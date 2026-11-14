from rest_framework import viewsets

from apps.core.permissions import role_permission

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
    search_fields = ["name"]
