"""Load a menu from a spreadsheet (Excel or CSV), and write the template / current menu out.

One row per dish. Items are matched to existing ones by name (ignoring case), so the same file
can be imported again after editing prices: matching rows update, new names are added, and dishes
missing from the file are left alone. Categories, kitchen stations and courses named in the file
are created when they don't exist yet.

Import is all-or-nothing: `preview()` checks every row and reports what would change; `apply()`
does the same and saves, but only if no row has an error.
"""

import csv
import io
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

from django.db import transaction
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation

from apps.kitchen.models import Station

from .models import Category, Course, MenuItem

# (header, attribute, help) in template order. Required columns are marked * in the file.
COLUMNS = [
    ("Name", "name", "Dish name as it should print on the KOT and bill. Must be unique."),
    ("Category", "category", "e.g. Starters, Mains, Beverages. Created if new."),
    ("Price", "price", "Selling price, numbers only (e.g. 260 or 260.50)."),
    (
        "Kitchen station",
        "station",
        "Where the category's KOTs go (e.g. Tandoor, Bar). Leave blank for no KOT "
        "(packaged drinks). Applies to the whole category.",
    ),
    ("Course", "course", "Starters, Mains, Desserts… Optional."),
    ("Veg", "is_vegetarian", "Yes or No. Shows the veg / non-veg mark."),
    (
        "Jain option",
        "has_jain",
        "Yes if the dish can be made Jain; waiters then pick Regular or Jain.",
    ),
    ("Special", "is_special", "Yes to mark as today's special."),
    (
        "Available",
        "is_available",
        "No hides it from the order screen. Blank means Yes for new dishes.",
    ),
    ("Description", "description", "Optional short description."),
    (
        "Number",
        "code",
        "Short number waiters type to find the dish. Blank keeps it, or gives the next free one.",
    ),
]
REQUIRED = {"name", "category", "price"}
FLAGS = {"is_vegetarian", "has_jain", "is_special", "is_available"}
HEADERS = [f"{h}*" if attr in REQUIRED else h for h, attr, _ in COLUMNS]
EXAMPLES = [
    ["Paneer Tikka", "Starters", 290, "Tandoor", "Starters", "Yes", "Yes", "No", "Yes", "Tikka", 1],
    ["Butter Chicken", "Mains", 410, "Main Kitchen", "Mains", "No", "No", "Yes", "Yes", "", 2],
    ["Mineral Water", "Packaged", 40, "", "", "Yes", "No", "No", "Yes", "", ""],
]  # fmt: skip
YES = {"yes", "y", "true", "1", "veg", "✓"}
NO = {"no", "n", "false", "0", "non-veg", "nonveg", ""}
MAX_ROWS = 2000


class ImportError_(Exception):  # noqa: N801 - "ImportError" is a builtin
    pass


# ---------- reading ----------


def _key(header) -> str | None:
    text = re.sub(r"[^a-z]", "", str(header or "").lower())
    for h, attr, _ in COLUMNS:
        if text == re.sub(r"[^a-z]", "", h.lower()):
            return attr
    aliases = {"item": "name", "dish": "name", "itemname": "name", "rate": "price", "mrp": "price",
               "station": "station", "vegetarian": "is_vegetarian", "jain": "has_jain",
               "no": "code", "code": "code", "itemno": "code", "itemcode": "code"}  # fmt: skip
    return aliases.get(text)


def read_rows(upload) -> list[tuple[int, dict]]:
    """[(spreadsheet row number, {attribute: text})] from an .xlsx or .csv upload."""
    name = (getattr(upload, "name", "") or "").lower()
    data = upload.read()
    if name.endswith(".xlsx") or data[:2] == b"PK":
        try:
            book = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception as exc:
            raise ImportError_(
                "Could not open this Excel file. Save it as .xlsx and try again."
            ) from exc
        sheet = book["Menu"] if "Menu" in book.sheetnames else book.worksheets[0]
        table = [list(r) for r in sheet.iter_rows(values_only=True)]
    elif name.endswith(".csv") or not name:
        for encoding in ("utf-8-sig", "cp1252"):
            try:
                text = data.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        table = list(csv.reader(io.StringIO(text)))
    else:
        raise ImportError_("Upload the template as .xlsx (Excel) or .csv.")

    if not table:
        raise ImportError_("The file is empty.")
    keys = [_key(h) for h in table[0]]
    missing = REQUIRED - set(keys)
    if missing:
        names = ", ".join(h for h, attr, _ in COLUMNS if attr in missing)
        raise ImportError_(f"Missing column(s): {names}. Start from the template.")

    rows = []
    for number, values in enumerate(table[1:], start=2):
        row = {}
        for key, value in zip(keys, values, strict=False):
            if key:
                row[key] = "" if value is None else str(value).strip()
        if any(row.values()):
            rows.append((number, row))
    if not rows:
        raise ImportError_("No dishes found under the header row.")
    if len(rows) > MAX_ROWS:
        raise ImportError_(f"At most {MAX_ROWS} dishes per file.")
    return rows


