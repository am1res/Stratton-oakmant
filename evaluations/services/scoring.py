"""Deterministic scoring. LLMs only choose values; every number is computed here.

Rules (from the checklist): YES = full weight, NO = 0; scale points = step / max_step * weight;
N/A criteria drop out of numerator and denominator; total = earned / applicable weight * 100,
rounded; flag criteria carry no points and are reported separately.
"""
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from checklists.models import NA, YES, Criterion
from evaluations.models import CriterionResult


@dataclass(frozen=True)
class CriterionSpec:
    code: str
    answer_type: str
    weight: float
    allowed_steps: tuple = ()
    section: str | None = None

    @classmethod
    def from_model(cls, criterion):
        return cls(
            code=criterion.code,
            answer_type=criterion.answer_type,
            weight=float(criterion.weight),
            allowed_steps=tuple(float(s) for s in criterion.allowed_steps or ()),
            section=criterion.section.name if criterion.section_id else None,
        )


@dataclass
class ScoreSummary:
    points: dict  # code -> points (None for N/A and flags)
    total: float | None
    sections: dict  # section name -> score | None
    critical_violation: bool


def round_half_up(value, digits):
    return float(Decimal(str(value)).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def criterion_points(spec, value):
    if spec.answer_type == Criterion.AnswerType.FLAG or value == NA:
        return None
    if spec.answer_type == Criterion.AnswerType.BINARY:
        return spec.weight if value == YES else 0.0
    step = float(value)
    top = max(spec.allowed_steps)
    return step / top * spec.weight


def weighted_total(items, digits):
    """items: [(spec, points)] for applicable weighted criteria."""
    weight = sum(spec.weight for spec, _ in items)
    if weight <= 0:
        return None
    return round_half_up(sum(points for _, points in items) / weight * 100, digits)


def compute(pairs, rounding=2):
    """pairs: iterable of (CriterionSpec, value string)."""
    points, applicable, critical = {}, [], False
    for spec, value in pairs:
        p = criterion_points(spec, value)
        points[spec.code] = p
        if spec.answer_type == Criterion.AnswerType.FLAG:
            critical = critical or value == YES
        elif p is not None and spec.weight > 0:
            applicable.append((spec, p))

    sections = {}
    for name in dict.fromkeys(spec.section for spec, _ in applicable if spec.section):
        sections[name] = weighted_total([(s, p) for s, p in applicable if s.section == name], rounding)

    return ScoreSummary(
        points={code: (None if p is None else round_half_up(p, 4)) for code, p in points.items()},
        total=weighted_total(applicable, rounding),
        sections=sections,
        critical_violation=critical,
    )


def recalculate(evaluation, *, ai=False):
    """Recompute and persist scores for an evaluation from its criterion results.

    ai=True scores the original AI values (used once, when the pipeline finishes).
    """
    results = list(evaluation.results.select_related("criterion__section"))
    summary = compute(
        ((CriterionSpec.from_model(r.criterion), r.ai_value if ai else r.final_value) for r in results),
        rounding=evaluation.checklist_version.rounding,
    )
    for r in results:
        r.points = summary.points[r.criterion.code]
    CriterionResult.objects.bulk_update(results, ["points"])
    evaluation.total_score = summary.total
    evaluation.section_scores = summary.sections
    evaluation.critical_violation = summary.critical_violation
    fields = ["total_score", "section_scores", "critical_violation"]
    if ai:
        evaluation.ai_total_score = summary.total
        fields.append("ai_total_score")
    evaluation.save(update_fields=fields)
    return summary
