from django.contrib import admin
from simple_history.admin import SimpleHistoryAdmin
from unfold.admin import ModelAdmin

from .models import Category, Course, MenuItem


@admin.register(Course)
class CourseAdmin(ModelAdmin):
    list_display = ["name", "sort_order"]


@admin.register(Category)
class CategoryAdmin(SimpleHistoryAdmin, ModelAdmin):
    list_display = ["name", "station", "sort_order", "is_active"]
    list_filter = ["station", "is_active"]


@admin.register(MenuItem)
class MenuItemAdmin(SimpleHistoryAdmin, ModelAdmin):
    list_display = ["name", "category", "course", "price", "is_available"]
    list_filter = ["category", "course", "is_available", "is_special", "is_vegetarian"]
    search_fields = ["name"]
