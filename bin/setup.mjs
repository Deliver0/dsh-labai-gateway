#!/usr/bin/env node
/**
 * 「实验室 AI 网关」DSH 插件 —— 一键安装 / 卸载
 *
 *   node bin/setup.mjs                  交互式：粘贴自己的 sk-lab-… Key
 *   node bin/setup.mjs --key sk-lab-…  非交互
 *   node bin/setup.mjs --seed-ip 10.16.35.100   管理员可预置当前网关 IP（加速首次连接）
 *   node bin/setup.mjs --label Lab436   模型选择里显示的分组名（默认 Lab436）
 *   node bin/setup.mjs --uninstall     精确卸载，恢复安装前的配置
 *
 * 做四件事：
 *   1. 把插件复制到 ~/.dsh/plugins/，并在 profile 的 node_modules 里建目录链接；
 *   2. 在 DSH 内置的 llm-pi-ai 里加一个 provider（模型选择里的「Lab436」分组）；
 *   3. 把同学的 Key 写进 DSH 凭证库（refs）；
 *   4. 写 ~/.labai/dsh.json，本地代理据此注入 Key、自动发现网关 IP。
 *
 * 所有改动都带标记、都会先备份，卸载时精确撤销，不会动用户其它配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DEFAULTS, readConfig, writeConfig, DEFAULT_CONFIG_PATH, GatewayFinder } from '../lib/proxy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const PKG_NAME = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8')).name;
const HOME = os.homedir();
const MARK = 'labai-gateway';
const BEGIN = `# === ${MARK} BEGIN ===`;
const END = `# === ${MARK} END ===`;
const PROVIDER_KEY = 'lab436';          // llm-pi-ai 里的 provider 键，也就是模型选择里的分组 id
const CRED_NAME = 'LABAI_API_KEY';
const PROXY_URL = `http://127.0.0.1:${DEFAULTS.listenPort}`;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

const PROFILE = flag('--profile') || 'desktop';
const LABEL = flag('--label') || 'Lab436';
const DSH_HOME = flag('--dsh-home') || path.join(HOME, '.dsh');
const CONFIG_FILE = flag('--config') || DEFAULT_CONFIG_PATH;
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const PLUGINS_DIR = path.join(DSH_HOME, 'plugins');
const INSTALL_DIR = path.join(PLUGINS_DIR, PKG_NAME);
const NODE_MODULES = path.join(PROFILE_DIR, 'node_modules');
const LINK_PATH = path.join(NODE_MODULES, PKG_NAME);
const PKG_FILE = path.join(PROFILE_DIR, 'package.json');
const CORDIS_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml');
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml');
const BACKUP_ROOT = path.join(HOME, '.labai', 'backups');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(String(a).trim()); }));
}
function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}
function writeLines(file, lines, eol) {
  fs.writeFileSync(file, lines.join(eol), 'utf8');
}
function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
function need(file, what) {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到${what}: ${file}\n请确认 DeepSeek Harness 已安装、且 --profile 指向正确的 profile。`);
  }
}
function backup() {
  const dir = path.join(BACKUP_ROOT, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const items = [];
  for (const file of [PKG_FILE, CORDIS_FILE, CRED_FILE]) {
    if (!fs.existsSync(file)) continue;
    const dest = path.join(dir, path.basename(file));
    fs.copyFileSync(file, dest);
    items.push({ original: file, backup: dest });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(items, null, 2), 'utf8');
  return dir;
}

/** 把插件本体复制到 DSH 插件目录，再在 profile 的 node_modules 里建 junction。 */
function installFiles() {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  fs.mkdirSync(NODE_MODULES, { recursive: true });
  fs.cpSync(PLUGIN_DIR, INSTALL_DIR, {
    recursive: true,
    force: true,
    filter: (src) => !/(^|[\\/])(node_modules|\.git|__pycache__)([\\/]|$)/.test(src),
  });

  if (fs.existsSync(LINK_PATH)) {
    const stat = fs.lstatSync(LINK_PATH);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      // 已经装过：junction 直接复用；真实目录则只删空目录，避免误删用户文件
      if (stat.isSymbolicLink()) return;
      const entries = fs.readdirSync(LINK_PATH);
      if (entries.length === 0) fs.rmdirSync(LINK_PATH);
      else throw new Error(`${LINK_PATH} 已存在且不为空，请手动处理后重试`);
    }
  }
  fs.symlinkSync(INSTALL_DIR, LINK_PATH, 'junction');
}

