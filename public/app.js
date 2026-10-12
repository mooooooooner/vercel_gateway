const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const state = {
  token: localStorage.getItem('adminToken') || '',
  keys: [],
  pkeys: [],
  meta: {},
  settings: { strategy: 'round-robin', modelParams: {} },
  paramCards: [],
  imageHistory: [],
  latestImage: null,
};

const PARAM_PRESETS = [
  { key: 'providerOptions', type: 'json', value: '{\n  "gateway": { "only": ["xai"] }\n}' },
  { key: 'temperature', type: 'number', value: '0.7' },
  { key: 'max_tokens', type: 'number', value: '1024' },
];

function newField(preset = {}) {
  return {
    id: Math.random().toString(36).slice(2, 8),
    key: preset.key || '',
    type: preset.type || 'string',
    value: preset.value ?? '',
  };
}

function newCard(model = '', params = {}, enabled = true) {
  const fields = Object.entries(params).map(([key, value]) => {
    if (value !== null && typeof value === 'object') {
      return newField({ key, type: 'json', value: JSON.stringify(value, null, 2) });
    }
    if (typeof value === 'number') return newField({ key, type: 'number', value: String(value) });
    if (typeof value === 'boolean') return newField({ key, type: 'boolean', value: String(value) });
    return newField({ key, type: 'string', value: value == null ? '' : String(value) });
  });
  return { id: Math.random().toString(36).slice(2, 8), model, enabled, fields };
}

// ---------- HTTP ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['x-admin-token'] = state.token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    toast('管理令牌无效或缺失，请点击右上角设置', 'err');
    openModal('modal-token');
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

// ---------- UI helpers ----------
let toastTimer;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}
function openModal(id) { $('#' + id).hidden = false; }
function closeModal(id) { $('#' + id).hidden = true; }
$$('[data-close]').forEach((b) => b.addEventListener('click', (e) => e.target.closest('.modal').hidden = true));
$$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));

function fmtMoney(v) { return v === null || v === undefined ? '—' : '$' + Number(v).toFixed(4); }
function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
const STATUS_LABEL = { ok: '正常', low: '额度不足', invalid: '失效', error: '异常', unknown: '未检查' };

// ---------- render ----------
function renderStats(s) {
  $('#stats').innerHTML = [
    ['Key 总数', s.total],
    ['可用', s.usable],
    ['总余额', `<small>$</small>${s.totalBalance.toFixed(2)}`],
    ['累计花费', `<small>$</small>${(s.totalUsed ?? 0).toFixed(2)}`],
    ['累计请求', s.totalRequests],
    ['额度不足', s.low + s.invalid],
  ].map(([label, value]) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');
}

function renderKeys() {
  const body = $('#keys-body');
  const keys = state.keys;
  $('#empty').hidden = keys.length > 0;
  body.innerHTML = keys.map((k) => `
    <tr data-id="${k.id}">
      <td class="col-check"><input type="checkbox" class="row-check" value="${k.id}" /></td>
      <td class="keycell">
        <div class="name">${k.name ? escapeHtml(k.name) : '<span style="color:var(--ink-faint)">（未命名）</span>'}</div>
        <div class="kmask">${k.keyMasked}</div>
        ${k.lastError ? `<div class="err">${escapeHtml(k.lastError)}</div>` : ''}
      </td>
      <td><span class="badge ${k.status}">${STATUS_LABEL[k.status] || k.status}</span></td>
      <td class="num mono">${fmtMoney(k.balance)}</td>
      <td class="num mono">${fmtMoney(k.totalUsed)}</td>
      <td class="num mono">${k.requests} / <span style="color:var(--red)">${k.failures}</span></td>
      <td>${fmtTime(k.lastChecked)}</td>
      <td>
        <label class="switch"><input type="checkbox" class="row-enable" ${k.enabled ? 'checked' : ''} /><span></span></label>
      </td>
      <td><button class="btn mini danger ghost row-del">删除</button></td>
    </tr>`).join('');

  body.querySelectorAll('.row-del').forEach((b) => b.addEventListener('click', onDeleteRow));
  body.querySelectorAll('.row-enable').forEach((b) => b.addEventListener('change', onToggleEnable));
  $('#check-all').checked = false;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- data ----------
async function loadAll() {
  try {
    const [stats, keysRes, settings] = await Promise.all([
      api('/api/stats'), api('/api/keys'), api('/api/settings'),
    ]);
    renderStats(stats);
    state.keys = keysRes.items;
    renderKeys();
     $('#strategy').value = settings.strategy;
    state.settings = settings;
    renderSearchSettings(settings.search);
    if (!state.paramCards.length) {
      state.paramCards = Object.entries(settings.modelParams || {}).map(([model, params]) =>
        newCard(model, params, settings.modelEnabled?.[model] !== false));
    }
    renderParamCards();
  } catch (e) { if (e.message !== 'unauthorized') toast(e.message, 'err'); }
}

async function loadMeta() {
  state.meta = await fetch('/api/meta').then((r) => r.json());
  $('#proxy-hint').textContent = state.meta.proxyAuthEnabled ? '代理已启用鉴权' : '代理无鉴权';
  $('#proxy-url').textContent = location.origin + '/v1';
  $('#anthropic-url').textContent = location.origin;
}

// ---------- actions ----------
function selectedIds() { return [...$$('.row-check:checked')].map((c) => c.value); }

async function onDeleteRow(e) {
  const id = e.target.closest('tr').dataset.id;
  if (!confirm('确定删除这个 Key？')) return;
  await api('/api/keys/' + id, { method: 'DELETE' });
  toast('已删除', 'ok');
  loadAll();
}

async function onToggleEnable(e) {
  const id = e.target.closest('tr').dataset.id;
  try {
    await api('/api/keys/' + id, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) });
  } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
}

