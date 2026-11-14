from django.db.models import OuterRef, Subquery
from django.db.models.functions import Coalesce
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.permissions import FRONT_OF_HOUSE, role_permission
from apps.orders.models import Order

from . import services
from .models import Room, Table
from .serializers import MergeSerializer, RoomSerializer, TableSerializer


class RoomViewSet(viewsets.ModelViewSet):
    queryset = Room.objects.all()
    serializer_class = RoomSerializer
    permission_classes = [role_permission()]
    filterset_fields = ["is_active"]


class TableViewSet(viewsets.ModelViewSet):
    queryset = (
        Table.objects.select_related("room")
        .prefetch_related("merged_tables")
        .annotate(
            # A joined table shows the order of the table it is joined to.
            active_order_id=Subquery(
                Order.objects.filter(
                    table=Coalesce(OuterRef("merged_into"), OuterRef("pk")),
                    status__in=["open", "billed"],
                ).values("pk")[:1]
            )
        )
    )
    serializer_class = TableSerializer
    filterset_fields = ["room", "status", "is_active"]

    def get_permissions(self):
        if self.action in ("merge", "unmerge"):
            return [role_permission(read=FRONT_OF_HOUSE, write=FRONT_OF_HOUSE)()]
        return [role_permission()()]

    def _respond(self, table):
        return Response(self.get_serializer(self.get_queryset().get(pk=table.pk)).data)

    @action(detail=True, methods=["post"], serializer_class=MergeSerializer)
    def merge(self, request, pk=None):
        """Join free tables in the same room onto this one."""
        body = MergeSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        targets = [t.pk for t in body.validated_data["tables"]]
        table = services.merge(self.get_object().pk, targets)
        return Response(TableSerializer(self.get_queryset().get(pk=table.pk)).data)

    @action(detail=True, methods=["post"])
    def unmerge(self, request, pk=None):
        """Split the group this table belongs to."""
        return self._respond(services.unmerge(self.get_object().pk))
