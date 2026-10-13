"""Editable, member-only anniversaries and transactional annual in-app reminders."""
import calendar
import json
import re
from datetime import date, datetime, timedelta, timezone

from flask import Blueprint, g, jsonify, request
from sqlalchemy import (MetaData, Table, Column, Integer, String, Boolean,
                        DateTime, UniqueConstraint, select, text)
from lunar_python import Lunar, LunarMonth
from app.extensions import db
from app.routes.couple_api_routes import _current_user

anniversaries_bp = Blueprint('anniversaries', __name__, url_prefix='/api/couple/anniversaries')
BEIJING = timezone(timedelta(hours=8))
metadata = MetaData()
anniversaries = Table('couple_anniversaries', metadata,
    Column('id', Integer, primary_key=True, autoincrement=True),
    Column('couple_id', Integer, nullable=False, index=True),
    Column('seed_key', String(40)),
    Column('title', String(80), nullable=False),
    Column('event_kind', String(16), nullable=False, default='anniversary'),
    Column('calendar_type', String(10), nullable=False),
    Column('start_year', Integer), Column('month', Integer, nullable=False),
    Column('day', Integer, nullable=False), Column('leap_month', Boolean, nullable=False, default=False),
    Column('enabled', Boolean, nullable=False, default=True),
    Column('reminder_minutes', Integer, nullable=False, default=600),
    Column('reminder_days', String(40), nullable=False, default='[7,3,1,0]'),
    Column('deleted', Boolean, nullable=False, default=False),
    Column('version', Integer, nullable=False, default=1),
    Column('updated_by', Integer), Column('updated_at', DateTime, nullable=False),
    UniqueConstraint('couple_id', 'seed_key'))
deliveries = Table('couple_anniversary_deliveries', metadata,
    Column('id', Integer, primary_key=True, autoincrement=True),
    Column('event_id', Integer, nullable=False), Column('recipient_id', Integer, nullable=False),
    Column('cycle_year', Integer, nullable=False), Column('advance_days', Integer, nullable=False),
    Column('created_at', DateTime, nullable=False),
    Column('event_version', Integer, nullable=False),
    Column('title', String(120), nullable=False), Column('content', String(500), nullable=False),
    Column('email_status', String(20), nullable=False), Column('attempts', Integer, nullable=False, default=0),
    Column('next_attempt', DateTime, nullable=False), Column('expires_at', DateTime, nullable=False),
    UniqueConstraint('event_id', 'recipient_id', 'cycle_year', 'advance_days'))
preferences = Table('couple_anniversary_preferences', metadata,
    Column('user_id', Integer, primary_key=True), Column('email', String(200), nullable=False),
    Column('email_enabled', Boolean, nullable=False, default=False))

# Neutral examples for a fresh public deployment. They can all be edited or
# deleted in the app; no private names or dates from the original instance are
# included here.
DEFAULTS = [
    ('partner-a-birthday', '伴侣 A 的生日', 'lunar', None, 1, 1),
    ('partner-b-birthday', '伴侣 B 的生日', 'lunar', None, 2, 2),
    ('first-met', '初次相识', 'solar', 2025, 1, 1),
    ('promise-day', '特别约定', 'solar', 2025, 2, 14),
    ('shared-anniversary', '共同纪念日', 'solar', 2025, 5, 20),
]

def now():
    return datetime.now(BEIJING)

def init_anniversaries(app):
    from app.routes import anniversary_wechat
    with app.app_context():
        # Gunicorn starts multiple workers: serialize first-time MySQL DDL.
        with db.engine.connect() as connection:
            mysql = connection.dialect.name in ('mysql','mariadb')
            if mysql and connection.execute(text("SELECT GET_LOCK('couple_space_anniversary_schema',30)")).scalar()!=1:
                raise RuntimeError('Anniversary schema initialization lock unavailable')
            try:
                metadata.create_all(connection)
                anniversary_wechat.metadata.create_all(connection)
                connection.commit()
            finally:
                if mysql: connection.execute(text("SELECT RELEASE_LOCK('couple_space_anniversary_schema')"))

def seed_defaults(couple_id):
    """Explicit deployment operation for the intended space, not every user's space."""
    stamp = now().replace(tzinfo=None)
    for key, title, kind, year, month, day in DEFAULTS:
        if db.session.execute(select(anniversaries.c.id).where(
                anniversaries.c.couple_id == couple_id, anniversaries.c.seed_key == key)).first():
            continue
        db.session.execute(anniversaries.insert().values(
            couple_id=couple_id, seed_key=key, title=title, event_kind='birthday' if key.endswith('birthday') else 'anniversary', calendar_type=kind,
            start_year=year, month=month, day=day, leap_month=False, enabled=True,
            reminder_minutes=600, reminder_days='[7,3,1,0]', deleted=False, version=1, updated_at=stamp))
    db.session.commit()

