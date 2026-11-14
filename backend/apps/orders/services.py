"""The order lifecycle: open → (fire to kitchen)* → billed → paid, or cancelled.

Every state change goes through here so table status, totals and kitchen tickets
can never drift apart. Each function locks the order row for its transaction.
"""

from decimal import ROUND_HALF_UP, Decimal

from django.db import transaction
from django.db.models import F
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.core.permissions import MANAGEMENT
from apps.core.realtime import KITCHEN_GROUP, broadcast
from apps.floor import services as floor
from apps.floor.models import Table
from apps.kitchen.models import KOT, KOTItem

from .models import Order, OrderItem, Payment

ACTIVE = [Order.Status.OPEN, Order.Status.BILLED]


def _lock(order_id) -> Order:
    return Order.objects.select_for_update().get(pk=order_id)


def _require(order: Order, status: Order.Status, message: str):
    if order.status != status:
        raise ValidationError(message)


def _claim_table(table: Table | None, order: Order | None = None) -> Table | None:
    """Resolve `table` to the one that will hold the order, and check it's available.

    Locks the table so two waiters can't open it at the same moment.
    """
    if table is None:
        return None
    primary = floor.lock_primary(table)
    taken = Order.objects.filter(table=primary, status__in=ACTIVE)
    if order:
        taken = taken.exclude(pk=order.pk)
    if taken.exists():
        raise ValidationError({"table": f"{primary.label} already has an open order."})
    return primary


def _table_status(order: Order) -> Table.Status:
    return Table.Status.BILLED if order.status == Order.Status.BILLED else Table.Status.OCCUPIED


def _move(order: Order, table: Table):
    """Seat the order at `table`, freeing (and splitting) wherever it was."""
    new = _claim_table(table, order)
    if new == order.table:
        raise ValidationError({"table": f"This order is already at {new.label}."})
    if order.table:
        floor.set_status(order.table, Table.Status.FREE)
        floor.release(order.table)
    order.table = new
    floor.set_status(new, _table_status(order))


def _retotal(order: Order):
    order.recalculate()
    order.save(update_fields=["subtotal", "discount", "total", "updated_at"])


def _apply_lines(order: Order, lines: list[dict], user):
    for line in lines:
        if "id" in line:
            item = order.items.filter(pk=line["id"]).first()
            if item is None:
                raise ValidationError(f"Line {line['id']} is not on this order.")
            quantity = line.get("quantity", item.quantity)
            note = line.get("note", item.note)
            if quantity < item.kot_quantity and user.role not in MANAGEMENT:
                raise PermissionDenied(
                    "Only a manager can cancel items already sent to the kitchen."
                )
            if note != item.note and item.kot_quantity:
                raise ValidationError("The note can't change once the kitchen has the item.")
            if quantity == 0 and item.kot_quantity == 0:
                item.delete()
                continue
            item.quantity, item.note = quantity, note
            item.unit_price = line.get("unit_price", item.unit_price)
            item.save(update_fields=["quantity", "note", "unit_price", "updated_at"])
        else:
            menu_item = line["menu_item"]
            if not menu_item.is_available:
                raise ValidationError(f"{menu_item.name} is not available right now.")
            if line.get("quantity", 1):
                OrderItem.objects.create(
                    order=order,
                    menu_item=menu_item,
                    name=menu_item.name,
                    unit_price=menu_item.price,
                    quantity=line.get("quantity", 1),
                    note=line.get("note", ""),
                    is_jain=line.get("is_jain", False),
                )
    _retotal(order)


@transaction.atomic
def open_order(user, *, lines=(), **fields) -> Order:
    table = fields["table"] = _claim_table(fields.get("table"))
    order = Order.objects.create(waiter=user, **fields)
    if table:
        floor.set_status(table, Table.Status.OCCUPIED)
    _apply_lines(order, list(lines), user)
    return order


@transaction.atomic
def update_order(order_id, user, *, lines=(), **fields) -> Order:
    order = _lock(order_id)
    _require(order, Order.Status.OPEN, "Only an open order can be changed.")
    table = fields.pop("table", order.table)
    if table and table != order.table:
        _move(order, table)
    for name, value in fields.items():
        setattr(order, name, value)
    if order.order_type == Order.Type.DINE_IN and order.table is None:
        raise ValidationError({"table": "A dine-in order needs a table."})
    order.save()
    _apply_lines(order, list(lines), user)
    return order


def _fire(order: Order, user, claim_print=False) -> list[KOT]:
    """Send the kitchen whatever changed since the last ticket, all items on one ticket.

    Each line remembers how much the kitchen already knows (`kot_quantity`), so only
    the difference travels: increases as a New/Modified ticket, decreases as a
    cancellation ticket. Every item is listed, whatever its category's station.
    `claim_print`: the device sending prints the tickets itself (see printing.for_device),
    marked in the same transaction so the Printer page never sees them unclaimed.
    """
    items = list(order.items.all())
    added, cancelled = [], []
    for item in items:
        delta = item.quantity - item.kot_quantity
        if delta == 0:
            continue
        if delta > 0:
            added.append((item, delta, 0))
        else:  # a cancellation line shows what the kitchen had and how much to drop
            cancelled.append((item, item.kot_quantity, -delta))
        item.kot_quantity = item.quantity
        item.save(update_fields=["kot_quantity", "updated_at"])

    def ticket(kind, lines):
        claimed = timezone.now() if claim_print else None
        kot = KOT.objects.create(order=order, type=kind, created_by=user, print_claimed_at=claimed)
        KOTItem.objects.bulk_create(
            KOTItem(
                kot=kot,
                order_item=item,
                name=item.name,
                quantity=quantity,
                cancelled_quantity=cancelled_quantity,
                note=item.note,
                is_jain=item.is_jain,
            )
            for item, quantity, cancelled_quantity in lines
        )
        return kot

    kots = []
    if added:
        kind = KOT.Type.MODIFIED if order.kots.exists() else KOT.Type.NEW
        kots.append(ticket(kind, added))
    if cancelled:
        still_live = any(item.quantity for item in items)
        kind = KOT.Type.PARTIALLY_CANCELLED if still_live else KOT.Type.CANCELLED
        kots.append(ticket(kind, cancelled))
    return kots


