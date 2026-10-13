"""Authenticated image upload endpoint for the couple mini-program.

Files are stored in the existing ``share_data`` bind mount so uploads survive
container restarts.  The response uses the public HTTPS API URL, which can be
saved directly on calendar, task and menu records.  A later MinIO migration
only needs to replace this module's storage implementation.
"""

import os
import uuid

from flask import Blueprint, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename
from sqlalchemy import text

from app.extensions import db
from app.routes.couple_api_routes import _current_user, _ensure_tables


uploads_bp = Blueprint("couple_uploads", __name__, url_prefix="/api/couple")
UPLOAD_ROOT = os.getenv("COUPLE_UPLOAD_DIR", "/app/data/uploads")
MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "gif", "webp"}
ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def _member_context():
    actor = _current_user()
    if not actor or not actor.get("user_id"):
        return None
    _ensure_tables()
    member = db.session.execute(
        text("SELECT couple_id,role FROM couple_members WHERE user_id=:uid"),
        {"uid": actor["user_id"]},
    ).mappings().first()
    if not member or member.get("role") not in {"owner", "member"}:
        return None
    return {"user_id": actor["user_id"], **dict(member)}


@uploads_bp.post("/uploads/images")
def upload_image():
    context = _member_context()
    if not context:
        return jsonify({"message": "请先登录并绑定情侣空间"}), 403
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify({"message": "请选择图片"}), 400
    extension = secure_filename(uploaded.filename).rsplit(".", 1)[-1].lower()
    if extension not in ALLOWED_EXTENSIONS or uploaded.mimetype not in ALLOWED_MIME_TYPES:
        return jsonify({"message": "仅支持 JPG、PNG、GIF 或 WebP 图片"}), 400
    uploaded.stream.seek(0, os.SEEK_END)
    size = uploaded.stream.tell()
    uploaded.stream.seek(0)
    if size <= 0 or size > MAX_IMAGE_BYTES:
        return jsonify({"message": "图片大小需在 10MB 以内"}), 400
    os.makedirs(UPLOAD_ROOT, exist_ok=True)
    filename = f"{context['couple_id']}_{uuid.uuid4().hex}.{extension}"
    uploaded.save(os.path.join(UPLOAD_ROOT, filename))
    # OpenResty terminates TLS before forwarding to Flask, so request.host_url
    # may be http even though the public URL must be https for mini-programs.
    public_base = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    public_host = request.headers.get('X-Forwarded-Host') or request.host
    url = (f"{public_base}/api/couple/uploads/images/{filename}" if public_base
           else f"https://{public_host}/api/couple/uploads/images/{filename}")
    return jsonify({"url": url, "size": size, "filename": filename}), 201


@uploads_bp.get("/uploads/images/<path:filename>")
def get_image(filename):
    safe_name = secure_filename(filename)
    if not safe_name or safe_name != filename:
        return jsonify({"message": "图片不存在"}), 404
    return send_from_directory(UPLOAD_ROOT, safe_name, max_age=60 * 60 * 24 * 30)
