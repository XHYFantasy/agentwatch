// 通过 DevTools 协议操作 Android WebView 里的页面：**问它渲染出什么** / **往输入框发一条消息**。
//
// 为什么需要它：
//   T9 全线的验收都绕不开一个问题 —— 页面真的起来了，还是只回了一坨 HTML？
//   `adb logcat` 只能证明 onPageFinished；`/json/list` 的 title 可能是静态 <title> 写死的。
//   只有往页面里 eval 一句、看 DOM 真长出来了，才算证据。
//   再往下（T9-d）还要验「消息发得出去、审批事件回得来」，所以顺带把发消息也做进来。
//
// 用法:
//   1) adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
//      （socket 名：`adb shell cat /proc/net/unix | Select-String webview_devtools`）
//   2) node tools\webview-probe.mjs [选项]
//
// 选项:
//   --base <url>     DevTools 端点，默认 http://127.0.0.1:9222
//   --expr "<js>"    自定义求值（默认做一遍页面体检）
//   --expr-file <f>  ⭐ 同上，但表达式写在文件里 —— PS 5.1 传给原生 exe 的引号会被搅坏
//                    （实测：一句带 `"` 的 JS 直接变成 SyntaxError: Invalid or unexpected token）
//   --pre-click <css> ⭐ **发消息前**先点掉挡住输入框的东西（对齐 cdp-probe 的同名开关）。
//                    dsh 新 profile / App 数据被清之后首次打开会弹「预览版说明」模态框，
//                    它盖住 composer ⇒ 字打得进去、消息发不出去（实测踩过两次）。
//                    用法：--pre-click '[aria-label="预览版说明"] button'
//   --send "<文本>"  往输入框打进这段文字并提交（走 CDP Input，绕过输入法）
//                    🔴 提交**优先点「发送消息」按钮**，不是回车 —— dsh 的 composer 是
//                    Lexical（data-lexical-editor），CDP 的 Enter 到不了它的提交路径。
//   --wait <毫秒>    --send 之后等多久再体检，默认 45000
//   --clear-cookies  ⚠️ 清 WebView 里的 cookie 并强制重载。**实测对本项目那个
//                    「dsh 重启后 authentication required」救不回来**（那次是靠 pm clear 过去的），
//                    留着当备用手段 —— 见下面那段注释。
//
// 判读要点：elements / bodyChildren / resources 三个数只要不是 0，SPA 就是真渲染了。

import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const BASE = opt('--base', 'http://127.0.0.1:9222');
const SEND = opt('--send', null);
const WAIT = Number(opt('--wait', '45000'));
const PRE_CLICK = opt('--pre-click', null);

const HEALTH = `(() => {
  const r = {};
  r.readyState  = document.readyState;
  r.href        = location.href;
  r.title       = document.title;
  r.elements    = document.querySelectorAll('*').length;
  r.bodyChildren= document.body ? document.body.children.length : -1;
  r.bodyText    = document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 600) : null;
  r.resources   = performance.getEntriesByType('resource').length;
  r.scripts     = document.scripts.length;
  r.docHeight   = document.documentElement.scrollHeight;
  return r;
})()`;
const EXPR_FILE = opt('--expr-file', null);
// 阅读顺序：--expr-file 优先，其次 --expr，最后落回体检。
// 复杂表达式（带引号、多行）走 --expr-file —— 见头部那条 PS 引号的坑。
const EXPR = EXPR_FILE ? fs.readFileSync(EXPR_FILE, 'utf8') : opt('--expr', HEALTH);

// dsh 的输入框：先按 textarea 找，再退到 contenteditable。
// 聚焦和取值都走同一个选择器，免得「聚焦了一个、读的是另一个」。
const SEL = `document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')`;
const FOCUS = `(() => {
  const el = ${SEL};
  if (!el) return { found: false };
  el.focus();
  return { found: true, tag: el.tagName, ce: el.getAttribute('contenteditable'),
           ph: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || null };
})()`;
const VALUE = `(() => { const el = ${SEL}; if (!el) return null;
  return el.tagName === 'TEXTAREA' ? el.value : el.innerText; })()`;

