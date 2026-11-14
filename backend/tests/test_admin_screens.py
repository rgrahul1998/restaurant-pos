"""Menu and Staff screens: deleting things in use, photos, and staff lockout guards."""

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.floor.models import Room, Table
from apps.kitchen.models import KOT, Station
from apps.menu.models import Category, MenuItem
from apps.orders.models import Order, OrderItem
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db


@pytest.fixture
def users():
    return {role: User.objects.create_user(f"u_{role}", password="x", role=role) for role in Role}


@pytest.fixture
def table():
    return Table.objects.create(room=Room.objects.create(name="Hall"), name="T1")


@pytest.fixture
def dish():
    category = Category.objects.create(name="Mains", station=Station.objects.create(name="Grill"))
    return MenuItem.objects.create(category=category, name="Paneer Tikka", price="250.00")


def client_for(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


# Smallest valid GIF, so Pillow accepts it as an image.
GIF = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00"
    b",\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
)


def test_deleting_an_ordered_item_is_a_readable_conflict(users, table, dish):
    order = Order.objects.create(table=table, waiter=users["waiter"])
    OrderItem.objects.create(order=order, menu_item=dish, name=dish.name, unit_price=dish.price)
    response = client_for(users["manager"]).delete(f"/api/menu-items/{dish.id}/")
    assert response.status_code == 409
    assert "Deactivate it instead" in response.data["detail"]
    assert MenuItem.objects.filter(id=dish.id).exists()


def test_unused_item_and_category_delete(users, dish):
    client = client_for(users["manager"])
    category = dish.category
    assert client.delete(f"/api/categories/{category.id}/").status_code == 409  # still has the item
    assert client.delete(f"/api/menu-items/{dish.id}/").status_code == 204
    assert client.delete(f"/api/categories/{category.id}/").status_code == 204


def test_station_with_tickets_cannot_be_deleted(users, table, dish):
    order = Order.objects.create(table=table, waiter=users["waiter"])
    station = dish.category.station
    KOT.objects.create(order=order, station=station, created_by=users["waiter"])
    assert client_for(users["admin"]).delete(f"/api/stations/{station.id}/").status_code == 409


def test_item_photo_upload_and_removal(users, dish, settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    client = client_for(users["manager"])
    photo = SimpleUploadedFile("dish.gif", GIF, content_type="image/gif")
    response = client.patch(
        f"/api/menu-items/{dish.id}/", {"image": photo, "price": "260"}, format="multipart"
    )
    assert response.status_code == 200, response.data
    assert response.data["image"].endswith(".gif")

    response = client.patch(f"/api/menu-items/{dish.id}/", {"image": None}, format="json")
    assert response.status_code == 200, response.data
    assert response.data["image"] is None
    dish.refresh_from_db()
    assert not dish.image


def test_nobody_can_lock_themselves_out(users):
    admin = users["admin"]
    client = client_for(admin)
    url = f"/api/users/{admin.id}/"
    assert client.patch(url, {"is_active": False}, format="json").status_code == 400
    assert client.patch(url, {"role": "manager"}, format="json").status_code == 400
    assert client.delete(url).status_code == 400
    # Their own name and password are fine.
    body = {"first_name": "Asha", "password": "new-pass-123"}
    assert client.patch(url, body, format="json").status_code == 200


def test_admin_deactivates_staff(users):
    url = f"/api/users/{users['manager'].id}/"
    response = client_for(users["admin"]).patch(url, {"is_active": False}, format="json")
    assert response.status_code == 200
    users["manager"].refresh_from_db()
    assert not users["manager"].is_active


def test_deactivated_user_is_rejected(users):
    waiter = users["waiter"]
    token = str(AccessToken.for_user(waiter))
    waiter.is_active = False
    waiter.save()
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    assert client.get("/api/auth/me/").status_code == 401
