// 诊断用：用桌面端自带的 Node 运行时（同一套网络栈 / 同一份 CA 库）打一次
// DeepSeek Messages 端点，判断 "Messages transport failed" 是网络层还是凭据层。
// 故意用假 key —— 若传输正常，应当拿到 401（证明能连通、TLS 没问题）。
// 不读取、不打印任何真实凭据。
import dns from 'node:dns/promises';
import tls from 'node:tls';

const HOST = 'api.deepseek.com';
const URL_ = 'https://api.deepseek.com/anthropic/v1/messages';

function chain(e, depth = 0) {
  if (!e || depth > 5) return;
  console.log(`${'  '.repeat(depth)}- ${e.constructor?.name ?? typeof e}: ${e.message}`);
  for (const k of ['code', 'errno', 'syscall', 'hostname', 'status']) {
    if (e[k] !== undefined) console.log(`${'  '.repeat(depth)}    ${k} = ${e[k]}`);
  }
  chain(e.cause, depth + 1);
}

console.log('node:', process.versions.node, '| electron:', process.versions.electron ?? '(none)');
console.log('execPath:', process.execPath);
console.log('proxy env:', ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']
  .map((k) => `${k}=${process.env[k] ?? '-'}`).join(' '));

try {
  const addrs = await dns.lookup(HOST, { all: true });
  console.log('\n[1] DNS', HOST, '=>', addrs.map((a) => `${a.address}/${a.family}`).join(', '));
} catch (e) {
  console.log('\n[1] DNS 失败');
  chain(e);
}

await new Promise((resolve) => {
  console.log('\n[2] TLS 握手（用 Node 自带 CA 库验证证书链）');
  const sock = tls.connect({ host: HOST, port: 443, servername: HOST }, () => {
    const c = sock.getPeerCertificate();
    console.log('  ✓ 握手成功');
    console.log('  issuer :', c.issuer?.O, '/', c.issuer?.CN);
    console.log('  subject:', c.subject?.CN);
    console.log('  authorized:', sock.authorized, sock.authorizationError ?? '');
    sock.end();
    resolve();
  });
  sock.on('error', (e) => { console.log('  ✗ 握手失败'); chain(e); resolve(); });
  sock.setTimeout(15000, () => { console.log('  ✗ 握手超时'); sock.destroy(); resolve(); });
});

console.log('\n[3] POST', URL_, '（假 key，期望 401）');
const t0 = Date.now();
try {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-diagnostic-not-a-real-key', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(20000),
  });
  console.log(`  HTTP ${r.status} ${r.statusText}  (${Date.now() - t0}ms)`);
  console.log('  body:', (await r.text()).slice(0, 300));
} catch (e) {
  console.log(`  ✗ fetch 抛异常 (${Date.now() - t0}ms)`);
  chain(e);
}