/**
 * 找 DSH 的 dsh CLI：先交给 PATH，再试 ~/.local/bin，最后从注册表读安装位置。
 * 装完用它 dump 一遍合成后的配置，确认分组真的写进去了。
 */
function dshCandidates() {
  const isWin = process.platform === 'win32';
  const name = isWin ? 'dsh.cmd' : 'dsh';
  const list = [name];
  list.push(path.join(HOME, '.local', 'bin', name));
  if (isWin) {
    for (const hive of ['HKLM', 'HKCU']) {
      try {
        const out = execFileSync(
          'reg',
          ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'DeepSeek Harness', '/d'],
          { encoding: 'utf8', windowsHide: true },
        );
        const loc = out.match(/InstallLocation\s+REG_\w+\s+(.+)/);
        if (loc) list.push(path.join(loc[1].trim(), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
      } catch {
        // 没有这一项就跳过
      }
    }
  }
  return list;
}

/** 装完自己验一遍：dump 出合成后的配置，确认分组真的在里面。 */
function verifyProvider() {
  for (const bin of dshCandidates()) {
    let out = '';
    try {
      out = execFileSync(bin, ['--profile', PROFILE, '--dump-config'], {
        encoding: 'utf8',
        timeout: 90000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
      });
    } catch {
      continue; // 没有 CLI，或者 profile 正被开着的 DSH 占着——跳过，不算失败
    }
    if (!out) continue;
    if (out.includes('llm-pi-ai') && new RegExp(`^\\s*${PROVIDER_KEY}:`, 'm').test(out)) {
      console.log(`  已确认：模型分组「${LABEL}」已经写进 DSH 配置。\n`);
      return true;
    }
    console.log(`  注意：配置里没找到「${LABEL}」分组，这个版本的 DSH 可能还不带 llm-pi-ai。`);
    console.log('  把这段提示截图发给管理员，并附上 DSH 版本号（设置 → 关于）。\n');
    return false;
  }
  return null; // 没法验证，不打扰用户
}

/** package.json：登记 link 依赖 + bundle，保证以后 pnpm install 不会把插件弄丢。 */
function patchPackageJson(remove = false) {
  const text = fs.readFileSync(PKG_FILE, 'utf8');
  const pkg = JSON.parse(text);
  pkg.dependencies ||= {};
  const linkValue = `link:${INSTALL_DIR.replace(/\\/g, '/')}`;
  if (remove) {
    delete pkg.dependencies[PKG_NAME];
  } else {
    pkg.dependencies[PKG_NAME] = linkValue;
  }
  const dsh = (pkg.dsh ||= {});
  const profile = (dsh.profile ||= {});
  const bundles = Array.isArray(profile.bundles) ? profile.bundles : (profile.bundles = []);
  const at = bundles.indexOf(PKG_NAME);
  if (remove && at >= 0) bundles.splice(at, 1);
  if (!remove && at < 0) bundles.push(PKG_NAME);
  fs.writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

/**
 * cordis.patch.yml：给 DSH 内置的 llm-pi-ai 加一个 provider，在模型选择里自成一个分组。
 *
 * 为什么不用第二个 newapi-provider 实例（早期版本的做法）：
 *   dsh-newapi-provider 的 HTTP 路由前缀是写死的 `/newapi-provider/api/`，不随 providerId 变。
 *   DSH 的 webServer 按 (kind, path) 判重，第二次注册直接抛 duplicate route，
 *   整个实例随之失效 —— 表现就是「模型选择里根本没有这一组」。
 *   llm-pi-ai 是 DSH 内置插件，一个实例能挂多个 provider，各自有 key 和 displayName，
 *   不注册新路由，所以想加几组就加几组。
 *
 * 如果同学的 patch 文件里已经有 llm-pi-ai 段（自己配过中转站），
 * 就把 lab436 塞进它现有的 providers 里，绝不整段覆盖；没有才追加一条同 id 的补丁条目。
 */
function providerLines(indent) {
  const p = ' '.repeat(indent);
  return [
    `${p}${PROVIDER_KEY}:`,
    `${p}  displayName: ${LABEL}`,
    `${p}  api: openai-completions`,
    `${p}  baseURL: ${PROXY_URL}/v1`,
    `${p}  apiKeyEnv: ${CRED_NAME}`,
    // 模型直接写死在配置里：pi-ai 不会去网关拉 /v1/models，
    // DSH 冷启动时代理还没监听也照样有模型可选。
    `${p}  models:`,
    `${p}    - id: deepseek-flash`,
    `${p}      name: DeepSeek Flash`,
    `${p}      contextWindow: 128000`,
    `${p}      maxTokens: 8192`,
    `${p}    - id: deepseek-v4-pro`,
    `${p}      name: DeepSeek V4 Pro`,
    `${p}      contextWindow: 128000`,
    `${p}      maxTokens: 8192`,
  ];
}

/** 在一段已有配置里找 `key:` 这一行；返回 [行号, 缩进, 行内值]，找不到给 [-1, 0, '']。 */
function findKey(lines, from, to, key) {
  const re = new RegExp(`^(\\s+)${key}:(.*)$`);
  for (let i = from; i < to; i += 1) {
    const m = lines[i].match(re);
    if (m) return [i, m[1].length, m[2].trim()];
  }
  return [-1, 0, ''];
}

function insertPiAiProvider(lines) {
  const at = lines.findIndex((l) => /^- id:\s*llm-pi-ai\s*$/.test(l));

  if (at < 0) {
    // 没有现成的 llm-pi-ai 段：追加一条顶层补丁条目（同 id 覆盖同名插件的配置）
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('');
    lines.push(`# === ${MARK} BEGIN ===`);
    lines.push('# 走 DSH 内置的 llm-pi-ai。别改成第二个 dsh-newapi-provider 实例：');
    lines.push('# 它的路由前缀写死成 /newapi-provider/api，第二次注册会被判成重复路由抛错，');
    lines.push('# 整个实例失效，模型选择里就看不到这一组了。');
    lines.push('- id: llm-pi-ai');
    lines.push('  config:');
    lines.push('    providers:');
    lines.push(...providerLines(6));
    lines.push(`# === ${MARK} END ===`);
    lines.push('');
    return;
  }

  // 已有 llm-pi-ai 段：只往它的 providers 里加一个键
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i] && !/^\s/.test(lines[i])) { end = i; break; }
  }
  while (end > at + 1 && !lines[end - 1].trim()) end -= 1; // 别把尾随空行挤到我们写的内容前面
  if (findKey(lines, at, end, PROVIDER_KEY)[0] >= 0) return; // 已经配过，不重复加

  // 标记块必须把它自己新增的每一行都包住，卸载时才能原样撤回。
  const [cfg, cfgIndent, cfgInline] = findKey(lines, at, end, 'config');
  if (cfg < 0) {
    lines.splice(end, 0,
      '  ' + `# === ${MARK} BEGIN ===`,
      '  config:',
      '    providers:',
      ...providerLines(6),
      '  ' + `# === ${MARK} END ===`);
    return;
  }
  if (cfgInline) {
    throw new Error(`cordis.patch.yml 里 llm-pi-ai 的 config 写成了行内形式，不敢自动改：第 ${cfg + 1} 行。\n`
      + '  请把它展开成多行（config: 换行后逐项缩进）再重新运行本脚本。');
  }

  const [prov, provIndent, provInline] = findKey(lines, cfg + 1, end, 'providers');
  if (prov < 0) {
    lines.splice(cfg + 1, 0,
      ' '.repeat(cfgIndent + 2) + `# === ${MARK} BEGIN ===`,
      ' '.repeat(cfgIndent + 2) + 'providers:',
      ...providerLines(cfgIndent + 4),
      ' '.repeat(cfgIndent + 2) + `# === ${MARK} END ===`);
    return;
  }
  if (provInline) {
    throw new Error(`cordis.patch.yml 里 llm-pi-ai 的 providers 写成了行内形式，不敢自动改：第 ${prov + 1} 行。\n`
      + '  请把它展开成多行（providers: 换行后每行一个 provider）再重新运行本脚本。');
  }
  lines.splice(prov + 1, 0,
    ' '.repeat(provIndent + 2) + `# === ${MARK} BEGIN ===`,
    ...providerLines(provIndent + 2),
    ' '.repeat(provIndent + 2) + `# === ${MARK} END ===`);
}

