from django.core.management.base import BaseCommand, CommandError

from checklists.models import ChecklistVersion
from evaluations.services import pipeline
from evaluations.services.runs import start_run
from ingestion.models import Conversation, Dataset


class Command(BaseCommand):
    help = "Evaluate a dataset (or selected conversations) synchronously, in this process."

    def add_arguments(self, parser):
        parser.add_argument("group_id")
        parser.add_argument("--checklist-version", type=int, help="ChecklistVersion id (default: the active one)")
        parser.add_argument("--conversation", action="append", default=[], help="conversation_id; repeatable")
        parser.add_argument("--force", action="store_true", help="Re-evaluate conversations already done")

    def handle(self, group_id, conversation, force, **options):
        try:
            dataset = Dataset.objects.get(group_id=group_id)
        except Dataset.DoesNotExist:
            raise CommandError(f"Dataset {group_id} not imported")
        version_id = options["checklist_version"]
        checklist_version = (
            ChecklistVersion.objects.get(pk=version_id)
            if version_id
            else ChecklistVersion.objects.filter(is_active=True).first()
        )
        if checklist_version is None:
            raise CommandError("No active checklist version; run seed_checklist first")
        conversations = Conversation.objects.filter(dataset=dataset)
        if conversation:
            conversations = conversations.filter(conversation_id__in=conversation)

        run = start_run(checklist_version, conversations, dataset=dataset, force=force, background=False)
        for ev in run.evaluations.select_related("conversation"):
            ev = pipeline.evaluate(ev.id)
            self.stdout.write(f"{ev.conversation.conversation_id}: {ev.status} total={ev.total_score} "
                              f"critical={ev.critical_violation} arbiter={ev.arbiter_used} {ev.error[:200]}")
        self.stdout.write(self.style.SUCCESS(f"Run {run.id}: {run.progress()}"))
