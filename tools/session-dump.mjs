// 把 dsh 的会话事件日志（session.v4.jsonl.zstd）解开来看。
//
// 为什么需要它：写 Conversation 事件 Definition 之前，必须知道目标事件的真实报文
// 长什么样——`match` 判什么字段、`start` 存什么 state，全靠这个。
// Node 24 的 zlib 自带 zstd 解压，所以不用装任何东西。
//
// 用法:
//   node session-dump.mjs                  # 取最近修改的那个会话，列事件类型统计
//   node session-dump.mjs types            # 同上（显式）
//   node session-dump.mjs dump step/end        # 打印该类型全部事件的完整 JSON
//   node session-dump.mjs dump approval/request
//   node session-dump.mjs dump step/end 1      # 只看第 1 条
//   node session-dump.mjs <文件路径> [子命令] [参数]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ⚠️ 不要写死本机用户目录 —— 这个文件要公开，路径里的账号名会跟着一起发出去。
//    dsh 的会话根可被 DSH_HOME 覆盖，取不到才退回 ~/.dsh。
const SESSIONS_ROOT = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');

/** 找最近修改的 .zstd 会话文件。 */
function newestSessionFile() {
  let best = null;
  for (const ws of fs.readdirSync(SESSIONS_ROOT)) {
    const wsDir = path.join(SESSIONS_ROOT, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const s of fs.readdirSync(wsDir)) {
      const f = path.join(wsDir, s, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const m = fs.statSync(f).mtimeMs;
      if (best === null || m > best.mtimeMs) best = { file: f, mtimeMs: m, ws, s };
    }
  }
  return best;
}

// ⚠️ 这个日志是**分帧追加**的 zstd（每次写各成一帧）。
// 实测：`zstdDecompressSync` 和流式 `createZstdDecompress` **都只解第一帧**
// （55KB 的文件只吐出 ~300 字节，后面的全丢）。所以只能自己按魔数切帧。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressAll(buf) {
  // 收集所有可能是帧头的位置
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { starts.push(i); i += 4; }
  if (starts.length === 0) throw new Error('没有找到 zstd 帧头，这文件可能不是 zstd');
  starts.push(buf.length); // 哨兵：最后一帧到文件尾

  const parts = [];
  let frames = 0;
  for (let k = 0; k < starts.length - 1; k++) {
    const start = starts[k];
    // 到「下一个魔数」是正常边界；压缩数据里刚好撞上魔数时那一片会解不开，
    // 就往后多试几个边界（最多 4 个）。
    for (let j = k + 1; j < Math.min(starts.length, k + 5); j++) {
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(start, starts[j])));
        frames++;
        k = j - 1; // 跳到这一帧的末尾
        break;
      } catch { /* 边界不对，试下一个 */ }
    }
  }
  return { raw: Buffer.concat(parts), frames };
}

function readEvents(file) {
  const buf = fs.readFileSync(file);
  const { raw, frames } = decompressAll(buf);
  console.log(`文件 ${buf.length} 字节 → 解出 ${frames} 帧 / ${raw.length} 字节`);
  const out = [];
  for (const line of raw.toString('utf8').split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try { out.push(JSON.parse(t)); }
    catch (e) { out.push({ __parseError: e.message, __raw: t.slice(0, 200) }); }
  }
  return out;
}

// ---- 参数解析 ----
const argv = process.argv.slice(2);
let file = null;
if (argv[0] && (argv[0].endsWith('.zstd') || fs.existsSync(argv[0]))) {
  file = argv.shift();
} else {
  const newest = newestSessionFile();
  if (newest === null) { console.error('没找到任何会话文件'); process.exit(1); }
  file = newest.file;
  console.log(`会话工作区: ${newest.ws}`);
  console.log(`会话 ID    : ${newest.s}`);
  console.log(`修改时间   : ${new Date(newest.mtimeMs).toLocaleString('zh-CN')}`);
}
console.log(`文件       : ${file}\n`);

const events = await readEvents(file);
console.log(`共 ${events.length} 条事件\n`);

const cmd = argv[0] ?? 'types';

/** 描述一个值：类型 + 大小/长度，供 keys 探针用。 */
function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === 'object') return `object{${Object.keys(v).length}}`;
  if (typeof v === 'string') return `string(${v.length})`;
  return typeof v;
}

if (cmd === 'keys') {
  // 探结构：顶层键，数组再下一层。
  events.forEach((e, i) => {
    console.log(`───── 第 ${i} 行 ─────`);
    for (const [k, v] of Object.entries(e)) {
      console.log(`  ${k.padEnd(24)} ${describe(v)}`);
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null) {
        console.log(`      └─ [0] 的键: ${Object.keys(v[0]).join(', ')}`);
      } else if (v !== null && typeof v === 'object') {
        console.log(`      └─ 键: ${Object.keys(v).join(', ')}`);
      }
    }
    console.log();
  });
} else if (cmd === 'types') {
  // 事件类型统计。dsh 的 entry 有外层信封：{type, event:{type,...}} 或直接是事件。
  const counts = new Map();
  for (const e of events) {
    const t = e?.event?.type ?? e?.type ?? '(无 type)';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [t, n] of rows) console.log(`  ${t.padEnd(w)}  ${String(n).padStart(5)}`);
  console.log('\n看某个类型的完整报文:  node session-dump.mjs dump <类型>');
} else if (cmd === 'dump') {
  const want = argv[1];
  if (!want) { console.error('要指定事件类型，例如: node session-dump.mjs dump step/end'); process.exit(2); }
  const limit = argv[2] ? Number(argv[2]) : Infinity;
  const hits = events.filter((e) => (e?.event?.type ?? e?.type) === want);
  console.log(`「${want}」命中 ${hits.length} 条${Number.isFinite(limit) ? `，只看前 ${limit} 条` : ''}\n`);
  if (hits.length === 0) {
    console.log('没命中。上面 types 列出的类型里挑一个，注意大小写和斜杠。');
  }
  hits.slice(0, Number.isFinite(limit) ? limit : undefined).forEach((e, i) => {
    console.log(`───── [${i}] ─────`);
    console.log(JSON.stringify(e, null, 2));
    console.log();
  });
} else {
  console.error(`不认识的子命令: ${cmd}`);
  process.exit(2);
}
