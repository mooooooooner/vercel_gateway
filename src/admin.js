import express from 'express';
import { config } from './config.js';
import { store, maskKey } from './store.js';
import { fetchCredits, forward, runPool } from './gateway.js';
import { log } from './logger.js';
import { attachImageRoutes } from './images.js';

// 激活用的探测模型与消息：对每个 key 发一次极短 chat 请求，触发上游激活。
const ACTIVATE_MODEL = 'zai/glm-5.2';
const ACTIVATE_BODY = {
  model: ACTIVATE_MODEL,
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1,
  stream: false,
};

// 管理接口鉴权：需要 Authorization: Bearer <ADMIN_TOKEN> 或 x-admin-token。
// 未配置 ADMIN_TOKEN 时放行（并在日志中已有警告）。
function adminAuth(req, res, next) {
  if (!config.adminToken) return next();
  const auth = req.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = bearer || req.get('x-admin-token') || '';
  if (token && token === config.adminToken) return next();
  return res.status(401).json({ error: { message: '管理令牌无效或缺失', type: 'unauthorized' } });
}

function publicView(k) {
  return {
    id: k.id,
    keyMasked: maskKey(k.key),
    name: k.name || '',
    enabled: k.enabled,
    balance: k.balance,
    totalUsed: k.totalUsed,
    status: k.status,
    lastChecked: k.lastChecked,
    lastError: k.lastError,
    requests: k.requests,
    failures: k.failures,
    lastUsed: k.lastUsed,
    cooldownUntil: k.cooldownUntil ?? null,
    createdAt: k.createdAt,
  };
}

