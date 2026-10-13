"""Short-lived, authenticated lightboard rooms. SQLite transactions span all workers."""
import json
import hashlib
import os
import re
import secrets
import sqlite3
import struct
import time
from flask import Blueprint, jsonify, request, Response, current_app
from app.routes.couple_api_routes import _current_user

lightboard_bp = Blueprint('lightboard_rooms', __name__, url_prefix='/api/couple/lightboard')
ROOM_DB = os.getenv('LIGHTBOARD_DB', '/app/data/runtime/lightboard_rooms.sqlite3')


def now():
    return int(time.time() * 1000)


def database():
    os.makedirs(os.path.dirname(ROOM_DB) or '.', exist_ok=True)
    connection = sqlite3.connect(ROOM_DB, timeout=10)
    connection.execute('PRAGMA auto_vacuum=INCREMENTAL')
    connection.execute('CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, owner INTEGER, expires INTEGER, active INTEGER, data TEXT, sprite BLOB)')
    connection.execute('CREATE INDEX IF NOT EXISTS room_expiry ON rooms(expires)')
    connection.execute('DELETE FROM rooms WHERE expires < ? OR active < ?', (now(), now()-20*60000))
    connection.commit()
    return connection


class Invalid(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


@lightboard_bp.errorhandler(Invalid)
def invalid(error):
    return jsonify(message=error.message), error.status


@lightboard_bp.before_request
def limit_body():
    if request.content_length and request.content_length > 1024*1024+65536:
        raise Invalid('请求内容过大', 413)


def actor():
    # A device-local capability, never included in room payloads or share links.
    # The public member id is a one-way digest, not an authorization credential.
    guest = request.headers.get('X-Lightboard-Guest')
    if guest is not None:
        if not re.fullmatch(r'[a-f0-9]{64}', guest):
            raise Invalid('访客身份无效，请重新打开多人灯牌', 401)
        return 'guest:' + hashlib.sha256(guest.encode('ascii')).hexdigest()
    # Keep existing logged-in room clients working during the rollout.
    user = _current_user()
    if not user or not user.get('user_id'):
        raise Invalid('访客身份尚未就绪，请更新小程序并重新打开多人灯牌', 401)
    return int(user['user_id'])


def admin_user(required=True):
    # Always re-read activated membership from the primary database. Neither
    # a nickname, client role, nor an anonymous capability grants admin access.
    user = _current_user()
    if not user or not user.get('user_id'):
        if required:
            raise Invalid('请先登录已激活的情侣账号', 401)
        return None
    from app.routes.couple_api_routes import _user_payload
    profile = _user_payload(user['user_id'])
    if not profile or not profile.get('coupleId') or profile.get('role') not in ('owner', 'member'):
        if required:
            raise Invalid('仅已激活的情侣成员可以管理全部房间', 403)
        return None
    return profile


@lightboard_bp.get('/admin/access')
def admin_access():
    response = jsonify(canManage=bool(admin_user(required=False)))
    response.headers['Cache-Control'] = 'no-store'
    return response


@lightboard_bp.get('/admin/rooms')
def admin_rooms():
    admin_user()
    page = int(number(request.args.get('page', 1), 1, 100))
    connection = database()
    try:
        stamp = now()
        rows = connection.execute('SELECT id, expires, active, data, length(sprite), length(CAST(data AS BLOB)) FROM rooms ORDER BY active DESC, id').fetchall()
        room_list = []
        members_count = online_count = sprite_bytes = state_bytes = 0
        for room_id, expires, active, data, image_size, data_size in rows:
            room = json.loads(data)
            online = sum(stamp-m['seen'] < 8000 and m.get('stage', False) for m in room['members'])
            members_count += len(room['members'])
            online_count += online
            sprite_bytes += image_size or 0
            state_bytes += data_size or 0
            timeline = room['timeline']
            effective = timeline.get('previous', timeline) if stamp < timeline['at'] else timeline
            room_list.append(dict(id=room_id, mode=room['mode'], text=room['config']['text'],
                                  memberCount=len(room['members']), onlineCount=online,
                                  members=[dict(name=m['name'], ready=m['ready']) for m in room['members']],
                                  ownerName=next((m['name'] for m in room['members'] if m['uid']==room['owner']), '未加入的房主'),
                                  state=effective['state'], pending=stamp<timeline['at'],
                                  spriteBytes=image_size or 0, stateBytes=data_size or 0,
                                  createdAt=expires-4*3600000, expiresAt=expires, lastActive=active,
                                  reclaimAt=min(expires, active+20*60000)))
        page_size = connection.execute('PRAGMA page_size').fetchone()[0]
        free_pages = connection.execute('PRAGMA freelist_count').fetchone()[0]
        db_size = os.path.getsize(ROOM_DB)
        journal_size = 0
        for suffix in ('-journal','-wal','-shm'):
            try:
                journal_size += os.path.getsize(ROOM_DB+suffix)
            except OSError:
                pass  # SQLite may remove a journal between requests.
        response = jsonify(rooms=room_list[(page-1)*20:page*20], page=page, pageSize=20, total=len(rows),
                           stats=dict(rooms=len(rows), members=members_count, online=online_count,
                                      spriteBytes=sprite_bytes, stateBytes=state_bytes, databaseBytes=db_size,
                                      reusableBytes=free_pages*page_size, journalBytes=journal_size,
                                      maxRooms=100, maxMembers=6), serverTime=stamp)
        response.headers['Cache-Control'] = 'no-store'
        return response
    finally:
        connection.close()


@lightboard_bp.get('/admin/rooms/<room_id>')
def admin_room(room_id):
    user = admin_user()
    connection = database()
    try:
        row = connection.execute('SELECT data FROM rooms WHERE id=?', (room_id,)).fetchone()
        if not row:
            raise Invalid('房间已关闭或过期', 404)
        response = jsonify(room=json.loads(row[0]), uid=user['id'], observing=True)
        response.headers['Cache-Control'] = 'no-store'
        return response
    finally:
        connection.close()


@lightboard_bp.delete('/admin/rooms/<room_id>')
def admin_close(room_id):
    user = admin_user()
    connection = database()
    try:
        removed = connection.execute('DELETE FROM rooms WHERE id=?', (room_id,)).rowcount
        connection.commit()
        if not removed:
            raise Invalid('房间已关闭或过期', 404)
        current_app.logger.info('Lightboard room closed by activated member: admin=%s room=%s', user['id'], room_id)
        return jsonify(closed=True)
    finally:
        connection.close()


def number(value, low, high):
    try:
        result = float(value)
        if not low <= result <= high:
            raise ValueError()
        return result
    except (TypeError, ValueError):
        raise Invalid('参数超出允许范围')


def config(value):
    if not isinstance(value, dict):
        raise Invalid('参数无效')
    text = str(value.get('text', '')).replace('\n', ' ').strip()
    if not 1 <= len(text) <= 80:
        raise Invalid('文字需要 1～80 个字')
    import re
    colors = {k: value.get(k, '') for k in ('fg', 'bg')}
    if not all(isinstance(v, str) and re.fullmatch('#[a-fA-F0-9]{6}', v) for v in colors.values()):
        raise Invalid('颜色无效')
    if colors['fg'].lower() == colors['bg'].lower():
        raise Invalid('文字与背景请使用不同颜色')
    return dict(text=text, **colors, font=int(number(value.get('font', 1), 0, 4)),
                speed=number(value.get('speed', 100), 30, 240), size=number(value.get('size', 65), 25, 90),
                direction=int(number(value.get('direction', 0), 0, 1)))


def reset(room):
    room['version'] += 1
    room['timeline'] = dict(state='paused', at=0, position=0)
    for member in room['members']:
        member['ready'] = False


def position(timeline, stamp):
    if stamp < timeline['at'] and timeline.get('previous'):
        return position(timeline['previous'], stamp)
    return timeline['position'] + (max(0, stamp-timeline['at']) / 1000 if timeline['state'] == 'playing' else 0)


@lightboard_bp.get('/clock')
def clock():
    received = now()
    return jsonify(received=received, sent=now())


@lightboard_bp.post('/session')
def guest_session():
    response = jsonify(token=secrets.token_hex(32))
    response.headers['Cache-Control'] = 'no-store'
    return response, 201


@lightboard_bp.post('/rooms')
def create():
    uid = actor()
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        raise Invalid('参数无效')
    cfg = config(body.get('config'))
    mode = body.get('mode')
    if mode not in ('sync', 'extend'):
        raise Invalid('请选择同步播放或拼接延长')
    stamp = now()
    room_id = secrets.token_urlsafe(18)
    room = dict(id=room_id, owner=uid, version=1, mode=mode, config=cfg, spriteVersion=0,
                spriteWidth=0, spriteHeight=0, members=[], timeline=dict(state='paused', at=0, position=0))
    connection = database()
    try:
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('DELETE FROM rooms WHERE expires < ?', (stamp,))
        if connection.execute('SELECT count(*) FROM rooms').fetchone()[0] >= 100:
            raise Invalid('当前房间数量已达上限，请稍后重试', 429)
        if connection.execute('SELECT count(*) FROM rooms WHERE owner=?', (uid,)).fetchone()[0] >= 3:
            raise Invalid('最多保留 3 个房间，请先关闭旧房间')
        connection.execute('INSERT INTO rooms VALUES (?,?,?,?,?,NULL)', (room_id, uid, stamp+4*3600000, stamp, json.dumps(room)))
        connection.commit()
    finally:
        connection.close()
    return jsonify(room=room), 201


@lightboard_bp.get('/rooms/<room_id>/sprite/<int:version>')
def sprite(room_id, version):
    connection = database()
    try:
        row = connection.execute('SELECT data,sprite FROM rooms WHERE id=? AND expires>?', (room_id, now())).fetchone()
    finally:
        connection.close()
    if not row or not row[1] or json.loads(row[0])['spriteVersion'] != version:
        raise Invalid('文字图片不存在或已过期', 404)
    return Response(row[1], mimetype='image/png', headers={'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff'})


@lightboard_bp.post('/rooms/<room_id>')
def room_action(room_id):
    uid = actor()
    body = request.get_json(silent=True) or request.form.to_dict()
    if not isinstance(body, dict):
        raise Invalid('参数无效')
    action = body.get('action', 'poll')
    stamp = now()
    connection = database()
    try:
        connection.execute('BEGIN IMMEDIATE')
        row = connection.execute('SELECT data FROM rooms WHERE id=? AND expires>?', (room_id, stamp)).fetchone()
        if not row:
            raise Invalid('房间已关闭或过期', 404)
        room = json.loads(row[0])
        members = room['members']
        member = next((m for m in members if m['uid'] == uid), None)
        owner = uid == room['owner']
        if action == 'join':
            if not member:
                if len(members) >= 6:
                    raise Invalid('房间最多支持 6 人')
                if room['timeline']['state'] == 'playing' or stamp < room['timeline']['at']:
                    raise Invalid('正在播放，请房主暂停后再加入')
                member = dict(uid=uid, name=str(body.get('name', '参与者'))[:20], ready=False,
                              width=750, scale=1, offset=0, gap=0, seen=stamp, stage=False)
                members.append(member)
                reset(room)
        elif not member and not owner:
            raise Invalid('请先加入房间', 403)
        if action in ('config', 'sprite', 'order', 'remove', 'play', 'pause', 'close') and not owner:
            raise Invalid('仅房主可以执行此操作', 403)
        if action not in ('join', 'poll', 'leave', 'close'):
            if str(body.get('version')) != str(room['version']):
                raise Invalid('房间参数已更新，请重新确认', 409)
        if action == 'close':
            connection.execute('DELETE FROM rooms WHERE id=?', (room_id,))
            connection.commit()
            return jsonify(closed=True)
        if action in ('config', 'order', 'remove', 'calibrate', 'leave', 'sprite'):
            if room['timeline']['state'] == 'playing' or stamp < room['timeline']['at']:
                raise Invalid('请先暂停播放，再调整房间')
        if action == 'config':
            room['config'] = config(body.get('config'))
            if body.get('mode') not in ('sync', 'extend'):
                raise Invalid('模式无效')
            room['mode'] = body['mode']
            reset(room)
            room['spriteVersion'] = 0
            connection.execute('UPDATE rooms SET sprite=NULL WHERE id=?', (room_id,))
        elif action == 'sprite':
            file = request.files.get('file')
            data = file.read(1024*1024+1) if file else b''
            if len(data) < 24 or len(data) > 1024*1024 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
                raise Invalid('请上传 1MB 以内的 PNG 文字图片')
            width, height = struct.unpack('>II', data[16:24])
            if not 1 <= width <= 4096 or not 1 <= height <= 256:
                raise Invalid('文字图片尺寸无效')
            reset(room)
            room.update(spriteVersion=room['version'], spriteWidth=width, spriteHeight=height)
            connection.execute('UPDATE rooms SET sprite=? WHERE id=?', (data, room_id))
        elif action == 'order':
            order = body.get('order')
            if not isinstance(order, list) or not all(type(uid) in (int, str) for uid in order) or len(order) != len(members) or set(order) != {m['uid'] for m in members}:
                raise Invalid('成员顺序无效')
            room['members'] = sorted(members, key=lambda m: order.index(m['uid']))
            reset(room)
        elif action == 'remove':
            target = body.get('uid')
            if target == room['owner'] or not any(m['uid'] == target for m in members):
                raise Invalid('不能移除该成员')
            room['members'] = [m for m in members if m['uid'] != target]
            reset(room)
        elif action == 'calibrate':
            if not member:
                raise Invalid('请先加入', 403)
            values = dict(width=round(number(body.get('width'), 200, 3000), 3), scale=number(body.get('scale'), .5, 1.5),
                          offset=number(body.get('offset'), -100, 100), gap=number(body.get('gap'), 0, 100))
            if any(member[k] != v for k, v in values.items()):
                member.update(values)
                reset(room)
        elif action == 'ready':
            if not member or not room['spriteVersion'] or str(body.get('spriteVersion')) != str(room['spriteVersion']):
                raise Invalid('请等待文字图片加载完成')
            if not member.get('stage'):
                raise Invalid('请进入横屏并校准后再准备')
            member['ready'] = True
        elif action in ('play', 'pause'):
            if stamp < room['timeline']['at']:
                raise Invalid('指令正在生效，请稍候')
            if action == 'play' and (len(members) < 2 or not all(m['ready'] and m.get('stage') and stamp-m['seen'] < 8000 for m in members)):
                raise Invalid('至少两人进入横屏并准备完成才能播放')
            previous = {k: v for k, v in room['timeline'].items() if k != 'previous'}
            at = stamp + 3000
            room['timeline'] = dict(state='playing' if action == 'play' else 'paused', at=at,
                                    position=position(previous, at), previous=previous)
        elif action == 'leave':
            if owner:
                raise Invalid('房主请使用关闭房间')
            room['members'] = [m for m in members if m['uid'] != uid]
            reset(room)
        elif action not in ('join', 'poll'):
            raise Invalid('操作无效')
        if member and action != 'leave':
            member['seen'] = stamp
            if action == 'poll':
                member['stage'] = body.get('stage') is True
                if not member['stage']:
                    member['ready'] = False
        room['seq'] = room.get('seq', 0)+1
        connection.execute('UPDATE rooms SET data=?, active=? WHERE id=?', (json.dumps(room), stamp, room_id))
        connection.commit()
        return jsonify(room=room, uid=uid, serverTime=now())
    finally:
        connection.close()
