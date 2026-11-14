from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from apps.core import backup


class Command(BaseCommand):
    help = (
        "Load a backup zip made by the Backup page or create_backup. Run `migrate` first. "
        "Refuses a database that already has data unless --replace is given."
    )

    def add_arguments(self, parser):
        parser.add_argument("path", help="The backup zip.")
        parser.add_argument(
            "--replace",
            action="store_true",
            help="Delete everything in this database (and uploaded files) before restoring.",
        )
        parser.add_argument("--yes", action="store_true", help="Don't ask before --replace.")

    def handle(self, *args, path, replace=False, yes=False, **options):
        zip_path = Path(path)
        if not zip_path.is_file():
            raise CommandError(f"No such file: {zip_path}")
        try:
            manifest = backup.read_manifest(zip_path)
            self.stdout.write(
                f"Backup from {manifest['created_at']}: "
                f"{sum(manifest['counts'].values())} rows, {manifest['media_files']} files."
            )
            if replace and backup.in_use() and not yes:
                answer = input("This deletes ALL current data on this server. Type 'replace': ")
                if answer.strip() != "replace":
                    raise CommandError("Cancelled; nothing was changed.")
            result = backup.restore(zip_path, replace=replace)
        except backup.BackupError as exc:
            raise CommandError(str(exc)) from exc

        for warning in result["warnings"]:
            self.stdout.write(self.style.WARNING(warning))
        expected, restored = manifest["counts"], result["counts"]
        mismatched = {k: (v, restored.get(k)) for k, v in expected.items() if restored.get(k) != v}
        if mismatched:
            raise CommandError(f"Row counts differ after restore (expected, found): {mismatched}")
        self.stdout.write(
            self.style.SUCCESS(
                f"Restored {sum(restored.values())} rows and {result['media_files']} files. "
                "Everyone needs to log in again."
            )
        )
