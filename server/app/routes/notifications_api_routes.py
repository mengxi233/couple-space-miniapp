"""In-app notification APIs with optional email-channel extension points."""

import json
import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import parseaddr
from datetime import datetime
import re

from flask import Blueprint, jsonify, request
from sqlalchemy import text

from app.extensions import db
from app.routes.couple_api_routes import _current_user, _ensure_tables
from app.utils.runtime_config import runtime_bool, runtime_int, runtime_value


notifications_bp = Blueprint("couple_notifications", __name__, url_prefix="/api/couple")
logger = logging.getLogger(__name__)
_EMAIL_PATTERN = re.compile(r"[^@\s<>]+@[^@\s<>]+")


def _normalise_email(value):
    """Return a plain, header-safe email address or an empty string."""

    candidate = str(value or "").strip()
    if not candidate or len(candidate) > 254 or "\r" in candidate or "\n" in candidate:
        return ""
    # User settings intentionally accept a bare address only.  Rejecting
    # display-name syntax keeps the value safe when it is copied into a To
    # header and avoids accepting malformed addresses such as ``a@b@c``.
    _, address = parseaddr(candidate)
    if address != candidate or not _EMAIL_PATTERN.fullmatch(candidate):
        return ""
    return candidate


def _smtp_settings():
    """Read and validate SMTP settings without exposing any secret values."""

    host = runtime_value("SMTP_HOST")
    if not host or any(char in host for char in "\r\n") or len(host) > 253:
        return None

    user = runtime_value("SMTP_USER")
    password = runtime_value("SMTP_PASSWORD")
    # Authenticated relays need both values.  An empty pair is allowed for an
    # explicitly configured unauthenticated relay.
    if bool(user) != bool(password):
        return None

    security = (runtime_value("SMTP_SECURITY") or "").lower()
    if not security:
        # Backwards compatibility with the original boolean switch: true
        # meant implicit SSL and false meant STARTTLS.
        security = "ssl" if runtime_bool("SMTP_USE_TLS", True) else "starttls"
    security = {
        "smtps": "ssl",
        "tls": "starttls",
        "start_tls": "starttls",
        "none": "plain",
    }.get(security, security)
    if security not in {"ssl", "starttls", "plain"}:
        return None
    if security == "plain" and not runtime_bool("SMTP_ALLOW_INSECURE", False):
        return None

    sender = runtime_value("SMTP_FROM") or user or "no-reply@example.com"
    sender = _normalise_email(sender)
    if not sender:
        return None

    return {
        "host": host,
        "port": runtime_int("SMTP_PORT", 465, minimum=1, maximum=65535),
        "user": user,
        "password": password,
        "sender": sender,
        "security": security,
        "timeout": runtime_int("SMTP_TIMEOUT", 8, minimum=3, maximum=30),
    }


def ensure_notification_tables():
    _ensure_tables()
    db.session.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS couple_notifications (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                couple_id INT NOT NULL,
                recipient_id INT NOT NULL,
                type VARCHAR(40) NOT NULL DEFAULT 'system',
                title VARCHAR(120) NOT NULL,
                content VARCHAR(500) NOT NULL DEFAULT '',
                payload_json TEXT NULL,
                channel VARCHAR(30) NOT NULL DEFAULT 'in_app',
                is_read TINYINT(1) NOT NULL DEFAULT 0,
                read_at DATETIME NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_notifications_recipient (recipient_id, is_read, created_at),
                INDEX idx_notifications_couple (couple_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """
        )
    )
    db.session.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS couple_notification_settings (
                user_id INT PRIMARY KEY,
                in_app_enabled TINYINT(1) NOT NULL DEFAULT 1,
                email_enabled TINYINT(1) NOT NULL DEFAULT 0,
                email VARCHAR(200) NOT NULL DEFAULT '',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """
        )
    )
    db.session.commit()


def _member_context():
    actor = _current_user()
    if not actor or not actor.get("user_id"):
        return None
    row = db.session.execute(
        text(
            """
            SELECT u.id AS user_id, u.nickname, m.couple_id, m.role
            FROM couple_users u
            LEFT JOIN couple_members m ON m.user_id=u.id
            WHERE u.id=:uid
            """
        ),
        {"uid": actor["user_id"]},
    ).mappings().first()
    if not row or not row.get("couple_id") or row.get("role") not in {"owner", "member"}:
        return None
    return dict(row)


