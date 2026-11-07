from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from ingestion.models import Conversation

from .models import Evaluation, EvaluationRun
from .serializers import (
    AgentVerdictSerializer,
    EvaluationDetailSerializer,
    EvaluationListSerializer,
    RunCreateSerializer,
    RunSerializer,
)
from .services import runs


class RunViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = EvaluationRun.objects.select_related("dataset")
    serializer_class = RunSerializer

    def create(self, request):
        """Start a batch. Body: {dataset: group_id | conversations: [ids], checklist_version?, force?}."""
        body = RunCreateSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        data = body.validated_data
        conversations = data.get("conversations") or Conversation.objects.filter(dataset=data["dataset"])
        run = runs.start_run(
            data["checklist_version"], conversations, dataset=data.get("dataset"), force=data["force"]
        )
        return Response(RunSerializer(run).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def retry(self, request, pk=None):
        """Re-queue failed, never-started and stuck evaluations."""
        ids = runs.retry(self.get_object())
        return Response({"requeued": ids})


class EvaluationViewSet(viewsets.ReadOnlyModelViewSet):
    def get_queryset(self):
        qs = Evaluation.objects.select_related("conversation", "checklist_version")
        params = self.request.query_params
        filters = {
            "run": "run_id",
            "conversation": "conversation_id",
            "checklist_version": "checklist_version_id",
            "status": "status",
            "group_id": "conversation__dataset__group_id",
        }
        for param, lookup in filters.items():
            if params.get(param):
                qs = qs.filter(**{lookup: params[param]})
        if self.action == "retrieve":
            qs = qs.prefetch_related("conversation__messages")
        return qs

    def get_serializer_class(self):
        return EvaluationDetailSerializer if self.action == "retrieve" else EvaluationListSerializer

    @action(detail=True, methods=["get"])
    def verdicts(self, request, pk=None):
        """Raw agent and arbiter outputs (debugging / transparency)."""
        return Response(AgentVerdictSerializer(self.get_object().verdicts.order_by("created_at"), many=True).data)
