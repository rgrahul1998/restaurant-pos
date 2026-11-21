"""Jain portions: a separate line per dish, "(J)" on the KOT and bill."""

import base64
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.floor.models import Room, Table
from apps.kitchen.models import KOT, Station
from apps.menu.models import Category, MenuItem
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db


def client_for(role):
    user, _ = User.objects.get_or_create(username=f"u_{role}", defaults={"role": role})
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def setup():
    cache.delete("printing:page-alive")
    table = Table.objects.create(room=Room.objects.create(name="Hall"), name="T1")
    mains = Category.objects.create(name="Mains", station=Station.objects.create(name="Kitchen"))
    dal = MenuItem.objects.create(category=mains, name="Dal Makhani", price="240", has_jain=True)
    naan = MenuItem.objects.create(category=mains, name="Butter Naan", price="60")
    return table, dal, naan


def test_jain_and_regular_are_separate_lines_and_print_with_j(setup):
    table, dal, naan = setup
    waiter = client_for(Role.WAITER)
    lines = [
        {"menu_item": dal.id, "quantity": 1},
        {"menu_item": dal.id, "quantity": 2, "is_jain": True},
        {"menu_item": naan.id, "quantity": 3},
    ]
    order = waiter.post("/api/orders/", {"table": table.id, "lines": lines}, format="json").data
    assert [(i["name"], i["is_jain"], i["quantity"]) for i in order["items"]] == [
        ("Dal Makhani", False, 1),
        ("Dal Makhani", True, 2),
        ("Butter Naan", False, 3),
    ]
    assert order["total"] == "900.00"  # Jain costs the same

    waiter.post(f"/api/orders/{order['id']}/fire/")
    kot = KOT.objects.get(order_id=order["id"])
    assert sorted((i.name, i.is_jain) for i in kot.items.all()) == [
        ("Butter Naan", False),
        ("Dal Makhani", False),
        ("Dal Makhani", True),
    ]
    kitchen_view = client_for(Role.KITCHEN).get(f"/api/kots/{kot.id}/").data
    assert [i["is_jain"] for i in kitchen_view["items"]] == [False, True, False]

    since = (timezone.now() - timedelta(minutes=5)).isoformat()
    tickets = client_for(Role.KITCHEN).get("/api/printing/pending/", {"since": since}).data
    printed = base64.b64decode(tickets["tickets"][0]["ticket"]).decode("ascii", "replace")
    assert "Dal Makhani (J)" in printed
    assert printed.count("(J)") == 1
    # The regular portion of a dish with a Jain option is marked too; other dishes aren't.
    assert "Dal Makhani (R)" in printed
    assert printed.count("(R)") == 1


def test_jain_needs_the_option_on_the_dish(setup):
    table, _, naan = setup
    lines = [{"menu_item": naan.id, "is_jain": True}]
    response = client_for(Role.WAITER).post(
        "/api/orders/", {"table": table.id, "lines": lines}, format="json"
    )
    assert response.status_code == 400
    assert "no Jain option" in str(response.data)


def test_reprint_keeps_jain(setup):
    table, dal, _ = setup
    waiter = client_for(Role.WAITER)
    lines = [{"menu_item": dal.id, "is_jain": True}]
    order = waiter.post("/api/orders/", {"table": table.id, "lines": lines}, format="json").data
    waiter.post(f"/api/orders/{order['id']}/fire/")
    kot = KOT.objects.get(order_id=order["id"])
    assert waiter.post(f"/api/kots/{kot.id}/reprint/").status_code == 204
    copy = KOT.objects.exclude(pk=kot.pk).get(order_id=order["id"])
    assert copy.items.get().is_jain
