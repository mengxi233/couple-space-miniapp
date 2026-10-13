# 安全说明 / Security

请不要在公开 Issue 中粘贴 `.env`、微信 AppSecret、SMTP 授权码、数据库密码、用户 OpenID 或生产日志全文。

部署时必须：

1. 使用至少 32 个随机字符的 `SECRET_KEY`；
2. 将所有秘密保存在服务器 `.env`、Docker Secret 或密钥管理服务中；
3. 仅开放 80/443，对外关闭 MySQL 和 Flask 端口；
4. 为 API 配置 HTTPS，并在微信公众平台添加合法 request/uploadFile/downloadFile 域名；
5. 定期备份 MySQL 和 `app_data` 数据卷；
6. 生产环境保持 `COUPLE_DEV_LOGIN=false`，设置不可预测且不同的两个激活码；
7. 只在确有 Web 跨域需求时配置 `CORS_ALLOWED_ORIGINS`，不要使用 `*`。

Security reports may be submitted privately to the maintainer. Never include
live credentials, OpenIDs, database dumps, or private media in a public issue.
