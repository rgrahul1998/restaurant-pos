from rest_framework import viewsets
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.permissions import role_permission

from .models import Role, User
from .serializers import UserSerializer


class MeView(APIView):
    serializer_class = UserSerializer

    def get(self, request):
        return Response(UserSerializer(request.user).data)


class UserViewSet(viewsets.ModelViewSet):
    """Staff accounts. Only Admins see or manage them."""

    queryset = User.objects.order_by("username")
    serializer_class = UserSerializer
    permission_classes = [role_permission(read={Role.ADMIN}, write={Role.ADMIN})]
    filterset_fields = ["role", "is_active"]
    search_fields = ["username", "first_name", "last_name"]

    def perform_update(self, serializer):
        user, data = serializer.instance, serializer.validated_data
        # Nobody can lock themselves out: no deactivating or demoting your own account.
        if user == self.request.user and (
            data.get("is_active") is False or data.get("role", user.role) != user.role
        ):
            raise ValidationError("You can't change your own role or deactivate yourself.")
        serializer.save()

    def perform_destroy(self, instance):
        if instance == self.request.user:
            raise ValidationError("You can't delete your own account.")
        instance.delete()