function patchCordis(remove = false) {
  const text = fs.readFileSync(CORDIS_FILE, 'utf8');
  const eol = eolOf(text);
  const lines = readLines(CORDIS_FILE);

  // 1) 删掉上次写入的标记块（旧版塞在 newapi-provider 里的那一段也在这个范围内）
  const b = lines.findIndex((l) => l.includes(BEGIN));
  const e = lines.findIndex((l) => l.includes(END));
  if (b >= 0 && e > b) {
    // 独立成段时，安装会前后各补一个空行做分隔；卸载要顺手收掉一个，否则每装一次多一行空行
    const beforeBlank = b > 0 && !lines[b - 1].trim();
    const afterBlank = e + 1 < lines.length && !lines[e + 1].trim();
    lines.splice(b, e - b + 1);
    if (beforeBlank && afterBlank) lines.splice(b, 1);
  }

  // 1b) 清掉删块后留下的空 `- insert:`（重装两次会累积出空壳）
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!/^- insert:\s*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j += 1;
    const hasBody = j < lines.length && /^\s+\S/.test(lines[j]);
    if (!hasBody) lines.splice(i, j - i);
  }

  // 2) 恢复旧版改过的 activeChannel
  const a = lines.findIndex((l) => /^\s*activeChannel:/.test(l) && l.includes(`${MARK} 原值:`));
  if (a >= 0) {
    const m = lines[a].match(new RegExp(`${MARK} 原值:\\s*(\\S*)`));
    if (m && m[1]) lines[a] = `    activeChannel: ${m[1]}`;
    else lines.splice(a, 1);
  }

  if (!remove) insertPiAiProvider(lines);

  writeLines(CORDIS_FILE, lines, eol);
}

