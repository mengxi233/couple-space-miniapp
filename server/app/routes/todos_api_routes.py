"""Shared, mobile-first todo APIs for the couple mini-program.

The older ``/tasks`` endpoints are kept for backwards compatibility.  The
v1.4 todo API lives under ``/todos`` and stores the Markdown source plus
structured metadata (dates, assignee, location and extensibility JSON).
Guests can read public todos; bound couple members can mutate them.
"""

from datetime import datetime, timezone
import json

from flask import Blueprint, jsonify, request
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.routes.couple_api_routes import _current_user, _ensure_tables as _ensure_couple_tables


todo_bp = Blueprint("couple_todos", __name__, url_prefix="/api/couple")
MEMBER_ROLES = {"owner", "member"}
PRIORITIES = {"normal", "important", "urgent"}


def _ensure_todo_tables():
    _ensure_couple_tables()
    db.session.execute(text("""
        CREATE TABLE IF NOT EXISTS couple_todos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            couple_id INT NOT NULL,
            creator_id INT NOT NULL,
            assignee_id INT NULL,
            title VARCHAR(160) NOT NULL,
            markdown_body TEXT NULL,
            priority VARCHAR(16) NOT NULL DEFAULT 'normal',
            tags_json TEXT NULL,
            due_date DATE NULL,
            due_time TIME NULL,
            location_json TEXT NULL,
            links_json TEXT NULL,
            attachments_json TEXT NULL,
            extensions_json TEXT NULL,
            is_completed TINYINT(1) NOT NULL DEFAULT 0,
            completed_by INT NULL,
            completed_at DATETIME NULL,
            is_public TINYINT(1) NOT NULL DEFAULT 1,
            sort_order INT NOT NULL DEFAULT 0,
            deleted_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_todos_couple_state (couple_id, is_completed, deleted_at),
            INDEX idx_todos_couple_due (couple_id, due_date, due_time),
            INDEX idx_todos_assignee (assignee_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    db.session.execute(text("""
        CREATE TABLE IF NOT EXISTS couple_todo_events (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            todo_id INT NOT NULL,
            couple_id INT NOT NULL,
            user_id INT NOT NULL,
            action VARCHAR(32) NOT NULL,
            payload_json TEXT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_todo_events (todo_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    # The project historically had an experimental todo table on a few
    # deployments.  Add any v1.4 columns that are missing instead of assuming
    # CREATE TABLE IF NOT EXISTS can migrate that table for us.
    existing = {row[0] for row in db.session.execute(text(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='couple_todos'"
    )).all()}
    migrations = {
        "assignee_id": "INT NULL", "markdown_body": "TEXT NULL",
        "priority": "VARCHAR(16) NOT NULL DEFAULT 'normal'", "tags_json": "TEXT NULL",
        "due_date": "DATE NULL", "due_time": "TIME NULL", "location_json": "TEXT NULL",
        "links_json": "TEXT NULL", "attachments_json": "TEXT NULL", "extensions_json": "TEXT NULL",
        "is_completed": "TINYINT(1) NOT NULL DEFAULT 0", "completed_by": "INT NULL",
        "completed_at": "DATETIME NULL", "is_public": "TINYINT(1) NOT NULL DEFAULT 1",
        "sort_order": "INT NOT NULL DEFAULT 0", "deleted_at": "DATETIME NULL",
        "created_at": "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP",
        "updated_at": "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
        "last_editor_id": "INT NULL",
    }
    for column, definition in migrations.items():
        if column not in existing:
            db.session.execute(text(f"ALTER TABLE couple_todos ADD COLUMN {column} {definition}"))
    db.session.commit()


def _json_load(value, default):
    if not value:
        return default
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, type(default)) else default
    except (TypeError, ValueError):
        return default


def _json_dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _iso(value):
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _actor_context():
    actor = _current_user()
    if not actor or not actor.get("user_id"):
        return None
    row = db.session.execute(text("""
        SELECT u.id AS user_id, u.nickname, u.avatar_url, m.couple_id, m.role
        FROM couple_users u
        LEFT JOIN couple_members m ON m.user_id=u.id
        WHERE u.id=:uid
    """), {"uid": actor["user_id"]}).mappings().first()
    if not row:
        return None
    result = dict(row)
    result["role"] = result.get("role") or "guest"
    return result


def _default_couple_id():
    row = db.session.execute(text("SELECT id FROM couple_spaces ORDER BY id LIMIT 1")).first()
    return row[0] if row else None


def _read_scope():
    context = _actor_context()
    if context and context.get("couple_id"):
        return context["couple_id"], context, False
    return _default_couple_id(), context, True


def _member_or_error():
    context = _actor_context()
    if not context:
        return None, (jsonify({"message": "请先登录"}), 401)
    if not context.get("couple_id") or context.get("role") not in MEMBER_ROLES:
        return None, (jsonify({"message": "请先绑定情侣空间"}), 403)
    return context, None


def _parse_date(value):
    if value in (None, ""):
        return None
    value = str(value).strip()
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ValueError("截止日期格式应为 YYYY-MM-DD")
    return value


def _parse_time(value):
    if value in (None, ""):
        return None
    value = str(value).strip()
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            parsed = datetime.strptime(value, fmt)
            return parsed.strftime("%H:%M:%S")
        except ValueError:
            continue
    raise ValueError("时间格式应为 HH:MM")


def _normalise_tags(value):
    if value is None:
        return []
    if isinstance(value, str):
        value = [item.strip() for item in value.split(",")]
    if not isinstance(value, list):
        raise ValueError("标签必须是数组")
    result = []
    for item in value:
        item = str(item or "").strip()
        if item and item not in result:
            if len(item) > 24:
                raise ValueError("单个标签不能超过24个字")
            result.append(item)
    return result[:12]


def _normalise_object(value, name, max_length=12000):
    if value in (None, ""):
        return {} if name == "location" else [] if name in {"links", "attachments"} else {}
    if name == "location" and not isinstance(value, dict):
        raise ValueError("地址信息格式不正确")
    if name in {"links", "attachments"} and not isinstance(value, list):
        raise ValueError(f"{name} 必须是数组")
    if name == "extensions" and not isinstance(value, dict):
        raise ValueError("扩展信息格式不正确")
    encoded = _json_dump(value)
    if len(encoded) > max_length:
        raise ValueError(f"{name} 内容过长")
    return value


def _assignee_ok(couple_id, assignee_id):
    if assignee_id in (None, ""):
        return None
    try:
        assignee_id = int(assignee_id)
    except (TypeError, ValueError):
        raise ValueError("负责人不正确")
    row = db.session.execute(text(
        "SELECT user_id FROM couple_members WHERE couple_id=:cid AND user_id=:uid"
    ), {"cid": couple_id, "uid": assignee_id}).first()
    if not row:
        raise ValueError("负责人必须是情侣空间成员")
    return assignee_id


def _todo_payload(row, context=None):
    context = context or {}
    viewer = context.get("user_id")
    member = context.get("role") in MEMBER_ROLES and bool(context.get("couple_id"))
    completed = bool(row.get("is_completed"))
    return {
        "id": row.get("id"),
        "coupleId": row.get("couple_id"),
        "title": row.get("title") or "",
        "markdown": row.get("markdown_body") or "",
        "detail": row.get("markdown_body") or "",
        "priority": row.get("priority") or "normal",
        "tags": _json_load(row.get("tags_json"), []),
        "dueDate": _iso(row.get("due_date")),
        "dueTime": _iso(row.get("due_time")),
        "location": _json_load(row.get("location_json"), {}),
        "links": _json_load(row.get("links_json"), []),
        "attachments": _json_load(row.get("attachments_json"), []),
        "extensions": _json_load(row.get("extensions_json"), {}),
        "status": "completed" if completed else "pending",
        "isCompleted": completed,
        "creatorId": row.get("creator_id"),
        "creatorName": row.get("creator_name") or "新朋友",
        "creatorAvatar": row.get("creator_avatar") or "",
        "assigneeId": row.get("assignee_id"),
        "assigneeName": row.get("assignee_name") or "",
        "assigneeAvatar": row.get("assignee_avatar") or "",
        "completedBy": row.get("completed_by"),
        "completedByName": row.get("completed_by_name") or "",
        "completedAt": _iso(row.get("completed_at")),
        "isPublic": bool(row.get("is_public")),
        "sortOrder": int(row.get("sort_order") or 0),
        "createdAt": _iso(row.get("created_at")),
        "updatedAt": _iso(row.get("updated_at")),
        "lastEditorId": row.get("last_editor_id"),
        "lastEditorName": row.get("last_editor_name") or "",
        "canEdit": member,
        "canComplete": member,
        "canDelete": member,
        "isMine": bool(viewer and row.get("assignee_id") == viewer),
    }


TODO_SELECT = """
    SELECT t.*, creator.nickname AS creator_name, creator.avatar_url AS creator_avatar,
           assignee.nickname AS assignee_name, assignee.avatar_url AS assignee_avatar,
           editor.nickname AS last_editor_name, completed.nickname AS completed_by_name
    FROM couple_todos t
    LEFT JOIN couple_users creator ON creator.id=t.creator_id
    LEFT JOIN couple_users assignee ON assignee.id=t.assignee_id
    LEFT JOIN couple_users editor ON editor.id=t.last_editor_id
    LEFT JOIN couple_users completed ON completed.id=t.completed_by
"""


def _todo_row(todo_id, couple_id, public_only=False):
    clauses = ["t.id=:tid", "t.couple_id=:cid", "t.deleted_at IS NULL"]
    if public_only:
        clauses.append("t.is_public=1")
    return db.session.execute(text(TODO_SELECT + " WHERE " + " AND ".join(clauses) + " LIMIT 1"), {
        "tid": todo_id, "cid": couple_id
    }).mappings().first()


def _record_event(todo_id, couple_id, user_id, action, payload=None):
    db.session.execute(text("""
        INSERT INTO couple_todo_events(todo_id,couple_id,user_id,action,payload_json)
        VALUES(:tid,:cid,:uid,:action,:payload)
    """), {"tid": todo_id, "cid": couple_id, "uid": user_id,
            "action": action, "payload": _json_dump(payload or {})})


@todo_bp.get("/todos")
def list_todos():
    _ensure_todo_tables()
    couple_id, context, guest = _read_scope()
    if not couple_id:
        return jsonify({"todos": [], "role": "guest", "coupleId": None, "total": 0})
    status = (request.args.get("status") or "all").strip().lower()
    if status not in {"all", "pending", "completed"}:
        return jsonify({"message": "status 只能是 all、pending 或 completed"}), 400
    scope = (request.args.get("scope") or "all").strip().lower()
    priority = (request.args.get("priority") or "").strip().lower()
    date_scope = (request.args.get("dateScope") or "").strip().lower()
    keyword = (request.args.get("q") or "").strip()
    tag = (request.args.get("tag") or "").strip()
    sort = (request.args.get("sort") or "due").strip().lower()
    try:
        limit = min(max(int(request.args.get("limit", 50)), 1), 100)
        offset = max(int(request.args.get("offset", 0)), 0)
    except (TypeError, ValueError):
        limit, offset = 50, 0
    clauses = ["t.couple_id=:cid", "t.deleted_at IS NULL"]
    params = {"cid": couple_id, "viewer_id": (context or {}).get("user_id") or -1,
              "limit": limit, "offset": offset}
    if guest:
        clauses.append("t.is_public=1")
    if status == "pending":
        clauses.append("t.is_completed=0")
    elif status == "completed":
        clauses.append("t.is_completed=1")
    if scope == "mine" and params["viewer_id"] > 0:
        clauses.append("t.assignee_id=:viewer_id")
    elif scope == "unassigned":
        clauses.append("t.assignee_id IS NULL")
    if priority in PRIORITIES:
        clauses.append("t.priority=:priority")
        params["priority"] = priority
    if tag:
        clauses.append("COALESCE(t.tags_json,'') LIKE :tag")
        params["tag"] = f'%"{tag.replace(chr(34), chr(92)+chr(34))}"%'
    if keyword:
        clauses.append("(t.title LIKE :keyword OR COALESCE(t.markdown_body,'') LIKE :keyword)")
        params["keyword"] = f"%{keyword}%"
    if date_scope == "today":
        clauses.append("t.due_date=CURDATE()")
    elif date_scope == "upcoming":
        clauses.append("t.due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)")
    elif date_scope == "overdue":
        clauses.append("t.due_date < CURDATE() AND t.is_completed=0")
    if sort == "created":
        order = "t.created_at DESC, t.id DESC"
    elif sort == "updated":
        order = "t.updated_at DESC, t.id DESC"
    elif sort == "priority":
        order = "FIELD(t.priority,'urgent','important','normal'), t.due_date IS NULL, t.due_date ASC, t.sort_order ASC"
    else:
        order = "t.is_completed ASC, t.due_date IS NULL ASC, t.due_date ASC, t.due_time IS NULL ASC, t.due_time ASC, t.sort_order ASC, t.id DESC"
    where = " AND ".join(clauses)
    rows = db.session.execute(text(TODO_SELECT + f" WHERE {where} ORDER BY {order} LIMIT :limit OFFSET :offset"), params).mappings().all()
    count_params = {key: value for key, value in params.items() if key not in {"limit", "offset"}}
    total = db.session.execute(text(f"SELECT COUNT(*) FROM couple_todos t WHERE {where}"), count_params).scalar()
    summary_clauses = ["couple_id=:cid", "deleted_at IS NULL"]
    summary_params = {"cid": couple_id}
    if guest:
        summary_clauses.append("is_public=1")
    summary = db.session.execute(text(
        "SELECT "
        "COALESCE(SUM(CASE WHEN is_completed=0 THEN 1 ELSE 0 END),0) AS pending_count, "
        "COALESCE(SUM(CASE WHEN is_completed=1 THEN 1 ELSE 0 END),0) AS completed_count "
        f"FROM couple_todos WHERE {' AND '.join(summary_clauses)}"
    ), summary_params).mappings().first()
    members = db.session.execute(text("""
        SELECT u.id,u.nickname,u.avatar_url,m.role
        FROM couple_members m JOIN couple_users u ON u.id=m.user_id
        WHERE m.couple_id=:cid ORDER BY m.role,u.id
    """), {"cid": couple_id}).mappings().all()
    return jsonify({"todos": [_todo_payload(dict(row), context) for row in rows],
                    "members": [{"id": row["id"], "nickname": row.get("nickname") or "新朋友",
                                 "avatarUrl": row.get("avatar_url") or "", "role": row.get("role")}
                                for row in members],
                    "role": (context or {}).get("role", "guest"), "coupleId": couple_id,
                    "total": int(total or 0), "hasMore": offset + len(rows) < int(total or 0),
                    "pendingCount": int((summary or {}).get("pending_count") or 0),
                    "completedCount": int((summary or {}).get("completed_count") or 0)})


@todo_bp.get("/todos/<int:todo_id>")
def get_todo(todo_id):
    _ensure_todo_tables()
    couple_id, context, guest = _read_scope()
    row = _todo_row(todo_id, couple_id, public_only=guest) if couple_id else None
    if not row:
        return jsonify({"message": "待办不存在或无权查看"}), 404
    item = _todo_payload(dict(row), context)
    events = db.session.execute(text("""
        SELECT e.id,e.action,e.payload_json,e.created_at,e.user_id,u.nickname
        FROM couple_todo_events e LEFT JOIN couple_users u ON u.id=e.user_id
        WHERE e.todo_id=:tid ORDER BY e.id DESC LIMIT 100
    """), {"tid": todo_id}).mappings().all()
    item["events"] = [{"id": row["id"], "action": row["action"],
                       "payload": _json_load(row.get("payload_json"), {}),
                       "userId": row["user_id"], "userName": row.get("nickname") or "新朋友",
                       "createdAt": _iso(row.get("created_at"))} for row in events]
    return jsonify({"todo": item})


def _normalise_payload(payload, context, current=None):
    current = current or {}
    title = str(payload.get("title", current.get("title", "")) or "").strip()
    markdown = payload.get("markdown", payload.get("detail", current.get("markdown_body", "")))
    markdown = str(markdown or "")
    if not title:
        raise ValueError("待办标题不能为空")
    if len(title) > 160:
        raise ValueError("待办标题不能超过160个字")
    if len(markdown) > 10000:
        raise ValueError("Markdown详情不能超过10000个字")
    priority = str(payload.get("priority", current.get("priority", "normal")) or "normal").strip().lower()
    if priority not in PRIORITIES:
        raise ValueError("优先级不正确")
    due_date = _parse_date(payload.get("dueDate", current.get("due_date")))
    due_time = _parse_time(payload.get("dueTime", current.get("due_time")))
    tags = _normalise_tags(payload.get("tags", _json_load(current.get("tags_json"), [])))
    assignee = _assignee_ok(context["couple_id"], payload.get("assigneeId", current.get("assignee_id")))
    location = _normalise_object(payload.get("location", _json_load(current.get("location_json"), {})), "location")
    links = _normalise_object(payload.get("links", _json_load(current.get("links_json"), [])), "links")
    attachments = _normalise_object(payload.get("attachments", _json_load(current.get("attachments_json"), [])), "attachments")
    extensions = _normalise_object(payload.get("extensions", _json_load(current.get("extensions_json"), {})), "extensions")
    return {"title": title, "markdown": markdown, "priority": priority, "due_date": due_date,
            "due_time": due_time, "tags": tags, "assignee_id": assignee, "location": location,
            "links": links, "attachments": attachments, "extensions": extensions,
            "is_public": 1 if payload.get("isPublic", current.get("is_public", 1)) not in (False, 0, "0", "false") else 0}


@todo_bp.post("/todos")
def create_todo():
    _ensure_todo_tables()
    context, error = _member_or_error()
    if error:
        return error
    try:
        values = _normalise_payload(request.get_json(silent=True) or {}, context)
    except ValueError as exc:
        return jsonify({"message": str(exc)}), 400
    next_order = db.session.execute(text("SELECT COALESCE(MAX(sort_order),0)+1 FROM couple_todos WHERE couple_id=:cid AND deleted_at IS NULL"), {"cid": context["couple_id"]}).scalar()
    result = db.session.execute(text("""
        INSERT INTO couple_todos
        (couple_id,creator_id,assignee_id,title,markdown_body,priority,tags_json,due_date,due_time,
         location_json,links_json,attachments_json,extensions_json,is_public,sort_order,last_editor_id)
        VALUES(:cid,:uid,:assignee,:title,:markdown,:priority,:tags,:due_date,:due_time,
               :location,:links,:attachments,:extensions,:is_public,:sort_order,:uid)
    """), {"cid": context["couple_id"], "uid": context["user_id"], "assignee": values["assignee_id"],
            "title": values["title"], "markdown": values["markdown"], "priority": values["priority"],
            "tags": _json_dump(values["tags"]), "due_date": values["due_date"], "due_time": values["due_time"],
            "location": _json_dump(values["location"]), "links": _json_dump(values["links"]),
            "attachments": _json_dump(values["attachments"]), "extensions": _json_dump(values["extensions"]),
            "is_public": values["is_public"], "sort_order": int(next_order or 1)})
    _record_event(result.lastrowid, context["couple_id"], context["user_id"], "created", {"title": values["title"]})
    db.session.commit()
    row = _todo_row(result.lastrowid, context["couple_id"])
    return jsonify({"todo": _todo_payload(dict(row), context)}), 201


@todo_bp.patch("/todos/<int:todo_id>")
def update_todo(todo_id):
    _ensure_todo_tables()
    context, error = _member_or_error()
    if error:
        return error
    # The subsequent UPDATE is scoped by couple and id; avoiding a dialect
    # specific row-lock clause keeps the endpoint usable in local SQLite tests
    # as well as the production MySQL container.
    row = db.session.execute(text("SELECT * FROM couple_todos WHERE id=:tid AND couple_id=:cid AND deleted_at IS NULL"), {"tid": todo_id, "cid": context["couple_id"]}).mappings().first()
    if not row:
        return jsonify({"message": "待办不存在"}), 404
    payload = request.get_json(silent=True) or {}
    try:
        values = _normalise_payload(payload, context, row)
    except ValueError as exc:
        db.session.rollback()
        return jsonify({"message": str(exc)}), 400
    completed = bool(row["is_completed"])
    if "completed" in payload or "isCompleted" in payload or "status" in payload:
        desired = payload.get("completed", payload.get("isCompleted", payload.get("status") == "completed"))
        completed = str(desired).lower() in {"1", "true", "yes", "completed", "done"}
    now = datetime.now(timezone.utc).replace(tzinfo=None) if completed else None
    completed_by = context["user_id"] if completed else None
    action = "updated"
    if completed != bool(row["is_completed"]):
        action = "completed" if completed else "reopened"
    db.session.execute(text("""
        UPDATE couple_todos SET assignee_id=:assignee,title=:title,markdown_body=:markdown,
        priority=:priority,tags_json=:tags,due_date=:due_date,due_time=:due_time,
        location_json=:location,links_json=:links,attachments_json=:attachments,extensions_json=:extensions,
        is_public=:is_public,is_completed=:completed,completed_by=:completed_by,completed_at=:completed_at,
        last_editor_id=:uid
        WHERE id=:tid AND couple_id=:cid
    """), {"assignee": values["assignee_id"], "title": values["title"], "markdown": values["markdown"],
            "priority": values["priority"], "tags": _json_dump(values["tags"]), "due_date": values["due_date"],
            "due_time": values["due_time"], "location": _json_dump(values["location"]), "links": _json_dump(values["links"]),
            "attachments": _json_dump(values["attachments"]), "extensions": _json_dump(values["extensions"]),
            "is_public": values["is_public"], "completed": completed, "completed_by": completed_by,
            "completed_at": now, "uid": context["user_id"], "tid": todo_id, "cid": context["couple_id"]})
    _record_event(todo_id, context["couple_id"], context["user_id"], action,
                  {"completed": completed, "title": values["title"]})
    db.session.commit()
    fresh = _todo_row(todo_id, context["couple_id"])
    return jsonify({"todo": _todo_payload(dict(fresh), context)})


@todo_bp.post("/todos/<int:todo_id>/complete")
def complete_todo(todo_id):
    payload = request.get_json(silent=True) or {}
    payload["completed"] = payload.get("completed", payload.get("isCompleted", True))
    # Keep one permission and validation path for checkbox and detail edits.
    request._cached_json = (payload, payload)
    return update_todo(todo_id)


@todo_bp.post("/todos/reorder")
def reorder_todos():
    _ensure_todo_tables()
    context, error = _member_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    ids = payload.get("ids") or []
    if not isinstance(ids, list) or len(ids) > 100:
        return jsonify({"message": "排序数据不正确"}), 400
    try:
        ids = [int(value) for value in ids]
    except (TypeError, ValueError):
        return jsonify({"message": "排序数据不正确"}), 400
    for index, todo_id in enumerate(ids):
        db.session.execute(text("""
            UPDATE couple_todos SET sort_order=:order_value,last_editor_id=:uid
            WHERE id=:tid AND couple_id=:cid AND deleted_at IS NULL
        """), {"order_value": index, "uid": context["user_id"], "tid": todo_id, "cid": context["couple_id"]})
    if ids:
        _record_event(ids[0], context["couple_id"], context["user_id"], "reordered", {"ids": ids})
    db.session.commit()
    return jsonify({"success": True})


@todo_bp.delete("/todos/<int:todo_id>")
def delete_todo(todo_id):
    _ensure_todo_tables()
    context, error = _member_or_error()
    if error:
        return error
    row = db.session.execute(text("SELECT id FROM couple_todos WHERE id=:tid AND couple_id=:cid AND deleted_at IS NULL"), {"tid": todo_id, "cid": context["couple_id"]}).first()
    if not row:
        return jsonify({"message": "待办不存在"}), 404
    db.session.execute(text("UPDATE couple_todos SET deleted_at=CURRENT_TIMESTAMP,last_editor_id=:uid WHERE id=:tid AND couple_id=:cid"), {"uid": context["user_id"], "tid": todo_id, "cid": context["couple_id"]})
    _record_event(todo_id, context["couple_id"], context["user_id"], "deleted")
    db.session.commit()
    return jsonify({"success": True, "id": todo_id})


@todo_bp.get("/todos/<int:todo_id>/events")
def list_todo_events(todo_id):
    _ensure_todo_tables()
    couple_id, context, guest = _read_scope()
    if not couple_id or not _todo_row(todo_id, couple_id, public_only=guest):
        return jsonify({"message": "待办不存在或无权查看"}), 404
    rows = db.session.execute(text("""
        SELECT e.id,e.action,e.payload_json,e.created_at,e.user_id,u.nickname
        FROM couple_todo_events e LEFT JOIN couple_users u ON u.id=e.user_id
        WHERE e.todo_id=:tid ORDER BY e.id DESC LIMIT 100
    """), {"tid": todo_id}).mappings().all()
    return jsonify({"events": [{"id": row["id"], "action": row["action"],
                                 "payload": _json_load(row.get("payload_json"), {}),
                                 "userId": row["user_id"], "userName": row.get("nickname") or "新朋友",
                                 "createdAt": _iso(row.get("created_at"))} for row in rows]})
