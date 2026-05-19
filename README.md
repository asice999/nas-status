# NAS Status Page

增强版生产版 NAS 状态页方案：

- Debian + Docker Compose
- `nas-status-agent` 容器主动上报
- Cloudflare Worker 接收、存储、展示
- Basic Auth 页面保护
- 离线超时标红
- D1 历史趋势
- 企业微信 / Telegram 告警
- GHCR 镜像发布支持

## 目录结构

```text
nas-status-page/
├── worker.js
├── wrangler.toml
├── package.json
├── .gitignore
├── .github/workflows/build-agent-image.yml
└── agent/
    ├── agent.py
    ├── Dockerfile
    ├── docker-compose.yml
    ├── docker-compose.ghcr.yml
    └── .env.example
```

## Cloudflare 侧

### 1. 创建 Worker
建议名称：`nas-status-page`

### 2. 绑定 KV
创建一个 KV namespace，绑定变量名：

```text
NAS_STATUS
```

### 3. 绑定 D1（用于历史趋势）
创建一个 D1 数据库，绑定变量名：

```text
DB
```

### 4. 设置 Worker 环境变量
至少添加：

- `REPORT_TOKEN`

建议添加：

- `STATUS_USERNAME`
- `STATUS_PASSWORD`
- `STALE_AFTER_SECONDS`（例如 `180`）

可选告警：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `WECOM_BOT_WEBHOOK`

## Debian 侧（本地构建版）

```bash
cd /opt
rm -rf nas-status
git clone https://github.com/asice999/nas-status.git
cd /opt/nas-status/agent
cp .env.example .env
nano .env
docker compose up -d --build
```

## Debian 侧（GHCR 拉取版）

等 GitHub Actions 成功构建镜像后：

```bash
cd /opt
rm -rf nas-status
git clone https://github.com/asice999/nas-status.git
cd /opt/nas-status/agent
cp .env.example .env
nano .env
docker compose -f docker-compose.ghcr.yml up -d
```

GHCR 镜像地址：

```text
ghcr.io/asice999/nas-status-agent:latest
```

## 手动触发镜像构建

GitHub Actions 工作流：

- `Build and Publish Agent Image`

触发后会发布：

- `ghcr.io/asice999/nas-status-agent:latest`
- `ghcr.io/asice999/nas-status-agent:sha-...`

## 状态页访问

- 页面：`https://your-worker-domain.example.com/`
- 数据：`https://your-worker-domain.example.com/api/status`
- 历史：`https://your-worker-domain.example.com/api/history?limit=48`
- 健康检查：`https://your-worker-domain.example.com/healthz`
