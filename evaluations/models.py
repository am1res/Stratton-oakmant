from django.db import models

from checklists.models import ChecklistVersion, Criterion
from ingestion.models import Conversation, Dataset


class Status(models.TextChoices):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class EvaluationRun(models.Model):
    """A batch: one checklist version applied to a set of conversations."""

    checklist_version = models.ForeignKey(ChecklistVersion, on_delete=models.PROTECT, related_name="runs")
    dataset = models.ForeignKey(Dataset, on_delete=models.SET_NULL, null=True, blank=True, related_name="runs")
    skipped = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def progress(self):
        counts = dict(self.evaluations.values_list("status").annotate(n=models.Count("id")))
        total = sum(counts.values())
        finished = counts.get(Status.DONE, 0) + counts.get(Status.FAILED, 0)
        return {
            "total": total,
            "pending": counts.get(Status.PENDING, 0),
            "running": counts.get(Status.RUNNING, 0),
            "done": counts.get(Status.DONE, 0),
            "failed": counts.get(Status.FAILED, 0),
            "skipped": self.skipped,
            "status": Status.DONE if finished == total else Status.RUNNING,
        }


class Evaluation(models.Model):
    run = models.ForeignKey(EvaluationRun, on_delete=models.SET_NULL, null=True, blank=True, related_name="evaluations")
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="evaluations")
    checklist_version = models.ForeignKey(ChecklistVersion, on_delete=models.PROTECT, related_name="evaluations")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    error = models.TextField(blank=True)
    # Score as produced by the agents, kept for the audit trail.
    ai_total_score = models.FloatField(null=True, blank=True)
    # Current score after reviewer decisions; None = "not calculated".
    total_score = models.FloatField(null=True, blank=True)
    section_scores = models.JSONField(default=dict, blank=True)
    critical_violation = models.BooleanField(null=True)
    arbiter_used = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["conversation", "checklist_version", "status"])]


class AgentVerdict(models.Model):
    """Raw output of one LLM call, for reproducibility and debugging."""

    class Role(models.TextChoices):
        AGENT_A = "A"
        AGENT_B = "B"
        ARBITER = "ARBITER"

    evaluation = models.ForeignKey(Evaluation, on_delete=models.CASCADE, related_name="verdicts")
    role = models.CharField(max_length=10, choices=Role.choices)
    model_name = models.CharField(max_length=100)
    prompt_hash = models.CharField(max_length=64)
    raw_output = models.JSONField(default=dict)
    error = models.TextField(blank=True)
    latency_ms = models.PositiveIntegerField(default=0)
    usage = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)


class CriterionResult(models.Model):
    class Agreement(models.TextChoices):
        AGREED = "agreed"
        ARBITRATED = "arbitrated"
        SINGLE = "single_agent"

    class Source(models.TextChoices):
        AI = "ai"
        REVIEW = "review"

    evaluation = models.ForeignKey(Evaluation, on_delete=models.CASCADE, related_name="results")
    criterion = models.ForeignKey(Criterion, on_delete=models.PROTECT, related_name="results")
    value_a = models.CharField(max_length=20, blank=True)
    value_b = models.CharField(max_length=20, blank=True)
    value_arbiter = models.CharField(max_length=20, blank=True)
    ai_value = models.CharField(max_length=20)
    final_value = models.CharField(max_length=20)
    points = models.FloatField(null=True, blank=True)
    explanation = models.TextField(blank=True)
    arbiter_reason = models.TextField(blank=True)
    na_reason = models.TextField(blank=True)
    # [{"msg_idx": 7, "proves": "..."}]
    evidence = models.JSONField(default=list, blank=True)
    # [from_idx, to_idx] of the part checked for a missing action, or None.
    checked_range = models.JSONField(null=True, blank=True)
    agreement = models.CharField(max_length=20, choices=Agreement.choices)
    source = models.CharField(max_length=10, choices=Source.choices, default=Source.AI)

    class Meta:
        unique_together = [("evaluation", "criterion")]
        ordering = ["criterion__order", "criterion_id"]
