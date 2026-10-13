"""Partner calendar one-time subscriptions and a bounded, durable outbox.

Client consent receipts are only quota hints. WeChat is the authority. The
calendar transaction reserves a hint and inserts its job atomically; workers
never retry a send whose outcome is uncertain.
"""
import re
from datetime import datetime, timedelta, timezone
import requests
from flask import Blueprint, jsonify, request
from sqlalchemy import MetaData, Table, Column, Integer, String, Boolean, DateTime, select, text, func
from app.extensions import db
from app.routes import anniversary_wechat as transport
from app.utils.runtime_config import runtime_value

def template_id():
    return runtime_value('WX_CALENDAR_TEMPLATE_ID') or ''
bp = Blueprint('calendar_wechat', __name__, url_prefix='/api/couple/calendar/wechat')
metadata = MetaData()
subscriptions = Table('couple_calendar_wx_subscriptions', metadata,
    Column('user_id', Integer, primary_key=True), Column('enabled', Boolean, nullable=False),
    Column('credits', Integer, nullable=False), Column('state', String(12), nullable=False))
receipts = Table('couple_calendar_wx_receipts', metadata,
    Column('id', String(64), primary_key=True), Column('user_id', Integer, nullable=False, index=True),
    Column('created_at', DateTime, nullable=False))
jobs = Table('couple_calendar_wx_jobs', metadata,
    Column('event_id', Integer, primary_key=True), Column('user_id', Integer, primary_key=True),
    Column('couple_id', Integer, nullable=False), Column('notification_id', Integer),
    Column('state', String(12), nullable=False), Column('status', String(24), nullable=False, index=True),
    Column('created_at', DateTime, nullable=False), Column('next_attempt', DateTime, nullable=False),
    Column('expires_at', DateTime, nullable=False), Column('attempts', Integer, nullable=False, default=0),
    Column('error_code', String(24)))

def now():
    return datetime.now(timezone(timedelta(hours=8))).replace(tzinfo=None)

def init_calendar_wechat(app):
    with app.app_context(), db.engine.connect() as connection:
        mysql = connection.dialect.name in ('mysql', 'mariadb')
        if mysql and connection.execute(text("SELECT GET_LOCK('couple_space_calendar_wx_schema',30)")).scalar()!=1:
            raise RuntimeError('Calendar notification schema lock unavailable')
        try:
            metadata.create_all(connection)
            connection.commit()
        finally:
            if mysql: connection.execute(text("SELECT RELEASE_LOCK('couple_space_calendar_wx_schema')"))
    app.register_blueprint(bp)

def status(uid):
    row = db.session.execute(select(subscriptions).where(subscriptions.c.user_id==uid)).mappings().first()
    recent = db.session.execute(select(jobs.c.status).where(jobs.c.user_id==uid)
        .order_by(jobs.c.created_at.desc(), jobs.c.event_id.desc()).limit(1)).scalar()
    return dict(templateId=template_id(), configured=bool(transport.configured() and template_id()),
        enabled=bool(row and row['enabled']), canAttempt=bool(row and row['enabled'] and row['credits']>0),
        lastStatus=recent or '')

@bp.route('/subscription', methods=['GET', 'POST'])
def subscription():
    from app.routes.couple_api_routes import _current_user
    actor = _current_user()
    if not actor: return jsonify(message='请先登录'), 401
    uid = actor['user_id']
    member = db.session.execute(text("SELECT user_id FROM couple_members WHERE user_id=:uid "
        "AND role IN ('owner','member') FOR UPDATE"), {'uid':uid}).first()
    if not member: return jsonify(message='激活情侣身份后才能订阅'), 403
    if request.method=='GET':
        result=status(uid); db.session.commit(); return jsonify(result)
    body = request.get_json(silent=True)
    if not isinstance(body, dict): return jsonify(message='参数格式错误'), 400
    if body.get('enabled') is False:
        db.session.execute(subscriptions.update().where(subscriptions.c.user_id==uid).values(enabled=False, credits=0))
        db.session.commit(); return jsonify(status(uid))
    receipt, state = body.get('receiptId'), body.get('state')
    if (body.get('result')!='accept' or body.get('templateId')!=template_id() or
        not isinstance(receipt,str) or not re.fullmatch(r'[A-Za-z0-9-]{16,64}', receipt) or
        state not in ('developer','trial','formal')):
        return jsonify(message='请先在微信弹窗中同意订阅'), 400
    if not transport.configured(): return jsonify(message='微信通知服务尚未配置'), 503
    existing = db.session.execute(select(receipts.c.user_id).where(receipts.c.id==receipt)).scalar()
    if existing is not None:
        if existing!=uid: return jsonify(message='订阅凭据无效'), 409
        db.session.commit(); return jsonify(status(uid))
    stamp=now()
    count=db.session.execute(select(func.count()).select_from(receipts).where(
        receipts.c.user_id==uid, receipts.c.created_at>=stamp-timedelta(days=1))).scalar()
    if count>=100: return jsonify(message='今天订阅次数较多，请明天再试'), 429
    row=db.session.execute(select(subscriptions).where(subscriptions.c.user_id==uid).with_for_update()).mappings().first()
    values=dict(enabled=True, credits=min(100,(row['credits'] if row else 0)+1), state=state)
    db.session.execute(subscriptions.update().where(subscriptions.c.user_id==uid).values(**values)
        if row else subscriptions.insert().values(user_id=uid, **values))
    db.session.execute(receipts.insert().values(id=receipt,user_id=uid,created_at=stamp))
    db.session.commit(); return jsonify(status(uid))

