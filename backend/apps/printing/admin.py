from django.contrib import admin
from unfold.admin import ModelAdmin

from .models import BillPrintJob, KOTPrintLog, Restaurant


@admin.register(Restaurant)
class RestaurantAdmin(ModelAdmin):
    def has_add_permission(self, request):
        return not Restaurant.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(KOTPrintLog)
class KOTPrintLogAdmin(ModelAdmin):
    list_display = ["kot", "printer", "printed_by", "created_at"]


@admin.register(BillPrintJob)
class BillPrintJobAdmin(ModelAdmin):
    list_display = ["order", "status", "printer", "requested_by", "created_at"]
    list_filter = ["status"]
