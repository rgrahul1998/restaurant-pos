from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from simple_history.admin import SimpleHistoryAdmin
from unfold.admin import ModelAdmin
from unfold.forms import AdminPasswordChangeForm, UserChangeForm, UserCreationForm

from .models import User


@admin.register(User)
class UserAdmin(SimpleHistoryAdmin, BaseUserAdmin, ModelAdmin):
    form = UserChangeForm
    add_form = UserCreationForm
    change_password_form = AdminPasswordChangeForm
    list_display = ["username", "first_name", "last_name", "role", "is_active"]
    list_filter = ["role", "is_active"]
    fieldsets = [
        (None, {"fields": ["username", "password"]}),
        ("Profile", {"fields": ["first_name", "last_name", "phone", "role", "is_active"]}),
    ]
    add_fieldsets = [
        (None, {"fields": ["username", "role", "password1", "password2"]}),
    ]
