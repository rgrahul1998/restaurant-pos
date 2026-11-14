import django_filters
from django.db.models import Q

from .models import Order


class OrderFilter(django_filters.FilterSet):
    """List filters, also used by order history. Dates are the restaurant's local day."""

    status = django_filters.MultipleChoiceFilter(choices=Order.Status.choices)
    status__in = django_filters.BaseInFilter(field_name="status")  # ?status__in=open,billed
    date_from = django_filters.DateFilter(field_name="created_at", lookup_expr="date__gte")
    date_to = django_filters.DateFilter(field_name="created_at", lookup_expr="date__lte")
    q = django_filters.CharFilter(method="search", label="Order #, customer name or phone")

    class Meta:
        model = Order
        fields = {"order_type": ["exact"], "table": ["exact"], "waiter": ["exact"]}

    def search(self, queryset, name, value):
        value = value.strip()
        if value.startswith("#"):  # "#123" is an order number and nothing else
            number = value[1:].strip()
            return queryset.filter(pk=int(number)) if number.isdigit() else queryset.none()
        if not value:
            return queryset
        match = Q(customer_name__icontains=value) | Q(customer_phone__icontains=value)
        if value.isdigit():
            match |= Q(pk=int(value))
        return queryset.filter(match)
