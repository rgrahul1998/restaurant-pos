"""Automatic backups: schedule, pruning, worker check-in, and the Settings API."""

import os
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.core import scheduler
from apps.core.models import BackupSettings
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def folder(settings, tmp_path):
    settings.BACKUP_DIR = str(tmp_path / "backups")
    settings.MEDIA_ROOT = tmp_path / "media"
    cache.delete(scheduler.WORKER_ALIVE_KEY)
    return tmp_path / "backups"


def admin():
    client = APIClient()
    client.force_authenticate(User.objects.create_user("owner", role=Role.ADMIN))
    return client


def aged(folder, name, days):
    path = folder / name
    folder.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")
    then = (timezone.now() - timedelta(days=days)).timestamp()
    os.utime(path, (then, then))
    return path


def test_defaults_are_every_3_hours_for_7_days():
    config = BackupSettings.load()
    assert (config.enabled, config.interval_hours, config.keep_days) == (True, 3, 7)


def test_tick_backs_up_when_due_then_waits(folder):
    assert scheduler.tick().startswith("pos-backup-")  # never run before: due now
    assert scheduler.tick() is None  # just ran
    assert scheduler.worker_alive()
    config = BackupSettings.load()
    assert config.last_ok and config.last_file
    assert scheduler.next_run_at(config) == config.last_run_at + timedelta(hours=3)

    config.last_run_at -= timedelta(hours=3, minutes=1)
    config.save()
    assert scheduler.tick() is not None  # due again

    config.enabled = False
    config.last_run_at -= timedelta(days=1)
    config.save()
    assert scheduler.tick() is None


def test_prune_keeps_recent_and_always_the_newest(folder):
    old = aged(folder, "pos-backup-2026-11-01-0000.zip", days=8)
    recent = aged(folder, "pos-backup-2026-11-12-0000.zip", days=2)
    other = aged(folder, "notes.txt", days=30)
    assert scheduler.prune(7) == [old.name]
    assert recent.exists() and other.exists()  # only our own backups are touched

    recent.unlink()
    lonely = aged(folder, "pos-backup-2026-10-01-0000.zip", days=40)
    assert scheduler.prune(7) == []  # the only backup left is kept, however old
    assert lonely.exists()


def test_failed_backup_is_recorded(folder, monkeypatch):
    def boom(out):
        raise OSError("disk full")

    monkeypatch.setattr(scheduler.backup, "write_backup", boom)
    with pytest.raises(OSError):
        scheduler.run_backup()
    config = BackupSettings.load()
    assert not config.last_ok and config.last_error == "disk full"
    assert list(folder.glob("*")) == []  # no half-written file left behind


def test_settings_api(folder):
    client = admin()
    state = client.get("/api/settings/backup/").data
    assert (state["interval_hours"], state["keep_days"], state["files"]) == (3, 7, [])
    assert state["worker_seen_at"] is None

    state = client.patch(
        "/api/settings/backup/", {"interval_hours": 6, "keep_days": 14}, format="json"
    ).data
    assert (state["interval_hours"], state["keep_days"]) == (6, 14)
    assert (
        client.patch("/api/settings/backup/", {"interval_hours": 5}, format="json").status_code
        == 400
    )
    assert client.patch("/api/settings/backup/", {"keep_days": 0}, format="json").status_code == 400

    made = client.post("/api/settings/backup/run/").data
    assert client.get("/api/settings/backup/").data["files"][0]["name"] == made["name"]
    response = client.get(f"/api/settings/backup/files/{made['name']}/")
    assert response.status_code == 200
    assert b"".join(response.streaming_content)[:2] == b"PK"  # a zip
    assert client.get("/api/settings/backup/files/..%2F..%2Fsettings.py/").status_code == 404


def test_settings_are_admin_only():
    client = APIClient()
    client.force_authenticate(User.objects.create_user("boss", role=Role.MANAGER))
    assert client.get("/api/settings/backup/").status_code == 403
    assert client.post("/api/settings/backup/run/").status_code == 403