def _notification_payload(row):
    payload = row.get("payload_json")
    try:
        payload = json.loads(payload) if payload else {}
    except (TypeError, ValueError):
        payload = {}
    created = row.get("created_at")
    read_at = row.get("read_at")
    return {
        "id": row.get("id"),
        "type": row.get("type") or "system",
        "title": row.get("title") or "通知",
        "content": row.get("content") or "",
        "payload": payload,
        "channel": row.get("channel") or "in_app",
        "isRead": bool(row.get("is_read")),
        "createdAt": created.isoformat() if isinstance(created, datetime) else created,
        "readAt": read_at.isoformat() if isinstance(read_at, datetime) else read_at,
    }


def create_notification(
    couple_id,
    recipient_id,
    title,
    content="",
    notification_type="system",
    payload=None,
    channel="in_app",
    commit=False,
    ensure=True,
):
    """Insert an in-app notification and optionally attempt email delivery.

    Email is intentionally opt-in and best-effort.  Without a complete SMTP
    configuration the in-app row is still persisted, leaving a clean seam for
    a later mail provider or queue worker.
    """

    if ensure:
        ensure_notification_tables()
    settings = db.session.execute(
        text(
            "SELECT in_app_enabled,email_enabled,email FROM couple_notification_settings "
            "WHERE user_id=:uid"
        ),
        {"uid": recipient_id},
    ).mappings().first()
    in_app_enabled = not settings or bool(settings.get("in_app_enabled"))
    recipient_email = _normalise_email(settings.get("email")) if settings else ""
    email_enabled = bool(settings and settings.get("email_enabled") and recipient_email)
    # A user may enable both channels.  Keep that information in the row and
    # deliver email independently; the previous implementation silently chose
    # in-app whenever both toggles were on, so email was never sent for the
    # default (in-app enabled) profile.
    channels = []
    if in_app_enabled:
        channels.append("in_app")
    if email_enabled:
        channels.append("email")
    if not channels:
        # Preserve a row for auditability even when the user disabled both
        # channels.  It remains invisible to the disabled in-app UI.
        channels.append("none")
    chosen_channel = ",".join(channels)
    result = db.session.execute(
        text(
            """
            INSERT INTO couple_notifications
                (couple_id,recipient_id,type,title,content,payload_json,channel)
            VALUES(:cid,:uid,:type,:title,:content,:payload,:channel)
            """
        ),
        {
            "cid": couple_id,
            "uid": recipient_id,
            "type": str(notification_type or "system")[:40],
            "title": str(title or "通知")[:120],
            "content": str(content or "")[:500],
            "payload": json.dumps(payload or {}, ensure_ascii=False),
            "channel": chosen_channel,
        },
    )
    if commit:
        db.session.commit()

    # Keep delivery optional and non-blocking from the API's perspective.
    if email_enabled:
        _try_send_email(recipient_email, title, content)
    return result.lastrowid


def _try_send_email(recipient, title, content):
    recipient = _normalise_email(recipient)
    settings = _smtp_settings()
    if not recipient or not settings:
        logger.info("SMTP email delivery skipped: recipient or server configuration is unavailable")
        return False
    try:
        message = EmailMessage()
        # Notification titles are generated by the server, but normalising
        # line breaks here also protects future call sites from header
        # injection.
        message["Subject"] = " ".join(str(title or "伴侣空间通知").splitlines())[:200]
        message["From"] = settings["sender"]
        message["To"] = recipient
        message.set_content(content or "你有一条新的情侣空间通知。")
        if settings["security"] == "ssl":
            connection = smtplib.SMTP_SSL(
                settings["host"],
                settings["port"],
                timeout=settings["timeout"],
                context=ssl.create_default_context(),
            )
        else:
            connection = smtplib.SMTP(settings["host"], settings["port"], timeout=settings["timeout"])
        with connection as server:
            if settings["security"] == "starttls":
                server.ehlo()
                server.starttls(context=ssl.create_default_context())
                server.ehlo()
            if settings["user"]:
                server.login(settings["user"], settings["password"])
            server.send_message(message)
        return True
    except Exception as exc:
        # Notification persistence must not fail a task/order request because
        # an optional external mail provider is unavailable.
        logger.warning(
            "SMTP email delivery failed (host=%s port=%s): %s",
            settings["host"],
            settings["port"],
            type(exc).__name__,
        )
        return False


