"""Demo restaurant: staff, floor, menu, four weeks of trade, today's service and bookings.

Used by the first-run setup screen ("Load demo data") and `setup_site --demo`. Everything is
generated from a fixed seed, so two demo installs look the same apart from the dates, which are
relative to today.

Past trade is written straight to the tables (with the timestamps it would have had); today's
open tables and the bookings go through the real services, so they behave exactly like orders
taken on the POS.
"""

import random
from contextlib import contextmanager
from datetime import datetime, time, timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from apps.floor.models import Room, Table
from apps.kitchen.models import KOT, KOTItem, Station
from apps.menu.models import Category, Course, MenuItem
from apps.orders import services as orders
from apps.orders.models import Order, OrderItem, Payment
from apps.printing.models import BillPrintJob, KOTPrintLog, Restaurant
from apps.reservations import services as reservations
from apps.reservations.models import Reservation
from apps.users.models import Role, User

HISTORY_DAYS = 28

RESTAURANT = {
    "name": "Saffron Table",
    "address_line1": "14, Linking Road",
    "address_line2": "Bandra West",
    "city": "Mumbai",
    "pincode": "400050",
    "phone": "+91 98200 12345",
}

# username, first name, last name, role
STAFF = [
    ("manager", "Priya", "Sharma", Role.MANAGER),
    ("cashier", "Arjun", "Mehta", Role.CASHIER),
    ("waiter", "Ravi", "Kumar", Role.WAITER),
    ("meena", "Meena", "Iyer", Role.WAITER),
    ("kitchen", "Suresh", "Patil", Role.KITCHEN),
]

ROOMS = [("Main Hall", "M", 10, 4), ("Terrace", "T", 6, 4)]

COURSES = ["Starters", "Mains", "Desserts"]

# category: (station or None, course, [(name, price, veg, jain, special, description)])
MENU = {
    "Soups": (
        "Main Kitchen",
        "Starters",
        [
            ("Tomato Shorba", 160, True, True, False, "Slow-cooked tomato, cumin, coriander"),
            ("Lemon Coriander Soup", 170, True, False, False, ""),
            ("Chicken Manchow Soup", 210, False, False, False, ""),
        ],
    ),
    "Starters": (
        "Tandoor",
        "Starters",
        [
            ("Paneer Tikka", 290, True, True, False, "Cottage cheese, hung-curd marinade"),
            ("Hara Bhara Kebab", 240, True, False, False, ""),
            ("Tandoori Mushroom", 270, True, False, False, ""),
            ("Chicken Tikka", 340, False, False, False, ""),
            ("Fish Amritsari", 380, False, False, True, "Gram-flour batter, carom, chaat masala"),
            ("Mutton Seekh Kebab", 420, False, False, False, ""),
        ],
    ),
    "Mains": (
        "Main Kitchen",
        "Mains",
        [
            ("Dal Makhani", 260, True, False, False, "Black lentils simmered overnight"),
            ("Dal Tadka", 220, True, True, False, ""),
            ("Paneer Butter Masala", 320, True, True, False, ""),
            ("Palak Paneer", 300, True, False, False, ""),
            ("Veg Kolhapuri", 280, True, False, False, ""),
            ("Butter Chicken", 410, False, False, False, "Tandoori chicken in tomato-butter gravy"),
            ("Chicken Chettinad", 400, False, False, True, "Kalpasi, black pepper, coconut"),
            ("Mutton Rogan Josh", 480, False, False, False, ""),
        ],
    ),
    "Breads": (
        "Tandoor",
        "Mains",
        [
            ("Tandoori Roti", 35, True, True, False, ""),
            ("Butter Naan", 65, True, True, False, ""),
            ("Garlic Naan", 80, True, False, False, ""),
            ("Laccha Paratha", 70, True, True, False, ""),
        ],
    ),
    "Rice": (
        "Main Kitchen",
        "Mains",
        [
            ("Jeera Rice", 180, True, True, False, ""),
            ("Veg Biryani", 300, True, False, False, ""),
            ("Chicken Dum Biryani", 390, False, False, False, ""),
        ],
    ),
    "Desserts": (
        "Main Kitchen",
        "Desserts",
        [
            ("Gulab Jamun", 120, True, True, False, ""),
            ("Rasmalai", 150, True, True, False, ""),
            ("Kulfi Falooda", 180, True, False, True, "Malai kulfi, rose syrup, falooda"),
        ],
    ),
    "Beverages": (
        "Bar",
        None,
        [
            ("Masala Chai", 60, True, False, False, ""),
            ("Fresh Lime Soda", 110, True, True, False, ""),
            ("Sweet Lassi", 130, True, True, False, ""),
            ("Cold Coffee", 160, True, False, False, ""),
        ],
    ),
    # No station: handed over from the counter, so no kitchen ticket.
    "Packaged": (
        None,
        None,
        [("Mineral Water", 40, True, False, False, ""), ("Soft Drink", 60, True, False, False, "")],
    ),
}

