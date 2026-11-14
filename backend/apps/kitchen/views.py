from django.utils import timezone
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.permissions import ALL_ROLES, KITCHEN_STAFF, role_permission
from apps.printing import services as printing

from .models import KOT, Station
from .serializers import KOTSerializer, StationSerializer

STATUS_TIMESTAMP = {
    KOT.Status.PREPARING: "started_at",
    KOT.Status.READY: "ready_at",
    KOT.Status.SERVED: "served_at",
}


class StationViewSet(viewsets.ModelViewSet):
    queryset = Station.objects.all()
    serializer_class = StationSerializer
    permission_classes = [role_permission()]
    filterset_fields = ["is_active"]


class KOTViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    queryset = KOT.objects.select_related("order__table", "station").prefetch_related(
        "items", "order__table__merged_tables"
    )
    serializer_class = KOTSerializer
    filterset_fields = ["station", "status", "type", "order"]
    http_method_names = ["get", "post", "patch", "head", "options"]

    def get_permissions(self):
        write = ALL_ROLES if self.action == "reprint" else KITCHEN_STAFF
        return [role_permission(write=write)()]

    @action(detail=True, methods=["post"])
    def reprint(self, request, pk=None):
        """Print this ticket again, marked REPRINT."""
        printing.reprint_kot(self.get_object(), request.user)
        return Response(status=204)

    def perform_update(self, serializer):
        stamp = STATUS_TIMESTAMP.get(serializer.validated_data.get("status"))
        extra = {stamp: timezone.now()} if stamp and not getattr(serializer.instance, stamp) else {}
        serializer.save(**extra)
