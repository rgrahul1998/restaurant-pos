"""Menu import from Excel / CSV: preview first, all-or-nothing, re-import updates by name."""

import io

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from openpyxl import load_workbook
from rest_framework.test import APIClient

from apps.kitchen.models import Station
from apps.menu import importer
from apps.menu.models import Category, MenuItem
from apps.users.models import Role, User

pytestmark = pytest.mark.django_db

HEADER = (
    "Name*,Category*,Price*,Kitchen station,Course,Veg,Jain option,Special,Available,"
    "Description,Number"
)


def client(role=Role.MANAGER):
    c = APIClient()
    c.force_authenticate(User.objects.create_user(f"u-{role}", password="x" * 10, role=role))
    return c


def csv_file(*rows, name="menu.csv"):
    text = "\n".join([HEADER, *rows]) + "\n"
    return SimpleUploadedFile(name, text.encode("utf-8-sig"), content_type="text/csv")


def post(c, upload, save=False):
    data = {"file": upload, **({"save": "true"} if save else {})}
    return c.post("/api/menu-items/import/", data, format="multipart")


ROWS = [
    "Paneer Tikka,Starters,290,Tandoor,Starters,Yes,Yes,No,Yes,Hung-curd marinade",
    'Butter Chicken,Mains,"₹ 1,410.50",Main Kitchen,Mains,No,,Yes,,',
    "Mineral Water,Packaged,40,,,yes,no,no,yes,",
]


def test_preview_saves_nothing():
    res = post(client(), csv_file(*ROWS))
    assert res.status_code == 200, res.json()
    body = res.json()
    assert (body["saved"], body["created"], body["errors"]) == (False, 3, [])
    assert body["new"]["categories"] == ["Starters", "Mains", "Packaged"]
    assert body["new"]["stations"] == ["Tandoor", "Main Kitchen"]
    assert not MenuItem.objects.exists() and not Category.objects.exists()


def test_import_creates_everything():
    res = post(client(), csv_file(*ROWS), save=True)
    assert res.json()["saved"] is True
    chicken = MenuItem.objects.get(name="Butter Chicken")
    assert str(chicken.price) == "1410.50"
    assert chicken.category.station.name == "Main Kitchen"
    assert chicken.course.name == "Mains"
    assert (chicken.is_vegetarian, chicken.has_jain, chicken.is_special) == (False, False, True)
    assert chicken.is_available  # blank Available means yes for a new dish
    water = MenuItem.objects.get(name="Mineral Water")
    assert water.category.station is None and water.course is None
    assert MenuItem.objects.get(name="Paneer Tikka").has_jain
    assert list(Category.objects.values_list("name", flat=True)) == [
        "Starters",
        "Mains",
        "Packaged",
    ]


def test_reimport_updates_by_name_and_keeps_others():
    c = client()
    post(c, csv_file(*ROWS), save=True)
    extra = MenuItem.objects.create(
        name="Masala Chai", category=Category.objects.get(name="Mains"), price=50
    )
    res = post(c, csv_file("paneer tikka,Starters,310,,,,,,No,", ROWS[2]))
    body = res.json()
    assert (body["created"], body["updated"], body["unchanged"]) == (0, 1, 1)
    assert body["rows"][0]["changes"] == [
        "Name Paneer Tikka → paneer tikka",
        "Price ₹290 → ₹310",
        "Available Yes → No",
    ]
    post(c, csv_file("Paneer Tikka,Starters,310,,,,,,No,"), save=True)
    paneer = MenuItem.objects.get(name="Paneer Tikka")
    assert str(paneer.price) == "310.00" and not paneer.is_available
    assert paneer.has_jain and paneer.description == "Hung-curd marinade"  # blanks kept
    assert MenuItem.objects.filter(pk=extra.pk).exists()  # never deletes


def test_any_error_saves_nothing():
    res = post(
        client(),
        csv_file(ROWS[0], "Dal,,abc,,,maybe,,,,", ROWS[0]),
        save=True,
    )
    assert res.status_code == 400
    messages = {(e["row"], e["message"]) for e in res.json()["errors"]}
    assert (3, "Category is required.") in messages
    assert (3, "Price: “abc” is not a number.") in messages
    assert (3, "Veg: write Yes or No (not “maybe”).") in messages
    assert (4, "“Paneer Tikka” is also on row 2.") in messages
    assert not MenuItem.objects.exists() and not Station.objects.exists()