const list = await (await fetch(`${BASE}/json/list`)).json();
const targets = Array.isArray(list) ? list : [];
if (targets.length === 0) {
  console.error(`✗ ${BASE}/json/list 里没有 target —— forward 挂上了吗？WebView 进程还活着吗？`);
  process.exit(1);
}
const page = targets.find((t) => t.type === 'page') ?? targets[0];
console.log(`target  title=${JSON.stringify(page.title)}  url=${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const call = (method, params) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
  else p.res(msg.result);
});

const bail = setTimeout(() => { console.error('✗ 120s 总超时'); process.exit(2); }, 120000);

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', (e) => rej(new Error(e.message ?? String(e))), { once: true });
});

const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true });
  return r?.result?.value;
};

// ---- --clear-cookies：dsh 重启后手机必须清的那张 cookie（2026-10-14 实测）----
//
// 症状：重启 dsh（或整条 bridge）之后，手机上打开只剩一行
//   `dsh web authentication required; reopen the URL printed by dsh web.`
//
// 为什么清不掉、也自愈不了：
//   · 那张 cookie 由 dsh 铸，**载荷里绑了 authority 和服务端密钥** ⇒ 实例一换就废；
//   · 而 bridge 的补 token 只在「请求里**没有** dsh-auth cookie」时才触发
//     （`tools\ts-bridge.mjs` 头注释那段首请求嗅探）—— 旧的还在，它就不补；
//   · cookie 是 **HttpOnly**（实测：页面里 `document.cookie` 是空数组）⇒
//     **JS 删不掉**，只能从 CookieManager / CDP 这一层清。
//   ⇒ App 侧目前**没有自愈路径**，是个待办（见 AGENTS.md 的 D 表）。
//   本开关只解决「开发时怎么过去」，不解决产品那一半。
const CLEAR_COOKIES = argv.includes('--clear-cookies');
if (CLEAR_COOKIES) {
  try { await call('Network.enable'); } catch { /* 不 enable 也能清，失败就算了 */ }
  await call('Network.clearBrowserCookies');
  await call('Page.reload', { ignoreCache: true });
  console.log('已清 WebView cookie 并强制重载（等 bridge 补 token）');
  await new Promise((r) => setTimeout(r, 2500));
}

// 提交按钮。dsh 的 composer 上就是 `[aria-label="发送消息"]`。
// 用按钮而不是回车 —— 理由见下面 SEND 块里那段注释。
const SEND_BTN = `(() => {
  const b = document.querySelector('[aria-label="发送消息"]');
  if (!b) return 'no-button';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;

// ---- --pre-click：发消息前先点掉挡路的模态框（对齐 cdp-probe）----
if (PRE_CLICK) {
  const sel = JSON.stringify(PRE_CLICK);
  const r = await evaluate(
    `(() => { const el = document.querySelector(${sel}); if (!el) return 'no-target'; el.click(); return 'clicked'; })()`
  );
  console.log('pre-click =', r);
  await new Promise((r) => setTimeout(r, 400));
}

if (SEND) {
  const info = await evaluate(FOCUS);
  console.log('composer =', JSON.stringify(info));
  if (!info?.found) { console.error('✗ 没找到输入框'); process.exit(3); }

  await call('Input.insertText', { text: SEND });

  // ⚠️ 已知坑（cdp-probe.mjs 第 64 行记过）：有模态框盖住输入框时，
  // insertText 会**静默打不进去**，但脚本照样"发送成功"。
  // 所以打完必须回读一次，空就直接判失败 —— 不能让假成功混过去。
  const back = await evaluate(VALUE);
  console.log('回读输入框 =', JSON.stringify(back));
  if (!back || String(back).trim() === '') {
    console.error('✗ 字没打进去（多半是有模态框盖着，或选择器变了）—— 已中止，没发送');
    process.exit(4);
  }

  // 🔴 提交走**按钮**，不走回车（2026-10-14 实测）。
  //    原因：dsh 的 composer 是 **Lexical**（`data-lexical-editor="true"`），
  //    CDP 的 `Input.dispatchKeyEvent(Enter)` **到不了它的提交路径** ——
  //    实测字进了 DOM（`<span data-lexical-text>` 都长出来了）、消息却发不出去，
  //    而脚本当时还以为成功（因为回读只验了"字在不在"，没验"发没发出去"）。
  //    按钮这条路没有键盘事件语义的坑，且 dsh 自己就给它挂了无障碍名。
  const sent = await evaluate(SEND_BTN);
  console.log('提交 =', sent);
  if (sent !== 'clicked') {
    console.log('（发送按钮那条路不通，回退到回车）');
    for (const type of ['keyDown', 'keyUp']) {
      await call('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
    }
  }

  // ⭐ 提交成功的判据 = **输入框空了**，而不是"我们派发了一个事件"。
  //    跟上面那次回读是同一个道理：只验"我做了动作"而不是"动作生效了"，
  //    假成功就是这么混进来的（这次两轮白跑就是栽在这儿）。
  await new Promise((r) => setTimeout(r, 1200));
  const left = await evaluate(VALUE);
  if (left && String(left).trim() !== '') {
    console.error(
      `✗ 消息没提交（输入框里还剩 ${String(left).length} 个字符）` +
      `——多半有模态框挡着，用 --pre-click 点掉它再来`
    );
    process.exit(5);
  }

  console.log(`已提交，等 ${WAIT}ms 让 agent 回话…`);
  await new Promise((r) => setTimeout(r, WAIT));
}

const value = await evaluate(EXPR);
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

clearTimeout(bail);
ws.close();
process.exit(0);
