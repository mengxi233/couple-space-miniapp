from datetime import datetime, timezone
import hashlib
from flask import Blueprint, jsonify, request
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from sqlalchemy import text
import requests

from app.utils.runtime_config import is_production, runtime_bool, runtime_value

couple_bp = Blueprint('couple', __name__, url_prefix='/api/couple')
TOKEN_MAX_AGE = 60 * 60 * 24 * 30
MIN_PRODUCTION_SECRET_LENGTH = 32

def _activation_code(label):
    return hashlib.sha256(label.encode('utf-8')).hexdigest()[:16]

def _invite_codes():
    owner = (runtime_value('COUPLE_OWNER_INVITE_CODE') or '').strip().lower()
    member = (runtime_value('COUPLE_MEMBER_INVITE_CODE') or '').strip().lower()
    if not owner and not member and not is_production():
        owner, member = _activation_code('demo-owner'), _activation_code('demo-member')
    if not all(len(value) == 16 and all(char in '0123456789abcdef' for char in value)
               for value in (owner, member)) or owner == member:
        return {}
    return {owner: 'owner', member: 'member'}

def _default_start_time():
    value = runtime_value('COUPLE_DEFAULT_START_DATE', '2025-01-01')
    try:
        return datetime.strptime(value[:10], '%Y-%m-%d').strftime('%Y-%m-%d 00:00:00')
    except (TypeError, ValueError):
        return '2025-01-01 00:00:00'

def _serializer():
    secret = runtime_value('SECRET_KEY')
    # Keep a clearly-marked fallback for local prototype work, but never use
    # it in production.  ``_current_user`` treats the production error as an
    # invalid session and the login endpoint returns a safe configuration
    # error before issuing a token.
    if not secret or (is_production() and len(secret) < MIN_PRODUCTION_SECRET_LENGTH):
        if is_production():
            raise RuntimeError('SECRET_KEY is not configured')
        secret = 'dev-only-insecure-secret'
    return URLSafeTimedSerializer(secret)

def _ensure_tables():
    from app.extensions import db
    db.session.execute(text('''CREATE TABLE IF NOT EXISTS couple_users (id INT AUTO_INCREMENT PRIMARY KEY, openid VARCHAR(128) NOT NULL UNIQUE, nickname VARCHAR(100) NOT NULL DEFAULT '新朋友', avatar_url VARCHAR(500) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'''))
    db.session.execute(text('''CREATE TABLE IF NOT EXISTS couple_spaces (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL DEFAULT '我们的空间', start_time DATETIME NOT NULL, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'''))
    db.session.execute(text('''CREATE TABLE IF NOT EXISTS couple_members (couple_id INT NOT NULL, user_id INT NOT NULL, role ENUM('owner','member') NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(couple_id,user_id), UNIQUE KEY one_role(couple_id,role)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'''))
    db.session.execute(text('''CREATE TABLE IF NOT EXISTS couple_invites (code VARCHAR(20) PRIMARY KEY, couple_id INT NOT NULL, role ENUM('owner','member') NOT NULL, used_by INT NULL, used_at DATETIME NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'''))
    db.session.commit()

def _current_user():
    auth = request.headers.get('Authorization', '')
    if not auth.startswith('Bearer '): return None
    try: return _serializer().loads(auth[7:], max_age=TOKEN_MAX_AGE)
    except (BadSignature, SignatureExpired, RuntimeError): return None

def _user_payload(user_id):
    from app.extensions import db
    row = db.session.execute(text('SELECT u.id,u.nickname,u.avatar_url,m.couple_id,m.role FROM couple_users u LEFT JOIN couple_members m ON m.user_id=u.id WHERE u.id=:id'), {'id': user_id}).mappings().first()
    if not row: return None
    return {'id': row['id'], 'nickname': row['nickname'], 'avatarUrl': row['avatar_url'], 'coupleId': row['couple_id'], 'role': row['role'] or 'guest'}