# ---------- checking and applying ----------


@dataclass
class Result:
    rows: list[dict] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    new: dict[str, list[str]] = field(
        default_factory=lambda: {"categories": [], "stations": [], "courses": []}
    )
    notes: list[str] = field(default_factory=list)

    def as_dict(self, saved: bool) -> dict:
        count = lambda action: sum(r["action"] == action for r in self.rows)  # noqa: E731
        return {
            "saved": saved,
            "created": count("create"),
            "updated": count("update"),
            "unchanged": count("unchanged"),
            "new": self.new,
            "notes": self.notes,
            "rows": self.rows,
            "errors": self.errors,
        }


def _flag(value: str, row: int, label: str, errors: list) -> bool | None:
    text = value.strip().lower()
    if text in YES:
        return True
    if text in NO:
        return None if text == "" else False
    errors.append({"row": row, "message": f"{label}: write Yes or No (not “{value}”)."})
    return None


def _price(value: str, row: int, errors: list) -> Decimal | None:
    text = re.sub(r"[₹,\s]|rs\.?", "", value, flags=re.I)
    try:
        price = Decimal(text)
    except InvalidOperation:
        errors.append({"row": row, "message": f"Price: “{value}” is not a number."})
        return None
    if price < 0 or price.as_tuple().exponent < -2 or price >= Decimal("1e8"):
        errors.append({"row": row, "message": f"Price: “{value}” is not a valid price."})
        return None
    return price.quantize(Decimal("0.01"))


def _lookup(model, name: str, cache: dict, created: list[str], **create):
    """Existing row with this name (any case), or a new one, saved later in `apply`."""
    key = name.lower()
    if key not in cache:
        found = model.objects.filter(name__iexact=name).first()
        if found is None:
            found = model(name=name, **create)
            created.append(name)
        cache[key] = found
    return cache[key]


def _code(value: str, row: int, errors: list) -> int | None:
    text = value.strip().removesuffix(".0")  # Excel hands whole numbers back as "12.0"
    if not text:
        return None
    if not text.isdigit() or int(text) == 0 or int(text) > 2_147_483_647:
        errors.append({"row": row, "message": f"Number: “{value}” is not a whole number above 0."})
        return None
    return int(text)


def _money(value) -> str:
    return f"₹{value:,.2f}".removesuffix(".00")


def _apply_row(item, row, name, price, code, category, course, flags, existing) -> list[str]:
    """Set the row's values on `item`; for an existing dish, say what changed."""
    changes = []

    def set_(attr, value, label, shown=str):
        old = getattr(item, attr)
        if old != value:
            if existing:
                changes.append(f"{label} {shown(old)} → {shown(value)}")
            setattr(item, attr, value)

    set_("name", name, "Name")
    set_("price", price, "Price", _money)
    if code is not None:
        set_("code", code, "Number", lambda v: "—" if v is None else str(v))
    if item.category_id is None or item.category.name.lower() != category.name.lower():
        if existing:
            changes.append(f"Category {item.category.name} → {category.name}")
        item.category = category
    current_course = item.course.name if item.course_id else None
    if course is not None and (current_course or "").lower() != course.name.lower():
        if existing:
            changes.append(f"Course {current_course or '—'} → {course.name}")
        item.course = course
    if row.get("description"):
        set_("description", row["description"], "Description", lambda v: f"“{v[:30]}”")
    labels = {attr: h for h, attr, _ in COLUMNS}
    for attr, value in flags.items():
        if value is not None:  # blank keeps what's there (a new dish: No, but available)
            set_(attr, value, labels[attr], lambda v: "Yes" if v else "No")
    return changes


