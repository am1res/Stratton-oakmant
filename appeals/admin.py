from django.contrib import admin

from .models import Appeal, ReviewDecision


class ReviewDecisionInline(admin.StackedInline):
    model = ReviewDecision
    extra = 0


@admin.register(Appeal)
class AppealAdmin(admin.ModelAdmin):
    list_display = ["id", "criterion_result", "status", "author", "created_at"]
    list_filter = ["status"]
    inlines = [ReviewDecisionInline]
