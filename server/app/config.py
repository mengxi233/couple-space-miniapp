import os

from dotenv import load_dotenv

from app.utils.runtime_config import runtime_bool, runtime_value


load_dotenv()


class Config:
    SECRET_KEY = runtime_value("SECRET_KEY")
    SQLALCHEMY_DATABASE_URI = runtime_value(
        "DATABASE_URI",
        "mysql+pymysql://couple:couple@mysql:3306/couple_space",
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SESSION_COOKIE_SECURE = runtime_bool("SESSION_COOKIE_SECURE", True)
    MAX_CONTENT_LENGTH = 12 * 1024 * 1024
    JSON_AS_ASCII = False


class DevelopmentConfig(Config):
    DEBUG = True
    SESSION_COOKIE_SECURE = False


class ProductionConfig(Config):
    DEBUG = False


config = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "default": ProductionConfig,
}
