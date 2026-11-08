from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import AppealViewSet, criterion_result_appeals, evaluation_audit

router = DefaultRouter()
router.register("appeals", AppealViewSet, basename="appeal")

urlpatterns = [
    path("criterion-results/<int:pk>/appeals/", criterion_result_appeals, name="criterion-result-appeals"),
    path("evaluations/<int:pk>/audit/", evaluation_audit, name="evaluation-audit"),
    *router.urls,
]