@anniversaries_bp.before_request
def member_only():
    actor = _current_user()
    if not actor:
        return jsonify(message='请先登录'), 401
    member = db.session.execute(text('SELECT couple_id,role FROM couple_members WHERE user_id=:uid'),
                                {'uid': actor['user_id']}).mappings().first()
    if not member or member['role'] not in ('owner', 'member'):
        return jsonify(message='激活情侣身份后才能使用纪念日'), 403
    g.anniversary_member = dict(member, user_id=actor['user_id'])

def occurrence(item, year):
    """One celebration per calendar year; missing leap month -> normal month."""
    month, day = item['month'], item['day']
    if item['calendar_type'] == 'solar':
        return date(year, month, min(day, calendar.monthrange(year, month)[1]))
    lunar_month = -month if item['leap_month'] else month
    info = LunarMonth.fromYm(year, lunar_month)
    if info is None:
        lunar_month = month
        info = LunarMonth.fromYm(year, month)
    solar = Lunar.fromYmd(year, lunar_month, min(day, info.getDayCount())).getSolar()
    return date(solar.getYear(), solar.getMonth(), solar.getDay())

def next_occurrence(item, today):
    candidates = []
    # Lunar December can fall in January/February of the following Gregorian year.
    for year in range(today.year - 1, today.year + 3):
        if item['start_year'] and year < item['start_year']:
            continue
        target = occurrence(item, year)
        if target >= today:
            candidates.append((target, year))
    return min(candidates) if candidates else (None, None)

def serialize(row, today):
    item = dict(row)
    target, year = next_occurrence(item, today)
    hours, minutes = divmod(item['reminder_minutes'], 60)
    label = ('农历' if item['calendar_type'] == 'lunar' else '公历')
    label += ('闰' if item['leap_month'] else '') + f"{item['month']}月{item['day']}日"
    if item['start_year']:
        label = f"{item['start_year']}年起 · " + label
    if item['event_kind'] == 'birthday':
        elapsed_from = None
    elif item['start_year']:
        elapsed_from = occurrence(item, item['start_year'])
    else:
        # Unknown birthday year: duration since the most recent annual occurrence, not age.
        elapsed_from = max(occurrence(item, y) for y in range(today.year-2, today.year+1)
                           if occurrence(item, y) <= today)
    return dict(id=item['id'], title=item['title'], eventKind=item['event_kind'], calendarType=item['calendar_type'],
        startYear=item['start_year'], month=item['month'], day=item['day'], leapMonth=item['leap_month'],
        enabled=item['enabled'], reminderTime=f'{hours:02}:{minutes:02}', reminderDays=json.loads(item['reminder_days']),
        version=item['version'], dateLabel=label, nextDate=target.isoformat() if target else '',
        elapsedFrom=elapsed_from.isoformat()+'T00:00:00+08:00' if elapsed_from else '',
        elapsedBasis='original' if item['start_year'] else 'latest',
        daysUntil=(target-today).days if target else None,
        years=(year-item['start_year']) if year is not None and item['start_year'] and item['event_kind'] != 'birthday' else None)

