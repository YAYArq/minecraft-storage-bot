'use strict';

/**
 * 仓库分类 BOT 控制面板前端（无打包，直接可用）
 * UI 参考 YAYA MCC BOT 风格；通信：WebSocket(/ws) + REST API（同端口 10260）
 */

/* ================= 全局状态 ================= */
const state = {
  ws: null,
  connected: false,
  bots: [],
  selectedId: null,     // 实例详情当前 bot
  settings: null,       // 系统设置
  audit: null,          // 盘点结果
  chatLog: [],          // 聊天消息流
  logAll: [],
  logOne: [],
  view: 'instances',
  configRaw: '',
  vis: null         // 可视化配置（返回点/源箱/目标箱/溢出箱）编辑状态
};

const $ = (id) => document.getElementById(id);
const BASE_PORT = '10260';
const apiRoot = () => `http://${location.hostname || 'localhost'}:${location.port || BASE_PORT}`;
const wsUrl = () => `ws://${location.hostname || 'localhost'}:${location.port || BASE_PORT}/ws`;

const fmtTime = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const fmtDate = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ================= WebSocket ================= */
function connectWs() {
  state.ws = new WebSocket(wsUrl());
  state.ws.onopen = () => { state.connected = true; setWsBadge(); };
  state.ws.onmessage = (ev) => { try { handleMessage(JSON.parse(ev.data)); } catch (e) { /* ignore */ } };
  state.ws.onclose = () => { state.connected = false; setWsBadge(); setTimeout(connectWs, 3000); };
  state.ws.onerror = () => { /* onclose 处理重连 */ };
}

function setWsBadge() {
  $('conn-status').textContent = state.connected ? '● 已连接' : '○ 未连接';
  $('conn-status').className = 'conn-status ' + (state.connected ? 'on' : 'off');
  $('ws-label').textContent = state.connected ? '已连接' : '未连接';
}

function sendCommand(botId, command, args) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showResult('cmd-result', 'WebSocket 未连接', false);
    return;
  }
  state.ws.send(JSON.stringify({ type: 'command', botId, command, args }));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      state.bots = msg.bots || [];
      if (!state.selectedId && state.bots.length) state.selectedId = state.bots[0].id;
      renderAll();
      break;
    case 'status':
      upsertBot(msg.bot);
      renderAll();
      break;
    case 'log':
      appendLog(msg.entry);
      break;
    case 'chat':
      appendChat(msg.chat);
      break;
    case 'commandResult':
      showResult('cmd-result', msg.message, msg.ok);
      showResult('chat-result', msg.message, msg.ok);
      break;
    case 'pong': break;
    case 'error':
      showResult('cmd-result', msg.message, false);
      showResult('chat-result', msg.message, false);
      break;
  }
}

function upsertBot(bot) {
  const i = state.bots.findIndex(b => b.id === bot.id);
  if (i >= 0) state.bots[i] = bot;
  else state.bots.push(bot);
}

const botOf = (id) => state.bots.find(b => b.id === id) || null;
const curBot = () => botOf(state.selectedId);

/* ================= REST ================= */
async function api(path, opts) {
  const res = await fetch(apiRoot() + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  return res.json();
}

/* ================= 视图切换 ================= */
function switchView(view) {
  state.view = view;
  for (const btn of document.querySelectorAll('.main-tab')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  for (const id of ['sec-instances', 'sec-map', 'sec-tasks', 'sec-inventory', 'sec-chat', 'sec-configs', 'sec-settings', 'sec-logs', 'sec-detail']) {
    const el = $(id);
    if (!el) continue;
    const isViewSec = id === 'sec-' + view;
    const isDetail = id === 'sec-detail';
    const showDetail = isDetail && view === 'instances' && !!state.selectedId;
    el.classList.toggle('hidden', !(isViewSec || showDetail));
  }
  if (view === 'map') renderMap();
  if (view === 'tasks') loadTasks();
  if (view === 'inventory') loadAudit();
  if (view === 'configs') loadConfigs();
  if (view === 'settings') loadSettings();
  if (view === 'instances' && state.selectedId) loadConfigEditor();
}

/* ================= 渲染 ================= */
function renderAll() {
  renderHero();
  renderInstances();
  if (state.selectedId) renderDetail();
  fillBotSelects();
}

function renderHero() {
  const online = state.bots.filter(b => b.connectionState === 'online').length;
  const tasks = state.bots.filter(b => b.task && b.task.state === 'running').length;
  const alerts = state.bots.filter(b => b.paused).length;
  $('h-instances').textContent = state.bots.length;
  $('h-online').textContent = online;
  $('h-tasks').textContent = tasks;
  $('h-alerts').textContent = alerts;
}

const connLabel = { online: '在线', offline: '离线', connecting: '连接中', idle: '未启动' };

function renderInstances() {
  const grid = $('instance-grid');
  grid.innerHTML = '';
  $('list-summary').textContent = state.bots.length ? `共 ${state.bots.length} 个实例` : '';
  $('empty-state').classList.toggle('hidden', state.bots.length > 0);
  for (const b of state.bots) {
    const taskState = b.task ? b.task.state : '-';
    const card = document.createElement('div');
    card.className = 'inst-card';
    card.innerHTML = `
      <div class="card-top">
        <span class="card-name">${esc(b.id)}</span>
        <span class="badge ${b.connectionState}">${connLabel[b.connectionState] || b.connectionState}</span>
      </div>
      <div class="card-meta">${esc(b.username || '')} @ ${esc(b.host || '')}:${b.port || ''} · v${esc(b.config && b.config.version || '-')}</div>
      <div class="card-meta">${b.position ? `位置 (${b.position.x}, ${b.position.y}, ${b.position.z})` : '未知位置'} · 背包空位 ${b.inventoryFreeSlots ?? '-'}</div>
      <div class="card-cmd">任务: <span class="badge ${b.task && b.task.state === 'running' ? 'task' : (b.task && b.task.state === 'paused' ? 'paused' : 'idle')}">${taskState}</span>
        ${b.paused ? '<span class="badge paused">已暂停(溢出)</span>' : ''}
        ${b.autoStore ? '<span class="badge task">自动入库</span>' : ''}</div>
      <div class="card-actions">
        <button class="btn ${b.autoStore ? 'on' : ''}" data-act="store" data-id="${esc(b.id)}">入库 ${b.autoStore ? '开' : '关'}</button>
        <button class="btn btn-accent" data-act="reclassify" data-id="${esc(b.id)}">重分类</button>
        <button class="btn btn-sm" data-act="open" data-id="${esc(b.id)}">详情</button>
      </div>`;
    grid.appendChild(card);
  }
  // 卡片操作绑定
  grid.querySelectorAll('button[data-act]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (btn.dataset.act === 'open') openDetail(id);
      else if (btn.dataset.act === 'store') {
        const b = botOf(id);
        sendCommand(id, 'store', !(b && b.autoStore));
      } else if (btn.dataset.act === 'reclassify') sendCommand(id, 'reclassify');
    };
  });
}

