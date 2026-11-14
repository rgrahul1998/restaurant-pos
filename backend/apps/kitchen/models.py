from django.conf import settings
from django.db import models
from simple_history.models import HistoricalRecords

from apps.core.models import TimeStampedModel


class Station(TimeStampedModel):
    """A production unit with its own KDS screen / printer: Grill, Tandoor, Bar…"""

    name = models.CharField(max_length=60, unique=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class KOT(TimeStampedModel):
    """Kitchen Order Ticket: one batch of an order's items sent to the kitchen together.

    Tickets from "Send to kitchen" list every item and have no station; older tickets
    were split per station and keep theirs.
    """

    class Type(models.TextChoices):
        NEW = "new", "New Order"
        MODIFIED = "modified", "Order Modified"
        CANCELLED = "cancelled", "Cancelled"
        PARTIALLY_CANCELLED = "partially_cancelled", "Partially Cancelled"
        DUPLICATE = "duplicate", "Duplicate"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PREPARING = "preparing", "Preparing"
        READY = "ready", "Ready"
        SERVED = "served", "Served"

    order = models.ForeignKey("orders.Order", on_delete=models.CASCADE, related_name="kots")
    station = models.ForeignKey(
        Station, on_delete=models.PROTECT, null=True, blank=True, related_name="kots"
    )
    type = models.CharField(max_length=20, choices=Type.choices, default=Type.NEW)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.PENDING)
    # For Modified / Cancelled tickets: the ticket this one amends.
    original = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="amendments"
    )
    note = models.CharField(max_length=255, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    # A tablet said it prints this itself; the Printer page leaves it alone for a while.
    print_claimed_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    ready_at = models.DateTimeField(null=True, blank=True)
    served_at = models.DateTimeField(null=True, blank=True)

    history = HistoricalRecords()

    class Meta:
        ordering = ["created_at"]
        verbose_name = "KOT"
        indexes = [models.Index(fields=["station", "status"])]

    def __str__(self):
        return f"KOT #{self.pk}"


class KOTItem(models.Model):
    kot = models.ForeignKey(KOT, on_delete=models.CASCADE, related_name="items")
    order_item = models.ForeignKey(
        "orders.OrderItem", on_delete=models.CASCADE, related_name="kot_items"
    )
    name = models.CharField(max_length=120)  # snapshot; survives menu renames
    quantity = models.PositiveIntegerField()
    cancelled_quantity = models.PositiveIntegerField(default=0)
    note = models.CharField(max_length=255, blank=True)
    is_jain = models.BooleanField(default=False)

    def __str__(self):
        return f"{self.quantity} × {self.name}{' (J)' if self.is_jain else ''}"
