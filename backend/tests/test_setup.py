"""First-run setup: blank, demo data or a backup, and never once the POS is in use."""

import io

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from rest_framework.test import APIClient

from apps.core import backup
from apps.floor.models import Table
from apps.kitchen.models import KOT
from apps.menu.models import MenuItem
from apps.orders.models import Order
from apps.printing.models import Restaurant
from apps.reservations.models import Reservation
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db

BODY = {
    "restaurant_name": "Hill View",
    "full_name": "Asha Rao",
    "username": "asha",
    "password": "kitchen-door-42",
}


def test_fresh_server_needs_setup():
    assert APIClient().get("/api/setup/").json() == {"needed": True}


def test_blank_setup_creates_admin_and_signs_in():
    res = APIClient().post("/api/setup/", {**BODY, "mode": "blank"}, format="json")
    assert res.status_code == 201
    admin = User.objects.get()
    assert (admin.username, admin.role, admin.first_name) == ("asha", Role.ADMIN, "Asha")
    assert admin.check_password("kitchen-door-42")
    assert Restaurant.load().name == "Hill View"
    assert not MenuItem.objects.exists()

    me = APIClient(headers={"Authorization": f"Bearer {res.json()['access']}"}).get("/api/auth/me/")
    assert me.json()["username"] == "asha"
    assert APIClient().get("/api/setup/").json() == {"needed": False}


def test_demo_setup_fills_the_restaurant():
    res = APIClient().post("/api/setup/", {**BODY, "mode": "demo"}, format="json")
    assert res.status_code == 201
    assert User.objects.filter(role=Role.WAITER).count() == 2
    assert User.objects.get(username="manager").check_password("kitchen-door-42")
    assert MenuItem.objects.count() > 20
    assert Order.objects.filter(status=Order.Status.PAID).count() > 200
    assert Order.objects.filter(status__in=["open", "billed"]).count() == 5
    assert Table.objects.filter(merged_into__isnull=False).count() == 1
    assert Reservation.objects.filter(status="confirmed").count() == 5
    assert not KOT.objects.filter(print_log__isnull=True).exists()  # nothing to print
    # Paid orders always balance.
    for order in Order.objects.filter(status=Order.Status.PAID)[:50]:
        assert order.balance == 0
    assert Restaurant.load().name == "Hill View"  # chosen name wins over the demo's


def test_setup_refused_once_in_use():
    User.objects.create_user("owner", password="x" * 10, role=Role.ADMIN)
    res = APIClient().post("/api/setup/", {**BODY, "mode": "demo"}, format="json")
    assert res.status_code == 409
    assert User.objects.count() == 1


def test_weak_password_refused():
    res = APIClient().post("/api/setup/", {**BODY, "mode": "blank", "password": "12345678"})
    assert res.status_code == 400
    assert not User.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_restore_on_fresh_server(settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path / "media"
    User.objects.create_user("owner", password="owner-pass-1", role=Role.ADMIN)
    out = io.BytesIO()
    backup.write_backup(out)
    call_command("flush", interactive=False, verbosity=0)

    upload = SimpleUploadedFile("b.zip", out.getvalue(), content_type="application/zip")
    res = APIClient().post("/api/setup/restore/", {"file": upload}, format="multipart")
    assert res.status_code == 201, res.content
    assert User.objects.get().check_password("owner-pass-1")

    again = SimpleUploadedFile("b.zip", out.getvalue(), content_type="application/zip")
    res = APIClient().post("/api/setup/restore/", {"file": again}, format="multipart")
    assert res.status_code == 409


def test_restore_rejects_junk():
    upload = SimpleUploadedFile("b.zip", b"not a zip", content_type="application/zip")
    res = APIClient().post("/api/setup/restore/", {"file": upload}, format="multipart")
    assert res.status_code == 400
    assert "not a zip" in res.json()["detail"]


def test_only_username_and_password_needed():
    body = {"mode": "blank", "username": "owner", "password": "kitchen-door-42"}
    assert APIClient().post("/api/setup/", body, format="json").status_code == 201
    assert APIClient().post("/api/setup/", body, format="json").status_code == 409
