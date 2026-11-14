import base64
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.floor.models import Room, Table
from apps.kitchen.models import KOT, Station
from apps.menu.models import Category, MenuItem
from apps.printing.models import PrintSettings, Restaurant
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
        b"KOT", b"Name: Avijit", b"Tel#: 2222222222", f"No: #{order['id']}".encode(),
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


def test_cancellations_are_not_printed_and_reprint(api, order):
    waiter, manager = api(Role.WAITER), api(Role.MANAGER)
    url = f"/api/orders/{order['id']}/"
    waiter.post(url + "fire/")
    line = order["items"][0]["id"]
    manager.patch(url, {"lines": [{"id": line, "quantity": 3}]}, format="json")
    manager.post(url + "fire/")

    # The reduction is on the kitchen screen, but only the original ticket prints.
    assert KOT.objects.filter(order=order["id"], type="partially_cancelled").exists()
    (first,) = pending(waiter)

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


def test_test_ticket_and_unsigned_qz(api, settings):
    settings.QZ_CERTIFICATE_FILE = settings.QZ_PRIVATE_KEY_FILE = ""
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


def test_bill_merges_rows_split_only_by_cooking_instruction(api, order):
    from apps.orders.models import Order
    from apps.printing.services import bill_data

    waiter = api(Role.WAITER)
    phulka = order["items"][0]["menu_item"]
    MenuItem.objects.filter(pk=phulka).update(has_jain=True)
    lines = [
        {"menu_item": phulka, "quantity": 2, "note": "crispy"},
        {"menu_item": phulka, "quantity": 1},
        {"menu_item": phulka, "quantity": 1, "is_jain": True, "note": "soft"},
        {"menu_item": phulka, "quantity": 1, "is_jain": True},
    ]
    response = waiter.patch(f"/api/orders/{order['id']}/", {"lines": lines}, format="json")
    assert response.status_code == 200, response.data
    assert len(response.data["items"]) == 5  # still separate rows on screen and KOT

    items = bill_data(Order.objects.get(pk=order["id"]))["items"]
    assert [(i["item_name"], i["qty"], i["amount"]) for i in items] == [
        ("Phulka", 8, 400),
        ("Phulka (J)", 2, 100),
    ]


def test_tablet_prints_its_own_tickets(api, order):
    """The Android app prints straight to the network printer; the Printer page stays out."""
    waiter, cashier, admin = api(Role.WAITER), api(Role.CASHIER), api(Role.ADMIN)
    url = f"/api/orders/{order['id']}/"

    # No network printer yet: nothing for the tablet, the Printer page prints as before.
    first = waiter.post(url + "fire/", {"print_here": True}, format="json").data
    assert "print" not in first
    assert len(pending(cashier)) == 1
    KOT.objects.update(print_claimed_at=None)
    for kot in KOT.objects.all():  # as if the Printer page printed it
        cashier.post("/api/printing/printed/", {"kind": "kot", "id": kot.id})

    settings = {"kot_printer_host": "192.168.10.12", "bill_printer_host": "", "width": 32}
    assert waiter.patch("/api/settings/printing/", settings).status_code == 403  # admin only
    assert (
        admin.patch("/api/settings/printing/", {"kot_printer_host": "http://x"}).status_code == 400
    )
    assert admin.patch("/api/settings/printing/", settings).data["port"] == 9100

    line = order["items"][0]["id"]
    waiter.patch(url, {"lines": [{"id": line, "quantity": 7}]}, format="json")
    (ticket,) = waiter.post(url + "fire/", {"print_here": True}, format="json").data["print"]
    assert (ticket["kind"], ticket["host"], ticket["port"]) == ("kot", "192.168.10.12", 9100)
    assert b"ORDER MODIFIED" in base64.b64decode(ticket["ticket"])
    assert pending(cashier) == []  # claimed by the tablet

    # The tablet couldn't print it: once the claim runs out, the Printer page does.
    KOT.objects.filter(pk=ticket["id"]).update(
        print_claimed_at=timezone.now() - timedelta(seconds=31)
    )
    assert [t["id"] for t in pending(cashier)] == [ticket["id"]]

    # A bill prints from the tablet without the Printer page being open, to the bill printer.
    admin.patch("/api/settings/printing/", {"bill_printer_host": "192.168.10.13"})
    cashier.post(url + "bill/")
    cache.delete("printing:page-alive")  # the pending() calls above count as the page
    assert cashier.post(url + "print-bill/").status_code == 400  # Printer page isn't open
    (bill,) = cashier.post(url + "print-bill/", {"print_here": True}, format="json").data["print"]
    assert (bill["kind"], bill["host"]) == ("bill", "192.168.10.13")
    assert [t["kind"] for t in pending(cashier)] == ["kot"]  # the bill is the tablet's
    printed = {"kind": "bill", "id": bill["id"], "printer": "192.168.10.13"}
    assert cashier.post("/api/printing/printed/", printed).status_code == 204
    assert PrintSettings.load().width == 32
