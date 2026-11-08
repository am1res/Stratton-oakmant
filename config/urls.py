from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("ingestion.urls")),
    path("api/", include("checklists.urls")),
    path("api/", include("evaluations.urls")),
    path("api/", include("appeals.urls")),
]