$('#check-all').addEventListener('change', (e) => {
  $$('.row-check').forEach((c) => (c.checked = e.target.checked));
});

$('#btn-del-selected').addEventListener('click', async () => {
  const ids = selectedIds();
  if (ids.length === 0) return toast('未选中任何 Key');
  if (!confirm(`确定删除选中的 ${ids.length} 个 Key？`)) return;
  const r = await api('/api/keys/delete', { method: 'POST', body: JSON.stringify({ ids }) });
  toast(`已删除 ${r.removed} 个`, 'ok');
  loadAll();
});

$('#btn-refresh').addEventListener('click', async () => {
  const concurrency = Number($('#concurrency').value) || 5;
  const btn = $('#btn-refresh');
  btn.disabled = true; btn.textContent = '刷新中…';
  try {
    const r = await api('/api/keys/refresh', { method: 'POST', body: JSON.stringify({ concurrency }) });
    toast(`已刷新 ${r.checked} 个 Key 的额度`, 'ok');
    loadAll();
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '↻ 刷新全部'; }
});

$('#btn-refresh-selected').addEventListener('click', async () => {
  const ids = selectedIds();
  if (ids.length === 0) return toast('未选中任何 Key');
  const concurrency = Number($('#concurrency').value) || 5;
  const btn = $('#btn-refresh-selected');
  btn.disabled = true; btn.textContent = '刷新中…';
  try {
    const r = await api('/api/keys/refresh', { method: 'POST', body: JSON.stringify({ concurrency, ids }) });
    toast(`已刷新选中的 ${r.checked} 个 Key`, 'ok');
    loadAll();
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '↻ 刷新选中'; }
});

// 激活选中：对每个 key 用 zai/glm-5.2 发一条极短测试消息
$('#btn-activate-selected').addEventListener('click', async () => {
  const ids = selectedIds();
  if (ids.length === 0) return toast('未选中任何 Key');
  if (!confirm(`将对选中的 ${ids.length} 个 Key 调用 zai/glm-5.2 发送测试消息以激活，是否继续？`)) return;
  const concurrency = Math.min(Number($('#concurrency').value) || 3, 8);
  const btn = $('#btn-activate-selected');
  btn.disabled = true; btn.textContent = '激活中…';
  try {
    const r = await api('/api/keys/activate', {
      method: 'POST',
      body: JSON.stringify({ ids, concurrency }),
    });
    const model = r.model || 'zai/glm-5.2';
    if (r.failed === 0) {
      toast(`激活成功 ${r.succeeded} 个（${model}）`, 'ok');
    } else {
      toast(`激活完成：成功 ${r.succeeded}，失败 ${r.failed}（${model}）`, r.succeeded ? 'ok' : 'err');
    }
    loadAll();
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '⚡ 激活选中'; }
});

$('#btn-recharge').addEventListener('click', async () => {
  const low = state.keys.filter((k) => k.status === 'low').length;
  if (low === 0) return toast('没有额度不足的 Key');
  if (!confirm(`将对 ${low} 个额度不足的 Key 调用 zai/glm-5.2 测活：403 刷新额度，402 保持不变。是否继续？`)) return;
  const concurrency = Number($('#concurrency').value) || 5;
  const btn = $('#btn-recharge');
  btn.disabled = true; btn.textContent = '充值中…';
  try {
    const r = await api('/api/keys/recharge', { method: 'POST', body: JSON.stringify({ concurrency }) });
    toast(`刷新 ${r.refreshed} · 未刷新(402) ${r.pending} · 失败 ${r.failed}`, r.failed && !r.refreshed ? 'err' : 'ok');
    loadAll();
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '💰 批量充值额度'; }
});

$('#btn-prune').addEventListener('click', async () => {
  if (!confirm('将先刷新全部额度，然后删除「余额不足 / 失效」的 Key。是否继续？')) return;
  const concurrency = Number($('#concurrency').value) || 5;
  const btn = $('#btn-prune');
  btn.disabled = true; btn.textContent = '清理中…';
  try {
    const r = await api('/api/keys/prune', { method: 'POST', body: JSON.stringify({ concurrency }) });
    toast(`已清理 ${r.removed} 个额度不足 / 失效的 Key`, 'ok');
    loadAll();
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '🧹 清理额度不足'; }
});

