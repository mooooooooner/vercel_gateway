import crypto from 'node:crypto';
import { imageStore } from './image-store.js';
import { forwardWithFailover } from './proxy.js';
import { upstreamFetch } from './upstream-fetch.js';
import { log } from './logger.js';

export const DEFAULT_IMAGE_MODEL = 'bytedance/seedream-5.0-pro';
const MAX_REFERENCES = 8;
const MAX_REF_BYTES = 8 * 1024 * 1024;

function publicFile(item, file, index, kind) {
  const qs = kind === 'ref' ? `kind=ref&index=${index}` : `index=${index}`;
  return {
    index,
    mediaType: file.mediaType,
    bytes: file.bytes,
    url: `/api/images/${item.id}/file?${qs}`,
  };
}

function publicItem(item) {
  return {
    id: item.id,
    createdAt: item.createdAt,
    prompt: item.prompt,
    model: item.model,
    size: item.size,
    n: item.n,
    files: (item.files || []).map((file, index) => publicFile(item, file, index, 'out')),
    references: (item.references || []).map((file, index) => publicFile(item, file, index, 'ref')),
  };
}

function sniffMedia(buf) {
  if (!buf || buf.length < 12) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

function parseDataUrl(url) {
  const m = String(url || '').match(/^data:([^;,]+);base64,(.+)$/i);
  if (!m) return null;
  const buffer = Buffer.from(m[2], 'base64');
  return { mediaType: m[1] || sniffMedia(buffer), buffer };
}

async function downloadImage(url) {
  const res = await upstreamFetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`下载上游图片失败 HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const headerType = (res.headers.get('content-type') || '').split(';')[0].trim();
  const mediaType = headerType.startsWith('image/') ? headerType : sniffMedia(buffer);
  return { mediaType, buffer };
}

async function extractGeneratedImages(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const images = [];
  for (const row of rows) {
    if (row?.b64_json) {
      const buffer = Buffer.from(row.b64_json, 'base64');
      images.push({ mediaType: sniffMedia(buffer), buffer });
      continue;
    }
    if (row?.url) {
      const parsed = parseDataUrl(row.url);
      if (parsed) {
        images.push(parsed);
        continue;
      }
      if (/^https?:\/\//i.test(row.url)) {
        images.push(await downloadImage(row.url));
      }
    }
  }
  return images;
}

function decodeReference(raw, index) {
  const label = `参考图 ${index + 1}`;
  if (typeof raw === 'string') {
    const parsed = parseDataUrl(raw);
    if (!parsed) throw new Error(`${label} 不是有效的 data URL`);
    return parsed;
  }
  if (!raw || typeof raw !== 'object') throw new Error(`${label} 格式无效`);
  const mediaType = String(raw.mediaType || raw.type || '').trim();
  const b64 = String(raw.b64 || raw.b64_json || raw.data || '').replace(/\s+/g, '');
  if (!b64) throw new Error(`${label} 缺少图片数据`);
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) throw new Error(`${label} 解码失败`);
  return { mediaType: mediaType || sniffMedia(buffer), buffer };
}

function parseReferences(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('references 必须为数组');
  if (input.length > MAX_REFERENCES) throw new Error(`参考图最多 ${MAX_REFERENCES} 张`);
  return input.map((raw, i) => {
    const img = decodeReference(raw, i);
    if (img.buffer.length > MAX_REF_BYTES) throw new Error(`参考图 ${i + 1} 超过 8MB`);
    if (!String(img.mediaType).startsWith('image/')) {
      img.mediaType = sniffMedia(img.buffer);
    }
    return img;
  });
}

function toDataUrl(img) {
  return `data:${img.mediaType || 'image/png'};base64,${img.buffer.toString('base64')}`;
}

export function attachImageRoutes(router) {
  router.get('/images', (req, res) => {
    res.json({ items: imageStore.list().map(publicItem) });
  });

  router.get('/images/:id/file', (req, res) => {
    const item = imageStore.getById(req.params.id);
    if (!item) return res.status(404).json({ error: { message: '未找到该记录' } });
    const index = Number(req.query.index || 0);
    const list = req.query.kind === 'ref' ? item.references : item.files;
    const file = list?.[index];
    if (!file) return res.status(404).json({ error: { message: '未找到该图片' } });
    const buf = imageStore.readFile(file.filename);
    if (!buf) return res.status(404).json({ error: { message: '图片文件不存在' } });
    res.setHeader('Content-Type', file.mediaType || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  });

  router.delete('/images/:id', (req, res) => {
    const ok = imageStore.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: { message: '未找到该记录' } });
    log.info('images', `删除生成记录 ${req.params.id}`);
    res.json({ removed: 1 });
  });

  router.post('/images/generate', async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: { message: '请输入提示词' } });

    const model = String(req.body?.model || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
    const size = String(req.body?.size || '2K').trim() || '2K';
    const nRaw = Number(req.body?.n);
    const n = Number.isFinite(nRaw) ? Math.min(4, Math.max(1, Math.round(nRaw))) : 1;

    let references;
    try {
      references = parseReferences(req.body?.references);
    } catch (err) {
      return res.status(400).json({ error: { message: String(err.message || err) } });
    }

    const body = {
      model,
      prompt,
      n,
      size,
      response_format: 'b64_json',
    };
    const pathName = references.length ? '/images/edits' : '/images/generations';
    if (references.length) {
      body.images = references.map((img) => ({ image_url: toDataUrl(img) }));
    }

    const result = await forwardWithFailover(pathName, body, {
      scope: 'images',
      timeoutMs: 300000,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: { message: result.message, type: 'gateway_error' } });
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.from(await result.response.arrayBuffer()).toString('utf8'));
    } catch {
      return res.status(502).json({ error: { message: '上游返回的不是有效 JSON' } });
    }
    if (!result.response.ok) {
      const msg = payload?.error?.message || payload?.message || `上游返回 HTTP ${result.status}`;
      return res.status(result.status).json({ error: { message: String(msg) } });
    }

    let images;
    try {
      images = await extractGeneratedImages(payload);
    } catch (err) {
      return res.status(502).json({ error: { message: String(err.message || err) } });
    }
    if (images.length === 0) {
      return res.status(502).json({ error: { message: '上游未返回图片数据' } });
    }

    const id = crypto.randomUUID();
    const files = images.map((img, i) => imageStore.saveFile(id, i, img.buffer, img.mediaType));
    const savedRefs = references.map((img, i) => imageStore.saveFile(id, i, img.buffer, img.mediaType, 'ref'));
    const entry = imageStore.add({
      id,
      createdAt: Date.now(),
      prompt,
      model,
      size,
      n,
      files,
      references: savedRefs,
      keyId: result.key.id,
    });
    log.info('images', `生成成功 model=${model} files=${files.length} refs=${savedRefs.length} id=${id}`);
    res.json(publicItem(entry));
  });
}