@couple_bp.post('/auth/wechat-login')
def wechat_login():
    from app.extensions import db
    _ensure_tables(); payload = request.get_json(silent=True) or {}; code = str(payload.get('code') or '').strip()[:256]
    if not code: return jsonify({'message': '缺少微信登录凭证'}), 400
    appid = runtime_value('WX_APPID', aliases=('WECHAT_APPID',))
    secret = runtime_value('WX_APPSECRET', aliases=('WECHAT_APPSECRET',))
    openid = None
    if bool(appid) != bool(secret):
        # A partial pair is almost always a deployment mistake.  Do not fall
        # back to predictable ``dev:`` identities in that case.
        return jsonify({'message': '服务器微信登录配置不完整，请联系管理员'}), 503
    if appid and secret:
        try:
            response = requests.get(
                'https://api.weixin.qq.com/sns/jscode2session',
                params={'appid': appid, 'secret': secret, 'js_code': code, 'grant_type': 'authorization_code'},
                timeout=8,
            ).json()
        except (requests.RequestException, ValueError):
            return jsonify({'message': '微信登录服务暂时不可用，请稍后再试'}), 502
        if not isinstance(response, dict):
            return jsonify({'message': '微信登录服务返回异常，请稍后再试'}), 502
        openid = response.get('openid')
        if not isinstance(openid, str) or not openid.strip():
            # Do not echo the upstream response: it can contain deployment
            # details and is not useful to a mini-program user.
            return jsonify({'message': '微信登录校验失败'}), 401
        openid = openid.strip()
        if len(openid) > 128:
            return jsonify({'message': '微信登录身份无效'}), 401
    elif runtime_bool('COUPLE_DEV_LOGIN', default=not is_production()):
        # Keep development identities bounded so arbitrary input cannot cause
        # a database truncation error.
        openid = ('dev:' + code)[:128]
    else:
        return jsonify({'message': '服务器尚未配置微信登录，请联系管理员'}), 503
    row = db.session.execute(text('SELECT id FROM couple_users WHERE openid=:openid'), {'openid': openid}).first()
    if row: user_id = row[0]
    else:
        result = db.session.execute(text("INSERT INTO couple_users(openid) VALUES(:openid)"), {'openid': openid}); db.session.commit(); user_id = result.lastrowid
    try:
        token = _serializer().dumps({'user_id': user_id})
    except RuntimeError:
        db.session.rollback()
        return jsonify({'message': '服务器会话密钥未配置，请联系管理员'}), 503
    user = _user_payload(user_id)
    return jsonify({'token': token, 'user': user})

@couple_bp.post('/couples/join')
def join_couple():
    from app.extensions import db
    actor = _current_user()
    if not actor: return jsonify({'message': '请先登录'}), 401
    _ensure_tables(); payload = request.get_json(silent=True) or {}; code = str(payload.get('activationCode') or payload.get('invite') or '').strip().lower()
    if db.session.execute(text("SELECT 1 FROM couple_members WHERE user_id=:uid"), {"uid": actor["user_id"]}).first(): return jsonify({"message": "你已经绑定情侣空间"}), 409
    code_roles = _invite_codes()
    if not code_roles:
        return jsonify({'message': '服务器尚未配置情侣激活码'}), 503
    if code not in code_roles: return jsonify({'message': '激活码无效'}), 400
    invite = db.session.execute(text('SELECT code,couple_id,role,used_by FROM couple_invites WHERE code=:code FOR UPDATE'), {'code': code}).mappings().first()
    if not invite:
        existing = db.session.execute(text('SELECT id FROM couple_spaces ORDER BY id LIMIT 1')).first()
        if not existing:
            owner_code = next(value for value, role in code_roles.items() if role == 'owner')
            member_code = next(value for value, role in code_roles.items() if role == 'member')
            result = db.session.execute(text("INSERT INTO couple_spaces(name,start_time,created_by) VALUES(:name,:start,:uid)"), {'name': runtime_value('COUPLE_DEFAULT_NAME', '我们的空间'), 'start': _default_start_time(), 'uid': actor['user_id']}); couple_id = result.lastrowid
            db.session.execute(text("INSERT INTO couple_invites(code,couple_id,role) VALUES(:owner_code,:cid,'owner'),(:member_code,:cid,'member')"), {'owner_code': owner_code, 'member_code': member_code, 'cid': couple_id}); db.session.commit(); invite = {'couple_id': couple_id, 'role': code_roles[code], 'used_by': None}
        else: return jsonify({'message': '邀请码尚未初始化'}), 409
    else: couple_id = invite['couple_id']
    if invite.get('used_by') and invite['used_by'] != actor['user_id']: return jsonify({'message': '邀请码已使用'}), 409
    member_count = db.session.execute(text('SELECT COUNT(*) FROM couple_members WHERE couple_id=:cid'), {'cid': couple_id}).scalar()
    if member_count >= 2: return jsonify({'message': '情侣成员已满'}), 409
    db.session.execute(text('INSERT IGNORE INTO couple_members(couple_id,user_id,role) VALUES(:cid,:uid,:role)'), {'cid': couple_id, 'uid': actor['user_id'], 'role': invite['role']})
    db.session.execute(text('UPDATE couple_invites SET used_by=:uid,used_at=:now WHERE code=:code'), {'uid': actor['user_id'], 'now': datetime.now(timezone.utc).replace(tzinfo=None), 'code': code}); db.session.commit()
    return jsonify({'user': _user_payload(actor['user_id'])})

