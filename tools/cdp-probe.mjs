// 用 CDP 驱动 headless Edge 打开一个页面，把「页面上真正显示的文字」和报错捞回来。
//
// 为什么不用 `msedge --headless --screenshot`：
//   那条路在 dsh 上会**永远挂住** —— `--virtual-time-budget` 要等页面"静止"，
//   而 dsh 前端全程挂着 WebSocket，虚拟时间一直在前进，永远等不到头（实测 180s 超时）。
//   自己开 remote-debugging-port 用 CDP 控制，就没有这个坑：想等多久自己说了算。
//
// 用途：D12 这类「卡片到底渲染出来没有」的验证。手机上能看到的，这里也能看到，
//   所以它能把「必须找用户掏手机」的验证尽量前移。
//
// 用法:
//   node cdp-probe.mjs <页面URL> [输出目录] [等待毫秒] [--type "要发的消息"] [--wait2 毫秒] [--port 端口]
//   默认: 输出目录 = 本目录\..\logs，等待 25000ms
//   --type 会在页面加载完成后，往输入框里打字并回车发送，再等 --wait2（默认 45000ms）后抓结果。
//   用途：空白会话里没有历史事件，得让 agent 真动一下，卡片才有东西可画。
//
// 可选开关:
//   --mark "甲,乙,丙"     要检查的命中文字（默认是 D12 那四个）
//   --shot 名字.png       截图文件名（默认 d12-shot.png）
//   --click "文字"        点「包含该文字的最内层元素」，用于展开折叠的分组
//   --click-wait 毫秒     点击后等多久再抓（默认 3500）
//   --deny                点 dsh **原生**审批卡的「拒绝」
//   --js "表达式"         执行一段任意 JS 并打印结果（诊断「插件客户端半有没有加载」）
//   --js-file 路径.js     ⭐ **表达式稍微复杂就用这个**：同上，但表达式从文件读。
//                         `--js` 带空格/引号时会被 shell 拆参数，报错只剩一句 `Uncaught`（实测）。
//                         返回值支持 Promise —— 脚本里写了 `awaitPromise`，可以等一会儿再回结果。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 脚本自身位置 —— 下面那句「默认输出目录 = 本目录\..\logs」按它算。
// ⚠️ 别写死本机绝对路径（既暴露目录结构，项目挪窝也断链）。
const HERE = path.dirname(fileURLToPath(import.meta.url));

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2); // 拿掉，剩下的才是位置参数
  return v;
};
// ⚠️ 端口做成参数（2026-10-14）：9222 常年被 `adb forward tcp:9222`（手机 WebView 远程
//    调试）占着 —— 撞上时 Edge 绑不上端口，报出来的是「CDP 端口一直没起来（Edge 没启动成功？）」，
//    完全看不出真因。给个 `--port` 就能绕开，不必去撤别人的转发。
const PORT = Number(flag('--port', 9222));
const typeText = flag('--type', null);
const clickText = flag('--click', null);
const wait2 = Number(flag('--wait2', 45000));
// 命中标记与截图名都做成参数 —— 不然每验一个任务就得改一次源码。
const marks = (flag('--mark', '步已完成,需要你批准,已批准,已拒绝') ?? '').split(',').filter(Boolean);
const shotName = flag('--shot', 'd12-shot.png');
const clickWait = Number(flag('--click-wait', 3500));
// 把「含某段文字的最内层元素」连同它上面 4 层一起 dump 出来。
// 用途：分不清某段文字是**我们插件画的**还是 **dsh 原生画的** —— 看结构就知道。
const dumpDom = flag('--dump-dom', null);
// 普查对话流里所有节点的 `data-chat-flow-kind`。
// 用途：判断「dsh 原生有没有自己的一套工具卡片」—— 决定我们的卡是不是重复建设。
const flowIdx = argv.indexOf('--flow');
const flow = flowIdx !== -1;
if (flow) argv.splice(flowIdx, 1); // 无值开关
// 按 `data-chat-flow-kind` 精确取节点看结构。
// 比 --dump-dom 按文字找强：折叠起来的节点 innerText 是空的，按文字根本找不着。
const dumpKind = flag('--dump-kind', null);
// 按 CSS 选择器点。`--click` 只能找「没有子元素的、含某文字的元素」，
// 而 dsh 的折叠按钮是个带 svg 子节点的 <button>，按文字够不着，只能按选择器点。
const clickSel = flag('--click-sel', null);
// 在 `--type` **之前**按 CSS 选择器点一下。
// 用途：dsh 新 profile 首次打开会弹「预览版说明」模态框，它盖住输入框 →
// `--type` 的 insertText 会**静默打不进去**（输入框内容仍是空，但脚本会误报"发送成功"）。
// 必须在发消息前点掉，所以不能复用 `--click-sel`（那个跑在 `--type` 之后）。
const preClick = flag('--pre-click', null);
// 执行一段任意 JS 表达式并把结果打出来。
// 用途：判断「插件客户端半到底加载了没有」—— 只看渲染出来的文字分不清
//   「插件没加载」和「加载了但那个字段没渲染」，这两种的修法完全不同，得直接问页面。
// ⚠️ 表达式里有空格 / 引号时，**用 `--js-file` 指一个文件**，别用 `--js`。
//    2026-10-14 实测踩到：`--js 'JSON.stringify({hook: typeof …})'` 从 PowerShell 传进去，
//    页面报回来的是光秃秃一句 `<<求值异常: Uncaught>>` —— 因为表达式被**拆成了多个参数**，
//    `flag()` 只取到前半句，剩下半句成了游离的位置参数，于是求值的是半句残码（语法错）。
//    报错里**完全看不出真因**（和 `--port` 那次一样：真因在传参层，不在被测对象上）。
//    走文件就没有任何一层要转义。
const jsFile = flag('--js-file', null);
const jsExpr = jsFile === null ? flag('--js', null) : fs.readFileSync(jsFile, 'utf8');
const denyIdx = argv.indexOf('--deny');
const deny = denyIdx !== -1;
if (deny) argv.splice(denyIdx, 1); // 无值开关

