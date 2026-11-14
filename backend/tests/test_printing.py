import base64
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.floor.models import Room, Table
from apps.kitchen.models import KOT, Station
from apps.menu.models import Category, MenuItem
from apps.printing.models import Restaurant
from apps.printing.ticket import CUT
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def page_not_running():
    cache.delete("printing:page-alive")


@pytest.fixture
def api():
    def client(role):
        user, _ = User.objects.get_or_create(
            username=f"u_{role}", defaults={"role": role, "first_name": role.title()}
        )
        client = APIClient()
        client.force_authenticate(user)
        return client

    return client


@pytest.fixture
def order(api):
    table = Table.objects.create(room=Room.objects.create(name="Hall"), name="T11")
    grill = Category.objects.create(name="Grill", station=Station.objects.create(name="Kitchen"))
    phulka = MenuItem.objects.create(category=grill, name="Phulka", price="50.00")
    body = {
        "table": table.id,
        "customer_name": "Avijit",
        "customer_phone": "2222222222",
        "lines": [{"menu_item": phulka.id, "quantity": 5, "note": "less oil"}],
    }
    return api(Role.WAITER).post("/api/orders/", body, format="json").data


def pending(client, since=None):
    since = since or (timezone.now() - timedelta(minutes=5)).isoformat()
    response = client.get("/api/printing/pending/", {"since": since})
    assert response.status_code == 200, response.data
    return [{**t, "ticket": base64.b64decode(t["ticket"])} for t in response.data["tickets"]]


def test_kot_prints_once_in_the_shared_format(api, order):
    waiter, kitchen = api(Role.WAITER), api(Role.KITCHEN)
    waiter.post(f"/api/orders/{order['id']}/fire/")

    (ticket,) = pending(kitchen)
    assert (ticket["kind"], ticket["label"]) == ("kot", f"KOT-{ticket['id']} - T11 - New Order")
    paper = ticket["ticket"]
    expected = (
        b"KOT", b"Kitchen", b"Name: Avijit", b"Tel#: 2222222222", f"No: #{order['id']}".encode(),
        b"Dine In", b"Table No: T11", b"ITEM", b"QTY", b"Phulka", b"X 5", b"* less oil",
        b"By: Waiter", f"KOT-{ticket['id']}".encode(),
    )  # fmt: skip
    for text in expected:
        assert text in paper, text
    assert paper.endswith(CUT)

    # Still pending until the page confirms it reached the printer.
    assert len(pending(kitchen)) == 1
    done = {"kind": "kot", "id": ticket["id"], "printer": "RETSOL"}
    assert kitchen.post("/api/printing/printed/", done).status_code == 204
    assert kitchen.post("/api/printing/printed/", done).status_code == 204  # safe to repeat
    assert pending(kitchen) == []


def test_first_run_page_prints_nothing_old(api, order):
    api(Role.WAITER).post(f"/api/orders/{order['id']}/fire/")
    response = api(Role.KITCHEN).get("/api/printing/pending/")
    assert response.data["tickets"] == []
    assert pending(api(Role.KITCHEN), since=response.data["now"].isoformat()) == []


def test_cancellation_and_reprint_tickets(api, order):
    waiter, manager = api(Role.WAITER), api(Role.MANAGER)
    url = f"/api/orders/{order['id']}/"
    waiter.post(url + "fire/")
    line = order["items"][0]["id"]
    manager.patch(url, {"lines": [{"id": line, "quantity": 3}]}, format="json")
    manager.post(url + "fire/")

    first, cancel = pending(waiter)
    assert b"PARTLY CANCELLED" in cancel["ticket"]
    assert b"5 > 3" in cancel["ticket"]

    assert waiter.post(f"/api/kots/{first['id']}/reprint/").status_code == 204
    reprint = pending(waiter)[-1]
    assert b"REPRINT" in reprint["ticket"] and b"X 5" in reprint["ticket"]
    # A reprint is paper only; the kitchen screen must not get a second ticket to cook.
    assert KOT.objects.get(pk=reprint["id"]).status == "served"


def test_bill_needs_the_printer_page_and_prints_once(api, order):
    waiter, cashier = api(Role.WAITER), api(Role.CASHIER)
    url = f"/api/orders/{order['id']}/"
    waiter.post(url + "fire/")
    assert cashier.post(url + "print-bill/").status_code == 400  # not billed yet
    cashier.post(url + "bill/", {"discount": "10", "discount_type": "percent"})

    refused = cashier.post(url + "print-bill/")
    assert refused.status_code == 400 and "Printer page" in str(refused.data)

    Restaurant.objects.update_or_create(
        pk=1, defaults={"name": "Invento Cafe", "address_line1": "1 MG Road", "phone": "98765"}
    )
    pending(cashier)  # the page checks in
    assert cashier.post(url + "print-bill/").status_code == 204
    assert cashier.post(url + "print-bill/").status_code == 204  # double tap: still one bill

    bills = [t for t in pending(cashier) if t["kind"] == "bill"]
    assert len(bills) == 1
    paper = bills[0]["ticket"]
    expected = (
        b"Invento Cafe", b"1 MG Road", b"Phone: 98765", b"Name: Avijit", b"Table No: T11",
        b"PRICE", b"Phulka", b"X 5", b"Rs.250.00", b"Item Sub Total", b"Discount", b"-Rs.25.00",
        b"Total", b"Rs.225.00", b"Thank You. Visit Again.", b"THIS IS COMPUTER GENERATED INVOICE",
    )  # fmt: skip
    for text in expected:
        assert text in paper, text
    assert b"M.O.P" not in paper and b"Paid" not in paper and b"GSTIN" not in paper

    cashier.post("/api/printing/printed/", {"kind": "bill", "id": bills[0]["id"]})
    assert [t for t in pending(cashier) if t["kind"] == "bill"] == []

    # Once paid, a reprint shows how it was paid.
    cashier.post("/api/payments/", {"order": order["id"], "method": "upi", "amount": "225"})
    cashier.post(url + "print-bill/")
    paid = [t for t in pending(cashier) if t["kind"] == "bill"][0]["ticket"]
    assert b"M.O.P: UPI\n" in paid and b"Paid" in paid


def test_test_ticket_and_unsigned_qz(api):
    client = api(Role.KITCHEN)
    response = client.get("/api/printing/test-ticket/", {"printer": "RETSOL", "width": 32})
    assert b"RETSOL" in base64.b64decode(response.data["ticket"])
    assert (
        client.get("/api/printing/test-ticket/", {"printer": "X", "width": 40}).status_code == 400
    )
    # No certificate configured: QZ Tray falls back to asking the user.
    assert client.get("/api/printing/qz/certificate/").data == {"certificate": ""}
    assert client.post("/api/printing/qz/sign/", {"message": "abc"}).data == {"signature": ""}
    assert APIClient().get("/api/printing/pending/").status_code == 401
