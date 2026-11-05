#!/usr/bin/env node
/**
 * 插件自检：模拟「网关 DHCP 换了 IP」，验证 DSH 侧配置完全不用改。
 *
 * 不动真实网卡，只在回环地址上起两个假网关：
 *   127.0.0.10:19800  → 关掉
 *   127.0.0.11:19800  → 接管
 * 本地代理监听 127.0.0.1:19801，看它能否自己发现新地址并重试成功。
 *
 *   node bin/selftest.mjs
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createProxyServer, probe, DEFAULTS } from '../lib/proxy.mjs';

const LAB = 'labai-selftest-v1';
const GW_PORT = 19800;
const PX_PORT = 19801;
const IP_A = '127.0.0.10';
const IP_B = '127.0.0.11';
const CACHE = path.join(os.tmpdir(), `labai-selftest-${process.pid}.json`);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? '   ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}   ${detail}`);
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      const onError = (err) => {
        server.removeListener('error', onError);
        tries += 1;
        if (err.code === 'EADDRINUSE' && tries < 5) {
          setTimeout(attempt, 200);
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve(server);
      });
    };
    attempt();
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** 假网关：/healthz 带 lab 标识，其它请求回显 body，用来检查重试有没有丢内容。 */
function mockGateway(label, withLab = true) {
  return http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...(withLab ? { lab: LAB } : {}) }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        label,
        echo: Buffer.concat(chunks).toString('utf8'),
        contentLength: req.headers['content-length'],
      }));
    });
  });
}

async function request(url, options = {}, body) {
  const res = await fetch(url, { ...options, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const cfg = {
  ...DEFAULTS,
  listenPort: PX_PORT,
  gatewayPort: GW_PORT,
  labId: LAB,
  seedIps: [IP_A],
  scanNets: ['127.0.0.0/24'],
  probeTimeoutMs: 150,
  concurrency: 64,
  cacheTtlSec: 60,
  overrideAuth: false,
};

const chatBody = JSON.stringify({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: '模拟一次带请求体的聊天调用' }],
});
const postOptions = { method: 'POST', headers: { 'content-type': 'application/json' } };

let gwA, gwB, impostor, proxyServer;

async function main() {
  console.log('\n=== 实验室网关 DSH 插件自检（模拟 DHCP 换 IP）===\n');
  try { fs.unlinkSync(CACHE); } catch { /* 无缓存 */ }

  console.log(`[1] 网关在 ${IP_A}:${GW_PORT}，启动本地代理 127.0.0.1:${PX_PORT}`);
  gwA = mockGateway('网关A');
  await listen(gwA, GW_PORT, IP_A);
  const { server, finder } = createProxyServer(cfg, { cacheFile: CACHE });
  proxyServer = server;
  await listen(proxyServer, PX_PORT, '127.0.0.1');

  let st = await request(`http://127.0.0.1:${PX_PORT}/__labai/status`);
  check('自动发现到网关A', st.json.ip === IP_A, `ip=${st.json.ip}`);

  let r = await request(`http://127.0.0.1:${PX_PORT}/v1/chat/completions`, postOptions, chatBody);
  check('POST 请求体完整转发', r.json.echo === chatBody, `len=${(r.json.echo || '').length}`);
  check('命中网关A', r.json.label === '网关A', `label=${r.json.label}`);

  console.log(`\n[2] 模拟 DHCP 换 IP：关掉 ${IP_A}，网关改到 ${IP_B}`);
  await close(gwA);
  gwA = null;
  gwB = mockGateway('网关B');
  await listen(gwB, GW_PORT, IP_B);

  r = await request(`http://127.0.0.1:${PX_PORT}/v1/chat/completions`, postOptions, chatBody);
  check('换 IP 后自动重试成功', r.status === 200 && r.json.label === '网关B',
    `status=${r.status} label=${r.json && r.json.label}`);
  check('重试时 POST body 没丢', r.json.echo === chatBody, `len=${(r.json.echo || '').length}`);

  st = await request(`http://127.0.0.1:${PX_PORT}/__labai/status`);
  check('缓存已更新为新 IP', st.json.ip === IP_B, `ip=${st.json.ip}`);

  console.log('\n[3] 误连防护：同端口来了个没有 lab 标识的服务');
  await close(gwB);
  gwB = null;
  impostor = mockGateway('冒牌货', false);
  await listen(impostor, GW_PORT, IP_B);
  const fresh = await request(`http://127.0.0.1:${PX_PORT}/__labai/refresh`);
  check('不会误认同端口的其它服务', !fresh.json.ip, `ip=${fresh.json.ip}`);
  check('状态里给出了排查提示', Boolean(fresh.json.lastError), '');
  await close(impostor);
  impostor = null;

  console.log('\n[4] 真实网关（本机 8800）');
  const real = await probe('127.0.0.1', {
    ...DEFAULTS, gatewayPort: 8800, labId: 'lab-ai-gateway-v1', probeTimeoutMs: 1200,
  });
  check('127.0.0.1:8800 带正确的 lab 标识', real === '127.0.0.1', `probe=${real}`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`\n自检异常: ${err && err.stack || err}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close(proxyServer);
    await close(gwA);
    await close(gwB);
    await close(impostor);
    try { fs.unlinkSync(CACHE); } catch { /* 忽略 */ }
  });
