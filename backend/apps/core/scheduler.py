"""Automatic backups: written to BACKUP_DIR on the schedule in BackupSettings, pruned by age.

`manage.py backup_worker` calls `tick()` once a minute. A Postgres advisory lock makes sure only
one backup runs at a time, even with two workers or a "Back up now" click at the same moment.
"""

import logging
import os
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from django.conf import settings
from django.core.cache import cache
from django.db import connection
from django.utils import timezone

from . import backup
from .models import BackupSettings

log = logging.getLogger(__name__)

WORKER_ALIVE_KEY = "backup:worker-alive"
WORKER_ALIVE_SECONDS = 180  # three missed minutes means the worker is down
LOCK_ID = 7_401_202  # any constant; identifies "a backup is running" to Postgres


class Busy(Exception):
    """Another backup is already being written."""


def backup_dir() -> Path:
    return Path(settings.BACKUP_DIR)


def stored() -> list[dict]:
    """Backups in BACKUP_DIR, newest first."""
    folder = backup_dir()
    if not folder.exists():
        return []
    files = [p for p in folder.glob("pos-backup-*.zip") if p.is_file()]
    rows = [
        {
            "name": p.name,
            "size": p.stat().st_size,
            "created_at": datetime.fromtimestamp(
                p.stat().st_mtime, tz=timezone.get_current_timezone()
            ),
        }
        for p in files
    ]
    return sorted(rows, key=lambda r: r["created_at"], reverse=True)


def next_run_at(config: BackupSettings):
    if not config.enabled:
        return None
    if config.last_run_at is None:
        return timezone.now()
    return config.last_run_at + timedelta(hours=config.interval_hours)


def worker_alive():
    """When the worker last checked in, or None if it hasn't in the last few minutes."""
    return cache.get(WORKER_ALIVE_KEY)


@contextmanager
def _lock():
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s)", [LOCK_ID])
        if not cursor.fetchone()[0]:
            raise Busy("A backup is already being written.")
        try:
            yield
        finally:
            cursor.execute("SELECT pg_advisory_unlock(%s)", [LOCK_ID])


def run_backup() -> dict:
    """Write a backup into BACKUP_DIR now, record the outcome, prune old ones. Raises Busy."""
    config = BackupSettings.load()
    folder = backup_dir()
    with _lock():
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / backup.filename()
        partial = target.with_suffix(
            ".zip.partial"
        )  # never leave a half-written zip that looks real
        try:
            with partial.open("wb") as out:
                backup.write_backup(out)
            os.replace(partial, target)
        except Exception as exc:
            partial.unlink(missing_ok=True)
            config.last_run_at, config.last_ok, config.last_error = timezone.now(), False, str(exc)
            config.save(update_fields=["last_run_at", "last_ok", "last_error"])
            log.exception("Backup failed")
            raise
        config.last_run_at, config.last_ok, config.last_error = timezone.now(), True, ""
        config.last_file = target.name
        config.save(update_fields=["last_run_at", "last_ok", "last_error", "last_file"])
        prune(config.keep_days)
    return next(r for r in stored() if r["name"] == target.name)


def prune(keep_days: int) -> list[str]:
    """Delete backups older than `keep_days`, but never the newest one."""
    cutoff = timezone.now() - timedelta(days=keep_days)
    files = stored()
    removed = []
    for row in files[1:]:
        if row["created_at"] < cutoff:
            (backup_dir() / row["name"]).unlink(missing_ok=True)
            removed.append(row["name"])
    return removed


def tick() -> str | None:
    """One scheduler step: check in, and back up if one is due. Returns the file written, if any."""
    cache.set(WORKER_ALIVE_KEY, timezone.now().isoformat(), WORKER_ALIVE_SECONDS)
    config = BackupSettings.load()
    due = next_run_at(config)
    if due is None or due > timezone.now():
        return None
    try:
        return run_backup()["name"]
    except Busy:
        return None
