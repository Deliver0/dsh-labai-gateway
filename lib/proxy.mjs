/**
 * 实验室 AI 网关 · DSH 插件的本地代理
 *
 * 同学工具里永远填 http://127.0.0.1:8801，本代理负责：
 *   1. 自动发现网关当前 IP（缓存 → 已知地址 → 分层网段探测）
 *   2. 注入本人的 API Key（Key 存在本机文件里，工具里不用填）
 *   3. 原样转发请求/响应，SSE 流式不缓冲
 *
 * 只用 Node 内置模块，没有第三方依赖。可独立运行：
 *   node proxy.mjs --once                 只发现一次并打印地址
 *   node proxy.mjs --port 8801           启动代理
 *   node proxy.mjs --config <file>       指定配置文件（测试隔离用）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = Object.freeze({
  listenPort: 8801,
  gatewayPort: 8800,
  // 网关 /healthz 必须返回同样的 lab 字段，避免误连到别人开在 8800 上的服务
  labId: 'lab-ai-gateway-v1',
  // 上次已知地址优先；网关换 IP 后这些会全部失效，再按网段找
  seedIps: ['10.16.35.100'],
  // 分层：先扫当前 /24（256 个），找不到再扫校园网 DHCP 池常见的 /20（4096 个）
  scanNets: ['10.16.35.0/24', '10.16.32.0/20'],
  probeTimeoutMs: 500,
  concurrency: 96,
  cacheTtlSec: 60,
  // 本人的 Key 存本机文件里，DSH 里不用填；代理转发时注入
  apiKey: '',
  overrideAuth: true,
});

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.labai', 'dsh.json');
export const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.labai', 'dsh-gateway.json');

export function readConfig(extra = {}, file = DEFAULT_CONFIG_PATH) {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 还没有配置文件就用默认值
  }
  return { ...DEFAULTS, ...stored, ...extra };
}

export function writeConfig(patch, file = DEFAULT_CONFIG_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readConfig({}, file), ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function ipToInt(ip) {
  return String(ip).split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

export function intToIp(n) {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
}

/** 支持 /32（单地址）、/24、/20 等，返回该网段全部地址。 */
export function expandCidr(cidr) {
  const [base, bitsRaw] = String(cidr).trim().split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return [];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const start = (ipToInt(base) & mask) >>> 0;
  const size = 2 ** (32 - bits);
  const out = [];
  for (let i = 0; i < size; i += 1) out.push(intToIp((start + i) >>> 0));
  return out;
}