$('#strategy').addEventListener('change', async (e) => {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ strategy: e.target.value }) });
  toast('负载策略已更新', 'ok');
});

// 批量添加
$('#btn-add').addEventListener('click', () => { $('#add-text').value = ''; $('#add-prefix').value = ''; openModal('modal-add'); });
$('#add-submit').addEventListener('click', async () => {
  const text = $('#add-text').value;
  if (!text.trim()) return toast('请输入至少一个 Key');
  try {
    const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ text, namePrefix: $('#add-prefix').value.trim() }) });
    closeModal('modal-add');
    toast(`新增 ${r.added} 个，跳过 ${r.skipped} 个重复`, 'ok');
    loadAll();
  } catch (e) { toast(e.message, 'err'); }
});

// ================= 代理 Key =================
function hitRateCell(rate) {
  if (rate === null || rate === undefined) return '<span style="color:var(--ink-faint)">—</span>';
  const pct = Math.min(100, rate * 100);
  return `<span class="hitbar"><i style="width:${pct}%"></i></span><span class="mono hitpct">${pct.toFixed(1)}%</span>`;
}

function renderPkeyStats(items) {
  const t = items.reduce((acc, k) => {
    acc.enabled += k.enabled ? 1 : 0;
    acc.requests += k.requests || 0;
    acc.promptTokens += k.promptTokens || 0;
    acc.completionTokens += k.completionTokens || 0;
    acc.cachedTokens += k.cachedTokens || 0;
    acc.cost += k.cost || 0;
    return acc;
  }, { enabled: 0, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 });
  const rate = t.promptTokens > 0 ? t.cachedTokens / t.promptTokens : null;
  $('#pkey-stats').innerHTML = [
    ['Key 总数', `${items.length} <small>/ 启用 ${t.enabled}</small>`],
    ['累计请求', t.requests],
    ['Tokens 入 / 出', `${fmtTokens(t.promptTokens)} <small>/</small> ${fmtTokens(t.completionTokens)}`],
    ['累计消耗', `<small>$</small>${t.cost.toFixed(4)}`],
    ['总体命中率', rate === null ? '—' : `${(rate * 100).toFixed(1)}%`],
  ].map(([label, value]) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

  const hint = $('#pk-auth-hint');
  if (items.length === 0) {
    hint.textContent = '⚠ /v1 无鉴权（没有代理 Key）';
    hint.className = 'pill';
    hint.style.color = 'var(--red)';
  } else {
    hint.textContent = t.enabled > 0 ? '鉴权已启用' : '⚠ 全部已停用，/v1 将全部 401';
    hint.className = 'pill muted';
    hint.style.color = t.enabled > 0 ? '' : 'var(--red)';
  }
}

function renderProxyKeys() {
  const body = $('#pkeys-body');
  const items = state.pkeys;
  $('#pkeys-empty').hidden = items.length > 0;
  body.innerHTML = items.map((k) => `
    <tr data-id="${k.id}">
      <td class="col-check"><input type="checkbox" class="pk-check" value="${k.id}" /></td>
      <td class="keycell">
        <div class="name">${k.name ? escapeHtml(k.name) : '<span style="color:var(--ink-faint)">（未命名）</span>'}</div>
        <div class="kmask">${k.keyMasked}</div>
      </td>
      <td class="num mono">${k.requests} / <span style="color:var(--red)">${k.failures}</span></td>
      <td class="num mono">${fmtTokens(k.promptTokens)} / ${fmtTokens(k.completionTokens)}</td>
      <td class="num mono">${k.cost ? '$' + Number(k.cost).toFixed(4) : '—'}</td>
      <td>${hitRateCell(k.hitRate)}</td>
      <td>${fmtTime(k.lastUsed)}</td>
      <td>
        <label class="switch"><input type="checkbox" class="pk-enable" ${k.enabled ? 'checked' : ''} /><span></span></label>
      </td>
      <td style="white-space:nowrap">
        <button class="btn mini ghost pk-rename">改名</button>
        <button class="btn mini ghost pk-copy">复制</button>
        <button class="btn mini danger ghost pk-del">删除</button>
      </td>
    </tr>`).join('');

  body.querySelectorAll('.pk-rename').forEach((b) => b.addEventListener('click', onPkRename));
  body.querySelectorAll('.pk-del').forEach((b) => b.addEventListener('click', onPkDelete));
  body.querySelectorAll('.pk-enable').forEach((b) => b.addEventListener('change', onPkToggle));
  body.querySelectorAll('.pk-copy').forEach((b) => b.addEventListener('click', onPkCopy));
  $('#pk-check-all').checked = false;
}

function renderProxyKeysAll() {
  renderPkeyStats(state.pkeys);
  renderProxyKeys();
}

async function loadProxyKeys() {
  try {
    const r = await api('/api/proxy-keys');
    state.pkeys = r.items;
    renderProxyKeysAll();
  } catch (e) { if (e.message !== 'unauthorized') toast(e.message, 'err'); }
}

function pkSelectedIds() { return [...$$('.pk-check:checked')].map((c) => c.value); }

$('#pk-check-all').addEventListener('change', (e) => {
  $$('.pk-check').forEach((c) => (c.checked = e.target.checked));
});

$('#btn-pk-add').addEventListener('click', () => {
  $('#pk-add-text').value = '';
  $('#pk-add-prefix').value = '';
  $('#pk-add-generate').value = 0;
  openModal('modal-pk-add');
});

$('#pk-add-submit').addEventListener('click', async () => {
  const text = $('#pk-add-text').value;
  const gen = Number($('#pk-add-generate').value) || 0;
  if (!text.trim() && gen <= 0) return toast('请粘贴 Key 或填写随机生成数量');
  try {
    const r = await api('/api/proxy-keys', {
      method: 'POST',
      body: JSON.stringify({
        text,
        namePrefix: $('#pk-add-prefix').value.trim(),
        generate: text.trim() ? 0 : gen,
      }),
    });
    closeModal('modal-pk-add');
    toast(`新增 ${r.added} 个${r.skipped ? `，跳过 ${r.skipped} 个重复` : ''}`, 'ok');
    loadProxyKeys();
  } catch (e) { toast(e.message, 'err'); }
});

$('#btn-pk-del-selected').addEventListener('click', async () => {
  const ids = pkSelectedIds();
  if (ids.length === 0) return toast('未选中任何代理 Key');
  if (!confirm(`确定删除选中的 ${ids.length} 个代理 Key？删除后使用该 Key 的客户端将无法调用。`)) return;
  try {
    const r = await api('/api/proxy-keys/delete', { method: 'POST', body: JSON.stringify({ ids }) });
    toast(`已删除 ${r.removed} 个`, 'ok');
    loadProxyKeys();
  } catch (e) { toast(e.message, 'err'); }
});

$('#btn-pk-reset-stats').addEventListener('click', async () => {
  const ids = pkSelectedIds();
  const scope = ids.length ? `选中的 ${ids.length} 个` : '全部';
  if (!confirm(`确定将 ${scope}代理 Key 的用量统计清零？`)) return;
  try {
    const r = await api('/api/proxy-keys/reset-stats', { method: 'POST', body: JSON.stringify({ ids }) });
    toast(`已清零 ${r.reset} 个 Key 的统计`, 'ok');
    loadProxyKeys();
  } catch (e) { toast(e.message, 'err'); }
});

async function onPkDelete(e) {
  const id = e.target.closest('tr').dataset.id;
  if (!confirm('确定删除这个代理 Key？')) return;
  try {
    await api('/api/proxy-keys/' + id, { method: 'DELETE' });
    toast('已删除', 'ok');
    loadProxyKeys();
  } catch (err) { toast(err.message, 'err'); }
}

async function onPkToggle(e) {
  const id = e.target.closest('tr').dataset.id;
  try {
    await api('/api/proxy-keys/' + id, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) });
    loadProxyKeys();
  } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
}

