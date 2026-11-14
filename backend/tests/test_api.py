import pytest
from channels.testing import WebsocketCommunicator
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.floor.models import Room, Table
from apps.kitchen.models import KOT, Station
from apps.menu.models import Category, MenuItem
from apps.users.models import Role, User
from config.asgi import application

pytestmark = pytest.mark.django_db

# The websocket stack only accepts browser origins listed in ALLOWED_HOSTS.
ORIGIN = [(b"origin", b"http://localhost")]


@pytest.fixture
def users():
    return {role: User.objects.create_user(f"u_{role}", password="x", role=role) for role in Role}


def client_for(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def table():
    return Table.objects.create(room=Room.objects.create(name="Hall"), name="T1")


@pytest.fixture
def dish():
    station = Station.objects.create(name="Grill")
    category = Category.objects.create(name="Mains", station=station)
    return MenuItem.objects.create(category=category, name="Paneer Tikka", price="250.00")


def test_login_and_me(users):
    client = APIClient()
    tokens = client.post("/api/auth/token/", {"username": "u_waiter", "password": "x"}).data
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
    assert client.get("/api/auth/me/").data["role"] == "waiter"


def test_anonymous_is_rejected():
    assert APIClient().get("/api/menu-items/").status_code == 401


@pytest.mark.parametrize(
    ("role", "status"),
    [("admin", 201), ("manager", 201), ("cashier", 403), ("waiter", 403), ("kitchen", 403)],
)
def test_only_management_edits_menu(users, role, status):
    client = client_for(users[role])
    assert client.get("/api/courses/").status_code == 200
    assert client.post("/api/courses/", {"name": "Starters"}).status_code == status


@pytest.mark.parametrize("role", ["manager", "cashier", "waiter", "kitchen"])
def test_only_admin_manages_staff(users, role):
    body = {"username": "new_waiter", "role": "waiter", "password": "longenough1"}
    client = client_for(users[role])
    assert client.get("/api/users/").status_code == 403
    assert client.post("/api/users/", body).status_code == 403
    assert client.patch(f"/api/users/{users['waiter'].id}/", {"phone": "1"}).status_code == 403


def test_admin_creates_staff_and_admins(users):
    client = client_for(users["admin"])
    for name, role in [("boss", "admin"), ("asha", "manager")]:
        body = {"username": name, "role": role, "password": "longenough1"}
        assert client.post("/api/users/", body).status_code == 201


def test_waiter_creates_order_with_price_snapshot(users, table, dish):
    body = {"table": table.id, "lines": [{"menu_item": dish.id, "quantity": 2}]}
    response = client_for(users["waiter"]).post("/api/orders/", body, format="json")
    assert response.status_code == 201, response.data
    assert response.data["total"] == "500.00"
    assert response.data["waiter"] == users["waiter"].id
    assert response.data["items"][0]["name"] == "Paneer Tikka"


def test_dine_in_needs_table(users, dish):
    body = {"lines": [{"menu_item": dish.id, "quantity": 1}]}
    assert client_for(users["waiter"]).post("/api/orders/", body, format="json").status_code == 400


def test_kitchen_cannot_see_orders_or_payments(users):
    client = client_for(users["kitchen"])
    assert client.get("/api/orders/").status_code == 403
    assert client.get("/api/payments/").status_code == 403
    assert client_for(users["waiter"]).get("/api/payments/").status_code == 403


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_kitchen_socket_receives_kot(users, table, dish):
    from asgiref.sync import sync_to_async

    token = AccessToken.for_user(users[Role.KITCHEN])
    socket = WebsocketCommunicator(application, f"/ws/kitchen/?token={token}", headers=ORIGIN)
    connected, _ = await socket.connect()
    assert connected

    @sync_to_async
    def fire():
        from apps.orders.models import Order

        order = Order.objects.create(table=table, waiter=users[Role.WAITER])
        return KOT.objects.create(
            order=order, station=dish.category.station, created_by=users[Role.WAITER]
        )

    kot = await fire()
    message = await socket.receive_json_from(timeout=3)
    assert message["event"] == "kot.created"
    assert message["payload"]["id"] == kot.id
    assert message["payload"]["table"] == "T1"
    await socket.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_printer_socket_is_pinged_for_new_kots(users, table, dish):
    """The Printer page prints the moment it's pinged, not on its next check."""
    from asgiref.sync import sync_to_async

    token = AccessToken.for_user(users[Role.CASHIER])
    socket = WebsocketCommunicator(application, f"/ws/printer/?token={token}", headers=ORIGIN)
    connected, _ = await socket.connect()
    assert connected

    @sync_to_async
    def fire():
        from apps.orders.models import Order

        order = Order.objects.create(table=table, waiter=users[Role.WAITER])
        KOT.objects.create(order=order, created_by=users[Role.WAITER])

    await fire()
    assert (await socket.receive_json_from(timeout=3))["event"] == "print.ready"
    await socket.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_socket_rejects_missing_token():
    socket = WebsocketCommunicator(application, "/ws/kitchen/", headers=ORIGIN)
    connected, code = await socket.connect()
    assert not connected and code == 4401
