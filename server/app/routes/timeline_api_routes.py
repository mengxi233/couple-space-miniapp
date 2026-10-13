"""Member-only, space-scoped chronology. Video URLs are metadata, never fetched."""
import json
from datetime import datetime
from urllib.parse import urlsplit

from flask import Blueprint, jsonify, request
from sqlalchemy import text
from app.extensions import db
from app.routes.couple_api_routes import _current_user

timeline_bp = Blueprint('couple_timeline', __name__, url_prefix='/api/couple/timeline')


def init_timeline(app):
    # Run once at application startup, never perform schema changes per request.
    with app.app_context():
        db.session.execute(text('''CREATE TABLE IF NOT EXISTS couple_timeline_events (
            id INT AUTO_INCREMENT PRIMARY KEY, couple_id INT NOT NULL,
            created_by INT NOT NULL, event_at DATETIME NOT NULL, time_known BOOLEAN NOT NULL DEFAULT FALSE,
            title VARCHAR(120) NOT NULL, description VARCHAR(500) NOT NULL DEFAULT '',
            details TEXT NOT NULL, images JSON NOT NULL, link_url VARCHAR(1000) NOT NULL DEFAULT '',
            video_url VARCHAR(1000) NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_timeline_space_time(couple_id,event_at,id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'''))
        db.session.commit()


@timeline_bp.before_request
def require_member():
    from flask import g
    actor = _current_user()
    if not actor:
        return jsonify(message='请先登录'), 401
    member = db.session.execute(text('SELECT couple_id,role FROM couple_members WHERE user_id=:uid'),
                                {'uid': actor['user_id']}).mappings().first()
    if not member or member['role'] not in ('owner', 'member'):
        return jsonify(message='绑定情侣空间后才能使用大事纪年表'), 403
    g.timeline_member = {**dict(member), 'user_id': actor['user_id']}


def https_url(value):
    if not isinstance(value, str) or len(value) > 1000:
        raise ValueError('链接最多1000个字符')
    value = value.strip()
    if not value:
        return ''
    parts = urlsplit(value)
    if parts.scheme != 'https' or not parts.hostname or parts.username or parts.password or any(c.isspace() for c in value):
        raise ValueError('请输入有效的 HTTPS 链接')
    return value


def validate(payload):
    if not isinstance(payload, dict):
        raise ValueError('事件格式无效')
    result = {}
    for key, limit in [('title', 120), ('description', 500), ('details', 5000)]:
        value = payload.get(key, '')
        if not isinstance(value, str) or len(value) > limit:
            raise ValueError(f'{key} 长度不能超过 {limit} 个字符')
        result[key] = value.strip()
    if not result['title']:
        raise ValueError('请填写标题')
    date = payload.get('date', '')
    time = payload.get('time', '')
    if not isinstance(date, str) or not isinstance(time, str):
        raise ValueError('日期或时间无效')
    try:
        event_at = datetime.strptime(f'{date} {time or "00:00"}', '%Y-%m-%d %H:%M')
        if event_at.strftime('%Y-%m-%d') != date or (time and event_at.strftime('%H:%M') != time) or event_at.year < 1000:
            raise ValueError()
    except ValueError:
        raise ValueError('请填写有效日期和时间')
    images = payload.get('images', [])
    if not isinstance(images, list) or len(images) > 6:
        raise ValueError('最多添加6张图片')
    normalized_images = [https_url(url) for url in images]
    result.update(event_at=event_at, time_known=bool(time),
                  images=json.dumps(normalized_images, ensure_ascii=False),
                  link_url=https_url(payload.get('linkUrl', '')),
                  video_url=https_url(payload.get('videoUrl', '')))
    if any(not url for url in normalized_images):
        raise ValueError('图片地址不能为空')
    return result


