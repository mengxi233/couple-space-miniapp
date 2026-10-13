import os

from flask import Flask, jsonify
from flask_cors import CORS

from app.extensions import db


def create_app(config_name=None):
    profile = (config_name or os.getenv("APP_ENV") or os.getenv("FLASK_ENV") or "production").lower()
    if profile not in {"development", "production", "default"}:
        profile = "production"

    app = Flask(__name__)
    from app.config import config
    app.config.from_object(config[profile])
    db.init_app(app)

    # WeChat Mini Program requests do not need browser CORS. Enable it only
    # for explicitly listed web origins, never with a wildcard in production.
    origins = [item.strip() for item in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",") if item.strip()]
    if origins:
        CORS(app, resources={r"/api/*": {"origins": origins}})

    from app.routes.couple_api_routes import couple_bp
    from app.routes.menu_api_routes import menu_bp
    from app.routes.todos_api_routes import todo_bp
    from app.routes.notifications_api_routes import notifications_bp
    from app.routes.uploads_api_routes import uploads_bp
    from app.routes.banners_api_routes import banners_bp
    from app.routes.question_board_api_routes import question_board_bp
    from app.routes.timeline_api_routes import timeline_bp, init_timeline
    from app.routes.media_api_routes import media_bp
    from app.routes.lightboard_api_routes import lightboard_bp
    from app.routes.couple_wheel_api_routes import wheel_bp
    from app.routes.anniversaries_api_routes import anniversaries_bp, init_anniversaries
    from app.routes.calendar_wechat import init_calendar_wechat

    for blueprint in (
        couple_bp, menu_bp, todo_bp, notifications_bp, uploads_bp, banners_bp,
        question_board_bp, timeline_bp, media_bp, lightboard_bp, wheel_bp,
        anniversaries_bp,
    ):
        app.register_blueprint(blueprint)

    init_timeline(app)
    init_anniversaries(app)
    init_calendar_wechat(app)

    @app.get("/healthz")
    def healthz():
        return jsonify(status="ok")

    return app
