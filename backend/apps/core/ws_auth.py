from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.middleware import BaseMiddleware
from django.contrib.auth.models import AnonymousUser
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError


@database_sync_to_async
def _user_from_token(raw_token: str):
    auth = JWTAuthentication()
    try:
        return auth.get_user(auth.get_validated_token(raw_token))
    except (InvalidToken, TokenError):
        return AnonymousUser()


class JWTAuthMiddleware(BaseMiddleware):
    """Authenticate websockets with `?token=<access JWT>` (browsers can't set WS headers)."""

    async def __call__(self, scope, receive, send):
        token = parse_qs(scope["query_string"].decode()).get("token", [None])[0]
        scope["user"] = await _user_from_token(token) if token else AnonymousUser()
        return await super().__call__(scope, receive, send)