async function onPkCopy(e) {
  const id = e.target.closest('tr').dataset.id;
  try {
    const r = await api(`/api/proxy-keys/${id}/reveal`);
    try {
      await navigator.clipboard.writeText(r.key);
      toast('完整 Key 已复制到剪贴板', 'ok');
    } catch {
      window.prompt('复制完整 Key：', r.key); // 非 HTTPS 环境剪贴板不可用时兜底
    }
  } catch (err) { if (err.message !== 'unauthorized') toast(err.message, 'err'); }
}

let pkRenameTarget = null;

function onPkRename(e) {
  const id = e.target.closest('tr').dataset.id;
  const k = state.pkeys.find((x) => x.id === id);
  if (!k) return;
  pkRenameTarget = k;
  $('#pk-rename-masked').textContent = k.keyMasked;
  $('#pk-rename-input').value = k.name || '';
  openModal('modal-pk-rename');
  $('#pk-rename-input').focus();
  $('#pk-rename-input').select();
}

async function submitPkRename() {
  if (!pkRenameTarget) return;
  try {
    await api('/api/proxy-keys/' + pkRenameTarget.id, {
      method: 'PATCH',
      body: JSON.stringify({ name: $('#pk-rename-input').value.trim() }),
    });
    pkRenameTarget = null;
    closeModal('modal-pk-rename');
    toast('已保存名称', 'ok');
    loadProxyKeys();
  } catch (err) { toast(err.message, 'err'); }
}

