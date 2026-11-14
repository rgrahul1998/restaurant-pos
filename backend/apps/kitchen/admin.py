from django.contrib import admin
from simple_history.admin import SimpleHistoryAdmin
from unfold.admin import ModelAdmin, TabularInline

from .models import KOT, KitchenSettings, KOTItem, Station


@admin.register(Station)
class StationAdmin(ModelAdmin):
    list_display = ["name", "is_active"]


class KOTItemInline(TabularInline):
    model = KOTItem
    extra = 0


@admin.register(KOT)
class KOTAdmin(SimpleHistoryAdmin, ModelAdmin):
    list_display = ["id", "order", "station", "type", "status", "created_at"]
    list_filter = ["station", "type", "status"]
    inlines = [KOTItemInline]


@admin.register(KitchenSettings)
class KitchenSettingsAdmin(ModelAdmin):
    list_display = ["__str__"]
