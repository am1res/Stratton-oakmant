from rest_framework.routers import DefaultRouter

from .views import ConversationViewSet, DatasetViewSet

router = DefaultRouter()
router.register("datasets", DatasetViewSet, basename="dataset")
router.register("conversations", ConversationViewSet, basename="conversation")

urlpatterns = router.urls
