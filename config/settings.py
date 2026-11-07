"""Django settings for the Conversation Quality Analytics (CQA) backend.

All deployment-specific values come from environment variables (optionally a .env file).
"""
import os
from pathlib import Path

import dj_database_url
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def env_bool(name, default=False):
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-insecure-change-me")
DEBUG = env_bool("DJANGO_DEBUG", True)
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "*").split(",")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "ingestion",
    "checklists",
    "evaluations",
    "appeals",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# SQLite by default for local hacking; PostgreSQL via DATABASE_URL in docker-compose.
DATABASES = {
    "default": dj_database_url.config(
        default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}", conn_max_age=60
    )
}
if DATABASES["default"]["ENGINE"] == "django.db.backends.sqlite3":
    # Background evaluation threads write concurrently; wait for the lock instead of failing.
    DATABASES["default"].setdefault("OPTIONS", {})["timeout"] = 30

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- API -------------------------------------------------------------------
# Auth is out of scope for the demo; the API is open.
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 100,
}

# The frontend is a separate static bundle (later a Dynamics 365 web resource).
CORS_ALLOWED_ORIGINS = [o for o in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",") if o]
CORS_ALLOW_ALL_ORIGINS = DEBUG and not CORS_ALLOWED_ORIGINS

# --- Background execution ----------------------------------------------------
# "thread": in-process thread pool (no Redis needed, good for local dev).
# "celery": Celery workers via CELERY_BROKER_URL (docker-compose).
CQA_EXECUTOR = os.environ.get("CQA_EXECUTOR", "thread")
CQA_MAX_CONCURRENCY = int(os.environ.get("CQA_MAX_CONCURRENCY", "4"))

CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0")
CELERY_RESULT_BACKEND = None
CELERY_TASK_ACKS_LATE = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1

# --- Organizers' dataset API -------------------------------------------------
CQA_DATASET_API_URL = os.environ.get("CQA_DATASET_API_URL", "")
CQA_DATASET_API_TIMEOUT = int(os.environ.get("CQA_DATASET_API_TIMEOUT", "60"))

# --- LLM agents --------------------------------------------------------------
# "anthropic" calls the Claude API; "mock" returns deterministic fake verdicts (no key needed).
CQA_LLM_PROVIDER = os.environ.get("CQA_LLM_PROVIDER", "anthropic")
CQA_MODEL_AGENT_A = os.environ.get("CQA_MODEL_AGENT_A", "claude-opus-5-5")
CQA_MODEL_AGENT_B = os.environ.get("CQA_MODEL_AGENT_B", "claude-opus-5-5")
CQA_MODEL_ARBITER = os.environ.get("CQA_MODEL_ARBITER", "claude-opus-5-5")
CQA_EFFORT_AGENT = os.environ.get("CQA_EFFORT_AGENT", "medium")
CQA_EFFORT_ARBITER = os.environ.get("CQA_EFFORT_ARBITER", "high")
CQA_LLM_MAX_TOKENS = int(os.environ.get("CQA_LLM_MAX_TOKENS", "16000"))
# Server-side refusal fallback (beta): re-runs a declined request on a fallback model.
CQA_USE_FALLBACKS = env_bool("CQA_USE_FALLBACKS", True)

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "loggers": {
        "cqa": {"handlers": ["console"], "level": os.environ.get("CQA_LOG_LEVEL", "INFO")},
    },
}
