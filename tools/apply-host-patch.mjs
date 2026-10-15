// 把 host-patch\closure.patch.yml 合并进某个 dsh profile 的 cordis.patch.yml。
//
// ── 为什么需要它（2026-10-13 定案）──────────────────────────────────
//   手机链路可以用 `dsh web --patch <file>` 直接挂清单 —— 纯叠加、不落盘、
//   随时撤，**不需要这个脚本**。
//   但**桌面 GUI 不行**：
//     · Electron 侧 `patchFiles: []` 是写死的空数组
//       （属主源码 refs\dsh-desktop-host\lib\index.js:230，无环境变量、无 CLI 口子）
//     · `dsh --profile desktop` 被官方硬拒：
//       error: profile "desktop" is managed exclusively by the Electron application
//       （连 --dump-config 都不给）
//   ⇒ 想让桌面端也收口，**只能写进 profiles\desktop\cordis.patch.yml**（工作区外）。
//   而那个文件里有用户的真实设置（ui-chat / agent-default-model / …）
//   ⇒ 必须「合并 + 备份」，绝不能覆盖。
//
// ── 设计：托管块（managed block），不是逐条改写 ──────────────────────
//   清单内容整体包在一对标记之间：
//       # >>> agentwatch host-patch (managed) >>>
//       - id: ...
//         disabled: true
//       # <<< agentwatch host-patch <<<
//   好处：
//     · 绝不碰用户原有条目（只在块上做文章）
//     · apply 幂等 —— 整块替换，跑几次都一样
//     · revert = 删块，删干净不留痕
//     · 冲突可查 —— 清单里某个 id 在块外已存在时**只警告、不修改**
//
// ── 用法 ────────────────────────────────────────────────────────────
//   node apply-host-patch.mjs status --profile desktop
//   node apply-host-patch.mjs apply  --profile desktop [--dry-run]
//   node apply-host-patch.mjs revert --profile desktop
//   node apply-host-patch.mjs apply  --profile web --dry-run
//
//   参数:
//     --profile <name>  必填；不给就拒绝（防误伤 —— 尤其防手滑打到 desktop）
//     --patch <file>    清单文件，默认 <仓库>\host-patch\closure.patch.yml
//     --dry-run         只打印将写入的内容，不落盘

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const DEFAULT_LIST = path.join(REPO, 'host-patch', 'closure.patch.yml');

const BEGIN = '# >>> agentwatch host-patch (managed) >>>';
const END = '# <<< agentwatch host-patch <<<';
// 整块（含尾部换行）；m 让 ^ 匹配行首
const BLOCK_RE = new RegExp(
  `^${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?^${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`,
  'm'
);

// ---- 参数 ----
const argv = process.argv.slice(2);
const takeFlag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const takeSwitch = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};

const cmd = argv[0];
const profile = takeFlag('--profile', null);
const listPath = takeFlag('--patch', DEFAULT_LIST);
const dryRun = takeSwitch('--dry-run');

const die = (msg) => { console.error(msg); process.exit(1); };

if (!['status', 'apply', 'revert'].includes(cmd)) {
  die('用法: node apply-host-patch.mjs <status|apply|revert> --profile <name> [--patch <file>] [--dry-run]');
}
if (!profile) {
  die('必填 --profile <name>（不给就拒绝，防误伤）\n例: node apply-host-patch.mjs status --profile desktop');
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileDir = path.join(dshHome, 'profiles', profile);
const target = path.join(profileDir, 'cordis.patch.yml');

// ---- 工具 ----
/** 从清单文件里取出「生效条目」= 去掉注释行与空行后剩下的部分。 */
function activeEntries(text) {
  return text.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith('#')).join('\n');
}

const buildBlock = (entries) => `${BEGIN}\n${entries}\n${END}\n`;

const stripBlock = (text) => text.replace(BLOCK_RE, '');

const hasBlock = (text) => BLOCK_RE.test(text);

/** 去掉注释行与空行，看还剩什么（用来判断文件是不是空列表）。 */
const bare = (text) =>
  text.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith('#')).join('\n').trim();

