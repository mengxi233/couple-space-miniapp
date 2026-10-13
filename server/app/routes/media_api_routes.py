"""Bounded video/avatar uploads and a fixed-host QQ avatar importer."""
import os
import re
import uuid
import requests
from flask import Blueprint, jsonify, request, send_from_directory
from sqlalchemy import text
from app.extensions import db
from app.routes.couple_api_routes import _current_user

media_bp = Blueprint('couple_media', __name__, url_prefix='/api/couple')
ROOT = os.getenv('COUPLE_MEDIA_DIR', '/app/data/media')
MAX_BYTES = 10 * 1024 * 1024


def authenticated(member=False):
    actor = _current_user()
    if not actor:
        return None, (jsonify(message='请先登录'), 401)
    if member:
        row = db.session.execute(text('SELECT role FROM couple_members WHERE user_id=:uid'), {'uid': actor['user_id']}).first()
        if not row or row[0] not in ('owner', 'member'):
            return None, (jsonify(message='绑定情侣空间后才能上传视频'), 403)
    return actor, None


def image_extension(data):
    if data.startswith(b'\xff\xd8\xff'): return 'jpg'
    if data.startswith(b'\x89PNG\r\n\x1a\n'): return 'png'
    if data.startswith((b'GIF87a', b'GIF89a')): return 'gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP': return 'webp'
    return None


def store_file(data, extension, actor):
    os.makedirs(ROOT, exist_ok=True)
    name = f"{actor['user_id']}_{uuid.uuid4().hex}.{extension}"
    with open(os.path.join(ROOT, name), 'xb') as destination:
        destination.write(data)
    public_base = os.getenv('PUBLIC_BASE_URL', '').rstrip('/')
    url = f"{public_base}/api/couple/media/{name}" if public_base else f"https://{request.host}/api/couple/media/{name}"
    return {'url': url, 'size': len(data)}


def read_upload():
    # Bound multipart parsing as well as the individual file read.
    request.max_content_length = MAX_BYTES + 256 * 1024
    file = request.files.get('file')
    if not file:
        return None, (jsonify(message='请选择文件'), 400)
    data = file.stream.read(MAX_BYTES + 1)
    if not data or len(data) > MAX_BYTES:
        return None, (jsonify(message='文件大小不能超过10MB'), 413)
    return data, None


@media_bp.errorhandler(413)
def too_large(_):
    return jsonify(message='文件大小不能超过10MB'), 413


@media_bp.post('/uploads/videos')
def upload_video():
    actor, error = authenticated(member=True)
    if error: return error
    data, error = read_upload()
    if error: return error
    # ISO base media MP4 container; do not trust a filename or MIME header alone.
    if len(data) < 16 or data[4:8] != b'ftyp' or not any(brand in data[8:64] for brand in (b'isom', b'iso2', b'mp41', b'mp42', b'avc1', b'M4V ')):
        return jsonify(message='请上传MP4格式视频'), 400
    return jsonify(store_file(data, 'mp4', actor)), 201


@media_bp.post('/uploads/avatars')
def upload_avatar():
    actor, error = authenticated()
    if error: return error
    data, error = read_upload()
    if error: return error
    extension = image_extension(data)
    if not extension: return jsonify(message='请使用 JPG、PNG、GIF 或 WebP 图片'), 400
    return jsonify(store_file(data, extension, actor)), 201


@media_bp.post('/users/qq-avatar')
def qq_avatar():
    actor, error = authenticated()
    if error: return error
    payload = request.get_json(silent=True)
    qq = str(payload.get('qq', '')) if isinstance(payload, dict) else ''
    if not re.fullmatch(r'[1-9]\d{4,11}', qq): return jsonify(message='请输入5至12位QQ号'), 400
    try:
        # No arbitrary URLs or redirects: the client only supplies decimal digits.
        with requests.get('https://q1.qlogo.cn/g', params={'b': 'qq', 'nk': qq, 's': '100'},
                          stream=True, allow_redirects=False, timeout=(3, 5)) as response:
            if response.status_code != 200: raise ValueError()
            data = bytearray()
            for chunk in response.iter_content(16384):
                data.extend(chunk)
                if len(data) > 2*1024*1024: raise ValueError()
            extension = image_extension(data)
            if not extension: raise ValueError()
        return jsonify(store_file(data, extension, actor))
    except (requests.RequestException, ValueError):
        return jsonify(message='QQ头像暂时无法获取，请稍后重试或上传图片'), 502


@media_bp.get('/media/<filename>')
def get_media(filename):
    if re.fullmatch(r'soundboard-[1-6]\.mp3', filename):
        response = send_from_directory(ROOT, filename, conditional=True,
                                       max_age=60 * 60 * 24 * 30,
                                       mimetype='audio/mpeg')
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Accept-Ranges'] = 'bytes'
        return response
    if filename in ('fusion-pixel-12px-zh_hans.woff2', 'fusion-pixel-LICENSE.txt'):
        response = send_from_directory(ROOT, filename, conditional=True, max_age=86400,
                                       mimetype='font/woff2' if filename.endswith('.woff2') else 'text/plain')
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response
    if re.fullmatch(r'soundboard-avatar-[1-4]\.png', filename):
        response = send_from_directory(ROOT, filename, conditional=True,
                                       max_age=60 * 60 * 24 * 30,
                                       mimetype='image/png')
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response
    if not re.fullmatch(r'\d+_[a-f0-9]{32}\.(mp4|jpg|png|gif|webp)', filename):
        return jsonify(message='文件不存在'), 404
    response = send_from_directory(ROOT, filename, conditional=True, max_age=86400)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response
