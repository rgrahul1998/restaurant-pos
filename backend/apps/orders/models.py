from decimal import Decimal

from django.conf import settings
from django.db import models
from simple_history.models import HistoricalRecords

from apps.core.models import TimeStampedModel


class Order(TimeStampedModel):
    class Type(models.TextChoices):
        DINE_IN = "dine_in", "Dine In"
        TAKEAWAY = "takeaway", "Takeaway"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        BILLED = "billed", "Billed"  # bill printed, awaiting payment
        PAID = "paid", "Paid"
        CANCELLED = "cancelled", "Cancelled"

    order_type = models.CharField(max_length=12, choices=Type.choices, default=Type.DINE_IN)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.OPEN)
    table = models.ForeignKey(
        "floor.Table", on_delete=models.PROTECT, null=True, blank=True, related_name="orders"
    )
    guests = models.PositiveSmallIntegerField(default=1)
    customer_name = models.CharField(max_length=120, blank=True)
    customer_phone = models.CharField(max_length=20, blank=True)
    note = models.CharField(max_length=255, blank=True)

    waiter = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="orders_taken"
    )
    cashier = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="orders_billed",
    )

    subtotal = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    discount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    # Set when the discount was given as a percentage; `discount` holds the resulting amount.
    discount_percent = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    total = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    # Paid ahead on a reservation and taken off the bill; set when the party is seated.
    advance = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    closed_at = models.DateTimeField(null=True, blank=True)

    history = HistoricalRecords()

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["status", "created_at"])]
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(order_type="dine_in") | models.Q(table__isnull=False),
                name="dine_in_order_has_table",
            ),
            models.UniqueConstraint(
                fields=["table"],
                condition=models.Q(status__in=["open", "billed"]),
                name="one_active_order_per_table",
            ),
        ]

    def __str__(self):
        return f"Order #{self.pk}"

    @property
    def paid(self):
        return sum((p.amount for p in self.payments.all()), Decimal("0"))

    @property
    def balance(self):
        return self.total - self.advance - self.paid

    def recalculate(self):
        self.subtotal = sum((i.line_total for i in self.items.all()), Decimal("0"))
        self.total = max(self.subtotal - self.discount, Decimal("0"))


class OrderItem(TimeStampedModel):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="items")
    menu_item = models.ForeignKey("menu.MenuItem", on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=120)  # snapshot at time of order
    unit_price = models.DecimalField(max_digits=10, decimal_places=2)  # snapshot
    quantity = models.PositiveIntegerField(default=1)
    # How much of `quantity` the kitchen has already been told about. The next KOT
    # carries only the difference, so re-sending an order never double-fires items.
    kot_quantity = models.PositiveIntegerField(default=0)
    note = models.CharField(max_length=255, blank=True)
    # Jain and regular portions of one dish are separate lines, so each prints on its own.
    is_jain = models.BooleanField(default=False)

    history = HistoricalRecords()

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        return f"{self.quantity} × {self.name}{' (J)' if self.is_jain else ''}"

    @property
    def line_total(self):
        return self.unit_price * self.quantity


class Payment(TimeStampedModel):
    class Method(models.TextChoices):
        CASH = "cash", "Cash"
        CARD = "card", "Card"
        UPI = "upi", "UPI"
        OTHER = "other", "Other"

    order = models.ForeignKey(Order, on_delete=models.PROTECT, related_name="payments")
    method = models.CharField(max_length=8, choices=Method.choices)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    reference = models.CharField(max_length=80, blank=True)
    received_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )

    history = HistoricalRecords()

    def __str__(self):
        return f"{self.get_method_display()} {self.amount}"
