from rest_framework import serializers

from .models import Checklist, ChecklistVersion, Criterion, Section


class SectionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Section
        fields = ["id", "name", "order"]
        read_only_fields = ["id"]


class CriterionSerializer(serializers.ModelSerializer):
    # Sections are referenced by name; reading renders str(section), which is its name.
    section = serializers.CharField(allow_null=True, required=False, default=None)
    allowed_values = serializers.ListField(read_only=True)

    class Meta:
        model = Criterion
        fields = [
            "id", "code", "title", "rule_text", "answer_type", "allowed_steps", "scale_descriptions",
            "weight", "na_allowed", "na_condition", "order", "section", "allowed_values",
        ]
        read_only_fields = ["id"]
        extra_kwargs = {"order": {"required": False}}

    def validate(self, attrs):
        answer_type = attrs["answer_type"]
        steps = attrs.get("allowed_steps") or []
        if answer_type == Criterion.AnswerType.SCALE:
            if not steps or not all(isinstance(s, (int, float)) and s >= 0 for s in steps):
                raise serializers.ValidationError("Scale criteria need a non-empty list of non-negative steps.")
            if max(steps) <= 0:
                raise serializers.ValidationError("The top scale step must be greater than 0.")
            if len(set(steps)) != len(steps):
                raise serializers.ValidationError("Scale steps must be unique.")
        elif steps:
            raise serializers.ValidationError("allowed_steps only applies to scale criteria.")
        if answer_type == Criterion.AnswerType.FLAG:
            if attrs.get("weight", 0):
                raise serializers.ValidationError("Flag criteria carry no weight.")
            if attrs.get("na_allowed"):
                raise serializers.ValidationError("Flag criteria cannot be N/A.")
        elif attrs.get("weight", 0) <= 0:
            raise serializers.ValidationError("Scored criteria need a positive weight.")
        if attrs.get("na_allowed") and not attrs.get("na_condition", "").strip():
            raise serializers.ValidationError("Describe when N/A applies (na_condition).")
        return attrs


class ChecklistVersionSerializer(serializers.ModelSerializer):
    sections = SectionSerializer(many=True)
    criteria = CriterionSerializer(many=True)
    checklist_name = serializers.CharField(source="checklist.name", read_only=True)

    class Meta:
        model = ChecklistVersion
        fields = [
            "id", "checklist", "checklist_name", "version", "is_active", "comment", "rounding",
            "clarifications", "created_at", "sections", "criteria",
        ]
        read_only_fields = ["id", "checklist", "version", "is_active", "created_at"]

    def validate(self, attrs):
        criteria = attrs.get("criteria") or []
        if not criteria:
            raise serializers.ValidationError("A checklist needs at least one criterion.")
        codes = [c["code"] for c in criteria]
        if len(set(codes)) != len(codes):
            raise serializers.ValidationError("Criterion codes must be unique.")
        section_names = {s["name"] for s in attrs.get("sections") or []}
        unknown = {c["section"] for c in criteria if c.get("section")} - section_names
        if unknown:
            raise serializers.ValidationError(f"Unknown sections: {', '.join(sorted(unknown))}")
        if not any(c["answer_type"] != Criterion.AnswerType.FLAG for c in criteria):
            raise serializers.ValidationError("At least one criterion must carry weight.")
        return attrs


class ChecklistVersionSummarySerializer(serializers.ModelSerializer):
    criteria_count = serializers.IntegerField(source="criteria.count", read_only=True)

    class Meta:
        model = ChecklistVersion
        fields = ["id", "version", "is_active", "comment", "created_at", "criteria_count"]


class ChecklistSerializer(serializers.ModelSerializer):
    active_version = serializers.SerializerMethodField()

    class Meta:
        model = Checklist
        fields = ["id", "name", "description", "created_at", "active_version"]
        read_only_fields = ["id", "created_at"]

    def get_active_version(self, checklist):
        version = checklist.active_version
        return version and ChecklistVersionSummarySerializer(version).data
