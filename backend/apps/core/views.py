import tempfile

from django.http import FileResponse
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import NotFound
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core import backup, scheduler
from apps.core.models import BackupSettings
from apps.core.permissions import role_permission
from apps.printing.models import PrintSettings, Restaurant
from apps.printing.serializers import PrintSettingsSerializer, RestaurantSerializer
from apps.users.models import Role


@api_view(["GET"])
@permission_classes([AllowAny])
def health(request):
    return Response({"status": "ok"})


class BackupView(APIView):
    """Admins: GET downloads a full backup zip; GET ?info=1 says what it would hold."""

    permission_classes = [role_permission(read={Role.ADMIN}, write=frozenset())]

    def get(self, request):
        if request.query_params.get("info"):
            return Response(backup.summary())
        out = tempfile.TemporaryFile()  # deleted when the response closes it
        backup.write_backup(out)
        out.seek(0)
        return FileResponse(
            out, as_attachment=True, filename=backup.filename(), content_type="application/zip"
        )


AdminOnly = role_permission(read={Role.ADMIN}, write={Role.ADMIN})


class BackupSettingsSerializer(serializers.ModelSerializer):
    keep_days = serializers.IntegerField(min_value=1, max_value=90)

    class Meta:
        model = BackupSettings
        fields = ["enabled", "interval_hours", "keep_days"]


class BackupSettingsView(APIView):
    """Settings → Backup: the schedule, how the last run went, and the backups on the server."""

    permission_classes = [AdminOnly]

    def _state(self, config):
        files = scheduler.stored()
        next_run = scheduler.next_run_at(config)
        return {
            **BackupSettingsSerializer(config).data,
            "interval_choices": BackupSettings.INTERVALS,
            "last_run_at": config.last_run_at,
            "last_ok": config.last_ok,
            "last_error": config.last_error,
            "next_run_at": next_run,
            "due": next_run is not None and next_run <= timezone.now(),
            "worker_seen_at": scheduler.worker_alive(),
            "folder": str(scheduler.backup_dir()),
            "files": files,
            "total_bytes": sum(f["size"] for f in files),
        }

    def get(self, request):
        return Response(self._state(BackupSettings.load()))

    def patch(self, request):
        config = BackupSettings.load()
        body = BackupSettingsSerializer(config, data=request.data, partial=True)
        body.is_valid(raise_exception=True)
        body.save()
        if "keep_days" in body.validated_data:
            scheduler.prune(config.keep_days)
        return Response(self._state(config))


class BackupRunView(APIView):
    """Back up to the server's backup folder now."""

    permission_classes = [AdminOnly]

    def post(self, request):
        try:
            return Response(scheduler.run_backup(), status=201)
        except scheduler.Busy as exc:
            return Response({"detail": str(exc)}, status=409)


class BackupFileView(APIView):
    """Download one of the backups kept on the server."""

    permission_classes = [AdminOnly]

    def get(self, request, name):
        # Only names from the listing, so nothing outside the backup folder can be fetched.
        if name not in {f["name"] for f in scheduler.stored()}:
            raise NotFound("No such backup.")
        return FileResponse(
            (scheduler.backup_dir() / name).open("rb"),
            as_attachment=True,
            filename=name,
            content_type="application/zip",
        )


class RestaurantSettingsView(APIView):
    """Settings → Restaurant: name, address and registration numbers printed on the bill."""

    permission_classes = [AdminOnly]

    def get(self, request):
        return Response(RestaurantSerializer(Restaurant.load()).data)

    def patch(self, request):
        body = RestaurantSerializer(Restaurant.load(), data=request.data, partial=True)
        body.is_valid(raise_exception=True)
        body.save()
        return Response(body.data)


class PrintSettingsView(APIView):
    """Settings → Printing: the network printer the Android app prints to directly."""

    permission_classes = [AdminOnly]

    def get(self, request):
        return Response(PrintSettingsSerializer(PrintSettings.load()).data)

    def patch(self, request):
        body = PrintSettingsSerializer(PrintSettings.load(), data=request.data, partial=True)
        body.is_valid(raise_exception=True)
        body.save()
        return Response(body.data)
