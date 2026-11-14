from decimal import Decimal

from django.db.models import Count, Sum
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core.permissions import BILLING, FRONT_OF_HOUSE, role_permission
from apps.printing import services as printing
from apps.printing.models import PrintSettings

from . import services
from .filters import OrderFilter
from .models import Order, Payment
from .serializers import (
    BillSerializer,
    OrderSerializer,
    PaymentSerializer,
    TransferSerializer,
)


def _print_here(request) -> bool:
    return request.data.get("print_here") in (True, "true", "1")


FrontOfHouse = role_permission(read=FRONT_OF_HOUSE, write=FRONT_OF_HOUSE)
Billing = role_permission(read=BILLING, write=BILLING)


class OrderViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    queryset = Order.objects.select_related("table", "waiter", "reservation").prefetch_related(
        "items", "payments"
    )
    serializer_class = OrderSerializer
    filterset_class = OrderFilter
    http_method_names = ["get", "post", "patch", "head", "options"]

    def get_permissions(self):
        return [Billing() if self.action in ("bill", "reopen", "summary") else FrontOfHouse()]

    def _respond(self, pk, status=200):
        # Re-read through the viewset queryset: services return a bare, locked row.
        return Response(self.get_serializer(self.get_queryset().get(pk=pk)).data, status=status)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return self._respond(serializer.save().pk, status=201)

    def partial_update(self, request, *args, **kwargs):
        serializer = self.get_serializer(self.get_object(), data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        return self._respond(serializer.save().pk)

    @action(detail=False)
    def summary(self, request):
        """Totals for the orders the same filters would list: what history shows above the list."""
        orders = self.filter_queryset(Order.objects.all())
        paid = orders.filter(status=Order.Status.PAID)
        money = paid.aggregate(sales=Sum("total"), discounts=Sum("discount"))
        counts = dict(orders.values_list("status").annotate(n=Count("pk")).order_by())
        return Response(
            {
                "orders": sum(counts.values()),
                "paid": counts.get(Order.Status.PAID, 0),
                "cancelled": counts.get(Order.Status.CANCELLED, 0),
                "active": counts.get(Order.Status.OPEN, 0) + counts.get(Order.Status.BILLED, 0),
                "sales": money["sales"] or Decimal("0"),
                "discounts": money["discounts"] or Decimal("0"),
            }
        )

    @action(detail=True, methods=["post"])
    def fire(self, request, pk=None):
        """Send everything the kitchen hasn't seen yet.

        `print_here: true` (the Android app): the response's `print` lists the new KOTs for
        the app to print straight to the network printer.
        """
        order = self.get_object()
        on_device = _print_here(request) and bool(PrintSettings.load().kot_printer_host)
        kots = services.fire(order.pk, request.user, claim_print=on_device)
        response = self._respond(order.pk)
        if on_device:
            response.data["print"] = printing.for_device(kots=kots)
        return response

    @action(detail=True, methods=["post"], serializer_class=BillSerializer)
    def bill(self, request, pk=None):
        body = BillSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        order = services.bill(self.get_object().pk, request.user, **body.validated_data)
        return Response(OrderSerializer(self.get_queryset().get(pk=order.pk)).data)

    @action(detail=True, methods=["post"], serializer_class=TransferSerializer)
    def transfer(self, request, pk=None):
        """Move the order to a free table."""
        body = TransferSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        order = services.transfer(self.get_object().pk, body.validated_data["table"])
        return Response(OrderSerializer(self.get_queryset().get(pk=order.pk)).data)

    @action(detail=True, methods=["post"], url_path="print-bill")
    def print_bill(self, request, pk=None):
        """Queue the bill for the laptop's printer page.

        `print_here: true` (the Android app, with a network printer set): returns the bill
        for the app to print itself.
        """
        on_device = _print_here(request) and bool(PrintSettings.load().kot_printer_host)
        job = printing.queue_bill(self.get_object(), request.user, on_device=on_device)
        if on_device:
            return Response({"print": printing.for_device(job=job)})
        return Response(status=204)

    @action(detail=True, methods=["post"])
    def reopen(self, request, pk=None):
        return self._respond(services.reopen(self.get_object().pk).pk)

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        return self._respond(services.cancel(self.get_object().pk, request.user).pk)


class PaymentViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet,
):
    queryset = Payment.objects.select_related("order")
    serializer_class = PaymentSerializer
    permission_classes = [Billing]
    filterset_fields = ["order", "method"]
