from django.db import models


class Dataset(models.Model):
    """One import of the organizers' API for a given group_id (DEV, control set, ...)."""

    group_id = models.CharField(max_length=100, unique=True)
    total_records = models.PositiveIntegerField(default=0)
    raw_response = models.JSONField(default=dict, blank=True)
    fetched_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.group_id


class Conversation(models.Model):
    class Channel(models.TextChoices):
        CHAT = "agent chat", "Agent chat"
        CALL = "voice call", "Voice call"

    dataset = models.ForeignKey(Dataset, on_delete=models.CASCADE, related_name="conversations")
    conversation_id = models.CharField(max_length=100)
    channel = models.CharField(max_length=20, choices=Channel.choices)
    language = models.CharField(max_length=5)
    audio_url = models.URLField(max_length=1000, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("dataset", "conversation_id")]
        ordering = ["conversation_id"]

    def __str__(self):
        return self.conversation_id


class Message(models.Model):
    """A transcript line. `idx` is the stable anchor that evidence references point to."""

    class Speaker(models.TextChoices):
        CLIENT = "client"
        OPERATOR = "operator"
        BOT = "bot"
        SYSTEM = "system"

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="messages")
    idx = models.PositiveIntegerField()
    speaker = models.CharField(max_length=10, choices=Speaker.choices)
    timestamp_raw = models.CharField(max_length=64, blank=True)
    # Seconds from the first message; lets the UI seek the call recording.
    offset_sec = models.FloatField(null=True, blank=True)
    text = models.TextField(blank=True)

    class Meta:
        unique_together = [("conversation", "idx")]
        ordering = ["idx"]

    @property
    def is_evaluable(self):
        """Only operator messages are judged; bot and system lines are context."""
        return self.speaker == self.Speaker.OPERATOR

    def __str__(self):
        return f"{self.conversation_id}#{self.idx}"
