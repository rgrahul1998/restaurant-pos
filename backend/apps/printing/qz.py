"""Signs QZ Tray requests so the laptop doesn't ask "Allow?" on every print.

Optional: without a certificate QZ Tray still prints, but prompts each time.
"""

import base64
from functools import cache
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from django.conf import settings


def certificate() -> str:
    path = settings.QZ_CERTIFICATE_FILE
    return Path(path).read_text() if path else ""


@cache
def _private_key(path: str):
    return serialization.load_pem_private_key(Path(path).read_bytes(), password=None)


def sign(message: str) -> str:
    path = settings.QZ_PRIVATE_KEY_FILE
    if not path:
        return ""
    signature = _private_key(path).sign(message.encode(), padding.PKCS1v15(), hashes.SHA512())
    return base64.b64encode(signature).decode("ascii")
