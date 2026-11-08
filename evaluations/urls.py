from rest_framework.routers import DefaultRouter

from .views import EvaluationViewSet, RunViewSet

router = DefaultRouter()
router.register("runs", RunViewSet, basename="run")
router.register("evaluations", EvaluationViewSet, basename="evaluation")

urlpatterns = router.urls