function fillBotSelects() {
  for (const sel of ['map-bot', 'inv-bot', 'chat-bot']) {
    const el = $(sel);
    if (!el) continue;
    const prev = el.value;
    el.innerHTML = state.bots.map(b => `<option value="${esc(b.id)}">${esc(b.id)}</option>`).join('');
    if (prev && state.bots.some(b => b.id === prev)) el.value = prev;
  }
}

/* ================= 实例详情 ================= */
function openDetail(id) {
  state.selectedId = id;
  switchView('instances');
  $('sec-detail').classList.remove('hidden');
  loadConfigEditor();
}

function renderDetail() {
  const b = curBot();
  if (!b) return;
  $('detail-title').textContent = `实例详情 · ${b.id}`;
  // 状态 tab
  const kv = (k, v) => `<div class="k">${k}</div><div class="v">${v}</div>`;
  $('st-basic').innerHTML = kv('连接状态', connLabel[b.connectionState] || b.connectionState)
    + kv('账号', esc(b.username || ''))
    + kv('服务器', `${esc(b.host || '')}:${b.port || ''}`)
    + kv('位置', b.position ? `(${b.position.x}, ${b.position.y}, ${b.position.z})` : '-')
    + kv('背包空位', b.inventoryFreeSlots ?? '-')
    + kv('配置加载', b.configLoaded ? '✓' : '✗')
    + kv('自动入库', b.autoStore ? '开启' : '关闭')
    + kv('全局暂停', b.paused ? '是（溢出箱满等）' : '否');
  const s = b.task && b.task.stats ? b.task.stats : null;
  $('st-task').innerHTML = s
    ? kv('任务状态', b.task.state)
      + kv('当前源箱', s.currentSource ? `(${s.currentSource.x}, ${s.currentSource.y}, ${s.currentSource.z})` : '-')
      + kv('源箱进度', `${s.sourceIndex || 0} / ${s.sourceTotal || 0}`)
      + kv('已处理数量', s.processedCount || 0)
      + kv('源箱剩余', s.currentSourceRemaining ?? '-')
      + kv('完成批次', s.batchIndex || 0)
      + kv('溢出箱新增', Object.entries(s.overflowAdded || {}).filter(([, c]) => c > 0).map(([n, c]) => `${n} x${c}`).join(', ') || '无')
    : '<div class="v" style="grid-column:1/-1;text-align:left">暂无任务</div>';
  const btn = $('btn-store');
  btn.textContent = b.autoStore ? '关闭自动入库' : '开启自动入库';
  btn.classList.toggle('btn-primary', !b.autoStore);
}

function renderDetailTabs() {
  const tab = $('detail-tabs').querySelector('.tab.active').dataset.tab;
  for (const p of ['tab-status', 'tab-config', 'tab-log', 'tab-command']) {
    $(p).classList.toggle('hidden', p !== 'tab-' + tab);
  }
}

/* ---------- 配置编辑 ---------- */
async function loadConfigEditor() {
  const b = curBot();
  if (!b) return;
  try {
    const res = await api(`/api/bots/${encodeURIComponent(b.id)}/settings`);
    if (res.ok && res.bot) {
      const c = res.bot;
      $('cfg-id').value = c.id || '';
      $('cfg-host').value = c.host || '';
      $('cfg-port').value = c.port || 25565;
      $('cfg-username').value = c.username || '';
      $('cfg-auth').value = c.auth || 'offline';
      $('cfg-version').value = c.version || '';
      $('cfg-storage').value = c.storageConfig || '';
      $('cfg-trusted').value = (c.trustedPlayers || []).join(',');
      $('cfg-prefix').value = c.commandPrefix || '!';
      $('cfg-brand').value = c.brand || 'vanilla';
    }
  } catch (e) { /* ignore */ }
  try {
    const r = await api(`/api/bots/${encodeURIComponent(b.id)}/boxes`);
    if (r.raw) {
      state.configRaw = r.raw;
      $('box-editor').value = r.raw;
    }
    if (r.config) {
      renderBoxView(r.config);
      loadVis(r.config);
    }
  } catch (e) { /* ignore */ }
}

/* ---------- 可视化配置（返回点 / 源箱 / 目标箱 / 溢出箱） ---------- */
function loadVis(cfg) {
  // 拆分单箱（point）与对角区域（area）：area 走独立区域列表
  const split = (arr) => {
    const pts = [], areas = [];
    (arr || []).forEach(b => {
      if (!b) return;
      if (b.type === 'area' || (b.min && b.max)) {
        areas.push({ min: b.min, max: b.max, key: b.key });
      } else {
        pts.push({ x: b.x, y: b.y, z: b.z });
      }
    });
    return { pts, areas };
  };
  state.vis = {
    batchSize: cfg.batchSize ?? 64,
    freeSlotThreshold: cfg.freeSlotThreshold ?? 6,
    standby: cfg.standbyPoint ? { x: cfg.standbyPoint.x, y: cfg.standbyPoint.y, z: cfg.standbyPoint.z } : { x: '', y: '', z: '' },
    sources: split(cfg.sourceBoxes),
    targets: (cfg.targetBoxes || []).map(t => ({ x: t.x, y: t.y, z: t.z, category: t.category || '', items: t.items.map(i => i.zhName || i.name).join(',') })),
    overflows: split(cfg.overflowBoxes || (cfg.overflowBox ? [cfg.overflowBox] : []))
  };
  $('vis-batch').value = state.vis.batchSize;
  $('vis-free').value = state.vis.freeSlotThreshold;
  $('vis-spx').value = state.vis.standby.x;
  $('vis-spy').value = state.vis.standby.y;
  $('vis-spz').value = state.vis.standby.z;
  renderVis();
  renderAreas();
}

