"""Joining tables for a large party, and keeping a group's status in step.

A group is a star: joined tables point at one primary table (`merged_into`).
The order always sits on the primary; the others mirror its status.
"""

from django.db import transaction
from rest_framework.exceptions import ValidationError

from .models import Table

ACTIVE_ORDER = ["open", "billed"]


def set_status(table: Table, status: Table.Status):
    for member in [table, *table.merged_tables.all()]:
        if member.status != status:
            member.status = status
            member.save(update_fields=["status", "updated_at"])


def release(primary: Table):
    """Dissolve the group around `primary`, freeing the joined tables."""
    for member in primary.merged_tables.all():
        member.merged_into = None
        member.status = Table.Status.FREE
        member.save(update_fields=["merged_into", "status", "updated_at"])


def lock_primary(table: Table) -> Table:
    """The table that actually holds the order for `table`, locked for this transaction."""
    return Table.objects.select_for_update().get(pk=table.merged_into_id or table.pk)


@transaction.atomic
def merge(table_id, target_ids) -> Table:
    primary = lock_primary(Table.objects.get(pk=table_id))
    targets = list(
        Table.objects.select_for_update().filter(pk__in=set(target_ids)).exclude(pk=primary.pk)
    )
    if not targets:
        raise ValidationError("Pick at least one other table to join.")
    for table in targets:
        if table.room_id != primary.room_id:
            raise ValidationError(f"{table.name} is in a different room.")
        if table.merged_into_id or table.merged_tables.exists():
            raise ValidationError(f"{table.name} is already joined with other tables.")
        if (
            table.status != Table.Status.FREE
            or table.orders.filter(status__in=ACTIVE_ORDER).exists()
        ):
            raise ValidationError(f"{table.name} is occupied. Only free tables can be joined.")
        table.merged_into = primary
        table.status = primary.status
        table.save(update_fields=["merged_into", "status", "updated_at"])
    primary.save(update_fields=["updated_at"])  # announces the new group on the floor feed
    return primary


@transaction.atomic
def unmerge(table_id) -> Table:
    primary = lock_primary(Table.objects.get(pk=table_id))
    if not primary.merged_tables.exists():
        raise ValidationError(f"{primary.name} isn't joined with any other table.")
    release(primary)
    primary.save(update_fields=["updated_at"])
    return primary
