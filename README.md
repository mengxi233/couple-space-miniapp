# 伴侣空间小程序

[English](README.en.md) · [部署指南](docs/deployment.zh-CN.md) · [架构说明](docs/architecture.md) · [安全说明](SECURITY.md)

一个面向两个人共同生活的微信小程序与自托管后端。它把日历记录、共享待办、菜单点单、纪念日、时间线、双人问答和生活小工具放进同一个空间，同时保留访客只读模式、成员权限与可选通知能力。

> 本仓库是从实际运行项目中整理出的通用版本。生产域名、微信凭据、模板 ID、邮箱授权码、双方昵称、私人日期和服务器配置均已移除。截图来自定制实例，仅用于展示界面，公开模板中的名称与日期使用示例值。

## 界面预览

| 首页与日历 | 爱心菜单 | 双人待办 |
| --- | --- | --- |
| <img src="docs/screenshots/home.jpg" width="260" alt="首页与日历"> | <img src="docs/screenshots/menu.jpg" width="260" alt="爱心菜单"> | <img src="docs/screenshots/todos.jpg" width="260" alt="双人待办"> |

| 我的 | 关于 | 功能与版本记录 |
| --- | --- | --- |
| <img src="docs/screenshots/profile.jpg" width="260" alt="个人中心"> | <img src="docs/screenshots/about.jpg" width="260" alt="关于页面"> | <img src="docs/screenshots/features.jpg" width="260" alt="功能介绍与版本记录"> |

## 主要功能

- **首页与共同日历**：轮播图、关系计时、按月日历、心情、文字、图片和链接记录，显示创建时间与最后编辑者；支持访客查看和成员编辑。
- **爱心菜单与订单**：菜品分类、搜索、收藏、图片、购物车、下单、订单状态调整和完成记录；双方成员都可维护菜单。
- **双人共享待办**：搜索、状态/日期/优先级筛选、富文本、标签、负责人、截止时间、最多九张图片、完成与编辑记录、分享给微信好友。
- **大事纪年表**：按纵向时间线保存标题、详情、图片、链接与小体积视频，并可导出单张长图。
- **纪念日与提醒**：公历/农历日期、已过去时长、下一次倒计时、站内通知、可选 SMTP 邮件和微信一次性订阅消息。
- **双人问答留言板**：问题、回答、图片留言、回复、赞踩、十分制评分、结束/重开状态及站内/邮件通知。
- **做个决定**：随机转盘、可拖动选项、常用模板、历史结果与微信分享。
- **手持灯牌**：静态或滚动文字、字体/颜色/背景图、实时预览、保存图片；支持 2～6 台手机同步或拼接延长播放，并自动回收过期房间。
- **情侣转盘**：基础与私密题库、单机或双机同步抽题、最近记录与短时房间。
- **六键音乐挂件**：两套主题、六首音频、播放控制、进度拖动及本地缓存。示例音频不随仓库发布，请自行提供有权使用的资源。
- **个人与管理**：微信登录、激活码绑定、头像/昵称、QQ 公开头像、通知设置、首页轮播管理、灯牌房间管理和版本记录。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 小程序 | 原生微信小程序 JavaScript、WXML、WXSS、Vant Weapp 1.11 |
| 网络与登录 | `wx.request`、`wx.uploadFile`、微信 `code2Session`、Bearer 签名会话 |
| 后端 | Python 3.12、Flask 3.1、Flask-SQLAlchemy、SQLAlchemy 2、Gunicorn |
| 数据 | MySQL 8（业务数据）；SQLite（短时灯牌/转盘房间）；本地持久卷（图片、视频、字体、音频） |
| 通知 | 站内通知、SMTP 邮件、微信一次性订阅消息（均可选） |
| 部署 | Docker Compose、Nginx、HTTPS；纪念日与日历通知由 cron 触发 |
| 测试 | Node.js 内置测试脚本与 Python `unittest`（仓库保留的服务端用例） |

Redis、MinIO 并不是当前公开版的必需依赖。若访问量或媒体规模增大，可将短时房间迁移到 Redis，将上传存储迁移到 S3/MinIO；接口 URL 结构已集中在后端，便于替换。

## 仓库结构