function renderAreas() {
  if (!state.vis) return;
  const group = (list, label) => list.map((a, i) => `
    <div class="vis-row area-row">
      <span class="vis-idx">${label}</span>
      <span class="area-key mono-input">${esc(a.min.x)},${esc(a.min.y)},${esc(a.min.z)} ~ ${esc(a.max.x)},${esc(a.max.y)},${esc(a.max.z)}</span>
      <button class="btn btn-sm btn-danger area-del" data-kind="${label === '源箱' ? 'source' : 'overflow'}" data-key="${esc(a.key)}">删除</button>
    </div>`).join('');
  const srcs = group(state.vis.sources.areas, '源箱');
  const ovfs = group(state.vis.overflows.areas, '溢出箱');
  $('vis-areas').innerHTML = (srcs || ovfs)
    ? `<div class="panel-title" style="margin-top:6px">已配置区域（即时生效）</div>${srcs}${ovfs}`
    : '<div class="panel-hint">暂无区域，用上方「对角区域框选」添加</div>';
  document.querySelectorAll('.area-del').forEach(btn => {
    btn.onclick = async () => {
      const r = await api(`/api/bots/${encodeURIComponent((curBot() ? curBot().id : ''))}/boxes/delete`, {
        method: 'POST',
        body: JSON.stringify({ key: btn.dataset.key })
      });
      showAreaResult(r.ok, r.message);
      if (r.ok) loadConfigEditor();
    };
  });
}

function showAreaResult(ok, msg) {
  const el = $('area-result');
  el.textContent = msg || '';
  el.style.color = ok ? '#22c55e' : '#ef4444';
}

function areaType() {
  const el = document.querySelector('input[name="area-type"]:checked');
  return el ? el.value : 'source';
}

function readAreaCorners() {
  const nums = [ar1x, ar1y, ar1z, ar2x, ar2y, ar2z].map(id => Number($(id).value));
  if (!nums.every(n => Number.isFinite(n))) return null;
  return {
    corner1: { x: nums[0], y: nums[1], z: nums[2] },
    corner2: { x: nums[3], y: nums[4], z: nums[5] }
  };
}

function bindAreaOps() {
  $('area-scan').onclick = async () => {
    const c = readAreaCorners();
    if (!c) { showAreaResult(false, '请先填写两个对角坐标（x/y/z）'); return; }
    const r = await api(`/api/bots/${encodeURIComponent((curBot() ? curBot().id : ''))}/boxes/scan`, {
      method: 'POST',
      body: JSON.stringify(c)
    });
    if (!r.ok) { showAreaResult(false, r.message); return; }
    showAreaResult(true, `区域内发现 ${r.count} 个箱子`);
    $('area-preview').innerHTML = r.boxes.length
      ? `<div class="area-preview-list">${r.boxes.map(b => `<span class="chip">${b.x},${b.y},${b.z}</span>`).join('')}</div>`
      : '<div class="panel-hint">区域内没有发现箱子（确认 bot 在线且该区域区块已加载）</div>';
  };
  $('area-add').onclick = async () => {
    const c = readAreaCorners();
    if (!c) { showAreaResult(false, '请先填写两个对角坐标（x/y/z）'); return; }
    const entry = {
      min: {
        x: Math.min(c.corner1.x, c.corner2.x), y: Math.min(c.corner1.y, c.corner2.y), z: Math.min(c.corner1.z, c.corner2.z)
      },
      max: {
        x: Math.max(c.corner1.x, c.corner2.x), y: Math.max(c.corner1.y, c.corner2.y), z: Math.max(c.corner1.z, c.corner2.z)
      }
    };
    const r = await api(`/api/bots/${encodeURIComponent((curBot() ? curBot().id : ''))}/boxes/area`, {
      method: 'POST',
      body: JSON.stringify({ type: areaType(), entry })
    });
    showAreaResult(r.ok, r.message);
    if (r.ok) {
      $('area-preview').innerHTML = '';
      loadConfigEditor();
    }
  };
}

function renderVis() {
  if (!state.vis) return;
  const row = (i, cls, inner, del) => `
    <div class="vis-row" data-i="${i}">
      <span class="vis-idx">${i + 1}</span>${inner}
      <button class="btn btn-sm btn-danger vis-del" data-cls="${cls}" data-i="${i}">删除</button>
    </div>`;
  const box3 = (i, prefix, v) => `
    <input class="input mono-input vis-input vis-x" data-p="${prefix}" data-i="${i}" placeholder="x" value="${esc(v.x)}">
    <input class="input mono-input vis-input vis-y" data-p="${prefix}" data-i="${i}" placeholder="y" value="${esc(v.y)}">
    <input class="input mono-input vis-input vis-z" data-p="${prefix}" data-i="${i}" placeholder="z" value="${esc(v.z)}">`;

  $('vis-srcs').innerHTML = state.vis.sources.pts.map((v, i) => row(i, 'sources', box3(i, 'sources', v), '源箱')).join('')
    || '<div class="panel-hint">暂无源箱</div>';
  $('vis-tgts').innerHTML = state.vis.targets.map((t, i) => row(i, 'targets', `
      ${box3(i, 'targets', t)}
      <input class="input mono-input vis-input vis-cat" data-i="${i}" placeholder="分类名（如 钻石）" value="${esc(t.category)}">
      <input class="input mono-input vis-input vis-items" data-i="${i}" placeholder="物品（逗号分隔，如 钻石,diamond,264）" value="${esc(t.items)}">`, '目标箱')).join('')
    || '<div class="panel-hint">暂无目标箱</div>';
  $('vis-ovfs').innerHTML = state.vis.overflows.pts.map((v, i) => row(i, 'overflows', box3(i, 'overflows', v), '溢出箱')).join('')
    || '<div class="panel-hint">暂无溢出箱</div>';

  // 行内输入同步到 state（删除/保存时读取）
  document.querySelectorAll('.vis-input').forEach(inp => {
    inp.oninput = () => syncVisRow();
  });
  document.querySelectorAll('.vis-del').forEach(btn => {
    btn.onclick = () => {
      const cls = btn.dataset.cls;
      state.vis[cls].pts.splice(Number(btn.dataset.i), 1);
      renderVis();
    };
  });
}

