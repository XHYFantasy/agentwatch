// 一条命令：把本机 loopback 上的 dsh 送到 Tailscale，手机在外面就能开。
//
// 为什么这样写（2026-10-12 实测定案）：
//   dsh 的 webserver 硬拒非 loopback 绑定（0.0.0.0 被显式拒），所以必须前面挂代理。
//   官方给的口子是 `--trusted-host <authority>`：把手机真正看到的那个 authority
//   告诉 dsh，它的 /api browser-trust 围栏就放行。围栏**只卡 /api**，首页不卡。
//   实测：/api + 未信任 Host → 403；/api + trusted-host → 401（过围栏撞鉴权层）。
//   ⇒ 代理不需要改写 Host/Origin，也不需要 TLS 终结，**纯 TCP 透传即可**。
//
// dsh 的认证机制（实测）：
//   启动时打印 `?token=…`。带 token 访问首页 → 303 + Set-Cookie
//   （cookie 名 dsh-auth-*，载荷里绑定了 authority，有效期 30 天）。
//   之后全靠这张 cookie；无 cookie 且无 token 的请求 → 401
//   "dsh web authentication required"。
//
// 所以这里多做一步**首请求嗅探**：
//   连接建立后读第一个数据块，若「没有 dsh-auth cookie」且「URL 里也没带 token」，
//   直接回 302 到 `/?token=…`，由 dsh 发 cookie 后浏览器再正常访问。
//   ⇒ 手机只需打开 `http://<tailscale-ip>:3080/`，不用手抄那串 43 位 token。
//
//   ⚠️ 安全含义：这让「在 tailnet 内」就等于「已认证」。边界从 token 变成
//   Tailscale/WireGuard 本身。本机 tailnet 目前只有你的 PC 和手机，可接受；
//   若将来 tailnet 里进来别的设备，用 TS_BRIDGE_NO_INJECT=1 关掉这个行为。
//
// 用法: node ts-bridge.mjs [tailscale-ip]
//   不给参数则自动跑 `tailscale ip -4` 取。
//   环境变量 TS_BRIDGE_VERBOSE=1 打印每条请求行；TS_BRIDGE_NO_INJECT=1 关闭 token 注入。
//   透出 dsh 输出时会把 token 自动脱敏成 ***REDACTED***（2026-10-14 加）——
//   重定向 stdout 到日志文件也不会再攒明文，不靠人记。

import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

// dsh 桌面端自带的 CLI。**不写死本机安装路径** —— 装在哪因人而异，写死了别人连不上、
// 还顺手把自己机器的目录结构发了出去。
// 顺序：AGENTWATCH_DSH 环境变量 → PATH 里的 dsh → 都没有就停下来把话说清楚。
function resolveDsh() {
  if (process.env.AGENTWATCH_DSH) return process.env.AGENTWATCH_DSH;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const hit = execFileSync(finder, ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (hit) return hit;
  } catch { /* PATH 里没有，往下走 */ }
  return null;
}
const DSH = resolveDsh();
if (!DSH) {
  console.error('找不到 dsh CLI。设一次环境变量指过去即可：');
  console.error('  $env:AGENTWATCH_DSH = "<dsh 安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd"');
  console.error('想长期生效（新开的终端都认）：');
  console.error('  setx AGENTWATCH_DSH "<同一个路径>"');
  process.exit(1);
}
const DSH_PORT = 3081; // dsh 内部监听（固定，免得动态发现）
const BRIDGE_PORT = 3080; // 对外监听（手机访问这个）

// ---- T7 安全收口：把 host-patch\closure.patch.yml 挂进手机这条链路 ----
//
// 桌面 GUI 那条链路是把同一份清单**合并进** profiles\desktop\cordis.patch.yml
// （Electron 侧 patchFiles 写死为空，只能用脚本合）；手机这条链路有官方口子：
//   `--patch <path>` 是 **launcher flag，必须排在 app 参数之前** ——
//   放到 --no-open 后面会被当成 web 自己的参数 → `error: unknown option '--patch'`。
//   ⇒ 所以下面参数数组里它紧跟 'web'。
//
// 路径按脚本自身位置定位（不写死绝对路径），项目挪窝不断链。
// 🔴 **fail-closed**：清单不在就拒绝启动 —— 「收口清单丢了」绝不能退化成
//    「静默全开」，那等于手机上悄悄多出终端与文件入口。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCH = path.resolve(HERE, '..', 'host-patch', 'closure.patch.yml');
if (!existsSync(PATCH)) {
  console.error(`✗ 收口清单不在: ${PATCH}`);
  console.error('  拒绝以「未收口」状态启动手机链路（fail-closed）。');
  console.error('  确认 host-patch\\closure.patch.yml 是否被移动或删除。');
  process.exit(1);
}

const VERBOSE = !!process.env.TS_BRIDGE_VERBOSE;
const INJECT = !process.env.TS_BRIDGE_NO_INJECT;

function resolveTailscaleIp() {
  if (process.argv[2]) return process.argv[2];
  try {
    const out = execFileSync(
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      ['ip', '-4'],
      { encoding: 'utf8' }
    ).trim();
    if (!out) throw new Error('空输出');
    return out.split(/\r?\n/)[0].trim();
  } catch (e) {
    console.error('取不到 Tailscale IP —— 先确认已登录：');
    console.error('  & "C:\\Program Files\\Tailscale\\tailscale.exe" status');
    console.error(`  (原始错误: ${e.message})`);
    process.exit(2);
  }
}

