"""No production data or real email: SQLite and a mocked SMTP adapter."""
import importlib.util
from pathlib import Path
ROUTES = Path(__file__).resolve().parents[1] / 'app' / 'routes'
import sys
import types
import unittest
from datetime import date, datetime, timedelta
from unittest.mock import patch
from flask import Flask, request
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text, event, select

app=Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI']='sqlite://'
db=SQLAlchemy(app)
extension=types.ModuleType('app.extensions'); extension.db=db
sys.modules['app.extensions']=extension
auth=types.ModuleType('app.routes.couple_api_routes')
auth._current_user=lambda: {'user_id':int(request.headers['User'])} if request.headers.get('User') else None
sys.modules[auth.__name__]=auth
notifications=types.ModuleType('app.routes.notifications_api_routes')
notifications._smtp_settings=lambda: {'configured':True}
notifications._try_send_email=lambda *args: True
notifications._normalise_email=lambda value: value.strip() if isinstance(value,str) and '@' in value and '\n' not in value else ''
sys.modules[notifications.__name__]=notifications
routes=types.ModuleType('app.routes'); sys.modules['app.routes']=routes
runtime=types.ModuleType('app.utils.runtime_config');runtime.runtime_value=lambda name:'test-only'
sys.modules[runtime.__name__]=runtime
wx_spec=importlib.util.spec_from_file_location('app.routes.anniversary_wechat',str(ROUTES / 'anniversary_wechat.py'))
wx_module=importlib.util.module_from_spec(wx_spec);wx_spec.loader.exec_module(wx_module)
sys.modules[wx_spec.name]=wx_module;routes.anniversary_wechat=wx_module
spec=importlib.util.spec_from_file_location('anniversaries',str(ROUTES / 'anniversaries_api_routes.py'))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sys.modules['app.routes.anniversaries_api_routes']=module
app.register_blueprint(module.anniversaries_bp)
with app.app_context():
    @event.listens_for(db.engine,'before_cursor_execute',retval=True)
    def locks(conn,cursor,sql,parameters,context,executemany):
        return sql.replace(' FOR UPDATE',''),parameters

