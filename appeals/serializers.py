from rest_framework import serializers

from evaluations.serializers import message_ref

from .models import Appeal, ReviewDecision
from .services import dialogue_fragment


class AppealCreateSerializer(serializers.Serializer):
    comment = serializers.CharField()
    author = serializers.CharField(required=False, allow_blank=True, default="")


class DecisionCreateSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=ReviewDecision.Decision.choices)
    reason = serializers.CharField()
    new_value = serializers.CharField(required=False, allow_blank=True, default="")
    reviewer = serializers.CharField(required=False, allow_blank=True, default="")


class ReviewDecisionSerializer(serializers.ModelSerializer):
    class Meta:
        model = ReviewDecision
        fields = [
            "decision", "previous_value", "new_value", "reason", "reviewer",
            "previous_total", "new_total", "decided_at",
        ]


class AppealSerializer(serializers.ModelSerializer):
    evaluation = serializers.IntegerField(source="criterion_result.evaluation_id")
    conversation_id = serializers.CharField(source="criterion_result.evaluation.conversation.conversation_id")
    criterion = serializers.SerializerMethodField()
    decision = ReviewDecisionSerializer(read_only=True, default=None)

    class Meta:
        model = Appeal
        fields = [
            "id", "status", "comment", "author", "created_at",
            "criterion_result", "evaluation", "conversation_id", "criterion", "decision",
        ]

    def get_criterion(self, appeal):
        r = appeal.criterion_result
        return {
            "code": r.criterion.code,
            "title": r.criterion.title,
            "rule_text": r.criterion.rule_text,
            "allowed_values": r.criterion.allowed_values(),
            "disputed_value": r.final_value,
            "ai_value": r.ai_value,
            "points": r.points,
            "explanation": r.explanation,
            "arbiter_reason": r.arbiter_reason,
            "na_reason": r.na_reason,
            "evidence": r.evidence,
            "checked_range": r.checked_range,
        }


class AppealDetailSerializer(AppealSerializer):
    fragment = serializers.SerializerMethodField()

    class Meta(AppealSerializer.Meta):
        fields = AppealSerializer.Meta.fields + ["fragment"]

    def get_fragment(self, appeal):
        return [message_ref(m) for m in dialogue_fragment(appeal.criterion_result)]