def enqueue(event_id, uid, couple_id, notification_id):
    """Called inside the new calendar record transaction, never from edits."""
    if db.session.execute(select(jobs.c.event_id).where(jobs.c.event_id==event_id,jobs.c.user_id==uid)).first(): return
    row=db.session.execute(select(subscriptions).where(subscriptions.c.user_id==uid).with_for_update()).mappings().first()
    if not row or not row['enabled'] or row['credits']<=0: return
    stamp=now()
    db.session.execute(subscriptions.update().where(subscriptions.c.user_id==uid).values(credits=row['credits']-1))
    db.session.execute(jobs.insert().values(event_id=event_id,user_id=uid,couple_id=couple_id,
        notification_id=notification_id,state=row['state'],status='pending',created_at=stamp,
        next_attempt=stamp,expires_at=stamp+timedelta(days=1),attempts=0))

def short(value, fallback):
    return re.sub(r'\s+', ' ', str(value or '')).strip()[:20] or fallback

def send_pending(stamp=None):
    """Run under a single worker flock; cap each run and clean up old resources."""
    stamp=stamp or now()
    db.session.execute(jobs.update().where(jobs.c.status=='sending',jobs.c.next_attempt<=stamp).values(status='unknown'))
    db.session.execute(jobs.update().where(jobs.c.status=='pending',jobs.c.expires_at<=stamp).values(status='expired'))
    db.session.execute(receipts.delete().where(receipts.c.created_at<stamp-timedelta(days=90)))
    db.session.execute(jobs.delete().where(jobs.c.created_at<stamp-timedelta(days=90),jobs.c.status.notin_(['pending','sending'])))
    db.session.commit()
    if not transport.configured(): return 0
    pending=db.session.execute(select(jobs).where(jobs.c.status=='pending',jobs.c.next_attempt<=stamp)
        .order_by(jobs.c.created_at).limit(20)).mappings().all()
    db.session.commit(); sent=0
    for item in pending:
        key=(jobs.c.event_id==item['event_id'],jobs.c.user_id==item['user_id'])
        job=db.session.execute(select(jobs).where(*key).with_for_update()).mappings().first()
        if job['status']!='pending': db.session.rollback(); continue
        event=db.session.execute(text('SELECT e.title,e.content,e.event_date,e.user_id FROM couple_calendar_events e '
            'WHERE e.id=:eid AND e.couple_id=:cid'),{'eid':job['event_id'],'cid':job['couple_id']}).mappings().first()
        member=db.session.execute(text("SELECT u.openid FROM couple_members m JOIN couple_users u ON u.id=m.user_id "
            "WHERE m.user_id=:uid AND m.couple_id=:cid AND m.role IN ('owner','member')"),
            {'uid':job['user_id'],'cid':job['couple_id']}).scalar()
        enabled=db.session.execute(select(subscriptions.c.enabled).where(subscriptions.c.user_id==job['user_id'])).scalar()
        read=db.session.execute(text('SELECT is_read FROM couple_notifications WHERE id=:id'),{'id':job['notification_id']}).scalar()
        if not event or event['user_id']==job['user_id'] or not member or member.startswith('dev:') or not enabled or read:
            db.session.execute(jobs.update().where(*key).values(status='cancelled')); db.session.commit(); continue
        try: token=transport.access_token()
        except Exception:
            attempts=job['attempts']+1
            db.session.execute(jobs.update().where(*key).values(status='failed' if attempts>=4 else 'pending',
                attempts=attempts,next_attempt=stamp+timedelta(minutes=5),error_code='token_error'))
            db.session.commit(); continue
        event_date=str(event['event_date'])[:10]
        payload=dict(touser=member,template_id=template_id(),miniprogram_state=job['state'],lang='zh_CN',
            page='pages/index/index?recordDate='+event_date,data={
                'thing7':{'value':'对方新增了一条日历记录'},
                'thing19':{'value':short(event['title'] or event['content'],'对方分享了图片或链接')},
                'time37':{'value':job['created_at'].strftime('%Y-%m-%d %H:%M')}})
        db.session.execute(jobs.update().where(*key).values(status='sending',next_attempt=stamp+timedelta(minutes=5)))
        db.session.commit()
        try:
            result=requests.post('https://api.weixin.qq.com/cgi-bin/message/subscribe/send',
                params={'access_token':token},json=payload,timeout=12).json()
            code=result.get('errcode')
            outcome='sent' if code==0 else 'no_subscription' if code==43101 else 'unknown' if code is None else 'failed'
        except Exception:
            code='network_unknown';outcome='unknown'
        # No retry after a send: a timeout may still have consumed the subscription.
        db.session.execute(jobs.update().where(*key).values(status=outcome,error_code=str(code)[:24]))
        if outcome=='no_subscription':
            db.session.execute(subscriptions.update().where(subscriptions.c.user_id==job['user_id']).values(credits=0))
            db.session.execute(jobs.update().where(jobs.c.user_id==job['user_id'],jobs.c.status=='pending').values(status='no_subscription'))
        db.session.commit()
        sent+=int(outcome=='sent')
    return sent
