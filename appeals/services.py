from django.db import transaction

from evaluations.models import CriterionResult, Status
from evaluations.services import scoring

from .models import Appeal, ReviewDecision

FRAGMENT_CONTEXT = 2  # messages shown around each piece of evidence


class AppealError(Exception):
    pass


def file_appeal(result, comment, author=""):
    if not comment.strip():
        raise AppealError("A comment is required.")
    if result.evaluation.status != Status.DONE:
        raise AppealError("Only finished evaluations can be appealed.")
    if result.appeals.filter(status=Appeal.Status.OPEN).exists():
        raise AppealError("This criterion already has an open appeal.")
    return Appeal.objects.create(criterion_result=result, comment=comment.strip(), author=author)


@transaction.atomic
def decide(appeal, decision, reason, new_value=None, reviewer=""):
    """Confirm or change the disputed value (reason mandatory) and recalculate the total."""
    appeal = Appeal.objects.select_for_update().select_related(
        "criterion_result__criterion", "criterion_result__evaluation__checklist_version"
    ).get(pk=appeal.pk)
    if appeal.status != Appeal.Status.OPEN:
        raise AppealError("This appeal is already resolved.")
    if not (reason or "").strip():
        raise AppealError("A reason is required.")

    result = appeal.criterion_result
    evaluation = result.evaluation
    previous_value, previous_total = result.final_value, evaluation.total_score
    if decision == ReviewDecision.Decision.CHANGE:
        new_value = str(new_value or "").strip().upper()
        allowed = result.criterion.allowed_values()
        if new_value not in allowed:
            raise AppealError(f"Value must be one of {allowed}.")
        if new_value == previous_value:
            raise AppealError("The new value equals the current one; confirm instead.")
        result.final_value = new_value
        result.source = CriterionResult.Source.REVIEW
        result.save(update_fields=["final_value", "source"])
    elif decision == ReviewDecision.Decision.CONFIRM:
        new_value = previous_value
    else:
        raise AppealError("Decision must be 'confirm' or 'change'.")

    summary = scoring.recalculate(evaluation)
    appeal.status = Appeal.Status.RESOLVED
    appeal.save(update_fields=["status"])
    return ReviewDecision.objects.create(
        appeal=appeal,
        decision=decision,
        previous_value=previous_value,
        new_value=new_value,
        reason=reason.strip(),
        reviewer=reviewer,
        previous_total=previous_total,
        new_total=summary.total,
    )


def dialogue_fragment(result):
    """The messages a reviewer needs: evidence (with neighbours) and the checked range."""
    wanted = set()
    for e in result.evidence:
        wanted.update(range(e["msg_idx"] - FRAGMENT_CONTEXT, e["msg_idx"] + FRAGMENT_CONTEXT + 1))
    if result.checked_range:
        lo, hi = result.checked_range
        wanted.update(range(lo, hi + 1))
    return result.evaluation.conversation.messages.filter(idx__in=wanted).order_by("idx")
