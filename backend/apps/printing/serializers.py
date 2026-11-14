import re

from rest_framework import serializers

from .models import PrintSettings, Restaurant

# 2-digit state code, PAN (5 letters, 4 digits, letter), entity number, Z, check character.
GSTIN = re.compile(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]")


class RestaurantSerializer(serializers.ModelSerializer):
    # Typed with spaces ("1152 1012 0001 23"); the length is checked once they're removed.
    gstin = serializers.CharField(max_length=30, required=False, allow_blank=True)
    fssai = serializers.CharField(max_length=30, required=False, allow_blank=True)

    class Meta:
        model = Restaurant
        fields = [
            "name",
            "legal_name",
            "address_line1",
            "address_line2",
            "city",
            "state",
            "pincode",
            "phone",
            "email",
            "gstin",
            "fssai",
            "bill_footer",
        ]
        extra_kwargs = {"name": {"allow_blank": False}}

    def validate_gstin(self, value):
        value = re.sub(r"\s", "", value).upper()
        if value and not GSTIN.fullmatch(value):
            raise serializers.ValidationError(
                "That is not a valid GSTIN. It has 15 characters, like 27ABCDE1234F1Z5."
            )
        return value

    def validate_fssai(self, value):
        value = re.sub(r"\s", "", value)
        if value and not re.fullmatch(r"\d{14}", value):
            raise serializers.ValidationError("An FSSAI licence number is 14 digits.")
        return value

    def validate_pincode(self, value):
        value = value.strip()
        if value and not re.fullmatch(r"\d{6}", value):
            raise serializers.ValidationError("A PIN code is 6 digits.")
        return value


# An IPv4 address or a plain host name; never a URL, since it goes straight into a socket.
HOST = re.compile(r"[A-Za-z0-9]([A-Za-z0-9.-]{0,98}[A-Za-z0-9])?")


class PrintSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = PrintSettings
        fields = ["kot_printer_host", "bill_printer_host", "port", "width"]
        extra_kwargs = {"port": {"min_value": 1, "max_value": 65535}}

    def _host(self, value):
        value = value.strip()
        if value and not HOST.fullmatch(value):
            raise serializers.ValidationError("Enter the printer's IP address, like 192.168.1.50.")
        return value

    validate_kot_printer_host = _host
    validate_bill_printer_host = _host
