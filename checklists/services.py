from django.db import transaction
from django.db.models import Max

from .models import Checklist, ChecklistVersion, Criterion, Section


@transaction.atomic
def create_version(checklist, data, activate=True):
    """Create the next version of `checklist` from validated serializer data.

    `data` = {comment, rounding, clarifications, sections: [{name, order}],
              criteria: [{..., section: <section name or None>}]}
    """
    last = checklist.versions.aggregate(n=Max("version"))["n"] or 0
    version = ChecklistVersion.objects.create(
        checklist=checklist,
        version=last + 1,
        comment=data.get("comment", ""),
        rounding=data.get("rounding", 2),
        clarifications=data.get("clarifications", ""),
    )
    sections = {
        s["name"]: Section.objects.create(version=version, name=s["name"], order=s.get("order", i))
        for i, s in enumerate(data.get("sections", []))
    }
    for i, c in enumerate(data["criteria"]):
        fields = {k: v for k, v in c.items() if k != "section"}
        fields.setdefault("order", i)
        Criterion.objects.create(version=version, section=sections.get(c.get("section")), **fields)
    if activate:
        activate_version(version)
    return version


@transaction.atomic
def activate_version(version):
    version.checklist.versions.exclude(pk=version.pk).update(is_active=False)
    if not version.is_active:
        version.is_active = True
        version.save(update_fields=["is_active"])
    return version


def get_or_create_checklist(name, description=""):
    checklist, _ = Checklist.objects.get_or_create(name=name, defaults={"description": description})
    return checklist