def serialize(row):
    value = dict(row)
    for field in ('event_at', 'created_at', 'updated_at'):
        if isinstance(value[field], str):
            value[field] = datetime.fromisoformat(value[field])
    return {'id': value['id'], 'date': value['event_at'].strftime('%Y-%m-%d'),
            'time': value['event_at'].strftime('%H:%M') if value['time_known'] else '',
            'title': value['title'], 'description': value['description'], 'details': value['details'],
            'images': json.loads(value['images']) if isinstance(value['images'], str) else value['images'],
            'linkUrl': value['link_url'], 'videoUrl': value['video_url'],
            'createdAt': value['created_at'].isoformat(), 'updatedAt': value['updated_at'].isoformat()}


def find(event_id, lock=False):
    from flask import g
    return db.session.execute(text('SELECT * FROM couple_timeline_events WHERE id=:id AND couple_id=:cid' + (' FOR UPDATE' if lock else '')),
                              {'id': event_id, 'cid': g.timeline_member['couple_id']}).mappings().first()


@timeline_bp.get('/events')
def list_events():
    from flask import g
    try:
        offset = max(0, int(request.args.get('offset', 0)))
    except ValueError:
        return jsonify(message='分页参数无效'), 400
    query = request.args.get('q', '').strip()[:100]
    direction = 'ASC' if request.args.get('order') == 'asc' else 'DESC'
    params = {'cid': g.timeline_member['couple_id'], 'q': query, 'offset': offset}
    rows = db.session.execute(text('SELECT * FROM couple_timeline_events WHERE couple_id=:cid '
        'AND (:q=\'\' OR LOCATE(:q,title)>0 OR LOCATE(:q,description)>0 OR LOCATE(:q,details)>0) '
        f'ORDER BY event_at {direction},id {direction} LIMIT 21 OFFSET :offset'), params).mappings().all()
    return jsonify(events=[serialize(row) for row in rows[:20]], hasMore=len(rows)>20, canEdit=True)


@timeline_bp.get('/events/<int:event_id>')
def get_event(event_id):
    row = find(event_id)
    return jsonify(event=serialize(row), canEdit=True) if row else (jsonify(message='事件不存在或无权访问'), 404)


@timeline_bp.post('/events')
def create_event():
    from flask import g
    try:
        params = validate(request.get_json(silent=True))
    except (ValueError, TypeError):
        return jsonify(message='请检查标题、日期、图片数量和 HTTPS 链接格式'), 400
    params.update(cid=g.timeline_member['couple_id'], uid=g.timeline_member['user_id'])
    result = db.session.execute(text('INSERT INTO couple_timeline_events '
        '(couple_id,created_by,event_at,time_known,title,description,details,images,link_url,video_url) '
        'VALUES(:cid,:uid,:event_at,:time_known,:title,:description,:details,:images,:link_url,:video_url)'), params)
    event_id = result.lastrowid
    db.session.commit()
    return jsonify(event=serialize(find(event_id))), 201


@timeline_bp.put('/events/<int:event_id>')
def update_event(event_id):
    if not find(event_id, lock=True):
        return jsonify(message='事件不存在或无权访问'), 404
    try:
        params = validate(request.get_json(silent=True))
    except (ValueError, TypeError):
        db.session.rollback()
        return jsonify(message='请检查标题、日期、图片数量和 HTTPS 链接格式'), 400
    from flask import g
    params.update(id=event_id, cid=g.timeline_member['couple_id'])
    db.session.execute(text('UPDATE couple_timeline_events SET event_at=:event_at,time_known=:time_known,'
        'title=:title,description=:description,details=:details,images=:images,link_url=:link_url,video_url=:video_url '
        'WHERE id=:id AND couple_id=:cid'), params)
    db.session.commit()
    return jsonify(event=serialize(find(event_id)))


@timeline_bp.delete('/events/<int:event_id>')
def delete_event(event_id):
    from flask import g
    result = db.session.execute(text('DELETE FROM couple_timeline_events WHERE id=:id AND couple_id=:cid'),
                                {'id': event_id, 'cid': g.timeline_member['couple_id']})
    db.session.commit()
    return jsonify(success=True) if result.rowcount else (jsonify(message='事件不存在或无权访问'), 404)