function syncVisRow() {
  state.vis.standby.x = $('vis-spx').value;
  state.vis.standby.y = $('vis-spy').value;
  state.vis.standby.z = $('vis-spz').value;
  state.vis.sources.pts.forEach((v, i) => {
    const x = document.querySelector(`.vis-x[data-p="sources"][data-i="${i}"]`);
    if (x) { v.x = x.value; }
    const y = document.querySelector(`.vis-y[data-p="sources"][data-i="${i}"]`);
    if (y) { v.y = y.value; }
    const z = document.querySelector(`.vis-z[data-p="sources"][data-i="${i}"]`);
    if (z) { v.z = z.value; }
  });
  state.vis.targets.forEach((t, i) => {
    const x = document.querySelector(`.vis-x[data-p="targets"][data-i="${i}"]`);
    if (x) { t.x = x.value; }
    const y = document.querySelector(`.vis-y[data-p="targets"][data-i="${i}"]`);
    if (y) { t.y = y.value; }
    const z = document.querySelector(`.vis-z[data-p="targets"][data-i="${i}"]`);
    if (z) { t.z = z.value; }
    const cat = document.querySelector(`.vis-cat[data-i="${i}"]`);
    if (cat) { t.category = cat.value; }
    const items = document.querySelector(`.vis-items[data-i="${i}"]`);
    if (items) { t.items = items.value; }
  });
  state.vis.overflows.pts.forEach((v, i) => {
    const x = document.querySelector(`.vis-x[data-p="overflows"][data-i="${i}"]`);
    if (x) { v.x = x.value; }
    const y = document.querySelector(`.vis-y[data-p="overflows"][data-i="${i}"]`);
    if (y) { v.y = y.value; }
    const z = document.querySelector(`.vis-z[data-p="overflows"][data-i="${i}"]`);
    if (z) { v.z = z.value; }
  });
}

function collectVis() {
  syncVisRow();
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const spx = String(state.vis.standby.x || '').trim();
  // 合并当前 raw JSON 中不被表单覆盖的字段（如 zhNameMap）
  let extra = {};
  try { extra = JSON.parse(state.configRaw || '{}'); } catch (e) { /* ignore */ }
  return {
    batchSize: Number($('vis-batch').value) || 64,
    freeSlotThreshold: Number($('vis-free').value) || 6,
    standbyPoint: spx ? { x: num(state.vis.standby.x), y: num(state.vis.standby.y), z: num(state.vis.standby.z) } : null,
    sourceBoxes: [
      ...state.vis.sources.pts.map(v => ({ x: num(v.x), y: num(v.y), z: num(v.z) })).filter(v => v.x || v.y || v.z),
      ...state.vis.sources.areas.map(a => ({ min: a.min, max: a.max }))
    ],
    targetBoxes: state.vis.targets.map(t => ({
      x: num(t.x), y: num(t.y), z: num(t.z),
      category: String(t.category || '').trim(),
      items: String(t.items || '').split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean)
    })).filter(t => (t.x || t.y || t.z) && t.items.length),
    overflowBoxes: [
      ...state.vis.overflows.pts.map(v => ({ x: num(v.x), y: num(v.y), z: num(v.z) })).filter(v => v.x || v.y || v.z),
      ...state.vis.overflows.areas.map(a => ({ min: a.min, max: a.max }))
    ],
    sourceCheckInterval: extra.sourceCheckInterval ?? 120,
    zhNameMap: extra.zhNameMap || {}
  };
}

function collectBotConfig() {
  return {
    host: $('cfg-host').value.trim(),
    port: Number($('cfg-port').value) || 25565,
    username: $('cfg-username').value.trim(),
    auth: $('cfg-auth').value,
    version: $('cfg-version').value.trim(),
    storageConfig: $('cfg-storage').value.trim(),
    trustedPlayers: $('cfg-trusted').value.split(/[,，\s]+/).filter(Boolean),
    commandPrefix: $('cfg-prefix').value.trim() || '!',
    brand: $('cfg-brand').value.trim() || 'vanilla'
  };
}

async function saveBotConfig(andRestart) {
  const b = curBot();
  if (!b) return;
  const res = await api(`/api/bots/${encodeURIComponent(b.id)}/settings`, {
    method: 'PUT', body: JSON.stringify(collectBotConfig())
  });
  showResult('cfg-result', res.message, res.ok);
  if (res.ok && andRestart) {
    await api(`/api/bots/${encodeURIComponent(b.id)}/restart`, { method: 'POST' });
    showResult('cfg-result', '配置已保存并请求重启', true);
  }
}

