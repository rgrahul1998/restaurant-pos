from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.floor.models import Room, Table
from apps.kitchen.models import Station
from apps.menu.models import Category, Course, MenuItem
from apps.users.models import Role, User

PASSWORD = "pos12345"

MENU = {
    # category: (station, course, [(item, price, vegetarian)])
    "Starters": (
        "Tandoor",
        "Starters",
        [("Paneer Tikka", 260, True), ("Chicken Tikka", 320, False)],
    ),
    "Mains": (
        "Main Kitchen",
        "Mains",
        [("Dal Makhani", 240, True), ("Butter Chicken", 380, False)],
    ),
    "Breads": ("Tandoor", "Mains", [("Butter Naan", 60, True), ("Tandoori Roti", 30, True)]),
    "Beverages": ("Bar", None, [("Fresh Lime Soda", 90, True), ("Masala Chai", 50, True)]),
}


class Command(BaseCommand):
    help = "Create one user per role plus a small floor and menu. Development only."

    @transaction.atomic
    def handle(self, *args, **options):
        if not settings.DEBUG:
            raise CommandError("seed_demo creates users with a known password; DEBUG only.")

        for role in Role:
            if not User.objects.filter(username=role.value).exists():
                User.objects.create_user(role.value, password=PASSWORD, role=role)

        for room_name, count in [("Main Hall", 8), ("Terrace", 4)]:
            room, _ = Room.objects.get_or_create(name=room_name)
            for n in range(1, count + 1):
                Table.objects.get_or_create(room=room, name=f"{room_name[0]}{n}")

        for order, name in enumerate(["Starters", "Mains", "Desserts"]):
            Course.objects.get_or_create(name=name, defaults={"sort_order": order})

        for order, (category_name, (station_name, course_name, items)) in enumerate(MENU.items()):
            station, _ = Station.objects.get_or_create(name=station_name)
            category, _ = Category.objects.get_or_create(
                name=category_name, defaults={"station": station, "sort_order": order}
            )
            course = Course.objects.filter(name=course_name).first()
            for name, price, vegetarian in items:
                MenuItem.objects.get_or_create(
                    name=name,
                    defaults={
                        "category": category,
                        "course": course,
                        "price": price,
                        "is_vegetarian": vegetarian,
                    },
                )

        self.stdout.write(
            self.style.SUCCESS(f"Seeded. Log in as {', '.join(Role.values)} / {PASSWORD}")
        )
