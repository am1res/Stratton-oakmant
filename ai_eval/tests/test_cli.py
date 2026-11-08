import json
import os
import subprocess
import sys

from helpers import FIXTURES, SRC


def _env(mode: str | None = "mock") -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("AI_EVAL_")}
    inherited = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join(part for part in (str(SRC), inherited) if part)
    if mode is not None:
        env["AI_EVAL_MODE"] = mode
    return env


def test_cli_writes_mock_json(tmp_path) -> None:
    output = tmp_path / "nested" / "ru.json"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "ai_eval",
            "--conversation",
            str(FIXTURES / "conversations" / "ru.json"),
            "--checklist",
            str(FIXTURES / "checklists" / "demo.json"),
            "--output",
            str(output),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=_env(),
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(output.read_text(encoding="utf-8"))
    # Two mock judges disagree by design, so the mock CLI shows the dispute path.
    assert payload["status"] == "partial"
    assert payload["conversation_id"] == "demo-ru-001"
    assert payload["checklist_version_id"] == "demo-not-official-v1"
    assert len(payload["disputed_criterion_ids"]) == 4
    assert len(payload["judge_runs"]) == 3
    assert len(payload["criterion_results"]) == 4
    assert "disputed=" in completed.stdout
    assert "judge_b: mock/mock-b" in completed.stdout
    assert "adjudicator: mock/mock-adjudicator" in completed.stdout
    assert "score" not in payload
    assert "Здравствуйте, где посмотреть тариф?" not in output.read_text(encoding="utf-8")


def test_cli_live_mode_writes_nothing(tmp_path) -> None:
    output = tmp_path / "should-not-exist.json"
    env_file = tmp_path / "secret.env"
    env_file.write_text("AI_EVAL_JUDGE_A_API_KEY=sk-cli-secret\n", encoding="utf-8")
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "ai_eval",
            "--conversation",
            str(FIXTURES / "conversations" / "en.json"),
            "--checklist",
            str(FIXTURES / "checklists" / "demo.json"),
            "--output",
            str(output),
            "--env-file",
            str(env_file),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=_env(mode=None) | {"AI_EVAL_MODE": "live"},
    )
    assert completed.returncode == 2
    assert not output.exists()
    assert "live mode is not configured" in completed.stderr
    assert "sk-cli-secret" not in completed.stderr
    assert "sk-cli-secret" not in completed.stdout