// 从大段文本中解析 key：支持换行、逗号、空格分隔。
function parseKeys(input) {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
  return String(input || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createAdminRouter() {
  const router = express.Router();
  router.use(adminAuth);

  // 概览统计
  router.get('/stats', (req, res) => {
    const keys = store.list();
    const enabled = keys.filter((k) => k.enabled);
    const usable = keys.filter((k) => k.enabled && k.status !== 'invalid' && k.status !== 'low');
    const totalBalance = keys.reduce((s, k) => s + (k.balance || 0), 0);
    const totalUsed = keys.reduce((s, k) => s + (k.totalUsed || 0), 0);
    const totalRequests = keys.reduce((s, k) => s + (k.requests || 0), 0);
    res.json({
      total: keys.length,
      enabled: enabled.length,
      usable: usable.length,
      low: keys.filter((k) => k.status === 'low').length,
      invalid: keys.filter((k) => k.status === 'invalid').length,
      totalBalance: Number(totalBalance.toFixed(4)),
      totalUsed: Number(totalUsed.toFixed(4)),
      totalRequests,
      strategy: store.getSettings().strategy,
    });
  });

  // 设置（负载均衡策略 + 按模型参数）
  router.get('/settings', (req, res) => res.json(store.getSettings()));
  router.put('/settings', (req, res) => {
    const { strategy, modelParams } = req.body || {};
    const valid = ['round-robin', 'least-used', 'random', 'highest-balance', 'lowest-balance'];
    const patch = {};
    if (strategy) {
      if (!valid.includes(strategy)) return res.status(400).json({ error: { message: '无效的策略' } });
      patch.strategy = strategy;
    }
    if (modelParams !== undefined) {
      if (typeof modelParams !== 'object' || Array.isArray(modelParams)) {
        return res.status(400).json({ error: { message: 'modelParams 必须为对象' } });
      }
      const cleaned = {};
      for (const [modelId, params] of Object.entries(modelParams)) {
        const id = String(modelId || '').trim();
        if (!id) continue;
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
          return res.status(400).json({ error: { message: `模型「${id}」的参数必须为对象` } });
        }
        cleaned[id] = params;
      }
      patch.modelParams = cleaned;
    }
    res.json(store.setSettings(patch));
  });

  // 列出所有 key（脱敏）
  router.get('/keys', (req, res) => {
    res.json({ items: store.list().map(publicView) });
  });

  // 最近日志（一次性拉取，SSE 实时流见 /api/logs/stream）
  router.get('/logs', (req, res) => {
    res.json({ items: log.recent(Number(req.query.limit) || 300), debug: log.debugEnabled });
  });

  // Debug 模式开关
  router.get('/debug', (req, res) => res.json({ debug: log.debugEnabled }));
  router.put('/debug', (req, res) => {
    const on = log.setDebug(Boolean(req.body?.debug));
    res.json({ debug: on });
  });

  // 批量添加
  router.post('/keys', (req, res) => {
    const { text, keys, namePrefix } = req.body || {};
    const parsed = parseKeys(keys ?? text);
    if (parsed.length === 0) return res.status(400).json({ error: { message: '未解析到任何 key' } });
    const result = store.addMany(parsed, namePrefix || '');
    log.info('admin', `批量添加：新增 ${result.added}，跳过 ${result.skipped}`);
    res.json({ added: result.added, skipped: result.skipped, items: result.items.map(publicView) });
  });

  // 批量删除
  router.post('/keys/delete', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: { message: '缺少 ids' } });
    const removed = store.remove(ids);
    log.info('admin', `批量删除 ${removed} 个 key`);
    res.json({ removed });
  });

  // 删除单个
  router.delete('/keys/:id', (req, res) => {
    const removed = store.remove([req.params.id]);
    res.json({ removed });
  });

  // 修改单个（启用/停用/改名）
  router.patch('/keys/:id', (req, res) => {
    const patch = {};
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (typeof req.body?.name === 'string') patch.name = req.body.name;
    const k = store.update(req.params.id, patch);
    if (!k) return res.status(404).json({ error: { message: '未找到该 key' } });
    res.json(publicView(k));
  });

  // 刷新额度（自定义并发）。ids 为空则刷新全部。
  router.post('/keys/refresh', async (req, res) => {
    const { ids, concurrency } = req.body || {};
    const targets = Array.isArray(ids) && ids.length
      ? store.list().filter((k) => ids.includes(k.id))
      : store.list();
    if (targets.length === 0) return res.json({ checked: 0, items: [] });

    await runPool(targets, concurrency || 5, async (k) => {
      const r = await fetchCredits(k.key);
      log.debug('credits', `key「${k.name || maskKey(k.key)}」→ ${r.status} balance=${r.balance ?? '—'}${r.error ? ' err=' + r.error : ''}`);
      store.update(k.id, {
        balance: r.balance,
        totalUsed: r.totalUsed,
        status: r.status,
        lastError: r.error || '',
        lastChecked: Date.now(),
      });
    });
    log.info('admin', `刷新额度完成：${targets.length} 个（并发 ${concurrency || 5}）`);
    res.json({ checked: targets.length, items: targets.map((k) => publicView(store.getById(k.id))) });
  });

  // 激活选中 key：对每个 key 调用 zai/glm-5.2 发送一条极短测试消息，触发上游激活。
  // body: { ids: string[], concurrency?: number }
  router.post('/keys/activate', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: { message: '缺少 ids' } });
    const concurrency = req.body?.concurrency || 3;
    const targets = store.list().filter((k) => ids.includes(k.id));
    if (targets.length === 0) return res.status(404).json({ error: { message: '未找到任何选中的 key' } });

    const results = await runPool(targets, concurrency, async (k) => {
      const label = k.name || maskKey(k.key);
      try {
        const upstream = await forward(k.key, '/chat/completions', ACTIVATE_BODY, {
          method: 'POST',
          timeoutMs: 60000,
        });
        const text = await upstream.text().catch(() => '');
        let snippet = '';
        try {
          const data = JSON.parse(text);
          snippet = data?.choices?.[0]?.message?.content
            || data?.error?.message
            || text.slice(0, 160);
        } catch {
          snippet = text.slice(0, 160);
        }

        if (upstream.ok) {
          store.update(k.id, {
            requests: (k.requests || 0) + 1,
            lastUsed: Date.now(),
            lastError: '',
            // 能跑通 chat 说明 key 可用；保留 low（额度不足但 key 本身有效）
            status: k.status === 'low' ? 'low' : 'ok',
          });
          log.info('admin', `激活成功 key「${label}」→ ${upstream.status} model=${ACTIVATE_MODEL}`);
          return {
            id: k.id,
            keyMasked: maskKey(k.key),
            name: k.name || '',
            ok: true,
            status: upstream.status,
            message: String(snippet || 'ok').slice(0, 200),
          };
        }

        // 鉴权失败 → invalid；402 → low；其它记 error
        const patch = { failures: (k.failures || 0) + 1, lastError: `激活失败 HTTP ${upstream.status}` };
        if (upstream.status === 401 || upstream.status === 403) patch.status = 'invalid';
        else if (upstream.status === 402) patch.status = 'low';
        else if (k.status === 'unknown') patch.status = 'error';
        store.update(k.id, patch);
        log.warn('admin', `激活失败 key「${label}」→ ${upstream.status} ${snippet}`);
        return {
          id: k.id,
          keyMasked: maskKey(k.key),
          name: k.name || '',
          ok: false,
          status: upstream.status,
          message: String(snippet || `HTTP ${upstream.status}`).slice(0, 200),
        };
      } catch (err) {
        const msg = String(err.message || err);
        store.update(k.id, {
          failures: (k.failures || 0) + 1,
          lastError: `激活异常：${msg}`,
          status: k.status === 'unknown' ? 'error' : k.status,
        });
        log.warn('admin', `激活异常 key「${label}」：${msg}`);
        return {
          id: k.id,
          keyMasked: maskKey(k.key),
          name: k.name || '',
          ok: false,
          status: 0,
          message: msg.slice(0, 200),
        };
      }
    });

    const items = results.map((r) => (r.ok ? r.value : {
      id: '?',
      ok: false,
      status: 0,
      message: String(r.error?.message || r.error || '内部错误'),
    }));
    const succeeded = items.filter((i) => i.ok).length;
    const failed = items.length - succeeded;
    log.info('admin', `激活完成：成功 ${succeeded}，失败 ${failed}（共 ${items.length}，并发 ${concurrency}，模型 ${ACTIVATE_MODEL}）`);
    res.json({
      model: ACTIVATE_MODEL,
      total: items.length,
      succeeded,
      failed,
      items,
    });
  });

  // 批量额度充值：对 status=low 的 key 用 zai/glm-5.2 测活。
  // 402 = 月额度未刷新，保持不变；403/200 = 已刷新，再拉最新额度。
  router.post('/keys/recharge', async (req, res) => {
    const concurrency = req.body?.concurrency || 5;
    const targets = store.list().filter((k) => k.status === 'low');
    if (targets.length === 0) {
      return res.json({
        model: ACTIVATE_MODEL,
        total: 0,
        refreshed: 0,
        pending: 0,
        failed: 0,
        items: [],
      });
    }

    const results = await runPool(targets, concurrency, async (k) => {
      const label = k.name || maskKey(k.key);
      try {
        const upstream = await forward(k.key, '/chat/completions', ACTIVATE_BODY, {
          method: 'POST',
          timeoutMs: 60000,
        });
        const text = await upstream.text().catch(() => '');
        let snippet = '';
        try {
          const data = JSON.parse(text);
          snippet = data?.error?.message || data?.choices?.[0]?.message?.content || text.slice(0, 160);
        } catch {
          snippet = text.slice(0, 160);
        }

        if (upstream.status === 402) {
          store.update(k.id, { lastError: '月额度未刷新 (402)', lastChecked: Date.now() });
          log.info('admin', `充值跳过 key「${label}」→ 402 月额度未刷新`);
          return {
            id: k.id,
            keyMasked: maskKey(k.key),
            name: k.name || '',
            action: 'pending',
            status: 402,
            message: String(snippet || '月额度未刷新').slice(0, 200),
          };
        }

        if (upstream.status === 403 || upstream.ok) {
          const credits = await fetchCredits(k.key);
          store.update(k.id, {
            balance: credits.balance,
            totalUsed: credits.totalUsed,
            status: credits.status,
            lastError: credits.error || '',
            lastChecked: Date.now(),
            lastUsed: Date.now(),
            requests: (k.requests || 0) + 1,
          });
          log.info('admin', `充值刷新 key「${label}」→ probe=${upstream.status} credits=${credits.status} balance=${credits.balance ?? '—'}`);
          return {
            id: k.id,
            keyMasked: maskKey(k.key),
            name: k.name || '',
            action: 'refreshed',
            status: upstream.status,
            creditsStatus: credits.status,
            balance: credits.balance,
            message: String(snippet || 'ok').slice(0, 200),
          };
        }

        if (upstream.status === 401) {
          store.update(k.id, {
            failures: (k.failures || 0) + 1,
            lastError: `充值失败 HTTP ${upstream.status}`,
            status: 'invalid',
            lastChecked: Date.now(),
          });
        } else {
          store.update(k.id, {
            failures: (k.failures || 0) + 1,
            lastError: `充值失败 HTTP ${upstream.status}`,
            lastChecked: Date.now(),
          });
        }
        log.warn('admin', `充值失败 key「${label}」→ ${upstream.status} ${snippet}`);
        return {
          id: k.id,
          keyMasked: maskKey(k.key),
          name: k.name || '',
          action: 'failed',
          status: upstream.status,
          message: String(snippet || `HTTP ${upstream.status}`).slice(0, 200),
        };
      } catch (err) {
        const msg = String(err.message || err);
        store.update(k.id, {
          failures: (k.failures || 0) + 1,
          lastError: `充值异常：${msg}`,
        });
        log.warn('admin', `充值异常 key「${label}」：${msg}`);
        return {
          id: k.id,
          keyMasked: maskKey(k.key),
          name: k.name || '',
          action: 'failed',
          status: 0,
          message: msg.slice(0, 200),
        };
      }
    });

    const items = results.map((r) => (r.ok ? r.value : {
      id: '?',
      action: 'failed',
      status: 0,
      message: String(r.error?.message || r.error || '内部错误'),
    }));
    const refreshed = items.filter((i) => i.action === 'refreshed').length;
    const pending = items.filter((i) => i.action === 'pending').length;
    const failed = items.filter((i) => i.action === 'failed').length;
    log.info('admin', `批量充值完成：刷新 ${refreshed}，未刷新 ${pending}，失败 ${failed}（共 ${items.length}，并发 ${concurrency}）`);
    res.json({
      model: ACTIVATE_MODEL,
      total: items.length,
      refreshed,
      pending,
      failed,
      items,
    });
  });

  // 一键删除额度不足 / 失效的 key。先刷新一遍再删除。
  router.post('/keys/prune', async (req, res) => {
    const threshold = req.body?.threshold !== undefined ? Number(req.body.threshold) : config.lowBalanceThreshold;
    const concurrency = req.body?.concurrency || 5;
    const refresh = req.body?.refresh !== false; // 默认先刷新

    if (refresh) {
      await runPool(store.list(), concurrency, async (k) => {
        const r = await fetchCredits(k.key);
        store.update(k.id, {
          balance: r.balance,
          totalUsed: r.totalUsed,
          status: r.status,
          lastError: r.error || '',
          lastChecked: Date.now(),
        });
      });
    }

    const toDelete = store.list().filter((k) => {
      if (k.status === 'invalid') return true;
      if (k.balance !== null && k.balance <= threshold) return true;
      return false;
    });
    const ids = toDelete.map((k) => k.id);
    const removed = store.remove(ids);
    log.info('admin', `一键清理：删除 ${removed} 个额度不足/失效的 key（阈值 $${threshold}）`);
    res.json({ removed, deleted: toDelete.map((k) => ({ id: k.id, keyMasked: maskKey(k.key), balance: k.balance, status: k.status })) });
  });

  attachImageRoutes(router);

  return router;
}
