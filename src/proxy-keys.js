import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './logger.js';

const FILE = path.join(config.dataDir, 'proxy-keys.json');
const SAVE_DEBOUNCE_MS = 3000;

function ensureDir() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
}

function loadRaw() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function normalize(k) {
  return {
    id: String(k.id || crypto.randomUUID()),
    key: String(k.key || ''),
    name: String(k.name || ''),
    enabled: k.enabled !== false,
    createdAt: Number(k.createdAt) || Date.now(),
    lastUsed: k.lastUsed ?? null,
    requests: Number(k.requests) || 0,
    failures: Number(k.failures) || 0,
    promptTokens: Number(k.promptTokens) || 0,
    completionTokens: Number(k.completionTokens) || 0,
    cachedTokens: Number(k.cachedTokens) || 0,
    cost: Number(k.cost) || 0,
  };
}

function writeJsonAtomic(data) {
  ensureDir();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function randomKey() {
  return `sk-gw-${crypto.randomBytes(18).toString('base64url')}`;
}

class ProxyKeyStore {
  constructor() {
    ensureDir();
    this.items = loadRaw().map(normalize).filter((k) => k.key);
    this._saveTimer = null;
    this.seedFromEnv();
  }

  // 用 .env 的 PROXY_API_KEYS 做种子：缺失的补入，保证旧配置无缝迁移。
  seedFromEnv() {
    const existing = new Set(this.items.map((k) => k.key));
    const missing = config.proxyApiKeys.filter((k) => !existing.has(k));
    if (missing.length === 0) return;
    for (const key of missing) {
      this.items.push(normalize({ key, name: '', createdAt: Date.now() }));
    }
    this.saveNow();
    log.info('system', `已从 PROXY_API_KEYS 迁移 ${missing.length} 个代理 Key 到 data/proxy-keys.json`);
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    writeJsonAtomic(this.items);
  }

  // 统计更新走防抖落盘，避免每个请求都写磁盘。
  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        this.saveNow();
      } catch (err) {
        log.error('proxy-keys', `落盘失败：${err.message}`);
      }
    }, SAVE_DEBOUNCE_MS);
    this._saveTimer.unref?.();
  }

  flush() {
    if (!this._saveTimer) return;
    try {
      this.saveNow();
    } catch {}
  }

  list() {
    return this.items;
  }

  count() {
    return this.items.length;
  }

  getById(id) {
    return this.items.find((k) => k.id === id);
  }

  // 校验代理请求令牌，仅启用中的 key 有效。
  verify(token) {
    if (!token) return null;
    const k = this.items.find((x) => x.key === token);
    return k && k.enabled ? k : null;
  }

  addMany(rawKeys, namePrefix = '') {
    const existing = new Set(this.items.map((k) => k.key));
    let added = 0;
    let skipped = 0;
    const items = [];
    for (const raw of rawKeys) {
      const key = String(raw).trim();
      if (!key) continue;
      if (existing.has(key)) {
        skipped++;
        continue;
      }
      existing.add(key);
      const item = normalize({
        key,
        name: namePrefix ? `${namePrefix}-${added + 1}` : '',
        createdAt: Date.now(),
      });
      this.items.push(item);
      items.push(item);
      added++;
    }
    if (added) this.saveNow();
    return { added, skipped, items };
  }

  // 随机生成 n 个代理 Key（sk-gw- 前缀）。
  generate(n, namePrefix = '') {
    const count = Math.max(1, Math.min(50, Math.floor(Number(n) || 0)));
    const base = this.items.length;
    const items = [];
    for (let i = 0; i < count; i++) {
      const item = normalize({
        key: randomKey(),
        name: namePrefix ? `${namePrefix}-${base + i + 1}` : '',
        createdAt: Date.now(),
      });
      this.items.push(item);
      items.push(item);
    }
    this.saveNow();
    return { added: count, items };
  }

  remove(ids) {
    const set = new Set(ids);
    const before = this.items.length;
    this.items = this.items.filter((k) => !set.has(k.id));
    const removed = before - this.items.length;
    if (removed) this.saveNow();
    return removed;
  }

  update(id, patch) {
    const k = this.getById(id);
    if (!k) return null;
    if (typeof patch.enabled === 'boolean') k.enabled = patch.enabled;
    if (typeof patch.name === 'string') k.name = patch.name;
    this.saveNow();
    return k;
  }

  resetStats(ids) {
    const targets = Array.isArray(ids) && ids.length ? this.items.filter((k) => ids.includes(k.id)) : this.items;
    for (const k of targets) {
      k.requests = 0;
      k.failures = 0;
      k.promptTokens = 0;
      k.completionTokens = 0;
      k.cachedTokens = 0;
      k.cost = 0;
    }
    if (targets.length) this.saveNow();
    return targets.length;
  }

  // 代理请求成功后累计用量。usage: { promptTokens, completionTokens, cachedTokens, cost } | null
  recordUsage(id, usage) {
    const k = this.getById(id);
    if (!k) return;
    k.requests += 1;
    k.lastUsed = Date.now();
    if (usage) {
      k.promptTokens += usage.promptTokens || 0;
      k.completionTokens += usage.completionTokens || 0;
      k.cachedTokens += usage.cachedTokens || 0;
      if (usage.cost) k.cost = Math.round((k.cost + usage.cost) * 1e6) / 1e6;
    }
    this.scheduleSave();
  }

  recordFailure(id) {
    const k = this.getById(id);
    if (!k) return;
    k.failures += 1;
    k.lastUsed = Date.now();
    this.scheduleSave();
  }
}

export const proxyKeyStore = new ProxyKeyStore();