@couple_bp.get('/home')
def home():
    from app.extensions import db
    _ensure_tables()
    actor = _current_user()
    member = None
    if actor:
        member = db.session.execute(
            text('SELECT couple_id,role FROM couple_members WHERE user_id=:uid'),
            {'uid': actor['user_id']},
        ).mappings().first()
    couple_id = member['couple_id'] if member else db.session.execute(
        text('SELECT id FROM couple_spaces ORDER BY id LIMIT 1')
    ).scalar()
    row = db.session.execute(
        text('SELECT id,name,start_time FROM couple_spaces WHERE id=:cid'),
        {'cid': couple_id},
    ).mappings().first() if couple_id else None
    couple = dict(row) if row else {
        'id': None,
        'name': '我们的空间',
        'start_time': _default_start_time(),
    }
    if row:
        couple['startTime'] = row['start_time'].isoformat(sep=' ') if hasattr(row['start_time'], 'isoformat') else row['start_time']
    members = []
    if couple_id:
        member_rows = db.session.execute(
            text(
                'SELECT u.id,u.nickname,u.avatar_url AS avatarUrl,m.role '
                'FROM couple_members m JOIN couple_users u ON u.id=m.user_id '
                'WHERE m.couple_id=:cid ORDER BY m.role,u.id'
            ),
            {'cid': couple_id},
        ).mappings().all()
        members = [dict(item) for item in member_rows]
    points = 0
    if actor and member:
        # Keep the home endpoint usable even before the optional points tables
        # have been created by importing the helper lazily.
        try:
            from app.routes.points_api_routes import balance_for
            points = balance_for(couple_id, actor['user_id'])
        except Exception:
            db.session.rollback()
            points = 0
    db.session.commit()
    return jsonify({'couple': couple, 'members': members, 'banners': [], 'points': points})


@couple_bp.get('/couples/settings')
def couple_settings():
    """Read the couple-space settings for the home/profile screens."""

    from app.extensions import db
    _ensure_tables()
    actor = _current_user()
    member = None
    if actor:
        member = db.session.execute(
            text('SELECT couple_id,role FROM couple_members WHERE user_id=:uid'),
            {'uid': actor['user_id']},
        ).mappings().first()
    couple_id = member['couple_id'] if member else db.session.execute(
        text('SELECT id FROM couple_spaces ORDER BY id LIMIT 1')
    ).scalar()
    row = db.session.execute(
        text('SELECT id,name,start_time FROM couple_spaces WHERE id=:cid'),
        {'cid': couple_id},
    ).mappings().first() if couple_id else None
    if not row:
        return jsonify({'settings': {'name': runtime_value('COUPLE_DEFAULT_NAME', '我们的空间'), 'startTime': _default_start_time()[:10]}})
    start = row['start_time']
    return jsonify({'settings': {
        'id': row['id'],
        'name': row['name'],
        'startTime': start.strftime('%Y-%m-%d') if hasattr(start, 'strftime') else str(start)[:10],
        'canEdit': bool(member and member['role'] == 'owner'),
    }})


