"""First run: a brand-new install has no users. Until it does, anyone who reaches the server can
set it up, in one of three ways:

- blank:   just the Admin account and the restaurant's name; build the menu and floor yourself
- demo:    the Admin account plus a ready-made restaurant to try things on (`apps.core.demo`)
- restore: load a backup zip from another server (everyone keeps their old logins)

Once any user exists, every one of these is refused, so setup can't be used to take over a
running POS.
"""

from pathlib import Path

from django.db import connection, transaction

from apps.core import backup, demo
from apps.printing.models import Restaurant
from apps.users.models import Role, User

# pg_advisory_xact_lock key: two browsers pressing "Set up" together can't both win.
LOCK = 724_001


class SetupError(Exception):
    pass


def needed() -> bool:
    return not User.objects.exists() and not backup.in_use()


def _lock():
    if connection.vendor == "postgresql":
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(%s)", [LOCK])


def _require_fresh():
    if not needed():
        raise SetupError("This POS is already set up. Sign in instead.")


@transaction.atomic
def create(*, mode: str, username: str, password: str, restaurant_name="", full_name="") -> User:
    _lock()
    _require_fresh()
    first, _, last = full_name.strip().partition(" ")
    admin = User(username=username, first_name=first, last_name=last, role=Role.ADMIN)
    admin.set_password(password)
    admin.save()
    if mode == "demo":
        demo.load(admin, password)
    if restaurant_name:
        restaurant = Restaurant.load()
        restaurant.name = restaurant_name
        restaurant.save()
    return admin


@transaction.atomic
def restore(path: Path) -> dict:
    _lock()
    _require_fresh()
    try:
        return backup.restore(path)
    except backup.BackupError as exc:
        raise SetupError(str(exc)) from exc