function renderBoxView(cfg) {
  const rows = [];
  for (const sb of cfg.sourceBoxes || []) {
    rows.push(`<tr><td><span class="badge idle">源箱</span></td><td class="mono">(${sb.x}, ${sb.y}, ${sb.z})</td><td colspan="2">杂乱物品来源（分批取出）</td></tr>`);
  }
  for (const tb of cfg.targetBoxes || []) {
    const items = tb.items.map(it => it.zhName || it.name).join('、');
    rows.push(`<tr><td><span class="badge task">目标箱</span></td><td class="mono">(${tb.x}, ${tb.y}, ${tb.z})</td><td>${esc(tb.category)}</td><td>${esc(items)}</td></tr>`);
  }
  if (cfg.overflowBoxes && cfg.overflowBoxes.length) {
    for (const ob of cfg.overflowBoxes) {
      rows.push(`<tr><td><span class="badge paused">溢出箱</span></td><td class="mono">(${ob.x}, ${ob.y}, ${ob.z})</td><td colspan="2">无匹配分类 / 目标箱已满</td></tr>`);
    }
  }
  $('box-view').innerHTML = `
    <div class="table-wrap"><table class="v3-table">
      <thead><tr><th>类型</th><th>坐标</th><th>分类</th><th>允许物品</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
}

/* ================= 仓库地图 ================= */
function renderMap() {
  const id = $('map-bot').value || (state.bots[0] && state.bots[0].id);
  const b = botOf(id);
  if (!b) { $('map-canvas-wrap').innerHTML = '<div class="empty-state">无实例</div>'; return; }
  $('map-hint').textContent = b.configLoaded ? '箱子内容来自最近一次盘点（开箱识别）' : '该实例配置未加载';
  api(`/api/bots/${encodeURIComponent(id)}/boxes`).then(r => {
    if (!r.config) { $('map-canvas-wrap').innerHTML = '<div class="empty-state">配置未加载</div>'; return; }
    const audit = state.audit && state.audit.botId === id ? state.audit : null;
    drawMap(r.config, audit, id);
  }).catch(() => {
    $('map-canvas-wrap').innerHTML = '<div class="empty-state">加载失败</div>';
  });
}

function drawMap(cfg, audit, botId) {
  const points = [];
  const add = (p, type, label) => points.push({ ...p, type, label });
  for (const s of cfg.sourceBoxes || []) add(s, 'source', '源箱');
  for (const t of cfg.targetBoxes || []) add(t, 'target', t.category || '目标箱');
  for (const ob of (cfg.overflowBoxes || (cfg.overflowBox ? [cfg.overflowBox] : []))) add(ob, 'overflow', '溢出箱');
  if (!points.length) { $('map-canvas-wrap').innerHTML = '<div class="empty-state">无可绘制坐标</div>'; return; }

  const xs = points.map(p => p.x), zs = points.map(p => p.z);
  let minX = Math.min(...xs) - 3, maxX = Math.max(...xs) + 3;
  let minZ = Math.min(...zs) - 3, maxZ = Math.max(...zs) + 3;
  // 扫描区域扩展
  const areas = (state.settings && state.settings.scanAreas) || [];
  for (const a of areas) {
    minX = Math.min(minX, a.min.x - 3); maxX = Math.max(maxX, a.max.x + 3);
    minZ = Math.min(minZ, a.min.z - 3); maxZ = Math.max(maxZ, a.max.z + 3);
  }
  const W = 820, H = 560, pad = 40;
  const sx = (W - pad * 2) / (maxX - minX || 1);
  const sz = (H - pad * 2) / (maxZ - minZ || 1);
  const X = (x) => pad + (x - minX) * sx;
  const Z = (z) => pad + (z - minZ) * sz;

  // 容器方块类型 -> 贴图（盘点结果 blockType；未盘点默认 chest）
  const textureOf = (name) => {
    if (!name) return 'chest.png';
    if (name.includes('barrel')) return 'barrel_top.png';
    if (name.includes('shulker')) return 'shulker_box.png';
    if (name.includes('hopper')) return 'hopper_top.png';
    if (name.includes('dispenser')) return 'dispenser_front.png';
    if (name.includes('dropper')) return 'dropper_front.png';
    if (name.includes('trapped_chest')) return 'trapped_chest.png';
    return 'chest.png';
  };
  const typeName = (name) => {
    if (!name) return '箱子';
    if (name.includes('barrel')) return '木桶';
    if (name.includes('shulker')) return '潜影盒';
    if (name.includes('hopper')) return '漏斗';
    if (name.includes('dispenser')) return '发射器';
    if (name.includes('dropper')) return '投掷器';
    if (name.includes('trapped_chest')) return '陷阱箱';
    return '箱子';
  };
  const auditByKey = {};
  if (audit) for (const bx of audit.boxes || []) auditByKey[bx.key] = bx;

  // 同 XZ 不同 Y 的箱子分组（竖叠时错开显示，避免完全重叠）
  const groups = new Map(); // "x,z" -> [points]
  for (const p of points) {
    const k = `${p.x},${p.z}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const CELL = 40; // 每格尺寸
  const STACK_GAP = 15; // 同格内每层错开量

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;background:#120c14;border-radius:14px;border:1px solid #3b273f">`;
  // 网格
  svg += `<defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#241826" stroke-width="1"/></pattern></defs>`;
  svg += `<rect width="${W}" height="${H}" fill="url(#grid)"/>`;
  // 扫描区域
  for (const a of areas) {
    svg += `<rect x="${X(a.min.x)}" y="${Z(a.min.z)}" width="${(a.max.x - a.min.x + 1) * sx}" height="${(a.max.z - a.min.z + 1) * sz}"
      fill="rgba(255,143,192,0.06)" stroke="rgba(255,143,192,0.5)" stroke-dasharray="6 4" rx="8"/>`;
    svg += `<text x="${X(a.min.x) + 8}" y="${Z(a.min.z) + 18}" fill="#ff8fc0" font-size="12">${esc(a.name)}</text>`;
  }
  // 容器（贴图 + 同格错开）
  const ring = { source: '#ffd9a0', target: '#ff8fc0', overflow: '#7fd4ff' };
  for (const [k, pts] of groups) {
    const [gx, gz] = k.split(',').map(Number);
    const cx = X(gx), cy = Z(gz);
    // 同格多个箱子按 y 升序错开
    const sorted = [...pts].sort((a, b) => (a.y || 0) - (b.y || 0));
    sorted.forEach((p, i) => {
      const tip = auditByKey[p.key];
      const blk = tip && tip.blockType ? tip.blockType : null;
      const img = textureOf(blk);
      const off = i * STACK_GAP;
      const size = CELL - 6;
      const content = tip && tip.items && tip.items.length
        ? tip.items.slice(0, 3).map(it => `${it.zhName || it.name} x${it.count}`).join('\n') + (tip.items.length > 3 ? `\n…共 ${tip.items.length} 种` : '')
        : (tip && tip.error ? `识别失败: ${tip.error}` : '未盘点');
      const label = `${typeName(blk)} ${p.label} (${p.x}, ${p.y}, ${p.z})`;
      svg += `
      <g>
        <rect x="${cx - size / 2}" y="${cy - size / 2 + off}" width="${size}" height="${size}" rx="7"
          fill="${ring[p.type]}" fill-opacity="0.14" stroke="${ring[p.type]}" stroke-width="1.5"/>
        <image href="/textures/${img}" x="${cx - size / 2 + 4}" y="${cy - size / 2 + 4 + off}" width="${size - 8}" height="${size - 8}"
          preserveAspectRatio="xMidYMid meet"/>
        <title>${esc(label)}\n${esc(content)}</title>
      </g>`;
    });
    // 坐标标注（格下方）
    svg += `<text x="${cx}" y="${cy + CELL / 2 + 14 + (sorted.length - 1) * STACK_GAP}" text-anchor="middle" fill="#b89dad" font-size="10" font-family="monospace">${gx},${gz}${sorted.length > 1 ? ` ×${sorted.length}` : ''}</text>`;
  }
  svg += `<text x="14" y="${H - 12}" fill="#6b5570" font-size="11">容器按 MC 方块贴图绘制（悬停查看内容）· 同格竖叠自动错开 · 盘点数据来自开箱识别</text>`;
  svg += '</svg>';
  $('map-canvas-wrap').innerHTML = svg;
}

