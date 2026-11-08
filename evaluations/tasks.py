from celery import shared_task

from .services import pipeline


@shared_task(acks_late=True)
def evaluate_conversation(evaluation_id):
    pipeline.evaluate(evaluation_id)
