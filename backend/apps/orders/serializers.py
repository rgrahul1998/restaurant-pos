from decimal import Decimal

from rest_framework import serializers

from apps.floor.models import Table
from apps.menu.models import MenuItem

from . import services
from .models import Order, OrderItem, Payment


class OrderItemSerializer(serializers.ModelSerializer):
    line_total = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)

    class Meta:
        model = OrderItem
        fields = [
            "id", "menu_item", "name", "is_jain", "unit_price", "quantity", "kot_quantity", "note",
            "line_total",
        ]  # fmt: skip


class OrderLineSerializer(serializers.Serializer):
    """One cart change: `{menu_item, quantity}` adds a line, `{id, quantity}` edits one.

    Setting quantity to 0 removes the line (or cancels it, if the kitchen has it).
    """

    id = serializers.IntegerField(required=False)
    menu_item = serializers.PrimaryKeyRelatedField(queryset=MenuItem.objects.all(), required=False)
    quantity = serializers.IntegerField(min_value=0, max_value=999, required=False)
    note = serializers.CharField(max_length=255, allow_blank=True, required=False)
    is_jain = serializers.BooleanField(required=False, help_text="New lines only.")

    def validate(self, attrs):
        if ("id" in attrs) == ("menu_item" in attrs):
            raise serializers.ValidationError("Send either `id` or `menu_item`.")
        if attrs.get("is_jain") and "menu_item" in attrs and not attrs["menu_item"].has_jain:
            raise serializers.ValidationError(f"{attrs['menu_item'].name} has no Jain option.")
        return attrs


class PaymentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Payment
        fields = ["id", "order", "method", "amount", "reference", "received_by", "created_at"]
        read_only_fields = ["received_by"]

    def create(self, validated_data):
        order = validated_data.pop("order")
        return services.pay(order.pk, self.context["request"].user, **validated_data)


class OrderSerializer(serializers.ModelSerializer):
    items = OrderItemSerializer(many=True, read_only=True)
    lines = OrderLineSerializer(many=True, write_only=True, required=False)
    payments = PaymentSerializer(many=True, read_only=True)
    table_name = serializers.CharField(source="table.label", default=None, read_only=True)
    waiter_name = serializers.CharField(source="waiter.username", read_only=True)
    paid = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    balance = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    has_unsent = serializers.SerializerMethodField()
    reservation = serializers.SerializerMethodField()

    class Meta:
        model = Order
        fields = [
            "id", "order_type", "status", "table", "table_name", "guests", "customer_name",
            "customer_phone", "note", "waiter", "waiter_name", "cashier", "subtotal", "discount",
            "discount_percent", "total", "advance", "reservation", "paid", "balance", "has_unsent",
            "items", "lines", "payments", "created_at", "closed_at",
        ]  # fmt: skip
        read_only_fields = [
            "status", "waiter", "cashier", "subtotal", "discount", "discount_percent", "total",
            "advance", "closed_at",
        ]  # fmt: skip

    def get_reservation(self, order) -> int | None:
        return getattr(getattr(order, "reservation", None), "pk", None)

    def get_has_unsent(self, order) -> bool:
        return any(item.quantity != item.kot_quantity for item in order.items.all())

    def validate(self, attrs):
        if self.instance is None:
            order_type = attrs.get("order_type", Order.Type.DINE_IN)
            if order_type == Order.Type.DINE_IN and attrs.get("table") is None:
                raise serializers.ValidationError({"table": "A dine-in order needs a table."})
        return attrs

    def create(self, validated_data):
        return services.open_order(self.context["request"].user, **validated_data)

    def update(self, instance, validated_data):
        return services.update_order(instance.pk, self.context["request"].user, **validated_data)


class BillSerializer(serializers.Serializer):
    discount = serializers.DecimalField(
        max_digits=12, decimal_places=2, min_value=Decimal("0"), default=Decimal("0")
    )
    discount_type = serializers.ChoiceField(choices=["amount", "percent"], default="amount")


class TransferSerializer(serializers.Serializer):
    table = serializers.PrimaryKeyRelatedField(queryset=Table.objects.filter(is_active=True))
