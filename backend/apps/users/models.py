from django.contrib.auth.models import AbstractUser
from django.db import models
from simple_history.models import HistoricalRecords


class Role(models.TextChoices):
    ADMIN = "admin", "Admin"
    MANAGER = "manager", "Manager"
    CASHIER = "cashier", "Cashier"
    WAITER = "waiter", "Waiter"
    KITCHEN = "kitchen", "Kitchen"


class User(AbstractUser):
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.WAITER)
    phone = models.CharField(max_length=20, blank=True)

    history = HistoricalRecords(excluded_fields=["password", "last_login"])

    def save(self, *args, **kwargs):
        # Superusers (createsuperuser) are always Admins; Admins get the Django admin site.
        if self.is_superuser:
            self.role = Role.ADMIN
        self.is_staff = self.is_superuser = self.role == Role.ADMIN
        super().save(*args, **kwargs)
