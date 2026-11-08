import os

import pytest


@pytest.fixture(autouse=True)
def clear_ai_eval_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.startswith("AI_EVAL_"):
            monkeypatch.delenv(name, raising=False)
