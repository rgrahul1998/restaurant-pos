from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .permissions import ALL_ROLES, FRONT_OF_HOUSE
from .realtime import FLOOR_GROUP, KITCHEN_GROUP


class GroupConsumer(AsyncJsonWebsocketConsumer):
    """Read-only feed: joins one group and relays its events to the client."""

    group: str
    roles: frozenset = ALL_ROLES

    async def connect(self):
        user = self.scope.get("user")
        if not (user and user.is_authenticated and user.role in self.roles):
            await self.close(code=4401)
            return
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        await self.channel_layer.group_discard(self.group, self.channel_name)

    async def pos_event(self, message):
        await self.send_json({"event": message["event"], "payload": message["payload"]})


class KitchenConsumer(GroupConsumer):
    group = KITCHEN_GROUP


class FloorConsumer(GroupConsumer):
    group = FLOOR_GROUP
    roles = FRONT_OF_HOUSE
