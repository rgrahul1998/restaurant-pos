from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from apps.core import backup


class Command(BaseCommand):
    help = "Write a full backup zip (all data and uploaded files), e.g. from a nightly cron job."

    def add_arguments(self, parser):
        parser.add_argument("path", nargs="?", help="Zip file or folder (default: current folder).")

    def handle(self, *args, path=None, **options):
        target = Path(path or ".")
        if target.is_dir() or not target.suffix:
            target.mkdir(parents=True, exist_ok=True)
            target = backup.free_path(target)
        elif target.exists():
            raise CommandError(f"{target} already exists; choose another name or a folder.")
        with target.open("xb") as out:  # "x": never overwrite an existing backup
            manifest = backup.write_backup(out)
        rows = sum(manifest["counts"].values())
        self.stdout.write(
            self.style.SUCCESS(
                f"Backed up {rows} rows and {manifest['media_files']} files to {target} "
                f"({target.stat().st_size / 1_048_576:.1f} MB)."
            )
        )
