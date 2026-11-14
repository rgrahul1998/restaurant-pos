from rest_framework import serializers

from .models import Category, Course, MenuItem


class CourseSerializer(serializers.ModelSerializer):
    class Meta:
        model = Course
        fields = ["id", "name", "sort_order"]


class CategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = Category
        fields = ["id", "name", "station", "sort_order", "is_active"]


class MenuItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = MenuItem
        fields = [
            "id",
            "category",
            "course",
            "name",
            "description",
            "price",
            "image",
            "is_vegetarian",
            "has_jain",
            "is_special",
            "is_available",
        ]
        extra_kwargs = {"image": {"allow_null": True}}

    def validate_image(self, value):
        # null clears the photo; the column itself stores "" for "no image".
        return value or ""
