"""Provider settings from the environment.

Secrets stay in the environment variable named by *_API_KEY_ENV.
This module stores that name, not the key, and never includes a key in errors.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping

from ai_eval.errors import ConfigurationError
from ai_eval.models import (
    AppConfig,
    JudgeRole,
    ResponseFormatCapability,
    RoleSettings,
    UsageMetadata,
)

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PLACEHOLDER_MARKERS = ("PASTE", "CHANGEME", "YOUR_KEY", "YOUR_MODEL", "YOUR-MODEL", "EXAMPLE.COM")
_ROLE_PREFIX = {
    JudgeRole.judge_a: "AI_EVAL_JUDGE_A",
    JudgeRole.judge_b: "AI_EVAL_JUDGE_B",
    JudgeRole.adjudicator: "AI_EVAL_ADJUDICATOR",
}


def load_config(environ: Mapping[str, str] | None = None) -> AppConfig:
    source = environ if environ is not None else _os_environ()
    mode = source.get("AI_EVAL_MODE", "mock")
    if mode not in ("mock", "live"):
        raise ConfigurationError("AI_EVAL_MODE must be mock or live")
    price_input = _optional_price(source, "AI_EVAL_PRICE_INPUT_PER_MILLION")
    price_output = _optional_price(source, "AI_EVAL_PRICE_OUTPUT_PER_MILLION")
    if (price_input is None) ^ (price_output is None):
        raise ConfigurationError(
            "set both AI_EVAL_PRICE_INPUT_PER_MILLION and "
            "AI_EVAL_PRICE_OUTPUT_PER_MILLION, or leave both unset"
        )
    max_attempts = _optional_positive_int(source, "AI_EVAL_MAX_ATTEMPTS")
    if max_attempts is not None and max_attempts > 10:
        raise ConfigurationError("AI_EVAL_MAX_ATTEMPTS must be between 1 and 10")
    return AppConfig(
        mode=mode,  # type: ignore[arg-type]
        roles={role: _role_settings(source, role) for role in JudgeRole},
        max_attempts=max_attempts if max_attempts is not None else 3,
        price_input_per_million=price_input,
        price_output_per_million=price_output,
    )


def live_config_problems(
    config: AppConfig,
    role: JudgeRole,
    environ: Mapping[str, str] | None = None,
) -> list[str]:
    """Actionable gaps for one live role. The returned text never contains a key."""
    source = environ if environ is not None else _os_environ()
    settings = config.roles[role]
    label = role.value
    problems: list[str] = []
    if not settings.base_url:
        problems.append(f"{label}: base URL is not set")
    elif _is_placeholder(settings.base_url) or not settings.base_url.startswith(
        ("http://", "https://")
    ):
        problems.append(f"{label}: base URL must be a real http(s) URL, not a placeholder")
    if not settings.api_key_env:
        problems.append(f"{label}: api_key_env is not set")
    elif not _ENV_NAME.fullmatch(settings.api_key_env):
        problems.append(f"{label}: api_key_env must be the name of an environment variable")
    else:
        secret = source.get(settings.api_key_env, "")
        if secret.strip() == "":
            problems.append(f"{label}: environment variable {settings.api_key_env} is missing")
        elif _is_placeholder(secret):
            problems.append(
                f"{label}: environment variable {settings.api_key_env} is still a placeholder"
            )
    if not settings.model:
        problems.append(f"{label}: model id is not set")
    elif _is_placeholder(settings.model):
        problems.append(f"{label}: model id is still a placeholder")
    if settings.response_format is None:
        problems.append(
            f"{label}: response format is not set (json_schema, json_object, or prompt_json); "
            "it will not be guessed"
        )
    if settings.timeout_seconds is None:
        problems.append(f"{label}: timeout_seconds is not set")
    if settings.max_output_tokens is None:
        problems.append(f"{label}: max_output_tokens is not set")
    return problems


def read_api_key(
    config: AppConfig,
    role: JudgeRole,
    environ: Mapping[str, str] | None = None,
) -> str:
    """Return the secret for one role. Callers must not log the result."""
    problems = live_config_problems(config, role, environ)
    if problems:
        raise ConfigurationError(
            f"live mode is not configured for {role.value}:\n- " + "\n- ".join(problems)
        )
    source = environ if environ is not None else _os_environ()
    settings = config.roles[role]
    assert settings.api_key_env is not None
    return source[settings.api_key_env].strip()


def apply_price_estimate(usage: UsageMetadata, config: AppConfig) -> UsageMetadata:
    """Fill estimated_cost_usd only when tokens and both prices are known."""
    if (
        not usage.usage_known
        or usage.input_tokens is None
        or usage.output_tokens is None
        or config.price_input_per_million is None
        or config.price_output_per_million is None
    ):
        return usage
    estimated = (
        usage.input_tokens * config.price_input_per_million
        + usage.output_tokens * config.price_output_per_million
    ) / 1_000_000
    return usage.model_copy(update={"estimated_cost_usd": estimated})


def load_env_file(path: str, environ: dict[str, str]) -> None:
    """Load KEY=VALUE lines into environ without overriding existing names.

    Values are not logged. A missing file is a configuration error.
    """
    try:
        text = open(path, encoding="utf-8").read()
    except OSError as exc:
        raise ConfigurationError(f"cannot read env file: {exc.strerror or exc.__class__.__name__}") from exc
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            raise ConfigurationError(f"env file line {line_number} is not KEY=VALUE")
        name, value = line.split("=", 1)
        name = name.strip()
        if not _ENV_NAME.fullmatch(name):
            raise ConfigurationError(f"env file line {line_number} has an invalid name")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        environ.setdefault(name, value)


def _role_settings(source: Mapping[str, str], role: JudgeRole) -> RoleSettings:
    prefix = _ROLE_PREFIX[role]
    response_format = _optional(source, f"{prefix}_RESPONSE_FORMAT")
    parsed_format: ResponseFormatCapability | None
    if response_format is None:
        parsed_format = None
    else:
        try:
            parsed_format = ResponseFormatCapability(response_format)
        except ValueError as exc:
            raise ConfigurationError(
                f"{prefix}_RESPONSE_FORMAT must be json_schema, json_object, or prompt_json"
            ) from exc
    max_tokens_param = _optional(source, f"{prefix}_MAX_TOKENS_PARAM") or "max_completion_tokens"
    if max_tokens_param not in ("max_completion_tokens", "max_tokens"):
        raise ConfigurationError(
            f"{prefix}_MAX_TOKENS_PARAM must be max_completion_tokens or max_tokens"
        )
    return RoleSettings(
        base_url=_optional(source, f"{prefix}_BASE_URL"),
        api_key_env=_optional(source, f"{prefix}_API_KEY_ENV"),
        model=_optional(source, f"{prefix}_MODEL"),
        response_format=parsed_format,
        timeout_seconds=_optional_float(source, f"{prefix}_TIMEOUT_SECONDS"),
        max_output_tokens=_optional_positive_int(source, f"{prefix}_MAX_OUTPUT_TOKENS"),
        max_tokens_param=max_tokens_param,  # type: ignore[arg-type]
        temperature=_optional_finite_float(source, f"{prefix}_TEMPERATURE"),
        reasoning_effort=_optional(source, f"{prefix}_REASONING_EFFORT"),
    )


def _optional(source: Mapping[str, str], name: str) -> str | None:
    value = source.get(name)
    if value is None or value.strip() == "":
        return None
    return value.strip()


def _optional_price(source: Mapping[str, str], name: str) -> float | None:
    value = _optional_finite_float(source, name)
    if value is not None and value < 0:
        raise ConfigurationError(f"{name} cannot be negative")
    return value


def _optional_float(source: Mapping[str, str], name: str) -> float | None:
    value = _optional_finite_float(source, name)
    if value is not None and value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _optional_finite_float(source: Mapping[str, str], name: str) -> float | None:
    raw = _optional(source, name)
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be a number") from exc
    if not math.isfinite(value):
        raise ConfigurationError(f"{name} must be a finite number")
    return value


def _optional_positive_int(source: Mapping[str, str], name: str) -> int | None:
    raw = _optional(source, name)
    if raw is None:
        return None
    if not re.fullmatch(r"[1-9][0-9]*", raw):
        raise ConfigurationError(f"{name} must be a positive integer")
    return int(raw)


def _is_placeholder(value: str) -> bool:
    upper = value.upper()
    return any(marker in upper for marker in _PLACEHOLDER_MARKERS)


def _os_environ() -> Mapping[str, str]:
    import os

    return os.environ
