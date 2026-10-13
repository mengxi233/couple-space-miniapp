"""Isolated SQLite tests; never call real WeChat or email endpoints."""
import importlib.util
import unittest
from datetime import timedelta
from unittest.mock import patch
from sqlalchemy import text, select
import test_anniversaries as fixture
from pathlib import Path

spec=importlib.util.spec_from_file_location('calendar_wechat',str(Path(__file__).resolve().parents[1] / 'app/routes/calendar_wechat.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
fixture.app.register_blueprint(module.bp)
db=fixture.db

class CalendarWechatTests(unittest.TestCase):
    def setUp(self):
        fixture.AnniversaryTests.setUp(self)
        module.metadata.create_all(db.engine)
        db.session.execute(text('CREATE TABLE couple_calendar_events(id INTEGER PRIMARY KEY,couple_id INTEGER,user_id INTEGER,title TEXT,content TEXT,event_date TEXT)'))
        db.session.execute(text("INSERT INTO couple_calendar_events VALUES(10,1,1,'新记录','内容','2026-09-10'),(11,1,1,'另一条','内容','2026-09-10')"))
        db.session.execute(text('ALTER TABLE couple_notifications ADD COLUMN is_read INTEGER DEFAULT 0'))
        db.session.execute(text("INSERT INTO couple_notifications(id,couple_id,recipient_id,type) VALUES(20,1,2,'calendar_created')"))
        db.session.commit()
        self.stamp=module.now()
    def tearDown(self):
        db.session.rollback();module.metadata.drop_all(db.engine)
        db.session.execute(text('DROP TABLE couple_calendar_events'));db.session.commit()
        fixture.AnniversaryTests.tearDown(self)
    def consent(self, uid=2, receipt='unique-receipt-00000001'):
        return self.client.post('/api/couple/calendar/wechat/subscription', headers={'User':str(uid)},json={
            'result':'accept','templateId':module.template_id(),'receiptId':receipt,'state':'trial'})
    def enqueue(self):
        module.enqueue(10,2,1,20);db.session.commit()
    def send(self, code=0):
        with patch.object(module.transport,'access_token',return_value='mock-token'), patch.object(module.requests,'post') as send:
            send.return_value.json.return_value={'errcode':code}
            result=module.send_pending(self.stamp+timedelta(seconds=1))
            return result,send
    def test_permissions_receipt_deduplication_and_separation(self):
        path='/api/couple/calendar/wechat/subscription'
        self.assertEqual(self.client.get(path).status_code,401)
        self.assertEqual(self.client.get(path,headers={'User':'4'}).status_code,403)
        self.assertEqual(self.consent().status_code,200)
        self.assertEqual(self.consent().status_code,200)
        self.assertEqual(self.consent(3).status_code,409)
        self.assertEqual(db.session.execute(select(module.subscriptions.c.credits)).scalar(),1)
        self.assertFalse(fixture.wx_module.eligible(2))
        self.assertEqual(self.client.post(path,headers={'User':'2'},json=[]).status_code,400)
    def test_reservation_and_rollback(self):
        self.consent();module.enqueue(10,2,1,20);db.session.rollback()
        self.assertEqual(db.session.execute(select(module.subscriptions.c.credits)).scalar(),1)
        self.assertIsNone(db.session.execute(select(module.jobs)).first())
        self.enqueue();module.enqueue(10,2,1,20);module.enqueue(11,2,1,20);db.session.commit()
        self.assertEqual(len(db.session.execute(select(module.jobs)).all()),1)
        self.assertEqual(db.session.execute(select(module.subscriptions.c.credits)).scalar(),0)
    def test_payload_and_no_repeat(self):
        self.consent();self.enqueue()
        sent,send=self.send();self.assertEqual(sent,1)
        body=send.call_args.kwargs['json']
        self.assertEqual(body['touser'],'openid-two')
        self.assertEqual(body['data']['thing19']['value'],'新记录')
        self.assertEqual(body['page'],'pages/index/index?recordDate=2026-09-10')
        self.assertEqual(body['template_id'],module.template_id())
        self.assertEqual(body['miniprogram_state'],'trial')
        sent,send=self.send();send.assert_not_called()
    def test_read_cancelled(self):
        self.consent();self.enqueue()
        db.session.execute(text('UPDATE couple_notifications SET is_read=1'));db.session.commit()
        sent,send=self.send();send.assert_not_called()
        self.assertEqual(db.session.execute(select(module.jobs.c.status)).scalar(),'cancelled')
    def test_deleted_and_wrong_couple(self):
        self.consent();self.enqueue()
        db.session.execute(text('UPDATE couple_calendar_events SET couple_id=2'));db.session.commit()
        sent,send=self.send();send.assert_not_called()
    def test_disabled(self):
        self.consent();self.enqueue()
        self.client.post('/api/couple/calendar/wechat/subscription',headers={'User':'2'},json={'enabled':False})
        sent,send=self.send();send.assert_not_called()
    def test_wechat_exhausted_cancels_remaining(self):
        self.consent();self.consent(receipt='unique-receipt-00000002');self.enqueue()
        module.enqueue(11,2,1,20);db.session.commit()
        sent,send=self.send(43101)
        self.assertEqual(send.call_count,1)
        self.assertEqual(db.session.execute(select(module.subscriptions.c.credits)).scalar(),0)
        self.assertTrue(all(x=='no_subscription' for x in db.session.execute(select(module.jobs.c.status)).scalars()))
    def test_unknown_send_not_retried_and_retention(self):
        self.consent();self.enqueue()
        with patch.object(module.transport,'access_token',return_value='mock-token'), patch.object(module.requests,'post',side_effect=TimeoutError) as send:
            module.send_pending(self.stamp+timedelta(seconds=1));module.send_pending(self.stamp+timedelta(minutes=10))
            self.assertEqual(send.call_count,1)
        self.assertEqual(db.session.execute(select(module.jobs.c.status)).scalar(),'unknown')
        module.send_pending(self.stamp+timedelta(days=91))
        self.assertIsNone(db.session.execute(select(module.jobs)).first())
        self.assertIsNone(db.session.execute(select(module.receipts)).first())

if __name__=='__main__': unittest.main()
