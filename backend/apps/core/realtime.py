from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

KITCHEN_GROUP = "kitchen"
FLOOR_GROUP = "floor"
# The laptop's Printer page: told the moment a KOT or bill is waiting, so it prints at once.
PRINTER_GROUP = "printer"


def broadcast(group: str, event: str, payload: dict) -> None:
    """Push `{event, payload}` to every websocket subscribed to `group`."""
    async_to_sync(get_channel_layer().group_send)(
        group, {"type": "pos.event", "event": event, "payload": payload}
    )
