import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from apps.core import scheduler


class Command(BaseCommand):
    help = (
        "Run automatic backups on the schedule set in Settings → Backup. Keep it running next to "
        "the web server (systemd, supervisor, or a terminal)."
    )

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Check once and exit (for cron).")

    def handle(self, *args, once=False, **options):
        if not once:
            self.stdout.write(f"Backup worker started; writing to {scheduler.backup_dir()}")
        while True:
            close_old_connections()  # survive a database restart between checks
            try:
                written = scheduler.tick()
                if written:
                    self.stdout.write(self.style.SUCCESS(f"Backed up to {written}"))
            except Exception as exc:  # noqa: BLE001 - keep the worker alive; the failure is recorded
                self.stderr.write(f"Backup check failed: {exc}")
            if once:
                return
            time.sleep(60)
