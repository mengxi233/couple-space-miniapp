"""One-time WeChat subscriptions. Client receipts are hints, never proof of quota."""
import time
from datetime import datetime, timedelta
import requests
from sqlalchemy import MetaData, Table, Column, Integer, String, Boolean, DateTime, select, text
from app.extensions import db
from app.utils.runtime_config import runtime_value

def template_id():
    return runtime_value('WX_ANNIVERSARY_TEMPLATE_ID') or ''
metadata = MetaData()
subscriptions = Table('couple_anniversary_wx_subscriptions', metadata,
    Column('user_id', Integer, primary_key=True),
    Column('enabled', Boolean, nullable=False, default=False),
    Column('credits', Integer, nullable=False, default=0),
    Column('state', String(12), nullable=False, default='trial'))
receipts = Table('couple_anniversary_wx_receipts', metadata,
    Column('id', String(64), primary_key=True), Column('user_id', Integer, nullable=False),
    Column('created_at', DateTime, nullable=False))
jobs = Table('couple_anniversary_wx_jobs', metadata,
    Column('delivery_id', Integer, primary_key=True), Column('user_id', Integer, nullable=False),
    Column('status', String(24), nullable=False), Column('attempts', Integer, nullable=False, default=0),
    Column('reserved', Boolean, nullable=False, default=False),
    Column('scheduled_at', String(20), nullable=False), Column('event_at', String(20), nullable=False),
    Column('created_at', DateTime, nullable=False), Column('next_attempt', DateTime, nullable=False),
    Column('expires_at', DateTime, nullable=False), Column('error_code', String(24)))
_token = None
_token_until = 0

def configured():
    return bool(runtime_value('WX_APPID') and runtime_value('WX_APPSECRET') and template_id())

def status(uid):
    row = db.session.execute(select(subscriptions).where(subscriptions.c.user_id == uid)).mappings().first()
    recent = db.session.execute(select(jobs.c.status, jobs.c.created_at).where(jobs.c.user_id == uid)
        .order_by(jobs.c.created_at.desc(), jobs.c.delivery_id.desc()).limit(1)).mappings().first()
    return dict(templateId=template_id(), configured=configured(), enabled=bool(row and row['enabled']),
        canAttempt=bool(row and row['enabled'] and row['credits'] > 0),
        lastStatus=recent['status'] if recent else '', templateType='once')

def eligible(uid):
    row = db.session.execute(select(subscriptions).where(subscriptions.c.user_id == uid)).mappings().first()
    return bool(row and row['enabled'] and row['credits'] > 0)

def consent(uid, receipt_id, state, stamp):
    # Serialize with cron and other consent requests; no supplied recipient/openid is accepted.
    db.session.execute(text('SELECT user_id FROM couple_members WHERE user_id=:uid FOR UPDATE'), {'uid':uid}).first()
    if db.session.execute(select(receipts.c.id).where(receipts.c.id == receipt_id)).first():
        return
    row = db.session.execute(select(subscriptions).where(subscriptions.c.user_id == uid).with_for_update()).mappings().first()
    values = dict(enabled=True, credits=min(100, (row['credits'] if row else 0)+1), state=state)
    db.session.execute(subscriptions.update().where(subscriptions.c.user_id == uid).values(**values)
        if row else subscriptions.insert().values(user_id=uid, **values))
    db.session.execute(receipts.insert().values(id=receipt_id, user_id=uid, created_at=stamp))

def enqueue(delivery_id, uid, event, target, stamp):
    if not eligible(uid): return
    hour, minute = divmod(event['reminder_minutes'], 60)
    db.session.execute(jobs.insert().values(delivery_id=delivery_id, user_id=uid, status='pending',
        attempts=0, reserved=False, scheduled_at=f'{stamp:%Y-%m-%d} {hour:02}:{minute:02}',
        event_at=f'{target.isoformat()} 00:00', created_at=stamp, next_attempt=stamp,
        expires_at=datetime.combine(stamp.date()+timedelta(days=2), datetime.min.time())))

class ApiError(Exception):
    def __init__(self, code): self.code = str(code)

def access_token():
    global _token, _token_until
    if _token and time.monotonic() < _token_until: return _token
    result = requests.post('https://api.weixin.qq.com/cgi-bin/stable_token', json={
        'grant_type':'client_credential', 'appid':runtime_value('WX_APPID'),
        'secret':runtime_value('WX_APPSECRET'), 'force_refresh':False}, timeout=12).json()
    if not result.get('access_token'): raise ApiError(result.get('errcode','token_error'))
    _token = result['access_token']
    _token_until = time.monotonic()+max(0, int(result.get('expires_in',7200))-300)
    return _token

