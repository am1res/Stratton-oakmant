from rest_framework import serializers

from .models import Conversation, Dataset, Message


class DatasetSerializer(serializers.ModelSerializer):
    conversation_count = serializers.IntegerField(source="conversations.count", read_only=True)

    class Meta:
        model = Dataset
        fields = ["id", "group_id", "total_records", "conversation_count", "fetched_at"]


class ImportRequestSerializer(serializers.Serializer):
    group_id = serializers.CharField(max_length=100)


class UploadRequestSerializer(serializers.Serializer):
    group_id = serializers.CharField(max_length=100)
    payload = serializers.JSONField(help_text="API response, its `data` object, or a list of records")


class MessageSerializer(serializers.ModelSerializer):
    is_evaluable = serializers.BooleanField(read_only=True)

    class Meta:
        model = Message
        fields = ["idx", "speaker", "timestamp_raw", "offset_sec", "text", "is_evaluable"]


class LatestEvaluationMixin(serializers.Serializer):
    latest_evaluation = serializers.SerializerMethodField()

    def get_latest_evaluation(self, conversation):
        # Relies on the view prefetching evaluations ordered newest first.
        evaluations = list(conversation.evaluations.all())
        if not evaluations:
            return None
        ev = evaluations[0]
        return {
            "id": ev.id,
            "status": ev.status,
            "checklist_version": ev.checklist_version_id,
            "total_score": ev.total_score,
            "critical_violation": ev.critical_violation,
        }


class ConversationListSerializer(LatestEvaluationMixin, serializers.ModelSerializer):
    dataset = serializers.CharField(source="dataset.group_id")

    class Meta:
        model = Conversation
        fields = ["id", "conversation_id", "dataset", "channel", "language", "audio_url", "latest_evaluation"]


class ConversationDetailSerializer(ConversationListSerializer):
    messages = MessageSerializer(many=True, read_only=True)

    class Meta(ConversationListSerializer.Meta):
        fields = ConversationListSerializer.Meta.fields + ["messages"]
