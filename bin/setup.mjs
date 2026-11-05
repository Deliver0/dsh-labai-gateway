#!/usr/bin/env node
/**
 * 「实验室 AI 网关」DSH 插件 —— 一键安装 / 卸载
 *
 *   node bin/setup.mjs                  交互式：粘贴自己的 sk-lab-… Key
 *   node bin/setup.mjs --key sk-lab-…  非交互
 *   node bin/setup.mjs --seed-ip 10.16.35.100   管理员可预置当前网关 IP（加速首次连接）
 *   node bin/setup.mjs --uninstall     精确卸载，恢复安装前的配置
 *
 * 做四件事：
 *   1. 把插件复制到 ~/.dsh/plugins/，并在 profile 的 node_modules 里建目录链接；
 *   2. 在 newapi-provider 里加一条指向 127.0.0.1:8801 的通道并设为默认；
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
import { DEFAULTS, readConfig, writeConfig, DEFAULT_CONFIG_PATH } from '../lib/proxy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const PKG_NAME = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8')).name;
const HOME = os.homedir();
const MARK = 'labai-gateway';
const BEGIN = `# === ${MARK} BEGIN ===`;
const END = `# === ${MARK} END ===`;
const CHANNEL_ID = 'labai';
const CRED_NAME = 'LABAI_API_KEY';
const PROXY_URL = `http://127.0.0.1:${DEFAULTS.listenPort}`;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

const PROFILE = flag('--profile') || 'desktop';
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
 * cordis.patch.yml：只做两处文本级修改，完整保留注释和其它脚本维护的区块。
 *   - 在 newapi-provider 的 channels 列表里插入「实验室网关」通道（带 BEGIN/END 标记）
 *   - 把 activeChannel 指向它，并把原值记在行尾注释里供卸载恢复
 */
function patchCordis(remove = false) {
  const text = fs.readFileSync(CORDIS_FILE, 'utf8');
  const eol = eolOf(text);
  const lines = readLines(CORDIS_FILE);

  // 卸载：删标记块 + 恢复 activeChannel
  if (remove) {
    const b = lines.findIndex((l) => l.includes(BEGIN));
    const e = lines.findIndex((l) => l.includes(END));
    if (b >= 0 && e > b) lines.splice(b, e - b + 1);
    const a = lines.findIndex((l) => /^\s*activeChannel:/.test(l));
    if (a >= 0) {
      const m = lines[a].match(new RegExp(`${MARK}\\s*原值:\\s*(\\S+)`));
      if (m) lines[a] = `    activeChannel: ${m[1]}`;
      else if (/activeChannel:\s*labai\b/.test(lines[a])) lines.splice(a, 1);
    }
    writeLines(CORDIS_FILE, lines, eol);
    return;
  }

  let start = lines.findIndex((l) => /^- id:\s*newapi-provider\s*$/.test(l));
  if (start < 0) {
    // 这个 profile 还没配过 newapi-provider：整体追加一段带标记的块
    const block = [
      BEGIN,
      '- insert:',
      '    - id: newapi-provider',
      '      name: dsh-newapi-provider',
      '      config:',
      '        channels:',
      `          - id: ${CHANNEL_ID}`,
      '            name: 实验室网关',
      `            baseURL: ${PROXY_URL}`,
      `            apiKeyEnv: ${CRED_NAME}`,
      '            headers: {}',
      '            models: {}',
      `        activeChannel: ${CHANNEL_ID}`,
      `    - id: ${MARK}`,
      `      name: ${PKG_NAME}`,
      END,
      '',
    ];
    writeLines(CORDIS_FILE, [...lines, ...block], eol);
    return;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) { end = i; break; }
  }

  const channelsLine = lines.findIndex((l, i) => i > start && i < end && /^\s+channels:\s*$/.test(l));
  if (channelsLine < 0) throw new Error('newapi-provider 配置块里找不到 channels 列表');

  let listEnd = channelsLine + 1;
  for (let i = channelsLine + 1; i < end; i += 1) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const indent = l.match(/^\s*/)[0].length;
    if (indent < 6) { listEnd = i; break; }
    listEnd = i + 1;
  }

  if (!lines.some((l) => l.includes(BEGIN))) {
    const block = [
      `      ${BEGIN}`,
      `      - id: ${CHANNEL_ID}`,
      '        name: 实验室网关',
      `        baseURL: ${PROXY_URL}`,
      `        apiKeyEnv: ${CRED_NAME}`,
      '        headers: {}',
      '        models: {}',
      `      ${END}`,
    ];
    lines.splice(listEnd, 0, ...block);
  }

  const activeLine = lines.findIndex((l, i) => i > start && /^\s*activeChannel:/.test(l));
  if (activeLine >= 0) {
    const m = lines[activeLine].match(/^(\s*activeChannel:\s*)(\S+)/);
    const original = m ? m[2] : '';
    if (original !== CHANNEL_ID) {
      lines[activeLine] = `    activeChannel: ${CHANNEL_ID}  # ${MARK} 原值: ${original}`;
    }
  } else {
    lines.splice(end, 0, `    activeChannel: ${CHANNEL_ID}  # ${MARK} 原值: `);
  }

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
安装完成！

  本地代理    ${PROXY_URL}   （DSH 里固定填这个，永远不用改）
  网关地址    自动发现：先试上次的地址，再按网段找；换了 IP 自己会更新
  DSH 通道    「实验室网关」已添加并设为默认
  备份位置    ${backupDir}

下一步：完全退出 DeepSeek Harness，再重新打开。

检查是否连上：浏览器打开 ${PROXY_URL}/__labai/status
  看到 "ip": "10.x.x.x" 就说明已经找到网关了。
  看到 "ip": null 说明网关没开机 / 防火墙没放行 ${DEFAULTS.gatewayPort} 端口。
`);
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
}

main().catch((err) => {
  console.error(`\n失败: ${err && err.message}\n`);
  console.error(`如配置已被改动，可从最新备份还原：${BACKUP_ROOT}\n`);
  process.exitCode = 1;
});
