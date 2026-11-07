from django.db.models import Prefetch
from django.shortcuts import get_object_or_404
from rest_framework import status, viewsets
from rest_framework.decorators import action, api_view
from rest_framework.response import Response

from evaluations.models import CriterionResult, Evaluation

from . import services
from .models import Appeal
from .serializers import (
    AppealCreateSerializer,
    AppealDetailSerializer,
    AppealSerializer,
    DecisionCreateSerializer,
    ReviewDecisionSerializer,
)


def error(exc):
    return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)


class AppealViewSet(viewsets.ReadOnlyModelViewSet):
    """Reviewer queue: GET /api/appeals/?status=open"""

    def get_queryset(self):
        qs = Appeal.objects.select_related(
            "criterion_result__criterion", "criterion_result__evaluation__conversation", "decision"
        )
        params = self.request.query_params
        if params.get("status"):
            qs = qs.filter(status=params["status"])
        if params.get("evaluation"):
            qs = qs.filter(criterion_result__evaluation_id=params["evaluation"])
        return qs

    def get_serializer_class(self):
        return AppealDetailSerializer if self.action == "retrieve" else AppealSerializer

    @action(detail=True, methods=["post"])
    def decision(self, request, pk=None):
        body = DecisionCreateSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        try:
            decision = services.decide(self.get_object(), **body.validated_data)
        except services.AppealError as exc:
            return error(exc)
        return Response(ReviewDecisionSerializer(decision).data, status=status.HTTP_201_CREATED)


@api_view(["GET", "POST"])
def criterion_result_appeals(request, pk):
    """GET: appeals on one criterion result. POST {comment, author?}: dispute it."""
    result = get_object_or_404(CriterionResult.objects.select_related("evaluation"), pk=pk)
    if request.method == "GET":
        return Response(AppealSerializer(result.appeals.all(), many=True).data)
    body = AppealCreateSerializer(data=request.data)
    body.is_valid(raise_exception=True)
    try:
        appeal = services.file_appeal(result, **body.validated_data)
    except services.AppealError as exc:
        return error(exc)
    return Response(AppealDetailSerializer(appeal).data, status=status.HTTP_201_CREATED)


@api_view(["GET"])
def evaluation_audit(request, pk):
    """Original AI result, reviewer decisions, and the final result for one evaluation."""
    evaluation = get_object_or_404(
        Evaluation.objects.prefetch_related(
            Prefetch(
                "results",
                queryset=CriterionResult.objects.select_related("criterion").prefetch_related(
                    Prefetch("appeals", queryset=Appeal.objects.select_related("decision").order_by("created_at"))
                ),
            )
        ),
        pk=pk,
    )
    criteria = [
        {
            "criterion_result": r.id,
            "code": r.criterion.code,
            "title": r.criterion.title,
            "ai_value": r.ai_value,
            "final_value": r.final_value,
            "points": r.points,
            "source": r.source,
            "appeals": [
                {
                    "id": a.id,
                    "status": a.status,
                    "comment": a.comment,
                    "author": a.author,
                    "created_at": a.created_at,
                    "decision": ReviewDecisionSerializer(a.decision).data if hasattr(a, "decision") else None,
                }
                for a in r.appeals.all()
            ],
        }
        for r in evaluation.results.all()
    ]
    return Response(
        {
            "evaluation": evaluation.id,
            "ai_total_score": evaluation.ai_total_score,
            "total_score": evaluation.total_score,
            "critical_violation": evaluation.critical_violation,
            "changed": any(c["final_value"] != c["ai_value"] for c in criteria),
            "criteria": criteria,
        }
    )
