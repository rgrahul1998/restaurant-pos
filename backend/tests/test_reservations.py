from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from rest_framework.test import APIClient

from apps.floor.models import Room, Table
from apps.kitchen.models import Station
from apps.menu.models import Category, MenuItem
from apps.orders.models import Order
from apps.printing.services import bill_data
from apps.printing.ticket import build_bill
from apps.reservations.models import Reservation, ReservationTable
from apps.reservations.services import _write_slots
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db
IST = ZoneInfo("Asia/Kolkata")


@pytest.fixture
def api():
    def client(role):
        user, _ = User.objects.get_or_create(username=f"u_{role}", defaults={"role": role})
        client = APIClient()
        client.force_authenticate(user)
        return client

    return client


@pytest.fixture
def floor():
    hall, terrace = Room.objects.create(name="Hall"), Room.objects.create(name="Terrace")
    return {
        "T1": Table.objects.create(room=hall, name="T1"),
        "T2": Table.objects.create(room=hall, name="T2"),
        "PR": Table.objects.create(room=hall, name="PR", seats=12),
        "X1": Table.objects.create(room=terrace, name="X1"),
    }


def at(hour, minute=0):
    return datetime(2030, 5, 10, hour, minute, tzinfo=IST).isoformat()


def book(client, tables, start, end, **extra):
    body = {
        "customer_name": "Priya",
        "customer_phone": "9800000000",
        "guests": 10,
        "occasion": "birthday",
        "start_at": start,
        "end_at": end,
        "tables": [t.id for t in tables],
        **extra,
    }
    return client.post("/api/reservations/", body, format="json")


def test_booking_with_advance_and_listing_by_window(api, floor):
    cashier = api(Role.CASHIER)
    advance = {"method": "upi", "amount": "2000.00", "reference": "UPI123"}
    response = book(cashier, [floor["PR"]], at(19), at(22), advance=advance)
    assert response.status_code == 201, response.data
    data = response.data
    assert (data["status"], data["advance_paid"], data["table_names"]) == (
        "confirmed",
        "2000.00",
        "PR",
    )
    assert data["payments"][0]["kind"] == "advance"

    listed = cashier.get("/api/reservations/", {"start": at(18), "end": at(20)}).data
    assert [r["id"] for r in listed] == [data["id"]]
    assert cashier.get("/api/reservations/", {"start": at(22), "end": at(23)}).data == []


def test_overlap_is_refused_but_touching_times_are_fine(api, floor):
    cashier = api(Role.CASHIER)
    assert book(cashier, [floor["T1"], floor["T2"]], at(19), at(21)).status_code == 201

    clash = book(cashier, [floor["T2"]], at(20, 30), at(22))
    assert clash.status_code == 400
    assert "T2 is already booked" in str(clash.data["tables"])
    assert book(cashier, [floor["T1"]], at(18), at(19, 30)).status_code == 400  # starts before
    assert book(cashier, [floor["T1"]], at(19, 30), at(20)).status_code == 400  # inside

    assert book(cashier, [floor["T1"]], at(21), at(23)).status_code == 201  # starts at its end
    assert book(cashier, [floor["T2"]], at(17), at(19)).status_code == 201  # ends at its start
    assert book(cashier, [floor["PR"]], at(19), at(21)).status_code == 201  # other table


def test_database_refuses_overlap_even_without_the_check(api, floor):
    first = book(api(Role.CASHIER), [floor["T1"]], at(19), at(21)).data
    second = Reservation.objects.create(
        customer_name="B",
        customer_phone="1",
        start_at=datetime(2030, 5, 10, 20, tzinfo=IST),
        end_at=datetime(2030, 5, 10, 22, tzinfo=IST),
        created_by_id=first["created_by"],
    )
    from rest_framework.exceptions import ValidationError

    with pytest.raises(ValidationError):
        _write_slots(second, [floor["T1"]])
    assert ReservationTable.objects.filter(reservation=second).count() == 0


def test_validation_rules(api, floor):
    cashier = api(Role.CASHIER)
    assert book(cashier, [floor["T1"]], at(21), at(19)).status_code == 400
    assert book(cashier, [], at(19), at(21)).status_code == 400
    mixed = book(cashier, [floor["T1"], floor["X1"]], at(19), at(21))
    assert "same room" in str(mixed.data)


def test_roles(api, floor):
    assert book(api(Role.WAITER), [floor["T1"]], at(19), at(21)).status_code == 403
    assert book(api(Role.KITCHEN), [floor["T1"]], at(19), at(21)).status_code == 403
    assert book(api(Role.MANAGER), [floor["T1"]], at(19), at(21)).status_code == 201
    assert api(Role.WAITER).get("/api/reservations/").status_code == 200
    assert api(Role.KITCHEN).get("/api/reservations/").status_code == 403


def test_editing_moves_the_slots(api, floor):
    cashier = api(Role.CASHIER)
    one = book(cashier, [floor["T1"]], at(19), at(21)).data
    book(cashier, [floor["T2"]], at(19), at(21))
    url = f"/api/reservations/{one['id']}/"
    # Editing its own times never clashes with itself.
    assert cashier.patch(url, {"end_at": at(22)}, format="json").status_code == 200
    assert cashier.patch(url, {"tables": [floor["T2"].id]}, format="json").status_code == 400
    moved = cashier.patch(url, {"tables": [floor["PR"].id]}, format="json")
    assert moved.data["table_names"] == "PR"
    assert book(cashier, [floor["T1"]], at(19), at(21)).status_code == 201  # T1 was freed


