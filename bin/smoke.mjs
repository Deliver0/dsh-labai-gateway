#!/usr/bin/env node
/**
 * 端到端连通性自检 —— 走一遍 DSH 真正会走的路径。
 *
 *   node bin/smoke.mjs
 *
 * 用临时端口 18801 起一个独立代理，不干扰 DSH 里已经运行的那个。
 * 检查：发现网关 → /v1/models → 非流式对话 → SSE 流式 → 免填 Key 注入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxyServer, readConfig, DEFAULT_CONFIG_PATH } from '../lib/proxy.mjs';

const argv = process.argv.slice(2);
const idx = argv.indexOf('--config');
const configFile = idx >= 0 && argv[idx + 1] ? argv[idx + 1] : DEFAULT_CONFIG_PATH;
const cfg = readConfig({ listenPort: 18801 }, configFile);
const cacheFile = path.join(os.tmpdir(), `labai-smoke-${process.pid}.json`);
const BASE = `http://127.0.0.1:${cfg.listenPort}`;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  PASS  ${name}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${name}   ${detail}`); }
}
async function fetchWithTimeout(url, options = {}, ms = 40000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ac.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n=== 实验室网关 · DSH 插件端到端自检 ===\n');
  if (!fs.existsSync(configFile)) {
    throw new Error(`还没配置：${configFile}\n请先运行 node bin/setup.mjs 完成安装`);
  }
  try { fs.unlinkSync(cacheFile); } catch { /* 无缓存 */ }

  const { server } = createProxyServer(cfg, { cacheFile });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.listenPort, '127.0.0.1', resolve);
  });

  try {
    // 1. 发现网关
    const st = await fetchWithTimeout(`${BASE}/__labai/status`, {}, 30000);
    const status = await st.json();
    check('找到实验室网关', Boolean(status.ip), `ip=${status.ip}  gateway=${status.gateway}`);
    if (!status.ip) {
      console.log(`\n  提示：${status.lastError || '网关未响应'}\n`);
      return;
    }

    const auth = { authorization: `Bearer ${cfg.apiKey}` };
    const json = { 'content-type': 'application/json' };

    // 2. 模型列表（DSH 启动时会拉这个）
    const r1 = await fetchWithTimeout(`${BASE}/v1/models`, { headers: { ...auth } });
    const models = await r1.json();
    check('GET /v1/models', r1.status === 200 && Array.isArray(models.data),
      `status=${r1.status} models=${(models.data || []).length}`);

    // 3. 非流式对话
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '只回复两个字：正常' }],
      max_tokens: 50,
      stream: false,
    });
    const r2 = await fetchWithTimeout(`${BASE}/v1/chat/completions`,
      { method: 'POST', headers: { ...json, ...auth }, body });
    const chat = await r2.json();
    const answer = chat.choices?.[0]?.message?.content || chat.error?.message || '';
    check('POST /v1/chat/completions（非流式）', r2.status === 200 && Boolean(answer),
      `status=${r2.status} reply=${JSON.stringify(answer).slice(0, 40)}`);

    // 4. SSE 流式（Agent 工具主要走这条）
    const streamBody = JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '数到 3，用逗号隔开' }],
      max_tokens: 60,
      stream: true,
    });
    const r3 = await fetchWithTimeout(`${BASE}/v1/chat/completions`,
      { method: 'POST', headers: { ...json, ...auth }, body: streamBody });
    const reader = r3.body.getReader();
    const decoder = new TextDecoder();
    let sse = '';
    try {
      for (let i = 0; i < 8; i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        sse += decoder.decode(value, { stream: true });
        if (sse.includes('[DONE]')) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* 忽略 */ }
    }
    check('POST /v1/chat/completions（SSE 流式）',
      r3.status === 200 && sse.includes('data:'),
      `status=${r3.status} chunks=${(sse.match(/data:/g) || []).length}`);

    // 5. 代理注入 Key：工具里不填 Key 也能用
    if (cfg.apiKey && cfg.overrideAuth) {
      const r4 = await fetchWithTimeout(`${BASE}/v1/models`);
      check('免填 Key（代理自动注入）', r4.status === 200, `status=${r4.status}`);
    }
  } finally {
    await sleep(50);
    await new Promise((resolve) => server.close(resolve));
    try { fs.unlinkSync(cacheFile); } catch { /* 忽略 */ }
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  console.log('全部通过就说明：DSH 里可以直接用，网关换 IP 也不用改配置。\n');
  if (fail) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n自检失败: ${err && err.message}\n`);
  process.exitCode = 1;
});
