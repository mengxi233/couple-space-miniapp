"""Small helpers for reading runtime configuration safely.

The couple service is deployed in more than one way (a traditional ``.env``
file and containers with mounted secrets).  This module keeps the precedence
and parsing rules in one place:

* ``NAME_FILE`` is preferred when it points at a readable file.  The file is
  read at request/startup time and its trailing newline is removed.
* ``NAME`` is used as the fallback.
* Missing or malformed optional values resolve to the caller's default.

The helpers intentionally never log or return secret values in diagnostics.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable


TRUE_VALUES = {"1", "true", "yes", "on", "y"}
FALSE_VALUES = {"0", "false", "no", "off", "n"}


def runtime_value(
    name: str,
    default: str | None = None,
    *,
    aliases: Iterable[str] = (),
) -> str | None:
    """Return a trimmed runtime value, preferring its ``*_FILE`` variant.

    ``*_FILE`` support follows the common Docker/Kubernetes convention.  A
    missing or unreadable file does not make the process fail silently when a
    normal environment value is available; it simply falls back to that
    value.  Callers that require a value should validate the returned result.
    """

    names = (name, *tuple(aliases))
    for candidate in names:
        file_name = os.getenv(f"{candidate}_FILE", "").strip()
        if file_name:
            try:
                value = Path(file_name).read_text(encoding="utf-8").strip()
            except (OSError, UnicodeError):
                value = ""
            if value:
                return value

        value = os.getenv(candidate)
        if value is not None:
            value = value.strip()
            if value:
                return value
    return default


def runtime_bool(
    name: str,
    default: bool = False,
    *,
    aliases: Iterable[str] = (),
) -> bool:
    """Parse a boolean environment value without treating typos as truthy."""

    value = runtime_value(name, aliases=aliases)
    if value is None:
        return default
    normalized = value.lower()
    if normalized in TRUE_VALUES:
        return True
    if normalized in FALSE_VALUES:
        return False
    return default


def runtime_int(
    name: str,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
    aliases: Iterable[str] = (),
) -> int:
    """Parse and bound an integer environment value."""

    value = runtime_value(name, aliases=aliases)
    try:
        parsed = int(value) if value is not None else default
    except (TypeError, ValueError):
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def is_production() -> bool:
    """Return whether the process is running in a production-like mode."""

    environment = (
        runtime_value("FLASK_ENV", aliases=("APP_ENV",)) or "production"
    ).lower()
    return environment in {"production", "prod"}


def runtime_status() -> dict[str, bool]:
    """Expose non-sensitive readiness flags for internal diagnostics."""

    appid = runtime_value("WX_APPID", aliases=("WECHAT_APPID",))
    appsecret = runtime_value("WX_APPSECRET", aliases=("WECHAT_APPSECRET",))
    smtp_host = runtime_value("SMTP_HOST")
    smtp_user = runtime_value("SMTP_USER")
    smtp_password = runtime_value("SMTP_PASSWORD")
    smtp_from = runtime_value("SMTP_FROM") or smtp_user or "no-reply@example.com"
    smtp_security = (runtime_value("SMTP_SECURITY") or "").lower()
    if not smtp_security:
        smtp_security = "ssl" if runtime_bool("SMTP_USE_TLS", True) else "starttls"
    smtp_security = {"smtps": "ssl", "tls": "starttls", "start_tls": "starttls", "none": "plain"}.get(smtp_security, smtp_security)
    smtp_auth_ok = not smtp_user or bool(smtp_password)
    smtp_sender_ok = "@" in smtp_from
    smtp_security_ok = smtp_security in {"ssl", "starttls"} or (
        smtp_security == "plain" and runtime_bool("SMTP_ALLOW_INSECURE", False)
    )
    return {
        "wechatConfigured": bool(appid and appsecret),
        "wechatPartiallyConfigured": bool(appid) != bool(appsecret),
        "smtpConfigured": bool(smtp_host and smtp_auth_ok and smtp_sender_ok and smtp_security_ok),
        "devLoginEnabled": runtime_bool("COUPLE_DEV_LOGIN", default=not is_production()),
    }