@transaction.atomic
def fire(order_id, user, claim_print=False) -> list[KOT]:
    """The tickets this send made."""
    order = _lock(order_id)
    _require(order, Order.Status.OPEN, "Only an open order can be sent to the kitchen.")
    if not order.items.exclude(quantity=F("kot_quantity")).exists():
        raise ValidationError("Nothing new to send to the kitchen.")
    return _fire(order, user, claim_print)


def _close(order: Order, status: Order.Status):
    order.status = status
    order.closed_at = timezone.now()
    order.save(update_fields=["status", "closed_at", "updated_at"])
    if order.table:
        floor.set_status(order.table, Table.Status.FREE)
        floor.release(order.table)  # a joined group lasts for one party


@transaction.atomic
def bill(
    order_id,
    user,
    discount: Decimal = Decimal("0"),
    discount_type="amount",
    customer_name: str | None = None,
    customer_phone: str | None = None,
) -> Order:
    """`discount` is an amount, or a percentage of the subtotal for `discount_type="percent"`.

    The customer's name and mobile, when given, are saved on the order; None leaves them.
    """
    order = _lock(order_id)
    _require(order, Order.Status.OPEN, "This order has already been billed or closed.")
    items = list(order.items.all())
    if not any(item.quantity for item in items):
        raise ValidationError("Add items before billing.")
    if any(item.quantity != item.kot_quantity for item in items):
        raise ValidationError("Send the pending changes to the kitchen before billing.")
    order.recalculate()
    if discount_type == "percent":
        if discount > 100:
            raise ValidationError({"discount": "A discount can't be more than 100%."})
        order.discount_percent = discount
        discount = (order.subtotal * discount / 100).quantize(Decimal("0.01"), ROUND_HALF_UP)
    elif discount > order.subtotal:
        raise ValidationError({"discount": "The discount can't be more than the bill."})
    order.discount = discount
    if customer_name is not None:
        order.customer_name = customer_name
    if customer_phone is not None:
        order.customer_phone = customer_phone
    order.cashier = user
    order.status = Order.Status.BILLED
    order.recalculate()
    order.save()
    if order.balance <= 0:  # fully discounted or covered by the advance: nothing to collect
        _close(order, Order.Status.PAID)
    else:
        if order.table:
            floor.set_status(order.table, Table.Status.BILLED)
    return order


@transaction.atomic
def reopen(order_id) -> Order:
    order = _lock(order_id)
    _require(order, Order.Status.BILLED, "Only a billed, unpaid order can be reopened.")
    if order.payments.exists():
        raise ValidationError("This order already has payments and can't be reopened.")
    order.status = Order.Status.OPEN
    order.discount = Decimal("0")
    order.discount_percent = None
    order.cashier = None
    order.recalculate()
    order.save()
    if order.table:
        floor.set_status(order.table, Table.Status.OCCUPIED)
    return order


@transaction.atomic
def transfer(order_id, table: Table) -> Order:
    order = _lock(order_id)
    if order.status not in ACTIVE:
        raise ValidationError("Only an active order can move to another table.")
    if order.table is None:
        raise ValidationError("A takeaway order has no table to move from.")
    _move(order, table)
    order.save(update_fields=["table", "updated_at"])
    # Open tickets carry the table name; tell kitchen screens to refresh.
    transaction.on_commit(
        lambda: broadcast(KITCHEN_GROUP, "order.transferred", {"order": order.pk})
    )
    return order


@transaction.atomic
def pay(order_id, user, *, method, amount: Decimal, reference="") -> Payment:
    order = _lock(order_id)
    _require(order, Order.Status.BILLED, "Bill the order before taking payment.")
    balance = order.balance
    if amount <= 0:
        raise ValidationError({"amount": "Enter an amount greater than zero."})
    if amount > balance:
        raise ValidationError({"amount": f"Only {balance} is due on this order."})
    payment = Payment.objects.create(
        order=order, method=method, amount=amount, reference=reference, received_by=user
    )
    if amount == balance:
        _close(order, Order.Status.PAID)
    return payment


@transaction.atomic
def cancel(order_id, user) -> Order:
    order = _lock(order_id)
    _require(order, Order.Status.OPEN, "Only an open order can be cancelled.")
    if order.items.filter(kot_quantity__gt=0).exists() and user.role not in MANAGEMENT:
        raise PermissionDenied(
            "Only a manager can cancel an order the kitchen has already started."
        )
    order.items.filter(kot_quantity=0).delete()
    for item in order.items.all():
        item.quantity = 0
        item.save(update_fields=["quantity", "updated_at"])
    _fire(order, user)  # tells the kitchen to stop
    _retotal(order)
    _close(order, Order.Status.CANCELLED)
    return order
