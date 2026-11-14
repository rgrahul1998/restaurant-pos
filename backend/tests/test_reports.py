"""Sales report: totals, items, money by method, kitchen cancellations and reservations."""

from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from rest_framework.test import APIClient

from apps.floor.models import Room, Table
from apps.kitchen.models import Station
from apps.menu.models import Category, MenuItem
from apps.orders.models import Order
from apps.reservations.models import Reservation, ReservationPayment
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db
IST = ZoneInfo("Asia/Kolkata")
DAY = {"date_from": "2026-11-14", "date_to": "2026-11-14"}


def client_for(role):
    user, _ = User.objects.get_or_create(username=f"u_{role}", defaults={"role": role})
    client = APIClient()
    client.force_authenticate(user)
    return client


def backdate(model, pk, when):
    model.objects.filter(pk=pk).update(created_at=when)


@pytest.fixture
def day():
    """One evening: two paid dine-in orders, a cancelled one, and a reservation."""
    room = Room.objects.create(name="Hall")
    t1, t2, t3 = (Table.objects.create(room=room, name=n) for n in ("T1", "T2", "T3"))
    mains = Category.objects.create(name="Mains", station=Station.objects.create(name="Kitchen"))
    dal = MenuItem.objects.create(category=mains, name="Dal", price="200", has_jain=True)
    naan = MenuItem.objects.create(category=mains, name="Naan", price="50")
    waiter, cashier, manager = (
        client_for(Role.WAITER),
        client_for(Role.CASHIER),
        client_for(Role.MANAGER),
    )

    def order(table, lines, guests):
        body = {"table": table.id, "guests": guests, "lines": lines}
        o = waiter.post("/api/orders/", body, format="json").data
        waiter.post(f"/api/orders/{o['id']}/fire/")
        return o["id"]

    # Order A: 2 Dal (1 Jain) + 2 Naan = 500, 10% off → 450, paid cash 450.
    a = order(t1, [{"menu_item": dal.id}, {"menu_item": dal.id, "is_jain": True},
                   {"menu_item": naan.id, "quantity": 2}], guests=3)  # fmt: skip
    cashier.post(f"/api/orders/{a}/bill/", {"discount": "10", "discount_type": "percent"})
    cashier.post("/api/payments/", {"order": a, "method": "cash", "amount": "450"})
    # Order B: 1 Dal = 200, paid 150 UPI + 50 card.
    b = order(t2, [{"menu_item": dal.id}], guests=2)
    cashier.post(f"/api/orders/{b}/bill/", {})
    cashier.post("/api/payments/", {"order": b, "method": "upi", "amount": "150"})
    cashier.post("/api/payments/", {"order": b, "method": "card", "amount": "50"})
    # Order C: 3 Naan sent to the kitchen, then the whole order cancelled.
    c = order(t3, [{"menu_item": naan.id, "quantity": 3}], guests=1)
    manager.post(f"/api/orders/{c}/cancel/")

    evening = datetime(2026, 11, 14, 20, 15, tzinfo=IST)
    Order.objects.filter(pk__in=[a, b, c]).update(created_at=evening)
    from apps.kitchen.models import KOT

    KOT.objects.update(created_at=evening)
    from apps.orders.models import Payment

    Payment.objects.update(created_at=evening)

    # A booking that night with a 1000 UPI advance, cancelled and forfeited.
    booker = User.objects.get(username=f"u_{Role.CASHIER}")
    r = Reservation.objects.create(
        customer_name="Rao", customer_phone="1", guests=10, start_at=evening,
        end_at=evening + timedelta(hours=2), status="cancelled", advance_outcome="forfeited",
        created_by=booker,
    )  # fmt: skip
    p = ReservationPayment.objects.create(
        reservation=r, method="upi", amount="1000", received_by=booker
    )
    backdate(ReservationPayment, p.pk, evening)


def test_sales_report(day):
    response = client_for(Role.MANAGER).get("/api/reports/sales/", DAY)
    assert response.status_code == 200, response.data
    data = response.data
    s = data["summary"]
    assert (s["orders"], s["gross"], s["discounts"], s["net"]) == (2, 700, 50, 650)
    assert (s["average_bill"], s["guests"], s["per_guest"]) == (325, 5, 130)
    assert (s["discounted_orders"], s["cancelled_orders"]) == (1, 1)

    assert data["by_day"] == [{"date": datetime(2026, 11, 14).date(), "orders": 2, "net": 650}]
    assert data["by_hour"][20] == {"hour": 20, "orders": 2, "net": 650}  # local hour, not UTC

    dal = next(i for i in data["items"] if i["name"] == "Dal")
    assert (dal["quantity"], dal["jain_quantity"], dal["revenue"]) == (3, 1, 600)
    assert [c["revenue"] for c in data["categories"]] == [700]

    methods = {m["method"]: m for m in data["collections"]}
    assert methods["cash"]["net"] == 450
    assert (methods["upi"]["bills"], methods["upi"]["advances"], methods["upi"]["net"]) == (
        150, 1000, 1150,
    )  # fmt: skip
    assert methods["card"]["net"] == 50

    cancelled = data["cancellations"]
    assert (cancelled["orders"], cancelled["kitchen_items"], cancelled["kitchen_value"]) == (
        1, 3, 150,
    )  # fmt: skip

    booked = data["reservations"]
    assert (booked["bookings"], booked["cancelled"], booked["forfeited"]) == (1, 1, 1000)
    assert booked["guests"] == 0  # cancelled parties don't count as expected guests


def test_other_days_are_excluded(day):
    data = (
        client_for(Role.ADMIN)
        .get("/api/reports/sales/", {"date_from": "2026-11-15", "date_to": "2026-11-15"})
        .data
    )
    assert data["summary"]["orders"] == 0
    assert data["collections"] == []
    assert data["summary"]["average_bill"] == Decimal("0")


@pytest.mark.parametrize(
    "role,status",
    [
        (Role.ADMIN, 200),
        (Role.MANAGER, 200),
        (Role.CASHIER, 200),
        (Role.WAITER, 403),
        (Role.KITCHEN, 403),
    ],
)
def test_who_sees_reports(role, status):
    assert client_for(role).get("/api/reports/sales/").status_code == status


def test_bad_range():
    response = client_for(Role.ADMIN).get(
        "/api/reports/sales/", {"date_from": "2026-11-15", "date_to": "2026-11-14"}
    )
    assert response.status_code == 400
