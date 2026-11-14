from django.db import models
from simple_history.models import HistoricalRecords

from apps.core.models import TimeStampedModel


class Course(TimeStampedModel):
    """Serving sequence: Starters, Mains, Desserts… Drives firing order on the KDS."""

    name = models.CharField(max_length=60, unique=True)
    sort_order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "name"]

    def __str__(self):
        return self.name


class Category(TimeStampedModel):
    name = models.CharField(max_length=80, unique=True)
    # Which kitchen station cooks this category; decides where its KOTs are routed.
    station = models.ForeignKey(
        "kitchen.Station",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="categories",
    )
    sort_order = models.PositiveSmallIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    history = HistoricalRecords()

    class Meta:
        ordering = ["sort_order", "name"]
        verbose_name_plural = "categories"

    def __str__(self):
        return self.name


class MenuItem(TimeStampedModel):
    category = models.ForeignKey(Category, on_delete=models.PROTECT, related_name="items")
    course = models.ForeignKey(
        Course, on_delete=models.SET_NULL, null=True, blank=True, related_name="items"
    )
    name = models.CharField(max_length=120, unique=True)
    description = models.TextField(blank=True)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    image = models.ImageField(upload_to="menu/", blank=True)
    is_vegetarian = models.BooleanField(default=False)
    # Can be made Jain (no onion, garlic or root vegetables); waiters then pick Regular or Jain.
    has_jain = models.BooleanField("Jain option", default=False)
    is_special = models.BooleanField(default=False)
    is_available = models.BooleanField(default=True, help_text="Untick to 86 the item.")

    history = HistoricalRecords()

    class Meta:
        ordering = ["category", "name"]

    def __str__(self):
        return self.name
