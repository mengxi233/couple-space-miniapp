"""Private two-person question board with answers, comments and reactions."""

import json
from datetime import datetime

from flask import Blueprint, jsonify, request
from sqlalchemy import text

from app.extensions import db
from app.routes.couple_api_routes import _current_user, _ensure_tables as _ensure_couple_tables
from app.routes.notifications_api_routes import create_notification, ensure_notification_tables


question_board_bp = Blueprint("couple_question_board", __name__, url_prefix="/api/couple")
MEMBER_ROLES = {"owner", "member"}
TARGET_TYPES = {"question", "answer", "comment"}


def _ensure_question_tables():
    _ensure_couple_tables()
    ensure_notification_tables()
    statements = [
        """
        CREATE TABLE IF NOT EXISTS couple_questions (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            couple_id INT NOT NULL,
            author_id INT NOT NULL,
            recipient_id INT NOT NULL,
            title VARCHAR(160) NOT NULL,
            body TEXT NOT NULL,
            images_json TEXT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'pending',
            closed_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_questions_couple_status (couple_id,status,created_at),
            INDEX idx_questions_recipient (recipient_id,status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS couple_question_answers (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            question_id BIGINT NOT NULL,
            couple_id INT NOT NULL,
            author_id INT NOT NULL,
            body TEXT NOT NULL,
            images_json TEXT NULL,
            rating TINYINT NULL,
            rated_by INT NULL,
            rated_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_question_answer (question_id),
            INDEX idx_answers_couple (couple_id,created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS couple_question_comments (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            question_id BIGINT NOT NULL,
            answer_id BIGINT NULL,
            parent_id BIGINT NULL,
            couple_id INT NOT NULL,
            author_id INT NOT NULL,
            body TEXT NOT NULL,
            images_json TEXT NULL,
            deleted_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_question_comments (question_id,deleted_at,created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS couple_question_reactions (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            couple_id INT NOT NULL,
            user_id INT NOT NULL,
            target_type VARCHAR(16) NOT NULL,
            target_id BIGINT NOT NULL,
            value TINYINT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_question_reaction (user_id,target_type,target_id),
            INDEX idx_reaction_target (target_type,target_id,value)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
    ]
    for statement in statements:
        db.session.execute(text(statement))
    db.session.commit()


def _context():
    actor = _current_user()
    if not actor or not actor.get("user_id"):
        return None
    row = db.session.execute(text("""
        SELECT u.id AS user_id,u.nickname,u.avatar_url,m.couple_id,m.role
        FROM couple_users u JOIN couple_members m ON m.user_id=u.id
        WHERE u.id=:uid
    """), {"uid": actor["user_id"]}).mappings().first()
    if not row or row.get("role") not in MEMBER_ROLES:
        return None
    return dict(row)


def _member_or_error():
    context = _context()
    if not context:
        return None, (jsonify({"message": "请先登录并激活情侣身份"}), 403)
    return context, None


def _json_load(value, default=None):
    if not value:
        return [] if default is None else default
    try:
        parsed = json.loads(value)
        return parsed
    except (TypeError, ValueError):
        return [] if default is None else default


def _images(value):
    if not isinstance(value, list):
        return []
    result = []
    for item in value[:9]:
        url = item.get("url") if isinstance(item, dict) else item
        url = str(url or "").strip()
        if url.startswith(("https://", "http://")) and len(url) <= 1000:
            result.append(url)
    return result


def _iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


def _partner_id(context):
    return db.session.execute(text(
        "SELECT user_id FROM couple_members WHERE couple_id=:cid AND user_id<>:uid "
        "AND role IN ('owner','member') ORDER BY user_id LIMIT 1"
    ), {"cid": context["couple_id"], "uid": context["user_id"]}).scalar()


def _question_row(question_id, context):
    return db.session.execute(text("""
        SELECT q.*,author.nickname AS author_name,author.avatar_url AS author_avatar,
               recipient.nickname AS recipient_name,recipient.avatar_url AS recipient_avatar
        FROM couple_questions q
        JOIN couple_users author ON author.id=q.author_id
        JOIN couple_users recipient ON recipient.id=q.recipient_id
        WHERE q.id=:qid AND q.couple_id=:cid
    """), {"qid": question_id, "cid": context["couple_id"]}).mappings().first()


def _reaction(target_type, target_id, viewer_id):
    rows = db.session.execute(text("""
        SELECT value,COUNT(*) AS total FROM couple_question_reactions
        WHERE target_type=:kind AND target_id=:target GROUP BY value
    """), {"kind": target_type, "target": target_id}).mappings().all()
    counts = {int(row["value"]): int(row["total"]) for row in rows}
    mine = db.session.execute(text("""
        SELECT value FROM couple_question_reactions
        WHERE user_id=:uid AND target_type=:kind AND target_id=:target
    """), {"uid": viewer_id, "kind": target_type, "target": target_id}).scalar()
    return {"likes": counts.get(1, 0), "dislikes": counts.get(-1, 0), "myReaction": int(mine or 0)}


def _question_payload(row, context, include_body=True):
    result = {
        "id": int(row["id"]), "title": row.get("title") or "", "body": row.get("body") or "",
        "images": _json_load(row.get("images_json"), []), "status": row.get("status") or "pending",
        "authorId": int(row["author_id"]), "authorName": row.get("author_name") or "对方",
        "authorAvatar": row.get("author_avatar") or "", "recipientId": int(row["recipient_id"]),
        "recipientName": row.get("recipient_name") or "对方", "recipientAvatar": row.get("recipient_avatar") or "",
        "createdAt": _iso(row.get("created_at")), "updatedAt": _iso(row.get("updated_at")),
        "closedAt": _iso(row.get("closed_at")), "isAuthor": int(row["author_id"]) == int(context["user_id"]),
        "isRecipient": int(row["recipient_id"]) == int(context["user_id"]),
    }
    if not include_body:
        result["body"] = (result["body"][:90] + "…") if len(result["body"]) > 90 else result["body"]
    result.update(_reaction("question", row["id"], context["user_id"]))
    return result


def _answer_payload(row, context):
    result = {
        "id": int(row["id"]), "questionId": int(row["question_id"]), "body": row.get("body") or "",
        "images": _json_load(row.get("images_json"), []), "authorId": int(row["author_id"]),
        "authorName": row.get("author_name") or "对方", "authorAvatar": row.get("author_avatar") or "",
        "rating": int(row["rating"]) if row.get("rating") is not None else None,
        "createdAt": _iso(row.get("created_at")), "updatedAt": _iso(row.get("updated_at")),
        "isAuthor": int(row["author_id"]) == int(context["user_id"]),
    }
    result.update(_reaction("answer", row["id"], context["user_id"]))
    return result


def _comment_payload(row, context):
    result = {
        "id": int(row["id"]), "questionId": int(row["question_id"]),
        "parentId": int(row["parent_id"]) if row.get("parent_id") else None,
        "body": row.get("body") or "", "images": _json_load(row.get("images_json"), []),
        "authorId": int(row["author_id"]), "authorName": row.get("author_name") or "对方",
        "authorAvatar": row.get("author_avatar") or "", "createdAt": _iso(row.get("created_at")),
        "updatedAt": _iso(row.get("updated_at")),
        "isAuthor": int(row["author_id"]) == int(context["user_id"]),
    }
    result.update(_reaction("comment", row["id"], context["user_id"]))
    return result


def _notify(context, recipient_id, title, content, event_type, question_id):
    if not recipient_id or int(recipient_id) == int(context["user_id"]):
        return
    create_notification(
        context["couple_id"], recipient_id, title, content,
        notification_type=event_type,
        payload={"questionId": int(question_id), "path": f"/package-question-board/pages/detail/detail?id={int(question_id)}"},
        ensure=False,
    )


@question_board_bp.get("/questions")
def list_questions():
    _ensure_question_tables()
    context, error = _member_or_error()
    if error:
        return error
    status = str(request.args.get("status") or "all").strip().lower()
    if status not in {"all", "pending", "answered", "closed"}:
        return jsonify({"message": "问题状态不正确"}), 400
    try:
        limit = max(1, min(int(request.args.get("limit", 30)), 50))
        offset = max(0, int(request.args.get("offset", 0)))
    except (TypeError, ValueError):
        return jsonify({"message": "分页参数不正确"}), 400
    clause = "q.couple_id=:cid"
    params = {"cid": context["couple_id"], "limit": limit, "offset": offset}
    if status != "all":
        clause += " AND q.status=:status"
        params["status"] = status
    rows = db.session.execute(text(f"""
        SELECT q.*,author.nickname AS author_name,author.avatar_url AS author_avatar,
               recipient.nickname AS recipient_name,recipient.avatar_url AS recipient_avatar,
               (SELECT COUNT(*) FROM couple_question_comments c WHERE c.question_id=q.id AND c.deleted_at IS NULL) AS comment_count,
               (SELECT id FROM couple_question_answers a WHERE a.question_id=q.id LIMIT 1) AS answer_id,
               (SELECT rating FROM couple_question_answers a WHERE a.question_id=q.id LIMIT 1) AS answer_rating
        FROM couple_questions q
        JOIN couple_users author ON author.id=q.author_id
        JOIN couple_users recipient ON recipient.id=q.recipient_id
        WHERE {clause} ORDER BY q.updated_at DESC,q.id DESC LIMIT :limit OFFSET :offset
    """), params).mappings().all()
    total = db.session.execute(text(f"SELECT COUNT(*) FROM couple_questions q WHERE {clause}"), params).scalar()
    items = []
    for row in rows:
        item = _question_payload(row, context, include_body=False)
        item.update({"commentCount": int(row.get("comment_count") or 0),
                     "hasAnswer": bool(row.get("answer_id")),
                     "rating": int(row["answer_rating"]) if row.get("answer_rating") is not None else None})
        items.append(item)
    counts = db.session.execute(text("""
        SELECT status,COUNT(*) AS total FROM couple_questions WHERE couple_id=:cid GROUP BY status
    """), {"cid": context["couple_id"]}).mappings().all()
    summary = {row["status"]: int(row["total"]) for row in counts}
    return jsonify({"questions": items, "total": int(total or 0), "hasMore": offset + len(items) < int(total or 0),
                    "summary": {"pending": summary.get("pending", 0), "answered": summary.get("answered", 0), "closed": summary.get("closed", 0)}})


@question_board_bp.post("/questions")
def create_question():
    _ensure_question_tables()
    context, error = _member_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title") or "").strip()
    body = str(payload.get("body") or "").strip()
    if not title:
        return jsonify({"message": "请写下问题标题"}), 400
    if len(title) > 160 or len(body) > 10000:
        return jsonify({"message": "问题内容过长"}), 400
    partner = _partner_id(context)
    if not partner:
        return jsonify({"message": "还没有找到可以提问的另一半"}), 409
    images = _images(payload.get("images"))
    result = db.session.execute(text("""
        INSERT INTO couple_questions(couple_id,author_id,recipient_id,title,body,images_json)
        VALUES(:cid,:uid,:recipient,:title,:body,:images)
    """), {"cid": context["couple_id"], "uid": context["user_id"], "recipient": partner,
           "title": title, "body": body, "images": json.dumps(images, ensure_ascii=False)})
    question_id = result.lastrowid
    _notify(context, partner, "对方想问你一个问题", f"{context.get('nickname') or '对方'}：{title}", "question_created", question_id)
    db.session.commit()
    response = get_question(question_id)
    response.status_code = 201
    return response


@question_board_bp.get("/questions/<int:question_id>")
def get_question(question_id):
    _ensure_question_tables()
    context, error = _member_or_error()
    if error:
        return error
    row = _question_row(question_id, context)
    if not row:
        return jsonify({"message": "问题不存在或无权查看"}), 404
    answer_row = db.session.execute(text("""
        SELECT a.*,u.nickname AS author_name,u.avatar_url AS author_avatar
        FROM couple_question_answers a JOIN couple_users u ON u.id=a.author_id
        WHERE a.question_id=:qid AND a.couple_id=:cid LIMIT 1
    """), {"qid": question_id, "cid": context["couple_id"]}).mappings().first()
    comments = db.session.execute(text("""
        SELECT c.*,u.nickname AS author_name,u.avatar_url AS author_avatar
        FROM couple_question_comments c JOIN couple_users u ON u.id=c.author_id
        WHERE c.question_id=:qid AND c.couple_id=:cid AND c.deleted_at IS NULL
        ORDER BY c.id ASC LIMIT 300
    """), {"qid": question_id, "cid": context["couple_id"]}).mappings().all()
    return jsonify({"question": _question_payload(row, context),
                    "answer": _answer_payload(answer_row, context) if answer_row else None,
                    "comments": [_comment_payload(comment, context) for comment in comments]})


@question_board_bp.patch("/questions/<int:question_id>")
def update_question(question_id):
    _ensure_question_tables()
    context, error = _member_or_error()
    if error:
        return error
    row = _question_row(question_id, context)
    if not row:
        return jsonify({"message": "问题不存在"}), 404
    if int(row["author_id"]) != int(context["user_id"]):
        return jsonify({"message": "只有提问者可以修改问题"}), 403
    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title", row["title"]) or "").strip()
    body = str(payload.get("body", row["body"]) or "").strip()
    status = str(payload.get("status", row["status"]) or row["status"]).lower()
    if not title or len(title) > 160 or len(body) > 10000 or status not in {"pending", "answered", "closed"}:
        return jsonify({"message": "问题内容或状态不正确"}), 400
    images = _images(payload.get("images", _json_load(row.get("images_json"), [])))
    db.session.execute(text("""
        UPDATE couple_questions SET title=:title,body=:body,images_json=:images,status=:status,
        closed_at=CASE WHEN :status='closed' THEN COALESCE(closed_at,CURRENT_TIMESTAMP) ELSE NULL END
        WHERE id=:qid AND couple_id=:cid
    """), {"title": title, "body": body, "images": json.dumps(images, ensure_ascii=False),
           "status": status, "qid": question_id, "cid": context["couple_id"]})
    db.session.commit()
    return get_question(question_id)


@question_board_bp.delete("/questions/<int:question_id>")
def delete_question(question_id):
    _ensure_question_tables()
    context, error = _member_or_error()
    if error:
        return error
    row = _question_row(question_id, context)
    if not row:
        return jsonify({"message": "问题不存在"}), 404
    if int(row["author_id"]) != int(context["user_id"]):
        return jsonify({"message": "只有提问者可以删除问题"}), 403
    answer_ids = [item[0] for item in db.session.execute(text(
        "SELECT id FROM couple_question_answers WHERE question_id=:qid AND couple_id=:cid"
    ), {"qid": question_id, "cid": context["couple_id"]}).all()]
    comment_ids = [item[0] for item in db.session.execute(text(
        "SELECT id FROM couple_question_comments WHERE question_id=:qid AND couple_id=:cid"
    ), {"qid": question_id, "cid": context["couple_id"]}).all()]
    db.session.execute(text("DELETE FROM couple_question_reactions WHERE couple_id=:cid AND ((target_type='question' AND target_id=:qid) OR (target_type='answer' AND target_id IN (SELECT id FROM couple_question_answers WHERE question_id=:qid)) OR (target_type='comment' AND target_id IN (SELECT id FROM couple_question_comments WHERE question_id=:qid)))"), {"cid": context["couple_id"], "qid": question_id})
    db.session.execute(text("DELETE FROM couple_question_comments WHERE question_id=:qid AND couple_id=:cid"), {"qid": question_id, "cid": context["couple_id"]})
    db.session.execute(text("DELETE FROM couple_question_answers WHERE question_id=:qid AND couple_id=:cid"), {"qid": question_id, "cid": context["couple_id"]})
    db.session.execute(text("DELETE FROM couple_questions WHERE id=:qid AND couple_id=:cid"), {"qid": question_id, "cid": context["couple_id"]})
    db.session.commit()
    return jsonify({"success": True, "deletedAnswerIds": answer_ids, "deletedCommentIds": comment_ids})


@question_board_bp.put("/questions/<int:question_id>/answer")
def save_answer(question_id):
    _ensure_question_tables()
    context, error = _member_or_error()
    if error:
        return error
    question = _question_row(question_id, context)
    if not question:
        return jsonify({"message": "问题不存在"}), 404
    if question["status"] == "closed":
        return jsonify({"message": "问题已结束，不能继续回答"}), 409
    if int(question["recipient_id"]) != int(context["user_id"]):
        return jsonify({"message": "这个问题需要由对方回答"}), 403
    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body") or "").strip()
    if not body and not payload.get("images"):
        return jsonify({"message": "请写下回答或添加图片"}), 400
    if len(body) > 10000:
        return jsonify({"message": "回答不能超过10000个字"}), 400
    images = _images(payload.get("images"))
    existing = db.session.execute(text("SELECT id FROM couple_question_answers WHERE question_id=:qid"), {"qid": question_id}).scalar()
    if existing:
        db.session.execute(text("UPDATE couple_question_answers SET body=:body,images_json=:images WHERE id=:id AND author_id=:uid"),
                           {"body": body, "images": json.dumps(images, ensure_ascii=False), "id": existing, "uid": context["user_id"]})
        answer_id = existing
    else:
        result = db.session.execute(text("""
            INSERT INTO couple_question_answers(question_id,couple_id,author_id,body,images_json)
            VALUES(:qid,:cid,:uid,:body,:images)
        """), {"qid": question_id, "cid": context["couple_id"], "uid": context["user_id"],
               "body": body, "images": json.dumps(images, ensure_ascii=False)})
        answer_id = result.lastrowid
    db.session.execute(text("UPDATE couple_questions SET status='answered' WHERE id=:qid AND couple_id=:cid"),
                       {"qid": question_id, "cid": context["couple_id"]})
    _notify(context, question["author_id"], "你的问题有新回答", f"{context.get('nickname') or '对方'} 回答了：{question['title']}", "question_answered", question_id)
    db.session.commit()
    return get_question(question_id)


@question_board_bp.put("/questions/<int:question_id>/rating")
def rate_answer(question_id):
    _ensure_question_tables()
    context, error = _member_or_error()
    if error:
        return error
    question = _question_row(question_id, context)
    if not question:
        return jsonify({"message": "问题不存在"}), 404
    if int(question["author_id"]) != int(context["user_id"]):
        return jsonify({"message": "只有提问者可以评分"}), 403
    raw_score = (request.get_json(silent=True) or {}).get("score")
    try:
        score = int(raw_score)
    except (TypeError, ValueError):
        return jsonify({"message": "评分应为0到10的整数"}), 400
    if score < 0 or score > 10:
        return jsonify({"message": "评分应为0到10的整数"}), 400
    answer = db.session.execute(text("SELECT id,author_id FROM couple_question_answers WHERE question_id=:qid AND couple_id=:cid"),
                                {"qid": question_id, "cid": context["couple_id"]}).mappings().first()
    if not answer:
        return jsonify({"message": "对方回答后才能评分"}), 409
    db.session.execute(text("UPDATE couple_question_answers SET rating=:score,rated_by=:uid,rated_at=CURRENT_TIMESTAMP WHERE id=:id"),
                       {"score": score, "uid": context["user_id"], "id": answer["id"]})
    _notify(context, answer["author_id"], "你的回答收到评分", f"{context.get('nickname') or '对方'} 给回答打了 {score}/10 分", "question_rated", question_id)
    db.session.commit()
    return get_question(question_id)


@question_board_bp.post("/questions/<int:question_id>/comments")
def create_comment(question_id):
    _ensure_question_tables()
    context, error = _member_or_error()
    if error:
        return error
    question = _question_row(question_id, context)
    if not question:
        return jsonify({"message": "问题不存在"}), 404
    if question["status"] == "closed":
        return jsonify({"message": "问题已结束，不能继续评论"}), 409
    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body") or "").strip()
    images = _images(payload.get("images"))
    if not body and not images:
        return jsonify({"message": "请写下评论或添加图片"}), 400
    if len(body) > 3000:
        return jsonify({"message": "评论不能超过3000个字"}), 400
    parent_id = payload.get("parentId")
    if parent_id:
        parent_id = db.session.execute(text("SELECT id FROM couple_question_comments WHERE id=:id AND question_id=:qid AND deleted_at IS NULL"),
                                       {"id": parent_id, "qid": question_id}).scalar()
        if not parent_id:
            return jsonify({"message": "回复的评论不存在"}), 404
    answer_id = db.session.execute(text("SELECT id FROM couple_question_answers WHERE question_id=:qid LIMIT 1"), {"qid": question_id}).scalar()
    if not answer_id:
        return jsonify({"message": "对方回答后才能继续评论"}), 409
    result = db.session.execute(text("""
        INSERT INTO couple_question_comments(question_id,answer_id,parent_id,couple_id,author_id,body,images_json)
        VALUES(:qid,:answer,:parent,:cid,:uid,:body,:images)
    """), {"qid": question_id, "answer": answer_id, "parent": parent_id, "cid": context["couple_id"],
           "uid": context["user_id"], "body": body, "images": json.dumps(images, ensure_ascii=False)})
    recipient = question["recipient_id"] if int(question["author_id"]) == int(context["user_id"]) else question["author_id"]
    _notify(context, recipient, "问题里有一条新留言", f"{context.get('nickname') or '对方'} 评论了：{question['title']}", "question_commented", question_id)
    db.session.commit()
    return jsonify({"success": True, "commentId": result.lastrowid})


@question_board_bp.delete("/questions/<int:question_id>/comments/<int:comment_id>")
def delete_comment(question_id, comment_id):
    _ensure_question_tables()
    context, error = _member_or_error()
    if error:
        return error
    result = db.session.execute(text("""
        UPDATE couple_question_comments SET deleted_at=CURRENT_TIMESTAMP
        WHERE id=:id AND question_id=:qid AND couple_id=:cid AND author_id=:uid AND deleted_at IS NULL
    """), {"id": comment_id, "qid": question_id, "cid": context["couple_id"], "uid": context["user_id"]})
    db.session.commit()
    if not result.rowcount:
        return jsonify({"message": "评论不存在或无权删除"}), 404
    return jsonify({"success": True})


def _target_exists(target_type, target_id, context):
    table = {"question": "couple_questions", "answer": "couple_question_answers", "comment": "couple_question_comments"}[target_type]
    extra = " AND deleted_at IS NULL" if target_type == "comment" else ""
    return bool(db.session.execute(text(f"SELECT id FROM {table} WHERE id=:id AND couple_id=:cid{extra}"),
                                   {"id": target_id, "cid": context["couple_id"]}).scalar())


@question_board_bp.put("/question-reactions")
def set_reaction():
    _ensure_question_tables()
    context, error = _member_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    target_type = str(payload.get("targetType") or "").lower()
    try:
        target_id = int(payload.get("targetId"))
        value = int(payload.get("value", 0))
    except (TypeError, ValueError):
        return jsonify({"message": "互动参数不正确"}), 400
    if target_type not in TARGET_TYPES or value not in {-1, 0, 1} or not _target_exists(target_type, target_id, context):
        return jsonify({"message": "互动目标或类型不正确"}), 400
    if value == 0:
        db.session.execute(text("DELETE FROM couple_question_reactions WHERE user_id=:uid AND target_type=:kind AND target_id=:target"),
                           {"uid": context["user_id"], "kind": target_type, "target": target_id})
    else:
        db.session.execute(text("""
            INSERT INTO couple_question_reactions(couple_id,user_id,target_type,target_id,value)
            VALUES(:cid,:uid,:kind,:target,:value)
            ON DUPLICATE KEY UPDATE value=:value
        """), {"cid": context["couple_id"], "uid": context["user_id"], "kind": target_type,
               "target": target_id, "value": value})
    db.session.commit()
    return jsonify({"reaction": _reaction(target_type, target_id, context["user_id"])})