def _check(rows) -> tuple[Result, list]:
    result = Result()
    errors = result.errors
    plan = []  # (MenuItem, category, course, station or None, station given?)
    seen: dict[str, int] = {}
    seen_codes: dict[int, int] = {}
    categories, stations, courses = {}, {}, {}
    last = Category.objects.order_by("-sort_order").values_list("sort_order", flat=True).first()
    next_sort = (last or 0) + 1

    for number, row in rows:
        before = len(errors)
        name = row.get("name", "")
        for attr in REQUIRED:
            if not row.get(attr):
                label = next(h for h, a, _ in COLUMNS if a == attr)
                errors.append({"row": number, "message": f"{label} is required."})
        if len(name) > 120:
            errors.append({"row": number, "message": "Name: at most 120 characters."})
        if name and name.lower() in seen:
            errors.append(
                {"row": number, "message": f"“{name}” is also on row {seen[name.lower()]}."}
            )
        seen.setdefault(name.lower(), number)
        price = _price(row["price"], number, errors) if row.get("price") else None
        code = _code(row.get("code", ""), number, errors)
        if code is not None:
            if code in seen_codes:
                errors.append(
                    {"row": number, "message": f"Number {code} is also on row {seen_codes[code]}."}
                )
            seen_codes.setdefault(code, number)
            other = MenuItem.objects.filter(code=code).exclude(name__iexact=name).first()
            if other:
                errors.append({"row": number, "message": f"Number {code} is already {other.name}."})
        flags = {
            attr: _flag(row.get(attr, ""), number, h, errors)
            for h, attr, _ in COLUMNS
            if attr in FLAGS
        }
        if len(errors) > before:
            continue

        new_categories = len(result.new["categories"])
        category = _lookup(
            Category, row["category"], categories, result.new["categories"], sort_order=next_sort
        )
        next_sort += len(result.new["categories"]) - new_categories
        station_name = row.get("station", "")
        station = (
            _lookup(Station, station_name, stations, result.new["stations"])
            if station_name
            else None
        )
        if station and category.pk and category.station_id != station.pk:
            note = f"{category.name} tickets go to {station.name} from now on"
            if note not in result.notes:
                result.notes.append(note)
        course = (
            _lookup(Course, row["course"], courses, result.new["courses"])
            if row.get("course")
            else None
        )

        item = MenuItem.objects.filter(name__iexact=name).first()
        action = "update" if item else "create"
        item = item or MenuItem(name=name, is_available=True)
        changes = _apply_row(
            item, row, name, price, code, category, course, flags, action == "update"
        )

        result.rows.append(
            {
                "row": number,
                "name": name,
                "category": category.name,
                "price": str(price),
                "action": action if action == "create" or changes else "unchanged",
                "changes": changes,
            }
        )
        plan.append((item, category, course, station, bool(station_name)))
    return result, plan


def preview(upload) -> dict:
    result, _ = _check(read_rows(upload))
    return result.as_dict(saved=False)


@transaction.atomic
def apply(upload) -> dict:
    result, plan = _check(read_rows(upload))
    if result.errors:
        return result.as_dict(saved=False)
    # Numbered dishes first, so a blank one's "next free number" can't take a number the file
    # gives to a dish further down.
    plan.sort(key=lambda step: step[0].code is None)
    for item, category, course, station, station_given in plan:
        for obj in (station, course):
            if obj is not None and obj.pk is None:
                obj.save()
        if station_given and category.station_id != station.pk:
            category.station = station
            category.save()
        elif category.pk is None:
            category.save()
        item.category, item.course = category, course or item.course
        item.save()
    return result.as_dict(saved=True)


# ---------- writing ----------


def _current_rows() -> list[list]:
    yes_no = lambda v: "Yes" if v else "No"  # noqa: E731
    return [
        [
            i.name,
            i.category.name,
            float(i.price) if i.price != int(i.price) else int(i.price),
            i.category.station.name if i.category.station else "",
            i.course.name if i.course else "",
            yes_no(i.is_vegetarian),
            yes_no(i.has_jain),
            yes_no(i.is_special),
            yes_no(i.is_available),
            i.description,
            i.code or "",
        ]
        for i in MenuItem.objects.select_related("category__station", "course").order_by(
            "category__sort_order", "category__name", "name"
        )
    ]


def template_xlsx(current: bool) -> bytes:
    book = Workbook()
    sheet = book.active
    sheet.title = "Menu"
    sheet.append(HEADERS)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="EEEEEE")
    for row in _current_rows() if current else []:
        sheet.append(row)
    sheet.freeze_panes = "A2"
    for letter, width in zip("ABCDEFGHIJK", [28, 16, 10, 16, 12, 7, 12, 9, 10, 40, 9], strict=True):
        sheet.column_dimensions[letter].width = width
    yes_no = DataValidation(type="list", formula1='"Yes,No"', allow_blank=True)
    sheet.add_data_validation(yes_no)
    yes_no.add(f"F2:I{MAX_ROWS + 1}")

    help_ = book.create_sheet("How to fill")
    help_.append(["Fill one row per dish on the Menu sheet. Columns marked * are required."])
    help_.append(
        [
            "Dishes are matched by name: importing again updates prices and details, "
            "adds new dishes, and never deletes any."
        ]
    )
    help_.append([])
    help_.append(["Column", "What to write"])
    for header, (_, _, text) in zip(HEADERS, COLUMNS, strict=True):
        help_.append([header, text])
    help_.append([])
    help_.append(["Examples"])
    help_.append(HEADERS)
    for row in EXAMPLES:
        help_.append(row)
    help_["A1"].font = help_["A4"].font = help_["B4"].font = Font(bold=True)
    help_.column_dimensions["A"].width = 22
    help_.column_dimensions["B"].width = 90

    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def template_csv(current: bool) -> bytes:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(HEADERS)
    writer.writerows(_current_rows() if current else [])
    return out.getvalue().encode("utf-8-sig")  # BOM: Excel then reads ₹ and non-English names
