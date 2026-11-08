"""Create evaluation runs and dispatch them to the configured executor."""
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from functools import lru_cache

from django.conf import settings
from django.db import close_old_connections, transaction
from django.db.models import Q
from django.utils import timezone

from evaluations.models import Evaluation, EvaluationRun, Status

from . import pipeline

logger = logging.getLogger("cqa.runs")

STALE_AFTER = timedelta(minutes=15)


def start_run(version, conversations, dataset=None, force=False, background=True):
    """Queue an evaluation for every conversation; skip ones already done under `version`.

    background=False only creates the evaluations; the caller runs them.
    """
    conversations = list(conversations)
    with transaction.atomic():
        run = EvaluationRun.objects.create(checklist_version=version, dataset=dataset)
        done = set()
        if not force:
            done = set(
                Evaluation.objects.filter(
                    checklist_version=version, status=Status.DONE, conversation__in=conversations
                ).values_list("conversation_id", flat=True)
            )
        Evaluation.objects.bulk_create(
            Evaluation(run=run, conversation=c, checklist_version=version)
            for c in conversations
            if c.pk not in done
        )
        run.skipped = len(done)
        run.save(update_fields=["skipped"])
        ids = list(run.evaluations.values_list("id", flat=True))
        if not ids:
            run.finished_at = timezone.now()
            run.save(update_fields=["finished_at"])
        if background:
            transaction.on_commit(lambda: dispatch(ids))
    return run


def retry(run):
    """Re-queue failed, never-started, and stuck evaluations of a run."""
    stale = Q(status=Status.RUNNING, started_at__lt=timezone.now() - STALE_AFTER)
    qs = run.evaluations.filter(Q(status__in=[Status.PENDING, Status.FAILED]) | stale)
    ids = list(qs.values_list("id", flat=True))
    qs.update(status=Status.PENDING, error="")
    if ids:
        EvaluationRun.objects.filter(pk=run.pk).update(finished_at=None)
        dispatch(ids)
    return ids


def dispatch(evaluation_ids):
    if not evaluation_ids:
        return
    if settings.CQA_EXECUTOR == "celery":
        from celery import group

        from evaluations.tasks import evaluate_conversation

        group(evaluate_conversation.s(i) for i in evaluation_ids).apply_async()
    else:
        for i in evaluation_ids:
            _pool().submit(_evaluate_in_thread, i)
    logger.info("Dispatched %d evaluations via %s", len(evaluation_ids), settings.CQA_EXECUTOR)


@lru_cache(maxsize=1)
def _pool():
    return ThreadPoolExecutor(max_workers=settings.CQA_MAX_CONCURRENCY, thread_name_prefix="cqa-eval")


def _evaluate_in_thread(evaluation_id):
    close_old_connections()
    try:
        pipeline.evaluate(evaluation_id)
    except Exception:
        logger.exception("Evaluation %s crashed", evaluation_id)
    finally:
        close_old_connections()
