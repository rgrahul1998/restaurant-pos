from getpass import getpass

from django.core.management.base import BaseCommand, CommandError

from apps.core import setup


class Command(BaseCommand):
    help = (
        "Set up a fresh POS from the command line: an Admin account, blank or with demo data. "
        "(The browser does the same at /setup.) To move from another server use restore_backup."
    )

    def add_arguments(self, parser):
        parser.add_argument("--demo", action="store_true", help="Load the demo restaurant too.")
        parser.add_argument("--username", default="admin")
        parser.add_argument("--password", help="Asked for if not given.")
        parser.add_argument("--restaurant", default="", help="Restaurant name for the bill.")

    def handle(self, *args, demo, username, password, restaurant, **options):
        if not setup.needed():
            raise CommandError("This database already has data; setup is for a fresh install.")
        password = password or getpass(f"Password for {username}: ")
        if len(password) < 8:
            raise CommandError("Use at least 8 characters.")
        try:
            setup.create(
                mode="demo" if demo else "blank",
                restaurant_name=restaurant,
                username=username,
                password=password,
            )
        except setup.SetupError as exc:
            raise CommandError(str(exc)) from exc
        extra = ""
        if demo:
            extra = " Demo staff (manager, cashier, waiter, meena, kitchen) share that password."
        self.stdout.write(self.style.SUCCESS(f"Ready. Sign in as {username}.{extra}"))
