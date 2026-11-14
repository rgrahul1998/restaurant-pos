import pytest
from rest_framework.test import APIClient

from apps.floor.models import Room, Table
from apps.kitchen.models import Station
from apps.menu.models import Category, MenuItem
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db


@pytest.fixture
def waiter():
    client = APIClient()
    client.force_authenticate(User.objects.create(username="w", role=Role.WAITER))
    return client


@pytest.fixture
def cashier():
    client = APIClient()
    client.force_authenticate(User.objects.create(username="c", role=Role.CASHIER))
    return client


@pytest.fixture
def floor():
    hall, terrace = Room.objects.create(name="Hall"), Room.objects.create(name="Terrace")
    tables = {name: Table.objects.create(room=hall, name=name) for name in ("H1", "H2", "H3")}
    tables["T1"] = Table.objects.create(room=terrace, name="T1")
    return tables


@pytest.fixture
def dish():
    category = Category.objects.create(name="Grill", station=Station.objects.create(name="Grill"))
    return MenuItem.objects.create(category=category, name="Tikka", price="100.00")


def statuses(floor):
    return {name: Table.objects.get(pk=t.pk).status for name, t in floor.items()}


def order_at(client, table, dish):
    body = {"table": table.id, "lines": [{"menu_item": dish.id, "quantity": 1}]}
    response = client.post("/api/orders/", body, format="json")
    assert response.status_code == 201, response.data
    return response.data


def merge(client, table, *others):
    return client.post(
        f"/api/tables/{table.id}/merge/", {"tables": [t.id for t in others]}, format="json"
    )


def test_merge_then_order_spans_the_group(waiter, cashier, floor, dish):
    merged = merge(waiter, floor["H1"], floor["H2"], floor["H3"])
    assert merged.status_code == 200, merged.data
    assert merged.data["label"] == "H1 + H2 + H3"

    # Ordering from a joined table lands on the primary.
    order = order_at(waiter, floor["H2"], dish)
    assert (order["table"], order["table_name"]) == (floor["H1"].id, "H1 + H2 + H3")
    assert statuses(floor) == {"H1": "occupied", "H2": "occupied", "H3": "occupied", "T1": "free"}
    assert waiter.get(f"/api/tables/{floor['H3'].id}/").data["active_order"] == order["id"]
    listed = {t["name"]: t for t in waiter.get("/api/tables/").data["results"]}
    assert listed["H3"]["active_order"] == order["id"]
    assert listed["H3"]["merged_into"] == floor["H1"].id

    url = f"/api/orders/{order['id']}/"
    waiter.post(url + "fire/")
    cashier.post(url + "bill/")
    assert statuses(floor)["H3"] == "billed"
    cashier.post("/api/payments/", {"order": order["id"], "method": "cash", "amount": "100"})

    # Paying frees every table and dissolves the group.
    assert set(statuses(floor).values()) == {"free"}
    assert not Table.objects.filter(merged_into__isnull=False).exists()


def test_merge_onto_an_occupied_table(waiter, floor, dish):
    order_at(waiter, floor["H1"], dish)
    assert merge(waiter, floor["H1"], floor["H2"]).status_code == 200
    assert statuses(floor)["H2"] == "occupied"


@pytest.mark.parametrize("case", ["occupied", "other_room", "already_joined", "self", "kitchen"])
def test_merge_rejections(waiter, floor, dish, case):
    client, anchor, target = waiter, floor["H1"], floor["H2"]
    if case == "occupied":
        order_at(waiter, floor["H2"], dish)
    elif case == "other_room":
        target = floor["T1"]
    elif case == "already_joined":
        merge(waiter, floor["H3"], floor["H2"])
    elif case == "self":
        target = floor["H1"]
    elif case == "kitchen":
        client = APIClient()
        client.force_authenticate(User.objects.create(username="k", role=Role.KITCHEN))
    assert merge(client, anchor, target).status_code == (403 if case == "kitchen" else 400)


def test_unmerge_keeps_the_order_on_the_primary(waiter, floor, dish):
    merge(waiter, floor["H1"], floor["H2"])
    order = order_at(waiter, floor["H1"], dish)
    # Splitting works from any table in the group.
    assert waiter.post(f"/api/tables/{floor['H2'].id}/unmerge/").data["label"] == "H1"
    assert statuses(floor) == {"H1": "occupied", "H2": "free", "H3": "free", "T1": "free"}
    assert waiter.get(f"/api/orders/{order['id']}/").data["table_name"] == "H1"
    assert waiter.post(f"/api/tables/{floor['H1'].id}/unmerge/").status_code == 400


def test_transfer(waiter, cashier, floor, dish):
    merge(waiter, floor["H1"], floor["H2"])
    order = order_at(waiter, floor["H1"], dish)
    url = f"/api/orders/{order['id']}/transfer/"

    order_at(waiter, floor["H3"], dish)
    assert waiter.post(url, {"table": floor["H3"].id}).status_code == 400  # occupied
    assert waiter.post(url, {"table": floor["H2"].id}).status_code == 400  # its own group

    # Moving to another room is fine; the old group is freed and split.
    moved = waiter.post(url, {"table": floor["T1"].id})
    assert moved.status_code == 200, moved.data
    assert moved.data["table_name"] == "T1"
    assert statuses(floor) == {"H1": "free", "H2": "free", "H3": "occupied", "T1": "occupied"}
    assert not Table.objects.filter(merged_into__isnull=False).exists()

    # A billed order keeps its billed look when it moves.
    waiter.post(f"/api/orders/{order['id']}/fire/")
    cashier.post(f"/api/orders/{order['id']}/bill/")
    assert waiter.post(url, {"table": floor["H1"].id}).status_code == 200
    assert statuses(floor) == {"H1": "billed", "H2": "free", "H3": "occupied", "T1": "free"}


def test_takeaway_cannot_transfer(waiter, floor, dish):
    body = {"order_type": "takeaway", "lines": [{"menu_item": dish.id}]}
    order = waiter.post("/api/orders/", body, format="json").data
    url = f"/api/orders/{order['id']}/transfer/"
    assert waiter.post(url, {"table": floor["H1"].id}).status_code == 400
