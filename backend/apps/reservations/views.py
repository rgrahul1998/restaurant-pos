from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.permissions import BILLING, FRONT_OF_HOUSE, role_permission

from . import services
from .models import Reservation
from .serializers import (
    AdvanceSerializer,
    AvailabilityQuerySerializer,
    CancelSerializer,
    RangeQuerySerializer,
    ReservationPaymentSerializer,
    ReservationSerializer,
)

# Waiters see the calendar so they know a table is booked tonight; billing staff manage it.
ReservationPermission = role_permission(read=FRONT_OF_HOUSE, write=BILLING)


class ReservationViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """`GET ?start=&end=` lists bookings overlapping that window."""

    queryset = Reservation.objects.select_related("created_by").prefetch_related(
        "tables", "payments__received_by"
    )
    serializer_class = ReservationSerializer
    permission_classes = [ReservationPermission]
    filterset_fields = {"status": ["exact", "in"]}
    http_method_names = ["get", "post", "patch", "head", "options"]
    pagination_class = None

    def get_queryset(self):
        queryset = super().get_queryset()
        if self.action == "list":
            query = RangeQuerySerializer(data=self.request.query_params)
            query.is_valid(raise_exception=True)
            if start := query.validated_data.get("start"):
                queryset = queryset.filter(end_at__gt=start)
            if end := query.validated_data.get("end"):
                queryset = queryset.filter(start_at__lt=end)
        return queryset

    def _respond(self, pk, status=200):
        reservation = self.get_queryset().get(pk=pk)
        context = self.get_serializer_context()
        return Response(ReservationSerializer(reservation, context=context).data, status=status)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return self._respond(serializer.save().pk, status=201)

    def partial_update(self, request, *args, **kwargs):
        serializer = self.get_serializer(self.get_object(), data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        return self._respond(serializer.save().pk)

    @action(detail=True, methods=["post"], serializer_class=AdvanceSerializer)
    def payments(self, request, pk=None):
        """Take an advance (or a further one)."""
        body = AdvanceSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        payment = services.add_advance(self.get_object().pk, request.user, **body.validated_data)
        return Response(ReservationPaymentSerializer(payment).data, status=201)

    @action(detail=True, methods=["post"])
    def seat(self, request, pk=None):
        """The party has arrived: open their order with the advance taken off."""
        return self._respond(services.seat(self.get_object().pk, request.user).pk)

    def _cancel(self, request, no_show):
        body = CancelSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        reservation = services.cancel(
            self.get_object().pk, request.user, no_show=no_show, **body.validated_data
        )
        return self._respond(reservation.pk)

    @action(detail=True, methods=["post"], serializer_class=CancelSerializer)
    def cancel(self, request, pk=None):
        return self._cancel(request, no_show=False)

    @action(detail=True, methods=["post"], url_path="no-show", serializer_class=CancelSerializer)
    def no_show(self, request, pk=None):
        return self._cancel(request, no_show=True)

    @action(detail=False, methods=["get"])
    def availability(self, request):
        """`?start=&end=[&exclude=<reservation>]`: each table, and the booking blocking it."""
        query = AvailabilityQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        data = query.validated_data
        rows = services.availability(data["start"], data["end"], data.get("exclude"))
        return Response(
            [
                {
                    "table": table.pk,
                    "name": table.name,
                    "room": table.room_id,
                    "seats": table.seats,
                    "booked_by": booking
                    and {
                        "id": booking.pk,
                        "customer_name": booking.customer_name,
                        "start_at": booking.start_at,
                        "end_at": booking.end_at,
                    },
                }
                for table, booking in rows
            ]
        )
