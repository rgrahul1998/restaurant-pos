"""Settings → Restaurant: Admin edits the bill header; GSTIN / FSSAI / footer reach the paper."""

import pytest
from rest_framework.test import APIClient

from apps.printing.models import Restaurant
from apps.printing.services import company_data
from apps.printing.ticket import build_bill
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db


def client(role=Role.ADMIN):
    c = APIClient()
    c.force_authenticate(User.objects.create_user(f"u-{role}", password="x" * 10, role=role))
    return c


DETAILS = {
    "name": "Saffron Table",
    "legal_name": "Saffron Hospitality LLP",
    "address_line1": "14, Linking Road",
    "city": "Mumbai",
    "state": "Maharashtra",
    "pincode": "400050",
    "phone": "+91 98200 12345",
    "email": "hello@saffron.example",
    "gstin": "27abcde1234f1z5",
    "fssai": "1152 1012 0001 23",
    "bill_footer": "Thanks for dining with us!",
}


def test_admin_reads_and_saves():
    c = client()
    assert c.get("/api/settings/restaurant/").json()["bill_footer"] == "Thank You. Visit Again."
    res = c.patch("/api/settings/restaurant/", DETAILS, format="json")
    assert res.status_code == 200, res.json()
    saved = Restaurant.load()
    assert saved.gstin == "27ABCDE1234F1Z5"  # spaces dropped, upper-cased
    assert saved.fssai == "11521012000123"
    assert saved.legal_name == "Saffron Hospitality LLP"


@pytest.mark.parametrize(
    "field,value,message",
    [
        ("gstin", "27ABCDE1234F1Z", "not a valid GSTIN"),
        ("fssai", "12345", "14 digits"),
        ("pincode", "4000", "6 digits"),
        ("email", "not-an-email", "valid email"),
        ("name", "", "may not be blank"),
    ],
)
def test_bad_values_refused(field, value, message):
    res = client().patch("/api/settings/restaurant/", {field: value}, format="json")
    assert res.status_code == 400
    assert message in res.json()[field][0]


def test_only_admin():
    for role in (Role.MANAGER, Role.CASHIER, Role.WAITER, Role.KITCHEN):
        assert client(role).get("/api/settings/restaurant/").status_code == 403


def bill_text():
    invoice = {"name": "1", "items": [], "total": 100, "grand_total": 100, "docstatus": 1}
    return build_bill(invoice, company_data()).decode("ascii")


def test_header_and_footer_on_the_bill():
    client().patch("/api/settings/restaurant/", DETAILS, format="json")
    text = bill_text()
    for line in [
        "Saffron Table",
        "Saffron Hospitality LLP",
        "Mumbai 400050, Maharashtra",
        "Phone: +91 98200 12345",
        "GSTIN: 27ABCDE1234F1Z5",
        "FSSAI Lic. No: 11521012000123",
        "Thanks for dining with us!",
    ]:
        assert line in text
    assert "Visit Again" not in text


def test_blank_details_leave_no_empty_lines():
    Restaurant.objects.update_or_create(pk=1, defaults={"name": "Cafe", "bill_footer": ""})
    text = bill_text()
    assert "GSTIN" not in text and "FSSAI" not in text and "Visit Again" not in text
