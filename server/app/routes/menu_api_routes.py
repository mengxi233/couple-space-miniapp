"""情侣菜单、购物车和订单接口。

菜单是情侣空间的子资源：未绑定用户可以只读浏览公开菜单，只有情侣成员
可以新增菜品、点赞、维护购物车和创建/处理订单。
"""

from datetime import datetime

from flask import Blueprint, jsonify, request
from sqlalchemy import text

from app.routes.couple_api_routes import _current_user


menu_bp = Blueprint("couple_menu", __name__, url_prefix="/api/couple/menu")


def _db():
    from app.extensions import db

    return db


def _ensure_menu_tables():
    """Create the lightweight menu schema lazily for existing deployments."""
    db = _db()
    statements = [
        """
        CREATE TABLE IF NOT EXISTS couple_menu_items (
            id INT AUTO_INCREMENT PRIMARY KEY,
            couple_id INT NOT NULL,
            creator_id INT NOT NULL,
            name VARCHAR(120) NOT NULL,
            category VARCHAR(60) NOT NULL DEFAULT '其他',
            description TEXT NOT NULL,
            image_url VARCHAR(500) NOT NULL DEFAULT '',
            points_price INT NOT NULL DEFAULT 0,
            sales INT NOT NULL DEFAULT 0,
            likes INT NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_menu_couple(couple_id, is_active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS couple_cart_items (
            user_id INT NOT NULL,
            item_id INT NOT NULL,
            quantity INT NOT NULL DEFAULT 1,
            note VARCHAR(300) NOT NULL DEFAULT '',
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY(user_id, item_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS couple_orders (
            id INT AUTO_INCREMENT PRIMARY KEY,
            couple_id INT NOT NULL,
            buyer_id INT NOT NULL,
            receiver_id INT NULL,
            total_points INT NOT NULL DEFAULT 0,
            note VARCHAR(300) NOT NULL DEFAULT '',
            status ENUM('pending','cooking','completed','cancelled') NOT NULL DEFAULT 'pending',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME NULL,
            INDEX idx_orders_couple(couple_id, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS couple_order_items (
            order_id INT NOT NULL,
            item_id INT NOT NULL,
            item_name VARCHAR(120) NOT NULL,
            unit_price INT NOT NULL,
            quantity INT NOT NULL,
            PRIMARY KEY(order_id, item_id),
            INDEX idx_order_items_order(order_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS couple_order_reviews (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id INT NOT NULL UNIQUE,
            author_id INT NOT NULL,
            content TEXT NOT NULL,
            image_url VARCHAR(500) NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_order_reviews_author(author_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
    ]
    for statement in statements:
        db.session.execute(text(statement))
    db.session.commit()


def _member_context():
    actor = _current_user()
    if not actor:
        return None, None
    db = _db()
    row = db.session.execute(
        text("SELECT couple_id, role FROM couple_members WHERE user_id=:uid"),
        {"uid": actor["user_id"]},
    ).mappings().first()
    return actor, row


def _member_or_error():
    actor, member = _member_context()
    if not actor:
        return None, None, (jsonify({"message": "请先登录"}), 401)
    if not member:
        return actor, None, (jsonify({"message": "请先绑定情侣空间"}), 403)
    return actor, member, None


def _public_couple_id():
    db = _db()
    return db.session.execute(text("SELECT id FROM couple_spaces ORDER BY id LIMIT 1")).scalar()


def _item_query(scope_id, category="", search=""):
    sql = (
        "SELECT id,name,category,description,image_url AS imageUrl,"
        "points_price AS pointsPrice,sales,likes,creator_id AS creatorId "
        "FROM couple_menu_items WHERE is_active=TRUE AND couple_id=:cid"
    )
    params = {"cid": scope_id}
    if category:
        sql += " AND category=:category"
        params["category"] = category
    if search:
        sql += " AND (name LIKE :search OR description LIKE :search)"
        params["search"] = f"%{search}%"
    sql += " ORDER BY category ASC, name ASC, id DESC"
    return sql, params


@menu_bp.get("/items")
def list_items():
    db = _db()
    _ensure_menu_tables()
    _, member = _member_context()
    scope_id = member["couple_id"] if member else _public_couple_id()
    if not scope_id:
        return jsonify({"items": [], "categories": []})
    category = (request.args.get("category") or "").strip()[:60]
    search = (request.args.get("search") or "").strip()[:100]
    sql, params = _item_query(scope_id, category, search)
    rows = db.session.execute(text(sql), params).mappings().all()
    category_rows = db.session.execute(
        text(
            "SELECT DISTINCT category FROM couple_menu_items "
            "WHERE couple_id=:cid AND is_active=TRUE ORDER BY category"
        ),
        {"cid": scope_id},
    ).scalars().all()
    return jsonify({"items": [dict(row) for row in rows], "categories": list(category_rows)})


@menu_bp.post("/items")
def create_item():
    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()
    category = str(payload.get("category") or "其他").strip() or "其他"
    description = str(payload.get("description") or "").strip()
    image = str(payload.get("imageUrl") or payload.get("image_url") or "").strip()
    try:
        price = int(payload.get("pointsPrice", payload.get("points_price", 0)) or 0)
    except (TypeError, ValueError):
        return jsonify({"message": "积分价格必须是整数"}), 400
    if not name:
        return jsonify({"message": "菜品名称不能为空"}), 400
    if len(name) > 120 or len(category) > 60 or len(description) > 5000 or len(image) > 500:
        return jsonify({"message": "菜品信息过长"}), 400
    if price < 0 or price > 100000000:
        return jsonify({"message": "积分价格范围无效"}), 400
    _ensure_menu_tables()
    result = db.session.execute(
        text(
            "INSERT INTO couple_menu_items "
            "(couple_id,creator_id,name,category,description,image_url,points_price) "
            "VALUES(:cid,:uid,:name,:category,:description,:image,:price)"
        ),
        {
            "cid": member["couple_id"],
            "uid": actor["user_id"],
            "name": name,
            "category": category,
            "description": description,
            "image": image,
            "price": price,
        },
    )
    db.session.commit()
    return jsonify({"id": result.lastrowid}), 201


@menu_bp.patch("/items/<int:item_id>")
def update_item(item_id):
    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    fields = {
        'name': str(payload.get('name') or '').strip(),
        'category': str(payload.get('category') or '其他').strip() or '其他',
        'description': str(payload.get('description') or '').strip(),
        'image': str(payload.get('imageUrl') or payload.get('image_url') or '').strip(),
    }
    try:
        price = int(payload.get('pointsPrice', payload.get('points_price', 0)) or 0)
    except (TypeError, ValueError):
        return jsonify({'message': '积分价格必须是整数'}), 400
    if not fields['name']:
        return jsonify({'message': '菜品名称不能为空'}), 400
    if price < 0 or len(fields['name']) > 120 or len(fields['category']) > 60 or len(fields['description']) > 5000 or len(fields['image']) > 500:
        return jsonify({'message': '菜品信息无效'}), 400
    row = db.session.execute(text('SELECT id FROM couple_menu_items WHERE id=:id AND couple_id=:cid AND is_active=TRUE'), {'id': item_id, 'cid': member['couple_id']}).first()
    if not row:
        return jsonify({'message': '菜品不存在'}), 404
    db.session.execute(text('UPDATE couple_menu_items SET name=:name,category=:category,description=:description,image_url=:image,points_price=:price WHERE id=:id AND couple_id=:cid'), {**fields, 'price': price, 'id': item_id, 'cid': member['couple_id']})
    db.session.commit()
    return jsonify({'success': True, 'id': item_id})


@menu_bp.delete("/items/<int:item_id>")
def delete_item(item_id):
    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    result = db.session.execute(text('UPDATE couple_menu_items SET is_active=FALSE WHERE id=:id AND couple_id=:cid AND is_active=TRUE'), {'id': item_id, 'cid': member['couple_id']})
    if not result.rowcount:
        return jsonify({'message': '菜品不存在'}), 404
    db.session.commit()
    return jsonify({'success': True})


@menu_bp.post("/items/<int:item_id>/like")
def like_item(item_id):
    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    _ensure_menu_tables()
    result = db.session.execute(
        text(
            "UPDATE couple_menu_items SET likes=likes+1 "
            "WHERE id=:id AND couple_id=:cid AND is_active=TRUE"
        ),
        {"id": item_id, "cid": member["couple_id"]},
    )
    db.session.commit()
    if not result.rowcount:
        return jsonify({"message": "菜品不存在"}), 404
    return jsonify({"success": True})


def _cart_response(user_id):
    db = _db()
    rows = db.session.execute(
        text(
            "SELECT c.item_id AS itemId,c.quantity,c.note,m.name,m.category,"
            "m.description,m.image_url AS imageUrl,m.points_price AS pointsPrice,"
            "(c.quantity*m.points_price) AS subtotal "
            "FROM couple_cart_items c JOIN couple_menu_items m ON m.id=c.item_id "
            "WHERE c.user_id=:uid AND m.is_active=TRUE ORDER BY c.updated_at DESC"
        ),
        {"uid": user_id},
    ).mappings().all()
    return jsonify(
        {
            "items": [dict(row) for row in rows],
            "totalPoints": sum(int(row["subtotal"] or 0) for row in rows),
        }
    )


@menu_bp.get("/cart")
def get_cart():
    actor, _, error = _member_or_error()
    if error:
        return error
    _ensure_menu_tables()
    return _cart_response(actor["user_id"])


@menu_bp.post("/cart")
def put_cart():
    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    try:
        item_id = int(payload.get("itemId", payload.get("item_id", 0)) or 0)
        quantity = int(payload.get("quantity", 1) or 1)
    except (TypeError, ValueError):
        return jsonify({"message": "商品和数量无效"}), 400
    note = str(payload.get("note") or "")[:300]
    if item_id <= 0 or quantity <= 0 or quantity > 99:
        return jsonify({"message": "商品和数量无效"}), 400
    _ensure_menu_tables()
    exists = db.session.execute(
        text(
            "SELECT id FROM couple_menu_items WHERE id=:id AND couple_id=:cid "
            "AND is_active=TRUE"
        ),
        {"id": item_id, "cid": member["couple_id"]},
    ).first()
    if not exists:
        return jsonify({"message": "菜品不存在"}), 404
    existing = db.session.execute(
        text("SELECT quantity FROM couple_cart_items WHERE user_id=:uid AND item_id=:iid"),
        {"uid": actor["user_id"], "iid": item_id},
    ).scalar()
    if existing is not None and int(existing) + quantity > 99:
        return jsonify({"message": "单品最多添加 99 份"}), 400
    db.session.execute(
        text(
            "INSERT INTO couple_cart_items(user_id,item_id,quantity,note) "
            "VALUES(:uid,:iid,:qty,:note) "
            "ON DUPLICATE KEY UPDATE quantity=quantity+:qty,note=:note"
        ),
        {"uid": actor["user_id"], "iid": item_id, "qty": quantity, "note": note},
    )
    db.session.commit()
    return _cart_response(actor["user_id"])


@menu_bp.patch("/cart/<int:item_id>")
def update_cart(item_id):
    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    try:
        quantity = int(payload.get("quantity") or 0)
    except (TypeError, ValueError):
        return jsonify({"message": "数量无效"}), 400
    if quantity < 1 or quantity > 99:
        return jsonify({"message": "数量应为 1 到 99"}), 400
    _ensure_menu_tables()
    result = db.session.execute(
        text(
            "UPDATE couple_cart_items c JOIN couple_menu_items m ON m.id=c.item_id "
            "SET c.quantity=:qty WHERE c.user_id=:uid AND c.item_id=:iid "
            "AND m.couple_id=:cid AND m.is_active=TRUE"
        ),
        {"qty": quantity, "uid": actor["user_id"], "iid": item_id, "cid": member["couple_id"]},
    )
    db.session.commit()
    if not result.rowcount:
        return jsonify({"message": "购物车中没有这道菜"}), 404
    return _cart_response(actor["user_id"])


@menu_bp.delete("/cart/<int:item_id>")
def remove_cart(item_id):
    db = _db()
    actor, _, error = _member_or_error()
    if error:
        return error
    _ensure_menu_tables()
    db.session.execute(
        text("DELETE FROM couple_cart_items WHERE user_id=:uid AND item_id=:iid"),
        {"uid": actor["user_id"], "iid": item_id},
    )
    db.session.commit()
    return _cart_response(actor["user_id"])


def _order_payload(row):
    payload = dict(row)
    for key in ("createdAt", "completedAt"):
        value = payload.get(key)
        if isinstance(value, datetime):
            payload[key] = value.isoformat(sep=" ")
    return payload


def _review_payload(row):
    if not row:
        return None
    payload = dict(row)
    for key in ("createdAt", "updatedAt"):
        value = payload.get(key)
        if isinstance(value, datetime):
            payload[key] = value.isoformat(sep=" ")
    return payload


@menu_bp.get("/orders")
def list_orders():
    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    _ensure_menu_tables()
    rows = db.session.execute(
        text(
            "SELECT id,buyer_id AS buyerId,receiver_id AS receiverId,total_points AS totalPoints,"
            "note,status,created_at AS createdAt,completed_at AS completedAt "
            "FROM couple_orders WHERE couple_id=:cid AND (buyer_id=:uid OR receiver_id=:uid) "
            "ORDER BY id DESC"
        ),
        {"cid": member["couple_id"], "uid": actor["user_id"]},
    ).mappings().all()
    return jsonify({"orders": [_order_payload(row) for row in rows]})


@menu_bp.get("/orders/<int:order_id>")
def get_order(order_id):
    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    _ensure_menu_tables()
    order = db.session.execute(
        text(
            "SELECT id,buyer_id AS buyerId,receiver_id AS receiverId,total_points AS totalPoints,"
            "note,status,created_at AS createdAt,completed_at AS completedAt "
            "FROM couple_orders WHERE id=:oid AND couple_id=:cid "
            "AND (buyer_id=:uid OR receiver_id=:uid)"
        ),
        {"oid": order_id, "cid": member["couple_id"], "uid": actor["user_id"]},
    ).mappings().first()
    if not order:
        return jsonify({"message": "订单不存在或无权查看"}), 404
    items = db.session.execute(
        text(
            "SELECT item_id AS itemId,item_name AS itemName,unit_price AS unitPrice,quantity "
            "FROM couple_order_items WHERE order_id=:oid ORDER BY item_name"
        ),
        {"oid": order_id},
    ).mappings().all()
    review = db.session.execute(
        text(
            "SELECT id,author_id AS authorId,content,image_url AS imageUrl,"
            "created_at AS createdAt,updated_at AS updatedAt "
            "FROM couple_order_reviews WHERE order_id=:oid"
        ),
        {"oid": order_id},
    ).mappings().first()
    return jsonify({"order": _order_payload(order), "items": [dict(row) for row in items],
                    "review": _review_payload(review)})


@menu_bp.post("/orders")
def create_order():
    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    _ensure_menu_tables()
    payload = request.get_json(silent=True) or {}
    note = str(payload.get("note") or "")[:300]
    cart = db.session.execute(
        text(
            "SELECT c.item_id,c.quantity,c.note,m.name,m.points_price "
            "FROM couple_cart_items c JOIN couple_menu_items m ON m.id=c.item_id "
            "WHERE c.user_id=:uid AND m.couple_id=:cid AND m.is_active=TRUE FOR UPDATE"
        ),
        {"uid": actor["user_id"], "cid": member["couple_id"]},
    ).mappings().all()
    if not cart:
        return jsonify({"message": "购物车为空"}), 400
    total = sum(int(row["quantity"]) * int(row["points_price"]) for row in cart)
    receiver = db.session.execute(
        text(
            "SELECT user_id FROM couple_members WHERE couple_id=:cid AND user_id<>:uid "
            "ORDER BY user_id LIMIT 1"
        ),
        {"cid": member["couple_id"], "uid": actor["user_id"]},
    ).scalar()
    result = db.session.execute(
        text(
            "INSERT INTO couple_orders(couple_id,buyer_id,receiver_id,total_points,note) "
            "VALUES(:cid,:buyer,:receiver,:total,:note)"
        ),
        {
            "cid": member["couple_id"],
            "buyer": actor["user_id"],
            "receiver": receiver,
            "total": total,
            "note": note,
        },
    )
    order_id = result.lastrowid
    for row in cart:
        db.session.execute(
            text(
                "INSERT INTO couple_order_items(order_id,item_id,item_name,unit_price,quantity) "
                "VALUES(:oid,:iid,:name,:price,:qty)"
            ),
            {
                "oid": order_id,
                "iid": row["item_id"],
                "name": row["name"],
                "price": row["points_price"],
                "qty": row["quantity"],
            },
        )
        db.session.execute(
            text("UPDATE couple_menu_items SET sales=sales+:qty WHERE id=:iid AND couple_id=:cid"),
            {"qty": row["quantity"], "iid": row["item_id"], "cid": member["couple_id"]},
        )
    db.session.execute(text("DELETE FROM couple_cart_items WHERE user_id=:uid"), {"uid": actor["user_id"]})
    db.session.commit()
    return jsonify({"id": order_id, "totalPoints": total, "status": "pending"}), 201


@menu_bp.patch("/orders/<int:order_id>")
def update_order(order_id):
    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    status = str((request.get_json(silent=True) or {}).get("status") or "").strip()
    if status not in ("pending", "cooking", "completed", "cancelled"):
        return jsonify({"message": "订单状态无效"}), 400
    _ensure_menu_tables()
    order = db.session.execute(
        text(
            "SELECT id,buyer_id,receiver_id,status FROM couple_orders "
            "WHERE id=:oid AND couple_id=:cid FOR UPDATE"
        ),
        {"oid": order_id, "cid": member["couple_id"]},
    ).mappings().first()
    if not order:
        return jsonify({"message": "订单不存在"}), 404
    uid = actor["user_id"]
    current = order["status"]
    participant = uid in (order["buyer_id"], order["receiver_id"])
    if status == "cooking":
        allowed = participant and current == "pending"
    elif status == "completed":
        allowed = participant and current == "cooking"
    elif status == "cancelled":
        allowed = participant and current in ("pending", "cooking")
    else:
        allowed = False
    if not allowed:
        return jsonify({"message": "当前用户不能进行此状态操作"}), 403
    db.session.execute(
        text(
            "UPDATE couple_orders SET status=:status, "
            "completed_at=CASE WHEN :status='completed' THEN CURRENT_TIMESTAMP ELSE completed_at END "
            "WHERE id=:oid"
        ),
        {"status": status, "oid": order_id},
    )
    db.session.commit()
    return jsonify({"success": True, "status": status})


@menu_bp.post("/orders/<int:order_id>/review")
def save_order_review(order_id):
    """Save the receiver's completion photo and review for a finished order."""

    db = _db()
    actor, member, error = _member_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    content = str(payload.get("content") or payload.get("review") or "").strip()[:2000]
    image = str(payload.get("imageUrl") or payload.get("image_url") or "").strip()[:500]
    if not content and not image:
        return jsonify({"message": "写一点评价或上传一张照片吧"}), 400

    _ensure_menu_tables()
    order = db.session.execute(
        text(
            "SELECT id,buyer_id,receiver_id,status FROM couple_orders "
            "WHERE id=:oid AND couple_id=:cid FOR UPDATE"
        ),
        {"oid": order_id, "cid": member["couple_id"]},
    ).mappings().first()
    if not order:
        return jsonify({"message": "订单不存在"}), 404
    if order["status"] != "completed":
        return jsonify({"message": "订单完成后才能保存完成记录"}), 409
    if int(order["receiver_id"] or 0) != int(actor["user_id"]):
        return jsonify({"message": "只有接单的一方可以添加完成照片和评价"}), 403

    existing = db.session.execute(
        text("SELECT id FROM couple_order_reviews WHERE order_id=:oid"),
        {"oid": order_id},
    ).scalar()
    if existing:
        db.session.execute(
            text("UPDATE couple_order_reviews SET content=:content,image_url=:image WHERE order_id=:oid"),
            {"content": content, "image": image, "oid": order_id},
        )
    else:
        db.session.execute(
            text(
                "INSERT INTO couple_order_reviews(order_id,author_id,content,image_url) "
                "VALUES(:oid,:uid,:content,:image)"
            ),
            {"oid": order_id, "uid": actor["user_id"], "content": content, "image": image},
        )
    db.session.commit()
    review = db.session.execute(
        text(
            "SELECT id,author_id AS authorId,content,image_url AS imageUrl,"
            "created_at AS createdAt,updated_at AS updatedAt "
            "FROM couple_order_reviews WHERE order_id=:oid"
        ),
        {"oid": order_id},
    ).mappings().first()
    return jsonify({"review": _review_payload(review)})