$('#pk-rename-submit').addEventListener('click', submitPkRename);
$('#pk-rename-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPkRename(); });

// 令牌
$('#btn-token').addEventListener('click', () => { $('#token-input').value = state.token; openModal('modal-token'); });
$('#token-submit').addEventListener('click', () => {
  state.token = $('#token-input').value.trim();
  localStorage.setItem('adminToken', state.token);
  closeModal('modal-token');
  toast('已保存令牌', 'ok');
  loadAll();
  loadDebugState();
  stopLogStream(); // 用新令牌重连
  if (!$('#view-logs').hidden) startLogStream();
  if (!$('#view-images').hidden) loadImageHistory();
});

// ---------- init ----------
(async function init() {
  await loadMeta();
  if (state.meta.requiresAdminToken && !state.token) openModal('modal-token');
  loadAll();
  loadDebugState();
})();

// ================= 选项卡 =================
$$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
function switchView(view) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-keys').hidden = view !== 'keys';
  $('#view-pkeys').hidden = view !== 'pkeys';
  $('#view-params').hidden = view !== 'params';
  $('#view-images').hidden = view !== 'images';
  $('#view-logs').hidden = view !== 'logs';
  if (view === 'logs') startLogStream();
  if (view === 'params') renderParamCards();
  if (view === 'images') loadImageHistory();
  if (view === 'pkeys') loadProxyKeys();
}

function renderParamCards() {
  const list = $('#params-list');
  const empty = $('#params-empty');
  empty.hidden = state.paramCards.length > 0;
  list.innerHTML = state.paramCards.map((card) => `
    <section class="card param-card" data-card="${card.id}">
      <div class="param-card-head">
        <label class="field model-field">模型 ID
          <input type="text" class="param-model" value="${escapeHtml(card.model)}" placeholder="例如 xai/grok-4" />
        </label>
        <label class="switch-inline param-enable-wrap">
          <span class="param-enable-label">${card.enabled ? '已启用' : '已停用'}</span>
          <label class="switch"><input type="checkbox" class="param-enable-input" ${card.enabled ? 'checked' : ''} /><span></span></label>
        </label>
        <div class="param-card-actions">
          <button class="btn mini ghost param-dup">复制</button>
          <button class="btn mini danger ghost param-del">删除</button>
        </div>
      </div>
      <div class="param-fields">
        ${card.fields.map((f) => renderFieldRow(card.id, f)).join('')}
      </div>
      <div class="param-add-row">
        <button class="btn mini param-add-field">＋ 字段</button>
        ${PARAM_PRESETS.map((p) => `<button class="btn mini ghost param-preset" data-preset="${escapeHtml(p.key)}">${escapeHtml(p.key)}</button>`).join('')}
      </div>
    </section>`).join('');

  list.querySelectorAll('.param-card').forEach((el) => {
    const card = state.paramCards.find((c) => c.id === el.dataset.card);
    if (!card) return;
    el.querySelector('.param-model').addEventListener('input', (e) => { card.model = e.target.value; });
    el.querySelector('.param-enable-input').addEventListener('change', (e) => {
      card.enabled = e.target.checked;
      const label = el.querySelector('.param-enable-label');
      if (label) label.textContent = card.enabled ? '已启用' : '已停用';
    });
    el.querySelector('.param-dup').addEventListener('click', () => {
      const collected = collectCardParams(card);
      state.paramCards.push(newCard(card.model ? `${card.model}-copy` : '', collected.params || {}, card.enabled));
      renderParamCards();
    });
    el.querySelector('.param-del').addEventListener('click', () => {
      state.paramCards = state.paramCards.filter((c) => c.id !== card.id);
      renderParamCards();
    });
    el.querySelector('.param-add-field').addEventListener('click', () => {
      card.fields.push(newField());
      renderParamCards();
    });
    el.querySelectorAll('.param-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = PARAM_PRESETS.find((p) => p.key === btn.dataset.preset);
        if (!preset) return;
        if (card.fields.some((f) => f.key === preset.key)) return toast(`已有 ${preset.key}`);
        card.fields.push(newField(preset));
        renderParamCards();
      });
    });
    el.querySelectorAll('.param-field').forEach((row) => bindFieldRow(card, row));
  });
}

function renderFieldRow(cardId, field) {
  const valueControl = field.type === 'boolean'
    ? `<select class="param-value">
        <option value="true"${field.value === 'true' ? ' selected' : ''}>true</option>
        <option value="false"${field.value === 'false' ? ' selected' : ''}>false</option>
      </select>`
    : field.type === 'json'
      ? `<textarea class="param-value" rows="4" spellcheck="false" placeholder='{"gateway":{"only":["xai"]}}'>${escapeHtml(field.value)}</textarea>`
      : `<input class="param-value" type="${field.type === 'number' ? 'number' : 'text'}" value="${escapeHtml(field.value)}" step="any" />`;
  return `
    <div class="param-field" data-field="${field.id}">
      <input class="param-key" type="text" value="${escapeHtml(field.key)}" placeholder="字段名" />
      <select class="param-type">
        <option value="string"${field.type === 'string' ? ' selected' : ''}>string</option>
        <option value="number"${field.type === 'number' ? ' selected' : ''}>number</option>
        <option value="boolean"${field.type === 'boolean' ? ' selected' : ''}>boolean</option>
        <option value="json"${field.type === 'json' ? ' selected' : ''}>JSON</option>
      </select>
      ${valueControl}
      <button class="btn mini danger ghost param-del-field">×</button>
    </div>`;
}