/** 凭证库：在 refs: 段维护一条纯文本 token。只增/删自己那一行，不解析别人的内容。 */
function patchCredentials(key, remove = false) {
  let text = fs.existsSync(CRED_FILE) ? fs.readFileSync(CRED_FILE, 'utf8') : 'version: 1\nrecords: {}\nrefs:\n';
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^\\s+${CRED_NAME}:`).test(l));
  if (remove) {
    if (at >= 0) lines.splice(at, 1);
    writeLines(CRED_FILE, lines, eol);
    return;
  }
  const line = `  ${CRED_NAME}: ${JSON.stringify(key)}`;
  if (at >= 0) {
    lines[at] = line;
  } else {
    const refs = lines.findIndex((l) => /^refs:\s*$/.test(l));
    if (refs < 0) lines.push('refs:', line);
    else {
      let insertAt = lines.length;
      for (let i = refs + 1; i < lines.length; i += 1) {
        if (lines[i] && !/^\s/.test(lines[i]) && !/^\s*#/.test(lines[i])) { insertAt = i; break; }
      }
      lines.splice(insertAt, 0, line);
    }
  }
  writeLines(CRED_FILE, lines, eol);
}

function removeFiles() {
  try {
    const stat = fs.lstatSync(LINK_PATH);
    if (stat.isSymbolicLink()) fs.unlinkSync(LINK_PATH);
  } catch { /* 已经不在了 */ }
  if (fs.existsSync(INSTALL_DIR)) fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
}

function printDone(backupDir) {
  console.log(`
插件装好了。

  本地代理    ${PROXY_URL}   （DSH 里固定填这个，永远不用改）
  网关地址    自动发现：先试上次的地址，再按网段找；换了 IP 自己会更新
  模型选择    多了一个「${LABEL}」分组，里面是 DeepSeek Flash / DeepSeek V4 Pro
  备份位置    ${backupDir}
`);
}

/** 粘贴完 Key 向网关报到一次：把「我装好了」记进管理员的待审批列表。 */
async function reportToGateway(key) {
  const cfg = readConfig({}, CONFIG_FILE);
  // 只试缓存地址和管理员预置的 IP，不做整段扫描（报到不该拖慢安装）。
  // 万一网关刚换 IP 没连上，DSH 启动时的 /v1/models 也会在网关侧自动登记。
  const finder = new GatewayFinder({ ...cfg, scanNets: [] });
  let ip = null;
  try {
    ip = await finder.current(true);
  } catch {
    ip = null;
  }

  if (!ip) {
    console.log('  暂时连不上网关，申请还没提交。连上校园网后重新运行一次安装脚本就会报到，不用重装。\n');
    return;
  }

  const device = `${os.platform()} ${os.hostname()}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`http://${ip}:${cfg.gatewayPort}/gw/api/claim`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'x-labai-device': device,
      },
      body: '{}',
      signal: ctrl.signal,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.log(`  报到没成功：${(d.error && d.error.message) || d.detail || ('HTTP ' + r.status)}`);
      console.log('  把这段提示截图发给管理员即可，不用重装。\n');
      return;
    }
    if (d.status === 'pending') {
      console.log('  --------------------------------------------------');
      console.log('   申请已提交，正在等审批');
      console.log('   等管理员点了「通过」之后，重新打开 DSH 就能用了。');
      console.log('  --------------------------------------------------\n');
    } else {
      console.log(`  ${d.message || '已经通过审批，可以正常使用了。'}\n`);
    }
  } catch (err) {
    console.log(`  暂时连不上网关（${(err && err.message) || '超时'}），联网后重新运行一次安装脚本就会报到。\n`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  need(PKG_FILE, 'DSH profile 的 package.json');
  const backupDir = backup();

  if (has('--uninstall')) {
    patchCordis(true);
    patchPackageJson(true);
    patchCredentials('', true);
    removeFiles();
    console.log(`
已卸载插件，DSH 配置已恢复到安装前。
备份仍在：${backupDir}
~/.labai/dsh.json 保留了（里面是你的 Key），如不再使用可自行删除。
请重启 DeepSeek Harness 生效。
`);
    return;
  }

  let key = flag('--key');
  if (!key) {
    console.log('\n请粘贴管理员发给你的 API Key（sk-lab- 开头）：');
    key = await ask('  Key > ');
  }
  if (!key || /\s/.test(key)) throw new Error('API Key 为空或含空白字符，请重新运行');

  const seedIps = argv.filter((_, i) => argv[i - 1] === '--seed-ip');
  const patch = { apiKey: key, overrideAuth: true };
  if (seedIps.length) patch.seedIps = Array.from(new Set([...DEFAULTS.seedIps, ...seedIps]));
  writeConfig(patch, CONFIG_FILE);

  installFiles();
  patchPackageJson(false);
  patchCordis(false);
  patchCredentials(key, false);
  printDone(backupDir);
  verifyProvider();
  console.log('下一步：DSH 先别打开，等审批通过后再打开。\n');
  await reportToGateway(key);
}

main().catch((err) => {
  console.error(`\n失败: ${err && err.message}\n`);
  console.error(`如配置已被改动，可从最新备份还原：${BACKUP_ROOT}\n`);
  process.exitCode = 1;
});
