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
  const payload = { ...body, received_at: now, stale: false };

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
  if (!raw) return json({ ok: false, error: "no data yet" }, 404);

  const data = safeJsonParse(raw);
  const staleAfter = Number(env.STALE_AFTER_SECONDS || 180);
  const ageSeconds = ageFromIso(data.received_at || data.updated_at);
  data.age_seconds = ageSeconds;
  data.stale = ageSeconds > staleAfter;

  return json(data, 200);
}

async function handleGetHistory(request, env) {
  if (!isAuthorizedRequest(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.DB) return json({ ok: false, error: "history db not configured", items: [] }, 200);

  try {
    await ensureHistoryTable(env);
    const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") || 48), 500);
    const stmt = env.DB.prepare(
      "SELECT ts, cpu_percent, memory_percent, disk_percent, docker_running, net_rx_kbps, net_tx_kbps, load_1m, load_5m, disk_used_gb, disk_total_gb FROM status_history ORDER BY ts DESC LIMIT ?"
    ).bind(limit);
    const result = await stmt.all();
    const rows = (result.results || []).reverse();
    return json({ ok: true, items: rows }, 200);
  } catch (err) {
    return json({ ok: false, error: `history unavailable: ${err.message || String(err)}`, items: [] }, 200);
  }
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
      --bg: #07111f;
      --bg2: #0d1830;
      --panel: rgba(16, 26, 52, 0.88);
      --line: rgba(105, 132, 190, 0.18);
      --text: #edf3ff;
      --muted: #9eb2d9;
      --upbg: rgba(35, 138, 84, 0.18);
      --upfg: #75f2a8;
      --downbg: rgba(177, 54, 76, 0.18);
      --downfg: #ff9db1;
      --warnbg: rgba(163, 118, 27, 0.18);
      --warnfg: #ffd878;
      --blue: #64a8ff;
      --green: #63e6a8;
      --yellow: #ffd778;
      --cyan: #63d7ff;
      --purple: #9f8bff;
      --shadow: 0 18px 50px rgba(0,0,0,.28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Inter, sans-serif;
      color: var(--text);
      background: radial-gradient(circle at top, #112451 0%, var(--bg) 42%, #050b16 100%);
    }
    .wrap { max-width: 1320px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0; font-size: 40px; letter-spacing: -1px; }
    .sub { color: var(--muted); margin-top: 10px; margin-bottom: 22px; font-size: 14px; }
    .hero {
      display: grid;
      grid-template-columns: 1.6fr 1fr;
      gap: 18px;
      margin-bottom: 20px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 22px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }
    .hero-title { font-size: 14px; color: var(--muted); margin-bottom: 8px; }
    .hero-value { font-size: 46px; font-weight: 900; line-height: 1; }
    .hero-row { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
    .pill {
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 800;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .pill.up { background: var(--upbg); color: var(--upfg); }
    .pill.down { background: var(--downbg); color: var(--downfg); }
    .pill.warn { background: var(--warnbg); color: var(--warnfg); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 16px;
      margin: 18px 0 26px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 18px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
    }
    .label { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
    .value { font-size: 30px; font-weight: 900; }
    .small { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .section-title { font-size: 21px; margin: 28px 0 14px; }
    .charts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
    }
    .chart-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 16px 16px 10px;
      box-shadow: var(--shadow);
    }
    .chart-head { display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px; }
    .chart-title { font-size: 14px; color: var(--muted); }
    .chart-tip { font-size: 12px; color: var(--muted); }
    canvas { width: 100%; height: 220px; display: block; }
    .services, .checks {
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
    .banner {
      margin-bottom: 18px;
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid rgba(255, 191, 67, 0.25);
      background: rgba(139, 97, 16, 0.22);
      color: #ffd978;
      display: none;
    }
    .footer { color: var(--muted); font-size: 12px; margin: 24px 0 40px; }
    @media (max-width: 900px) {
      .hero { grid-template-columns: 1fr; }
      h1 { font-size: 34px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>NAS 状态页</h1>
    <div class="sub" id="updated">加载中...</div>
    <div class="banner" id="banner"></div>

    <div class="hero">
      <div class="panel">
        <div class="hero-title">主机在线状态</div>
        <div class="hero-value" id="heroHost">--</div>
        <div class="hero-row" id="heroPills"></div>
      </div>
      <div class="panel">
        <div class="hero-title">磁盘容量概览</div>
        <div class="hero-value" id="heroDisk">--</div>
        <div class="small" id="heroDiskSub">--</div>
      </div>
    </div>

    <div class="grid" id="summary"></div>

    <div class="section-title">资源趋势</div>
    <div class="charts">
      <div class="chart-card"><div class="chart-head"><div class="chart-title">CPU 使用率</div><div class="chart-tip">最近 48 个点</div></div><canvas id="cpuChart" width="560" height="220"></canvas></div>
      <div class="chart-card"><div class="chart-head"><div class="chart-title">内存使用率</div><div class="chart-tip">最近 48 个点</div></div><canvas id="memChart" width="560" height="220"></canvas></div>
      <div class="chart-card"><div class="chart-head"><div class="chart-title">磁盘使用率</div><div class="chart-tip">最近 48 个点</div></div><canvas id="diskChart" width="560" height="220"></canvas></div>
      <div class="chart-card"><div class="chart-head"><div class="chart-title">网络速度</div><div class="chart-tip">上行 / 下行 KB/s</div></div><canvas id="netChart" width="560" height="220"></canvas></div>
      <div class="chart-card"><div class="chart-head"><div class="chart-title">Docker 运行容器数</div><div class="chart-tip">最近 48 个点</div></div><canvas id="dockerChart" width="560" height="220"></canvas></div>
      <div class="chart-card"><div class="chart-head"><div class="chart-title">系统负载</div><div class="chart-tip">1m / 5m</div></div><canvas id="loadChart" width="560" height="220"></canvas></div>
    </div>

    <div class="section-title">服务状态</div>
    <div class="services" id="services"></div>

    <div class="section-title">连通性检查</div>
    <div class="checks" id="checks"></div>

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

    function fmtGb(v) {
      const n = Number(v || 0);
      return n.toFixed(1) + ' GB';
    }

    function fmtSpeed(v) {
      const n = Number(v || 0);
      if (n >= 1024) return (n / 1024).toFixed(1) + ' MB/s';
      return n.toFixed(1) + ' KB/s';
    }

    function fmtTimeLabel(ts) {
      const d = new Date(ts);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
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

    function renderCheckCard(name, info, kind) {
      const status = info.status || 'down';
      const badgeClass = status === 'up' ? 'up' : 'down';
      const badgeText = status === 'up' ? '在线' : '离线';
      let detail = '';
      if (kind === 'ping') {
        detail = '延迟：' + (info.latency_ms == null ? '--' : info.latency_ms + ' ms');
      } else {
        detail = '状态码：' + (info.http_status == null ? '--' : info.http_status) + ' · 延迟：' + (info.latency_ms == null ? '--' : info.latency_ms + ' ms');
      }
      return '<div class="card">' +
        '<div class="svc-name">' + name + '</div>' +
        '<span class="badge ' + badgeClass + '">' + badgeText + '</span>' +
        '<div class="muted">' + detail + '</div>' +
      '</div>';
    }

    function drawAxes(ctx, w, h, labels, max, unit) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.fillStyle = 'rgba(210,220,255,0.58)';
      ctx.lineWidth = 1;
      ctx.font = '11px sans-serif';
      const left = 40, right = 8, top = 8, bottom = 24;
      for (let i = 0; i <= 4; i++) {
        const y = top + ((h - top - bottom) / 4) * i;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(w - right, y);
        ctx.stroke();
        const value = Math.round(max - (max / 4) * i);
        ctx.fillText(value + unit, 4, y + 4);
      }
      const step = Math.max(1, Math.floor(labels.length / 4));
      for (let i = 0; i < labels.length; i += step) {
        const x = left + ((w - left - right) / Math.max(labels.length - 1, 1)) * i;
        ctx.fillText(labels[i], x - 12, h - 6);
      }
      return { left, right, top, bottom };
    }

    function drawMultiLineChart(canvasId, series, labels, colors, max, unit) {
      const canvas = document.getElementById(canvasId);
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const box = drawAxes(ctx, w, h, labels, max, unit);
      const plotW = w - box.left - box.right;
      const plotH = h - box.top - box.bottom;
      series.forEach(function(values, idx) {
        if (!values.length) return;
        ctx.strokeStyle = colors[idx];
        ctx.lineWidth = 2;
        ctx.beginPath();
        values.forEach(function(v, i) {
          const x = box.left + (plotW / Math.max(values.length - 1, 1)) * i;
          const y = box.top + plotH - ((Number(v || 0) / max) * plotH);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
    }

    async function load() {
      try {
        const statusRes = await fetch('/api/status', { cache: 'no-store' });
        const data = await statusRes.json();
        let history = { ok: false, items: [] };
        try {
          const historyRes = await fetch('/api/history?limit=48', { cache: 'no-store' });
          history = await historyRes.json();
        } catch (e) {
          history = { ok: false, items: [] };
        }
        if (!data || data.ok === false) {
          document.getElementById('updated').textContent = '暂无状态数据';
          return;
        }

        document.getElementById('updated').textContent =
          '主机：' + (data.host || '-') +
          ' · 最近上报：' + (data.updated_at || data.received_at || '-') +
          ' · 已运行：' + formatUptime(data.uptime_seconds);

        document.getElementById('heroHost').textContent = data.stale ? '离线' : '在线';
        document.getElementById('heroDisk').textContent = fmtGb(data.disk_used_gb) + ' / ' + fmtGb(data.disk_total_gb);
        document.getElementById('heroDiskSub').textContent = '可用 ' + fmtGb(data.disk_free_gb) + ' · 使用率 ' + (data.disk_percent ?? '-') + '%';
        document.getElementById('heroPills').innerHTML = [
          '<span class="pill ' + (data.stale ? 'down' : 'up') + '">' + (data.stale ? 'NAS 离线' : 'NAS 在线') + '</span>',
          '<span class="pill up">上行 ' + fmtSpeed(data.net_tx_kbps) + '</span>',
          '<span class="pill up">下行 ' + fmtSpeed(data.net_rx_kbps) + '</span>',
          '<span class="pill warn">Docker ' + String(data.docker_running ?? '-') + '</span>'
        ].join('');

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
          ['磁盘', (data.disk_percent ?? '-') + '%', '已用 ' + fmtGb(data.disk_used_gb) + ' / 总量 ' + fmtGb(data.disk_total_gb)],
          ['网络上行', fmtSpeed(data.net_tx_kbps), '当前发送速度'],
          ['网络下行', fmtSpeed(data.net_rx_kbps), '当前接收速度'],
          ['Docker 运行中', String(data.docker_running ?? '-'), '运行中的容器数量'],
          ['负载 1m', String(loadAvg['1m'] ?? '-'), '系统短时负载'],
          ['负载 5m', String(loadAvg['5m'] ?? '-'), '系统中时负载'],
        ];
        document.getElementById('summary').innerHTML = summary.map(function(item) {
          return renderSummaryCard(item[0], item[1], item[2]);
        }).join('');

        const services = data.services || {};
        const updatedAt = data.updated_at || data.received_at || '-';
        document.getElementById('services').innerHTML = Object.entries(services).map(function(entry) {
          return renderServiceCard(entry[0], entry[1], updatedAt);
        }).join('');

        const pingChecks = data.ping_checks || {};
        const httpChecks = data.http_checks || {};
        const checkCards = [];
        Object.entries(pingChecks).forEach(function(entry) { checkCards.push(renderCheckCard(entry[0], entry[1], 'ping')); });
        Object.entries(httpChecks).forEach(function(entry) { checkCards.push(renderCheckCard(entry[0], entry[1], 'http')); });
        document.getElementById('checks').innerHTML = checkCards.join('');

        const items = (history && history.items) ? history.items : [];
        const labels = items.map(function(it) { return fmtTimeLabel(it.ts); });
        drawMultiLineChart('cpuChart', [items.map(it => it.cpu_percent)], labels, ['#64a8ff'], 100, '%');
        drawMultiLineChart('memChart', [items.map(it => it.memory_percent)], labels, ['#63e6a8'], 100, '%');
        drawMultiLineChart('diskChart', [items.map(it => it.disk_percent)], labels, ['#ffd778'], 100, '%');
        drawMultiLineChart('netChart', [items.map(it => it.net_rx_kbps), items.map(it => it.net_tx_kbps)], labels, ['#63d7ff', '#9f8bff'], Math.max(100, ...items.map(it => Math.max(Number(it.net_rx_kbps || 0), Number(it.net_tx_kbps || 0)))), '');
        drawMultiLineChart('dockerChart', [items.map(it => it.docker_running)], labels, ['#edf3ff'], Math.max(10, ...items.map(it => Number(it.docker_running || 0))), '');
        drawMultiLineChart('loadChart', [items.map(it => it.load_1m), items.map(it => it.load_5m)], labels, ['#ffb45e', '#5aa9ff'], Math.max(5, ...items.map(it => Math.max(Number(it.load_1m || 0), Number(it.load_5m || 0)))), '');
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
  await ensureHistoryTable(env);
  await env.DB.prepare(
    "INSERT INTO status_history (ts, cpu_percent, memory_percent, disk_percent, docker_running, net_rx_kbps, net_tx_kbps, load_1m, load_5m, disk_used_gb, disk_total_gb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    payload.received_at || payload.updated_at,
    Number(payload.cpu_percent || 0),
    Number(payload.memory_percent || 0),
    Number(payload.disk_percent || 0),
    Number(payload.docker_running || 0),
    Number(payload.net_rx_kbps || 0),
    Number(payload.net_tx_kbps || 0),
    Number((payload.load_average || {})['1m'] || 0),
    Number((payload.load_average || {})['5m'] || 0),
    Number(payload.disk_used_gb || 0),
    Number(payload.disk_total_gb || 0)
  ).run();
  await env.DB.exec("DELETE FROM status_history WHERE id NOT IN (SELECT id FROM status_history ORDER BY ts DESC LIMIT 500)");
}

async function ensureHistoryTable(env) {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, cpu_percent REAL, memory_percent REAL, disk_percent REAL, docker_running INTEGER, net_rx_kbps REAL, net_tx_kbps REAL, load_1m REAL, load_5m REAL, disk_used_gb REAL, disk_total_gb REAL)");
  await safeAlter(env, "ALTER TABLE status_history ADD COLUMN net_rx_kbps REAL");
  await safeAlter(env, "ALTER TABLE status_history ADD COLUMN net_tx_kbps REAL");
  await safeAlter(env, "ALTER TABLE status_history ADD COLUMN load_1m REAL");
  await safeAlter(env, "ALTER TABLE status_history ADD COLUMN load_5m REAL");
  await safeAlter(env, "ALTER TABLE status_history ADD COLUMN disk_used_gb REAL");
  await safeAlter(env, "ALTER TABLE status_history ADD COLUMN disk_total_gb REAL");
}

async function safeAlter(env, sql) {
  try { await env.DB.exec(sql); } catch {}
}

async function maybeSendAlerts(env, prev, curr) {
  const messages = [];
  collectServiceAlerts(messages, prev, curr);
  collectCheckAlerts(messages, 'Ping', (prev && prev.ping_checks) || {}, curr.ping_checks || {});
  collectCheckAlerts(messages, 'HTTP', (prev && prev.http_checks) || {}, curr.http_checks || {});
  if (!messages.length) return;

  const text = [
    `NAS 状态通知`,
    `主机：${curr.host || '-'}`,
    `时间：${formatCnTime(curr.received_at || curr.updated_at)}`,
    ...messages,
  ].join("\n");

  await Promise.allSettled([
    sendTelegram(env, text),
    sendWecomApp(env, text),
  ]);
}

function collectServiceAlerts(messages, prev, curr) {
  const currServices = curr.services || {};
  const prevServices = (prev && prev.services) || {};
  for (const [name, info] of Object.entries(currServices)) {
    const prevStatus = (prevServices[name] && prevServices[name].status) || null;
    if (!prevStatus || prevStatus === info.status) continue;
    if (info.status === 'up') {
      messages.push(`服务恢复：${name} 已恢复在线（${info.container_state || '-'}）`);
    } else if (info.status === 'warn') {
      messages.push(`服务告警：${name} 状态异常（${info.container_state || '-'}）`);
    } else {
      messages.push(`服务异常：${name} 已离线（${info.container_state || '-'}）`);
    }
  }
}

function collectCheckAlerts(messages, label, prevChecks, currChecks) {
  for (const [name, info] of Object.entries(currChecks || {})) {
    const prevStatus = (prevChecks[name] && prevChecks[name].status) || null;
    if (!prevStatus || prevStatus === info.status) continue;
    if (info.status === 'up') {
      messages.push(`${label} 恢复：${name} 已恢复可达`);
    } else {
      messages.push(`${label} 异常：${name} 当前不可达`);
    }
  }
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
}

async function sendWecomApp(env, text) {
  if (!env.WECOM_CORP_ID || !env.WECOM_AGENT_ID || !env.WECOM_SECRET || !env.WECOM_TOPARTY) return;
  const tokenResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(env.WECOM_CORP_ID)}&corpsecret=${encodeURIComponent(env.WECOM_SECRET)}`);
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) return;
  await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(tokenData.access_token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      toparty: String(env.WECOM_TOPARTY),
      msgtype: 'text',
      agentid: Number(env.WECOM_AGENT_ID),
      text: { content: text },
      safe: 0,
    }),
  });
}

function isAuthorizedRequest(request, env) {
  if (!env.STATUS_USERNAME || !env.STATUS_PASSWORD) return true;
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

function formatCnTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function safeJsonParse(raw) {
  try { return JSON.parse(raw); } catch { return {}; }
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
