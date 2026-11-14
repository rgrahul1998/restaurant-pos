"""Whole-system backup and restore, for moving the POS to another server.

A backup is one zip:

    manifest.json   format, when, which migrations the data matches, row counts
    data.json       every row of every table (Django fixture, original ids kept)
    media/...       uploaded files (menu photos)

It is plain Django data, so it loads on any machine running this code at the same or a newer
version, whatever the Postgres version. Restore is a management command (`restore_backup`)
because a brand-new server has no users to log in with.
"""

import json
import shutil
import tempfile
import zipfile
from collections import defaultdict
from pathlib import Path

from django.apps import apps
from django.conf import settings
from django.core.management import call_command
from django.core.management.color import no_style
from django.db import connection, transaction
from django.db.migrations.recorder import MigrationRecorder
from django.utils import timezone

FORMAT = 1
# Rebuilt by `migrate` on every install; copying them would clash with the new server's rows.
# Everything that points at them is written with natural keys, so it still resolves.
EXCLUDE = ["contenttypes", "auth.permission", "sessions"]
# Any of these holding rows means the database is in use, not a fresh install.
IN_USE = ["users.User", "orders.Order", "menu.MenuItem", "floor.Table", "reservations.Reservation"]


class BackupError(Exception):
    pass


def _applied_migrations() -> dict[str, list[str]]:
    applied = defaultdict(list)
    for app, name in MigrationRecorder(connection).applied_migrations():
        applied[app].append(name)
    return {app: sorted(names) for app, names in sorted(applied.items())}


def _counts() -> dict[str, int]:
    excluded = {"contenttypes", "sessions"}
    return {
        model._meta.label: model._default_manager.count()
        for model in apps.get_models()
        if model._meta.app_label not in excluded and model._meta.label != "auth.Permission"
    }


def _media_files() -> list[Path]:
    root = Path(settings.MEDIA_ROOT)
    return sorted(p for p in root.rglob("*") if p.is_file()) if root.exists() else []


def filename() -> str:
    return f"pos-backup-{timezone.localtime():%Y-%m-%d-%H%M}.zip"


def free_path(folder: Path) -> Path:
    """`folder/pos-backup-<minute>.zip`, or `…-2.zip`, `…-3.zip` when that minute is taken.

    Two backups in one minute (the worker and someone pressing "Back up now") must never
    replace each other.
    """
    first = folder / filename()
    target, n = first, 1
    while target.exists():
        n += 1
        target = first.with_name(f"{first.stem}-{n}.zip")
    return target


def summary() -> dict:
    """What a backup made now would hold: rows per table and uploaded files."""
    files = _media_files()
    return {
        "counts": _counts(),
        "media_files": len(files),
        "media_bytes": sum(p.stat().st_size for p in files),
    }


def write_backup(out) -> dict:
    """Write a backup zip into the binary file object `out`; return its manifest."""
    with tempfile.TemporaryDirectory() as tmp:
        data = Path(tmp) / "data.json"
        # One consistent snapshot even while orders keep coming in. Only a fresh transaction can
        # set its isolation level; inside an outer one (tests) that transaction's view is used.
        fresh = not connection.in_atomic_block
        with transaction.atomic():
            if fresh and connection.vendor == "postgresql":
                with connection.cursor() as cursor:
                    cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            call_command(
                "dumpdata",
                exclude=EXCLUDE,
                natural_foreign=True,
                indent=None,
                output=str(data),
                verbosity=0,
            )
            manifest = {
                "format": FORMAT,
                "created_at": timezone.now().isoformat(),
                "time_zone": settings.TIME_ZONE,
                "migrations": _applied_migrations(),
                "counts": _counts(),
            }
        files = _media_files()
        manifest["media_files"] = len(files)

        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, indent=2))
            archive.write(data, "data.json")
            root = Path(settings.MEDIA_ROOT)
            for path in files:
                archive.write(path, f"media/{path.relative_to(root).as_posix()}")
    return manifest


def read_manifest(path: Path) -> dict:
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if not {"manifest.json", "data.json"} <= names:
                raise BackupError(
                    "This zip is not a POS backup (manifest.json or data.json missing)."
                )
            manifest = json.loads(archive.read("manifest.json"))
    except zipfile.BadZipFile as exc:
        raise BackupError("This file is not a zip archive.") from exc
    if manifest.get("format") != FORMAT:
        raise BackupError(f"Unknown backup format {manifest.get('format')!r}.")
    return manifest


def check_compatible(manifest: dict) -> list[str]:
    """Raise if the backup needs migrations this server doesn't have; return warnings otherwise."""
    here = _applied_migrations()
    missing = {
        app: sorted(set(names) - set(here.get(app, [])))
        for app, names in manifest["migrations"].items()
    }
    missing = {app: names for app, names in missing.items() if names}
    if missing:
        listed = "; ".join(f"{app}: {', '.join(names)}" for app, names in missing.items())
        raise BackupError(
            "This backup comes from a newer version of the POS. Update the code on this server "
            f"and run `migrate` first. Missing migrations: {listed}"
        )
    newer = sorted(
        app for app, names in here.items() if set(names) - set(manifest["migrations"].get(app, []))
    )
    if newer:
        return [
            f"This server is newer than the backup ({', '.join(newer)}); new fields get defaults."
        ]
    return []


def in_use() -> list[str]:
    return [label for label in IN_USE if apps.get_model(label)._default_manager.exists()]


def restore(path: Path, *, replace: bool = False) -> dict:
    """Load a backup into this database. Refuses a database already in use unless `replace`."""
    manifest = read_manifest(path)
    warnings = check_compatible(manifest)
    used = in_use()
    if used and not replace:
        raise BackupError(
            "This database already has data (" + ", ".join(used) + "). Restore into a fresh, "
            "migrated database, or pass --replace to wipe this one first."
        )

    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(path) as archive:
            archive.extract("data.json", tmp)
            media = [
                n for n in archive.namelist() if n.startswith("media/") and not n.endswith("/")
            ]
            for name in media:
                target = (Path(tmp) / name).resolve()
                if not target.is_relative_to(Path(tmp).resolve()):  # zip-slip guard
                    raise BackupError(f"Unsafe path in backup: {name}")
                archive.extract(name, tmp)

        with transaction.atomic():
            if replace:
                call_command("flush", interactive=False, verbosity=0)
            call_command("loaddata", str(Path(tmp) / "data.json"), verbosity=0)
            _reset_sequences()

        media_root = Path(settings.MEDIA_ROOT)
        if (Path(tmp) / "media").exists():
            if replace and media_root.exists():
                shutil.rmtree(media_root)
            shutil.copytree(Path(tmp) / "media", media_root, dirs_exist_ok=True)

    return {
        "manifest": manifest,
        "warnings": warnings,
        "counts": _counts(),
        "media_files": len(media),
    }


def _reset_sequences():
    """Point every id sequence past the restored rows, so new orders don't collide with old ones."""
    statements = connection.ops.sequence_reset_sql(no_style(), apps.get_models())
    with connection.cursor() as cursor:
        for sql in statements:
            cursor.execute(sql)
