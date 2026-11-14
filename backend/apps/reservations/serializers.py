from decimal import Decimal

from rest_framework import serializers

from apps.floor.models import Table
from apps.orders.models import Payment

from . import services
from .models import Reservation, ReservationPayment


class ReservationPaymentSerializer(serializers.ModelSerializer):
    received_by_name = serializers.CharField(source="received_by.username", read_only=True)

    class Meta:
        model = ReservationPayment
        fields = [
            "id", "kind", "method", "amount", "reference", "received_by", "received_by_name",
            "created_at",
        ]  # fmt: skip
        read_only_fields = ["kind", "received_by"]


class AdvanceSerializer(serializers.Serializer):
    method = serializers.ChoiceField(choices=Payment.Method.choices)
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0"))
    reference = serializers.CharField(max_length=80, allow_blank=True, required=False)


class ReservationSerializer(serializers.ModelSerializer):
    tables = serializers.PrimaryKeyRelatedField(
        queryset=Table.objects.filter(is_active=True), many=True
    )
    table_names = serializers.SerializerMethodField()
    room = serializers.SerializerMethodField()
    advance = AdvanceSerializer(write_only=True, required=False)
    advance_paid = serializers.DecimalField(
        source="advance", max_digits=12, decimal_places=2, read_only=True
    )
    payments = ReservationPaymentSerializer(many=True, read_only=True)
    created_by_name = serializers.CharField(source="created_by.username", read_only=True)

    class Meta:
        model = Reservation
        fields = [
            "id", "customer_name", "customer_phone", "guests", "occasion", "note", "start_at",
            "end_at", "tables", "table_names", "room", "status", "advance", "advance_paid",
            "advance_outcome", "cancel_reason", "payments", "order", "created_by",
            "created_by_name", "created_at",
        ]  # fmt: skip
        read_only_fields = [
            "status", "advance_outcome", "cancel_reason", "order", "created_by",
        ]  # fmt: skip

    def _tables(self, reservation):
        return sorted(reservation.tables.all(), key=lambda t: (len(t.name), t.name))

    def get_table_names(self, reservation) -> str:
        return " + ".join(t.name for t in self._tables(reservation))

    def get_room(self, reservation) -> int | None:
        tables = self._tables(reservation)
        return tables[0].room_id if tables else None

    def create(self, validated_data):
        return services.create(self.context["request"].user, **validated_data)

    def update(self, instance, validated_data):
        validated_data.pop("advance", None)  # extra advances go through /payments/
        return services.update(instance.pk, self.context["request"].user, **validated_data)


class CancelSerializer(serializers.Serializer):
    outcome = serializers.ChoiceField(choices=["refund", "forfeit"], required=False)
    refund_amount = serializers.DecimalField(
        max_digits=12, decimal_places=2, min_value=Decimal("0.01"), required=False
    )
    method = serializers.ChoiceField(choices=Payment.Method.choices, required=False)
    reference = serializers.CharField(max_length=80, allow_blank=True, required=False)
    reason = serializers.CharField(max_length=255, allow_blank=True, required=False)


class AvailabilityQuerySerializer(serializers.Serializer):
    start = serializers.DateTimeField()
    end = serializers.DateTimeField()
    exclude = serializers.IntegerField(required=False)


class RangeQuerySerializer(serializers.Serializer):
    start = serializers.DateTimeField(required=False)
    end = serializers.DateTimeField(required=False)
