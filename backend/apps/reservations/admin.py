from django.contrib import admin
from simple_history.admin import SimpleHistoryAdmin
from unfold.admin import ModelAdmin, TabularInline

from .models import Reservation, ReservationPayment, ReservationTable


class ReservationTableInline(TabularInline):
    model = ReservationTable
    extra = 0
    readonly_fields = ["table", "period", "is_active"]


class ReservationPaymentInline(TabularInline):
    model = ReservationPayment
    extra = 0


@admin.register(Reservation)
class ReservationAdmin(SimpleHistoryAdmin, ModelAdmin):
    list_display = ["id", "customer_name", "start_at", "end_at", "guests", "status"]
    list_filter = ["status", "occasion"]
    search_fields = ["customer_name", "customer_phone"]
    inlines = [ReservationTableInline, ReservationPaymentInline]
