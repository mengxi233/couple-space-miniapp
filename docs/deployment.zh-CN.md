# 部署指南

本文给出一套可复现的单机生产部署：Ubuntu/Debian + Docker Compose + MySQL + Nginx + HTTPS。小程序前端通过微信开发者工具上传，不部署到 Web 服务器。

## 1. 准备条件

- 已认证或可开发的微信小程序 AppID；
- 一个解析到服务器公网 IP 的域名；
- 有效 HTTPS 证书（微信正式环境不接受 IP、HTTP 或无效证书）；
- Linux 服务器、Docker Engine、Docker Compose v2 和 Nginx；
- 可选：SMTP 邮箱和两个微信订阅消息模板。

## 2. 创建配置

```bash
git clone <your-repository-url> couple-space-miniapp
cd couple-space-miniapp
cp .env.example .env
chmod 600 .env
```

至少修改：

- `SECRET_KEY`：不少于 32 个随机字符；
- `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD` 与 `DATABASE_URI`；
- `PUBLIC_BASE_URL=https://你的域名`；
- `WX_APPID`、`WX_APPSECRET`；
- 两个不同的 16 位小写十六进制激活码；
- `COUPLE_DEFAULT_START_DATE` 和空间名。

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
python3 -c "import secrets; print(secrets.token_hex(8))"
python3 -c "import secrets; print(secrets.token_hex(8))"
```

SMTP、微信订阅模板均可留空；留空只会关闭对应通知，不影响主要功能。QQ 邮箱通常使用 `smtp.qq.com:465`、`SMTP_SECURITY=ssl`，密码应填写单独生成的 SMTP 授权码而不是网页登录密码。

## 3. 启动 API 与数据库

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:5000/healthz
```

Compose 只把 API 绑定到服务器回环地址 `127.0.0.1:5000`，MySQL 不映射公网端口。请勿为了调试把数据库端口直接开放到互联网。

## 4. Nginx 与 HTTPS

复制 `deploy/nginx/couple-space.conf` 到 Nginx 配置目录，替换三处 `example.com`，配置证书路径并检查：

```bash
sudo nginx -t
sudo systemctl reload nginx
curl https://你的域名/healthz
```

示例已设置 `client_max_body_size 12m`；后端仍将单个图片/视频限制为 10 MB。若前面还有 CDN 或云负载均衡，也要把该层请求上限设为至少 12 MB。

## 5. 微信公众平台

在“开发管理 → 开发设置 → 服务器域名”中按实际功能配置：

- request 合法域名：`https://你的域名`
- uploadFile 合法域名：`https://你的域名`
- downloadFile 合法域名：`https://你的域名`

域名必须只写协议和主机，不要带 `/api/couple` 路径。保存后重新编译小程序；开发者工具缓存未刷新时，可清缓存并重新登录。服务端 AppID/AppSecret 必须与开发者工具导入项目时使用的 AppID 一致。

编辑 `miniapp/config.js`：

```js
module.exports = {
  apiBaseUrl: 'https://你的域名/api/couple',
  appName: '伴侣空间',
  coupleNames: ['我', 'TA'],
  relationshipStart: '2025-01-01T00:00:00+08:00',
  filingNumber: '你的备案号',
  copyrightOwner: '你的名称'
}
```

然后用微信开发者工具导入 `miniapp`，填写自己的 AppID，执行 `npm install` 和“构建 npm”。`WX_APPSECRET` 永远不能出现在这个目录。

## 6. 定时通知

纪念日提醒建议每 5 分钟执行，日历订阅消息建议每分钟执行。宿主机 `crontab -e` 示例：

```cron
* * * * * cd /opt/couple-space-miniapp && flock -n /tmp/couple-calendar.lock docker compose exec -T api python calendar_notifications.py >> /var/log/couple-calendar.log 2>&1
*/5 * * * * cd /opt/couple-space-miniapp && flock -n /tmp/couple-anniversary.lock docker compose exec -T api python anniversary_reminders.py >> /var/log/couple-anniversary.log 2>&1
```

微信小程序订阅消息通常是一次性授权：用户每次同意只增加一次可发送机会。模板 ID 必须与模板字段匹配；不确定时先关闭这两个环境变量，仅使用站内通知和邮件。

## 7. 媒体资源

六键音乐与像素字体由 `/api/couple/media/<filename>` 提供。请将你有权使用的以下文件放入 API 容器的 `/app/data/media`（对应 `app_data` 卷）：

- `soundboard-1.mp3` 至 `soundboard-6.mp3`
- `soundboard-avatar-1.png` 至 `soundboard-avatar-4.png`
- `fusion-pixel-12px-zh_hans.woff2`
- `fusion-pixel-LICENSE.txt`

仓库不附带音乐，以避免版权和代码包体积问题。上传的头像、图片和视频会进入同一持久卷的对应目录。

## 8. 备份与升级

```bash
# 数据库备份
docker compose exec -T mysql mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --single-transaction couple_space > couple_space.sql

# 查看卷名并备份 app_data
docker volume ls

# 升级
git pull --ff-only
docker compose up -d --build
docker compose ps
```

恢复演练与异地备份比“有备份文件”更重要。不要把备份、上传目录或 `.env` 提交到 Git。

## 9. 常见问题

- **请求合法域名报错**：确认 AppID 一致、域名为 HTTPS 且已在正确的小程序后台保存，重新编译并清开发者工具缓存。
- **登录 503**：检查服务器 `WX_APPID`/`WX_APPSECRET` 是否成对配置，以及 `SECRET_KEY` 是否至少 32 字符。
- **上传 413**：逐层检查 CDN、Nginx、网关和 Flask 上限；反向代理层应为 12 MB，单文件仍为 10 MB。
- **图片 PC 可见、真机不可见**：检查下载域名、证书链、返回 URL 是否为公网 HTTPS，以及 `PUBLIC_BASE_URL`。
- **订阅消息不发送**：确认用户已对对应模板主动授权一次、模板 ID/字段匹配、定时任务运行，并查看脱敏日志。
