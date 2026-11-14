import pytest
from rest_framework.test import APIClient

from apps.floor.models import Room, Table
from apps.kitchen.models import KOT, Station
from apps.menu.models import Category, MenuItem
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db


@pytest.fixture
def api():
    def client(role):
        user, _ = User.objects.get_or_create(username=f"u_{role}", defaults={"role": role})
        client = APIClient()
        client.force_authenticate(user)
        return client

    return client


@pytest.fixture
def table():
    return Table.objects.create(room=Room.objects.create(name="Hall"), name="T1")


@pytest.fixture
def menu():
    grill = Category.objects.create(name="Grill", station=Station.objects.create(name="Grill"))
    bar = Category.objects.create(name="Bar", station=Station.objects.create(name="Bar"))
    shelf = Category.objects.create(name="Packaged")  # no station
    return {
        "tikka": MenuItem.objects.create(category=grill, name="Tikka", price="250.00"),
        "kebab": MenuItem.objects.create(category=grill, name="Kebab", price="300.00"),
        "soda": MenuItem.objects.create(category=bar, name="Soda", price="90.00"),
        "water": MenuItem.objects.create(category=shelf, name="Water", price="20.00"),
    }


def open_order(client, table, **quantities):
    lines = [{"menu_item": item.id, "quantity": q} for item, q in quantities["lines"]]
    response = client.post("/api/orders/", {"table": table.id, "lines": lines}, format="json")
    assert response.status_code == 201, response.data
    return response.data


def line(order, name):
    return next(i for i in order["items"] if i["name"] == name)


def tickets(order):
    """Per ticket: type, and how much of each item it adds or cancels."""
    return [
        (
            k.type,
            [(i.name, i.cancelled_quantity or i.quantity) for i in k.items.all()],
        )
        for k in KOT.objects.filter(order=order["id"]).order_by("id")
    ]


def test_full_dine_in_flow(api, table, menu):
    waiter, cashier = api(Role.WAITER), api(Role.CASHIER)
    order = open_order(waiter, table, lines=[(menu["tikka"], 2), (menu["soda"], 1)])
    url = f"/api/orders/{order['id']}/"
    table.refresh_from_db()
    assert (table.status, order["total"], order["has_unsent"]) == ("occupied", "590.00", True)
    assert waiter.get(f"/api/tables/{table.id}/").data["active_order"] == order["id"]

    assert waiter.post(url + "fire/").data["has_unsent"] is False
    # One ticket for everything sent, whichever station cooks it.
    assert tickets(order) == [("new", [("Tikka", 2), ("Soda", 1)])]

    assert waiter.post(url + "bill/").status_code == 403  # waiters don't bill
    billed = cashier.post(url + "bill/", {"discount": "90.00"}).data
    table.refresh_from_db()
    assert (billed["status"], billed["total"], table.status) == ("billed", "500.00", "billed")
    assert waiter.patch(url, {"guests": 3}).status_code == 400  # locked once billed

    pay = {"order": order["id"], "method": "cash", "amount": "200.00"}
    assert cashier.post("/api/payments/", pay).status_code == 201
    assert cashier.get(url).data["balance"] == "300.00"
    assert cashier.post("/api/payments/", {**pay, "amount": "301.00"}).status_code == 400
    assert (
        cashier.post("/api/payments/", {**pay, "method": "upi", "amount": "300.00"}).status_code
        == 201
    )

    done = cashier.get(url).data
    table.refresh_from_db()
    assert (done["status"], done["balance"], table.status) == ("paid", "0.00", "free")
    assert done["closed_at"]
    assert waiter.get(f"/api/tables/{table.id}/").data["active_order"] is None


def test_refire_sends_only_the_difference(api, table, menu):
    waiter = api(Role.WAITER)
    order = open_order(waiter, table, lines=[(menu["tikka"], 1)])
    url = f"/api/orders/{order['id']}/"
    waiter.post(url + "fire/")
    assert waiter.post(url + "fire/").status_code == 400  # nothing new

    lines = [
        {"id": line(order, "Tikka")["id"], "quantity": 3},
        {"menu_item": menu["kebab"].id, "quantity": 1},
        {"menu_item": menu["water"].id, "quantity": 2},
    ]
    order = waiter.patch(url, {"lines": lines}, format="json").data
    assert order["has_unsent"] is True
    order = waiter.post(url + "fire/").data
    # Water has no station but is on the ticket too: every item prints.
    assert tickets(order) == [
        ("new", [("Tikka", 1)]),
        ("modified", [("Tikka", 2), ("Kebab", 1), ("Water", 2)]),
    ]
    assert order["has_unsent"] is False


