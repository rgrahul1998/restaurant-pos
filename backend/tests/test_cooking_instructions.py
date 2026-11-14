"""Settings → Cooking instructions: Admin keeps the one-tap list the order screen shows."""

import pytest
from rest_framework.test import APIClient

from apps.kitchen.models import KitchenSettings
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db
URL = "/api/settings/cooking-instructions/"


def client(role=Role.ADMIN):
    c = APIClient()
    c.force_authenticate(User.objects.create_user(f"u-{role}", password="x" * 10, role=role))
    return c


def test_defaults_then_admin_saves_cleaned_list():
    c = client()
    assert "Less oil" in c.get(URL).json()["instructions"]
    res = c.put(URL, {"instructions": ["  No  ice ", "", "Jain style", "no ice"]}, format="json")
    assert res.status_code == 200, res.json()
    assert res.json()["instructions"] == ["No ice", "Jain style"]
    assert KitchenSettings.load().cooking_instructions == ["No ice", "Jain style"]


def test_empty_list_allowed():
    res = client().put(URL, {"instructions": []}, format="json")
    assert res.status_code == 200
    assert res.json()["instructions"] == []


def test_commas_refused():
    res = client().put(URL, {"instructions": ["Soft, crispy"]}, format="json")
    assert res.status_code == 400


@pytest.mark.parametrize("role", [Role.WAITER, Role.KITCHEN, Role.MANAGER, Role.CASHIER])
def test_staff_read_but_cannot_change(role):
    c = client(role)
    assert c.get(URL).status_code == 200
    assert c.put(URL, {"instructions": ["x"]}, format="json").status_code == 403
