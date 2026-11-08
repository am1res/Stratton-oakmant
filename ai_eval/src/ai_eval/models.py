"""Input and output contracts for checklist evaluation.

The checklist supplied by the caller is the rubric. This module does not
embed official criterion names, weights, or score totals.
"""

from __future__ import annotations

from decimal import Decimal
from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    ValidationError,
    field_validator,
    model_validator,
)

from ai_eval.errors import ConfigurationError


class Language(str, Enum):
    RU = "RU"
    KZ = "KZ"
    EN = "EN"


class Speaker(str, Enum):
    client = "client"
    operator = "operator"
    bot = "bot"
    system = "system"


class Applicability(str, Enum):
    applicable = "applicable"
    not_applicable = "not_applicable"
    undetermined = "undetermined"


class JudgeRole(str, Enum):
    judge_a = "judge_a"
    judge_b = "judge_b"
    adjudicator = "adjudicator"


class ValidationStatus(str, Enum):
    valid = "valid"
    invalid = "invalid"


class EvaluationStatus(str, Enum):
    completed = "completed"
    partial = "partial"
    failed = "failed"


class ResponseFormat(str, Enum):
    """How the endpoint is asked for structured output.

    json_schema: response_format with a strict schema (schema enforced by the API).
    json_object: response_format json_object; the schema text goes into the prompt.
    prompt_json: no response_format parameter at all; the schema text goes into
                 the prompt and the output is validated here. For endpoints whose
                 response_format support is unknown or absent.
    """

    json_schema = "json_schema"
    json_object = "json_object"
    prompt_json = "prompt_json"


