"""Public question catalog and short-lived two-player couple-wheel rooms."""
from __future__ import annotations

import hashlib
import hmac
import html
import json
import os
import re
import secrets
import sqlite3
import time
from collections import Counter
from pathlib import Path

from flask import Blueprint, Response, current_app, jsonify, make_response, redirect, request, url_for
from app.routes.couple_api_routes import _current_user, _user_payload


wheel_bp = Blueprint('couple_wheel', __name__, url_prefix='/api/couple/wheel')
ROOM_DB = os.getenv('COUPLE_WHEEL_DB', '/app/data/runtime/couple_wheel_rooms.sqlite3')
QUESTION_FILE = os.getenv(
    'COUPLE_WHEEL_QUESTIONS',
    str(Path(__file__).resolve().parents[1] / 'data' / 'couple_wheel_questions.json'),
)
ADULT_QUESTION_FILE = os.getenv(
    'COUPLE_WHEEL_ADULT_QUESTIONS',
    str(Path(__file__).resolve().parents[1] / 'data' / 'couple_wheel_adult_questions.json'),
)
ROOM_TTL = 2 * 60 * 60 * 1000
IDLE_TTL = 20 * 60 * 1000
SPIN_DURATION = 2800
MAX_ROOMS = 100
ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'


class Invalid(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


@wheel_bp.errorhandler(Invalid)
def invalid(error):
    return jsonify(message=error.message), error.status


def member_profile(required=True):
    actor_data = _current_user()
    profile = _user_payload(actor_data['user_id']) if actor_data and actor_data.get('user_id') else None
    allowed = bool(profile and profile.get('coupleId') and profile.get('role') in ('owner', 'member'))
    if not allowed and required:
        if not actor_data:
            raise Invalid('请先登录并激活情侣身份', 401)
        raise Invalid('仅已激活的情侣成员可以使用情侣转盘', 403)
    return profile if allowed else None


def ensure_room_scope(room, profile):
    couple_id = room.get('coupleId')
    if couple_id is None:
        room['coupleId'] = profile['coupleId']
    elif int(couple_id) != int(profile['coupleId']):
        raise Invalid('这个房间不属于你的情侣空间', 403)


@wheel_bp.before_request
def limit_body():
    if request.content_length and request.content_length > 64 * 1024:
        raise Invalid('请求内容过大', 413)


def now():
    return int(time.time() * 1000)


def catalog():
    stamp = os.path.getmtime(QUESTION_FILE)
    cached = getattr(catalog, '_cached', None)
    if cached and cached[0] == stamp:
        return cached[1]
    with open(QUESTION_FILE, encoding='utf-8') as source:
        value = json.load(source)
    levels = value.get('levels') if isinstance(value, dict) else None
    if not isinstance(levels, dict) or any(len(levels.get(level, [])) != 100 for level in ('basic', 'private')):
        raise RuntimeError('情侣转盘题库必须包含基础和私密各100题')
    catalog._cached = (stamp, value)
    return value


def questions(level):
    if level not in ('basic', 'private'):
        raise Invalid('题库类型无效')
    return catalog()['levels'][level]


def adult_catalog():
    stamp = os.path.getmtime(ADULT_QUESTION_FILE)
    cached = getattr(adult_catalog, '_cached', None)
    if cached and cached[0] == stamp:
        return cached[1]
    with open(ADULT_QUESTION_FILE, encoding='utf-8') as source:
        value = json.load(source)
    items = value.get('questions') if isinstance(value, dict) else None
    if not isinstance(items, list) or len(items) != 100:
        raise RuntimeError('成人亲密题库必须包含100题')
    if len({item.get('id') for item in items}) != 100 or len({item.get('text') for item in items}) != 100:
        raise RuntimeError('成人亲密题库题号或内容存在重复')
    adult_catalog._cached = (stamp, value)
    return value


def adult_signature(stamp):
    secret = current_app.secret_key or os.getenv('SECRET_KEY')
    if not secret:
        raise RuntimeError('服务器密钥未配置，成人题库暂不可用')
    return hmac.new(str(secret).encode('utf-8'), f'couple-wheel-adult:{stamp}'.encode('ascii'), hashlib.sha256).hexdigest()


def adult_confirmed():
    value = request.cookies.get('couple_wheel_adult', '')
    try:
        stamp, signature = value.split('.', 1)
        age = int(time.time()) - int(stamp)
    except (TypeError, ValueError):
        return False
    return 0 <= age <= 30 * 24 * 60 * 60 and hmac.compare_digest(signature, adult_signature(stamp))


def private_page_response(document, status=200):
    response = Response(document, status=status, content_type='text/html; charset=utf-8')
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


def database():
    os.makedirs(os.path.dirname(ROOM_DB) or '.', exist_ok=True)
    connection = sqlite3.connect(ROOM_DB, timeout=10)
    connection.execute('PRAGMA auto_vacuum=INCREMENTAL')
    connection.execute(
        'CREATE TABLE IF NOT EXISTS rooms '
        '(id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL)'
    )
    connection.execute('CREATE INDEX IF NOT EXISTS couple_wheel_expiry ON rooms(expires)')
    stamp = now()
    connection.execute('DELETE FROM rooms WHERE expires < ? OR active < ?', (stamp, stamp - IDLE_TTL))
    connection.commit()
    return connection


def actor():
    token = request.headers.get('X-Couple-Wheel-Guest', '')
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise Invalid('联机身份无效，请重新进入情侣转盘', 401)
    return hashlib.sha256(token.encode('ascii')).hexdigest()


def room_code(connection):
    for _ in range(20):
        code = ''.join(secrets.choice(ALPHABET) for _ in range(6))
        if not connection.execute('SELECT 1 FROM rooms WHERE id=?', (code,)).fetchone():
            return code
    raise Invalid('暂时无法创建房间，请稍后重试', 503)


def clean_name(value, fallback):
    result = re.sub(r'[\r\n\t]', ' ', str(value or '')).strip()[:12]
    return result or fallback


def public_room(room, uid):
    result = {
        'id': room['id'],
        'level': room['level'],
        'version': room['version'],
        'memberCount': len(room['members']),
        'members': [member['name'] for member in room['members']],
        'isOwner': room['owner'] == uid,
        'spin': room.get('spin'),
        'history': room.get('history', [])[-20:],
    }
    return result


def load_room(connection, room_id):
    row = connection.execute('SELECT data FROM rooms WHERE id=? AND expires>?', (room_id, now())).fetchone()
    if not row:
        raise Invalid('房间不存在、已关闭或已过期', 404)
    return json.loads(row[0])


def save_room(connection, room):
    stamp = now()
    connection.execute(
        'UPDATE rooms SET active=?, data=? WHERE id=?',
        (stamp, json.dumps(room, ensure_ascii=False, separators=(',', ':')), room['id']),
    )


@wheel_bp.get('/questions')
def list_questions():
    member_profile()
    level = request.args.get('level', 'basic')
    items = questions(level)
    counts = Counter(item['category'] for item in items)
    response = jsonify(
        version=catalog().get('version'), level=level, count=len(items),
        categories=[{'name': name, 'count': count} for name, count in counts.items()],
        questions=items,
    )
    response.headers['Cache-Control'] = 'public, max-age=3600'
    return response


@wheel_bp.get('/access')
def feature_access():
    profile = member_profile(required=False)
    response = jsonify(canUse=bool(profile), role=(profile or {}).get('role', 'guest'))
    response.headers['Cache-Control'] = 'no-store'
    return response


@wheel_bp.get('/catalog')
def catalog_page():
    selected = request.args.get('level', 'all')
    levels = ['basic', 'private'] if selected not in ('basic', 'private') else [selected]
    sections = []
    for level in levels:
        items = questions(level)
        rows = ''.join(
            f'<tr><td>{html.escape(item["id"])}</td><td>{html.escape(item["category"])}</td>'
            f'<td>{html.escape(item["text"])}</td></tr>' for item in items
        )
        title = '基础题库' if level == 'basic' else '私密题库（仅限自愿成年情侣）'
        sections.append(f'<section><h2>{title} · {len(items)}题</h2><table><thead><tr><th>ID</th><th>分类</th><th>问题</th></tr></thead><tbody>{rows}</tbody></table></section>')
    document = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>情侣转盘题库</title><style>
body{{margin:0;background:#fff7f8;color:#493c40;font:14px/1.6 system-ui,-apple-system,sans-serif}}main{{max-width:1080px;margin:auto;padding:32px 18px 60px}}h1{{margin-bottom:6px}}.meta{{color:#a17f88}}nav a{{display:inline-block;margin:14px 8px 20px 0;padding:8px 14px;border-radius:20px;background:#f5dfe5;color:#a55369;text-decoration:none}}section{{background:#fff;margin:18px 0;padding:20px;border-radius:18px;box-shadow:0 8px 26px #9b657214}}table{{width:100%;border-collapse:collapse}}th,td{{padding:10px;border-bottom:1px solid #f2e7ea;text-align:left;vertical-align:top}}th:first-child,td:first-child{{width:58px}}th:nth-child(2),td:nth-child(2){{width:90px}}@media(max-width:600px){{main{{padding:20px 10px}}section{{padding:12px}}th,td{{padding:8px 5px}}}}
</style></head><body><main><h1>情侣转盘题库</h1><div class="meta">版本 {html.escape(str(catalog().get('version')))} · 基础100题 · 私密100题</div><p>题目为项目原创整理。私密题仅供双方自愿的成年情侣使用，任何一方都可以随时跳过或停止。</p><nav><a href="?level=all">全部</a><a href="?level=basic">基础</a><a href="?level=private">私密</a><a href="questions?level=basic">基础JSON</a><a href="questions?level=private">私密JSON</a></nav>{''.join(sections)}</main></body></html>'''
    return Response(document, content_type='text/html; charset=utf-8', headers={'Cache-Control': 'public, max-age=300'})


@wheel_bp.route('/adult', methods=['GET', 'POST'])
def adult_page():
    if request.method == 'POST':
        if request.form.get('confirm') != 'adult':
            return redirect(url_for('couple_wheel.adult_page'))
        stamp = str(int(time.time()))
        response = make_response(redirect(url_for('couple_wheel.adult_page')))
        response.set_cookie(
            'couple_wheel_adult', f'{stamp}.{adult_signature(stamp)}',
            max_age=30 * 24 * 60 * 60, secure=True, httponly=True, samesite='Lax', path='/api/couple/wheel/adult',
        )
        return response
    if request.args.get('leave') == '1':
        response = make_response(redirect(url_for('couple_wheel.adult_page')))
        response.delete_cookie('couple_wheel_adult', path='/api/couple/wheel/adult')
        return response
    if not adult_confirmed():
        gate = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>成人亲密题库 · 进入确认</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;background:radial-gradient(circle at top,#fff1f4,#f8e9ed 48%,#ecd9df);color:#4a3940;font:15px/1.7 system-ui,-apple-system,sans-serif}.gate{width:min(520px,100%);padding:34px 28px;background:#fff;border:1px solid #f0dce2;border-radius:26px;box-shadow:0 22px 70px #7d405625}.mark{width:68px;height:68px;display:grid;place-items:center;margin:0 auto 20px;border-radius:22px;background:#a95068;color:#fff;font-size:22px;font-weight:800}h1{text-align:center;margin:0;font-size:27px}.sub{text-align:center;color:#a27c88;margin:8px 0 24px}.notice{padding:18px;background:#fff6f8;border-radius:16px;color:#745a63}.notice strong{color:#9a435b}label{display:flex;gap:10px;align-items:flex-start;margin:22px 2px;color:#644f56}input{margin-top:6px;accent-color:#a95068}button{width:100%;height:50px;border:0;border-radius:999px;background:#a95068;color:#fff;font-size:16px;font-weight:700;cursor:pointer}.back{display:block;text-align:center;margin-top:18px;color:#9c7681;text-decoration:none}.fine{margin:18px 0 0;color:#aa9299;font-size:12px;text-align:center}</style></head><body><main class="gate"><div class="mark">18+</div><h1>禁忌 · 成人亲密题库</h1><p class="sub">100 道只适合自愿成年情侣的问题</p><div class="notice"><strong>进入前请确认：</strong><br>内容会直接讨论性、私密部位、偏好、避孕与健康。任何一方都可以拒绝回答、跳过问题或立即停止；沉默和犹豫不代表同意。</div><form method="post"><label><input type="checkbox" required>我已年满 18 周岁，并理解这不是对伴侣施压的工具。</label><button type="submit" name="confirm" value="adult">双方自愿，进入题库</button></form><a class="back" href="/api/couple/wheel/catalog">返回普通题库</a><p class="fine">确认状态仅保存在本浏览器 30 天，不记录回答内容。</p></main></body></html>'''
        return private_page_response(gate)

    source = adult_catalog()
    items = source['questions']
    counts = Counter(item['category'] for item in items)
    payload = json.dumps(items, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    category_options = ''.join(
        f'<option value="{html.escape(name)}">{html.escape(name)} · {count}题</option>'
        for name, count in counts.items()
    )
    rows = ''.join(
        f'<article class="question" data-category="{html.escape(item["category"])}"><span>{html.escape(item["category"])}</span>'
        f'<b>{html.escape(item["id"])}</b><p>{html.escape(item["text"])}</p></article>' for item in items
    )
    document = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>禁忌 · 成人亲密题库</title><style>
*{box-sizing:border-box}body{margin:0;background:#f9eef1;color:#48383e;font:14px/1.6 system-ui,-apple-system,sans-serif}main{max-width:1050px;margin:auto;padding:28px 16px 70px}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.eyebrow{color:#aa526b;letter-spacing:3px;font-size:12px}h1{font-size:30px;margin:5px 0 3px}.meta{color:#a1828b}.leave{color:#9a6977;text-decoration:none}.safety{margin:22px 0;padding:15px 18px;border-radius:16px;background:#fff7f9;border:1px solid #eed9df;color:#725961}.draw{background:linear-gradient(145deg,#943e58,#b9647a);padding:26px;border-radius:24px;color:#fff;box-shadow:0 18px 44px #79334a2b}.draw-head{display:flex;gap:12px;align-items:center;justify-content:space-between}.draw select{max-width:210px;padding:10px 12px;border:0;border-radius:12px;color:#68434f;background:#fff}.result{min-height:112px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:18px 8px}.result small{opacity:.75}.result strong{font-size:22px;line-height:1.55;margin-top:8px}.draw button{display:block;margin:auto;padding:12px 30px;border:0;border-radius:999px;background:#fff;color:#963f59;font-weight:800;font-size:15px;cursor:pointer}.summary{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}.summary span{padding:8px 13px;background:#fff;border-radius:999px;color:#865c68}.list-head{display:flex;align-items:end;justify-content:space-between;margin:26px 0 12px}.list-head h2{margin:0}.list-head input{width:min(280px,48vw);padding:11px 14px;border:1px solid #e9d5db;border-radius:13px;background:#fff}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.question{position:relative;background:#fff;border-radius:17px;padding:17px 18px;box-shadow:0 8px 24px #8752690b}.question span{display:inline-block;padding:3px 9px;border-radius:999px;background:#fae8ed;color:#a54d65;font-size:11px}.question b{position:absolute;right:16px;top:18px;color:#c2a7af;font-size:11px}.question p{margin:12px 0 0;font-size:15px}.empty{display:none;text-align:center;color:#a88b94;padding:30px}@media(max-width:660px){main{padding:20px 12px 56px}.top{align-items:center}h1{font-size:25px}.draw{padding:20px 16px}.draw-head{align-items:flex-start;flex-direction:column}.draw select{max-width:none;width:100%}.grid{grid-template-columns:1fr}.list-head{align-items:flex-start;gap:12px;flex-direction:column}.list-head input{width:100%}}</style></head><body><main><header class="top"><div><div class="eyebrow">ADULT COUPLE WHEEL</div><h1>禁忌 · 成人亲密题库</h1><div class="meta">__VERSION__ · 100题 · 仅限自愿成年情侣</div></div><a class="leave" href="?leave=1">退出</a></header><div class="safety">这套问题用于沟通，而不是测试、说服或施压。任何时候都可以跳过；一方犹豫时默认停止。本站不保存你们的回答。</div><section class="draw"><div class="draw-head"><div><b>随机抽取</b><div style="opacity:.75;font-size:12px">当前筛选内不重复，抽完自动重置</div></div><select id="category"><option value="">全部分类 · 100题</option>__OPTIONS__</select></div><div class="result"><small id="resultCategory">准备好后，抽一道问题</small><strong id="resultText">只回答双方都愿意谈的内容</strong></div><button id="drawButton">随机一题</button></section><div class="summary">__SUMMARY__</div><div class="list-head"><h2>完整题库</h2><input id="search" placeholder="搜索题目或分类"></div><section class="grid" id="questions">__ROWS__</section><div class="empty" id="empty">没有找到对应题目</div></main><script>const questions=__PAYLOAD__;let bag=[];const category=document.getElementById('category'),search=document.getElementById('search'),cards=[...document.querySelectorAll('.question')];function pool(){return questions.filter(q=>!category.value||q.category===category.value)}function reset(){bag=[]}function draw(){const source=pool();if(!bag.length)bag=source.map(q=>q.id).sort(()=>Math.random()-.5);const id=bag.pop(),q=source.find(item=>item.id===id);if(!q)return;document.getElementById('resultCategory').textContent=q.category+' · '+q.id;document.getElementById('resultText').textContent=q.text}function filter(){const key=search.value.trim().toLowerCase();let visible=0;cards.forEach(card=>{const show=(!category.value||card.dataset.category===category.value)&&(!key||card.textContent.toLowerCase().includes(key));card.style.display=show?'':'none';if(show)visible++});document.getElementById('empty').style.display=visible?'none':'block'}category.addEventListener('change',()=>{reset();filter()});search.addEventListener('input',filter);document.getElementById('drawButton').addEventListener('click',draw);</script></body></html>'''
    summary = ''.join(f'<span>{html.escape(name)} {count}</span>' for name, count in counts.items())
    document = document.replace('__VERSION__', html.escape(str(source.get('version', '')))).replace('__OPTIONS__', category_options).replace('__SUMMARY__', summary).replace('__ROWS__', rows).replace('__PAYLOAD__', payload)
    return private_page_response(document)


@wheel_bp.get('/adult/questions')
def adult_question_data():
    if not adult_confirmed():
        return jsonify(message='请先在成人题库页面确认已成年且自愿'), 403
    source = adult_catalog()
    items = source['questions']
    counts = Counter(item['category'] for item in items)
    response = jsonify(
        version=source.get('version'), title=source.get('title'), notice=source.get('notice'), count=len(items),
        categories=[{'name': name, 'count': count} for name, count in counts.items()], questions=items,
    )
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
    return response


@wheel_bp.post('/session')
def guest_session():
    member_profile()
    response = jsonify(token=secrets.token_hex(32))
    response.headers['Cache-Control'] = 'no-store'
    return response, 201


@wheel_bp.post('/rooms')
def create_room():
    profile = member_profile()
    uid = actor()
    body = request.get_json(silent=True) or {}
    level = body.get('level', 'basic')
    questions(level)
    stamp = now()
    connection = database()
    try:
        connection.execute('BEGIN IMMEDIATE')
        if connection.execute('SELECT count(*) FROM rooms').fetchone()[0] >= MAX_ROOMS:
            raise Invalid('当前联机房间较多，请稍后重试', 429)
        if connection.execute('SELECT count(*) FROM rooms WHERE owner=?', (uid,)).fetchone()[0] >= 3:
            raise Invalid('本机最多保留3个房间，请等待旧房间过期')
        code = room_code(connection)
        room = {
            'id': code, 'owner': uid, 'level': level, 'version': 1,
            'coupleId': profile['coupleId'],
            'members': [{'uid': uid, 'name': clean_name(body.get('name'), '玩家1')}],
            'used': [], 'cycle': 1, 'spin': None, 'history': [],
        }
        connection.execute(
            'INSERT INTO rooms VALUES (?,?,?,?,?)',
            (code, uid, stamp + ROOM_TTL, stamp, json.dumps(room, ensure_ascii=False, separators=(',', ':'))),
        )
        connection.commit()
        return jsonify(room=public_room(room, uid), serverTime=stamp), 201
    finally:
        connection.close()


@wheel_bp.post('/rooms/<room_id>/join')
def join_room(room_id):
    profile = member_profile()
    uid = actor()
    body = request.get_json(silent=True) or {}
    connection = database()
    try:
        connection.execute('BEGIN IMMEDIATE')
        room = load_room(connection, room_id.upper())
        ensure_room_scope(room, profile)
        member = next((item for item in room['members'] if item['uid'] == uid), None)
        if not member:
            if len(room['members']) >= 2:
                raise Invalid('房间已有两位玩家', 409)
            room['members'].append({'uid': uid, 'name': clean_name(body.get('name'), '玩家2')})
            room['version'] += 1
        else:
            member['name'] = clean_name(body.get('name'), member['name'])
        save_room(connection, room)
        connection.commit()
        return jsonify(room=public_room(room, uid), serverTime=now())
    finally:
        connection.close()


@wheel_bp.get('/rooms/<room_id>')
def read_room(room_id):
    profile = member_profile()
    uid = actor()
    connection = database()
    try:
        room = load_room(connection, room_id.upper())
        ensure_room_scope(room, profile)
        if not any(item['uid'] == uid for item in room['members']):
            raise Invalid('请先加入这个房间', 403)
        save_room(connection, room)
        connection.commit()
        response = jsonify(room=public_room(room, uid), serverTime=now())
        response.headers['Cache-Control'] = 'no-store'
        return response
    finally:
        connection.close()


@wheel_bp.post('/rooms/<room_id>')
def room_action(room_id):
    profile = member_profile()
    uid = actor()
    body = request.get_json(silent=True) or {}
    action = body.get('action')
    connection = database()
    try:
        connection.execute('BEGIN IMMEDIATE')
        room = load_room(connection, room_id.upper())
        ensure_room_scope(room, profile)
        if not any(item['uid'] == uid for item in room['members']):
            raise Invalid('你已不在这个房间中', 403)
        stamp = now()
        if action == 'spin':
            previous = room.get('spin') or {}
            if previous and stamp < previous.get('startedAt', 0) + SPIN_DURATION:
                raise Invalid('转盘仍在转动，请稍等', 409)
            pool = questions(room['level'])
            used = set(room.get('used', []))
            available = [item for item in pool if item['id'] not in used]
            if not available:
                room['used'] = []
                room['cycle'] = int(room.get('cycle', 1)) + 1
                available = pool
            selected = available[secrets.randbelow(len(available))]
            room['used'].append(selected['id'])
            categories = list(dict.fromkeys(item['category'] for item in pool))
            sequence = int(previous.get('seq', 0)) + 1
            history_key = f'{selected["id"]}-{sequence}-{stamp}'
            room['spin'] = {
                'seq': sequence,
                'question': selected,
                'segment': categories.index(selected['category']),
                'segments': categories,
                'startedAt': stamp + 350,
                'duration': SPIN_DURATION,
                'historyKey': history_key,
            }
            room['history'] = (room.get('history', []) + [{
                'key': history_key, 'id': selected['id'], 'text': selected['text'],
                'category': selected['category'], 'at': stamp, 'cycle': int(room.get('cycle', 1)),
            }])[-20:]
            room['version'] += 1
        elif action == 'level':
            if room['owner'] != uid:
                raise Invalid('只有房主可以切换题库', 403)
            level = body.get('level')
            questions(level)
            room.update(level=level, used=[], cycle=1, spin=None, history=[], version=room['version'] + 1)
        elif action == 'restore':
            history_key = str(body.get('key') or '')[:80]
            history = room.get('history', [])
            index = next((position for position in range(len(history) - 1, -1, -1)
                          if (history[position].get('key') or f'{history[position].get("id")}-{history[position].get("at")}') == history_key), None)
            if index is None:
                raise Invalid('这条抽题记录已不存在', 404)
            restored = history.pop(index)
            if int(restored.get('cycle', room.get('cycle', 1))) == int(room.get('cycle', 1)):
                try:
                    room.get('used', []).remove(restored.get('id'))
                except ValueError:
                    pass
            if (room.get('spin') or {}).get('historyKey') == history_key:
                room['spin'] = None
            room['history'] = history
            room['version'] += 1
        elif action == 'clear_history':
            current_cycle = int(room.get('cycle', 1))
            restored_ids = {
                item.get('id') for item in room.get('history', [])
                if int(item.get('cycle', current_cycle)) == current_cycle
            }
            room['used'] = [item_id for item_id in room.get('used', []) if item_id not in restored_ids]
            room['history'] = []
            room['spin'] = None
            room['version'] += 1
        elif action == 'leave':
            room['members'] = [item for item in room['members'] if item['uid'] != uid]
            if not room['members']:
                connection.execute('DELETE FROM rooms WHERE id=?', (room['id'],))
                connection.commit()
                return jsonify(closed=True)
            if room['owner'] == uid:
                room['owner'] = room['members'][0]['uid']
            room['version'] += 1
        else:
            raise Invalid('操作无效')
        save_room(connection, room)
        connection.commit()
        return jsonify(room=public_room(room, uid), serverTime=stamp)
    finally:
        connection.close()
