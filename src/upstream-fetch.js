import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from './config.js';

const proxyAgent = config.upstreamProxyUrl ? new SocksProxyAgent(config.upstreamProxyUrl) : undefined;

export function upstreamFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const target = new URL(url);
  const client = target.protocol === 'http:' ? http : https;
  const requestHeaders = { ...headers };

  if (body !== undefined && !hasHeader(requestHeaders, 'content-length')) {
    requestHeaders['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || abortError());

    const req = client.request(target, {
      method,
      headers: requestHeaders,
      agent: proxyAgent,
    }, (res) => {
      const response = new Response(Readable.toWeb(res), {
        status: res.statusCode || 0,
        statusText: res.statusMessage,
        headers: res.headers,
      });
      resolve(response);
    });

    const onAbort = () => {
      req.destroy(signal.reason || abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', reject);
    req.on('close', () => signal?.removeEventListener('abort', onAbort));

    if (body !== undefined) req.write(body);
    req.end();
  });
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}
