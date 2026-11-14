from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.users.models import Role

ALL_ROLES = frozenset(Role.values)
MANAGEMENT = frozenset({Role.ADMIN, Role.MANAGER})
FRONT_OF_HOUSE = MANAGEMENT | {Role.CASHIER, Role.WAITER}
BILLING = MANAGEMENT | {Role.CASHIER}
KITCHEN_STAFF = MANAGEMENT | {Role.KITCHEN}


def role_permission(*, read=ALL_ROLES, write=MANAGEMENT):
    """Build a DRF permission class: `read` roles may use safe methods, `write` roles the rest."""

    class RolePermission(BasePermission):
        def has_permission(self, request, view):
            user = request.user
            if not (user and user.is_authenticated):
                return False
            allowed = read if request.method in SAFE_METHODS else write
            return user.role in allowed

    return RolePermission
