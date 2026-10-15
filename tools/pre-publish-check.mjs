#!/usr/bin/env node
/**
 * 发布前检查 —— 把「一旦进了公开历史就收不回来」的东西挡在门外。
 *
 * 为什么非要有它（不是为了好看）：
 *   2026-10-14 之前发生过一次 —— AGENTS.md 被提交上去了，那里面写着真地址、
 *   设备名、账号邮箱。git 的历史是改不掉的，只能删库重来。
 *   而 `.gitignore` 挡不住 `git add -f`，也挡不住「有人手改了一行」。
 * ⇒ 所以这道闸门**不看 .gitignore**，它读的是**真正会被提交的那批文件**
 *   （`git ls-files`，即索引里的内容），并且**逐字节读内容**去匹配。
 *
 * 用法：
 *   node tools/pre-publish-check.mjs            # 有 .git → 扫 git ls-files（推荐）
 *   node tools/pre-publish-check.mjs --walk     # 还没 git init → 按内置表遍历
 *   node tools/pre-publish-check.mjs --list     # 只列出会扫哪些文件
 *   node tools/pre-publish-check.mjs <文件...>   # 只扫指定的那几个
 *   node tools/pre-publish-check.mjs --install-hook   # 挂成 pre-commit（每台机器装一次）
 *
 * 有命中就 **退出码 1** —— 可以直接当 pre-commit hook 用（`git config core.hooksPath`）。
 *
 * ⚠️ 输出里**不回显命中的原文**，只回显打码后的样子。理由：这个脚本的报错大概率
 *    会被人贴进聊天记录或 issue 里，回显原文等于换个地方再泄露一次。
 *
 * ⚠️ 别往这个文件里写任何真实值（真地址、真邮箱）。规则只写模式 ——
 *    这个文件本身也在扫描范围内。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, extname, relative, isAbsolute } from 'node:path';

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------
// 每条：name / why / re（带 g）/ mask（把命中串打码）
const RULES = [
  {
    name: 'tailscale-ip',
    why: 'Tailscale 的地址（CGNAT 网段）',
    re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
    mask: (m) => m.replace(/^(\d+\.\d+)\.\d+\.\d+$/, '$1.x.x'),
  },
  {
    name: 'private-ip',
    why: '内网地址',
    re: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
    mask: (m) => m.replace(/\.\d{1,3}\.\d{1,3}$/, '.x.x'),
  },
  {
    name: 'windows-user-path',
    why: 'Windows 用户目录 —— 用户名就在路径里',
    // ⚠️ 排除字符里那几个 `& < > ;` 不是随手加的：占位符写成 `C:\Users\<用户名>`
    //    在 HTML 里是 `&lt;用户名&gt;`，不排掉的话，**我们自己的占位符会被自己抓到**，
    //    然后开始怀疑自己改错了。
    // 🔴 2026-10-15 修：斜杠必须是 `{1,2}` 而不是单个。
    //    根因 —— 这条规则原先只认**单**反斜杠的形式，于是：
    //      · YAML / HTML / Markdown 里的**单**反斜杠形式 → 抓得到 ✅
    //      · **JS 字符串字面量**里的形式（源码里每个斜杠都写两遍）→
    //        正则直接滑过去 —— 三个 tools/*.mjs 就这么漏网并推上了 GitHub。
    //    ⇒ 教训：**同一个值在不同语言里的书写形式不同**，规则只认一种形式＝闸门只对一半有效。
    re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s"',;)<>&\]]+/g,
    mask: () => '[盘符]:\\Users\\<用户名>',
  },
  {
    name: 'device-name',
    why: 'Windows 机器名',
    re: /\bDESKTOP-[A-Z0-9]{7}\b/g,
    mask: () => 'DESKTOP-<机器名>',
  },
  {
    name: 'email',
    why: '邮箱地址',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    mask: () => '<邮箱>',
  },
  {
    name: 'secret-assign',
    why: '像是密钥的赋值',
    re: /\b(?:token|authkey|auth_key|apikey|api_key|secret|password|passwd|passphrase)\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{12,})/gi,
    mask: (m) => m.split(/[:=]/)[0].trim() + '=<已打码>',
  },
  {
    name: 'bearer-token',
    why: 'Bearer 令牌',
    re: /\bBearer\s+[A-Za-z0-9_\-.=]{16,}/gi,
    mask: () => 'Bearer <已打码>',
  },
  {
    name: 'api-key-literal',
    why: '形如 sk-… 的 API key',
    re: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    mask: () => 'sk-<已打码>',
  },
  {
    name: 'jwt',
    why: 'JWT',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    mask: () => '<JWT 已打码>',
  },
  {
    name: 'keystore-ref',
    why: '签名文件的引用',
    // ⚠️ 只认**签名文件本身**的扩展名。别顺手把 `keystore.properties` 也加进来 ——
    //    那是个正常的配置文件名，build.gradle / .gitignore 里本来就该出现，
    //    加了天天误报，然后这个脚本就没人看了（误报比漏报更能废掉一道闸门）。
    re: /[\w./\\-]+\.(?:jks|keystore|p12)\b/gi,
    mask: () => '<签名文件路径>',
  },
];

// 已知无害的字面量：不是漏网，是**确认过可以公开**的。
// ⚠️ 往里加东西之前先问一句「这条真的能公开吗」—— 别把它当成消音按钮。
const ALLOW = new Set([
  '100.64.0.0',                   // CGNAT 网段的起始地址，Tailscale 官方文档里就写着
  'sk-diagnostic-not-a-real-key', // net-probe.mjs 里明写的假 key（用来验 401）
]);

// 按**文件名/扩展名**就能判定不该发布的（内容扫不出来的那种）
const FORBIDDEN_EXT = ['.jks', '.keystore', '.p12', '.pem', '.cer', '.apk', '.aab'];
const FORBIDDEN_NAMES = ['keystore.properties', '.credentials.yaml', 'credentials.yaml'];

// `--walk` 模式的跳过目录：这些是发布范围外的东西（git 模式不靠这张表）
const WALK_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'build', '.gradle', '.kotlin', '.idea', '.vscode',
  'logs', 'refs', 'certs', 'bridge', 'dist',
]);
// `--walk` 模式跳过的文件名（同上）
const WALK_SKIP_FILES = new Set([
  'AGENTS.md', 'AGENTS-档案.md', 'CLAUDE.md', 'local.properties',
]);

// 内容扫不动的二进制（按扩展名跳）
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.zip', '.gz', '.7z', '.jar', '.so', '.dll', '.exe', '.wasm',
  '.mp3', '.mp4', '.wav', '.ttf', '.otf', '.woff', '.woff2',
]);

// ---------------------------------------------------------------------------
// 取文件列表
// ---------------------------------------------------------------------------
function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function gitFiles(root) {
  const out = execFileSync(
    'git',
    ['-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return out.split('\0').filter(Boolean);
}

function walkFiles(root) {
  const acc = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (WALK_SKIP_DIRS.has(ent.name)) continue;
        walk(join(dir, ent.name));
      } else if (ent.isFile()) {
        if (WALK_SKIP_FILES.has(ent.name)) continue;
        acc.push(relative(root, join(dir, ent.name)));
      }
    }
  };
  walk(root);
  return acc;
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------
const findings = [];

function report(file, lineNo, ruleName, why, masked) {
  findings.push({ file, lineNo, ruleName, why, masked });
}

function checkName(file) {
  const base = file.replace(/\\/g, '/').split('/').pop();
  const ext = extname(base).toLowerCase();
  if (FORBIDDEN_EXT.includes(ext)) {
    report(file, 0, 'file-type', `不该发布的文件类型（${ext}）`, base);
    return true; // 别再去读内容了
  }
  if (FORBIDDEN_NAMES.includes(base)) {
    report(file, 0, 'file-name', '凭据文件', base);
    return true;
  }
  return false;
}

function scanFile(root, rel) {
  // 🔴 2026-10-15 修：绝对路径必须原样用，不能再 join 一次。
  //    根因 —— 原写死 `join(root, rel)`，而「只扫指定文件」模式传进来的可以是绝对路径，
  //    join 会把它拼到仓库根后面（变成「仓库根 + 那个绝对路径」）→ 那个路径根本不存在 → 下面 catch 静默 return
  //    ⇒ **闸门报「✓ 没有命中」，其实一个字节都没读**。
  //    这条比漏一条规则更危险：它让**任何**一次验证都变成假阳性。
  const abs = isAbsolute(rel) ? rel : join(root, rel);
  if (checkName(rel)) return;

  if (BINARY_EXT.has(extname(rel).toLowerCase())) return;

  let buf;
  try {
    // 大文件跳过（内容扫也扫不动）。⚠️ 这是**已知的**缺口，不是漏网 —— 说清楚而不是假装没有。
    if (statSync(abs).size > 8 * 1024 * 1024) {
      console.error(`  ⚠️ 跳过（>8MB，内容未扫）：${rel}`);
      return;
    }
    buf = readFileSync(abs);
  } catch (e) {
    // 🔴 读不到**必须出声** —— 原先是裸 `catch { return }`，
    //    那正是上面那条 bug 能藏这么久的原因：静默失败看起来和「扫过且干净」一模一样。
    console.error(`  ⚠️ 读不到，未扫：${rel}  (${e.code ?? e.message})`);
    return;
  }
  // 前 8KB 里有 NUL ⇒ 当二进制
  if (buf.subarray(0, 8192).includes(0)) return;

  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);

  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      rule.re.lastIndex = 0;
      const m = rule.re.exec(lines[i]);
      if (m && !ALLOW.has(m[0])) report(rel, i + 1, rule.name, rule.why, rule.mask(m[0]));
    }
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const root0 = repoRoot() ?? process.cwd();

// ---------------------------------------------------------------------------
// --install-hook：把这道闸门挂成 pre-commit
// ---------------------------------------------------------------------------
// 手动跑的东西迟早会忘，而这个忘一次的代价是删库重来。
// ⚠️ 钩子在 `.git/hooks/` 里，**不在版本库里** —— 换台机器要重新装一次。
if (argv.includes('--install-hook')) {
  const hookPath = join(root0, '.git', 'hooks', 'pre-commit');
  const sh = `#!/bin/sh
# 提交前跑一遍发布前检查 —— 挡住「一旦进了公开历史就收不回来」的东西。
# ⚠️ 本文件不在版本库里（.git/hooks 是本机的），换机器要重装：
#     node tools/pre-publish-check.mjs --install-hook
if ! node tools/pre-publish-check.mjs; then
  echo ""
  echo "提交被拦下了。确实要跳过可以用 git commit --no-verify —— 但先想清楚为什么。"
  exit 1
fi
`;
  writeFileSync(hookPath, sh, 'utf8');
  try { chmodSync(hookPath, 0o755); } catch { /* Windows 上是空操作，无所谓 */ }
  console.log(`已安装 pre-commit 钩子：${hookPath}`);
  process.exit(0);
}