function bindFieldRow(card, row) {
  const field = card.fields.find((f) => f.id === row.dataset.field);
  if (!field) return;
  row.querySelector('.param-key').addEventListener('input', (e) => { field.key = e.target.value; });
  row.querySelector('.param-type').addEventListener('change', (e) => {
    field.type = e.target.value;
    if (field.type === 'boolean' && field.value !== 'true' && field.value !== 'false') field.value = 'true';
    if (field.type === 'json' && !field.value) field.value = '{}';
    renderParamCards();
  });
  row.querySelector('.param-value').addEventListener('input', (e) => { field.value = e.target.value; });
  row.querySelector('.param-del-field').addEventListener('click', () => {
    card.fields = card.fields.filter((f) => f.id !== field.id);
    renderParamCards();
  });
}

function collectCardParams(card) {
  const params = {};
  for (const field of card.fields) {
    const key = field.key.trim();
    if (!key) continue;
    if (field.type === 'number') {
      const n = Number(field.value);
      if (!Number.isFinite(n)) return { error: `「${key}」不是有效数字` };
      params[key] = n;
    } else if (field.type === 'boolean') {
      params[key] = field.value === 'true';
    } else if (field.type === 'json') {
      try {
        params[key] = JSON.parse(field.value || 'null');
      } catch (e) {
        return { error: `「${key}」JSON 无效：${e.message}` };
      }
    } else {
      params[key] = field.value;
    }
  }
  return { params };
}

$('#btn-add-model').addEventListener('click', () => {
  state.paramCards.push(newCard());
  renderParamCards();
});

// ================= 搜索 API 设置 =================
function renderSearchSettings(search) {
  const s = search || {};
  $('#search-model').value = s.model || 'zai/glm-5.2';
  $('#search-provider').value = s.provider || 'perplexity';
  $('#search-max-results').value = s.maxResults || 10;
}

$('#btn-save-search').addEventListener('click', async () => {
  const search = {
    model: $('#search-model').value.trim() || 'zai/glm-5.2',
    provider: $('#search-provider').value,
    maxResults: Math.max(1, Math.min(20, Number($('#search-max-results').value) || 10)),
  };
  try {
    const settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ search }) });
    state.settings = settings;
    renderSearchSettings(settings.search);
    toast('搜索设置已保存', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
});

$('#btn-save-params').addEventListener('click', async () => {
  const errEl = $('#params-error');
  const modelParams = {};
  const modelEnabled = {};
  for (const card of state.paramCards) {
    const model = card.model.trim();
    if (!model) { errEl.textContent = '存在未填写的模型 ID'; errEl.hidden = false; return; }
    if (modelParams[model]) { errEl.textContent = `模型「${model}」重复`; errEl.hidden = false; return; }
    const collected = collectCardParams(card);
    if (collected.error) { errEl.textContent = collected.error; errEl.hidden = false; return; }
    modelParams[model] = collected.params;
    modelEnabled[model] = card.enabled !== false;
  }
  try {
    const settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ modelParams, modelEnabled }) });
    state.settings = settings;
    state.paramCards = Object.entries(settings.modelParams || {}).map(([model, params]) =>
      newCard(model, params, settings.modelEnabled?.[model] !== false));
    errEl.hidden = true;
    renderParamCards();
    toast('模型参数已保存', 'ok');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.hidden = false;
    toast(e.message, 'err');
  }
});

// ================= 运行日志 =================
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
const logState = { es: null, level: 'all', autoscroll: true, seen: new Set() };

function levelPass(level) {
  if (logState.level === 'all') return true;
  return LEVEL_RANK[level] >= LEVEL_RANK[logState.level];
}

function appendLog(entry) {
  if (logState.seen.has(entry.id)) return; // SSE 重连补发去重
  logState.seen.add(entry.id);
  if (logState.seen.size > 2000) logState.seen = new Set([...logState.seen].slice(-1500));

  const console_ = $('#log-console');
  const empty = console_.querySelector('.log-empty');
  if (empty) empty.remove();

  const line = document.createElement('div');
  line.className = 'log-line ' + entry.level;
  line.dataset.level = entry.level;
  if (!levelPass(entry.level)) line.style.display = 'none';
  const t = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const meta = entry.meta !== undefined ? '  ' + JSON.stringify(entry.meta) : '';
  line.innerHTML =
    `<span class="lt">${t}</span>` +
    `<span class="ll">${entry.level.toUpperCase()}</span>` +
    `<span class="ls">${escapeHtml(entry.scope)}</span>` +
    `<span class="lm">${escapeHtml(entry.msg + meta)}</span>`;
  console_.appendChild(line);

  while (console_.childElementCount > 1200) console_.removeChild(console_.firstChild);
  if (logState.autoscroll) console_.scrollTop = console_.scrollHeight;
}

function startLogStream() {
  if (logState.es) return; // 已连接
  const console_ = $('#log-console');
  if (!console_.childElementCount) console_.innerHTML = '<div class="log-empty">正在连接日志流…</div>';
  const q = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  const es = new EventSource('/api/logs/stream' + q);
  logState.es = es;
  const status = $('#log-status');
  es.onopen = () => { status.textContent = '● 实时连接'; status.className = 'pill'; status.style.color = 'var(--green)'; };
  es.onerror = () => { status.textContent = '○ 重连中…'; status.className = 'pill muted'; status.style.color = ''; };
  es.onmessage = (e) => { try { appendLog(JSON.parse(e.data)); } catch {} };
}
function stopLogStream() {
  if (logState.es) { logState.es.close(); logState.es = null; }
}

