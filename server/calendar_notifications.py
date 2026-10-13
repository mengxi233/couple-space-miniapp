"""One-minute worker; logs counts only, never message bodies or credentials."""
import contextlib
import io
from app import create_app
with contextlib.redirect_stdout(io.StringIO()):
    app = create_app()
with app.app_context():
    from app.routes.calendar_wechat import send_pending
    print('calendar_wechat_sent', send_pending())