/** 抓出文本里所有 `- id: xxx` 的 id。 */
const idsIn = (text) => [...text.matchAll(/^-\s*id:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/^["']|["']$/g, ''));

// ---- 读清单 ----
if (!fs.existsSync(listPath)) die(`清单文件不存在: ${listPath}`);
const listText = fs.readFileSync(listPath, 'utf8');
const entries = activeEntries(listText);
if (!entries) die(`清单里没有生效条目（全被注释掉了？）: ${listPath}`);
const listIds = idsIn(entries);

if (!fs.existsSync(target)) die(`目标文件不存在: ${target}`);

const original = fs.readFileSync(target, 'utf8');
// ⚠️ 必须切 14 位，**不是 15** —— toISOString() 去掉 `-` `:` `T` 之后长这样：
//      "20261013044915.123Z"
//    前 14 位才是 yyyymmddHHMMSS，**第 15 位是那个小数点**。带上它会让备份文件名
//    以「.」结尾，而 Windows 会把路径末尾的点剥掉 ⇒ 文件确实建得出来
//    （Node/libuv 给绝对路径加 `\\?\` 前缀，所以创建时不报错），但**用普通路径
//    （资源管理器 / Copy-Item / Test-Path / Get-Content）一律打不开**
//    ⇒ 这条「回滚安全网」等于断了。（2026-10-13 实测踩到）
const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // yyyymmddHHMMSS

// ---- status ----
if (cmd === 'status') {
  console.log(`清单   : ${listPath}`);
  console.log(`目标   : ${target}`);
  console.log(`生效条目 (${listIds.length}) : ${listIds.join(', ')}`);
  const present = hasBlock(original);
  console.log(`托管块 : ${present ? '✅ 已存在' : '— 不存在'}`);
  const outside = idsIn(stripBlock(original));
  console.log(`块外已有条目 (${outside.length}) : ${outside.join(', ') || '(无)'}`);
  const clash = listIds.filter((id) => outside.includes(id));
  if (clash.length) {
    console.log(`⚠️  冲突 : ${clash.join(', ')} —— 清单要关的 id 在块外已存在。`);
    console.log('    脚本不会去改它（保持「绝不碰用户条目」），但你要知道 dsh 可能按后面的块为准。');
  }
  if (present) {
    const block = original.match(BLOCK_RE)[0].trimEnd();
    console.log(`---- 块内容 ----\n${block}`);
  }
  process.exit(0);
}

// ---- revert ----
if (cmd === 'revert') {
  if (!hasBlock(original)) { console.log('目标里没有托管块，无需回滚。'); process.exit(0); }
  let out = stripBlock(original);
  if (bare(out) === '') out = `${out.trimEnd()}\n[]\n`; // 块是唯一条目 → 还原成空列表
  if (dryRun) {
    console.log('---- dry-run：回滚后将是 ----');
    console.log(out);
    process.exit(0);
  }
  const backup = `${target}.bak.${timestamp}`;
  fs.copyFileSync(target, backup);
  fs.writeFileSync(target, out, 'utf8');
  console.log(`✅ 已回滚（删掉托管块）`);
  console.log(`   目标: ${target}`);
  console.log(`   备份: ${backup}`);
  process.exit(0);
}

// ---- apply ----
let base = stripBlock(original);
base = base.replace(/^\s*\[\s*\]\s*$/m, ''); // 空列表字面量 → 去掉，避免 `[]` 跟块并存
const out = `${base.trimEnd()}${base.trim() ? '\n\n' : ''}${buildBlock(entries)}`;

// 冲突检查（只提醒，不改动块外内容）
const outside = idsIn(stripBlock(original));
const clash = listIds.filter((id) => outside.includes(id));

if (dryRun) {
  console.log('---- dry-run：将写入以下内容 ----');
  console.log(out);
  if (clash.length) console.log(`\n⚠️  冲突: ${clash.join(', ')}（块外已存在，未被修改）`);
  process.exit(0);
}

const backup = `${target}.bak.${timestamp}`;
fs.copyFileSync(target, backup);
fs.writeFileSync(target, out, 'utf8');

console.log(`✅ 已应用托管块`);
console.log(`   清单: ${listPath}`);
console.log(`   目标: ${target}`);
console.log(`   备份: ${backup}`);
console.log(`   条目: ${listIds.join(', ')}`);
if (clash.length) console.log(`⚠️  冲突: ${clash.join(', ')}（块外已存在，未被修改）`);
console.log(`\n回滚: node ${path.relative(REPO, fileURLToPath(import.meta.url))} revert --profile ${profile}`);
