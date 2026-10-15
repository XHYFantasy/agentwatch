// 诊断用：跳过证书校验，把真实拿到的证书链打出来 —— 用来指认是谁在中间人。
import tls from 'node:tls';

const HOST = 'api.deepseek.com';
const sock = tls.connect({ host: HOST, port: 443, servername: HOST, rejectUnauthorized: false }, () => {
  const c = sock.getPeerCertificate(true);
  console.log('authorized:', sock.authorized, '| error:', sock.authorizationError);
  let cur = c, i = 0;
  while (cur?.raw) {
    console.log(`[${i}] subject : ${cur.subject?.CN} (O=${cur.subject?.O ?? '-'})`);
    console.log(`    issuer  : ${cur.issuer?.CN} (O=${cur.issuer?.O ?? '-'})`);
    console.log(`    valid   : ${cur.valid_from} -> ${cur.valid_to}`);
    if (!cur.issuerCertificate || cur.issuerCertificate === cur) break;
    cur = cur.issuerCertificate; i++;
  }
  sock.end();
});
sock.on('error', (e) => console.log('error:', e.code, e.message));
sock.setTimeout(15000, () => { console.log('timeout'); sock.destroy(); });