@couple_bp.patch('/couples/settings')
def update_couple_settings():
    from app.extensions import db
    actor = _current_user()
    if not actor:
        return jsonify({'message': '请先登录'}), 401
    _ensure_tables()
    member = db.session.execute(
        text('SELECT couple_id,role FROM couple_members WHERE user_id=:uid'),
        {'uid': actor['user_id']},
    ).mappings().first()
    if not member or member['role'] != 'owner':
        return jsonify({'message': '只有空间创建者可以修改相恋时间'}), 403
    payload = request.get_json(silent=True) or {}
    name = str(payload.get('name') or '').strip()[:100]
    start_value = str(payload.get('startTime') or payload.get('start_time') or '').strip()
    if not start_value:
        return jsonify({'message': '相恋日期不能为空'}), 400
    if len(start_value) == 10:
        start_value += ' 00:00:00'
    try:
        datetime.strptime(start_value[:19], '%Y-%m-%d %H:%M:%S')
    except ValueError:
        return jsonify({'message': '相恋日期格式应为 YYYY-MM-DD'}), 400
    if not name:
        name = '我们的空间'
    db.session.execute(
        text('UPDATE couple_spaces SET name=:name,start_time=:start WHERE id=:cid'),
        {'name': name, 'start': start_value[:19], 'cid': member['couple_id']},
    )
    db.session.commit()
    return jsonify({'success': True, 'settings': {'name': name, 'startTime': start_value[:10]}})

def _ensure_calendar_table():
    from app.extensions import db
    db.session.execute(text('''CREATE TABLE IF NOT EXISTS couple_calendar_events (id INT AUTO_INCREMENT PRIMARY KEY, couple_id INT NOT NULL, user_id INT NOT NULL, event_date DATE NOT NULL, title VARCHAR(200) NOT NULL DEFAULT '', content TEXT NOT NULL, mood VARCHAR(16) NOT NULL DEFAULT '😊', image_url VARCHAR(500) NOT NULL DEFAULT '', link_url VARCHAR(500) NOT NULL DEFAULT '', is_public BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_calendar_couple_date(couple_id,event_date)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'''))
    for column, definition in [('title', "VARCHAR(200) NOT NULL DEFAULT ''"), ('mood', "VARCHAR(16) NOT NULL DEFAULT '😊'"), ('image_url', "VARCHAR(500) NOT NULL DEFAULT ''"), ('link_url', "VARCHAR(500) NOT NULL DEFAULT ''"), ('updated_by', 'INT NULL'), ('updated_at', 'DATETIME NULL')]:
        present = db.session.execute(text('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\'couple_calendar_events\' AND COLUMN_NAME=:column'), {'column': column}).scalar()
        if not present:
            db.session.execute(text(f'ALTER TABLE couple_calendar_events ADD COLUMN {column} {definition}'))
    db.session.commit()

# Names are resolved from user IDs, never accepted from submitted event data.
_CALENDAR_EDITOR_FIELDS = (
    ',updated_by AS updatedBy,updated_at AS updatedAt,'
    '(SELECT nickname FROM couple_users WHERE id=couple_calendar_events.updated_by) AS updatedByName '
)

def _calendar_event_payload(row):
    event = dict(row)
    if hasattr(event.get('eventDate'), 'isoformat'):
        event['eventDate'] = event['eventDate'].isoformat()
    if hasattr(event.get('createdAt'), 'isoformat'):
        event['createdAt'] = event['createdAt'].isoformat(sep=' ')
    if hasattr(event.get('updatedAt'), 'isoformat'):
        event['updatedAt'] = event['updatedAt'].isoformat(sep=' ')
    return event

