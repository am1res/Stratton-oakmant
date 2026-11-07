from django.db import models

from evaluations.models import CriterionResult


class Appeal(models.Model):
    class Status(models.TextChoices):
        OPEN = "open"
        RESOLVED = "resolved"

    criterion_result = models.ForeignKey(CriterionResult, on_delete=models.CASCADE, related_name="appeals")
    comment = models.TextField()
    author = models.CharField(max_length=200, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.OPEN)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["criterion_result"],
                condition=models.Q(status="open"),
                name="one_open_appeal_per_criterion_result",
            )
        ]


class ReviewDecision(models.Model):
    class Decision(models.TextChoices):
        CONFIRM = "confirm"
        CHANGE = "change"

    appeal = models.OneToOneField(Appeal, on_delete=models.CASCADE, related_name="decision")
    decision = models.CharField(max_length=10, choices=Decision.choices)
    previous_value = models.CharField(max_length=20)
    new_value = models.CharField(max_length=20)
    reason = models.TextField()
    reviewer = models.CharField(max_length=200, blank=True)
    # Totals before/after this decision, so the card can show what the decision changed.
    previous_total = models.FloatField(null=True, blank=True)
    new_total = models.FloatField(null=True, blank=True)
    decided_at = models.DateTimeField(auto_now_add=True)
