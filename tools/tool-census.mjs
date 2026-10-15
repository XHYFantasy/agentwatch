// 统计所有 dsh 会话里出现过哪些工具名（`tool/call` 的 `name` 字段）。
//
// 为什么需要：T3 要做「工具名 → 中文动词」映射表，但**覆盖哪些工具不能靠猜** ——
// 得看 dsh 实际派出去过什么。顺带能看出各工具的使用频率，好排优先级。
//
// 用法:
//   node tool-census.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ⚠️ 不要写死本机用户目录 —— 这个文件要公开，路径里的账号名会跟着一起发出去。
//    dsh 的会话根可被 DSH_HOME 覆盖，取不到才退回 ~/.dsh。
const SESSIONS_ROOT = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// 与 session-dump.mjs 同一套分帧逻辑：那个日志是**分帧追加**的 zstd，
// zstdDecompressSync 直接喂整个文件只吐第一帧，必须按魔数切。
function decompressAll(buf) {
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { starts.push(i); i += 4; }
  if (starts.length === 0) return null;
  starts.push(buf.length); // 哨兵：最后一帧到文件尾

  const parts = [];
  for (let k = 0; k < starts.length - 1; k++) {
    const start = starts[k];
    // 到「下一个魔数」是正常边界；压缩数据里刚好撞上魔数时那一片会解不开，
    // 就往后多试几个边界（最多 4 个）。
    for (let j = k + 1; j < Math.min(starts.length, k + 5); j++) {
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(start, starts[j])));
        k = j - 1;
        break;
      } catch { /* 边界不对，试下一个 */ }
    }
  }
  return Buffer.concat(parts);
}

const names = new Map();
let sessions = 0;
let events = 0;
let unreadable = 0;

for (const ws of fs.readdirSync(SESSIONS_ROOT)) {
  const wsDir = path.join(SESSIONS_ROOT, ws);
  try { if (!fs.statSync(wsDir).isDirectory()) continue; } catch { continue; }
  for (const s of fs.readdirSync(wsDir)) {
    const file = path.join(wsDir, s, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    sessions++;
    let raw = null;
    try { raw = decompressAll(fs.readFileSync(file)); } catch { unreadable++; continue; }
    if (raw === null) { unreadable++; continue; }

    for (const line of raw.toString('utf8').split('\n')) {
      const t = line.trim();
      if (t === '') continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      events++;
      if (ev.type === 'tool/call' && typeof ev.data?.name === 'string') {
        names.set(ev.data.name, (names.get(ev.data.name) ?? 0) + 1);
      }
    }
  }
}

console.log(`扫描：${sessions} 个会话 / ${events} 条事件${unreadable ? `（${unreadable} 个解不开）` : ''}\n`);

if (names.size === 0) {
  console.log('没扫到任何 tool/call。');
} else {
  const total = [...names.values()].reduce((a, b) => a + b, 0);
  console.log('工具名分布：');
  for (const [n, c] of [...names].sort((a, b) => b[1] - a[1])) {
    const pct = ((c / total) * 100).toFixed(0).padStart(3);
    console.log(`  ${String(c).padStart(5)}  ${pct}%  ${n}`);
  }
  console.log(`\n共 ${names.size} 种工具 / ${total} 次调用。`);
}
