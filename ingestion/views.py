from django.db.models import Prefetch
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from evaluations.models import Evaluation

from . import services
from .models import Conversation, Dataset
from .serializers import (
    ConversationDetailSerializer,
    ConversationListSerializer,
    DatasetSerializer,
    ImportRequestSerializer,
    UploadRequestSerializer,
)


class DatasetViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Dataset.objects.order_by("-fetched_at")
    serializer_class = DatasetSerializer

    def _imported(self, run_import, error_status):
        try:
            dataset = run_import()
        except services.DatasetImportError as exc:
            return Response({"detail": str(exc)}, status=error_status)
        return Response(DatasetSerializer(dataset).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["post"], url_path="import")
    def import_group(self, request):
        """Fetch a group (DEV or the control set) from the organizers' API."""
        body = ImportRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        return self._imported(
            lambda: services.import_group(body.validated_data["group_id"]), status.HTTP_502_BAD_GATEWAY
        )

    @action(detail=False, methods=["post"])
    def upload(self, request):
        """Import a payload of the same shape the API returns (manual upload)."""
        body = UploadRequestSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = body.validated_data
        return self._imported(
            lambda: services.import_payload(data["group_id"], data["payload"]), status.HTTP_400_BAD_REQUEST
        )


class ConversationViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    def get_queryset(self):
        params = self.request.query_params
        # Read-side composition only: ingestion's models and services stay independent.
        evaluations = Evaluation.objects.order_by("-created_at")
        if params.get("checklist_version"):
            evaluations = evaluations.filter(checklist_version_id=params["checklist_version"])
        qs = Conversation.objects.select_related("dataset").prefetch_related(
            Prefetch("evaluations", queryset=evaluations)
        )
        if self.action == "retrieve":
            qs = qs.prefetch_related("messages")
        filters = {
            "dataset": "dataset_id",
            "group_id": "dataset__group_id",
            "language": "language__iexact",
            "channel": "channel",
        }
        for param, lookup in filters.items():
            if params.get(param):
                qs = qs.filter(**{lookup: params[param]})
        return qs

    def get_serializer_class(self):
        return ConversationDetailSerializer if self.action == "retrieve" else ConversationListSerializer
