"""Reservations: book tables for a time window, take advances, seat the party, or cancel.

Overlap is checked here for a readable error, and enforced by an exclusion constraint on
`ReservationTable` so two cashiers booking at the same moment still can't double-book.
"""

from django.db import IntegrityError, transaction
from django.db.backends.postgresql.psycopg_any import DateTimeTZRange
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.core.realtime import FLOOR_GROUP, broadcast
from apps.floor import services as floor
from apps.floor.models import Table
from apps.orders import services as orders

from .models import Reservation, ReservationPayment, ReservationTable

ACTIVE_ORDER = ["open", "billed"]


def _lock(reservation_id) -> Reservation:
    return Reservation.objects.select_for_update().get(pk=reservation_id)


def _require_confirmed(reservation: Reservation, message: str):
    if reservation.status != Reservation.Status.CONFIRMED:
        raise ValidationError(message)


def _announce(reservation: Reservation):
    transaction.on_commit(
        lambda: broadcast(FLOOR_GROUP, "reservation.updated", {"id": reservation.pk})
    )


def _fmt(moment):
    local = timezone.localtime(moment)
    return f"{local.day} {local:%b} {local.hour % 12 or 12}:{local:%M %p}"


def conflicts(tables, start_at, end_at, exclude=None):
    """Active bookings of any of `tables` that overlap [start_at, end_at)."""
    slots = ReservationTable.objects.filter(
        table__in=tables,
        is_active=True,
        period__overlap=DateTimeTZRange(start_at, end_at, "[)"),
    ).select_related("reservation", "table")
    if exclude:
        slots = slots.exclude(reservation=exclude)
    return list(slots)


def _validate(tables, start_at, end_at, exclude=None):
    if end_at <= start_at:
        raise ValidationError({"end_at": "The end time must be after the start time."})
    if not tables:
        raise ValidationError({"tables": "Pick at least one table."})
    if len({t.room_id for t in tables}) > 1:
        raise ValidationError({"tables": "All tables in a booking must be in the same room."})
    clash = conflicts(tables, start_at, end_at, exclude)
    if clash:
        slot = clash[0]
        other = slot.reservation
        raise ValidationError(
            {
                "tables": f"{slot.table.name} is already booked "
                f"{_fmt(other.start_at)} to {_fmt(other.end_at)} ({other.customer_name})."
            }
        )


def _write_slots(reservation: Reservation, tables):
    reservation.slots.all().delete()
    period = DateTimeTZRange(reservation.start_at, reservation.end_at, "[)")
    try:
        with transaction.atomic():
            ReservationTable.objects.bulk_create(
                ReservationTable(reservation=reservation, table=t, period=period) for t in tables
            )
    except IntegrityError as error:  # lost a race with another booking
        raise ValidationError({"tables": "One of these tables was just booked."}) from error


def _record(reservation, user, *, kind, method, amount, reference=""):
    if amount is None or amount <= 0:
        raise ValidationError({"amount": "Enter an amount greater than zero."})
    return ReservationPayment.objects.create(
        reservation=reservation,
        kind=kind,
        method=method,
        amount=amount,
        reference=reference,
        received_by=user,
    )


@transaction.atomic
def create(user, *, tables, advance=None, **fields) -> Reservation:
    tables = list(Table.objects.select_for_update().filter(pk__in=[t.pk for t in tables]))
    _validate(tables, fields["start_at"], fields["end_at"])
    reservation = Reservation.objects.create(created_by=user, **fields)
    _write_slots(reservation, tables)
    if advance and advance.get("amount"):
        _record(reservation, user, kind=ReservationPayment.Kind.ADVANCE, **advance)
    _announce(reservation)
    return reservation


