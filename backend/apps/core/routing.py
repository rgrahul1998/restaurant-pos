from django.urls import path

from .consumers import FloorConsumer, KitchenConsumer, PrinterConsumer

websocket_urlpatterns = [
    path("ws/kitchen/", KitchenConsumer.as_asgi()),
    path("ws/floor/", FloorConsumer.as_asgi()),
    path("ws/printer/", PrinterConsumer.as_asgi()),
]
