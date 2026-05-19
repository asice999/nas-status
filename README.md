# NAS Status Page

增强版生产版 NAS 状态页方案：

- Debian + Docker Compose
- `nas-status-agent` 容器主动上报
- Cloudflare Worker 接收、存储、展示
- Basic Auth 页面保护
- 离线超时标红
- D1 历史趋势
- 企业微信 / Telegram 告警

## 目录结构

```text
nas-status-page/
├── worker.js
├── wrangler.toml
├── package.json
├── .gitignore
└── agent/
    ├── agent.py
    ├── Dockerfile
    ├── docker-compose.yml
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

并把 `wrangler.toml` 里的：

```toml
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

替换成真实 ID。

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

### 5. 部署
将 `worker.js` 粘贴到 Worker 中部署，或使用 wrangler。

## Debian 侧

### 1. 准备目录

```bash
mkdir -p /opt/nas-status-agent
cd /opt/nas-status-agent
```

把 `agent/` 目录中的文件复制进去。

### 2. 创建环境变量文件

```bash
cp .env.example .env
```

编辑 `.env`：

```env
REPORT_URL=https://your-worker-domain.example.com/api/report
REPORT_TOKEN=your_report_token
```

### 3. 启动 agent

```bash
docker compose up -d --build
```

### 4. 查看日志

```bash
docker logs -f nas-status-agent
```

正常应看到：

```json
{"ok": true, "received_at": "..."}
```

## 状态页访问

- 页面：`https://your-worker-domain.example.com/`
- 数据：`https://your-worker-domain.example.com/api/status`
- 历史：`https://your-worker-domain.example.com/api/history?limit=48`
- 健康检查：`https://your-worker-domain.example.com/healthz`

## 默认监控服务

- qinglong
- postgres-main
- sub2api
- moviepilot-v2
- jellyfin
- emby
- qbittorrent
- navidrome

如果容器名与实际不一致，请修改 `agent.py` 里的 `WATCH_SERVICES`。

## 功能说明

### 页面密码保护
如果配置了：

- `STATUS_USERNAME`
- `STATUS_PASSWORD`

访问页面、状态 API、历史 API 时都需要 Basic Auth。

### 离线超时标红
如果最后一次上报超过 `STALE_AFTER_SECONDS`，页面顶部会显示离线告警横幅。

### 历史趋势图
Worker 会把最近 500 次上报写入 D1，并在页面上绘制：

- CPU 趋势
- 内存趋势
- 磁盘趋势

### 告警通知
当服务状态从正常切换到异常时，Worker 会尝试发送：

- Telegram 通知（如果配置了 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`）
- 企业微信机器人通知（如果配置了 `WECOM_BOT_WEBHOOK`）

## 安全说明

- agent 不暴露公网端口
- agent 只主动上报
- 只上传摘要数据
- Docker socket 为只读挂载
- 页面可启用 Basic Auth

## 建议下一步

- 绑定自定义域名
- 通过 Cloudflare Access 再加一层保护
- 后续可继续扩展：公网 IP、证书到期、容器资源明细、告警去重
