"""Sales reports. Read-only aggregation over orders, payments, KOTs and reservations.

Days are the restaurant's local days (settings.TIME_ZONE). Sales are counted on the day
the order was opened, the same day order history files it under; money received is
counted on the day it was received.
"""

from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Count, DecimalField, ExpressionWrapper, F, Q, Sum
from django.db.models.functions import ExtractHour, TruncDate

from apps.kitchen.models import KOTItem
from apps.orders.models import Order, OrderItem, Payment
from apps.reservations.models import Reservation, ReservationPayment

ZERO = Decimal("0")
LINE_VALUE = ExpressionWrapper(
    F("unit_price") * F("quantity"), output_field=DecimalField(max_digits=14, decimal_places=2)
)


def _in_range(field, start: date | None, end: date | None) -> Q:
    q = Q()
    if start:
        q &= Q(**{f"{field}__date__gte": start})
    if end:
        q &= Q(**{f"{field}__date__lte": end})
    return q


def _money(value) -> Decimal:
    return (value or ZERO).quantize(Decimal("0.01"))


def build(start: date | None, end: date | None) -> dict:
    orders = Order.objects.filter(_in_range("created_at", start, end))
    paid = orders.filter(status=Order.Status.PAID)

    totals = paid.aggregate(
        orders=Count("pk"),
        gross=Sum("subtotal"),
        discounts=Sum("discount"),
        net=Sum("total"),
        guests=Sum("guests", filter=Q(order_type=Order.Type.DINE_IN)),
        dine_in_net=Sum("total", filter=Q(order_type=Order.Type.DINE_IN)),
        discounted=Count("pk", filter=Q(discount__gt=0)),
    )
    count, net = totals["orders"], _money(totals["net"])
    guests = totals["guests"] or 0
    summary = {
        "orders": count,
        "gross": _money(totals["gross"]),
        "discounts": _money(totals["discounts"]),
        "discounted_orders": totals["discounted"],
        "net": net,
        "average_bill": _money(net / count) if count else ZERO,
        "guests": guests,
        "per_guest": _money(_money(totals["dine_in_net"]) / guests) if guests else ZERO,
        "cancelled_orders": orders.filter(status=Order.Status.CANCELLED).count(),
        "open_orders": orders.filter(status__in=[Order.Status.OPEN, Order.Status.BILLED]).count(),
    }

    # ---- over time ----
    per_day = {
        row["day"]: row
        for row in paid.annotate(day=TruncDate("created_at"))
        .values("day")
        .annotate(orders=Count("pk"), net=Sum("total"))
    }
    first = start or min(per_day, default=None)
    last = end or max(per_day, default=None)
    by_day = []
    if first and last and (last - first).days <= 366:
        day = first
        while day <= last:
            row = per_day.get(day, {})
            by_day.append(
                {"date": day, "orders": row.get("orders", 0), "net": _money(row.get("net"))}
            )
            day += timedelta(days=1)

    hours = {
        row["hour"]: row
        for row in paid.annotate(hour=ExtractHour("created_at"))
        .values("hour")
        .annotate(orders=Count("pk"), net=Sum("total"))
    }
    by_hour = [
        {
            "hour": h,
            "orders": hours.get(h, {}).get("orders", 0),
            "net": _money(hours.get(h, {}).get("net")),
        }
        for h in range(24)
    ]

    by_type = [
        {"type": row["order_type"], "orders": row["orders"], "net": _money(row["net"])}
        for row in paid.values("order_type")
        .annotate(orders=Count("pk"), net=Sum("total"))
        .order_by("-net")
    ]

    # ---- what sold (before bill discounts) ----
    lines = OrderItem.objects.filter(order__in=paid, quantity__gt=0)
    items = [
        {
            "menu_item": row["menu_item"],
            "name": row["menu_item__name"],
            "category": row["menu_item__category__name"],
            "quantity": row["qty"],
            "jain_quantity": row["jain_qty"] or 0,
            "revenue": _money(row["revenue"]),
        }
        for row in lines.values("menu_item", "menu_item__name", "menu_item__category__name")
        .annotate(
            qty=Sum("quantity"),
            jain_qty=Sum("quantity", filter=Q(is_jain=True)),
            revenue=Sum(LINE_VALUE),
        )
        .order_by("-revenue", "menu_item__name")
    ]
    categories = [
        {
            "name": row["menu_item__category__name"],
            "quantity": row["qty"],
            "revenue": _money(row["revenue"]),
        }
        for row in lines.values("menu_item__category__name")
        .annotate(qty=Sum("quantity"), revenue=Sum(LINE_VALUE))
        .order_by("-revenue")
    ]

    staff = [
        {
            "user": row["waiter"],
            "name": " ".join(filter(None, [row["waiter__first_name"], row["waiter__last_name"]]))
            or row["waiter__username"],
            "orders": row["orders"],
            "net": _money(row["net"]),
            "guests": row["guests"] or 0,
        }
        for row in paid.values(
            "waiter", "waiter__username", "waiter__first_name", "waiter__last_name"
        )
        .annotate(orders=Count("pk"), net=Sum("total"), guests=Sum("guests"))
        .order_by("-net")
    ]

    # ---- money received, by method ----
    methods = {
        m: {"method": m, "label": label, "bills": ZERO, "advances": ZERO, "refunds": ZERO}
        for m, label in Payment.Method.choices
    }
    for row in (
        Payment.objects.filter(_in_range("created_at", start, end))
        .values("method")
        .annotate(amount=Sum("amount"))
    ):
        methods[row["method"]]["bills"] = _money(row["amount"])
    for row in (
        ReservationPayment.objects.filter(_in_range("created_at", start, end))
        .values("method", "kind")
        .annotate(amount=Sum("amount"))
    ):
        key = "refunds" if row["kind"] == ReservationPayment.Kind.REFUND else "advances"
        methods[row["method"]][key] = _money(row["amount"])
    collections = []
    for row in methods.values():
        row["net"] = row["bills"] + row["advances"] - row["refunds"]
        if row["bills"] or row["advances"] or row["refunds"]:
            collections.append(row)
    collections.sort(key=lambda r: -r["net"])

    # ---- losses: items the kitchen had that were cancelled ----
    voided = KOTItem.objects.filter(
        _in_range("kot__created_at", start, end), cancelled_quantity__gt=0
    ).annotate(
        value=ExpressionWrapper(
            F("order_item__unit_price") * F("cancelled_quantity"),
            output_field=DecimalField(max_digits=14, decimal_places=2),
        )
    )
    void_items = [
        {"name": row["name"], "quantity": row["quantity"], "value": _money(row["value"])}
        for row in voided.values("name")
        .annotate(quantity=Sum("cancelled_quantity"), value=Sum("value"))
        .order_by("-value")
    ]
    cancellations = {
        "orders": summary["cancelled_orders"],
        "kitchen_items": sum(r["quantity"] for r in void_items),
        "kitchen_value": sum((r["value"] for r in void_items), ZERO),
        "items": void_items,
    }

    # ---- reservations, by the day of the booking ----
    bookings = Reservation.objects.filter(_in_range("start_at", start, end))
    status_counts = dict(bookings.values_list("status").annotate(n=Count("pk")).order_by())
    forfeited = ReservationPayment.objects.filter(
        reservation__in=bookings.filter(advance_outcome=Reservation.AdvanceOutcome.FORFEITED)
    ).aggregate(
        advances=Sum("amount", filter=Q(kind=ReservationPayment.Kind.ADVANCE)),
        refunds=Sum("amount", filter=Q(kind=ReservationPayment.Kind.REFUND)),
    )
    reservations = {
        "bookings": sum(status_counts.values()),
        "guests": bookings.exclude(
            status__in=[Reservation.Status.CANCELLED, Reservation.Status.NO_SHOW]
        ).aggregate(n=Sum("guests"))["n"]
        or 0,
        "seated": status_counts.get(Reservation.Status.SEATED, 0),
        "upcoming": status_counts.get(Reservation.Status.CONFIRMED, 0),
        "cancelled": status_counts.get(Reservation.Status.CANCELLED, 0),
        "no_show": status_counts.get(Reservation.Status.NO_SHOW, 0),
        "forfeited": _money(forfeited["advances"]) - _money(forfeited["refunds"]),
    }

    return {
        "date_from": start,
        "date_to": end,
        "summary": summary,
        "by_day": by_day,
        "by_hour": by_hour,
        "by_type": by_type,
        "items": items,
        "categories": categories,
        "staff": staff,
        "collections": collections,
        "cancellations": cancellations,
        "reservations": reservations,
    }
