// 从真实会话日志里捞指定类型的事件原文，用来**核对字段名**。
//
// 为什么必须做：写 event Definition 时，字段名错一个字母（比如 `callId` 写成 `callID`）
// 不会报错 —— `?.` 静默吞掉，卡片就是不出来，排查要花很久。
// 所以每写一个 Definition，先用这个对一遍真报文。
//
// 用法:
//   node event-shape.mjs tool/call              # 每种类型第一份原文
//   node event-shape.mjs tool/call tool/result  # 多个类型
//   node event-shape.mjs --n 3 step/end         # 每种要 3 份

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ⚠️ 不要写死本机用户目录 —— 这个文件要公开，路径里的账号名会跟着一起发出去。
//    dsh 的会话根可被 DSH_HOME 覆盖，取不到才退回 ~/.dsh。
const SESSIONS_ROOT = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// 与 session-dump.mjs / tool-census.mjs 同一套分帧逻辑：日志是**分帧追加**的 zstd，
// 直接喂整个文件只吐第一帧，必须按魔数切。
function decompressAll(buf) {
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { starts.push(i); i += 4; }
  if (starts.length === 0) return null;
  starts.push(buf.length);

  const parts = [];
  for (let k = 0; k < starts.length - 1; k++) {
    const start = starts[k];
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

const argv = process.argv.slice(2);
let perType = 1;
const argIdx = argv.indexOf('--n');
if (argIdx !== -1) { perType = Number(argv[argIdx + 1]) || 1; argv.splice(argIdx, 2); }
const wanted = argv.filter((a) => !a.startsWith('--'));

if (wanted.length === 0) {
  console.log('用法: node event-shape.mjs [--n N] <事件类型> [更多类型...]');
  process.exit(1);
}

const found = new Map(wanted.map((t) => [t, []]));
let sessions = 0;

outer:
for (const ws of fs.readdirSync(SESSIONS_ROOT)) {
  const wsDir = path.join(SESSIONS_ROOT, ws);
  try { if (!fs.statSync(wsDir).isDirectory()) continue; } catch { continue; }
  for (const s of fs.readdirSync(wsDir)) {
    const file = path.join(wsDir, s, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    sessions++;
    let raw = null;
    try { raw = decompressAll(fs.readFileSync(file)); } catch { continue; }
    if (raw === null) continue;

    for (const line of raw.toString('utf8').split('\n')) {
      const t = line.trim();
      if (t === '') continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      const bucket = found.get(ev.type);
      if (bucket && bucket.length < perType) {
        bucket.push({ session: `${ws}\\${s}`, ev });
      }
      // 全部捞够了就收工
      if ([...found.values()].every((b) => b.length >= perType)) break outer;
    }
  }
}

console.log(`扫描了 ${sessions} 个会话。\n`);

for (const [type, hits] of found) {
  if (hits.length === 0) {
    console.log(`❌ ${type} —— 没找到\n`);
    continue;
  }
  for (const { session, ev } of hits) {
    console.log(`✅ ${type}   来源 ${session}`);
    // 顶层字段单列一行，方便一眼看有没有 seq/time/…
    console.log(`   顶层键: ${Object.keys(ev).join(', ')}`);
    console.log(JSON.stringify(ev, null, 2).split('\n').map((l) => '   ' + l).join('\n'));
    console.log('');
  }
}
