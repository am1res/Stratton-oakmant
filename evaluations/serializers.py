from rest_framework import serializers

from checklists.models import ChecklistVersion
from ingestion.models import Conversation, Dataset

from .models import AgentVerdict, CriterionResult, Evaluation, EvaluationRun


def message_ref(message):
    """What the UI needs to scroll to a message or seek the recording."""
    return {
        "idx": message.idx,
        "speaker": message.speaker,
        "timestamp_raw": message.timestamp_raw,
        "offset_sec": message.offset_sec,
        "text": message.text,
    }


class RunCreateSerializer(serializers.Serializer):
    checklist_version = serializers.PrimaryKeyRelatedField(
        queryset=ChecklistVersion.objects.all(), required=False,
        help_text="Defaults to the active version",
    )
    dataset = serializers.SlugRelatedField(
        slug_field="group_id", queryset=Dataset.objects.all(), required=False,
        help_text="group_id of an imported dataset",
    )
    conversations = serializers.PrimaryKeyRelatedField(
        queryset=Conversation.objects.all(), many=True, required=False
    )
    force = serializers.BooleanField(default=False)

    def validate(self, attrs):
        if not attrs.get("dataset") and not attrs.get("conversations"):
            raise serializers.ValidationError("Provide `dataset` or `conversations`.")
        if "checklist_version" not in attrs:
            version = ChecklistVersion.objects.filter(is_active=True).order_by("-created_at").first()
            if version is None:
                raise serializers.ValidationError("No active checklist version.")
            attrs["checklist_version"] = version
        return attrs


class RunSerializer(serializers.ModelSerializer):
    progress = serializers.SerializerMethodField()
    dataset = serializers.CharField(source="dataset.group_id", default=None)

    class Meta:
        model = EvaluationRun
        fields = ["id", "checklist_version", "dataset", "created_at", "finished_at", "progress"]

    def get_progress(self, run):
        return run.progress()


class CriterionResultSerializer(serializers.ModelSerializer):
    code = serializers.CharField(source="criterion.code")
    title = serializers.CharField(source="criterion.title")
    answer_type = serializers.CharField(source="criterion.answer_type")
    weight = serializers.FloatField(source="criterion.weight")
    section = serializers.CharField(source="criterion.section", default=None)
    allowed_values = serializers.ListField(source="criterion.allowed_values")
    effective_weight = serializers.SerializerMethodField()
    evidence = serializers.SerializerMethodField()
    checked_range = serializers.SerializerMethodField()

    class Meta:
        model = CriterionResult
        fields = [
            "id", "code", "title", "answer_type", "section", "weight", "effective_weight", "allowed_values",
            "final_value", "points", "ai_value", "value_a", "value_b", "value_arbiter", "agreement", "source",
            "explanation", "arbiter_reason", "na_reason", "evidence", "checked_range",
        ]

    def get_effective_weight(self, result):
        """Weight after redistributing N/A criteria, as a share of 100."""
        applicable = self.context.get("applicable_weight")
        if result.points is None or not applicable:
            return None
        return round(result.criterion.weight / applicable * 100, 2)

    def get_evidence(self, result):
        messages = self.context.get("messages", {})
        return [
            {**e, "message": message_ref(messages[e["msg_idx"]]) if e["msg_idx"] in messages else None}
            for e in result.evidence
        ]

    def get_checked_range(self, result):
        if not result.checked_range:
            return None
        messages = self.context.get("messages", {})
        lo, hi = result.checked_range
        return {
            "from_idx": lo,
            "to_idx": hi,
            "from": message_ref(messages[lo]) if lo in messages else None,
            "to": message_ref(messages[hi]) if hi in messages else None,
        }


class AgentVerdictSerializer(serializers.ModelSerializer):
    class Meta:
        model = AgentVerdict
        fields = ["role", "model_name", "prompt_hash", "latency_ms", "usage", "error", "raw_output", "created_at"]


class EvaluationListSerializer(serializers.ModelSerializer):
    conversation_id = serializers.CharField(source="conversation.conversation_id")

    class Meta:
        model = Evaluation
        fields = [
            "id", "run", "conversation", "conversation_id", "checklist_version", "status", "error",
            "ai_total_score", "total_score", "section_scores", "critical_violation", "arbiter_used",
            "created_at", "finished_at",
        ]


class EvaluationDetailSerializer(EvaluationListSerializer):
    channel = serializers.CharField(source="conversation.channel")
    language = serializers.CharField(source="conversation.language")
    audio_url = serializers.CharField(source="conversation.audio_url")
    results = serializers.SerializerMethodField()

    class Meta(EvaluationListSerializer.Meta):
        fields = EvaluationListSerializer.Meta.fields + ["channel", "language", "audio_url", "results"]

    def get_results(self, evaluation):
        results = list(evaluation.results.select_related("criterion__section"))
        context = {
            "messages": {m.idx: m for m in evaluation.conversation.messages.all()},
            "applicable_weight": sum(
                r.criterion.weight for r in results if r.points is not None and r.criterion.weight > 0
            ),
        }
        return CriterionResultSerializer(results, many=True, context=context).data
