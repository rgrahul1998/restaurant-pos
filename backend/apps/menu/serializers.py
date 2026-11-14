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
            "code",
            "description",
            "price",
            "image",
            "is_vegetarian",
            "has_jain",
            "is_special",
            "is_available",
        ]
        # validate_code says which dish has the number, instead of the stock "already exists".
        extra_kwargs = {"image": {"allow_null": True}, "code": {"validators": []}}

    def validate_code(self, value):
        taken = MenuItem.objects.filter(code=value).exclude(pk=getattr(self.instance, "pk", None))
        if value is not None and (other := taken.first()):
            raise serializers.ValidationError(f"Number {value} is already {other.name}.")
        return value

    def validate_image(self, value):
        # null clears the photo; the column itself stores "" for "no image".
        return value or ""
