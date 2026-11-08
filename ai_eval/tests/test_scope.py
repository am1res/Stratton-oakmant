from helpers import SRC

_BANNED = (
    "Установление контакта",
    "Выявление потребности",
    "Идентификация",
    "Корректная и полная консультация",
    "Эмпатия и клиентоориентированность",
    "Управление диалогом",
    "Грубые ошибки",
    "checklist.default.json",
    "langchain",
    "api.openai.com",
    "gpt-5",
    "gpt-4",
    "c01",
    "c02",
    "c03",
    "c04",
    "c05",
    "c06",
    "c07",
    "c08",
)


def test_evaluator_source_has_no_official_rubric_or_provider_sdk() -> None:
    text = "\n".join(path.read_text(encoding="utf-8") for path in SRC.rglob("*.py")).lower()
    for banned in _BANNED:
        assert banned.lower() not in text
