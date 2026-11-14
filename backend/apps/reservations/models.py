from decimal import Decimal

from django.conf import settings
from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import DateTimeRangeField, RangeOperators
from django.db import models
from simple_history.models import HistoricalRecords

from apps.core.models import TimeStampedModel
from apps.orders.models import Payment


class Reservation(TimeStampedModel):
    """A booking of one or more tables (a private room is set up as a table) for a time window."""

    class Status(models.TextChoices):
        CONFIRMED = "confirmed", "Confirmed"
        SEATED = "seated", "Seated"
        CANCELLED = "cancelled", "Cancelled"
        NO_SHOW = "no_show", "No-show"

    class Occasion(models.TextChoices):
        BIRTHDAY = "birthday", "Birthday"
        ANNIVERSARY = "anniversary", "Anniversary"
        CORPORATE = "corporate", "Corporate"
        OTHER = "other", "Other"

    class AdvanceOutcome(models.TextChoices):
        REFUNDED = "refunded", "Refunded"
        FORFEITED = "forfeited", "Forfeited"

    customer_name = models.CharField(max_length=120)
    customer_phone = models.CharField(max_length=20)
    guests = models.PositiveSmallIntegerField(default=1)
    occasion = models.CharField(max_length=16, choices=Occasion.choices, default=Occasion.OTHER)
    note = models.CharField(max_length=500, blank=True)
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    tables = models.ManyToManyField("floor.Table", through="ReservationTable", related_name="+")
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.CONFIRMED)
    advance_outcome = models.CharField(max_length=12, choices=AdvanceOutcome.choices, blank=True)
    cancel_reason = models.CharField(max_length=255, blank=True)
    order = models.OneToOneField(
        "orders.Order",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="reservation",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )

    history = HistoricalRecords()

    class Meta:
        ordering = ["start_at"]
        indexes = [models.Index(fields=["start_at", "end_at"])]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(end_at__gt=models.F("start_at")),
                name="reservation_ends_after_start",
            ),
        ]

    def __str__(self):
        return f"Reservation #{self.pk} {self.customer_name}"

    @property
    def advance(self):
        """Advance held: everything paid ahead, less refunds."""
        total = Decimal("0")
        for payment in self.payments.all():
            sign = -1 if payment.kind == ReservationPayment.Kind.REFUND else 1
            total += sign * payment.amount
        return total


class ReservationTable(models.Model):
    """One booked table. Postgres refuses two active rows for a table with overlapping times."""

    reservation = models.ForeignKey(Reservation, on_delete=models.CASCADE, related_name="slots")
    table = models.ForeignKey("floor.Table", on_delete=models.PROTECT, related_name="+")
    # Copy of the reservation's [start_at, end_at): touching bookings (7-9, 9-11) don't clash.
    period = DateTimeRangeField()
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["reservation", "table"], name="unique_table_per_reservation"
            ),
            ExclusionConstraint(
                name="no_overlapping_table_bookings",
                expressions=[("table", RangeOperators.EQUAL), ("period", RangeOperators.OVERLAPS)],
                condition=models.Q(is_active=True),
            ),
        ]

    def __str__(self):
        return f"{self.table} for reservation #{self.reservation_id}"


class ReservationPayment(TimeStampedModel):
    class Kind(models.TextChoices):
        ADVANCE = "advance", "Advance"
        REFUND = "refund", "Refund"

    reservation = models.ForeignKey(Reservation, on_delete=models.PROTECT, related_name="payments")
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.ADVANCE)
    method = models.CharField(max_length=8, choices=Payment.Method.choices)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    reference = models.CharField(max_length=80, blank=True)
    received_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )

    history = HistoricalRecords()

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        return f"{self.get_kind_display()} {self.amount}"