$('#log-level').addEventListener('change', (e) => {
  logState.level = e.target.value;
  $$('#log-console .log-line').forEach((l) => { l.style.display = levelPass(l.dataset.level) ? '' : 'none'; });
});
$('#log-autoscroll').addEventListener('change', (e) => (logState.autoscroll = e.target.checked));
$('#btn-log-clear').addEventListener('click', () => {
  $('#log-console').innerHTML = '<div class="log-empty">已清屏，等待新日志…</div>';
  logState.seen.clear();
});
$('#debug-toggle').addEventListener('change', async (e) => {
  try {
    const r = await api('/api/debug', { method: 'PUT', body: JSON.stringify({ debug: e.target.checked }) });
    toast('Debug 模式已' + (r.debug ? '开启' : '关闭'), 'ok');
  } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
});

async function loadDebugState() {
  try {
    const r = await api('/api/debug');
    $('#debug-toggle').checked = r.debug;
  } catch {}
}

// ================= 图片生成 =================
const imageBlobCache = new Map();

async function imageBlobUrl(path) {
  if (imageBlobCache.has(path)) return imageBlobCache.get(path);
  const headers = {};
  if (state.token) headers['x-admin-token'] = state.token;
  const res = await fetch(path, { headers });
  if (res.status === 401) {
    toast('管理令牌无效或缺失，请点击右上角设置', 'err');
    openModal('modal-token');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error('图片加载失败');
  const url = URL.createObjectURL(await res.blob());
  imageBlobCache.set(path, url);
  return url;
}

function revokeImageBlobs(item) {
  const files = [...(item.files || []), ...(item.references || [])];
  for (const file of files) {
    const url = imageBlobCache.get(file.url);
    if (url) {
      URL.revokeObjectURL(url);
      imageBlobCache.delete(file.url);
    }
  }
}

function renderRefStrip(item) {
  if (!item.references?.length) return '';
  return `<div class="image-card-refs">${item.references.map((file) =>
    `<img class="ref-mini" data-src="${escapeHtml(file.url)}" alt="参考图" />`
  ).join('')}</div>`;
}

function renderImageCard(item, file) {
  return `
    <article class="card image-card" data-id="${item.id}" data-index="${file.index}">
      <div class="image-thumb loading" data-src="${escapeHtml(file.url)}">加载中…</div>
      <div class="image-card-body">
        <p class="image-card-prompt">${escapeHtml(item.prompt)}</p>
        ${renderRefStrip(item)}
        <div class="image-card-meta">${escapeHtml(item.model)} · ${escapeHtml(item.size || '—')}${item.references?.length ? ` · 参考 ${item.references.length} 张` : ''} · ${fmtTime(item.createdAt)}</div>
        <div class="image-card-actions">
          <button class="btn mini ghost image-open">查看</button>
          <button class="btn mini ghost image-dl">下载</button>
          <button class="btn mini danger ghost image-del">删除</button>
        </div>
      </div>
    </article>`;
}

function bindImageCard(el, item) {
  const file = item.files[Number(el.dataset.index)];
  if (!file) return;
  const thumb = el.querySelector('.image-thumb');
  imageBlobUrl(file.url).then((url) => {
    const img = document.createElement('img');
    img.className = 'image-thumb';
    img.alt = item.prompt;
    img.src = url;
    thumb.replaceWith(img);
    img.addEventListener('click', () => openImagePreview(item, file, url));
  }).catch(() => { thumb.textContent = '加载失败'; });
  el.querySelectorAll('.ref-mini').forEach((mini, i) => {
    const ref = item.references[i];
    if (!ref) return;
    imageBlobUrl(ref.url).then((url) => { mini.src = url; }).catch(() => {});
  });

  el.querySelector('.image-open').addEventListener('click', async () => {
    try {
      const url = await imageBlobUrl(file.url);
      openImagePreview(item, file, url);
    } catch (e) { if (e.message !== 'unauthorized') toast(e.message, 'err'); }
  });
  el.querySelector('.image-dl').addEventListener('click', async () => {
    try {
      const url = await imageBlobUrl(file.url);
      const a = document.createElement('a');
      a.href = url;
      a.download = `image-${item.id}-${file.index}.${(file.mediaType || 'image/png').split('/')[1] || 'png'}`;
      a.click();
    } catch (e) { if (e.message !== 'unauthorized') toast(e.message, 'err'); }
  });
  el.querySelector('.image-del').addEventListener('click', async () => {
    if (!confirm('确定删除这组生成记录？')) return;
    try {
      await api('/api/images/' + item.id, { method: 'DELETE' });
      revokeImageBlobs(item);
      state.imageHistory = (state.imageHistory || []).filter((x) => x.id !== item.id);
      if (state.latestImage?.id === item.id) {
        state.latestImage = null;
        $('#image-latest').hidden = true;
      }
      renderImageHistory();
      toast('已删除', 'ok');
    } catch (e) { if (e.message !== 'unauthorized') toast(e.message, 'err'); }
  });
}

function openImagePreview(item, file, url) {
  $('#image-preview-img').src = url;
  $('#image-preview-meta').textContent = `${item.model} · ${item.size || '—'} · ${fmtTime(item.createdAt)}`;
  const dl = $('#image-preview-download');
  dl.href = url;
  dl.download = `image-${item.id}-${file.index}.${(file.mediaType || 'image/png').split('/')[1] || 'png'}`;
  openModal('modal-image');
}

function renderLatestImage(item) {
  state.latestImage = item;
  const box = $('#image-latest');
  const grid = $('#image-latest-grid');
  if (!item?.files?.length) { box.hidden = true; return; }
  box.hidden = false;
  grid.innerHTML = item.files.map((file) => renderImageCard(item, file)).join('');
  grid.querySelectorAll('.image-card').forEach((el) => bindImageCard(el, item));
}

function renderImageHistory() {
  const latestId = state.latestImage?.id;
  const items = (state.imageHistory || []).filter((x) => x.id !== latestId);
  $('#image-empty').hidden = items.length > 0 || Boolean(latestId);
  const list = $('#image-history');
  list.innerHTML = items.flatMap((item) => (item.files || []).map((file) => renderImageCard(item, file))).join('');
  list.querySelectorAll('.image-card').forEach((el) => {
    const item = items.find((x) => x.id === el.dataset.id);
    if (item) bindImageCard(el, item);
  });
}

async function loadImageHistory() {
  try {
    const r = await api('/api/images');
    state.imageHistory = r.items || [];
    renderImageHistory();
  } catch (e) { if (e.message !== 'unauthorized') toast(e.message, 'err'); }
}

const MAX_IMAGE_REFS = 8;
const MAX_IMAGE_REF_BYTES = 8 * 1024 * 1024;
const imageRefs = [];

function fileToRef(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取参考图失败'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return reject(new Error('参考图编码失败'));
      resolve({
        name: file.name,
        mediaType: file.type || 'image/png',
        b64: dataUrl.slice(comma + 1),
        preview: dataUrl,
      });
    };
    reader.readAsDataURL(file);
  });
}

