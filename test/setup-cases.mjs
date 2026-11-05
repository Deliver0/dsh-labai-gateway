#!/usr/bin/env node
/**
 * 安装脚本的回归测试：在临时 DSH 目录里跑真实的 bin/setup.mjs，
 * 检查它写出来的 cordis.patch.yml 对不对、卸载能不能原样还原。
 *
 *   node test/setup-cases.mjs
 *
 * 全程只碰临时目录，不会动 ~/.dsh 和 ~/.labai。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SETUP = path.join(ROOT, 'bin', 'setup.mjs');
const KEY = 'sk-lab-test-0123456789abcdefghijklmnopqrstuvwxyzABCD';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'labai-setup-'));

let fail = 0;
function check(name, ok, extra) {
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!ok) fail += 1;
}

function makeHome(name, patchText) {
  const home = path.join(TMP, name);
  const profile = path.join(home, 'profiles', 'p');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'labai-test-profile',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), patchText);
  return { home, profile };
}

function run(home, extra = []) {
  try {
    return execFileSync(process.execPath, [SETUP, '--dsh-home', home, '--profile', 'p',
      '--config', path.join(home, 'dsh.json'), ...extra], {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return (err.stdout || '') + (err.stderr || '');
  }
}

const read = (f) => fs.readFileSync(f, 'utf8');

// ---------- 用例 1：干净配置（最常见） ----------
console.log('\n[1] 全新配置');
{
  const base = '- id: agent-default-model\n  config:\n    provider: mine\n    model: m1\n';
  const { home, profile } = makeHome('clean', base);
  const out = run(home, ['--key', KEY]);
  const after = read(path.join(profile, 'cordis.patch.yml'));
  check('装上了 llm-pi-ai 的 lab436', /^- id: llm-pi-ai$/m.test(after) &&
    /^\s+lab436:$/m.test(after) && /displayName: Lab436/.test(after));
  check('指向本机代理 /v1', /baseURL: http:\/\/127\.0\.0\.1:8801\/v1/.test(after));
  check('两个模型都写进去了', /id: deepseek-flash/.test(after) && /id: deepseek-v4-pro/.test(after));
  check('没有残留 newapi-provider 实例', !/name: dsh-newapi-provider/.test(after));
  check('原有配置没被破坏', after.includes('provider: mine'));
  check('Key 进了凭证库', read(path.join(home, '.credentials.yaml')).includes(KEY));
  check('Key 进了 dsh.json', read(path.join(home, 'dsh.json')).includes(KEY));

  run(home, ['--uninstall']);
  check('卸载后完全还原', read(path.join(profile, 'cordis.patch.yml')) === base);
  check('卸载后凭证也清了', !read(path.join(home, '.credentials.yaml')).includes(KEY));
}

// ---------- 用例 2：学生自己已经配过 llm-pi-ai ----------
console.log('\n[2] 已有 llm-pi-ai 段（要往里加，不能覆盖）');
{
  const base = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      mine:',
    '        displayName: Mine',
    '        api: openai-completions',
    '        baseURL: http://example.com/v1',
    '        apiKeyEnv: MINE_KEY',
    '        models:',
    '          - id: m1',
    '            name: M1',
    '',
  ].join('\n');
  const { home, profile } = makeHome('existing', base);
  run(home, ['--key', KEY]);
  const after = read(path.join(profile, 'cordis.patch.yml'));
  check('加进了同一个 providers', /^\s+lab436:$/m.test(after));
  check('原来的 mine 还在', /^\s+mine:$/m.test(after) && /MINE_KEY/.test(after));
  check('没有多出第二个 - id: llm-pi-ai', (after.match(/^- id: llm-pi-ai$/gm) || []).length === 1);
  check('缩进对齐（lab436 与 mine 同级）', /^      lab436:$/m.test(after) && /^      mine:$/m.test(after));
  run(home, ['--uninstall']);
  check('卸载后完全还原', read(path.join(profile, 'cordis.patch.yml')) === base);
}

// ---------- 用例 3：有 config 但没有 providers ----------
console.log('\n[3] 有 config、没有 providers');
{
  const base = '- id: llm-pi-ai\n  config:\n';
  const { home, profile } = makeHome('noprov', base);
  run(home, ['--key', KEY]);
  const after = read(path.join(profile, 'cordis.patch.yml'));
  check('补出了 providers', /^\s+providers:$/m.test(after) && /^\s+lab436:$/m.test(after));
  run(home, ['--uninstall']);
  check('卸载后完全还原', read(path.join(profile, 'cordis.patch.yml')) === base);
}

// ---------- 用例 4：行内写法，脚本应当拒绝而不是乱改 ----------
console.log('\n[4] providers 写成行内（应拒绝并保持原样）');
{
  const base = '- id: llm-pi-ai\n  config:\n    providers: {}\n';
  const { home, profile } = makeHome('inline', base);
  const out = run(home, ['--key', KEY]);
  check('给出了明确报错', /行内形式/.test(out), (out.match(/失败: .*/) || [''])[0].slice(0, 60));
  check('文件没被改动', read(path.join(profile, 'cordis.patch.yml')) === base);
}

// ---------- 用例 5：重复安装是幂等的 ----------
console.log('\n[5] 连装两次');
{
  const base = '- id: agent-default-model\n  config:\n    provider: mine\n';
  const { home, profile } = makeHome('twice', base);
  run(home, ['--key', KEY]);
  const once = read(path.join(profile, 'cordis.patch.yml'));
  run(home, ['--key', KEY]);
  const twice = read(path.join(profile, 'cordis.patch.yml'));
  check('结果完全一致', once === twice);
  check('只有一个 lab436', (twice.match(/^\s+lab436:$/gm) || []).length === 1);
  check('没有空 - insert 壳', !/^- insert:\s*$/m.test(twice));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `\n结果：${fail} 项失败\n` : '\n结果：全部通过\n');
if (fail) process.exitCode = 1;
