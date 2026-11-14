from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from apps.core.setup_views import SetupRestoreView, SetupView
from apps.core.views import (
    BackupFileView,
    BackupRunView,
    BackupSettingsView,
    BackupView,
    CookingInstructionsView,
    PrintSettingsView,
    RestaurantSettingsView,
    health,
)
from apps.floor.views import RoomViewSet, TableViewSet
from apps.kitchen.views import KOTViewSet, StationViewSet
from apps.menu.views import CategoryViewSet, CourseViewSet, MenuItemViewSet
from apps.orders.views import OrderViewSet, PaymentViewSet
from apps.printing.views import (
    PendingView,
    PrintedView,
    QzCertificateView,
    QzSignView,
    TestTicketView,
)
from apps.reports.views import SalesReportView
from apps.reservations.views import ReservationViewSet
from apps.users.views import MeView, UserViewSet

router = DefaultRouter()
router.register("users", UserViewSet)
router.register("rooms", RoomViewSet)
router.register("tables", TableViewSet)
router.register("courses", CourseViewSet)
router.register("categories", CategoryViewSet)
router.register("menu-items", MenuItemViewSet)
router.register("stations", StationViewSet)
router.register("kots", KOTViewSet)
router.register("orders", OrderViewSet)
router.register("payments", PaymentViewSet)
router.register("reservations", ReservationViewSet)

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", health),
    path("api/setup/", SetupView.as_view()),
    path("api/setup/restore/", SetupRestoreView.as_view()),
    path("api/backup/", BackupView.as_view()),
    path("api/settings/restaurant/", RestaurantSettingsView.as_view()),
    path("api/settings/printing/", PrintSettingsView.as_view()),
    path("api/settings/cooking-instructions/", CookingInstructionsView.as_view()),
    path("api/settings/backup/", BackupSettingsView.as_view()),
    path("api/settings/backup/run/", BackupRunView.as_view()),
    path("api/settings/backup/files/<str:name>/", BackupFileView.as_view()),
    path("api/auth/token/", TokenObtainPairView.as_view()),
    path("api/auth/token/refresh/", TokenRefreshView.as_view()),
    path("api/auth/me/", MeView.as_view()),
    path("api/printing/pending/", PendingView.as_view()),
    path("api/printing/printed/", PrintedView.as_view()),
    path("api/printing/test-ticket/", TestTicketView.as_view()),
    path("api/printing/qz/certificate/", QzCertificateView.as_view()),
    path("api/printing/qz/sign/", QzSignView.as_view()),
    path("api/reports/sales/", SalesReportView.as_view()),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema")),
    path("api/", include(router.urls)),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
