import pytest

from ai_eval.config import apply_price_estimate, live_config_problems, load_config, load_env_file
from ai_eval.errors import ConfigurationError
from ai_eval.models import JudgeRole, UsageMetadata


def _live_environ() -> dict[str, str]:
    return {
        "AI_EVAL_MODE": "live",
        "AI_EVAL_JUDGE_A_BASE_URL": "https://llm.internal.example.net/v1",
        "AI_EVAL_JUDGE_A_API_KEY_ENV": "AI_EVAL_JUDGE_A_API_KEY",
        "AI_EVAL_JUDGE_A_API_KEY": "sk-test-not-real",
        "AI_EVAL_JUDGE_A_MODEL": "vendor/model-id",
        "AI_EVAL_JUDGE_A_RESPONSE_FORMAT": "json_schema",
        "AI_EVAL_JUDGE_A_TIMEOUT_SECONDS": "30",
        "AI_EVAL_JUDGE_A_MAX_OUTPUT_TOKENS": "800",
    }


def test_unset_mode_is_mock_and_generation_settings_stay_unset() -> None:
    config = load_config({})
    assert config.mode == "mock"
    role = config.roles[JudgeRole.judge_a]
    assert role.model is None
    assert role.base_url is None
    assert role.temperature is None
    assert role.reasoning_effort is None
    assert role.response_format is None
    assert config.price_input_per_million is None


def test_live_problems_are_actionable_and_omit_the_secret() -> None:
    environ = _live_environ()
    environ["AI_EVAL_JUDGE_A_API_KEY"] = "sk-PASTE-secret-value"
    environ["AI_EVAL_JUDGE_A_MODEL"] = ""
    config = load_config(environ)
    problems = live_config_problems(config, JudgeRole.judge_a, environ)
    text = "\n".join(problems)
    assert "model id is not set" in text
    assert "still a placeholder" in text
    assert "sk-PASTE-secret-value" not in text


def test_complete_live_settings_have_no_problems() -> None:
    environ = _live_environ()
    config = load_config(environ)
    assert live_config_problems(config, JudgeRole.judge_a, environ) == []


def test_placeholder_url_and_bad_numbers_are_configuration_errors() -> None:
    environ = _live_environ()
    environ["AI_EVAL_JUDGE_A_BASE_URL"] = "https://example.com/v1"
    problems = live_config_problems(load_config(environ), JudgeRole.judge_a, environ)
    assert any("placeholder" in problem for problem in problems)

    environ = _live_environ()
    environ["AI_EVAL_MODE"] = "mock"
    environ["AI_EVAL_JUDGE_A_TEMPERATURE"] = "low"
    with pytest.raises(ConfigurationError, match="TEMPERATURE"):
        load_config(environ)

    environ = _live_environ()
    environ["AI_EVAL_PRICE_INPUT_PER_MILLION"] = "0.25"
    with pytest.raises(ConfigurationError, match="both"):
        load_config(environ)


def test_blank_temperature_means_the_setting_is_unsupported() -> None:
    config = load_config({"AI_EVAL_JUDGE_A_TEMPERATURE": "  "})
    assert config.roles[JudgeRole.judge_a].temperature is None


def test_estimate_uses_configured_prices_and_leaves_billed_cost_alone() -> None:
    usage = UsageMetadata(
        usage_known=True,
        input_tokens=10,
        output_tokens=5,
        request_count=1,
        provider_billed_cost_usd=0.01,
    )
    unchanged = apply_price_estimate(usage, load_config({}))
    assert unchanged.estimated_cost_usd is None
    assert unchanged.provider_billed_cost_usd == 0.01

    priced = apply_price_estimate(
        usage,
        load_config(
            {
                "AI_EVAL_PRICE_INPUT_PER_MILLION": "2",
                "AI_EVAL_PRICE_OUTPUT_PER_MILLION": "4",
            }
        ),
    )
    assert priced.estimated_cost_usd == pytest.approx(0.00004)
    assert priced.provider_billed_cost_usd == 0.01


def test_env_file_does_not_override_or_echo_secrets(tmp_path) -> None:
    path = tmp_path / "local.env"
    path.write_text(
        "\n".join(
            [
                "# comment",
                "AI_EVAL_MODE=live",
                "export AI_EVAL_JUDGE_A_API_KEY=sk-from-file",
                "",
            ]
        ),
        encoding="utf-8",
    )
    environ = {"AI_EVAL_MODE": "mock"}
    load_env_file(str(path), environ)
    assert environ["AI_EVAL_MODE"] == "mock"
    assert environ["AI_EVAL_JUDGE_A_API_KEY"] == "sk-from-file"

    broken = tmp_path / "broken.env"
    broken.write_text("sk-secret-value-without-equals\n", encoding="utf-8")
    with pytest.raises(ConfigurationError) as caught:
        load_env_file(str(broken), {})
    assert "sk-secret-value" not in str(caught.value)
