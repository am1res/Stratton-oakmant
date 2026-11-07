from rest_framework.routers import DefaultRouter

from .views import ChecklistVersionViewSet, ChecklistViewSet

router = DefaultRouter()
router.register("checklists", ChecklistViewSet, basename="checklist")
router.register("checklist-versions", ChecklistVersionViewSet, basename="checklist-version")

urlpatterns = router.urls
