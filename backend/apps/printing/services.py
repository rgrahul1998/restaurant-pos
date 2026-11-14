"""What the printer page should print next, and the record of what it has printed.

The laptop's printer page polls `pending()` every few seconds, prints through QZ Tray,
and calls `mark_printed()` only once QZ Tray has accepted the ticket. Nothing is
considered printed before that, so an outage delays tickets instead of losing them.
"""

import base64
from datetime import timedelta

from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.kitchen.models import KOT, KOTItem
from apps.orders.models import Order

from .models import BillPrintJob, KOTPrintLog, Restaurant
from .ticket import build_bill, build_ticket

KOT_CATCH_UP = timedelta(hours=12)
# A bill printed hours late is no use to anyone at the table, unlike a KOT record.
BILL_CATCH_UP = timedelta(hours=2)
BATCH_SIZE = 10
PAGE_ALIVE_KEY = "printing:page-alive"
PAGE_ALIVE_SECONDS = 30

# The ticket builder keeps the vocabulary of the app it was ported from.
KOT_TYPE = {
    KOT.Type.NEW: "New Order",
    KOT.Type.MODIFIED: "Order Modified",
    KOT.Type.CANCELLED: "Cancelled",
    KOT.Type.PARTIALLY_CANCELLED: "Partially cancelled",
    KOT.Type.DUPLICATE: "Duplicate",
}


def _encode(ticket: bytes) -> str:
    return base64.b64encode(ticket).decode("ascii")


def _stamp(moment):
    local = timezone.localtime(moment)
    return {"date": local.strftime("%Y-%m-%d"), "time": local.strftime("%H:%M:%S")}


def jain_name(item) -> str:
    """The printed name of an order or KOT line: Jain portions end in "(J)"."""
    return f"{item.name} (J)" if item.is_jain else item.name


def _order_fields(order: Order) -> dict:
    return {
        "customer_name": order.customer_name,
        "mobile_number": order.customer_phone,
        "order_type": order.get_order_type_display(),
        "restaurant_table": order.table.label if order.table else None,
    }


def kot_data(kot: KOT) -> dict:
    return {
        **_order_fields(kot.order),
        **_stamp(kot.created_at),
        "name": f"KOT-{kot.pk}",
        "type": KOT_TYPE[kot.type],
        "production": kot.station.name,
        "invoice": kot.order_id,
        "table_takeaway": kot.order.table is None,
        "comments": kot.note,
        "user": kot.created_by.get_full_name() or kot.created_by.username,
        "kot_items": [
            {
                "item_name": jain_name(item),
                "quantity": item.quantity,
                "cancelled_qty": item.cancelled_quantity,
                "comments": item.note,
            }
            for item in kot.items.all()
        ],
    }


def bill_data(order: Order) -> dict:
    stamp = _stamp(order.created_at)
    return {
        **_order_fields(order),
        "name": order.pk,
        "posting_date": stamp["date"],
        "posting_time": stamp["time"],
        "docstatus": 1 if order.status == Order.Status.PAID else 0,
        "items": [
            {"item_name": jain_name(item), "qty": item.quantity, "amount": item.line_total}
            for item in order.items.all()
            if item.quantity
        ],
        "total": order.subtotal,
        "discount_amount": order.discount,
        "grand_total": order.total,
        "advance_amount": order.advance,
        "paid_amount": order.paid,
        "payments": [
            {"mode_of_payment": payment.get_method_display(), "amount": payment.amount}
            for payment in order.payments.all()
        ],
    }


def company_data() -> dict:
    restaurant = Restaurant.load()
    city = " ".join(filter(None, [restaurant.city, restaurant.pincode]))
    return {
        "name": restaurant.name,
        "phone": restaurant.phone,
        "address_lines": list(
            filter(None, [restaurant.address_line1, restaurant.address_line2, city])
        ),
    }


def pending(since, width: int) -> list[dict]:
    """Ready-to-print tickets, oldest first. Calling this also marks the page as alive."""
    cache.set(PAGE_ALIVE_KEY, 1, PAGE_ALIVE_SECONDS)
    now = timezone.now()
    tickets = []
    if since:  # a page on its first run has nothing to catch up on
        kots = (
            KOT.objects.filter(
                created_at__gte=max(since, now - KOT_CATCH_UP), print_log__isnull=True
            )
            .select_related("order__table", "station", "created_by")
            .prefetch_related("items", "order__table__merged_tables")
            .order_by("created_at")[:BATCH_SIZE]
        )
        for kot in kots:
            data = kot_data(kot)
            label = [data["name"], data["restaurant_table"], kot.get_type_display()]
            tickets.append(
                {
                    "kind": "kot",
                    "id": kot.pk,
                    "label": " - ".join(filter(None, label)),
                    "ticket": _encode(build_ticket(data, width)),
                }
            )

    jobs = (
        BillPrintJob.objects.filter(
            status=BillPrintJob.Status.PENDING, created_at__gte=now - BILL_CATCH_UP
        )
        .select_related("order__table")
        .prefetch_related("order__items", "order__payments", "order__table__merged_tables")
        .order_by("created_at")[:BATCH_SIZE]
    )
    company = company_data() if jobs else {}
    for job in jobs:
        data = bill_data(job.order)
        tickets.append(
            {
                "kind": "bill",
                "id": job.pk,
                "label": " - ".join(
                    filter(None, ["Bill", f"#{job.order_id}", data["restaurant_table"]])
                ),
                "ticket": _encode(build_bill(data, company, width)),
            }
        )
    return tickets


def mark_printed(kind: str, pk: int, printer: str, user):
    if kind == "kot":
        if not KOT.objects.filter(pk=pk).exists():
            raise ValidationError("Unknown KOT.")
        KOTPrintLog.objects.get_or_create(
            kot_id=pk, defaults={"printer": printer, "printed_by": user}
        )
    else:
        BillPrintJob.objects.filter(pk=pk).update(
            status=BillPrintJob.Status.PRINTED, printer=printer, updated_at=timezone.now()
        )


def queue_bill(order: Order, user) -> BillPrintJob:
    if order.status not in (Order.Status.BILLED, Order.Status.PAID):
        raise ValidationError("Bill the order before printing it.")
    # Staff must find out now if nothing can print, not when the customer is waiting.
    if not cache.get(PAGE_ALIVE_KEY):
        raise ValidationError(
            "The bill was not printed. Open the Printer page on the laptop and check it says Ready."
        )
    job, _ = BillPrintJob.objects.get_or_create(
        order=order, status=BillPrintJob.Status.PENDING, defaults={"requested_by": user}
    )
    return job


@transaction.atomic
def reprint_kot(kot: KOT, user) -> KOT:
    """Print the ticket again. The copy is a new KOT marked REPRINT on paper."""
    copy = KOT.objects.create(
        order=kot.order,
        station=kot.station,
        type=KOT.Type.DUPLICATE,
        status=KOT.Status.SERVED,  # paper only: keeps it off the kitchen screen
        original=kot,
        note=kot.note,
        created_by=user,
    )
    KOTItem.objects.bulk_create(
        KOTItem(
            kot=copy,
            order_item=item.order_item,
            name=item.name,
            quantity=item.quantity,
            cancelled_quantity=item.cancelled_quantity,
            note=item.note,
            is_jain=item.is_jain,
        )
        for item in kot.items.all()
    )
    return copy