UNAVAILABLE = {"Mutton Rogan Josh"}  # 86'd today, to show the switch

CUSTOMERS = [
    ("Ananya Rao", "9820011122"),
    ("Vikram Singh", "9833044455"),
    ("Neha Kapoor", "9867012345"),
    ("Rohan Desai", "9821198765"),
    ("Kavya Nair", "9819923456"),
    ("Siddharth Jain", "9892234567"),
    ("Pooja Shah", "9870056789"),
    ("Aditya Kulkarni", "9930067890"),
    ("Ishita Ghosh", "9769078901"),
    ("Farhan Qureshi", "9004089012"),
]

METHODS = [Payment.Method.UPI] * 5 + [Payment.Method.CARD] * 3 + [Payment.Method.CASH] * 2


@contextmanager
def _own_timestamps(*models):
    """Let us write created_at / updated_at ourselves (past trade) instead of now()."""
    fields = [
        f for m in models for f in m._meta.concrete_fields if f.name in ("created_at", "updated_at")
    ]
    saved = [(f, f.auto_now, f.auto_now_add) for f in fields]
    for f in fields:
        f.auto_now = f.auto_now_add = False
    try:
        yield
    finally:
        for f, auto_now, auto_now_add in saved:
            f.auto_now, f.auto_now_add = auto_now, auto_now_add


def _local(day, hour, minute=0):
    return timezone.make_aware(datetime.combine(day, time(hour, minute)))


def _staff(admin_password: str) -> dict[str, User]:
    people = {}
    for username, first, last, role in STAFF:
        user = User(username=username, first_name=first, last_name=last, role=role)
        user.set_password(admin_password)
        user.save()
        people[username] = user
    return people


def _floor():
    tables = []
    for order, (room_name, prefix, count, seats) in enumerate(ROOMS):
        room = Room.objects.create(name=room_name, sort_order=order)
        for n in range(1, count + 1):
            tables.append(
                Table.objects.create(
                    room=room, name=f"{prefix}{n}", seats=6 if n in (count - 1, count) else seats
                )
            )
    private = Room.objects.create(name="Private Dining", sort_order=len(ROOMS))
    tables.append(Table.objects.create(room=private, name="PR1", seats=12))
    return tables


def _menu() -> list[MenuItem]:
    courses = {
        name: Course.objects.create(name=name, sort_order=i) for i, name in enumerate(COURSES)
    }
    stations = {}
    items = []
    for order, (category_name, (station_name, course_name, dishes)) in enumerate(MENU.items()):
        if station_name and station_name not in stations:
            stations[station_name] = Station.objects.create(name=station_name)
        category = Category.objects.create(
            name=category_name, station=stations.get(station_name), sort_order=order
        )
        for name, price, veg, jain, special, description in dishes:
            items.append(
                MenuItem.objects.create(
                    category=category,
                    course=courses.get(course_name),
                    name=name,
                    description=description,
                    price=Decimal(price),
                    is_vegetarian=veg,
                    has_jain=jain,
                    is_special=special,
                    is_available=name not in UNAVAILABLE,
                )
            )
    return items