function renderRefPreview() {
  const box = $('#image-refs-preview');
  const clearBtn = $('#btn-image-refs-clear');
  clearBtn.hidden = imageRefs.length === 0;
  if (imageRefs.length === 0) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = imageRefs.map((ref, i) => `
    <div class="ref-item">
      <img src="${ref.preview}" alt="${escapeHtml(ref.name || '参考图')}" />
      <button type="button" data-ref="${i}" aria-label="移除">×</button>
    </div>`).join('');
  box.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      imageRefs.splice(Number(btn.dataset.ref), 1);
      renderRefPreview();
    });
  });
}

$('#btn-image-refs').addEventListener('click', () => $('#image-refs').click());
$('#btn-image-refs-clear').addEventListener('click', () => {
  imageRefs.splice(0, imageRefs.length);
  $('#image-refs').value = '';
  renderRefPreview();
});
$('#image-refs').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  const room = MAX_IMAGE_REFS - imageRefs.length;
  if (room <= 0) return toast(`参考图最多 ${MAX_IMAGE_REFS} 张`, 'err');
  const picked = files.slice(0, room);
  if (files.length > room) toast(`已忽略超出的 ${files.length - room} 张`, 'err');
  for (const file of picked) {
    if (!file.type.startsWith('image/')) {
      toast(`「${file.name}」不是图片`, 'err');
      continue;
    }
    if (file.size > MAX_IMAGE_REF_BYTES) {
      toast(`「${file.name}」超过 8MB`, 'err');
      continue;
    }
    try {
      imageRefs.push(await fileToRef(file));
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  renderRefPreview();
});

$('#btn-image-generate').addEventListener('click', async () => {
  const prompt = $('#image-prompt').value.trim();
  const errEl = $('#image-form-error');
  if (!prompt) {
    errEl.textContent = '请输入提示词';
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  const btn = $('#btn-image-generate');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const item = await api('/api/images/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        model: $('#image-model').value.trim() || 'bytedance/seedream-5.0-pro',
        size: $('#image-size').value,
        n: Number($('#image-n').value) || 1,
        references: imageRefs.map((ref) => ({ mediaType: ref.mediaType, b64: ref.b64 })),
      }),
    });
    toast(`已生成 ${item.files?.length || 0} 张并保存`, 'ok');
    state.imageHistory = [item, ...(state.imageHistory || []).filter((x) => x.id !== item.id)];
    renderLatestImage(item);
    renderImageHistory();
  } catch (e) {
    if (e.message !== 'unauthorized') {
      errEl.textContent = e.message;
      errEl.hidden = false;
      toast(e.message, 'err');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '生成图片';
  }
});
