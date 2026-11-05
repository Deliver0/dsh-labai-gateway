#!/usr/bin/env node
/**
 * 发版后刷新 index.json 里的 Git 提交锁。
 *
 * DSH 的 plugin-market-index format 1 对 git 源的要求是：
 *   source = { type: "git", url: "https://github.com/owner/repo",
 *              commit: "<40 位小写十六进制 SHA>" }
 * 宿主据此拼出 `git+https://github.com/owner/repo.git#<sha>` 交给 pnpm 安装。
 * 也就是说索引必须指向一个真实存在的提交，不能用分支名或 tag 代替。
 *
 * 正确顺序（两步提交，避免"索引引用自己"的循环）：
 *   1. 提交并 push 插件代码（这一步不要带上 index.json 的改动）
 *   2. node bin/update-index.mjs   → 写入第 1 步的 SHA
 *   3. 只提交 index.json 再 push
 *
 * 用法：
 *   node bin/update-index.mjs           锁到当前 HEAD
 *   node bin/update-index.mjs <sha>    锁到指定提交（发旧版本时用）
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'index.json');

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** 从 origin 推出规范化的 https 仓库 URL（不带 .git / query / fragment）。 */
function repoUrl() {
  const remote = git('remote', 'get-url', 'origin');
  const matched = remote.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i);
  if (!matched) throw new Error(`无法从 origin 解析 GitHub 仓库：${remote}`);
  return `https://github.com/${matched[1]}/${matched[2]}`;
}

const sha = (process.argv[2] || git('rev-parse', 'HEAD')).toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sha)) {
  throw new Error(`commit 必须是 40 位小写十六进制 SHA，收到：${sha}`);
}

const publishedAt = Number(git('show', '-s', '--format=%ct', sha));
if (!Number.isInteger(publishedAt) || publishedAt < 0 || publishedAt >= 1e11) {
  throw new Error(`提交 ${sha} 的时间戳不合法：${publishedAt}`);
}

const url = repoUrl();
const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
if (index.format !== 1 || !Array.isArray(index.plugins) || index.plugins.length === 0) {
  throw new Error('index.json 不是合法的 format-1 索引（缺少 plugins）');
}

for (const plugin of index.plugins) {
  plugin.homepage = url;
  plugin.repository = { url };
  if (typeof plugin.title === 'string') {
    plugin.title = url.slice('https://github.com/'.length);
  }
  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
    throw new Error(`插件 ${plugin.name} 没有 versions`);
  }
  for (const version of plugin.versions) {
    version.source = { type: 'git', url, commit: sha };
    version.publishTimestamp = publishedAt;
  }
}

fs.writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`index.json 已锁定 ${url} @ ${sha.slice(0, 7)} (${new Date(publishedAt * 1000).toISOString()})`);
console.log('下一步只提交索引：git add index.json && git commit -m "chore: pin market index" && git push');
