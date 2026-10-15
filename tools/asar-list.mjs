// 列出 Electron asar 归档内的文件路径。
// 用法: node asar-list.mjs <app.asar> [关键词...]
// 关键词为空时列出全部；匹配为不区分大小写的子串。
import fs from 'node:fs';

const [archive, ...keywords] = process.argv.slice(2);
if (!archive) {
  console.error('用法: node asar-list.mjs <app.asar> [关键词...]');
  process.exit(2);
}

const fd = fs.openSync(archive, 'r');
try {
  const sizeBuf = Buffer.alloc(8);
  fs.readSync(fd, sizeBuf, 0, 8, 0);
  const headerSize = sizeBuf.readUInt32LE(4);

  const headerBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, headerBuf, 0, headerSize, 8);

  // Pickle: uint32 jsonSize 后跟 JSON，再补零对齐。容错地找到真正的 JSON 起点。
  const asString = headerBuf.toString('utf8');
  const start = asString.indexOf('{');
  const jsonSize = headerBuf.readUInt32LE(0);
  let header;
  try {
    header = JSON.parse(asString.slice(start, start + jsonSize));
  } catch {
    // 退一步：从 '{' 起做括号配平
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < asString.length; i++) {
      const c = asString[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i + 1; break; }
    }
    header = JSON.parse(asString.slice(start, end));
  }

  const out = [];
  (function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix + '/' + name;
      if (entry.files) walk(entry, p);
      else out.push(p);
    }
  })(header, '');

  const needles = keywords.map((k) => k.toLowerCase());
  const hits = needles.length
    ? out.filter((p) => needles.some((k) => p.toLowerCase().includes(k)))
    : out;

  console.log(`总计 ${out.length} 个文件，匹配 ${hits.length} 个：`);
  for (const p of hits) console.log(p);
} finally {
  fs.closeSync(fd);
}