def _pick_lines(rng: random.Random, menu: list[MenuItem], guests: int):
    """A plausible meal: a starter or two, mains with bread or rice, drinks, maybe dessert."""
    by_cat = {}
    for item in menu:
        by_cat.setdefault(item.category.name, []).append(item)
    picks = []
    picks += rng.sample(by_cat["Starters"] + by_cat["Soups"], k=min(2, max(1, guests // 2)))
    picks += rng.sample(by_cat["Mains"], k=min(3, max(1, (guests + 1) // 2)))
    picks.append(rng.choice(by_cat["Breads"] + by_cat["Rice"]))
    if rng.random() < 0.7:
        picks.append(rng.choice(by_cat["Beverages"] + by_cat["Packaged"]))
    if rng.random() < 0.4:
        picks.append(rng.choice(by_cat["Desserts"]))
    lines = {}
    for item in picks:
        jain = item.has_jain and rng.random() < 0.15
        qty = guests * 2 if item.category.name == "Breads" else rng.choice([1, 1, 1, 2])
        if item.category.name in ("Beverages", "Packaged"):
            qty = max(1, guests - rng.randint(0, 1))
        key = (item.pk, jain)
        if key not in lines:
            lines[key] = (item, jain, qty)
    return list(lines.values())


def _past_trade(rng, menu, tables, people, admin):
    """Four weeks of paid (and a few cancelled) orders, ending yesterday."""
    waiters = [people["waiter"], people["meena"], people["manager"]]
    billers = [people["cashier"], people["cashier"], people["manager"]]
    dine_in = [t for t in tables if t.name != "PR1"]
    today = timezone.localdate()

    with _own_timestamps(Order, OrderItem, KOT, Payment):
        for back in range(HISTORY_DAYS, 0, -1):
            day = today - timedelta(days=back)
            weekend = day.weekday() >= 5
            count = rng.randint(14, 22) if weekend else rng.randint(8, 14)
            for _ in range(count):
                dinner = rng.random() < 0.62
                hours = [19, 20, 20, 21, 21, 22] if dinner else [12, 13, 13, 14]
                hour = rng.choice(hours)
                opened = _local(day, hour, rng.randint(0, 59))
                takeaway = rng.random() < 0.15
                guests = 1 if takeaway else rng.choice([2, 2, 2, 3, 4, 4, 5, 6])
                customer = rng.choice(CUSTOMERS) if rng.random() < 0.35 else ("", "")
                cancelled = rng.random() < 0.03
                order = Order.objects.create(
                    order_type=Order.Type.TAKEAWAY if takeaway else Order.Type.DINE_IN,
                    status=Order.Status.CANCELLED if cancelled else Order.Status.PAID,
                    table=None if takeaway else rng.choice(dine_in),
                    guests=guests,
                    customer_name=customer[0],
                    customer_phone=customer[1],
                    waiter=rng.choice(waiters),
                    cashier=None if cancelled else rng.choice(billers),
                    created_at=opened,
                    updated_at=opened,
                )
                lines = _pick_lines(rng, menu, guests)
                items = OrderItem.objects.bulk_create(
                    OrderItem(
                        order=order,
                        menu_item=item,
                        name=item.name,
                        unit_price=item.price,
                        quantity=0 if cancelled else qty,
                        kot_quantity=0 if cancelled else qty,
                        is_jain=jain,
                        created_at=opened,
                        updated_at=opened,
                    )
                    for item, jain, qty in lines
                )
                _past_kots(order, items, lines, opened, cancelled, admin)

                closed = opened + timedelta(minutes=rng.randint(40, 95))
                if cancelled:
                    order.closed_at = closed
                    order.save(update_fields=["closed_at"])
                    continue
                order.recalculate()
                if rng.random() < 0.18:
                    order.discount_percent = Decimal(rng.choice([5, 10, 10, 15]))
                    order.discount = (order.subtotal * order.discount_percent / 100).quantize(
                        Decimal("1")
                    )
                    order.recalculate()
                order.closed_at = closed
                order.save()
                _past_payments(rng, order, closed, people["cashier"])


def _past_kots(order, items, lines, opened, cancelled, user):
    by_station = {}
    for item, (menu_item, _jain, qty) in zip(items, lines, strict=True):
        station = menu_item.category.station
        if station:
            by_station.setdefault(station, []).append((item, qty))
    for station, rows in by_station.items():
        kot = KOT.objects.create(
            order=order,
            station=station,
            status=KOT.Status.SERVED,
            created_by=order.waiter,
            created_at=opened + timedelta(minutes=2),
            updated_at=opened + timedelta(minutes=25),
            started_at=opened + timedelta(minutes=4),
            ready_at=opened + timedelta(minutes=18),
            served_at=opened + timedelta(minutes=22),
        )
        KOTItem.objects.bulk_create(
            KOTItem(kot=kot, order_item=item, name=item.name, quantity=qty, is_jain=item.is_jain)
            for item, qty in rows
        )
        if cancelled:
            cancel = KOT.objects.create(
                order=order,
                station=station,
                type=KOT.Type.CANCELLED,
                status=KOT.Status.SERVED,
                original=kot,
                created_by=user,
                created_at=opened + timedelta(minutes=10),
                updated_at=opened + timedelta(minutes=10),
            )
            KOTItem.objects.bulk_create(
                KOTItem(
                    kot=cancel,
                    order_item=item,
                    name=item.name,
                    quantity=qty,
                    cancelled_quantity=qty,
                    is_jain=item.is_jain,
                )
                for item, qty in rows
            )


def _past_payments(rng, order, closed, cashier):
    due = order.total
    if due <= 0:
        return
    if rng.random() < 0.12 and due > 600:  # split between two methods
        first = (due * Decimal("0.5")).quantize(Decimal("1"))
        parts = [(rng.choice(METHODS), first), (rng.choice(METHODS), due - first)]
    else:
        parts = [(rng.choice(METHODS), due)]
    for method, amount in parts:
        Payment.objects.create(
            order=order,
            method=method,
            amount=amount,
            reference=f"UPI{rng.randint(100000, 999999)}" if method == Payment.Method.UPI else "",
            received_by=cashier,
            created_at=closed,
            updated_at=closed,
        )


def _today(rng, menu, tables, people):
    """Service in progress: busy tables in each state, a joined group and a takeaway."""
    by_name = {t.name: t for t in tables}
    waiter, meena, cashier = people["waiter"], people["meena"], people["cashier"]
    item = {m.name: m for m in menu}

    def lines(*names):
        out = []
        for entry in names:
            name, qty, *rest = entry
            jain = bool(rest and rest[0])
            out.append({"menu_item": item[name], "quantity": qty, "is_jain": jain})
        return out

    # M2: food on its way, kitchen working on it.
    o = orders.open_order(
        waiter,
        table=by_name["M2"],
        guests=4,
        lines=lines(("Paneer Tikka", 1), ("Chicken Tikka", 1), ("Fresh Lime Soda", 4)),
    )
    orders.fire(o.pk, waiter)
    orders.update_order(
        o.pk,
        waiter,
        lines=lines(("Dal Makhani", 1), ("Butter Chicken", 1), ("Butter Naan", 6)),
    )
    orders.fire(o.pk, waiter)
    first = o.kots.order_by("created_at")
    for kot in first[:2]:
        kot.status = KOT.Status.READY
        kot.save()

    # M5: Jain family, just ordered.
    o = orders.open_order(
        meena,
        table=by_name["M5"],
        guests=3,
        customer_name="Siddharth Jain",
        customer_phone="9892234567",
        lines=lines(
            ("Paneer Butter Masala", 1, True),
            ("Dal Tadka", 1, True),
            ("Tandoori Roti", 6, True),
            ("Sweet Lassi", 3),
        ),
    )
    orders.fire(o.pk, meena)

    # M7: still choosing; nothing sent yet.
    orders.open_order(waiter, table=by_name["M7"], guests=2, lines=lines(("Tomato Shorba", 2)))

    # T1 + T2: a birthday group on joined tables, being billed.
    from apps.floor import services as floor

    floor.merge(by_name["T1"].pk, [by_name["T2"].pk])
    o = orders.open_order(
        meena,
        table=by_name["T1"],
        guests=8,
        customer_name="Kavya Nair",
        customer_phone="9819923456",
        lines=lines(
            ("Hara Bhara Kebab", 2),
            ("Fish Amritsari", 2),
            ("Veg Biryani", 2),
            ("Chicken Dum Biryani", 2),
            ("Kulfi Falooda", 8),
            ("Cold Coffee", 4),
        ),
    )
    orders.fire(o.pk, meena)
    o.kots.update(status=KOT.Status.SERVED)
    orders.bill(o.pk, cashier, Decimal("10"), "percent")

    # A takeaway at the counter.
    o = orders.open_order(
        cashier,
        order_type=Order.Type.TAKEAWAY,
        customer_name="Farhan Qureshi",
        customer_phone="9004089012",
        lines=lines(("Chicken Dum Biryani", 2), ("Gulab Jamun", 2)),
    )
    orders.fire(o.pk, cashier)

    # Lunch already paid and gone.
    for table, guests, dishes in [
        ("M1", 2, [("Veg Kolhapuri", 1), ("Jeera Rice", 1), ("Masala Chai", 2)]),
        ("M3", 4, [("Chicken Chettinad", 1), ("Palak Paneer", 1), ("Garlic Naan", 6)]),
        ("T4", 2, [("Dal Makhani", 1), ("Laccha Paratha", 3), ("Rasmalai", 2)]),
    ]:
        o = orders.open_order(waiter, table=by_name[table], guests=guests, lines=lines(*dishes))
        orders.fire(o.pk, waiter)
        o.kots.update(status=KOT.Status.SERVED)
        o = orders.bill(o.pk, cashier)
        orders.pay(o.pk, cashier, method=rng.choice(METHODS), amount=o.balance)


def _bookings(people):
    """Bookings around today: tonight, the coming days, and a no-show from last week."""
    cashier, manager = people["cashier"], people["manager"]
    table = {t.name: t for t in Table.objects.all()}
    today = timezone.localdate()

    def book(user, day, start, end, tables, **fields):
        return reservations.create(
            user,
            tables=[table[n] for n in tables],
            start_at=_local(day, *start),
            end_at=_local(day, *end),
            **fields,
        )

    book(
        cashier,
        today,
        (20, 0),
        (22, 30),
        ["PR1"],
        customer_name="Vikram Singh",
        customer_phone="9833044455",
        guests=10,
        occasion=Reservation.Occasion.CORPORATE,
        note="Team dinner, needs projector",
        advance={"amount": Decimal("3000"), "method": Payment.Method.UPI, "reference": "UPI778812"},
    )
    book(
        cashier,
        today,
        (21, 0),
        (23, 0),
        ["M9", "M10"],
        customer_name="Ananya Rao",
        customer_phone="9820011122",
        guests=10,
        occasion=Reservation.Occasion.BIRTHDAY,
        note="Cake at 10 pm",
        advance={"amount": Decimal("2000"), "method": Payment.Method.CARD, "reference": ""},
    )
    book(
        manager,
        today + timedelta(days=1),
        (13, 0),
        (15, 0),
        ["T5"],
        customer_name="Neha Kapoor",
        customer_phone="9867012345",
        guests=4,
        occasion=Reservation.Occasion.ANNIVERSARY,
    )
    book(
        cashier,
        today + timedelta(days=2),
        (19, 30),
        (22, 0),
        ["PR1"],
        customer_name="Rohan Desai",
        customer_phone="9821198765",
        guests=12,
        occasion=Reservation.Occasion.BIRTHDAY,
        advance={"amount": Decimal("5000"), "method": Payment.Method.UPI, "reference": "UPI552301"},
    )
    book(
        cashier,
        today + timedelta(days=4),
        (20, 0),
        (22, 0),
        ["M4"],
        customer_name="Pooja Shah",
        customer_phone="9870056789",
        guests=4,
    )
    # Last week: one no-show (advance kept), one cancellation (refunded).
    gone = book(
        cashier,
        today - timedelta(days=5),
        (20, 0),
        (22, 0),
        ["T3"],
        customer_name="Aditya Kulkarni",
        customer_phone="9930067890",
        guests=4,
        advance={"amount": Decimal("1000"), "method": Payment.Method.CASH, "reference": ""},
    )
    reservations.cancel(gone.pk, manager, no_show=True, outcome="forfeit")
    gone = book(
        cashier,
        today - timedelta(days=3),
        (13, 0),
        (15, 0),
        ["M6"],
        customer_name="Ishita Ghosh",
        customer_phone="9769078901",
        guests=5,
        advance={"amount": Decimal("1500"), "method": Payment.Method.UPI, "reference": "UPI100293"},
    )
    reservations.cancel(
        gone.pk,
        manager,
        outcome="refund",
        method=Payment.Method.UPI,
        reason="Plans changed",
    )


@transaction.atomic
def load(admin: User, password: str) -> dict:
    """Fill an empty POS with the demo restaurant. Staff log in with `password`."""
    rng = random.Random(1998)
    restaurant = Restaurant.load()
    for field, value in RESTAURANT.items():
        setattr(restaurant, field, value)
    restaurant.save()

    people = _staff(password)
    tables = _floor()
    menu = _menu()
    _past_trade(rng, menu, tables, people, admin)
    _today(rng, menu, tables, people)
    _bookings(people)

    # Everything so far is "already printed": the printer page shouldn't churn out demo tickets.
    KOTPrintLog.objects.bulk_create(
        KOTPrintLog(kot=kot) for kot in KOT.objects.filter(print_log__isnull=True)
    )
    BillPrintJob.objects.update(status=BillPrintJob.Status.PRINTED)

    return {
        "staff": [u for u, *_ in STAFF],
        "orders": Order.objects.count(),
        "menu_items": len(menu),
        "tables": len(tables),
        "reservations": Reservation.objects.count(),
    }
