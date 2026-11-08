from django.contrib import admin

from .models import Checklist, ChecklistVersion, Criterion, Section


class CriterionInline(admin.StackedInline):
    model = Criterion
    extra = 0


class SectionInline(admin.TabularInline):
    model = Section
    extra = 0


@admin.register(Checklist)
class ChecklistAdmin(admin.ModelAdmin):
    list_display = ["name", "created_at"]


@admin.register(ChecklistVersion)
class ChecklistVersionAdmin(admin.ModelAdmin):
    list_display = ["checklist", "version", "is_active", "created_at"]
    inlines = [SectionInline, CriterionInline]