class AnniversaryTests(unittest.TestCase):
    def setUp(self):
        self.context=app.app_context();self.context.push()
        module.metadata.create_all(db.engine)
        wx_module.metadata.create_all(db.engine)
        for sql in [
            'CREATE TABLE couple_users(id INTEGER PRIMARY KEY,openid TEXT)',
            "INSERT INTO couple_users VALUES(1,'openid-one'),(2,'openid-two'),(3,'openid-three')",
            'CREATE TABLE couple_spaces(id INTEGER PRIMARY KEY)',
            'INSERT INTO couple_spaces VALUES(1),(2)',
            'CREATE TABLE couple_members(user_id INTEGER,couple_id INTEGER,role TEXT)',
            "INSERT INTO couple_members VALUES(1,1,'owner'),(2,1,'member'),(3,2,'owner')",
            'CREATE TABLE couple_notification_settings(user_id INTEGER,in_app_enabled INTEGER,email_enabled INTEGER,email TEXT)',
            "INSERT INTO couple_notification_settings VALUES(1,1,1,'one@example.com'),(2,1,1,'two@example.com')",
            'CREATE TABLE couple_notifications(id INTEGER PRIMARY KEY,couple_id INTEGER,recipient_id INTEGER,type TEXT,title TEXT,content TEXT,payload_json TEXT,channel TEXT)'
        ]: db.session.execute(text(sql))
        db.session.commit(); self.client=app.test_client()
        self.fixed=datetime(2026,7,11,10,0,tzinfo=module.BEIJING)
        self.clock=patch.object(module,'now',return_value=self.fixed);self.clock.start()
    def tearDown(self):
        self.clock.stop();db.session.rollback();module.metadata.drop_all(db.engine);wx_module.metadata.drop_all(db.engine)
        for table in ['couple_spaces','couple_members','couple_notification_settings','couple_notifications','couple_users']:
            db.session.execute(text('DROP TABLE '+table))
        db.session.commit();self.context.pop()
    def body(self,**changes):
        return dict(title='纪念日',calendarType='solar',startYear=2025,month=7,day=18,
                    enabled=True,reminderTime='10:00',reminderDays=[7,3,1,0],**changes)
    def create(self):
        r=self.client.post('/api/couple/anniversaries',headers={'User':'1'},json=self.body())
        self.assertEqual(r.status_code,201);return r.json['id']
    def test_seed_permissions_and_edit(self):
        module.seed_defaults(1);module.seed_defaults(1)
        items=self.client.get('/api/couple/anniversaries',headers={'User':'1'}).json['items']
        self.assertEqual(len(items),5)
        self.assertTrue(all(x['reminderTime']=='10:00' and x['reminderDays']==[7,3,1,0] for x in items))
        birthdays=[x for x in items if x['eventKind']=='birthday']
        self.assertEqual(len(birthdays),2)
        self.assertTrue(all(x['elapsedFrom']=='' and x['years'] is None for x in birthdays))
        self.assertEqual(self.client.get('/api/couple/anniversaries').status_code,401)
        self.assertEqual(self.client.get('/api/couple/anniversaries',headers={'User':'4'}).status_code,403)
        path='/api/couple/anniversaries/'+str(items[0]['id'])
        body={**self.body(),'version':1}
        self.assertEqual(self.client.put(path,headers={'User':'3'},json=body).status_code,404)
        self.assertEqual(self.client.put(path,headers={'User':'2'},json=body).status_code,200)
        self.assertEqual(self.client.put(path,headers={'User':'1'},json=body).status_code,409)
        self.assertEqual(self.client.delete(path,headers={'User':'2'},json={'version':2}).status_code,200)
        module.seed_defaults(1)
        self.assertEqual(len(self.client.get('/api/couple/anniversaries',headers={'User':'1'}).json['items']),4)
    def test_four_offsets_time_and_dedupe(self):
        self.create()
        for days in [7,3,1,0]:
            stamp=datetime(2026,7,18,10,0,tzinfo=module.BEIJING)-timedelta(days=days)
            self.assertEqual(module.dispatch_due(stamp-timedelta(minutes=1)),0)
            self.assertEqual(module.dispatch_due(stamp),2)
            self.assertEqual(module.dispatch_due(stamp),0)
            with patch.object(notifications,'_try_send_email',return_value=True) as send:
                self.assertEqual(module.send_pending(stamp),2)
                self.assertEqual(module.send_pending(stamp),0)
                self.assertEqual(send.call_count,2)
        self.assertEqual(db.session.execute(text('SELECT COUNT(*) FROM couple_notifications')).scalar(),8)
        self.assertEqual(module.dispatch_due(datetime(2027,7,11,10,tzinfo=module.BEIJING)),2)
    def test_lunar_and_missing_dates(self):
        birthday=dict(calendar_type='lunar',month=11,day=2,leap_month=False,start_year=None)
        self.assertEqual(module.occurrence(birthday,2026),date(2026,12,10))
        birthday.update(month=10,day=29)
        self.assertEqual(module.occurrence(birthday,2026),date(2026,12,7))
        birthday.update(month=12,day=29)
        self.assertEqual(module.next_occurrence(birthday,date(2026,1,1))[1],2025)
        leap=dict(calendar_type='solar',month=2,day=29,leap_month=False,start_year=2024)
        self.assertEqual(module.occurrence(leap,2025),date(2025,2,28))
        lunar=dict(calendar_type='lunar',month=2,day=1,leap_month=True,start_year=None)
        self.assertEqual(module.occurrence(lunar,2024),module.occurrence({**lunar,'leap_month':False},2024))
    def test_queue_failure_missing_smtp_and_cancellation(self):
        event_id=self.create();module.dispatch_due(self.fixed)
        with patch.object(notifications,'_smtp_settings',return_value=None):
            self.assertEqual(module.send_pending(self.fixed),0)
        with patch.object(notifications,'_try_send_email',return_value=False):
            self.assertEqual(module.send_pending(self.fixed),0)
        self.assertEqual(module.send_pending(self.fixed+timedelta(minutes=5)),0)
        self.assertEqual(module.send_pending(self.fixed+timedelta(minutes=15)),2)
        later=datetime(2026,7,15,10,tzinfo=module.BEIJING);module.dispatch_due(later)
        self.client.delete('/api/couple/anniversaries/'+str(event_id),headers={'User':'1'},json={'version':1})
        with patch.object(notifications,'_try_send_email') as send:
            self.assertEqual(module.send_pending(later),0);send.assert_not_called()
    def test_email_independent_and_private_settings(self):
        self.create()
        db.session.execute(text('UPDATE couple_notification_settings SET in_app_enabled=0 WHERE user_id=1'))
        db.session.commit()
        self.assertEqual(module.dispatch_due(self.fixed),2)
        self.assertEqual(db.session.execute(text('SELECT COUNT(*) FROM couple_notifications')).scalar(),1)
        self.assertEqual(module.send_pending(self.fixed),2)
        self.client.put('/api/couple/anniversaries/settings',headers={'User':'1'},
                        json={'email':'new@example.com','emailEnabled':True})
        self.assertEqual(self.client.get('/api/couple/anniversaries/settings',headers={'User':'2'}).json['email'],'two@example.com')
    def test_invalid_date_and_parameters(self):
        for changes in [{'month':2,'day':31},{'reminderTime':'24:00'},{'reminderDays':[]},
                        {'reminderDays':[True]},{'calendarType':'bad'},{'leapMonth':True}]:
            r=self.client.post('/api/couple/anniversaries',headers={'User':'1'},json={**self.body(),**changes})
            self.assertEqual(r.status_code,400,changes)

    def subscribe(self, uid='1'):
        return self.client.post('/api/couple/anniversaries/wechat-subscription',headers={'User':uid},json={
            'enabled':True,'templateId':wx_module.template_id(),'result':'accept',
            'receiptId':'test-receipt-unique-'+uid,'state':'trial'})

    def test_wechat_consent_permissions_dedupe_and_delivery(self):
        path='/api/couple/anniversaries/wechat-subscription'
        self.assertEqual(self.client.post(path,json={'enabled':True}).status_code,401)
        self.assertEqual(self.client.post(path,headers={'User':'4'},json={'enabled':True}).status_code,403)
        self.assertEqual(self.client.post(path,headers={'User':'1'},json={'enabled':True}).status_code,400)
        self.assertEqual(self.subscribe().status_code,200);self.subscribe()
        sub=db.session.execute(select(wx_module.subscriptions)).mappings().one()
        self.assertEqual(sub['credits'],1)
        self.assertFalse(self.client.get('/api/couple/anniversaries/settings',headers={'User':'2'}).json['wechat']['enabled'])
        self.create();module.dispatch_due(self.fixed);module.dispatch_due(self.fixed)
        self.assertEqual(len(db.session.execute(select(wx_module.jobs)).all()),1)
        with patch.object(wx_module,'access_token',return_value='fake'),patch.object(wx_module.requests,'post') as send:
            send.return_value.json.return_value={'errcode':0}
            self.assertEqual(wx_module.send_pending(self.fixed),1)
            self.assertEqual(wx_module.send_pending(self.fixed),0)
            body=send.call_args.kwargs['json']
            self.assertEqual(body['template_id'],wx_module.template_id())
            self.assertEqual(body['miniprogram_state'],'trial')
            self.assertEqual(body['data']['thing1']['value'],'纪念日')
            self.assertEqual(body['data']['time6']['value'],'2026-07-18 00:00')
            self.assertEqual(set(body['data']),{'thing1','thing5','time2','time6'})
        self.assertEqual(db.session.execute(select(wx_module.subscriptions.c.credits)).scalar(),0)

    def test_wechat_denial_timeout_cancel_and_independence(self):
        self.subscribe();self.create()
        db.session.execute(text('UPDATE couple_notification_settings SET in_app_enabled=0,email_enabled=0 WHERE user_id=1'))
        db.session.commit();module.dispatch_due(self.fixed)
        with patch.object(wx_module,'access_token',return_value='fake'),patch.object(wx_module.requests,'post') as send:
            send.return_value.json.return_value={'errcode':43101}
            self.assertEqual(wx_module.send_pending(self.fixed),0)
        self.assertEqual(db.session.execute(select(wx_module.jobs.c.status)).scalar(),'no_subscription')
        self.assertEqual(db.session.execute(select(wx_module.subscriptions.c.credits)).scalar(),0)
        db.session.execute(wx_module.subscriptions.update().values(credits=1))
        db.session.execute(wx_module.jobs.update().values(status='pending',reserved=False,next_attempt=self.fixed.replace(tzinfo=None)))
        db.session.commit()
        with patch.object(wx_module,'access_token',return_value='fake'),patch.object(wx_module.requests,'post',side_effect=TimeoutError):
            self.assertEqual(wx_module.send_pending(self.fixed),0)
        self.assertEqual(db.session.execute(select(wx_module.jobs.c.status)).scalar(),'unknown')
        with patch.object(wx_module.requests,'post') as send:
            self.assertEqual(wx_module.send_pending(self.fixed+timedelta(minutes=30)),0);send.assert_not_called()
        db.session.execute(wx_module.jobs.update().values(status='pending'));db.session.commit()
        self.client.post('/api/couple/anniversaries/wechat-subscription',headers={'User':'1'},json={'enabled':False})
        with patch.object(wx_module.requests,'post') as send:
            self.assertEqual(wx_module.send_pending(self.fixed+timedelta(minutes=30)),0);send.assert_not_called()
        self.assertEqual(db.session.execute(select(wx_module.jobs.c.status)).scalar(),'cancelled')

if __name__=='__main__': unittest.main()
