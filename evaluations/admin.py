from django.contrib import admin

from .models import AgentVerdict, CriterionResult, Evaluation, EvaluationRun


class CriterionResultInline(admin.TabularInline):
    model = CriterionResult
    extra = 0
    fields = ["criterion", "value_a", "value_b", "value_arbiter", "final_value", "points", "agreement", "source"]
    readonly_fields = fields


class AgentVerdictInline(admin.TabularInline):
    model = AgentVerdict
    extra = 0
    fields = ["role", "model_name", "latency_ms", "error"]
    readonly_fields = fields


@admin.register(EvaluationRun)
class EvaluationRunAdmin(admin.ModelAdmin):
    list_display = ["id", "checklist_version", "dataset", "created_at", "finished_at"]


@admin.register(Evaluation)
class EvaluationAdmin(admin.ModelAdmin):
    list_display = ["id", "conversation", "checklist_version", "status", "total_score", "critical_violation"]
    list_filter = ["status", "checklist_version", "critical_violation"]
    inlines = [CriterionResultInline, AgentVerdictInline]