@couple_bp.get('/calendar/events')
def list_calendar_events():
    from app.extensions import db
    _ensure_tables(); _ensure_calendar_table()
    actor = _current_user(); couple_id = None
    if actor:
        couple_id = db.session.execute(text('SELECT couple_id FROM couple_members WHERE user_id=:uid'), {'uid': actor['user_id']}).scalar()
    if not couple_id:
        couple_id = db.session.execute(text('SELECT id FROM couple_spaces ORDER BY id LIMIT 1')).scalar()
    if not couple_id:
        return jsonify({'events': []})
    is_member = bool(actor and db.session.execute(
        text('SELECT 1 FROM couple_members WHERE couple_id=:cid AND user_id=:uid'),
        {'cid': couple_id, 'uid': actor['user_id'] if actor else -1},
    ).first())
    where = 'couple_id=:cid' if is_member else 'couple_id=:cid AND is_public=TRUE'
    rows = db.session.execute(
        text(
            'SELECT id,event_date AS eventDate,title,content,mood,image_url AS imageUrl,link_url AS linkUrl,'
            'is_public AS isPublic, user_id AS createdBy,created_at AS createdAt '
            + _CALENDAR_EDITOR_FIELDS + f'FROM couple_calendar_events WHERE {where} '
            'ORDER BY event_date DESC, id DESC LIMIT 100'
        ),
        {'cid': couple_id},
    ).mappings().all()
    events = []
    for row in rows:
        events.append(_calendar_event_payload(row))
    db.session.commit()
    return jsonify({'events': events})

@couple_bp.post('/calendar/events')
def create_calendar_event():
    from app.extensions import db
    actor = _current_user()
    if not actor: return jsonify({'message': '请先登录'}), 401
    _ensure_tables(); payload = request.get_json(silent=True) or {}
    couple_id = db.session.execute(text('SELECT couple_id FROM couple_members WHERE user_id=:uid'), {'uid': actor['user_id']}).scalar()
    if not couple_id: return jsonify({'message': '请先绑定情侣空间'}), 403
    date_value = (payload.get('eventDate') or '').strip(); title = str(payload.get('title') or '')[:200]; content = (payload.get('content') or '').strip(); mood = str(payload.get('mood') or '😊')[:16]; image_url = str(payload.get('imageUrl') or '')[:500]; link_url = str(payload.get('linkUrl') or payload.get('link') or '')[:500]
    if not date_value or not (title or content or image_url or link_url): return jsonify({'message': '日期和内容不能为空'}), 400
    try:
        datetime.strptime(date_value[:10], '%Y-%m-%d')
    except ValueError:
        return jsonify({'message': '日期格式应为 YYYY-MM-DD'}), 400
    _ensure_calendar_table()
    # Prepare the notification table before writing the event so the event and
    # its partner notification can be committed together.
    from app.routes.notifications_api_routes import create_notification, ensure_notification_tables
    ensure_notification_tables()
    result = db.session.execute(text('INSERT INTO couple_calendar_events(couple_id,user_id,event_date,title,content,mood,image_url,link_url,is_public,updated_by,updated_at) VALUES(:cid,:uid,:date,:title,:content,:mood,:image,:link,:public,:uid,CURRENT_TIMESTAMP)'), {'cid': couple_id, 'uid': actor['user_id'], 'date': date_value[:10], 'title': title, 'content': content, 'mood': mood, 'image': image_url, 'link': link_url, 'public': bool(payload.get('isPublic', True))})
    partner_id = db.session.execute(text('SELECT user_id FROM couple_members WHERE couple_id=:cid AND user_id<>:uid LIMIT 1'), {'cid': couple_id, 'uid': actor['user_id']}).scalar()
    if partner_id:
        notification_id = create_notification(couple_id, partner_id, '日历里多了一条记录', f"对方在 {date_value[:10]} 留下了新的记录", notification_type='calendar_created', payload={'eventId': result.lastrowid, 'eventDate': date_value[:10]}, ensure=False)
        from app.routes.calendar_wechat import enqueue
        enqueue(result.lastrowid, partner_id, couple_id, notification_id)
    db.session.commit()
    row = db.session.execute(text('SELECT id,event_date AS eventDate,title,content,mood,image_url AS imageUrl,link_url AS linkUrl,is_public AS isPublic,user_id AS createdBy,created_at AS createdAt ' + _CALENDAR_EDITOR_FIELDS + 'FROM couple_calendar_events WHERE id=:id'), {'id': result.lastrowid}).mappings().one()
    return jsonify({'success': True, 'event': _calendar_event_payload(row)}), 201
