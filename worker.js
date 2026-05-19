export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/report") {
      return handleReport(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      return handleGetStatus(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/history") {
      return handleGetHistory(request, env);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return handlePage(request, env);
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleReport(request, env, ctx) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");

  if (!env.REPORT_TOKEN || token !== env.REPORT_TOKEN) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  const now = new Date().toISOString();
  const prevRaw = await env.NAS_STATUS.get("latest");
  const prev = prevRaw ? safeJsonParse(prevRaw) : null;
  const payload = {
    ...body,
    received_at: now,
    stale: false,
  };

  await env.NAS_STATUS.put("latest", JSON.stringify(payload));

  if (env.DB) {
    ctx.waitUntil(saveHistory(env, payload));
  }

  ctx.waitUntil(maybeSendAlerts(env, prev, payload));

  return json({ ok: true, received_at: now });
}

async function handleGetStatus(request, env) {
  if (!isAuthorizedRequest(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const raw = await env.NAS_STATUS.get("latest");
  if (!raw) {
    return json({ ok: false, error: "no data yet" }, 404);
  }

  const data = safeJsonParse(raw);
  const staleAfter = Number(env.STALE_AFTER_SECONDS || 180);
  const ageSeconds = ageFromIso(data.received_at || data.updated_at);
  data.age_seconds = ageSeconds;
  data.stale = ageSeconds > staleAfter;

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function handleGetHistory(request, env) {
  if (!isAuthorizedRequest(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  if (!env.DB) {
    return json({ ok: false, error: "history db not configured" }, 500);
  }

  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") || 48), 500);
  const stmt = env.DB.prepare(
    "SELECT ts, cpu_percent, memory_percent, disk_percent, docker_running FROM status_history ORDER BY ts DESC LIMIT ?"
  ).bind(limit);
  const result = await stmt.all();
  const rows = (result.results || []).reverse();
  return json({ ok: true, items: rows });
}

function handlePage(request, env) {
  if (!isAuthorizedRequest(request, env)) {
    return new Response(loginHtml(), {
      status: 401,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="NAS Status"',
      },
    });
  }

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>NAS 状态页</title>
  <style>
    :root {
      --bg: #0b1020;
      --panel: #141b34;
      --line: #223059;
      --text: #eaf0ff;
      --muted: #9fb0d0;
      --upbg: #123b24;
      --upfg: #7dffab;
      --downbg: #4a1820;
      --downfg: #ff97a5;
      --warnbg: #4a3610;
      --warnfg: #ffd36a;
      --accent: #5aa9ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
      background: radial-gradient(circle at top, #152044 0%, var(--bg) 55%);
      color: var(--text);
    }
    .wrap { max-width: 1180px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0 0 10px; font-size: 32px; }
    .sub { color: var(--muted); margin-bottom: 24px; }
    .banner {
      margin-bottom: 20px;
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid #6b5120;
      background: rgba(74,54,16,.35);
      color: var(--warnfg);
      display: none;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: rgba(20, 27, 52, 0.92);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 14px 40px rgba(0,0,0,.24);
      backdrop-filter: blur(6px);
    }
    .label { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
    .value { font-size: 30px; font-weight: 800; }
    .small { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .section-title { font-size: 20px; margin: 28px 0 14px; }
    .services {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
    }
    .svc-name { font-size: 18px; font-weight: 800; margin-bottom: 10px; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
      margin-bottom: 10px;
    }
    .up { background: var(--upbg); color: var(--upfg); }
    .down { background: var(--downbg); color: var(--downfg); }
    .warn { background: var(--warnbg); color: var(--warnfg); }
    .muted { color: var(--muted); font-size: 13px; margin-top: 6px; }
    .footer { color: var(--muted); font-size: 12px; margin-top: 24px; }
    .charts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px;
    }
    canvas { width: 100%; height: 180px; display: block; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>NAS 状态页</h1>
    <div class="sub" id="updated">加载中...</div>
    <div class="banner" id="banner"></div>

    <div class="grid" id="summary"></div>

    <div class="section-title">资源趋势</div>
    <div class="charts">
      <div class="card"><div class="label">CPU / %</div><canvas id="cpuChart" width="500" height="180"></canvas></div>
      <div class="card"><div class="label">内存 / %</div><canvas id="memChart" width="500" height="180"></canvas></div>
      <div class="card"><div class="label">磁盘 / %</div><canvas id="diskChart" width="500" height="180"></canvas></div>
    </div>

    <div class="section-title">服务状态</div>
    <div class="services" id="services"></div>

    <div class="footer">每 30 秒自动刷新</div>
  </div>

  <script>
    function formatUptime(seconds) {
      seconds = Number(seconds || 0);
      const d = Math.floor(seconds / 86400);
      const h = Math.floor((seconds % 86400) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return [d ? d + '天' : '', h ? h + '小时' : '', m + '分钟'].filter(Boolean).join(' ');
    }

    function renderSummaryCard(k, v, s) {
      return '<div class="card">' +
        '<div class="label">' + k + '</div>' +
        '<div class="value">' + v + '</div>' +
        '<div class="small">' + s + '</div>' +
      '</div>';
    }

    function renderServiceCard(name, info, updatedAt) {
      const status = info.status || 'down';
      const badgeClass = status === 'up' ? 'up' : (status === 'warn' ? 'warn' : 'down');
      const badgeText = status.toUpperCase();
      return '<div class="card">' +
        '<div class="svc-name">' + name + '</div>' +
        '<span class="badge ' + badgeClass + '">' + badgeText + '</span>' +
        '<div class="muted">容器状态：' + (info.container_state || '-') + '</div>' +
        '<div class="muted">更新时间：' + updatedAt + '</div>' +
      '</div>';
    }

    function drawLineChart(canvasId, items, key, color) {
      const canvas = document.getElementById(canvasId);
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (let i = 1; i <= 4; i++) {
        const y = (h / 5) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      if (!items.length) return;
      const values = items.map(function(it) { return Number(it[key] || 0); });
      const max = Math.max(100, ...values);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      values.forEach(function(v, i) {
        const x = values.length === 1 ? 0 : (w / (values.length - 1)) * i;
        const y = h - (v / max) * (h - 10) - 5;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    async function load() {
      try {
        const [statusRes, historyRes] = await Promise.all([
          fetch('/api/status', { cache: 'no-store' }),
          fetch('/api/history?limit=48', { cache: 'no-store' }),
        ]);
        const data = await statusRes.json();
        const history = await historyRes.json();

        if (!data || data.ok === false) {
          document.getElementById('updated').textContent = '暂无状态数据';
          return;
        }

        document.getElementById('updated').textContent =
          '主机：' + (data.host || '-') +
          ' · 最近上报：' + (data.updated_at || data.received_at || '-') +
          ' · 已运行：' + formatUptime(data.uptime_seconds);

        const banner = document.getElementById('banner');
        if (data.stale) {
          banner.style.display = 'block';
          banner.textContent = '告警：最近 ' + (data.age_seconds || 0) + ' 秒没有上报，NAS 可能离线。';
        } else {
          banner.style.display = 'none';
          banner.textContent = '';
        }

        const loadAvg = data.load_average || {};
        const summary = [
          ['CPU', (data.cpu_percent ?? '-') + '%', '当前 CPU 使用率'],
          ['内存', (data.memory_percent ?? '-') + '%', '当前内存使用率'],
          ['磁盘', (data.disk_percent ?? '-') + '%', '根分区使用率'],
          ['Docker 运行中', String(data.docker_running ?? '-'), '运行中的容器数量'],
          ['负载 1m', String(loadAvg['1m'] ?? '-'), '系统 load average'],
          ['负载 5m', String(loadAvg['5m'] ?? '-'), '系统 load average'],
        ];

        document.getElementById('summary').innerHTML = summary.map(function(item) {
          return renderSummaryCard(item[0], item[1], item[2]);
        }).join('');

        const services = data.services || {};
        const updatedAt = data.updated_at || data.received_at || '-';
        document.getElementById('services').innerHTML = Object.entries(services).map(function(entry) {
          return renderServiceCard(entry[0], entry[1], updatedAt);
        }).join('');

        const items = (history && history.items) ? history.items : [];
        drawLineChart('cpuChart', items, 'cpu_percent', '#5aa9ff');
        drawLineChart('memChart', items, 'memory_percent', '#7dffab');
        drawLineChart('diskChart', items, 'disk_percent', '#ffd36a');
      } catch (e) {
        document.getElementById('updated').textContent = '加载失败：' + e.message;
      }
    }

    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function saveHistory(env, payload) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      cpu_percent REAL,
      memory_percent REAL,
      disk_percent REAL,
      docker_running INTEGER
    );
  `);
  await env.DB.prepare(
    "INSERT INTO status_history (ts, cpu_percent, memory_percent, disk_percent, docker_running) VALUES (?, ?, ?, ?, ?)"
  ).bind(
    payload.received_at || payload.updated_at,
    Number(payload.cpu_percent || 0),
    Number(payload.memory_percent || 0),
    Number(payload.disk_percent || 0),
    Number(payload.docker_running || 0)
  ).run();
  await env.DB.exec(`
    DELETE FROM status_history
    WHERE id NOT IN (
      SELECT id FROM status_history ORDER BY ts DESC LIMIT 500
    );
  `);
}

async function maybeSendAlerts(env, prev, curr) {
  const alerts = [];
  const currServices = curr.services || {};
  const prevServices = (prev && prev.services) || {};

  for (const [name, info] of Object.entries(currServices)) {
    const prevStatus = (prevServices[name] && prevServices[name].status) || null;
    if (prevStatus && prevStatus !== info.status && info.status !== 'up') {
      alerts.push(`服务异常：${name} -> ${info.status}（${info.container_state || '-'}）`);
    }
  }

  if (!alerts.length) return;

  const text = [
    `NAS 状态告警`,
    `主机：${curr.host || '-'}`,
    `时间：${curr.received_at || curr.updated_at || '-'}`,
    ...alerts,
  ].join("\n");

  await Promise.allSettled([
    sendTelegram(env, text),
    sendWecom(env, text),
  ]);
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
}

async function sendWecom(env, text) {
  if (!env.WECOM_BOT_WEBHOOK) return;
  await fetch(env.WECOM_BOT_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
  });
}

function isAuthorizedRequest(request, env) {
  if (!env.STATUS_USERNAME || !env.STATUS_PASSWORD) {
    return true;
  }
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(':');
    if (idx === -1) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    return user === env.STATUS_USERNAME && pass === env.STATUS_PASSWORD;
  } catch {
    return false;
  }
}

function ageFromIso(value) {
  if (!value) return 999999;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return 999999;
  return Math.max(0, Math.floor((Date.now() - ts) / 1000));
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loginHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Unauthorized</title></head><body style="font-family:sans-serif;padding:32px;">需要 Basic Auth 登录后才能查看状态页。</body></html>`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
