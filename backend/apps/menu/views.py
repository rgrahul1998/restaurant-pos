from django.http import HttpResponse
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response

from apps.core.permissions import MANAGEMENT, role_permission

from . import importer
from .models import Category, Course, MenuItem
from .serializers import CategorySerializer, CourseSerializer, MenuItemSerializer


class CourseViewSet(viewsets.ModelViewSet):
    queryset = Course.objects.all()
    serializer_class = CourseSerializer
    permission_classes = [role_permission()]


class CategoryViewSet(viewsets.ModelViewSet):
    queryset = Category.objects.all()
    serializer_class = CategorySerializer
    permission_classes = [role_permission()]
    filterset_fields = ["station", "is_active"]


class MenuItemViewSet(viewsets.ModelViewSet):
    queryset = MenuItem.objects.all()
    serializer_class = MenuItemSerializer
    permission_classes = [role_permission()]
    filterset_fields = ["category", "course", "is_available", "is_special", "is_vegetarian"]
    search_fields = ["name", "=code"]

    # Spreadsheet in and out. Same people who edit the menu (Admin, Manager).
    @action(detail=False, methods=["get"], permission_classes=[role_permission(read=MANAGEMENT)])
    def template(self, request):
        """?type=xlsx|csv; ?current=1 fills it with today's menu, for editing in bulk."""
        current = request.query_params.get("current") == "1"
        name = "menu" if current else "menu-template"
        if request.query_params.get("type") == "csv":
            body, kind, ext = importer.template_csv(current), "text/csv", "csv"
        else:
            body = importer.template_xlsx(current)
            kind = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ext = "xlsx"
        response = HttpResponse(body, content_type=kind)
        response["Content-Disposition"] = f'attachment; filename="{name}.{ext}"'
        return response

    @action(
        detail=False,
        methods=["post"],
        url_path="import",
        parser_classes=[MultiPartParser],
        permission_classes=[role_permission(write=MANAGEMENT)],
    )
    def import_(self, request):
        """Upload `file`. Without `save=true` it only reports what would change."""
        upload = request.FILES.get("file")
        if upload is None:
            return Response({"detail": "Choose a file to import."}, status=400)
        try:
            if request.data.get("save") == "true":
                result = importer.apply(upload)
            else:
                result = importer.preview(upload)
        except importer.ImportError_ as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response(
            result, status=400 if result["errors"] and request.data.get("save") == "true" else 200
        )
