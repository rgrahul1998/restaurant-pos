from django.urls import path

from .consumers import FloorConsumer, KitchenConsumer

websocket_urlpatterns = [
    path("ws/kitchen/", KitchenConsumer.as_asgi()),
    path("ws/floor/", FloorConsumer.as_asgi()),
]
