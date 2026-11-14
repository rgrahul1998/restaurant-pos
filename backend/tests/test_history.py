"""Order history: filters by local date, status, table and search, plus the summary."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from rest_framework.test import APIClient

from apps.floor.models import Room, Table
from apps.orders.models import Order
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db
IST = ZoneInfo("Asia/Kolkata")


def client_for(role):
    user, _ = User.objects.get_or_create(username=f"u_{role}", defaults={"role": role})
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def orders():
    waiter = User.objects.create_user("w", role=Role.WAITER)
    room = Room.objects.create(name="Hall")
    t1, t2 = (Table.objects.create(room=room, name=n) for n in ("T1", "T2"))

    def make(when, status, **fields):
        order = Order.objects.create(waiter=waiter, status=status, **fields)
        Order.objects.filter(pk=order.pk).update(created_at=when)  # auto_now_add ignores kwargs
        return order

    # 12:30 am on the 15th in Kolkata is still the 14th in UTC: dates must follow local time.
    late = datetime(2026, 11, 15, 0, 30, tzinfo=IST)
    return {
        "paid": make(late, "paid", table=t1, customer_name="Avijit Rao",
                     customer_phone="98450 11111", total="500", discount="50"),
        "cancelled": make(late + timedelta(hours=12), "cancelled", table=t2, total="300"),
        "takeaway": make(late - timedelta(days=1), "paid", order_type="takeaway", total="120"),
        "open": make(late + timedelta(hours=13), "open", table=t2),
        "t1": t1,
    }  # fmt: skip


def ids(response):
    assert response.status_code == 200, response.data
    return sorted(o["id"] for o in response.data["results"])


def test_filters(orders):
    c = client_for(Role.CASHIER)
    day = {"date_from": "2026-11-15", "date_to": "2026-11-15"}
    o = orders
    on_the_15th = sorted([o["paid"].id, o["cancelled"].id, o["open"].id])
    assert ids(c.get("/api/orders/", day)) == on_the_15th
    assert ids(c.get("/api/orders/", {**day, "status": "cancelled"})) == [o["cancelled"].id]
    assert ids(c.get("/api/orders/", {"status__in": "open,billed"})) == [o["open"].id]
    assert ids(c.get("/api/orders/", {"table": o["t1"].id})) == [o["paid"].id]
    assert ids(c.get("/api/orders/", {"order_type": "takeaway"})) == [o["takeaway"].id]
    for q in ("avijit", "11111", f"#{o['cancelled'].id}"):
        expected = [o["cancelled"].id] if q.startswith("#") else [o["paid"].id]
        assert ids(c.get("/api/orders/", {"q": q})) == expected


def test_summary(orders):
    body = {"date_from": "2026-11-15", "date_to": "2026-11-15"}
    data = client_for(Role.CASHIER).get("/api/orders/summary/", body).data
    assert data == {
        "orders": 3, "paid": 1, "cancelled": 1, "active": 1, "sales": 500, "discounts": 50,
    }  # fmt: skip


def test_summary_is_for_billing_roles(orders):
    assert client_for(Role.WAITER).get("/api/orders/summary/").status_code == 403
    assert client_for(Role.KITCHEN).get("/api/orders/").status_code == 403
