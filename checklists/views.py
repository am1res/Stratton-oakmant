from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from . import services
from .models import Checklist, ChecklistVersion
from .serializers import ChecklistSerializer, ChecklistVersionSerializer, ChecklistVersionSummarySerializer


class ChecklistViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin, viewsets.GenericViewSet
):
    queryset = Checklist.objects.order_by("name")
    serializer_class = ChecklistSerializer

    @action(detail=True, methods=["get", "post"])
    def versions(self, request, pk=None):
        """GET: version history. POST: save an edited checklist as a new (active) version."""
        checklist = self.get_object()
        if request.method == "GET":
            return Response(ChecklistVersionSummarySerializer(checklist.versions.all(), many=True).data)
        body = ChecklistVersionSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        activate = str(request.query_params.get("activate", "true")).lower() != "false"
        version = services.create_version(checklist, body.validated_data, activate=activate)
        return Response(ChecklistVersionSerializer(version).data, status=status.HTTP_201_CREATED)


class ChecklistVersionViewSet(viewsets.ReadOnlyModelViewSet):
    """Versions are immutable: to change one, POST a new version to its checklist."""

    queryset = ChecklistVersion.objects.select_related("checklist").prefetch_related(
        "sections", "criteria__section"
    )
    serializer_class = ChecklistVersionSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("active") in ("1", "true"):
            qs = qs.filter(is_active=True)
        return qs

    @action(detail=True, methods=["post"])
    def activate(self, request, pk=None):
        version = services.activate_version(self.get_object())
        return Response(ChecklistVersionSummarySerializer(version).data)
