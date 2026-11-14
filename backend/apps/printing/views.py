from django.utils import timezone
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.permissions import ALL_ROLES, role_permission

from . import qz, services
from .ticket import build_test_ticket

Staff = role_permission(read=ALL_ROLES, write=ALL_ROLES)
WIDTHS = [32, 48]  # characters per line: 58mm and 80mm paper


class PendingQuery(serializers.Serializer):
    since = serializers.DateTimeField(required=False)
    width = serializers.ChoiceField(choices=WIDTHS, default=48)


class PrintedBody(serializers.Serializer):
    kind = serializers.ChoiceField(choices=["kot", "bill"])
    id = serializers.IntegerField()
    printer = serializers.CharField(max_length=200, allow_blank=True, default="")


class TestQuery(serializers.Serializer):
    printer = serializers.CharField(max_length=200)
    width = serializers.ChoiceField(choices=WIDTHS, default=48)


class SignBody(serializers.Serializer):
    message = serializers.CharField()


def _valid(serializer_class, data):
    serializer = serializer_class(data=data)
    serializer.is_valid(raise_exception=True)
    return serializer.validated_data


class PendingView(APIView):
    """Polled by the printer page. `now` is what a first-time page should send as `since`."""

    permission_classes = [Staff]
    serializer_class = PendingQuery

    def get(self, request):
        query = _valid(PendingQuery, request.query_params)
        tickets = services.pending(query.get("since"), int(query["width"]))
        return Response({"now": timezone.now(), "tickets": tickets})


class PrintedView(APIView):
    permission_classes = [Staff]
    serializer_class = PrintedBody

    def post(self, request):
        body = _valid(PrintedBody, request.data)
        services.mark_printed(body["kind"], body["id"], body["printer"], request.user)
        return Response(status=204)


class TestTicketView(APIView):
    permission_classes = [Staff]
    serializer_class = TestQuery

    def get(self, request):
        query = _valid(TestQuery, request.query_params)
        ticket = build_test_ticket(query["printer"], int(query["width"]))
        return Response({"ticket": services._encode(ticket)})


class QzCertificateView(APIView):
    permission_classes = [Staff]
    serializer_class = serializers.Serializer

    def get(self, request):
        return Response({"certificate": qz.certificate()})


class QzSignView(APIView):
    permission_classes = [Staff]
    serializer_class = SignBody

    def post(self, request):
        return Response({"signature": qz.sign(_valid(SignBody, request.data)["message"])})
