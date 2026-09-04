import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// 极简 .env 加载器（避免额外依赖）。已存在的 process.env 优先。
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

function splitList(v) {
  return (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT) || 8787,
  httpsKeyFile: process.env.HTTPS_KEY_FILE || '',
  httpsCertFile: process.env.HTTPS_CERT_FILE || '',
  adminToken: process.env.ADMIN_TOKEN || '',
  proxyApiKeys: splitList(process.env.PROXY_API_KEYS),
  gatewayBaseUrl: (process.env.GATEWAY_BASE_URL || 'https://ai-gateway.vercel.sh/v1').replace(/\/$/, ''),
  creditsUrl: process.env.GATEWAY_CREDITS_URL || 'https://ai-gateway.vercel.sh/v1/credits',
  upstreamProxyUrl: process.env.UPSTREAM_PROXY_URL || '',
  lowBalanceThreshold: Number(process.env.LOW_BALANCE_THRESHOLD ?? 0.01),
  debug: /^(1|true|yes|on)$/i.test(process.env.DEBUG || ''),
  // 数据目录可用 DATA_DIR 覆盖（默认 <项目根>/data）
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'),
};
