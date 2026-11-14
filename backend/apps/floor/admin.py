from django.contrib import admin
from simple_history.admin import SimpleHistoryAdmin
from unfold.admin import ModelAdmin

from .models import Room, Table


@admin.register(Room)
class RoomAdmin(SimpleHistoryAdmin, ModelAdmin):
    list_display = ["name", "sort_order", "is_active"]


@admin.register(Table)
class TableAdmin(SimpleHistoryAdmin, ModelAdmin):
    list_display = ["name", "room", "seats", "status", "is_active"]
    list_filter = ["room", "status", "is_active"]