/** 只认带实验室标识的 /healthz，避免连到别人开在 8800 上的服务。 */
export async function probe(ip, cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.probeTimeoutMs);
  try {
    const res = await fetch(`http://${ip}:${cfg.gatewayPort}/healthz`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ok === true && data.lab === cfg.labId ? ip : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function firstHit(ips, cfg) {
  const size = Math.max(1, cfg.concurrency);
  for (let i = 0; i < ips.length; i += size) {
    const batch = ips.slice(i, i + size);
    const results = await Promise.all(batch.map((ip) => probe(ip, cfg)));
    const hit = results.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

export class GatewayFinder {
  constructor(cfg, cacheFile = DEFAULT_CACHE_PATH) {
    this.cfg = cfg;
    this.cacheFile = cacheFile;
    this.ip = null;
    this.checkedAt = 0;
    this.pending = null;
    this.lastError = '';
    this.loadCache();
  }

  loadCache() {
    try {
      const cached = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (cached && cached.ip && cached.labId === this.cfg.labId) {
        this.ip = cached.ip;
        this.checkedAt = Number(cached.ts) || 0;
      }
    } catch {
      // 没有缓存，正常
    }
  }

  saveCache(ip) {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(
        this.cacheFile,
        JSON.stringify({ ip, labId: this.cfg.labId, ts: Date.now() }),
        'utf8',
      );
    } catch {
      // 缓存写不了不影响使用
    }
  }

  invalidate() {
    this.ip = null;
    this.checkedAt = 0;
  }

  async current(force = false) {
    if (!force && this.ip && Date.now() - this.checkedAt < this.cfg.cacheTtlSec * 1000) {
      return this.ip;
    }
    if (this.pending) return this.pending;
    this.pending = this.discover().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async discover() {
    const seen = new Set();
    const candidates = [];
    for (const ip of [this.ip, ...(this.cfg.seedIps || [])]) {
      if (ip && !seen.has(ip)) {
        seen.add(ip);
        candidates.push(ip);
      }
    }
    for (const net of this.cfg.scanNets || []) {
      for (const ip of expandCidr(net)) {
        if (!seen.has(ip)) {
          seen.add(ip);
          candidates.push(ip);
        }
      }
    }
    // 第一批里就包含缓存地址和已知地址，命中即返回，通常几十毫秒
    const hit = await firstHit(candidates, this.cfg);
    if (!hit) {
      this.invalidate();
      this.lastError =
        `没找到网关（试过 ${candidates.length} 个地址）。检查：网关是否开机、防火墙是否放行 ` +
        `${this.cfg.gatewayPort}、scanNets 是否覆盖了网关的新网段。`;
      throw new Error(this.lastError);
    }
    this.ip = hit;
    this.checkedAt = Date.now();
    this.lastError = '';
    this.saveCache(hit);
    return hit;
  }

  status() {
    return {
      gateway: this.ip ? `http://${this.ip}:${this.cfg.gatewayPort}` : null,
      ip: this.ip,
      checkedAt: this.checkedAt,
      labId: this.cfg.labId,
      lastError: this.lastError,
    };
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const MAX_BODY = 16 * 1024 * 1024;

/** 先把请求体收进内存：网关换 IP 时可以用同一份 body 原样重放一次。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new Error('请求体超过 16MB，拒绝转发'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function forward(req, res, ip, cfg, finder, body, retried = false) {
  const headers = { ...req.headers };
  headers.host = `${ip}:${cfg.gatewayPort}`;
  // 我们按完整 Buffer 重发，统一成固定长度，避免 chunked 头与重发不一致
  delete headers['transfer-encoding'];
  headers['content-length'] = String(body.length);
  if (cfg.overrideAuth && cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  const upstream = http.request(
    { hostname: ip, port: cfg.gatewayPort, path: req.url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.setTimeout(600000, () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', async (err) => {
    // 网关换 IP / 网络断了：作废缓存重新发现，用同一个 body 自动重试一次。
    // 只有响应头还没发出去时才能安全重试。
    if (!retried && !res.headersSent) {
      finder.invalidate();
      try {
        const next = await finder.current(true);
        if (next && next !== ip) {
          forward(req, res, next, cfg, finder, body, true);
          return;
        }
      } catch {
        // 下面统一报错
      }
    }
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { message: `连不上网关 ${ip}: ${err.message}`, type: 'upstream_error' },
      });
    } else {
      res.end();
    }
  });
  if (body.length) upstream.write(body);
  upstream.end();
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('discovery in progress')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createProxyServer(cfg, opts = {}) {
  const finder = opts.finder || new GatewayFinder(cfg, opts.cacheFile || DEFAULT_CACHE_PATH);
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/__labai/')) {
      if (url.startsWith('/__labai/refresh')) {
        finder.invalidate();
        try {
          await finder.current(true);
        } catch {
          // status 里会带上 lastError
        }
      } else if (!finder.ip) {
        // 刚启动、预热还没跑完时，状态接口顺带等一下；网关离线也不能把人卡死
        try {
          await withTimeout(finder.current(), 3000);
        } catch {
          // 还在找，status 里用 discovering 标出来
        }
      }
      sendJson(res, 200, {
        ok: true,
        ...finder.status(),
        listenPort: cfg.listenPort,
        hasKey: Boolean(cfg.apiKey),
        discovering: Boolean(finder.pending),
      });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: { message: err.message, type: 'body_too_large' } });
      return;
    }
    let ip;
    try {
      ip = await finder.current();
    } catch (err) {
      sendJson(res, 502, { error: { message: err.message, type: 'gateway_not_found' } });
      return;
    }
    forward(req, res, ip, cfg, finder, body);
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  return { server, finder };
}

const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const args = process.argv.slice(2);
  const valueOf = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const file = valueOf('--config', DEFAULT_CONFIG_PATH);
  const extra = {};
  if (args.includes('--port')) extra.listenPort = Number(valueOf('--port', '8801'));
  if (args.includes('--gateway-port')) extra.gatewayPort = Number(valueOf('--gateway-port', '8800'));
  const cfg = readConfig(extra, file);
  const cacheFile = `${file}.cache.json`;

  if (args.includes('--once')) {
    const finder = new GatewayFinder(cfg, cacheFile);
    try {
      const ip = await finder.current(true);
      console.log(`网关地址  http://${ip}:${cfg.gatewayPort}`);
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  } else {
    const { server, finder } = createProxyServer(cfg, { cacheFile });
    server.on('error', (err) => {
      console.error(`代理启动失败: ${err.message}`);
      process.exitCode = 1;
    });
    server.listen(cfg.listenPort, '127.0.0.1', () => {
      console.log(`实验室网关代理  http://127.0.0.1:${cfg.listenPort}`);
      console.log(`状态查询        http://127.0.0.1:${cfg.listenPort}/__labai/status`);
      finder
        .current()
        .then((ip) => console.log(`当前网关        http://${ip}:${cfg.gatewayPort}`))
        .catch((err) => console.log(`尚未发现网关    ${err.message}`));
    });
  }
}