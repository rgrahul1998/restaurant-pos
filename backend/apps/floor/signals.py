from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.core.realtime import FLOOR_GROUP, broadcast

from .models import Table
from .serializers import TableSerializer


@receiver(post_save, sender=Table)
def table_changed(sender, instance, raw=False, **kwargs):
    if raw:  # loading a backup: nobody is watching, and related rows may not exist yet
        return
    # on_commit: clients refetch when they hear this, so the change must be visible.
    transaction.on_commit(
        lambda: broadcast(FLOOR_GROUP, "table.updated", TableSerializer(instance).data)
    )
