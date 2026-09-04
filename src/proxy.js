import express from 'express';
import { Readable } from 'node:stream';
import { store, maskKey } from './store.js';
import { proxyKeyStore } from './proxy-keys.js';
import { extractUsage, createSseUsageScanner } from './usage.js';
import { forward } from './gateway.js';
import { log } from './logger.js';

// 客户端代理鉴权：Authorization: Bearer 或 x-api-key。
// 代理 Key 由后台页面管理（data/proxy-keys.json，启动时用 .env 的 PROXY_API_KEYS 做种子）。
// 一个 key 都没有时保持旧行为：放行（/api/meta 会提示「代理无鉴权」）。
function proxyAuth(req, res, next) {
  if (proxyKeyStore.count() === 0) return next();
  const auth = req.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = bearer || req.get('x-api-key') || '';
  if (token) {
    const pk = proxyKeyStore.verify(token);
    if (pk) {
      req.proxyKeyId = pk.id;
      return next();
    }
  }
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

async function handleForward(req, res, pathName, mergeDefaults, track = false) {
  const clientBody = req.body || {};
  let body = mergeDefaults ? mergeModelParams(clientBody) : clientBody;
  const extraHeaders = pickForwardHeaders(req);
  const wantStream = body.stream === true;
  const injected = mergeDefaults && body !== clientBody
    ? Object.keys(body).filter((k) => !(k in clientBody))
    : [];
  if (injected.length) {
    log.debug('proxy', `${pathName} 注入字段`, { injected });
  }
  // 流式 chat 请求且客户端未指定时注入 include_usage，保证最后一个 chunk 带上 usage 供统计。
  if (track && pathName === '/chat/completions' && wantStream && !body.stream_options?.include_usage) {
    body = { ...body, stream_options: { ...(body.stream_options || {}), include_usage: true } };
    log.debug('proxy', `${pathName} 注入 stream_options.include_usage`);
  }

  const result = await forwardWithFailover(pathName, body, { extraHeaders });
  if (!result.ok) {
    if (track && req.proxyKeyId) proxyKeyStore.recordFailure(req.proxyKeyId);
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
    // 旁路嗅探 SSE 中的 usage，结束时累计到代理 Key（客户端断开也会结算一次）。
    if (track && req.proxyKeyId) {
      const scanner = createSseUsageScanner();
      let settled = false;
      const finalize = () => {
        if (settled) return;
        settled = true;
        proxyKeyStore.recordUsage(req.proxyKeyId, scanner.result());
      };
      nodeStream.on('data', (chunk) => scanner.push(chunk.toString('utf8')));
      nodeStream.on('end', finalize);
      nodeStream.on('close', finalize);
    }
    nodeStream.pipe(res);
    return;
  }

  const buffer = Buffer.from(await result.response.arrayBuffer());
  if (track && req.proxyKeyId) {
    let usage = null;
    try {
      usage = extractUsage(JSON.parse(buffer.toString('utf8')));
    } catch {}
    proxyKeyStore.recordUsage(req.proxyKeyId, usage);
  }
  res.send(buffer);
}

export function createProxyRouter() {
  const router = express.Router();
  router.use(proxyAuth);

  // 聊天接口开启按代理 Key 的用量统计；embeddings / images / count_tokens 不统计。
  router.post('/chat/completions', (req, res) => handleForward(req, res, '/chat/completions', true, true));
  router.post('/completions', (req, res) => handleForward(req, res, '/completions', true, true));
  router.post('/embeddings', (req, res) => handleForward(req, res, '/embeddings', false));
  router.post('/messages', (req, res) => handleForward(req, res, '/messages', true, true));
  router.post('/messages/count_tokens', (req, res) => handleForward(req, res, '/messages/count_tokens', true));
  router.post('/responses', (req, res) => handleForward(req, res, '/responses', true, true));
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