def payload(event, job, openid, state, offset):
    return dict(touser=openid, template_id=template_id(), page='pages/anniversaries/anniversaries',
        miniprogram_state=state, lang='zh_CN', data={
            'thing1':{'value':event['title'][:20]},
            'time2':{'value':job['scheduled_at']},
            'thing5':{'value':('今天就是这个特别的日子' if offset == 0 else f'还有{offset}天，记得留时间庆祝')[:20]},
            'time6':{'value':job['event_at']}})

def send_pending(stamp):
    """Caller holds the cron flock. Uncertain delivery is NOT retried (avoid duplicates)."""
    global _token_until
    from app.routes.anniversaries_api_routes import anniversaries, deliveries
    stamp = stamp.replace(tzinfo=None)
    db.session.execute(jobs.update().where(jobs.c.status=='sending', jobs.c.next_attempt<=stamp)
        .values(status='unknown'))
    db.session.execute(jobs.update().where(jobs.c.status=='pending', jobs.c.expires_at<=stamp)
        .values(status='expired'))
    db.session.execute(receipts.delete().where(receipts.c.created_at<stamp-timedelta(days=90)))
    db.session.execute(jobs.delete().where(jobs.c.created_at<stamp-timedelta(days=180),
        jobs.c.status.notin_(['pending','sending'])))
    db.session.commit()
    if not configured(): return 0
    ids = db.session.execute(select(jobs.c.delivery_id).where(jobs.c.status=='pending',
        jobs.c.next_attempt<=stamp, jobs.c.expires_at>stamp).order_by(jobs.c.delivery_id).limit(20)).scalars().all()
    db.session.commit()
    sent = 0
    for ident in ids:
        job = db.session.execute(select(jobs).where(jobs.c.delivery_id==ident).with_for_update()).mappings().first()
        if job['status']!='pending' or job['next_attempt']>stamp:
            db.session.rollback(); continue
        delivery = db.session.execute(select(deliveries).where(deliveries.c.id==ident)).mappings().first()
        event = db.session.execute(select(anniversaries).where(anniversaries.c.id==delivery['event_id'])).mappings().first() if delivery else None
        member = db.session.execute(text("SELECT u.openid FROM couple_members m JOIN couple_users u ON u.id=m.user_id "
            "WHERE m.user_id=:uid AND m.couple_id=:cid AND m.role IN ('owner','member')"),
            {'uid':job['user_id'], 'cid':event['couple_id'] if event else -1}).first()
        sub = db.session.execute(select(subscriptions).where(subscriptions.c.user_id==job['user_id']).with_for_update()).mappings().first()
        invalid = (not event or event['deleted'] or not event['enabled'] or
            event['version']!=delivery['event_version'] or not member or not sub or not sub['enabled'])
        if invalid or not member[0] or member[0].startswith('dev:'):
            db.session.execute(jobs.update().where(jobs.c.delivery_id==ident).values(status='cancelled'))
            db.session.commit(); continue
        if not job['reserved'] and sub['credits']<=0:
            db.session.execute(jobs.update().where(jobs.c.delivery_id==ident).values(status='no_subscription'))
            db.session.commit(); continue
        # Token request cannot consume a subscription; it is safe to retry separately.
        try: token = access_token()
        except Exception as error:
            attempts = job['attempts']+1
            db.session.execute(jobs.update().where(jobs.c.delivery_id==ident).values(
                status='failed' if attempts>=4 else 'pending', attempts=attempts,
                next_attempt=stamp+timedelta(minutes=15), error_code=error.code if isinstance(error,ApiError) else 'token_network'))
            db.session.commit(); continue
        if not job['reserved']:
            db.session.execute(subscriptions.update().where(subscriptions.c.user_id==job['user_id']).values(credits=sub['credits']-1))
        attempts = job['attempts']+1
        body = payload(event, job, member[0], sub['state'], delivery['advance_days'])
        db.session.execute(jobs.update().where(jobs.c.delivery_id==ident).values(status='sending', reserved=True,
            attempts=attempts, next_attempt=stamp+timedelta(minutes=15)))
        db.session.commit()
        try:
            result = requests.post('https://api.weixin.qq.com/cgi-bin/message/subscribe/send',
                params={'access_token':token}, json=body, timeout=12).json()
            code = result.get('errcode')
            if code == 0: outcome='sent'; sent+=1
            elif code == 43101: outcome='no_subscription'
            elif code in (40001,40014,42001,-1,45009) and attempts<4:
                outcome='pending'
                if code in (40001,40014,42001): _token_until=0
            else: outcome='failed' if code is not None else 'unknown'
        except Exception:
            code='network_unknown'; outcome='unknown'
        # Never log response bodies, tokens or recipients.
        db.session.execute(jobs.update().where(jobs.c.delivery_id==ident).values(
            status=outcome, error_code=str(code)[:24], next_attempt=stamp+timedelta(minutes=15)))
        if outcome=='no_subscription':
            db.session.execute(subscriptions.update().where(subscriptions.c.user_id==job['user_id']).values(credits=0))
        db.session.commit()
    return sent
