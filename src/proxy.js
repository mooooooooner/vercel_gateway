import express from 'express';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { store, maskKey } from './store.js';
import { forward } from './gateway.js';
import { log } from './logger.js';

// 客户端代理鉴权：Authorization: Bearer 或 x-api-key。未配置则放行。
function proxyAuth(req, res, next) {
  if (config.proxyApiKeys.length === 0) return next();
  const auth = req.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = bearer || req.get('x-api-key') || '';
  if (token && config.proxyApiKeys.includes(token)) return next();
  return res.status(401).json({ error: { message: '无效的 API Key', type: 'invalid_request_error', code: 'invalid_api_key' } });
}

function pickForwardHeaders(req) {
  const extra = {};
  const version = req.get('anthropic-version');
  const beta = req.get('anthropic-beta');
  if (version) extra['anthropic-version'] = version;
  if (beta) extra['anthropic-beta'] = beta;
  return extra;
}

function mergeModelParams(clientBody) {
  const model = clientBody?.model;
  if (!model) return clientBody || {};
  const defaults = store.getSettings().modelParams?.[model];
  if (!defaults || typeof defaults !== 'object') return clientBody || {};
  const out = { ...clientBody };
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in clientBody)) out[key] = value;
  }
  return out;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
const COOLDOWN_MS = 60_000; // 429 限流后该 key 冷却 1 分钟，期间不再优先选中

const EXTRA_MODELS = [
  {
    id: 'zai/glm-5.2',
    object: 'model',
    owned_by: 'zai',
    name: 'GLM 5.2',
    type: 'language',
  },
];

// 根据上游状态码更新 key 状态
function markKey(k, status) {
  if (status === 401 || status === 403) return { status: 'invalid' };
  if (status === 402) return { status: 'low' };
  if (status === 429) return { cooldownUntil: Date.now() + COOLDOWN_MS }; // 限流：进入冷却
  return {};
}

function addExtraModels(data) {
  if (!data || !Array.isArray(data.data)) return data;
  const existing = new Set(data.data.map((m) => m?.id).filter(Boolean));
  for (const model of EXTRA_MODELS) {
    if (!existing.has(model.id)) data.data.push(model);
  }
  return data;
}

function snippet(text, max = 400) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 从 Key 池选一个向上游转发，401/402/429/5xx 自动换下一个。
 * 成功返回 { ok, status, response, key, reqId }；失败返回 { ok:false, status, message, reqId }。
 */
export async function forwardWithFailover(pathName, body, {
  extraHeaders = {},
  method = 'POST',
  timeoutMs,
  scope = 'proxy',
} = {}) {
  const reqId = Math.random().toString(36).slice(2, 8);
  const tried = new Set();
  const maxAttempts = Math.min(store.pickCandidates().length || 1, 5);
  let lastErr = null;

  log.debug(scope, `${pathName} ← model=${body?.model || '?'} stream=${body?.stream === true} [${reqId}]`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const k = store.nextKey(tried);
    if (!k) break;
    tried.add(k.id);
    const label = k.name || maskKey(k.key);
    log.debug(scope, `尝试 #${attempt + 1} 使用 key「${label}」[${reqId}]`);
    try {
      const upstream = await forward(k.key, pathName, body, { method, extraHeaders, timeoutMs });

      if (!upstream.ok && (RETRYABLE.has(upstream.status) || upstream.status === 401 || upstream.status === 402 || upstream.status === 403)) {
        const patch = markKey(k, upstream.status);
        store.update(k.id, { failures: (k.failures || 0) + 1, lastError: `HTTP ${upstream.status}`, ...patch });
        lastErr = { status: upstream.status, body: await upstream.text().catch(() => '') };
        const note = patch.status ? { marked: patch.status } : (patch.cooldownUntil ? { cooldown: `${COOLDOWN_MS / 1000}s` } : undefined);
        log.warn(scope, `key「${label}」返回 ${upstream.status}，切换下一个 [${reqId}]`, note);
        continue;
      }

      store.update(k.id, { requests: (k.requests || 0) + 1, lastUsed: Date.now() });
      log.info(scope, `key「${label}」→ ${upstream.status} ${body?.stream ? '(流式)' : ''} [${reqId}]`);
      return { ok: true, status: upstream.status, response: upstream, key: k, reqId };
    } catch (err) {
      store.update(k.id, { failures: (k.failures || 0) + 1, lastError: String(err.message || err) });
      lastErr = { status: 502, body: String(err.message || err) };
      log.warn(scope, `key「${label}」转发异常：${err.message} [${reqId}]`);
    }
  }

  const status = lastErr?.status || 503;
  const message = tried.size === 0
    ? '没有可用的 key（请在管理后台添加并刷新额度）'
    : `所有候选 key 均转发失败（尝试 ${tried.size} 个）。最后错误：${snippet(lastErr?.body || status)}`;
  log.error(scope, `${pathName} 失败 (${status})：${message} [${reqId}]`);
  return { ok: false, status, message, reqId, tried: tried.size };
}

