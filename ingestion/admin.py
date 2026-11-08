from django.contrib import admin

from .models import Conversation, Dataset, Message


class MessageInline(admin.TabularInline):
    model = Message
    extra = 0


@admin.register(Dataset)
class DatasetAdmin(admin.ModelAdmin):
    list_display = ["group_id", "total_records", "fetched_at"]


@admin.register(Conversation)
class ConversationAdmin(admin.ModelAdmin):
    list_display = ["conversation_id", "dataset", "channel", "language"]
    list_filter = ["dataset", "channel", "language"]
    search_fields = ["conversation_id"]
    inlines = [MessageInline]