const url = argv[0];
if (!url) { console.error('用法: node cdp-probe.mjs <URL> [输出目录] [等待毫秒] [--type "消息"] [--wait2 ms]'); process.exit(2); }
const outDir = argv[1] ?? path.join(HERE, '..', 'logs');
const waitMs = Number(argv[2] ?? 25000);
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 起一个干净的 Edge ----
const userDataDir = path.join(os.tmpdir(), 'edge-dsh-cdp');
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--window-size=430,932',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

let closed = false;
const cleanup = () => {
  if (closed) return;
  closed = true;
  try { edge.kill(); } catch {}
};
process.on('exit', cleanup);

async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('CDP 端口一直没起来（Edge 没启动成功？）');
}

/** 极简 CDP 客户端：够用就好，不引依赖。 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.method ?? ''})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  return {
    ready: new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连不上')));
    }),
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(fn) { listeners.push(fn); },
    close() { try { ws.close(); } catch {} },
  };
}

const version = await waitCdp();
console.log(`Edge: ${version.Browser}`);

// ---- 开一个目标页 ----
const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
const target = await created.json();
const cdp = connect(target.webSocketDebuggerUrl);
await cdp.ready;

const errors = [];
const consoleLines = [];
cdp.on((msg) => {
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push(d.exception?.description ?? d.text ?? JSON.stringify(d));
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    consoleLines.push(`[${msg.params.type}] ${text}`);
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error') errors.push(`${e.source}: ${e.text}`);
    else consoleLines.push(`[log:${e.level}] ${e.text}`);
  }
});

await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 430, height: 932, deviceScaleFactor: 2, mobile: true,
});

console.log(`导航到 ${url.replace(/token=[^&]+/, 'token=***')}`);
await cdp.send('Page.navigate', { url });

// 不用虚拟时间，就硬等——dsh 要连 WebSocket 拉会话，急不来。
console.log(`等待 ${waitMs}ms 让 SPA 跑起来…`);
await sleep(waitMs);

const evalText = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return `<<求值异常: ${r.exceptionDetails.text}>>`;
  return r.result.value;
};

// 发消息前先清场（见文件头 `--pre-click` 说明）。
if (preClick !== null) {
  const r = await evalText(`(() => {
    const el = document.querySelector(${JSON.stringify(preClick)});
    if (!el) return '没找到: ' + ${JSON.stringify(preClick)};
    el.click();
    return '点了 ' + el.tagName + '  文字=' + (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 40);
  })()`);
  console.log(`\n[pre-click] ${r}`);
  await sleep(3000); // 等模态框收起来、会话界面就位
}

// 找输入框：可见的 textarea / contenteditable 都算。dsh 用的是哪种没定，所以都收。
const FIND_INPUT = `(() => {
  const all = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')];
  const el = all.find((e) => e.offsetParent !== null && !e.disabled);
  if (!el) return null;
  el.focus();
  window.__awInput = el;
  return JSON.stringify({
    tag: el.tagName,
    contenteditable: el.getAttribute('contenteditable'),
    placeholder: el.placeholder ?? null,
  });
})()`;

const READ_INPUT = `(() => {
  const el = window.__awInput;
  if (!el) return '(输入框引用丢了)';
  return el.value !== undefined ? el.value : el.innerText;
})()`;

// 点 dsh **原生**审批卡的「拒绝」。
// ⚠️ 页面里有**两个**「拒绝」—— 我们插件画的那个（disabled）也在。
// 所以不能按文字找，得先认准只有原生才有的「允许一次」，再从它的父容器里取兄弟按钮。
// 用 el.click() 就够：React 的合成事件挂在 root 上，冒泡得到。
const DENY_NATIVE_APPROVAL = `(() => {
  const btns = [...document.querySelectorAll('button')];
  const allow = btns.find((b) => b.textContent.trim() === '允许一次');
  if (!allow) return '没找到「允许一次」—— 原生审批卡可能还没出来';
  const denyBtn = [...allow.parentElement.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '拒绝');
  if (!denyBtn) return '父容器里没找到「拒绝」';
  denyBtn.click();
  return '已点击';
})()`;

async function dump(label, shotName) {
  const title = await evalText('document.title');
  const bodyText = (await evalText('document.body.innerText')) ?? '';
  const bodyHtml = (await evalText('document.body.innerHTML')) ?? '';
  const domLen = bodyHtml.length;

  console.log(`\n======== ${label} ========`);
  console.log(`标题: ${title}   DOM: ${domLen} 字符`);
  console.log(`URL: ${await evalText('location.href')}`);
  console.log(`---- 可见文字 ----`);
  console.log(bodyText || '(空)');

  // 带次数：查「同一张卡是不是画了两遍」时，只看有没有是不够的。
  const count = (hay, needle) => hay.split(needle).length - 1;
  const hits = marks.map((w) => `${w}×${count(bodyText, w)}`).filter((s) => !s.endsWith('×0'));
  console.log(`---- 标记命中（可见文字）----`);
  console.log(hits.length ? hits.join(' | ') : '（一个都没命中）');
  const domHits = marks.map((w) => `${w}×${count(bodyHtml, w)}`).filter((s) => !s.endsWith('×0'));
  console.log(`DOM 源码里: ${domHits.length ? domHits.join(' | ') : '（也没有）'}`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const shotPath = path.join(outDir, shotName);
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(`截图: ${shotPath} (${fs.statSync(shotPath).size} 字节)`);
  return bodyText;
}

if (typeText !== null) {
  const info = await evalText(FIND_INPUT);
  console.log(`\n---- 输入框 ----\n${info}`);
  if (!info || info === 'null') {
    console.log('!! 没找到可见输入框，发不了消息');
  } else {
    await cdp.send('Input.insertText', { text: typeText });
    await sleep(1000);
    const typed = await evalText(READ_INPUT);
    console.log(`打字后输入框内容: ${JSON.stringify(String(typed).slice(0, 120))}`);

    for (const t of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: t, key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
    }
    await sleep(2500);
    const after = await evalText(READ_INPUT);
    const cleared = String(after).trim().length === 0;
    console.log(`回车后输入框: ${JSON.stringify(String(after).slice(0, 80))}  → ${cleared ? '已清空，发送成功' : '还有内容，可能没发出去'}`);

    console.log(`\n等 ${wait2}ms 让 agent 干活…`);
    await sleep(wait2);
  }
}

// 直接问页面（见文件头 `--js` 说明）。
if (jsExpr !== null) {
  const r = await evalText(jsExpr);
  console.log(`\n======== --js 结果 ========`);
  console.log(typeof r === 'string' ? r : JSON.stringify(r));
}

// 通用点击：点「包含该文字的最内层元素」。
// 用途：dsh 会把 turn 收尾后的步骤折叠进「已完成」分组，得点开才能看到里面的卡片。
if (clickText !== null) {
  // innerText 只能看到「渲染出来的」，innerHTML 才能区分
  // 「被 CSS 藏起来了」和「压根没渲染」。这两者对产品含义完全不同。
  const probe = `['步已完成','需要你批准','结果：'].filter((w) => document.body.innerHTML.includes(w)).join(' | ') || '(DOM 源码里也没有)'`;
  console.log(`\n点击前 ${await evalText(probe)}`);
  const r = await evalText(`(() => {
    const target = ${JSON.stringify(clickText)};
    const els = [...document.querySelectorAll('*')].filter(
      (e) => e.children.length === 0 && e.textContent.includes(target)
    );
    if (els.length === 0) return '没找到含该文字的元素';
    els[0].click();
    return '点了: ' + els[0].textContent.trim().slice(0, 50);
  })()`);
  console.log(`点击「${clickText}」：${r}`);
  await sleep(clickWait); // 等展开渲染
  console.log(`点击后 ${await evalText(probe)}`);
}

// 独立于发消息：页面若已停在待批会话上，不带 --type 也能点。
if (deny) {
  // ⚠️ 必须在点之前拍一张 —— 点完 approval/decided 回流，卡片当场变成「结果：rejected」，
  // **待批态就没了**。而跑探针通常正是为了看那张待批卡片（D12 那轮想看的是翻牌后，
  // 但更多时候要看的是翻牌前），所以两个状态都留一份。
  await dump('点「拒绝」之前（待批态）', shotName.replace(/\.png$/i, '-pending.png'));
  const r = await evalText(DENY_NATIVE_APPROVAL);
  console.log(`\n点「拒绝」（原生审批卡）：${r}`);
  await sleep(8000); // 等 approval/decided 回流 + 我们的卡片重渲染
}

// 按 CSS 选择器点一下（用于展开 dsh 的折叠分组）。
if (clickSel !== null) {
  const r = await evalText(`(() => {
    const el = document.querySelector(${JSON.stringify(clickSel)});
    if (!el) return '没找到: ' + ${JSON.stringify(clickSel)};
    el.click();
    return '点了 ' + el.tagName + '  文字=' + (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 40);
  })()`);
  console.log(`\n点击 ${clickSel}：${r}`);
  await sleep(clickWait);
}

// 按节点 kind 精确取结构。折叠起来的节点 innerText 是空的，按文字找不着，只能按 kind 找。
if (dumpKind !== null) {
  for (const kind of dumpKind.split(',').map((s) => s.trim()).filter(Boolean)) {
    const r = await evalText(`(() => {
      const els = [...document.querySelectorAll('[data-chat-flow-kind=' + JSON.stringify(${JSON.stringify(kind)}) + ']')];
      if (els.length === 0) return '没有 kind = ${kind} 的节点';
      return els.slice(0, 2).map((e, i) =>
        '---- 第 ' + (i + 1) + ' 个 / 共 ' + els.length + ' 个 ----\\n' + e.outerHTML.slice(0, 3000)
      ).join('\\n\\n');
    })()`);
    console.log(`\n======== 节点结构 kind=${kind} ========\n${r}`);
  }
}

// 普查对话流：每种 kind 有几个、各自可不可见、写了什么。
if (flow) {
  const r = await evalText(`(() => {
    const els = [...document.querySelectorAll('[data-chat-flow-kind]')];
    const byKind = {};
    for (const e of els) {
      const k = e.getAttribute('data-chat-flow-kind');
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    const census = Object.entries(byKind).sort((a, b) => b[1] - a[1])
      .map(([k, n]) => '  ' + String(n).padStart(3) + '  ' + k).join('\\n');
    const rows = els.map((e) => {
      const k = e.getAttribute('data-chat-flow-kind');
      const hidden = e.hasAttribute('hidden') ? '[hidden]' : '[可见]';
      const t = (e.innerText || '(空文字)').replace(/\\s+/g, ' ').slice(0, 80);
      return '  ' + hidden + ' ' + k.padEnd(18) + ' :: ' + t;
    }).join('\\n');
    return '按 kind 计数:\\n' + census + '\\n\\n逐条:\\n' + rows;
  })()`);
  console.log(`\n======== 对话流节点普查 ========\n${r}`);
}

// 分不清「这段文字是谁画的」时用它：把含该文字的最内层元素连同上 4 层一起看。
if (dumpDom !== null) {

  for (const needle of dumpDom.split(',').map((s) => s.trim()).filter(Boolean)) {
    const r = await evalText(`(() => {
      const t = ${JSON.stringify(needle)};
      const leaves = [...document.querySelectorAll('*')].filter(
        (e) => e.children.length === 0 && e.textContent.includes(t)
      );
      if (leaves.length === 0) return '没找到「含该文字且没有子元素」的元素';
      return leaves.slice(0, 3).map((leaf, i) => {
        let a = leaf;
        for (let k = 0; k < 4 && a.parentElement; k++) a = a.parentElement;
        return '---- 第 ' + (i + 1) + ' 处 / 共 ' + leaves.length + ' 处，向上 4 层 ----\\n' + a.outerHTML.slice(0, 2500);
      }).join('\\n\\n');
    })()`);
    console.log(`\n======== DOM 结构（含「${needle}」）========\n${r}`);
  }
}

const bodyText = await dump('最终结果', shotName);

if (errors.length) {
  console.log(`\n---- 页面错误 (${errors.length}) ----`);
  for (const e of errors.slice(0, 20)) console.log('  ' + String(e).split('\n')[0]);
}
if (consoleLines.length) {
  console.log(`\n---- 控制台 (${consoleLines.length}) ----`);
  for (const l of consoleLines.slice(0, 30)) console.log('  ' + l);
}
void bodyText;

cdp.close();
cleanup();
process.exit(0);
