from django.contrib import admin
from simple_history.admin import SimpleHistoryAdmin
from unfold.admin import ModelAdmin, TabularInline

from .models import Order, OrderItem, Payment


class OrderItemInline(TabularInline):
    model = OrderItem
    extra = 0


class PaymentInline(TabularInline):
    model = Payment
    extra = 0


@admin.register(Order)
class OrderAdmin(SimpleHistoryAdmin, ModelAdmin):
    list_display = ["id", "order_type", "table", "status", "waiter", "total", "created_at"]
    list_filter = ["status", "order_type"]
    inlines = [OrderItemInline, PaymentInline]


@admin.register(Payment)
class PaymentAdmin(SimpleHistoryAdmin, ModelAdmin):
    list_display = ["id", "order", "method", "amount", "received_by", "created_at"]
    list_filter = ["method"]