@notifications_bp.get("/notifications")
def list_notifications():
    context = _member_context()
    if not context:
        return jsonify({"notifications": [], "unreadCount": 0, "role": "guest"})
    ensure_notification_tables()
    unread_only = str(request.args.get("unreadOnly") or "").lower() in {"1", "true", "yes"}
    clause = " AND is_read=0" if unread_only else ""
    rows = db.session.execute(
        text(
            f"""
            SELECT id,type,title,content,payload_json,channel,is_read,read_at,created_at
            FROM couple_notifications
            WHERE recipient_id=:uid AND couple_id=:cid{clause}
            ORDER BY id DESC LIMIT 100
            """
        ),
        {"uid": context["user_id"], "cid": context["couple_id"]},
    ).mappings().all()
    unread = db.session.execute(
        text(
            "SELECT COUNT(*) FROM couple_notifications "
            "WHERE recipient_id=:uid AND couple_id=:cid AND is_read=0"
        ),
        {"uid": context["user_id"], "cid": context["couple_id"]},
    ).scalar()
    db.session.commit()
    return jsonify({"notifications": [_notification_payload(row) for row in rows], "unreadCount": int(unread or 0)})


@notifications_bp.post("/notifications/<int:notification_id>/read")
def mark_notification_read(notification_id):
    context = _member_context()
    if not context:
        return jsonify({"message": "请先登录并绑定情侣空间"}), 403
    ensure_notification_tables()
    result = db.session.execute(
        text(
            """
            UPDATE couple_notifications
            SET is_read=1,read_at=CURRENT_TIMESTAMP
            WHERE id=:nid AND recipient_id=:uid AND couple_id=:cid
            """
        ),
        {"nid": notification_id, "uid": context["user_id"], "cid": context["couple_id"]},
    )
    db.session.commit()
    if not result.rowcount:
        return jsonify({"message": "通知不存在"}), 404
    return jsonify({"success": True})


@notifications_bp.post("/notifications/read-all")
def mark_all_notifications_read():
    context = _member_context()
    if not context:
        return jsonify({"message": "请先登录并绑定情侣空间"}), 403
    ensure_notification_tables()
    db.session.execute(
        text(
            """
            UPDATE couple_notifications SET is_read=1,read_at=CURRENT_TIMESTAMP
            WHERE recipient_id=:uid AND couple_id=:cid AND is_read=0
            """
        ),
        {"uid": context["user_id"], "cid": context["couple_id"]},
    )
    db.session.commit()
    return jsonify({"success": True})


@notifications_bp.get("/notifications/settings")
def get_notification_settings():
    actor = _current_user()
    if not actor:
        return jsonify({"message": "请先登录"}), 401
    ensure_notification_tables()
    row = db.session.execute(
        text(
            "SELECT in_app_enabled AS inAppEnabled,email_enabled AS emailEnabled,email "
            "FROM couple_notification_settings WHERE user_id=:uid"
        ),
        {"uid": actor["user_id"]},
    ).mappings().first()
    db.session.commit()
    settings = dict(row) if row else {"inAppEnabled": True, "emailEnabled": False, "email": ""}
    # This is a boolean readiness flag only; SMTP host/user/password values
    # never leave the server.
    settings["emailAvailable"] = bool(_smtp_settings())
    return jsonify({"settings": settings})


@notifications_bp.patch("/notifications/settings")
def update_notification_settings():
    actor = _current_user()
    if not actor:
        return jsonify({"message": "请先登录"}), 401
    ensure_notification_tables()
    payload = request.get_json(silent=True) or {}
    in_app = 1 if payload.get("inAppEnabled", True) else 0
    email_enabled = 1 if payload.get("emailEnabled", False) else 0
    email = _normalise_email(str(payload.get("email") or ""))
    if email_enabled and (not email or len(email) > 200):
        return jsonify({"message": "请填写有效邮箱后再开启邮件通知"}), 400
    # The settings table intentionally caps addresses at 200 characters.
    # Reject an overlong address rather than truncating it into a different
    # (possibly valid-looking) recipient.
    if email and len(email) > 200:
        return jsonify({"message": "邮箱地址过长"}), 400
    db.session.execute(
        text(
            """
            INSERT INTO couple_notification_settings(user_id,in_app_enabled,email_enabled,email)
            VALUES(:uid,:in_app,:email_enabled,:email)
            ON DUPLICATE KEY UPDATE in_app_enabled=:in_app,email_enabled=:email_enabled,email=:email
            """
        ),
        {"uid": actor["user_id"], "in_app": in_app, "email_enabled": email_enabled, "email": email},
    )
    db.session.commit()
    return jsonify({"success": True, "settings": {"inAppEnabled": bool(in_app), "emailEnabled": bool(email_enabled), "email": email, "emailAvailable": bool(_smtp_settings())}})
