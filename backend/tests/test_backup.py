"""Backup and restore: everything comes back with the same ids, and new rows don't collide."""

import io
import json
import zipfile

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from rest_framework.test import APIClient

from apps.core import backup
from apps.floor.models import Room, Table
from apps.kitchen.models import Station
from apps.menu.models import Category, MenuItem
from apps.orders.models import Order
from apps.users.models import Role, User

GIF = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00"
    b",\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
)


def client_for(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def media(settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path / "media"
    return settings.MEDIA_ROOT


@pytest.fixture
def restaurant(media):
    admin = User.objects.create_user("owner", password="secret-pass-1", role=Role.ADMIN)
    waiter = User.objects.create_user("ravi", password="ravi-pass-1", role=Role.WAITER)
    table = Table.objects.create(room=Room.objects.create(name="Hall"), name="T1")
    mains = Category.objects.create(name="Mains", station=Station.objects.create(name="Kitchen"))
    dal = MenuItem.objects.create(
        category=mains,
        name="Dal",
        price="200",
        has_jain=True,
        image=SimpleUploadedFile("dal.gif", GIF),
    )
    body = {"table": table.id, "lines": [{"menu_item": dal.id, "quantity": 2, "is_jain": True}]}
    order = client_for(waiter).post("/api/orders/", body, format="json").data
    client_for(waiter).post(f"/api/orders/{order['id']}/fire/")
    return {"admin": admin, "waiter": waiter, "order": order["id"], "dal": dal}


def make_zip(tmp_path):
    path = tmp_path / "backup.zip"
    with path.open("wb") as out:
        backup.write_backup(out)
    return path


@pytest.mark.django_db(transaction=True)
def test_round_trip_keeps_everything(restaurant, media, tmp_path):
    path = make_zip(tmp_path)
    before = backup.summary()["counts"]
    photo = restaurant["dal"].image.name

    # A different server: empty database and no uploaded files.
    call_command("flush", interactive=False, verbosity=0)
    for f in media.rglob("*"):
        if f.is_file():
            f.unlink()

    call_command("restore_backup", str(path), verbosity=0)

    assert backup.summary()["counts"] == before
    order = Order.objects.get(pk=restaurant["order"])
    line = order.items.get()
    assert (line.name, line.quantity, line.is_jain, line.kot_quantity) == ("Dal", 2, True, 2)
    assert order.kots.get().items.get().is_jain
    assert order.history.count() > 1  # change history came along
    assert User.objects.get(username="owner").check_password("secret-pass-1")
    assert (media / photo).read_bytes() == GIF

    # Ids continue after the restored ones instead of colliding with them.
    new = Order.objects.create(order_type="takeaway", waiter=restaurant["waiter"])
    assert new.pk > restaurant["order"]


@pytest.mark.django_db(transaction=True)
def test_restore_refuses_a_database_in_use(restaurant, tmp_path):
    path = make_zip(tmp_path)
    with pytest.raises(backup.BackupError, match="already has data"):
        backup.restore(path)
    # --replace wipes it and loads the backup.
    Order.objects.create(order_type="takeaway", waiter=restaurant["waiter"])
    backup.restore(path, replace=True)
    assert list(Order.objects.values_list("pk", flat=True)) == [restaurant["order"]]


@pytest.mark.django_db(transaction=True)
def test_backup_from_a_newer_version_is_refused(restaurant, tmp_path):
    path = make_zip(tmp_path)
    with zipfile.ZipFile(path) as archive:
        files = {n: archive.read(n) for n in archive.namelist()}
    manifest = json.loads(files["manifest.json"])
    manifest["migrations"]["orders"].append("9999_future")
    files["manifest.json"] = json.dumps(manifest).encode()
    newer = tmp_path / "newer.zip"
    with zipfile.ZipFile(newer, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    call_command("flush", interactive=False, verbosity=0)
    with pytest.raises(backup.BackupError, match="newer version"):
        backup.restore(newer)


def test_not_a_backup(tmp_path):
    junk = tmp_path / "junk.zip"
    junk.write_bytes(b"hello")
    with pytest.raises(backup.BackupError, match="not a zip"):
        backup.read_manifest(junk)


@pytest.mark.django_db
def test_only_admins_download(restaurant):
    manager = User.objects.create_user("boss", role=Role.MANAGER)
    assert client_for(manager).get("/api/backup/").status_code == 403
    assert client_for(manager).get("/api/backup/", {"info": 1}).status_code == 403

    response = client_for(restaurant["admin"]).get("/api/backup/")
    assert response.status_code == 200
    assert response["Content-Disposition"].startswith('attachment; filename="pos-backup-')
    archive = zipfile.ZipFile(io.BytesIO(b"".join(response.streaming_content)))
    names = archive.namelist()
    assert {"manifest.json", "data.json"} <= set(names)
    assert any(n.startswith("media/menu/") for n in names)

    info = client_for(restaurant["admin"]).get("/api/backup/", {"info": 1}).data
    assert info["counts"]["orders.Order"] == 1 and info["media_files"] == 1