def test_cancel_with_refund_frees_the_tables(api, floor):
    cashier = api(Role.CASHIER)
    advance = {"method": "cash", "amount": "1000.00"}
    booking = book(cashier, [floor["PR"]], at(19), at(21), advance=advance).data
    url = f"/api/reservations/{booking['id']}/"
    more = cashier.post(url + "payments/", {"method": "upi", "amount": "500.00"})
    assert more.status_code == 201

    assert cashier.post(url + "cancel/").status_code == 400  # must say refund or forfeit
    too_much = {"outcome": "refund", "method": "cash", "refund_amount": "2000.00"}
    assert cashier.post(url + "cancel/", too_much).status_code == 400
    refund = {"outcome": "refund", "method": "cash", "refund_amount": "1200.00"}
    done = cashier.post(url + "cancel/", refund).data
    assert (done["status"], done["advance_outcome"], done["advance_paid"]) == (
        "cancelled",
        "refunded",
        "300.00",
    )
    assert cashier.post(url + "cancel/", refund).status_code == 400
    assert book(cashier, [floor["PR"]], at(19), at(21)).status_code == 201


def test_no_show_forfeits(api, floor):
    cashier = api(Role.CASHIER)
    booking = book(
        cashier, [floor["T1"]], at(19), at(21), advance={"method": "cash", "amount": "500"}
    ).data
    done = cashier.post(f"/api/reservations/{booking['id']}/no-show/", {"outcome": "forfeit"})
    assert (done.data["status"], done.data["advance_outcome"]) == ("no_show", "forfeited")
    # A booking with no advance cancels without an outcome.
    plain = book(cashier, [floor["T2"]], at(19), at(21)).data
    assert cashier.post(f"/api/reservations/{plain['id']}/cancel/").status_code == 200


def test_seating_opens_a_joined_order_and_takes_off_the_advance(api, floor):
    cashier = api(Role.CASHIER)
    station = Station.objects.create(name="Grill")
    tikka = MenuItem.objects.create(
        category=Category.objects.create(name="Grill", station=station),
        name="Tikka",
        price="250.00",
    )
    booking = book(
        cashier,
        [floor["T2"], floor["T1"]],
        at(19),
        at(21),
        advance={"method": "upi", "amount": "1000.00"},
    ).data
    url = f"/api/reservations/{booking['id']}/"

    seated = cashier.post(url + "seat/").data
    assert seated["status"] == "seated"
    order = cashier.get(f"/api/orders/{seated['order']}/").data
    assert (order["table_name"], order["advance"], order["reservation"]) == (
        "T1 + T2",
        "1000.00",
        booking["id"],
    )
    assert (order["customer_name"], order["guests"]) == ("Priya", 10)
    assert cashier.post(url + "seat/").status_code == 400
    assert cashier.patch(url, {"guests": 4}, format="json").status_code == 400

    order_url = f"/api/orders/{order['id']}/"
    cashier.patch(order_url, {"lines": [{"menu_item": tikka.id, "quantity": 6}]}, format="json")
    cashier.post(order_url + "fire/")
    billed = cashier.post(order_url + "bill/").data
    assert (billed["total"], billed["balance"]) == ("1500.00", "500.00")

    ticket = build_bill(bill_data(Order.objects.get(pk=order["id"])))
    assert b"Advance paid" in ticket and b"Balance due" in ticket and b"Rs.500.00" in ticket

    pay = {"order": order["id"], "method": "cash", "amount": "500.00"}
    assert cashier.post("/api/payments/", pay).status_code == 201
    assert cashier.get(order_url).data["status"] == "paid"


def test_advance_covering_the_whole_bill_closes_it(api, floor):
    cashier = api(Role.CASHIER)
    item = MenuItem.objects.create(
        category=Category.objects.create(name="Shelf"), name="Cake", price="800.00"
    )
    booking = book(
        cashier, [floor["PR"]], at(19), at(21), advance={"method": "cash", "amount": "800"}
    ).data
    order_id = cashier.post(f"/api/reservations/{booking['id']}/seat/").data["order"]
    url = f"/api/orders/{order_id}/"
    cashier.patch(url, {"lines": [{"menu_item": item.id, "quantity": 1}]}, format="json")
    cashier.post(url + "fire/")
    assert cashier.post(url + "bill/").data["status"] == "paid"


def test_seating_needs_free_tables(api, floor):
    cashier = api(Role.CASHIER)
    Order.objects.create(table=floor["T1"], waiter=User.objects.create(username="w"))
    booking = book(cashier, [floor["T1"]], at(19), at(21)).data
    response = cashier.post(f"/api/reservations/{booking['id']}/seat/")
    assert response.status_code == 400 and "T1 is still in use" in str(response.data)


def test_availability(api, floor):
    cashier = api(Role.CASHIER)
    booking = book(cashier, [floor["T1"]], at(19), at(21)).data
    rows = cashier.get("/api/reservations/availability/", {"start": at(20), "end": at(22)}).data
    blocked = {r["name"]: r["booked_by"] and r["booked_by"]["id"] for r in rows}
    assert blocked == {"T1": booking["id"], "T2": None, "PR": None, "X1": None}
    rows = cashier.get(
        "/api/reservations/availability/",
        {"start": at(20), "end": at(22), "exclude": booking["id"]},
    ).data
    assert all(r["booked_by"] is None for r in rows)


def test_later_window_is_free(api, floor):
    cashier = api(Role.CASHIER)
    book(cashier, [floor["T1"]], at(19), at(21))
    later = datetime(2030, 5, 10, 21, tzinfo=IST) + timedelta(minutes=1)
    assert book(cashier, [floor["T1"]], later.isoformat(), at(23)).status_code == 201
