"""Errors the caller can handle without inspecting a provider payload."""


class ConfigurationError(ValueError):
    """The checklist or provider settings cannot be used.

    Raised before a judge runs, or when the provider rejects a setting.
    A configuration error is never turned into an evaluation result.
    """


class ProviderError(RuntimeError):
    """One provider request failed.

    transient=True means a retry may succeed (timeout, rate limit, 5xx).
    The detail never contains an API key and is truncated before use.
    """

    def __init__(self, kind: str, detail: str, *, transient: bool) -> None:
        super().__init__(f"{kind}: {detail}" if detail else kind)
        self.kind = kind
        self.detail = detail
        self.transient = transient
