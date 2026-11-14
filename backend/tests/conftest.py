import pytest


@pytest.fixture(autouse=True)
def isolated_cache_and_channels(settings):
    """Keep tests off the dev server's Redis.

    Sharing it, an open Printer page marks itself alive in the middle of a test, and
    test events reach real kitchen and printer screens.
    """
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    settings.CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