async function handleForward(req, res, pathName, mergeDefaults) {
  const clientBody = req.body || {};
  const body = mergeDefaults ? mergeModelParams(clientBody) : clientBody;
  const extraHeaders = pickForwardHeaders(req);
  const wantStream = body.stream === true;
  const injected = mergeDefaults && body !== clientBody
    ? Object.keys(body).filter((k) => !(k in clientBody))
    : [];
  if (injected.length) {
    log.debug('proxy', `${pathName} 注入字段`, { injected });
  }

  const result = await forwardWithFailover(pathName, body, { extraHeaders });
  if (!result.ok) {
    return res.status(result.status).json({ error: { message: result.message, type: 'gateway_error' } });
  }

  res.status(result.status);
  res.setHeader('X-Gateway-Key-Id', result.key.id);
  const ct = result.response.headers.get('content-type');
  if (ct) res.setHeader('Content-Type', ct);

  if (wantStream && result.response.body) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const nodeStream = Readable.fromWeb(result.response.body);
    res.on('close', () => nodeStream.destroy());
    nodeStream.on('error', (err) => {
      log.warn('proxy', `流式传输中断：${err.message} [${result.reqId}]`);
      if (!res.writableEnded) res.end();
    });
    nodeStream.pipe(res);
    return;
  }
  res.send(Buffer.from(await result.response.arrayBuffer()));
}

export function createProxyRouter() {
  const router = express.Router();
  router.use(proxyAuth);

  router.post('/chat/completions', (req, res) => handleForward(req, res, '/chat/completions', true));
  router.post('/completions', (req, res) => handleForward(req, res, '/completions', true));
  router.post('/embeddings', (req, res) => handleForward(req, res, '/embeddings', false));
  router.post('/messages', (req, res) => handleForward(req, res, '/messages', true));
  router.post('/messages/count_tokens', (req, res) => handleForward(req, res, '/messages/count_tokens', true));
  router.post('/responses', (req, res) => handleForward(req, res, '/responses', true));
  router.post('/images/generations', (req, res) => handleForward(req, res, '/images/generations', true));
  router.post('/images/edits', (req, res) => handleForward(req, res, '/images/edits', true));

  // 模型列表：用任一可用 key 查询上游
  router.get('/models', async (req, res) => {
    const k = store.nextKey();
    if (!k) return res.status(503).json({ error: { message: '没有可用的 key' } });
    try {
      const upstream = await forward(k.key, '/models', null, { method: 'GET' });
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);
      if (upstream.ok && ct?.includes('application/json')) {
        const data = await upstream.json();
        return res.json(addExtraModels(data));
      }
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.status(502).json({ error: { message: String(err.message || err) } });
    }
  });

  return router;
}
