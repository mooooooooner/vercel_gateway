import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const KEYS_FILE = path.join(config.dataDir, 'keys.json');
const SETTINGS_FILE = path.join(config.dataDir, 'settings.json');

const DEFAULT_SETTINGS = {
  // 负载均衡策略：round-robin（轮询）| least-used（最少使用）| random（随机）
  //             | highest-balance（余额优先）| lowest-balance（低额度优先，429 依次回退到次低）
  strategy: 'round-robin',
  // 按模型注入的请求体参数。客户端未带同名顶层字段时才补上。
  modelParams: {},
};

function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...raw };
  delete settings.defaultParams;
  if (!settings.modelParams || typeof settings.modelParams !== 'object' || Array.isArray(settings.modelParams)) {
    settings.modelParams = {};
  }
  return settings;
}

function ensureDir() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return structuredClone(fallback);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJsonAtomic(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
    ensureDir();
    this.keys = readJson(KEYS_FILE, []);
    const loaded = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
    this.settings = normalizeSettings(loaded);
    this.rrIndex = 0;
    if ('defaultParams' in loaded) this.saveSettings();
  }

  saveKeys() {
    writeJsonAtomic(KEYS_FILE, this.keys);
  }

  saveSettings() {
    writeJsonAtomic(SETTINGS_FILE, this.settings);
  }

  // ---- keys ----
  list() {
    return this.keys;
  }

  getById(id) {
    return this.keys.find((k) => k.id === id);
  }

  /**
   * 批量添加。传入原始 key 字符串数组，自动去重（已存在的跳过）。
   * @returns {{added:number, skipped:number, items:object[]}}
   */
  addMany(rawKeys, namePrefix = '') {
    const existing = new Set(this.keys.map((k) => k.key));
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
      const item = {
        id: crypto.randomUUID(),
        key,
        name: namePrefix ? `${namePrefix}-${added + 1}` : '',
        enabled: true,
        balance: null,
        totalUsed: null,
        status: 'unknown', // unknown | ok | low | invalid | error
        lastChecked: null,
        lastError: '',
        requests: 0,
        failures: 0,
        lastUsed: null,
        cooldownUntil: null, // 429 限流后的冷却截止时间戳；早于当前时间即已解除
        createdAt: Date.now(),
      };
      this.keys.push(item);
      items.push(item);
      added++;
    }
    if (added) this.saveKeys();
    return { added, skipped, items };
  }

  remove(ids) {
    const set = new Set(ids);
    const before = this.keys.length;
    this.keys = this.keys.filter((k) => !set.has(k.id));
    const removed = before - this.keys.length;
    if (removed) this.saveKeys();
    return removed;
  }

  update(id, patch) {
    const k = this.getById(id);
    if (!k) return null;
    Object.assign(k, patch);
    this.saveKeys();
    return k;
  }

  // 选取一个可用 key（enabled 且状态非 invalid/low）用于代理转发。
  pickCandidates() {
    return this.keys.filter((k) => k.enabled && k.status !== 'invalid' && k.status !== 'low');
  }

  nextKey(exclude = new Set()) {
    const candidates = this.pickCandidates().filter((k) => !exclude.has(k.id));
    if (candidates.length === 0) return null;
    // 优先排除处于冷却期（近期 429 限流）的 key；若候选全部在冷却中，则退而用之，避免请求硬失败。
    const now = Date.now();
    let pool = candidates.filter((k) => !(k.cooldownUntil && k.cooldownUntil > now));
    if (pool.length === 0) pool = candidates;
    const strat = this.settings.strategy;
    if (strat === 'random') {
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (strat === 'least-used') {
      return pool.reduce((a, b) => (b.requests < a.requests ? b : a));
    }
    if (strat === 'highest-balance') {
      return pool.reduce((a, b) => ((b.balance ?? -Infinity) > (a.balance ?? -Infinity) ? b : a));
    }
    // lowest-balance：优先额度最低的 key；配合 proxy 的重试循环，若最低者遇到 429
    // 会被排除后自然回退到次低、第三低……余额未知（null）的 key 排到最后。
    if (strat === 'lowest-balance') {
      return pool.reduce((a, b) => ((b.balance ?? Infinity) < (a.balance ?? Infinity) ? b : a));
    }
    // round-robin（默认）
    this.rrIndex = (this.rrIndex + 1) % pool.length;
    return pool[this.rrIndex % pool.length];
  }

  // ---- settings ----
  getSettings() {
    return this.settings;
  }

  setSettings(patch) {
    if (patch.strategy) this.settings.strategy = patch.strategy;
    if (patch.modelParams && typeof patch.modelParams === 'object' && !Array.isArray(patch.modelParams)) {
      this.settings.modelParams = patch.modelParams;
    }
    this.saveSettings();
    return this.settings;
  }
}

export const store = new Store();

// 对外展示时脱敏 key
export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 2)}****`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