@transaction.atomic
def update(reservation_id, user, *, tables=None, **fields) -> Reservation:
    reservation = _lock(reservation_id)
    _require_confirmed(reservation, "Only a confirmed reservation can be changed.")
    for name, value in fields.items():
        setattr(reservation, name, value)
    tables = list(tables) if tables is not None else list(reservation.tables.all())
    _validate(tables, reservation.start_at, reservation.end_at, exclude=reservation)
    reservation.save()
    _write_slots(reservation, tables)
    _announce(reservation)
    return reservation


@transaction.atomic
def add_advance(reservation_id, user, *, method, amount, reference="") -> ReservationPayment:
    reservation = _lock(reservation_id)
    _require_confirmed(reservation, "Advances can only be taken on a confirmed reservation.")
    payment = _record(
        reservation,
        user,
        kind=ReservationPayment.Kind.ADVANCE,
        method=method,
        amount=amount,
        reference=reference,
    )
    _announce(reservation)
    return payment


@transaction.atomic
def seat(reservation_id, user):
    """Open an order on the booked tables (joined into one group) carrying the advance."""
    reservation = _lock(reservation_id)
    _require_confirmed(reservation, "Only a confirmed reservation can be seated.")
    tables = sorted(reservation.tables.all(), key=lambda t: (len(t.name), t.name))
    for table in tables:
        if (
            table.merged_into_id
            or table.merged_tables.exists()
            or table.orders.filter(status__in=ACTIVE_ORDER).exists()
        ):
            raise ValidationError(f"{table.name} is still in use. Move or close that order first.")
    primary, others = tables[0], tables[1:]
    if others:
        floor.merge(primary.pk, [t.pk for t in others])
    order = orders.open_order(
        user,
        table=primary,
        guests=reservation.guests,
        customer_name=reservation.customer_name,
        customer_phone=reservation.customer_phone,
        note=f"Reservation #{reservation.pk}",
    )
    order.advance = reservation.advance
    order.save(update_fields=["advance", "updated_at"])
    reservation.order = order
    reservation.status = Reservation.Status.SEATED
    reservation.save(update_fields=["order", "status", "updated_at"])
    _announce(reservation)
    return reservation


@transaction.atomic
def cancel(
    reservation_id,
    user,
    *,
    no_show=False,
    outcome="",
    refund_amount=None,
    method="",
    reference="",
    reason="",
) -> Reservation:
    """Cancel or mark a no-show. With an advance held, `outcome` is `refund` or `forfeit`.

    A refund can be partial; whatever isn't refunded is kept.
    """
    reservation = _lock(reservation_id)
    _require_confirmed(reservation, "Only a confirmed reservation can be cancelled.")
    held = reservation.advance
    if held > 0:
        if outcome == "refund":
            amount = held if refund_amount is None else refund_amount
            if amount > held:
                raise ValidationError({"refund_amount": f"Only {held} was paid in advance."})
            if not method:
                raise ValidationError({"method": "Choose how the refund was paid."})
            _record(
                reservation,
                user,
                kind=ReservationPayment.Kind.REFUND,
                method=method,
                amount=amount,
                reference=reference,
            )
            reservation.advance_outcome = Reservation.AdvanceOutcome.REFUNDED
        elif outcome == "forfeit":
            reservation.advance_outcome = Reservation.AdvanceOutcome.FORFEITED
        else:
            raise ValidationError(
                {"outcome": "This booking has an advance: choose refund or forfeit."}
            )
    reservation.status = Reservation.Status.NO_SHOW if no_show else Reservation.Status.CANCELLED
    reservation.cancel_reason = reason
    reservation.save()
    reservation.slots.update(is_active=False)
    _announce(reservation)
    return reservation


def availability(start_at, end_at, exclude=None):
    """Per active table: the booking that blocks it in the window, or None."""
    if end_at <= start_at:
        raise ValidationError({"end": "The end time must be after the start time."})
    tables = list(Table.objects.filter(is_active=True).select_related("room"))
    blocked = {s.table_id: s.reservation for s in conflicts(tables, start_at, end_at, exclude)}
    return [(table, blocked.get(table.pk)) for table in tables]
