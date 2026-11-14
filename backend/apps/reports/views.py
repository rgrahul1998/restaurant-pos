from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.permissions import BILLING, role_permission

from . import services


class RangeSerializer(serializers.Serializer):
    date_from = serializers.DateField(required=False)
    date_to = serializers.DateField(required=False)

    def validate(self, attrs):
        start, end = attrs.get("date_from"), attrs.get("date_to")
        if start and end and end < start:
            raise serializers.ValidationError({"date_to": "The end date is before the start."})
        return attrs


class SalesReportView(APIView):
    """Everything on the Reports screen for one date range (both ends optional, inclusive)."""

    permission_classes = [
        role_permission(read=BILLING, write=frozenset())
    ]  # Admin, Manager, Cashier

    def get(self, request):
        params = RangeSerializer(data=request.query_params)
        params.is_valid(raise_exception=True)
        data = params.validated_data
        return Response(services.build(data.get("date_from"), data.get("date_to")))
