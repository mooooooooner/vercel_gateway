import express from 'express';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { createAdminRouter } from './admin.js';
import { createProxyRouter } from './proxy.js';
import { proxyKeyStore } from './proxy-keys.js';
import { log } from './logger.js';

const app = express();
app.use(express.json({ limit: '100mb' }));

// 静态前端
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// 健康检查
app.get('/healthz', (req, res) => res.json({ ok: true }));

// 是否需要鉴权（供前端判断）
app.get('/api/meta', (req, res) => {
  res.json({
    requiresAdminToken: Boolean(config.adminToken),
    proxyAuthEnabled: proxyKeyStore.count() > 0,
    gatewayBaseUrl: config.gatewayBaseUrl,
    lowBalanceThreshold: config.lowBalanceThreshold,
    debug: log.debugEnabled,
  });
});

// 日志实时流（SSE）。EventSource 无法设置请求头，故令牌用查询参数 ?token= 校验。
app.get('/api/logs/stream', (req, res) => {
  if (config.adminToken && req.query.token !== config.adminToken) {
    return res.status(401).json({ error: { message: '管理令牌无效或缺失' } });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  // 先补发最近历史
  for (const entry of log.recent(200)) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const onLog = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
  log.on('log', onLog);
  const ka = setInterval(() => res.write(': keep-alive\n\n'), 25000);

  req.on('close', () => {
    clearInterval(ka);
    log.off('log', onLog);
  });
});

// 管理 API
app.use('/api', createAdminRouter());

// OpenAI 兼容代理
app.use('/v1', createProxyRouter());

app.use((err, req, res, next) => {
  log.error('server', String(err.message || err));
  if (res.headersSent) return next(err);
  res.status(500).json({ error: { message: String(err.message || err) } });
});

const httpsEnabled = Boolean(config.httpsKeyFile && config.httpsCertFile);
const server = httpsEnabled
  ? https.createServer({
      key: fs.readFileSync(config.httpsKeyFile),
      cert: fs.readFileSync(config.httpsCertFile),
    }, app)
  : app;
const protocol = httpsEnabled ? 'https' : 'http';

// 退出前把未落盘的代理 Key 统计写回（exit 回调里只能做同步操作，saveNow 为同步写）
process.on('exit', () => proxyKeyStore.flush());
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    proxyKeyStore.flush();
    process.exit(0);
  });
}

server.listen(config.port, () => {
  console.log(`\n  Vercel Gateway Manager 已启动`);
  console.log(`  ▸ 管理后台:  ${protocol}://localhost:${config.port}`);
  console.log(`  ▸ 代理端点:  ${protocol}://localhost:${config.port}/v1`);
  console.log(`  ▸ 上游地址:  ${config.gatewayBaseUrl}`);
  if (config.upstreamProxyUrl) console.log(`  ▸ 上游代理:  ${config.upstreamProxyUrl}`);
  console.log(`  ▸ 代理 Key:  ${proxyKeyStore.count()} 个（后台「代理 Key」页管理）`);
  if (!config.adminToken) console.log('  ⚠ 未设置 ADMIN_TOKEN，管理后台无鉴权！');
  if (proxyKeyStore.count() === 0) console.log('  ⚠ 未配置任何代理 Key，代理接口无鉴权！');
  console.log('');
  log.info('system', `服务已启动，${protocol.toUpperCase()} 端口 ${config.port}，Debug=${config.debug ? '开' : '关'}`);
});
