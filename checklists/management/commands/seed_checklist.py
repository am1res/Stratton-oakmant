import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from checklists.models import Checklist
from checklists.serializers import ChecklistVersionSerializer
from checklists.services import create_version, get_or_create_checklist

DEFAULT_SEED = Path(__file__).resolve().parents[2] / "seed" / "freedom_broker_v1.json"


class Command(BaseCommand):
    help = "Load a checklist configuration (JSON) as a new version. Skips if the checklist already exists."

    def add_arguments(self, parser):
        parser.add_argument("path", nargs="?", default=str(DEFAULT_SEED))
        parser.add_argument("--force", action="store_true", help="Add a new version even if one exists")

    def handle(self, path, force, **options):
        seed = json.loads(Path(path).read_text(encoding="utf-8"))
        meta = seed["checklist"]
        if not force and Checklist.objects.filter(name=meta["name"], versions__isnull=False).exists():
            self.stdout.write(f"Checklist '{meta['name']}' already seeded; use --force to add a version.")
            return
        body = ChecklistVersionSerializer(data=seed["version"])
        if not body.is_valid():
            raise CommandError(f"Invalid checklist seed: {body.errors}")
        checklist = get_or_create_checklist(meta["name"], meta.get("description", ""))
        version = create_version(checklist, body.validated_data)
        self.stdout.write(self.style.SUCCESS(f"Created {version} with {version.criteria.count()} criteria"))