/* ================= 任务列表 ================= */
async function loadTasks() {
  const r = await api('/api/tasks');
  const tbody = $('tasks-table').querySelector('tbody');
  if (!r.tasks || !r.tasks.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:#b89dad">暂无任务记录</td></tr>';
    return;
  }
  tbody.innerHTML = r.tasks.map(t => {
    const st = t.current ? '运行中' : { finished: '完成', paused: '已暂停', idle: '已取消', error: '异常' }[t.state] || t.state;
    const ov = Object.entries(t.overflowAdded || {}).filter(([, c]) => c > 0).map(([n, c]) => `${n} x${c}`).join(', ') || '-';
    return `<tr>
      <td class="mono">${fmtDate(t.startedAt || Date.now())}</td>
      <td>${esc(t.botId)}</td>
      <td>${t.type === 'reclassify' ? '批量重分类' : esc(t.type)}</td>
      <td>${t.current ? '<span class="badge task">运行中</span>' : esc(st)}</td>
      <td class="mono">${t.processedCount || 0}</td>
      <td class="mono">${t.sourceTotal ?? '-'}</td>
      <td>${esc(ov)}</td>
    </tr>`;
  }).join('');
}

/* ================= 库存盘点 ================= */
async function loadAudit() {
  const id = $('inv-bot').value || (state.bots[0] && state.bots[0].id);
  if (!id) { $('inv-view').innerHTML = '<div class="empty-state">无实例</div>'; return; }
  const r = await api(`/api/bots/${encodeURIComponent(id)}/audit`);
  state.audit = r.audit;
  renderAudit();
}

function renderAudit() {
  const a = state.audit;
  if (!a) { $('inv-view').innerHTML = '<div class="empty-state">尚未盘点。选择实例后点击「开始盘点（开箱识别）」，bot 将逐个打开源箱 / 目标箱 / 溢出箱统计物品。</div>'; return; }
  let html = `<div class="panel-hint">盘点时间：${fmtDate(a.startedAt)}${a.finishedAt ? ' → ' + fmtDate(a.finishedAt) : ''} · 共 ${a.boxes.length} 个箱子</div>`;
  // 全局总和
  if (a.summary) {
    const top = a.summary.items.slice(0, 25);
    const more = a.summary.items.length - top.length;
    html += `<div class="panel-box" style="margin-bottom:12px;border-color:#57364f">
      <div class="panel-title">全部箱子总和：${a.summary.totalCount} 件 / ${a.summary.totalKinds} 种</div>
      <div>${top.map(i => `<span class="badge task" style="margin:2px">${esc(i.zhName || i.name)} x${i.count}</span>`).join('')}${more > 0 ? `<span class="muted"> …共 ${more} 种未显示</span>` : ''}</div>
    </div>`;
  }
  // 每个箱子汇总
  for (const box of a.boxes) {
    const items = box.items && box.items.length
      ? box.items.map(i => `<span class="badge idle" style="margin:2px">${esc(i.zhName || i.name)} x${i.count}</span>`).join('')
      : (box.error ? `<span class="badge paused">${esc(box.error)}</span>` : '<span class="badge idle">空</span>');
    html += `<div class="panel-box" style="margin-bottom:10px">
      <div class="panel-title">${esc(box.category)} · (${box.x}, ${box.y}, ${box.z}) · <span class="accent">${box.totalCount} 件 / ${box.totalKinds} 种</span></div>
      <div>${items}</div>
    </div>`;
  }
  $('inv-view').innerHTML = html;
}

