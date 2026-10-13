"""Container entry point. Use the application factory, never embed credentials."""
import sys
from app import create_app
from app.routes.anniversaries_api_routes import dispatch_due, seed_defaults, send_pending
from app.routes.notifications_api_routes import ensure_notification_tables
from app.extensions import db
from sqlalchemy import text
from app.routes import anniversary_wechat
from app.routes.anniversaries_api_routes import now

app = create_app()
with app.app_context():
    ensure_notification_tables()
    if len(sys.argv) == 3 and sys.argv[1] == '--seed':
        cid = int(sys.argv[2])
        if not db.session.execute(text('SELECT id FROM couple_spaces WHERE id=:cid'), {'cid': cid}).first():
            raise ValueError('Space not found')
        seed_defaults(cid)
        print('Anniversary defaults initialized for the selected space.')
    elif len(sys.argv) == 1:
        print('Anniversary in-app reminders generated:', dispatch_due())
        print('Anniversary emails sent:', send_pending())
        print('Anniversary WeChat messages sent:', anniversary_wechat.send_pending(now()))
    else:
        raise ValueError('Expected no arguments or --seed <couple_id>')