ResponseFormatCapability = ResponseFormat


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_id: str = Field(pattern=r"^\S+$")
    timestamp: str = Field(min_length=1)
    speaker: Speaker
    text: str

    @field_validator("message_id", "timestamp", "text", mode="before")
    @classmethod
    def text_stays_text(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("must be a string")
        return value

    @field_validator("speaker", mode="before")
    @classmethod
    def speaker_stays_text(cls, value: object) -> object:
        if isinstance(value, Speaker):
            return value
        if not isinstance(value, str):
            raise ValueError("speaker must be a string")
        return value


class Conversation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: str = Field(min_length=1)
    channel: str = Field(min_length=1)
    language: Language
    messages: list[Message]

    @field_validator("conversation_id", "channel", mode="before")
    @classmethod
    def identity_stays_text(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("must be a string")
        return value

    @field_validator("language", mode="before")
    @classmethod
    def language_stays_text(cls, value: object) -> object:
        if isinstance(value, Language):
            return value
        if not isinstance(value, str):
            raise ValueError("language must be a string")
        return value

    @model_validator(mode="after")
    def unique_message_ids(self) -> Conversation:
        ids = [message.message_id for message in self.messages]
        if len(ids) != len(set(ids)):
            raise ValueError("conversation contains a duplicate message_id")
        return self


class ScaleAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: int | float
    description: str = Field(min_length=1)

    @field_validator("value", mode="before")
    @classmethod
    def numeric_value(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("anchor value must be a number")
        return value

    @field_validator("description")
    @classmethod
    def description_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("anchor description is empty")
        return value


class NumericScale(BaseModel):
    """Permitted numeric answers, taken only from the fields that are set.

    A missing bound, step, or anchor list is unknown. It is not filled in.
    """

    model_config = ConfigDict(extra="forbid")

    minimum: int | float | None = None
    maximum: int | float | None = None
    step: int | float | None = None
    allowed_values: list[int | float] | None = None
    anchors: list[ScaleAnchor] | None = None

    @field_validator("minimum", "maximum", "step", mode="before")
    @classmethod
    def numeric_bound(cls, value: object) -> object:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("scale bound must be a number")
        return value

    @field_validator("allowed_values", mode="before")
    @classmethod
    def numeric_list(cls, value: object) -> object:
        if value is None:
            return None
        if not isinstance(value, list):
            raise ValueError("allowed_values must be a list of numbers")
        for item in value:
            if isinstance(item, bool) or not isinstance(item, (int, float)):
                raise ValueError("allowed_values must be a list of numbers")
        return value

    @model_validator(mode="after")
    def defined_scale(self) -> NumericScale:
        if self.allowed_values is not None and len(self.allowed_values) == 0:
            raise ValueError("allowed_values is empty")
        if self.anchors is not None and len(self.anchors) == 0:
            raise ValueError("anchors is empty")
        has_discrete = self.allowed_values is not None or self.anchors is not None
        has_range = self.minimum is not None and self.maximum is not None
        if (self.minimum is None) ^ (self.maximum is None):
            if not has_discrete:
                raise ValueError("numeric range needs both minimum and maximum")
        if self.step is not None and self.minimum is None:
            raise ValueError(
                "step requires minimum; the scale does not say where the step starts"
            )
        if not has_discrete and not has_range:
            raise ValueError(
                "numeric scale needs allowed_values, anchors, or both minimum and maximum"
            )
        if self.minimum is not None and self.maximum is not None:
            if _decimal(self.minimum) > _decimal(self.maximum):
                raise ValueError("minimum is greater than maximum")
        if self.step is not None and _decimal(self.step) <= 0:
            raise ValueError("step must be positive")
        if self.anchors is not None:
            anchor_values = [_decimal(anchor.value) for anchor in self.anchors]
            if len(anchor_values) != len(set(anchor_values)):
                raise ValueError("duplicate anchor values")
        if self.allowed_values is not None:
            allowed = [_decimal(value) for value in self.allowed_values]
            if len(allowed) != len(set(allowed)):
                raise ValueError("duplicate allowed_values")
        if self.allowed_values is not None and self.anchors is not None:
            allowed = {_decimal(value) for value in self.allowed_values}
            anchored = {_decimal(anchor.value) for anchor in self.anchors}
            if allowed != anchored:
                raise ValueError("allowed_values and anchors define different numbers")
        discrete = self.discrete_values()
        if discrete is not None and self.minimum is not None:
            low = _decimal(self.minimum)
            if any(value < low for value in discrete):
                raise ValueError("a listed numeric value is below minimum")
        if discrete is not None and self.maximum is not None:
            high = _decimal(self.maximum)
            if any(value > high for value in discrete):
                raise ValueError("a listed numeric value is above maximum")
        return self

    def discrete_values(self) -> list[Decimal] | None:
        if self.allowed_values is not None:
            return [_decimal(value) for value in self.allowed_values]
        if self.anchors is not None:
            return [_decimal(anchor.value) for anchor in self.anchors]
        return None


class CriterionBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    criterion_id: str = Field(pattern=r"^\S+$")
    name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    allow_na: bool
    na_rule: str | None = None
    additional_instructions: str | None = None

    @model_validator(mode="after")
    def applicability_rule(self) -> CriterionBase:
        if not self.name.strip() or not self.description.strip():
            raise ValueError("criterion name and description must contain text")
        if self.allow_na:
            if self.na_rule is None or not self.na_rule.strip():
                raise ValueError("allow_na requires a non-empty na_rule")
        elif self.na_rule is not None:
            raise ValueError("na_rule is set but allow_na is false")
        if self.additional_instructions is not None and not self.additional_instructions.strip():
            raise ValueError("additional_instructions is empty")
        return self


class BooleanCriterion(CriterionBase):
    answer_type: Literal["boolean"]


class NumericCriterion(CriterionBase):
    answer_type: Literal["numeric"]
    scale: NumericScale


class CategoricalCriterion(CriterionBase):
    answer_type: Literal["categorical"]
    allowed_values: list[str] = Field(min_length=1)

    @field_validator("allowed_values")
    @classmethod
    def category_values(cls, values: list[str]) -> list[str]:
        if any(not isinstance(value, str) or not value.strip() for value in values):
            raise ValueError("allowed_values must be non-empty strings")
        if len(set(values)) != len(values):
            raise ValueError("duplicate allowed_values")
        return values


Criterion = Annotated[
    BooleanCriterion | NumericCriterion | CategoricalCriterion,
    Field(discriminator="answer_type"),
]


class Checklist(BaseModel):
    model_config = ConfigDict(extra="forbid")

    checklist_version_id: str = Field(min_length=1)
    shared_instructions: str
    criteria: list[Criterion] = Field(min_length=1)
    explanation_language: str | None = Field(
        default=None,
        description=(
            "Language for reviewer-facing text (explanation, na_reason, review_reason), "
            "e.g. 'Russian'. When unset the judge follows the language of the checklist text."
        ),
    )

    @model_validator(mode="after")
    def unique_criteria(self) -> Checklist:
        ids = [criterion.criterion_id for criterion in self.criteria]
        if len(ids) != len(set(ids)):
            raise ValueError("checklist contains a duplicate criterion_id")
        if self.explanation_language is not None and not self.explanation_language.strip():
            raise ValueError("explanation_language is empty")
        return self


class CheckedRange(BaseModel):
    """Inclusive transcript span. Order is message-list order, not timestamp order."""

    model_config = ConfigDict(extra="forbid")

    start_message_id: str
    end_message_id: str

    @field_validator("start_message_id", "end_message_id", mode="before")
    @classmethod
    def endpoint_is_text(cls, value: object) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("checked_range message id must be a non-empty string")
        return value


class CriterionJudgment(BaseModel):
    """One criterion decision.

    Enum values accept the JSON strings. Answer values stay in their JSON types:
    true/false stay booleans, 0 stays a number, and "yes" stays a string.
    """

    model_config = ConfigDict(extra="forbid")

    criterion_id: str
    applicability: Applicability
    answer: StrictBool | StrictInt | StrictFloat | StrictStr | None
    explanation: str
    evidence_message_ids: list[str]
    checked_range: CheckedRange | None
    na_reason: str | None
    needs_human_review: StrictBool
    review_reason: str | None

    @field_validator("criterion_id", "explanation", mode="before")
    @classmethod
    def required_text(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("must be a string")
        return value

    @field_validator("evidence_message_ids", mode="before")
    @classmethod
    def evidence_is_text(cls, value: object) -> object:
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise ValueError("evidence_message_ids must be a list of strings")
        return value

    @field_validator("na_reason", "review_reason", mode="before")
    @classmethod
    def optional_text(cls, value: object) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("must be a string or null")
        return value


class UsageMetadata(BaseModel):
    """Token and cost figures.

    None means the figure is unknown. It does not mean zero.
    estimated_cost_usd is computed from configured prices.
    provider_billed_cost_usd is recorded only when the provider reports it.
    """

    model_config = ConfigDict(extra="forbid")

    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    usage_known: bool
    estimated_cost_usd: float | None = None
    provider_billed_cost_usd: float | None = None
    request_count: int = 0

    @model_validator(mode="after")
    def consistent_usage(self) -> UsageMetadata:
        if self.request_count < 0:
            raise ValueError("request_count cannot be negative")
        if self.usage_known:
            if self.input_tokens is None or self.output_tokens is None:
                raise ValueError("usage_known requires input_tokens and output_tokens")
            if self.input_tokens < 0 or self.output_tokens < 0:
                raise ValueError("token counts cannot be negative")
            if (
                self.total_tokens is not None
                and self.total_tokens != self.input_tokens + self.output_tokens
            ):
                raise ValueError("total_tokens does not match input_tokens + output_tokens")
        elif any(
            value is not None
            for value in (self.input_tokens, self.output_tokens, self.total_tokens)
        ):
            raise ValueError("token counts must be null when usage is unknown")
        for name in ("estimated_cost_usd", "provider_billed_cost_usd"):
            amount = getattr(self, name)
            if amount is not None and amount < 0:
                raise ValueError(f"{name} cannot be negative")
        if not self.usage_known and self.estimated_cost_usd is not None:
            raise ValueError("estimated cost requires known token usage")
        return self


UNKNOWN_USAGE = UsageMetadata(usage_known=False, request_count=0)


class JudgeRun(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: JudgeRole
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)
    prompt_version: str = Field(min_length=1)
    judgments: list[CriterionJudgment]
    usage: UsageMetadata
    latency_ms: float
    validation_status: ValidationStatus
    validation_errors: list[str]
    notes: list[str] = Field(
        default_factory=list,
        description="Non-fatal observations, e.g. first-attempt errors fixed by the repair call.",
    )

    @field_validator("latency_ms")
    @classmethod
    def non_negative_latency(cls, value: float) -> float:
        if value < 0:
            raise ValueError("latency_ms cannot be negative")
        return value


class UsageSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider_request_count: int
    input_tokens: int | None = None
    output_tokens: int | None = None
    usage_known: bool
    estimated_cost_usd: float | None = None
    provider_billed_cost_usd: float | None = None


class EvaluationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: str
    checklist_version_id: str
    status: EvaluationStatus
    criterion_results: list[CriterionJudgment]
    judge_runs: list[JudgeRun]
    disputed_criterion_ids: list[str] = Field(
        description=(
            "Criteria where two valid judges disagreed on applicability or on the "
            "normalized answer. Empty when fewer than two valid judge runs exist."
        )
    )
    unresolved_criterion_ids: list[str]
    usage: UsageSummary
    notes: list[str] = Field(
        default_factory=list,
        description="Degradations the caller should show, e.g. a failed judge.",
    )


class PromptMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["system", "user", "assistant"]
    content: str


class ProviderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[PromptMessage]
    json_schema: dict[str, Any]
    prompt_version: str


class ProviderResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    raw_text: str
    usage: UsageMetadata
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)
    finish_reason: str | None = None
    refusal: str | None = None


class RoleSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_url: str | None = None
    api_key_env: str | None = None
    model: str | None = None
    response_format: ResponseFormat | None = None
    timeout_seconds: float | None = None
    max_output_tokens: int | None = None
    max_tokens_param: Literal["max_completion_tokens", "max_tokens"] = "max_completion_tokens"
    temperature: float | None = None
    reasoning_effort: str | None = None


class AppConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["mock", "live"]
    roles: dict[JudgeRole, RoleSettings]
    max_attempts: int = Field(default=3, ge=1, le=10)
    price_input_per_million: float | None = None
    price_output_per_million: float | None = None


def parse_conversation(data: object) -> Conversation:
    return _parse_model(Conversation, data)


def parse_checklist(data: object) -> Checklist:
    return _parse_model(Checklist, data)


load_conversation = parse_conversation
load_checklist = parse_checklist


def _parse_model(model: type[Conversation] | type[Checklist], data: object) -> Any:
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise ConfigurationError(_validation_summary(exc)) from exc


def _validation_summary(exc: ValidationError) -> str:
    lines = ["configuration error"]
    for error in exc.errors():
        location = ".".join(str(part) for part in error["loc"]) or "<root>"
        message = " ".join(str(error["msg"]).split())
        if len(message) > 180:
            message = message[:180] + "…"
        lines.append(f"{location}: {message}")
    return "\n".join(lines)


def _decimal(value: int | float) -> Decimal:
    return Decimal(str(value))
