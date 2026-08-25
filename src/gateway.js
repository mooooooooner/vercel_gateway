import { config } from './config.js';
import { upstreamFetch } from './upstream-fetch.js';

/** 简单的并发池：对 items 逐个执行 worker，最多同时运行 concurrency 个。 */
export async function runPool(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, 64));
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/**
 * 查询单个 key 的额度。返回 { balance, totalUsed, status, error }。
 * status: ok | low | invalid | error
 */
export async function fetchCredits(key, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await upstreamFetch(config.creditsUrl, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { balance: null, totalUsed: null, status: 'invalid', error: `鉴权失败 (${res.status})` };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { balance: null, totalUsed: null, status: 'error', error: `HTTP ${res.status} ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    const balance = toNumber(data.balance ?? data.available ?? data.remaining);
    const totalUsed = toNumber(data.total_used ?? data.totalUsed ?? data.used);
    const status = balance !== null && balance <= config.lowBalanceThreshold ? 'low' : 'ok';
    return { balance, totalUsed, status, error: '' };
  } catch (err) {
    const msg = err.name === 'AbortError' ? '请求超时' : String(err.message || err);
    return { balance: null, totalUsed: null, status: 'error', error: msg };
  } finally {
    clearTimeout(t);
  }
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 向上游转发 OpenAI 兼容请求。返回原始 fetch Response（便于流式透传）。
 * @param {string} key
 * @param {string} pathName 例如 /chat/completions
 * @param {object} body
 */
export async function forward(key, pathName, body, { method = 'POST', timeoutMs = 300000, extraHeaders = {} } = {}) {
  const url = `${config.gatewayBaseUrl}${pathName}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
    for (const [name, value] of Object.entries(extraHeaders || {})) {
      if (value == null || value === '') continue;
      headers[name] = value;
    }
    const res = await upstreamFetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}
