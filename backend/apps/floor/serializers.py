from rest_framework import serializers

from apps.orders.models import Order

from .models import Room, Table


class RoomSerializer(serializers.ModelSerializer):
    class Meta:
        model = Room
        fields = ["id", "name", "sort_order", "is_active"]


class TableSerializer(serializers.ModelSerializer):
    active_order = serializers.SerializerMethodField()
    label = serializers.CharField(read_only=True)
    merged_tables = serializers.PrimaryKeyRelatedField(many=True, read_only=True)

    class Meta:
        model = Table
        fields = [
            "id",
            "room",
            "name",
            "seats",
            "status",
            "label",
            "active_order",
            "merged_into",
            "merged_tables",
            "is_active",
            "shape",
            "layout_x",
            "layout_y",
            "layout_width",
            "layout_height",
        ]
        read_only_fields = ["status", "merged_into"]  # driven by orders and merge/unmerge

    def get_active_order(self, table) -> int | None:
        if hasattr(table, "active_order_id"):  # annotated by the list view
            return table.active_order_id
        return (
            Order.objects.filter(
                table=table.merged_into_id or table.pk, status__in=["open", "billed"]
            )
            .values_list("pk", flat=True)
            .first()
        )


class MergeSerializer(serializers.Serializer):
    tables = serializers.PrimaryKeyRelatedField(
        queryset=Table.objects.filter(is_active=True), many=True, allow_empty=False
    )