def test_station_change_is_reported_and_applied():
    station = Station.objects.create(name="Grill")
    Category.objects.create(name="Starters", station=station)
    c = client()
    assert post(c, csv_file(ROWS[0])).json()["notes"] == [
        "Starters tickets go to Tandoor from now on"
    ]
    post(c, csv_file(ROWS[0]), save=True)
    assert Category.objects.get(name="Starters").station.name == "Tandoor"


def test_missing_column_and_bad_file():
    bad = SimpleUploadedFile("m.csv", b"Dish,Cost\nTea,10\n")
    assert "Missing column(s): Category, Price" in post(client(), bad).json()["detail"]
    junk = SimpleUploadedFile("m.xlsx", b"PK not really")
    assert "Could not open this Excel file" in post(client(Role.ADMIN), junk).json()["detail"]


def test_excel_template_round_trip():
    c = client()
    post(c, csv_file(*ROWS), save=True)
    res = c.get("/api/menu-items/template/?current=1")
    assert res["Content-Disposition"] == 'attachment; filename="menu.xlsx"'
    book = load_workbook(io.BytesIO(res.content))
    assert book.sheetnames == ["Menu", "How to fill"]
    assert [cell.value for cell in book["Menu"][1]] == importer.HEADERS
    assert book["Menu"].max_row == 4
    # Importing the exported menu changes nothing.
    upload = SimpleUploadedFile("menu.xlsx", res.content)
    body = post(c, upload).json()
    assert (body["unchanged"], body["errors"]) == (3, [])

    blank = c.get("/api/menu-items/template/")
    assert load_workbook(io.BytesIO(blank.content))["Menu"].max_row == 1
    csv_blank = c.get("/api/menu-items/template/?type=csv")
    assert csv_blank.content.decode("utf-8-sig").strip() == HEADER


def test_only_admin_and_manager():
    for role in (Role.CASHIER, Role.WAITER, Role.KITCHEN):
        c = client(role)
        assert c.get("/api/menu-items/template/").status_code == 403
        assert post(c, csv_file(ROWS[0])).status_code == 403
    assert client(Role.ADMIN).get("/api/menu-items/template/").status_code == 200


def test_item_numbers():
    c = client()
    post(c, csv_file(*ROWS), save=True)
    # Blank numbers are given in turn.
    assert sorted(MenuItem.objects.values_list("code", flat=True)) == [1, 2, 3]

    # The file can set them; a number the file gives isn't handed out to a blank row first.
    body = post(
        c,
        csv_file(
            "Dal Khichdi,Mains,180,,,Yes,,,,,",
            "Paneer Tikka,Starters,290,,,,,,,,4",
        ),
        save=True,
    ).json()
    assert body["errors"] == []
    assert MenuItem.objects.get(name="Paneer Tikka").code == 4
    assert MenuItem.objects.get(name="Dal Khichdi").code == 5
    assert "Number 1 → 4" in next(r for r in body["rows"] if r["name"] == "Paneer Tikka")["changes"]

    taken = MenuItem.objects.get(name="Dal Khichdi")
    bad = post(
        c,
        csv_file(
            "Masala Chai,Drinks,40,,,,,,,,5",
            "Lassi,Drinks,60,,,,,,,,x",
            "Kulfi,Desserts,90,,,,,,,,9",
            "Kheer,Desserts,90,,,,,,,,9",
        ),
    ).json()
    messages = [e["message"] for e in bad["errors"]]
    assert f"Number 5 is already {taken.name}." in messages
    assert any("“x” is not a whole number" in m for m in messages)
    assert "Number 9 is also on row 4." in messages


def test_number_from_the_menu_screen():
    c = client()
    category = Category.objects.create(name="Mains")
    made = c.post(
        "/api/menu-items/", {"name": "Dal", "category": category.id, "price": "100"}
    ).json()
    assert made["code"] == 1
    other = c.post(
        "/api/menu-items/", {"name": "Rice", "category": category.id, "price": "90", "code": 7}
    ).json()
    assert other["code"] == 7
    res = c.patch(f"/api/menu-items/{made['id']}/", {"code": 7}, format="json")
    assert res.status_code == 400
    assert res.json()["code"] == ["Number 7 is already Rice."]
    assert c.patch(f"/api/menu-items/{made['id']}/", {"code": 3}, format="json").json()["code"] == 3