```text
couple-space-miniapp/
├─ miniapp/                 微信小程序前端
│  ├─ pages/                主包页面
│  ├─ package-*/            分包：音乐挂件、情侣转盘、问答
│  ├─ components/           页面头、渐进图片等组件
│  ├─ services/             API、Markdown、海报、灯牌渲染
│  └─ config.js             非秘密的客户端运行配置
├─ server/                  Flask API
│  ├─ app/routes/           情侣空间业务路由
│  ├─ app/data/             默认题库
│  └─ *_notifications.py    定时通知入口
├─ deploy/nginx/            HTTPS 反向代理示例
├─ docs/                    架构、部署与截图
├─ docker-compose.yml       API + MySQL
└─ .env.example             服务端配置模板（不含真实秘密）
```

## 快速开始

### 1. 启动后端

```bash
cp .env.example .env
# 编辑 .env，至少替换数据库密码、SECRET_KEY、两个激活码和 PUBLIC_BASE_URL
docker compose up -d --build
curl http://127.0.0.1:5000/healthz
```

生成随机值：

```bash
python -c "import secrets; print(secrets.token_hex(32))"  # SECRET_KEY
python -c "import secrets; print(secrets.token_hex(8))"   # 每个激活码各执行一次
```

生产部署还需要 Nginx、有效 HTTPS 证书、域名与微信公众平台配置，见[完整部署指南](docs/deployment.zh-CN.md)。

### 2. 运行小程序

1. 编辑 `miniapp/config.js`，将 `apiBaseUrl` 改成你的 `https://域名/api/couple`，按需修改双方显示名和关系开始时间。
2. 用微信开发者工具导入 `miniapp` 目录。
3. 在“详情 → 基本信息”中填写自己的小程序 AppID；不要把 AppSecret 写入小程序代码。
4. 在项目中执行 `npm install`，然后在开发者工具选择“工具 → 构建 npm”。仓库也保留了已构建的 `miniprogram_npm`，便于直接预览。
5. 在微信公众平台配置 request、uploadFile、downloadFile 合法域名并重新编译。

## 配置与数据安全

- `.env`、`project.private.config.json`、数据库、上传文件和 SQLite 运行文件均已加入 `.gitignore`。
- `WX_APPSECRET`、SMTP 授权码和数据库密码只能放在服务端，不得写入 `miniapp`。
- 公开版不含真实 AppID、OpenID、邮件、访问码、订阅模板 ID或生产域名。
- 生产环境不允许开发登录回退；缺少安全会话密钥时服务端拒绝签发登录令牌。
- 上传接口限制单文件 10 MB，Nginx/Flask 请求层预留到 12 MB。
- 示例头像、轮播图和截图请在正式发行前替换为你拥有使用权的素材。第三方字体、Vant 和其他依赖遵循各自许可证。

## 部署方式

推荐拓扑为：微信小程序 → HTTPS/Nginx → Gunicorn/Flask → MySQL，上传与短时房间落在 Docker 持久卷。仓库同时支持：

- **Docker Compose（推荐）**：一条命令启动 MySQL 与 API；宿主机 Nginx 终止 TLS。
- **传统 Linux 部署**：Python 虚拟环境 + Gunicorn + systemd + 外部 MySQL。
- **已有基础设施**：只部署 `server` 镜像，通过 `DATABASE_URI` 连接托管 MySQL，将 `/app/data` 挂载到持久存储。

详细命令、Nginx、证书、cron、备份、微信域名和订阅模板配置见[部署指南](docs/deployment.zh-CN.md)。

## 权限模型

- 未登录访客只能读取允许公开的内容。
- 微信登录后仍需使用一次性激活码绑定情侣空间。
- `owner` 与 `member` 可协作编辑；涉及空间设置或全局资源的操作由服务端再次校验角色。
- 临时灯牌房和部分演示工具可匿名使用，但有房间数量、空闲时间和总生命周期限制。

## 许可

代码以 [PolyForm Noncommercial License 1.0.0](LICENSE) 提供：个人学习、研究、兴趣项目等非商业用途可以按许可证使用；付费开发、商业交付、SaaS、转售或商业产品集成必须取得单独书面授权。它是 **source-available（源码可见）** 许可，不是 OSI 定义的开源许可证。商业授权说明见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

## 致谢

- [Vant Weapp](https://github.com/youzan/vant-weapp)
- [Flask](https://flask.palletsprojects.com/)
- [SQLAlchemy](https://www.sqlalchemy.org/)
- [PolyForm Project](https://polyformproject.org/)

