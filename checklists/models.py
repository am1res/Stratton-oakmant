from django.db import models

NA = "N/A"
YES = "YES"
NO = "NO"


def format_step(step):
    """Render a scale step the way agents and the API exchange it: 7 -> "7", 7.5 -> "7.5"."""
    return str(int(step)) if float(step).is_integer() else str(step)


class Checklist(models.Model):
    name = models.CharField(max_length=200, unique=True)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

    @property
    def active_version(self):
        return self.versions.filter(is_active=True).first()


class ChecklistVersion(models.Model):
    """An immutable snapshot of a checklist. Editing a checklist creates a new version."""

    checklist = models.ForeignKey(Checklist, on_delete=models.CASCADE, related_name="versions")
    version = models.PositiveIntegerField()
    is_active = models.BooleanField(default=False)
    comment = models.TextField(blank=True)
    rounding = models.PositiveSmallIntegerField(default=2)
    # Free-text rules shared by all criteria (NO vs N/A, out-of-scope items, ...), added to the prompt.
    clarifications = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("checklist", "version")]
        ordering = ["checklist", "-version"]

    def __str__(self):
        return f"{self.checklist.name} v{self.version}"


class Section(models.Model):
    version = models.ForeignKey(ChecklistVersion, on_delete=models.CASCADE, related_name="sections")
    name = models.CharField(max_length=200)
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self):
        return self.name


class Criterion(models.Model):
    class AnswerType(models.TextChoices):
        BINARY = "binary", "YES / NO"
        SCALE = "scale", "Numeric scale"
        FLAG = "flag", "Flag only (no points)"

    version = models.ForeignKey(ChecklistVersion, on_delete=models.CASCADE, related_name="criteria")
    section = models.ForeignKey(Section, on_delete=models.SET_NULL, null=True, blank=True, related_name="criteria")
    code = models.CharField(max_length=20)
    title = models.CharField(max_length=200)
    rule_text = models.TextField()
    answer_type = models.CharField(max_length=10, choices=AnswerType.choices)
    allowed_steps = models.JSONField(default=list, blank=True)
    # {"20": "All essential questions are resolved...", ...}
    scale_descriptions = models.JSONField(default=dict, blank=True)
    weight = models.FloatField(default=0)
    na_allowed = models.BooleanField(default=False)
    na_condition = models.TextField(blank=True)
    order = models.PositiveIntegerField(default=0)

    class Meta:
        unique_together = [("version", "code")]
        ordering = ["order", "id"]

    def __str__(self):
        return f"{self.code} {self.title}"

    @property
    def is_flag(self):
        return self.answer_type == self.AnswerType.FLAG

    def allowed_values(self):
        if self.answer_type == self.AnswerType.SCALE:
            values = [format_step(s) for s in sorted(self.allowed_steps, reverse=True)]
        else:
            values = [YES, NO]
        if self.na_allowed:
            values.append(NA)
        return values
