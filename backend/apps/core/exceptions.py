from django.db.models import ProtectedError
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler


def api_exception_handler(exc, context):
    """DRF's handler, plus a readable 409 when a delete is blocked by records that use the row."""
    if isinstance(exc, ProtectedError):
        names = {str(o._meta.verbose_name_plural) for o in exc.protected_objects}
        used_by = ", ".join(sorted(names))
        message = f"Can't delete: it is used by {used_by}. Deactivate it instead."
        return Response({"detail": message}, status=status.HTTP_409_CONFLICT)
    return exception_handler(exc, context)