let files;
let mode;

if (argv.includes('--walk') || !repoRoot()) {
  files = walkFiles(root0);
  mode = '遍历工作区（跳过发布范围外的目录）';
} else if (argv.some((a) => !a.startsWith('--'))) {
  files = argv.filter((a) => !a.startsWith('--'));
  mode = '只扫指定文件';
} else {
  files = gitFiles(root0);
  mode = 'git ls-files（真正会被提交的那批）';
}

if (argv.includes('--list')) {
  console.log(`模式：${mode}`);
  for (const f of files) console.log('  ' + f);
  console.log(`\n共 ${files.length} 个文件。`);
  process.exit(0);
}

for (const f of files) scanFile(root0, f);

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', OFF = '\x1b[0m';

console.log(`模式：${mode}`);
console.log(`扫描了 ${files.length} 个文件。\n`);

if (findings.length === 0) {
  console.log(`${GREEN}✓ 没有命中。${OFF}`);
  process.exit(0);
}

console.log(`${RED}✗ ${findings.length} 处命中 —— 这些一旦提交就收不回来：${OFF}\n`);
const byFile = new Map();
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}
for (const [file, list] of byFile) {
  console.log(`  ${file}`);
  for (const f of list) {
    const loc = f.lineNo ? `:${f.lineNo}` : '';
    console.log(`    ${DIM}${loc.padEnd(7)}${OFF}[${f.ruleName}] ${f.why}  ${DIM}${f.masked}${OFF}`);
  }
  console.log('');
}
console.log(`${RED}停下来，先把上面这些处理掉。${OFF}`);
process.exit(1);
