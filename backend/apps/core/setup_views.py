import tempfile

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from apps.core import setup


class SetupSerializer(serializers.Serializer):
    mode = serializers.ChoiceField(choices=["blank", "demo"])
    restaurant_name = serializers.CharField(max_length=120, required=False, allow_blank=True)
    full_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    username = serializers.RegexField(r"^[\w.@+-]+$", max_length=150)
    password = serializers.CharField(min_length=8, write_only=True)

    def validate_password(self, value):
        try:
            validate_password(value)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(list(exc.messages)) from exc
        return value


class SetupView(APIView):
    """GET: does this server still need setting up? POST: set it up blank or with demo data."""

    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        return Response({"needed": setup.needed()})

    def post(self, request):
        body = SetupSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        try:
            admin = setup.create(**body.validated_data)
        except setup.SetupError as exc:
            return Response({"detail": str(exc)}, status=409)
        refresh = RefreshToken.for_user(admin)
        return Response({"access": str(refresh.access_token), "refresh": str(refresh)}, status=201)


class SetupRestoreView(APIView):
    """Load a backup zip into this fresh server."""

    permission_classes = [AllowAny]
    authentication_classes = []
    parser_classes = [MultiPartParser]

    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            return Response({"detail": "Choose a backup zip."}, status=400)
        if not setup.needed():
            return Response({"detail": "This POS is already set up. Sign in instead."}, status=409)
        with tempfile.NamedTemporaryFile(suffix=".zip") as tmp:
            for chunk in upload.chunks():
                tmp.write(chunk)
            tmp.flush()
            try:
                result = setup.restore(tmp.name)
            except setup.SetupError as exc:
                return Response({"detail": str(exc)}, status=400)
        return Response(
            {
                "rows": sum(result["counts"].values()),
                "media_files": result["media_files"],
                "warnings": result["warnings"],
            },
            status=201,
        )