@couple_bp.get('/auth/me')
def auth_me():
    actor = _current_user()
    if not actor: return jsonify({'message': '请先登录'}), 401
    _ensure_tables(); user = _user_payload(actor['user_id'])
    return jsonify({'user': user}) if user else (jsonify({'message': '用户不存在'}), 404)

@couple_bp.patch('/users/profile')
def update_profile():
    from app.extensions import db
    actor = _current_user()
    if not actor: return jsonify({'message': '请先登录'}), 401
    _ensure_tables(); payload = request.get_json(silent=True) or {}
    nickname = str(payload.get('nickname') or '').strip()[:100]
    avatar_url = str(payload.get('avatarUrl') or '').strip()[:500]
    if not nickname: return jsonify({'message': '昵称不能为空'}), 400
    db.session.execute(text('UPDATE couple_users SET nickname=:nickname,avatar_url=:avatar WHERE id=:uid'), {'nickname': nickname, 'avatar': avatar_url, 'uid': actor['user_id']}); db.session.commit()
    return jsonify({'user': _user_payload(actor['user_id'])})

@couple_bp.patch('/calendar/events/<int:event_id>')
def update_calendar_event(event_id):
    from app.extensions import db
    actor = _current_user()
    if not actor: return jsonify({'message': '请先登录'}), 401
    _ensure_tables(); _ensure_calendar_table(); payload = request.get_json(silent=True) or {}
    couple_id = db.session.execute(text('SELECT couple_id FROM couple_members WHERE user_id=:uid'), {'uid': actor['user_id']}).scalar()
    if not couple_id: return jsonify({'message': '请先绑定情侣空间'}), 403
    title = str(payload.get('title') or '')[:200]
    content = str(payload.get('content') or '').strip()
    image_url = str(payload.get('imageUrl') or '')[:500]
    link_url = str(payload.get('linkUrl') or payload.get('link') or '')[:500]
    if not (title or content or image_url or link_url): return jsonify({'message': '记录内容不能为空'}), 400
    result = db.session.execute(text('UPDATE couple_calendar_events SET title=:title,content=:content,mood=:mood,image_url=:image,link_url=:link,is_public=:public,updated_by=:uid,updated_at=CURRENT_TIMESTAMP WHERE id=:id AND couple_id=:cid'), {'title': title, 'content': content, 'mood': str(payload.get('mood') or '😊')[:16], 'image': image_url, 'link': link_url, 'public': bool(payload.get('isPublic', True)), 'id': event_id, 'cid': couple_id, 'uid': actor['user_id']})
    if not result.rowcount: return jsonify({'message': '记录不存在'}), 404
    db.session.commit(); row = db.session.execute(text('SELECT id,event_date AS eventDate,title,content,mood,image_url AS imageUrl,link_url AS linkUrl,is_public AS isPublic,user_id AS createdBy,created_at AS createdAt ' + _CALENDAR_EDITOR_FIELDS + 'FROM couple_calendar_events WHERE id=:id'), {'id': event_id}).mappings().first()
    return jsonify({'event': _calendar_event_payload(row)})

@couple_bp.delete('/calendar/events/<int:event_id>')
def delete_calendar_event(event_id):
    from app.extensions import db
    actor = _current_user()
    if not actor: return jsonify({'message': '请先登录'}), 401
    _ensure_tables(); _ensure_calendar_table(); couple_id = db.session.execute(text('SELECT couple_id FROM couple_members WHERE user_id=:uid'), {'uid': actor['user_id']}).scalar()
    if not couple_id: return jsonify({'message': '请先绑定情侣空间'}), 403
    result = db.session.execute(text('DELETE FROM couple_calendar_events WHERE id=:id AND couple_id=:cid'), {'id': event_id, 'cid': couple_id}); db.session.commit()
    if not result.rowcount: return jsonify({'message': '记录不存在'}), 404
    return jsonify({'success': True})