const tsIp = resolveTailscaleIp();
console.log(`Tailscale IP = ${tsIp}`);

// ---- 起 dsh web，等它打印带 token 的那行 ----
const dsh = spawn(DSH, ['web', '--patch', PATCH, '--no-open', '--port', String(DSH_PORT),
  '--trusted-host', `${tsIp}:${BRIDGE_PORT}`], {
  shell: true,
  windowsHide: true,
});
console.log(`收口清单: ${PATCH}`);

let token = null;
let outBuf = '';
// ---- 脱敏：dsh 每次启动都往 stdout 打印一行带 token 的 URL ----
//
// 旧的纪律是「重定向到文件后手工抹掉」，但那靠人记 —— 已经复发过一次：
// 2026-10-13 那轮 dtest/baseline 实验往 logs\ 里又攒了 5 个文件、5 处明文
// （2026-10-14 才清掉）。这里改成在**透出之前**替换掉，从此重定向进日志的
// 内容也不再含明文 token —— 不依赖任何人记得。
//
// ⚠️ 只脱敏「打印出去的那一份」：内部 outBuf 仍收原文，否则下面自己也解析不出 token。
// 口径与解析正则保持一致（`token=<base64url-ish>`），免得哪天 dsh 换了打印形式、
// 解析得到而脱敏漏掉。
const redact = (s) => s.replace(/token=[A-Za-z0-9_\-]{8,}/g, 'token=***REDACTED***');

const onChunk = (buf) => {
  const s = buf.toString();
  process.stdout.write(redact(s)); // 透出前脱敏
  outBuf += s;                     // 内部留原文，供下面解析
  if (!token) {
    const m = outBuf.match(/token=([A-Za-z0-9_\-]+)/);
    if (m) { token = m[1]; printReady(); }
  }
};
dsh.stdout.on('data', onChunk);
dsh.stderr.on('data', (b) => process.stderr.write(redact(b.toString())));
dsh.on('exit', (code) => {
  console.error(`\n!! dsh web 退出 (code ${code})，bridge 一并停止。`);
  process.exit(1);
});

// ---- TCP 透传 + 首请求嗅探 ----
function firstLineOf(buf) {
  const s = buf.toString('latin1');
  const i = s.indexOf('\r\n');
  return i === -1 ? s.slice(0, 200) : s.slice(0, i);
}

let open = 0;
const server = net.createServer((client) => {
  client.once('data', (first) => {
    const head = first.toString('latin1');
    const reqLine = firstLineOf(first);
    // 只取头几 KB 找 cookie，避免大 body 拖慢
    const headSlice = head.slice(0, 8192);
    const hasCookie = /^cookie:[^\r\n]*dsh-auth-/im.test(headSlice);
    const hasToken = /[?&]token=/i.test(reqLine);

    if (VERBOSE) console.log(`  → ${reqLine}`);

    if (INJECT && token && !hasCookie && !hasToken) {
      const body = 'redirecting to authenticate\n';
      client.end(
        'HTTP/1.1 302 Found\r\n' +
        `Location: /?token=${token}\r\n` +
        'Cache-Control: no-store\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n\r\n' + body
      );
      console.log(`[${new Date().toISOString()}] 补充 token 重定向: ${reqLine}`);
      return;
    }

    const upstream = net.connect(DSH_PORT, '127.0.0.1');
    open++;
    let done = false;
    const close = (why) => {
      if (done) return;
      done = true;
      open--;
      if (VERBOSE) console.log(`[${new Date().toISOString()}] -  ${why} (并发 ${open})`);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', (e) => close(`client: ${e.code ?? e.message}`));
    upstream.on('error', (e) => close(`upstream: ${e.code ?? e.message}`));
    client.on('close', () => close('client 关'));
    upstream.on('close', () => close('upstream 关'));

    upstream.write(first); // 首块已被 once('data') 吃掉，手动转交
    client.pipe(upstream);
    upstream.pipe(client);
  });
  client.on('error', () => {});
});

server.on('error', (e) => {
  console.error(`监听 ${tsIp}:${BRIDGE_PORT} 失败: ${e.code ?? e.message}`);
  if (e.code === 'EADDRNOTAVAIL') {
    console.error('  → 这个 IP 现在不属于本机，多半是 Tailscale 掉线了。');
  }
  process.exit(1);
});

function printReady() {
  console.log('\n' + '='.repeat(60));
  console.log('手机在外面开这个地址（Tailscale 已登录的前提下）：');
  console.log(`\n  http://${tsIp}:${BRIDGE_PORT}/`);
  if (!INJECT) {
    console.log(`\n  （已关闭 token 注入，需手工带 token）`);
    console.log(`  http://${tsIp}:${BRIDGE_PORT}/?token=${token}`);
    console.log(`  ⚠️ 上面这行是给你手抄的，**故意没有脱敏** —— 别把它重定向进日志文件。`);
  }
  console.log('\n' + '='.repeat(60));
}

server.listen(BRIDGE_PORT, tsIp, () => {
  console.log(`bridge: ${tsIp}:${BRIDGE_PORT}  →  127.0.0.1:${DSH_PORT}  (TCP 透传${INJECT ? ' + token 注入' : ''})`);
  if (token) printReady();
  else console.log('等 dsh 打印 token…');
});

// ---- 收尾 ----
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  console.log('\n收尾中…');
  try { server.close(); } catch {}
  try { dsh.kill(); } catch {}
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