def test_cancelling_sent_items_needs_a_manager(api, table, menu):
    waiter, manager = api(Role.WAITER), api(Role.MANAGER)
    order = open_order(waiter, table, lines=[(menu["tikka"], 2), (menu["kebab"], 1)])
    url = f"/api/orders/{order['id']}/"
    order = waiter.post(url + "fire/").data
    tikka, kebab = line(order, "Tikka")["id"], line(order, "Kebab")["id"]

    reduce = {"lines": [{"id": tikka, "quantity": 1}]}
    assert waiter.patch(url, reduce, format="json").status_code == 403
    assert manager.patch(url, reduce, format="json").data["total"] == "550.00"
    manager.post(url + "fire/")
    assert tickets(order)[-1] == ("partially_cancelled", [("Tikka", 1)])

    remove_all = {"lines": [{"id": tikka, "quantity": 0}, {"id": kebab, "quantity": 0}]}
    manager.patch(url, remove_all, format="json")
    manager.post(url + "fire/")
    assert tickets(order)[-1] == ("cancelled", [("Tikka", 1), ("Kebab", 1)])


def test_unsent_lines_can_be_removed_by_anyone(api, table, menu):
    waiter = api(Role.WAITER)
    order = open_order(waiter, table, lines=[(menu["tikka"], 2)])
    body = {"lines": [{"id": line(order, "Tikka")["id"], "quantity": 0}]}
    order = waiter.patch(f"/api/orders/{order['id']}/", body, format="json").data
    assert (order["items"], order["total"]) == ([], "0.00")


def test_table_takes_one_order_at_a_time(api, table, menu):
    waiter = api(Role.WAITER)
    open_order(waiter, table, lines=[(menu["tikka"], 1)])
    body = {"table": table.id, "lines": [{"menu_item": menu["soda"].id}]}
    assert waiter.post("/api/orders/", body, format="json").status_code == 400


def test_bill_needs_everything_sent(api, table, menu):
    cashier = api(Role.CASHIER)
    order = open_order(cashier, table, lines=[(menu["tikka"], 1)])
    url = f"/api/orders/{order['id']}/"
    assert cashier.post(url + "bill/").status_code == 400
    cashier.post(url + "fire/")
    assert cashier.post(url + "bill/", {"discount": "999"}).status_code == 400
    assert cashier.post(url + "bill/").status_code == 200
    assert cashier.post(url + "reopen/").data["status"] == "open"


def test_cancel_order(api, table, menu):
    waiter, manager = api(Role.WAITER), api(Role.MANAGER)
    order = open_order(waiter, table, lines=[(menu["tikka"], 2)])
    url = f"/api/orders/{order['id']}/"
    waiter.post(url + "fire/")
    assert waiter.post(url + "cancel/").status_code == 403  # kitchen already has it
    cancelled = manager.post(url + "cancel/").data
    table.refresh_from_db()
    assert (cancelled["status"], cancelled["total"], table.status) == ("cancelled", "0.00", "free")
    assert tickets(order)[-1] == ("cancelled", [("Tikka", 2)])


def test_takeaway_and_unavailable_item(api, menu):
    waiter = api(Role.WAITER)
    body = {"order_type": "takeaway", "lines": [{"menu_item": menu["soda"].id, "quantity": 1}]}
    assert waiter.post("/api/orders/", body, format="json").data["table"] is None
    MenuItem.objects.filter(pk=menu["soda"].pk).update(is_available=False)
    assert waiter.post("/api/orders/", body, format="json").status_code == 400


def test_percent_discount(api, table, menu):
    cashier = api(Role.CASHIER)
    order = open_order(cashier, table, lines=[(menu["tikka"], 1), (menu["water"], 1)])  # 270.00
    url = f"/api/orders/{order['id']}/"
    cashier.post(url + "fire/")
    too_much = {"discount": "101", "discount_type": "percent"}
    assert cashier.post(url + "bill/", too_much).status_code == 400
    billed = cashier.post(url + "bill/", {"discount": "12.5", "discount_type": "percent"}).data
    assert (billed["discount_percent"], billed["discount"], billed["total"]) == (
        "12.50",
        "33.75",
        "236.25",
    )
    reopened = cashier.post(url + "reopen/").data
    assert (reopened["discount_percent"], reopened["discount"]) == (None, "0.00")
    # 100% off leaves nothing to collect, so the order closes straight away.
    free = cashier.post(url + "bill/", {"discount": "100", "discount_type": "percent"}).data
    assert (free["total"], free["status"]) == ("0.00", "paid")


def test_bill_saves_optional_customer_details(api, table, menu):
    cashier = api(Role.CASHIER)
    order = open_order(cashier, table, lines=[(menu["tikka"], 1)])
    url = f"/api/orders/{order['id']}/"
    cashier.post(url + "fire/")

    bad = cashier.post(url + "bill/", {"customer_phone": "12345"})
    assert bad.status_code == 400 and "customer_phone" in bad.data
    billed = cashier.post(
        url + "bill/", {"customer_name": "  Priya   Shah ", "customer_phone": "+91 98200-12345"}
    ).data
    assert (billed["customer_name"], billed["customer_phone"]) == ("Priya Shah", "9820012345")

    # Both are optional, and leaving them out keeps what the order already has.
    cashier.post(url + "reopen/")
    billed = cashier.post(url + "bill/").data
    assert (billed["customer_name"], billed["customer_phone"]) == ("Priya Shah", "9820012345")
    cashier.post(url + "reopen/")
    billed = cashier.post(url + "bill/", {"customer_name": "", "customer_phone": ""}).data
    assert (billed["customer_name"], billed["customer_phone"]) == ("", "")
