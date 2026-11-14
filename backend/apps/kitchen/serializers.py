from rest_framework import serializers

from .models import KOT, KOTItem, Station


class StationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Station
        fields = ["id", "name", "is_active"]


class KOTItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = KOTItem
        fields = [
            "id", "order_item", "name", "is_jain", "quantity", "cancelled_quantity", "note",
        ]  # fmt: skip


class KOTSerializer(serializers.ModelSerializer):
    items = KOTItemSerializer(many=True, read_only=True)
    table = serializers.CharField(source="order.table.label", default=None, read_only=True)
    order_type = serializers.CharField(source="order.order_type", read_only=True)
    station_name = serializers.CharField(source="station.name", default=None, read_only=True)

    class Meta:
        model = KOT
        fields = [
            "id",
            "order",
            "order_type",
            "table",
            "station",
            "station_name",
            "type",
            "status",
            "original",
            "note",
            "items",
            "created_at",
            "started_at",
            "ready_at",
            "served_at",
        ]
        # The kitchen only moves a ticket through its statuses; tickets themselves
        # are created by the order flow.
        read_only_fields = [f for f in fields if f != "status"]


class CookingInstructionsSerializer(serializers.Serializer):
    instructions = serializers.ListField(
        child=serializers.CharField(max_length=60, allow_blank=True), max_length=100
    )

    def validate_instructions(self, value):
        # Trimmed, blanks dropped, duplicates (any case) kept once. Commas would split
        # the saved note into separate chips, so they aren't allowed inside one.
        seen, out = set(), []
        for text in value:
            text = " ".join(text.split())
            if "," in text:
                raise serializers.ValidationError(
                    f"“{text}”: use separate instructions, not commas."
                )
            if text and text.lower() not in seen:
                seen.add(text.lower())
                out.append(text)
        return out