def integer(value, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError('日期或提醒参数无效')
    return value

def validate(body):
    if not isinstance(body, dict):
        raise ValueError('纪念日信息无效')
    title = body.get('title')
    if not isinstance(title, str) or not title.strip() or len(title.strip()) > 80:
        raise ValueError('标题需要1～80个字符')
    kind = body.get('calendarType')
    if kind not in ('solar', 'lunar'):
        raise ValueError('请选择公历或农历')
    event_kind = body.get('eventKind', 'anniversary')
    if event_kind not in ('birthday', 'anniversary'):
        raise ValueError('请选择生日或纪念日')
    year = body.get('startYear')
    if year is not None:
        integer(year, 1901, 2099)
    month = integer(body.get('month'), 1, 12)
    day = integer(body.get('day'), 1, 31 if kind == 'solar' else 30)
    leap = body.get('leapMonth', False)
    enabled = body.get('enabled', True)
    if type(leap) is not bool or type(enabled) is not bool:
        raise ValueError('开关参数无效')
    if kind == 'solar':
        if leap: raise ValueError('公历没有闰月选项')
        try: date(year or 2000, month, day)
        except ValueError: raise ValueError('公历日期不存在')
    elif year:
        info = LunarMonth.fromYm(year, -month if leap else month)
        if info is None or day > info.getDayCount():
            raise ValueError('所选年份的农历日期不存在')
    time = body.get('reminderTime', '10:00')
    if not isinstance(time, str) or len(time) != 5 or time[2] != ':' or not (time[:2]+time[3:]).isdigit():
        raise ValueError('提醒时间格式应为 HH:mm')
    hour, minute = int(time[:2]), int(time[3:])
    integer(hour, 0, 23); integer(minute, 0, 59)
    days = body.get('reminderDays', [7, 3, 1, 0])
    if not isinstance(days, list) or not days or len(days) > 4 or any(type(n) is not int or n not in (0,1,3,7) for n in days):
        raise ValueError('请选择提前7天、3天、1天或当天提醒')
    return dict(title=title.strip(), event_kind=event_kind, calendar_type=kind, start_year=year, month=month, day=day,
                leap_month=leap, enabled=enabled, reminder_minutes=hour*60+minute,
                reminder_days=json.dumps(sorted(set(days), reverse=True)))

@anniversaries_bp.get('')
def list_items():
    cid = g.anniversary_member['couple_id']
    rows = db.session.execute(select(anniversaries).where(
        anniversaries.c.couple_id == cid, anniversaries.c.deleted == False)).mappings().all()
    today = now().date()
    items = sorted((serialize(row, today) for row in rows), key=lambda item: (item['nextDate'], item['id']))
    response = jsonify(items=items, canEdit=True, today=today.isoformat(),
        notificationChannel='in_app', notificationChannels=['in_app','email','wechat_subscription'], timezone='Asia/Shanghai')
    response.headers['Cache-Control'] = 'no-store'
    return response

@anniversaries_bp.post('')
def create_item():
    try: values = validate(request.get_json(silent=True))
    except ValueError as error: return jsonify(message=str(error)), 400
    member = g.anniversary_member
    # Lock the space to bound concurrent creation at 50 records.
    db.session.execute(text('SELECT id FROM couple_spaces WHERE id=:cid FOR UPDATE'),
                       {'cid': member['couple_id']}).first()
    count = db.session.execute(select(anniversaries.c.id).where(
        anniversaries.c.couple_id == member['couple_id'], anniversaries.c.deleted == False)).all()
    if len(count) >= 50: return jsonify(message='最多保留50个纪念日'), 409
    result = db.session.execute(anniversaries.insert().values(**values, couple_id=member['couple_id'],
        version=1, updated_by=member['user_id'], updated_at=now().replace(tzinfo=None)))
    db.session.commit()
    return jsonify(id=result.inserted_primary_key[0]), 201

@anniversaries_bp.put('/<int:item_id>')
def update_item(item_id):
    body = request.get_json(silent=True)
    try:
        values = validate(body)
        version = integer(body.get('version'), 1, 2147483646)
    except ValueError as error: return jsonify(message=str(error)), 400
    return change_item(item_id, version, values)

@anniversaries_bp.delete('/<int:item_id>')
def delete_item(item_id):
    try: version = integer((request.get_json(silent=True) or {}).get('version'), 1, 2147483646)
    except (ValueError, AttributeError): return jsonify(message='版本参数无效'), 400
    return change_item(item_id, version, dict(deleted=True, enabled=False))

def change_item(item_id, version, values):
    member = g.anniversary_member
    clause = (anniversaries.c.id == item_id, anniversaries.c.couple_id == member['couple_id'],
              anniversaries.c.deleted == False)
    row = db.session.execute(select(anniversaries).where(*clause).with_for_update()).mappings().first()
    if not row: return jsonify(message='纪念日不存在'), 404
    if row['version'] != version: return jsonify(message='对方已修改，请刷新后重试'), 409
    db.session.execute(anniversaries.update().where(*clause).values(**values, version=version+1,
        updated_by=member['user_id'], updated_at=now().replace(tzinfo=None)))
    db.session.commit()
    return jsonify(success=True)

def mail_preference(uid):
    own = db.session.execute(select(preferences).where(preferences.c.user_id == uid)).mappings().first()
    if own:
        return dict(own)
    previous = db.session.execute(text('SELECT email,email_enabled FROM couple_notification_settings WHERE user_id=:uid'),
                                  {'uid': uid}).mappings().first()
    return dict(previous) if previous else dict(email='', email_enabled=False)

@anniversaries_bp.get('/settings')
def settings():
    from app.routes import anniversary_wechat
    from app.routes.notifications_api_routes import _smtp_settings
    uid = g.anniversary_member['user_id']
    pref = mail_preference(uid)
    rows = db.session.execute(select(deliveries.c.title, deliveries.c.email_status, deliveries.c.created_at)
        .where(deliveries.c.recipient_id == uid).order_by(deliveries.c.id.desc()).limit(12)).mappings().all()
    response = jsonify(email=pref['email'], emailEnabled=bool(pref['email_enabled']),
        smtpConfigured=bool(_smtp_settings()), wechat=anniversary_wechat.status(uid), deliveries=[dict(title=r['title'], status=r['email_status'],
        createdAt=r['created_at'].isoformat(sep=' ')) for r in rows])
    response.headers['Cache-Control'] = 'no-store'
    return response

@anniversaries_bp.put('/settings')
def save_settings():
    from app.routes.notifications_api_routes import _normalise_email
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or type(body.get('emailEnabled')) is not bool:
        return jsonify(message='邮箱设置无效'), 400
    email = _normalise_email(body.get('email'))
    if body['emailEnabled'] and not email or len(email) > 200:
        return jsonify(message='请填写有效的收件邮箱'), 400
    uid = g.anniversary_member['user_id']
    # Membership row also serializes first-time preference inserts.
    db.session.execute(text('SELECT user_id FROM couple_members WHERE user_id=:uid FOR UPDATE'), {'uid': uid}).first()
    existing = db.session.execute(select(preferences.c.user_id).where(preferences.c.user_id == uid)).first()
    values = dict(email=email, email_enabled=body['emailEnabled'])
    db.session.execute(preferences.update().where(preferences.c.user_id == uid).values(**values)
                       if existing else preferences.insert().values(user_id=uid, **values))
    db.session.commit()
    return jsonify(success=True)

@anniversaries_bp.post('/wechat-subscription')
def wechat_subscription():
    from app.routes import anniversary_wechat as wx
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or type(body.get('enabled')) is not bool:
        return jsonify(message='订阅设置无效'), 400
    uid = g.anniversary_member['user_id']
    if not body['enabled']:
        db.session.execute(wx.subscriptions.update().where(wx.subscriptions.c.user_id==uid).values(enabled=False))
        db.session.commit()
        return jsonify(success=True)
    if not wx.configured(): return jsonify(message='微信通知服务尚未配置'), 503
    receipt = body.get('receiptId','')
    state = body.get('state')
    if (body.get('templateId')!=wx.template_id() or body.get('result')!='accept' or
            not isinstance(receipt,str) or not re.fullmatch(r'[A-Za-z0-9-]{16,64}',receipt) or
            state not in ('developer','trial','formal')):
        return jsonify(message='请先在微信中同意日程提醒订阅'), 400
    wx.consent(uid, receipt, state, now().replace(tzinfo=None))
    db.session.commit()
    return jsonify(success=True)


def dispatch_due(stamp=None):
    """Cron every 5 minutes. No network delivery; row and dedupe marker commit together."""
    from app.routes import anniversary_wechat as wx
    stamp = stamp or now()
    stamp = stamp.astimezone(BEIJING)
    today = stamp.date()
    sent = 0
    ids = db.session.execute(select(anniversaries.c.id).where(
        anniversaries.c.enabled == True, anniversaries.c.deleted == False)).scalars().all()
    db.session.commit()
    for item_id in ids:
        try:
            # Updates/deletes and parallel cron runs serialize on this event.
            row = db.session.execute(select(anniversaries).where(
                anniversaries.c.id == item_id).with_for_update()).mappings().first()
            if not row or row['deleted'] or not row['enabled']:
                db.session.rollback()
                continue
            target, year = next_occurrence(row, today)
            offsets = set(json.loads(row['reminder_days']))
            minute = stamp.hour*60+stamp.minute
            due_offsets = [n for n in offsets if target and target-timedelta(days=n) == today
                           and minute >= row['reminder_minutes']]
            if not due_offsets:
                db.session.rollback()
                continue
            recipients = db.session.execute(text(
                'SELECT m.user_id,s.in_app_enabled FROM couple_members m LEFT JOIN couple_notification_settings s '
                'ON s.user_id=m.user_id WHERE m.couple_id=:cid '
                "AND m.role IN ('owner','member')"),
                {'cid': row['couple_id']}).mappings().all()
            for offset in due_offsets:
                for recipient in recipients:
                    uid = recipient['user_id']
                    pref = mail_preference(uid)
                    email_enabled = bool(pref['email_enabled'] and pref['email'])
                    in_app = recipient['in_app_enabled'] is None or bool(recipient['in_app_enabled'])
                    if not email_enabled and not in_app and not wx.eligible(uid): continue
                    exists = db.session.execute(select(deliveries.c.id).where(
                        deliveries.c.event_id == item_id, deliveries.c.recipient_id == uid,
                        deliveries.c.cycle_year == year, deliveries.c.advance_days == offset)).first()
                    if exists: continue
                    title = ('今天是' if offset == 0 else f'{offset}天后是') + row['title']
                    content = f"{target.isoformat()} · {row['title']}，记得留一点时间给这个特别的日子。"
                    result = db.session.execute(deliveries.insert().values(event_id=item_id, recipient_id=uid,
                        cycle_year=year, advance_days=offset, created_at=stamp.replace(tzinfo=None),
                        event_version=row['version'], title=title, content=content, attempts=0,
                        email_status='pending' if email_enabled else 'disabled',
                        next_attempt=stamp.replace(tzinfo=None),
                        expires_at=datetime.combine(today+timedelta(days=2), datetime.min.time())))
                    wx.enqueue(result.inserted_primary_key[0], uid, row, target, stamp.replace(tzinfo=None))
                    if in_app: db.session.execute(text(
                        "INSERT INTO couple_notifications(couple_id,recipient_id,type,title,content,payload_json,channel) "
                        "VALUES(:cid,:uid,'anniversary',:title,:content,:payload,'in_app')"),
                        dict(cid=row['couple_id'], uid=uid, title=title, content=content,
                             payload=json.dumps(dict(anniversaryId=item_id, occurrenceDate=target.isoformat()), ensure_ascii=False)))
                    sent += 1
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise  # cron reports failure; next run can safely retry.
    return sent

def send_pending(stamp=None):
    """Bounded SMTP queue. Transient failures retry, never block a page save."""
    from app.routes.notifications_api_routes import _smtp_settings, _try_send_email
    stamp = (stamp or now()).astimezone(BEIJING).replace(tzinfo=None)
    db.session.execute(deliveries.update().where(deliveries.c.expires_at <= stamp,
        deliveries.c.email_status.in_(['pending', 'sending'])).values(email_status='expired'))
    db.session.commit()
    if not _smtp_settings(): return 0  # Missing configuration must not exhaust retries.
    ids = db.session.execute(select(deliveries.c.id).where(
        deliveries.c.email_status.in_(['pending', 'sending']), deliveries.c.next_attempt <= stamp,
        deliveries.c.expires_at > stamp).order_by(deliveries.c.id).limit(20)).scalars().all()
    db.session.commit()
    count = 0
    for delivery_id in ids:
        row = db.session.execute(select(deliveries).where(deliveries.c.id == delivery_id).with_for_update()).mappings().first()
        if row['email_status'] not in ('pending', 'sending') or row['next_attempt'] > stamp:
            db.session.rollback()
            continue
        if row['attempts'] >= 6:
            db.session.execute(deliveries.update().where(deliveries.c.id == delivery_id).values(email_status='failed'))
            db.session.commit()
            continue
        event = db.session.execute(select(anniversaries).where(anniversaries.c.id == row['event_id'])).mappings().first()
        member = db.session.execute(text("SELECT 1 FROM couple_members WHERE user_id=:uid AND couple_id=:cid AND role IN ('owner','member')"),
            {'uid': row['recipient_id'], 'cid': event['couple_id'] if event else -1}).first()
        pref = mail_preference(row['recipient_id'])
        if not event or event['deleted'] or not event['enabled'] or event['version'] != row['event_version'] or not member or not pref['email_enabled'] or not pref['email']:
            db.session.execute(deliveries.update().where(deliveries.c.id == delivery_id).values(email_status='cancelled'))
            db.session.commit()
            continue
        attempts = row['attempts']+1
        db.session.execute(deliveries.update().where(deliveries.c.id == delivery_id).values(
            email_status='sending', attempts=attempts, next_attempt=stamp+timedelta(minutes=15)))
        db.session.commit()
        success = _try_send_email(pref['email'], row['title'], row['content'])
        db.session.execute(deliveries.update().where(deliveries.c.id == delivery_id).values(
            email_status='sent' if success else 'failed' if attempts >= 6 else 'pending',
            next_attempt=stamp+timedelta(minutes=min(240, 15*2**min(attempts-1,4)))))
        db.session.commit()
        count += int(success)
    return count
