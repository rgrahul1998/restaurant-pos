from django.db import models
from django.db.models.functions import Length
from simple_history.models import HistoricalRecords

from apps.core.models import TimeStampedModel


class Room(TimeStampedModel):
    """A seating area: Main Hall, Terrace, AC Section…"""

    name = models.CharField(max_length=80, unique=True)
    sort_order = models.PositiveSmallIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    history = HistoricalRecords()

    class Meta:
        ordering = ["sort_order", "name"]

    def __str__(self):
        return self.name


class Table(TimeStampedModel):
    class Shape(models.TextChoices):
        RECTANGLE = "rectangle", "Rectangle"
        SQUARE = "square", "Square"
        CIRCLE = "circle", "Circle"

    class Status(models.TextChoices):
        FREE = "free", "Free"
        OCCUPIED = "occupied", "Occupied"
        BILLED = "billed", "Billed"

    room = models.ForeignKey(Room, on_delete=models.PROTECT, related_name="tables")
    name = models.CharField(max_length=40)
    seats = models.PositiveSmallIntegerField(default=4)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.FREE)
    is_active = models.BooleanField(default=True)
    # Set on a table joined to another for a large party; the order lives on the primary.
    merged_into = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="merged_tables"
    )

    # Floor-plan editor geometry (grid units).
    shape = models.CharField(max_length=12, choices=Shape.choices, default=Shape.RECTANGLE)
    layout_x = models.FloatField(default=0)
    layout_y = models.FloatField(default=0)
    layout_width = models.FloatField(default=1)
    layout_height = models.FloatField(default=1)

    history = HistoricalRecords(excluded_fields=["status"])

    class Meta:
        # M1, M2 … M10 rather than M1, M10, M2.
        ordering = ["room", Length("name"), "name"]
        constraints = [
            models.UniqueConstraint(fields=["room", "name"], name="unique_table_name_per_room"),
        ]

    def __str__(self):
        return f"{self.room} / {self.name}"

    @property
    def label(self):
        """`M1`, or `M1 + M2` for the primary of a joined group."""
        return " + ".join([self.name, *(t.name for t in self.merged_tables.all())])
