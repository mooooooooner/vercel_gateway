import { EventEmitter } from 'node:events';
import { config } from './config.js';

const MAX_BUFFER = 800;

class Logger extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.buffer = [];
    this.seq = 0;
    this.debugEnabled = config.debug;
  }

  setDebug(on) {
    this.debugEnabled = Boolean(on);
    this._emit('info', 'system', `Debug 模式已${this.debugEnabled ? '开启' : '关闭'}`);
    return this.debugEnabled;
  }

  _emit(level, scope, msg, meta) {
    const entry = { id: ++this.seq, ts: Date.now(), level, scope, msg };
    if (meta !== undefined) entry.meta = meta;
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);

    // 控制台输出
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    const time = new Date(entry.ts).toISOString().slice(11, 23);
    fn(`[${time}] ${level.toUpperCase().padEnd(5)} ${scope} · ${msg}${meta !== undefined ? ' ' + safeJson(meta) : ''}`);

    this.emit('log', entry);
    return entry;
  }

  info(scope, msg, meta) { return this._emit('info', scope, msg, meta); }
  warn(scope, msg, meta) { return this._emit('warn', scope, msg, meta); }
  error(scope, msg, meta) { return this._emit('error', scope, msg, meta); }
  debug(scope, msg, meta) {
    if (!this.debugEnabled) return null;
    return this._emit('debug', scope, msg, meta);
  }

  recent(limit = 300) {
    return this.buffer.slice(-limit);
  }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const log = new Logger();
