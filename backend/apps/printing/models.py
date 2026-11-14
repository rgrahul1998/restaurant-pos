from django.conf import settings
from django.db import models

from apps.core.models import TimeStampedModel


class Restaurant(models.Model):
    """The restaurant's own details, for the bill header. Exactly one row; Settings edits it."""

    DEFAULT_FOOTER = "Thank You. Visit Again."

    name = models.CharField(max_length=120, default="Restaurant")
    legal_name = models.CharField(
        max_length=120, blank=True, help_text="Registered business name, if different."
    )
    address_line1 = models.CharField(max_length=120, blank=True)
    address_line2 = models.CharField(max_length=120, blank=True)
    city = models.CharField(max_length=80, blank=True)
    state = models.CharField(max_length=60, blank=True)
    pincode = models.CharField(max_length=12, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    email = models.EmailField(blank=True)
    gstin = models.CharField("GSTIN", max_length=15, blank=True)
    fssai = models.CharField("FSSAI licence number", max_length=14, blank=True)
    bill_footer = models.CharField(max_length=120, blank=True, default=DEFAULT_FOOTER)

    class Meta:
        verbose_name = "restaurant details"
        verbose_name_plural = "restaurant details"

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    @classmethod
    def load(cls):
        return cls.objects.get_or_create(pk=1)[0]


class KOTPrintLog(models.Model):
    """A KOT that reached paper. Its absence is what makes a KOT "pending"."""

    kot = models.OneToOneField("kitchen.KOT", on_delete=models.CASCADE, related_name="print_log")
    printer = models.CharField(max_length=200, blank=True)
    printed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "KOT print log"

    def __str__(self):
        return f"KOT-{self.kot_id}"


class BillPrintJob(TimeStampedModel):
    """A request from the POS to print a bill on the laptop's printer."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PRINTED = "printed", "Printed"

    order = models.ForeignKey("orders.Order", on_delete=models.CASCADE, related_name="print_jobs")
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.PENDING)
    printer = models.CharField(max_length=200, blank=True)
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="+"
    )

    class Meta:
        indexes = [models.Index(fields=["status", "created_at"])]

    def __str__(self):
        return f"Bill #{self.order_id}"
