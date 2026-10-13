"""Server-backed home banner management for the couple mini-program."""

from flask import Blueprint, jsonify, request
from sqlalchemy import text

from app.routes.couple_api_routes import _current_user, _ensure_tables


banners_bp = Blueprint('couple_banners', __name__, url_prefix='/api/couple')
MAX_BANNERS = 8


def _ensure_banner_tables():
    from app.extensions import db

    _ensure_tables()
    db.session.execute(text('''
        CREATE TABLE IF NOT EXISTS couple_banners (
            id INT AUTO_INCREMENT PRIMARY KEY,
            couple_id INT NOT NULL,
            created_by INT NOT NULL,
            image_url VARCHAR(500) NOT NULL,
            sort_order INT NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_banner_couple_order(couple_id,is_active,sort_order,id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    '''))
    db.session.execute(text('''
        CREATE TABLE IF NOT EXISTS couple_banner_settings (
            couple_id INT PRIMARY KEY,
            display_count INT NOT NULL DEFAULT 2,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    '''))
    db.session.commit()


def _member(required=True):
    from app.extensions import db

    actor = _current_user()
    if not actor:
        return None
    member = db.session.execute(
        text('SELECT couple_id,role FROM couple_members WHERE user_id=:uid'),
        {'uid': actor['user_id']},
    ).mappings().first()
    if required and not member:
        return None
    return {'user_id': actor['user_id'], **dict(member or {})}


def _couple_id_for_viewer():
    from app.extensions import db

    member = _member(required=False)
    if member and member.get('couple_id'):
        return member['couple_id']
    return db.session.execute(text('SELECT id FROM couple_spaces ORDER BY id LIMIT 1')).scalar()


def _display_count(couple_id):
    from app.extensions import db

    value = db.session.execute(
        text('SELECT display_count FROM couple_banner_settings WHERE couple_id=:cid'),
        {'cid': couple_id},
    ).scalar()
    return max(1, min(MAX_BANNERS, int(value or 2)))


def _rows(couple_id, active_only=False):
    from app.extensions import db

    where = 'couple_id=:cid AND is_active=TRUE' if active_only else 'couple_id=:cid'
    rows = db.session.execute(
        text(
            'SELECT id,image_url AS url,sort_order AS sortOrder,is_active AS isActive '
            f'FROM couple_banners WHERE {where} ORDER BY sort_order,id'
        ),
        {'cid': couple_id},
    ).mappings().all()
    return [dict(row) for row in rows]


@banners_bp.get('/banners')
def list_visible_banners():
    from app.extensions import db

    _ensure_banner_tables()
    couple_id = _couple_id_for_viewer()
    if not couple_id:
        return jsonify({'banners': [], 'displayCount': 2, 'configured': False})
    configured = bool(db.session.execute(
        text('SELECT 1 FROM couple_banners WHERE couple_id=:cid LIMIT 1'),
        {'cid': couple_id},
    ).first())
    display_count = _display_count(couple_id)
    return jsonify({
        'banners': _rows(couple_id, active_only=True)[:display_count],
        'displayCount': display_count,
        'configured': configured,
    })


@banners_bp.get('/banners/manage')
def manage_banners():
    _ensure_banner_tables()
    member = _member()
    if not member:
        return jsonify({'message': '登录并绑定情侣后才能管理轮播图'}), 403
    rows = _rows(member['couple_id'])
    return jsonify({
        'banners': rows,
        'displayCount': min(_display_count(member['couple_id']), max(1, len(rows))),
        'maxCount': MAX_BANNERS,
    })


@banners_bp.post('/banners')
def create_banner():
    from app.extensions import db

    _ensure_banner_tables()
    member = _member()
    if not member:
        return jsonify({'message': '登录并绑定情侣后才能上传轮播图'}), 403
    payload = request.get_json(silent=True) or {}
    image_url = str(payload.get('imageUrl') or payload.get('url') or '').strip()[:500]
    if not image_url.startswith(('https://', 'http://')):
        return jsonify({'message': '轮播图地址无效'}), 400
    count = db.session.execute(
        text('SELECT COUNT(*) FROM couple_banners WHERE couple_id=:cid'),
        {'cid': member['couple_id']},
    ).scalar()
    if count >= MAX_BANNERS:
        return jsonify({'message': f'最多只能设置 {MAX_BANNERS} 张轮播图'}), 409
    sort_order = db.session.execute(
        text('SELECT COALESCE(MAX(sort_order),-1)+1 FROM couple_banners WHERE couple_id=:cid'),
        {'cid': member['couple_id']},
    ).scalar()
    result = db.session.execute(
        text('INSERT INTO couple_banners(couple_id,created_by,image_url,sort_order,is_active) VALUES(:cid,:uid,:url,:sort_order,TRUE)'),
        {'cid': member['couple_id'], 'uid': member['user_id'], 'url': image_url, 'sort_order': sort_order},
    )
    db.session.execute(
        text('INSERT IGNORE INTO couple_banner_settings(couple_id,display_count) VALUES(:cid,2)'),
        {'cid': member['couple_id']},
    )
    db.session.commit()
    return jsonify({'banner': {'id': result.lastrowid, 'url': image_url, 'sortOrder': sort_order, 'isActive': True}}), 201


@banners_bp.put('/banners/manage')
def save_banner_settings():
    from app.extensions import db

    _ensure_banner_tables()
    member = _member()
    if not member:
        return jsonify({'message': '登录并绑定情侣后才能管理轮播图'}), 403
    payload = request.get_json(silent=True) or {}
    submitted = payload.get('banners') or []
    if not isinstance(submitted, list) or len(submitted) > MAX_BANNERS:
        return jsonify({'message': '轮播图设置无效'}), 400
    existing_ids = {row['id'] for row in _rows(member['couple_id'])}
    submitted_ids = []
    for index, item in enumerate(submitted):
        try:
            banner_id = int(item.get('id'))
        except (AttributeError, TypeError, ValueError):
            return jsonify({'message': '轮播图设置无效'}), 400
        if banner_id not in existing_ids or banner_id in submitted_ids:
            return jsonify({'message': '轮播图设置包含无效项目'}), 400
        submitted_ids.append(banner_id)
        db.session.execute(
            text('UPDATE couple_banners SET sort_order=:sort_order,is_active=:active WHERE id=:id AND couple_id=:cid'),
            {'sort_order': index, 'active': bool(item.get('isActive', True)), 'id': banner_id, 'cid': member['couple_id']},
        )
    active_count = sum(1 for item in submitted if item.get('isActive', True))
    requested_count = int(payload.get('displayCount') or 1)
    display_count = max(1, min(MAX_BANNERS, active_count or 1, requested_count))
    db.session.execute(
        text('INSERT INTO couple_banner_settings(couple_id,display_count) VALUES(:cid,:count) ON DUPLICATE KEY UPDATE display_count=:count'),
        {'cid': member['couple_id'], 'count': display_count},
    )
    db.session.commit()
    return jsonify({'banners': _rows(member['couple_id']), 'displayCount': display_count})


@banners_bp.delete('/banners/<int:banner_id>')
def delete_banner(banner_id):
    from app.extensions import db

    _ensure_banner_tables()
    member = _member()
    if not member:
        return jsonify({'message': '登录并绑定情侣后才能管理轮播图'}), 403
    result = db.session.execute(
        text('DELETE FROM couple_banners WHERE id=:id AND couple_id=:cid'),
        {'id': banner_id, 'cid': member['couple_id']},
    )
    if not result.rowcount:
        db.session.rollback()
        return jsonify({'message': '轮播图不存在'}), 404
    db.session.commit()
    return jsonify({'success': True})
