"""Conversation-quality evaluation.

Stage 1 exposes the contracts, validators, and a mock judge.
"""

from ai_eval.pipeline import evaluate_conversation, evaluate_single_judge

__all__ = ["evaluate_conversation", "evaluate_single_judge"]