/* ================= 聊天与指令控制台 ================= */
function appendChat(chat) {
  state.chatLog.push(chat);
  if (state.chatLog.length > 300) state.chatLog.shift();
  const box = $('chat-box');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="time">${fmtTime(chat.ts)}</span><span class="bot">${esc(chat.botId)}</span><span class="msg">&lt;${esc(chat.username)}&gt; ${esc(chat.message)}</span>`;
  box.appendChild(line);
  while (box.children.length > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function sendChatCommand() {
  const id = $('chat-bot').value;
  const text = $('chat-input').value.trim();
  if (!id || !text) return;
  const isChat = text.startsWith('/');
  if (isChat) {
    // 游戏聊天：走指令通道发给 bot？聊天需 bot.chat —— 通过扩展指令实现
    sendCommand(id, 'chat', text);
    $('chat-input').value = '';
    return;
  }
  const [cmd, ...rest] = text.split(/\s+/);
  sendCommand(id, cmd, rest.join(' ').trim() || true);
  $('chat-input').value = '';
}

/* ================= 配置总览 ================= */
async function loadConfigs() {
  const wrap = $('configs-view');
  let html = '';
  for (const b of state.bots) {
    const r = await api(`/api/bots/${encodeURIComponent(b.id)}/config`);
    if (!r.config) {
      html += `<div class="panel-box" style="margin-bottom:12px"><div class="panel-title">${esc(b.id)}</div><div class="muted">配置未加载</div></div>`;
      continue;
    }
    const c = r.config;
    const rows = [];
    for (const sb of c.sourceBoxes || []) rows.push(`<tr><td>源箱</td><td class="mono">(${sb.x}, ${sb.y}, ${sb.z})</td><td>杂乱物品来源</td></tr>`);
    for (const tb of c.targetBoxes || []) {
      rows.push(`<tr><td>目标箱</td><td class="mono">(${tb.x}, ${tb.y}, ${tb.z})</td><td>${esc(tb.category)}</td></tr>`);
    }
    if (c.overflowBoxes && c.overflowBoxes.length) {
      for (const ob of c.overflowBoxes) {
        rows.push(`<tr><td>溢出箱</td><td class="mono">(${ob.x}, ${ob.y}, ${ob.z})</td><td>无匹配 / 已满</td></tr>`);
      }
    }
    html += `<div class="panel-box" style="margin-bottom:12px">
      <div class="panel-title">${esc(b.id)} · batch=${c.batchSize} · 空位阈值=${c.freeSlotThreshold}</div>
      <div class="table-wrap"><table class="v3-table"><thead><tr><th>类型</th><th>坐标</th><th>分类</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    </div>`;
  }
  wrap.innerHTML = html || '<div class="empty-state">无实例</div>';
}

/* ================= 系统设置 ================= */
async function loadSettings() {
  const r = await api('/api/settings');
  if (!r.settings) return;
  state.settings = r.settings;
  const s = r.settings;
  $('set-host').value = s.server.host || '';
  $('set-port').value = s.server.port || 25565;
  $('set-username').value = s.server.username || '';
  $('set-auth').value = s.server.auth || 'offline';
  $('set-version').value = s.server.version || '';
  $('set-ai-enabled').value = String(!!s.ai.enabled);
  $('set-ai-key').value = s.ai.apiKey || '';
  $('set-ai-base').value = s.ai.baseUrl || '';
  $('set-ai-model').value = s.ai.model || '';
  $('set-batch').value = s.behavior.batchSize ?? 64;
  $('set-free').value = s.behavior.freeSlotThreshold ?? 6;
  $('set-autostore').value = String(!!s.behavior.autoStoreOnStart);
  renderAreas();
}

function renderAreas() {
  const areas = (state.settings && state.settings.scanAreas) || [];
  const wrap = $('set-areas');
  wrap.innerHTML = areas.map((a, i) => `
    <div class="config-form" style="margin-bottom:10px">
      <label class="form-label">区域名称<input class="input mono-input area-name" value="${esc(a.name || '')}" data-i="${i}"></label>
      <label class="form-label">min (x, y, z)<input class="input mono-input area-min" value="${a.min.x},${a.min.y},${a.min.z}" data-i="${i}"></label>
      <label class="form-label">max (x, y, z)<input class="input mono-input area-max" value="${a.max.x},${a.max.y},${a.max.z}" data-i="${i}"></label>
      <div class="form-label" style="display:flex;align-items:flex-end">
        <button class="btn btn-sm btn-danger area-del" data-i="${i}">删除</button>
      </div>
    </div>`).join('') || '<div class="panel-hint">暂无扫描区域</div>';
  wrap.querySelectorAll('.area-del').forEach(btn => {
    btn.onclick = () => {
      state.settings.scanAreas.splice(Number(btn.dataset.i), 1);
      renderAreas();
    };
  });
}

function collectSettings() {
  const areas = (state.settings && state.settings.scanAreas) || [];
  const readVec = (v) => {
    const [x, y, z] = String(v || '').split(/[,，\s]+/).map(Number);
    return { x: Number(x) || 0, y: Number(y) || 0, z: Number(z) || 0 };
  };
  document.querySelectorAll('.area-name').forEach((el, i) => { areas[i].name = el.value; });
  document.querySelectorAll('.area-min').forEach((el, i) => { areas[i].min = readVec(el.value); });
  document.querySelectorAll('.area-max').forEach((el, i) => { areas[i].max = readVec(el.value); });
  return {
    server: {
      host: $('set-host').value.trim(),
      port: Number($('set-port').value) || 25565,
      username: $('set-username').value.trim(),
      auth: $('set-auth').value,
      version: $('set-version').value.trim()
    },
    ai: {
      enabled: $('set-ai-enabled').value === 'true',
      apiKey: $('set-ai-key').value.trim(),
      baseUrl: $('set-ai-base').value.trim(),
      model: $('set-ai-model').value.trim()
    },
    behavior: {
      batchSize: Number($('set-batch').value) || 64,
      freeSlotThreshold: Number($('set-free').value) || 6,
      autoStoreOnStart: $('set-autostore').value === 'true'
    },
    scanAreas: areas
  };
}

/* ================= 日志 ================= */
function appendLog(entry) {
  const lineHtml = `<span class="time">${fmtTime(entry.ts)}</span><span class="bot">${esc(entry.botId)}</span><span class="lv lv-${entry.level}">[${entry.level.toUpperCase()}]</span><span class="msg">${esc(entry.message)}</span>`;
  // 详情日志（若属于当前选中 bot）
  const b = curBot();
  if (b && entry.botId === b.id) {
    const box = $('log-box');
    if (box) {
      const div = document.createElement('div');
      div.className = 'log-line';
      div.innerHTML = lineHtml;
      box.appendChild(div);
      while (box.children.length > 500) box.removeChild(box.firstChild);
      if ($('chk-auto').checked) box.scrollTop = box.scrollHeight;
    }
  }
  // 全局日志
  const all = $('log-box-all');
  if (all) {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.innerHTML = lineHtml;
    all.appendChild(div);
    while (all.children.length > 800) all.removeChild(all.firstChild);
    if ($('chk-auto-all').checked) all.scrollTop = all.scrollHeight;
  }
}

/* ================= 结果提示 ================= */
function showResult(id, message, ok) {
  const el = $(id);
  if (!el) return;
  el.textContent = (ok ? '✔ ' : '✘ ') + (message || '');
  el.className = 'command-result ' + (ok ? 'ok' : 'err');
}

/* ================= 事件绑定 ================= */
function bindEvents() {
  // 导航
  document.querySelectorAll('.main-tab').forEach(btn => {
    btn.onclick = () => switchView(btn.dataset.view);
  });

  // 实例工具栏
  $('btn-refresh').onclick = () => { state.bots = []; connectWs(); };
  $('btn-start-all').onclick = () => state.bots.forEach(b => sendCommand(b.id, 'store', true));
  $('btn-stop-all').onclick = () => state.bots.forEach(b => sendCommand(b.id, 'store', false));
  $('btn-add-bot').onclick = () => $('add-overlay').classList.remove('hidden');
  $('add-cancel').onclick = () => $('add-overlay').classList.add('hidden');
  $('add-ok').onclick = async () => {
    const body = {
      id: $('add-id').value.trim(),
      host: $('add-host').value.trim(),
      port: Number($('add-port').value) || 25565,
      username: $('add-username').value.trim(),
      auth: $('add-auth').value,
      version: $('add-version').value.trim() || '1.21.1',
      trustedPlayers: $('add-trusted').value.split(/[,，\s]+/).filter(Boolean)
    };
    const r = await api('/api/bots', { method: 'POST', body: JSON.stringify(body) });
    showResult('selected-count', r.message, r.ok);
    if (r.ok) { $('add-overlay').classList.add('hidden'); setTimeout(() => $('btn-refresh').click(), 800); }
  };

  // 详情
  $('btn-back').onclick = () => { state.selectedId = null; switchView('instances'); };
  $('detail-tabs').querySelectorAll('.tab').forEach(t => {
    t.onclick = () => {
      $('detail-tabs').querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      renderDetailTabs();
    };
  });
  $('btn-store').onclick = () => { const b = curBot(); if (b) sendCommand(b.id, 'store', !b.autoStore); };
  $('btn-reclassify').onclick = () => { const b = curBot(); if (b) sendCommand(b.id, 'reclassify'); };
  $('btn-pause').onclick = () => { const b = curBot(); if (b) sendCommand(b.id, 'pause'); };
  $('btn-resume').onclick = () => { const b = curBot(); if (b) sendCommand(b.id, 'resume'); };
  $('btn-stop-task').onclick = () => { const b = curBot(); if (b) sendCommand(b.id, 'stop'); };
  $('btn-reload').onclick = async () => { const b = curBot(); if (!b) return; sendCommand(b.id, 'reload'); setTimeout(loadConfigEditor, 600); };
  $('btn-restart').onclick = async () => { const b = curBot(); if (!b) return; const r = await api(`/api/bots/${encodeURIComponent(b.id)}/restart`, { method: 'POST' }); showResult('st-result', r.message, r.ok); };

  // 配置 tab
  $('cfg-save').onclick = () => saveBotConfig(false);
  $('cfg-restart').onclick = () => saveBotConfig(true);
  $('box-reload').onclick = () => loadConfigEditor();
  $('box-save').onclick = async () => {
    const b = curBot(); if (!b) return;
    const res = await api(`/api/bots/${encodeURIComponent(b.id)}/boxes`, { method: 'PUT', body: JSON.stringify({ raw: $('box-editor').value }) });
    showResult('box-result', res.message, res.ok);
    if (res.ok) { if (res.config) renderBoxView(res.config); setTimeout(loadConfigEditor, 400); }
  };

  // 可视化配置
  $('vis-add-src').onclick = () => { if (!state.vis) return; state.vis.sources.pts.push({ x: '', y: '', z: '' }); renderVis(); };
  $('vis-add-tgt').onclick = () => { if (!state.vis) return; state.vis.targets.push({ x: '', y: '', z: '', category: '', items: '' }); renderVis(); };
  $('vis-add-ovf').onclick = () => { if (!state.vis) return; state.vis.overflows.pts.push({ x: '', y: '', z: '' }); renderVis(); };
  bindAreaOps();
  $('vis-save').onclick = async () => {
    const b = curBot(); if (!b) return;
    const cfg = collectVis();
    if (!cfg.targetBoxes.length || !cfg.overflowBoxes.length) {
      showResult('vis-result', '至少需要 1 个目标箱和 1 个溢出箱', false);
      return;
    }
    const res = await api(`/api/bots/${encodeURIComponent(b.id)}/boxes`, { method: 'PUT', body: JSON.stringify(cfg) });
    showResult('vis-result', res.message, res.ok);
    if (res.ok) {
      if (res.config) { renderBoxView(res.config); loadVis(res.config); }
      setTimeout(loadConfigEditor, 400);
    }
  };

  // 指令 tab
  $('command-form').onsubmit = (e) => {
    e.preventDefault();
    const b = curBot(); if (!b) return;
    const text = $('command-input').value.trim(); if (!text) return;
    const [cmd, ...rest] = text.split(/\s+/);
    sendCommand(b.id, cmd, rest.join(' ').trim() || true);
    $('command-input').value = '';
    const hist = $('command-history');
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="time">${fmtTime(Date.now())}</span> ${esc(text)} <span class="out">→ ${esc(b.id)}</span>`;
    hist.prepend(row);
    while (hist.children.length > 50) hist.removeChild(hist.lastChild);
  };
  document.querySelectorAll('[data-cmd]').forEach(btn => {
    btn.onclick = () => {
      const b = curBot(); if (!b) return;
      const [cmd, ...rest] = btn.dataset.cmd.split(/\s+/);
      sendCommand(b.id, cmd, rest.length ? rest.join(' ') : true);
    };
  });

  // 地图
  $('map-bot').onchange = () => renderMap();
  $('map-refresh').onclick = () => renderMap();

  // 任务
  $('tasks-refresh').onclick = () => loadTasks();

  // 盘点
  $('inv-bot').onchange = () => loadAudit();
  $('inv-refresh').onclick = () => loadAudit();
  $('inv-audit').onclick = async () => {
    const id = $('inv-bot').value; if (!id) return;
    showResult('inv-result', '盘点中（开箱识别）...', true);
    const r = await api(`/api/bots/${encodeURIComponent(id)}/audit`, { method: 'POST' });
    showResult('inv-result', r.message, r.ok);
    if (r.audit) { state.audit = r.audit; renderAudit(); }
  };

  // 聊天控制台
  $('chat-form').onsubmit = (e) => { e.preventDefault(); sendChatCommand(); };
  document.querySelectorAll('[data-chat-cmd]').forEach(btn => {
    btn.onclick = () => {
      const id = $('chat-bot').value; if (!id) return;
      const [cmd, ...rest] = btn.dataset.chatCmd.split(/\s+/);
      sendCommand(id, cmd, rest.length ? rest.join(' ') : true);
    };
  });

  // 配置总览
  $('btn-clear-log').onclick = () => { $('log-box').innerHTML = ''; };
  $('btn-clear-log-all').onclick = () => { $('log-box-all').innerHTML = ''; };

  // 系统设置
  $('set-area-add').onclick = () => {
    if (!state.settings) state.settings = { scanAreas: [] };
    state.settings.scanAreas.push({ name: '新区域', min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } });
    renderAreas();
  };
  $('set-save').onclick = async () => {
    const r = await api('/api/settings', { method: 'PUT', body: JSON.stringify(collectSettings()) });
    showResult('set-result', r.message, r.ok);
    if (r.ok) loadSettings();
  };
  $('set-apply-server').onclick = async () => {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(collectSettings()) });
    const r = await api('/api/settings/apply-server', { method: 'POST' });
    showResult('set-result', r.message, r.ok);
  };
}

/* ================= 启动 ================= */
bindEvents();
connectWs();
