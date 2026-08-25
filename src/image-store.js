import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const HISTORY_FILE = path.join(config.dataDir, 'image-history.json');
const IMAGES_DIR = path.join(config.dataDir, 'images');

function ensureDir() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
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

function extFromMedia(mediaType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return map[String(mediaType || '').toLowerCase()] || 'png';
}

class ImageStore {
  constructor() {
    ensureDir();
    const loaded = readJson(HISTORY_FILE, []);
    this.items = Array.isArray(loaded) ? loaded : [];
  }

  save() {
    writeJsonAtomic(HISTORY_FILE, this.items);
  }

  list() {
    return [...this.items].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  getById(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  add(entry) {
    this.items.push(entry);
    this.save();
    return entry;
  }

  saveFile(id, index, buffer, mediaType, kind = 'out') {
    ensureDir();
    const ext = extFromMedia(mediaType);
    const prefix = kind === 'ref' ? `${id}-ref` : id;
    const filename = `${prefix}-${index}.${ext}`;
    fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);
    return { filename, mediaType: mediaType || 'image/png', bytes: buffer.length };
  }

  readFile(filename) {
    const safe = path.basename(String(filename || ''));
    if (!safe || safe !== filename) return null;
    const full = path.join(IMAGES_DIR, safe);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full);
  }

  remove(id) {
    const item = this.getById(id);
    if (!item) return false;
    const toDelete = [...(item.files || []), ...(item.references || [])];
    for (const file of toDelete) {
      const full = path.join(IMAGES_DIR, path.basename(file.filename));
      try { fs.unlinkSync(full); } catch { /* 文件缺失不影响删除元数据 */ }
    }
    this.items = this.items.filter((entry) => entry.id !== id);
    this.save();
    return true;
  }
}

export const imageStore = new ImageStore();
