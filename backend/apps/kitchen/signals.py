from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.core.realtime import KITCHEN_GROUP, PRINTER_GROUP, broadcast

from .models import KOT
from .serializers import KOTSerializer


@receiver(post_save, sender=KOT)
def kot_changed(sender, instance, created, raw=False, **kwargs):
    if raw:  # loading a backup: nobody is watching, and related rows may not exist yet
        return
    # on_commit: a new ticket's items are written after the ticket row itself.
    transaction.on_commit(
        lambda: broadcast(
            KITCHEN_GROUP,
            "kot.created" if created else "kot.updated",
            KOTSerializer(instance).data,
        )
    )
    if created:  # wake the Printer page now instead of on its next check
        transaction.on_commit(lambda: broadcast(PRINTER_GROUP, "print.ready", {}))
