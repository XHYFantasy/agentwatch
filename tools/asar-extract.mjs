// 从 Electron asar 归档中抽取文件。
// 用法: node asar-extract.mjs <app.asar> <归档内前缀> <输出目录>
// 前缀示例: /dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development
import fs from 'node:fs';
import path from 'node:path';

const [archive, prefix, outDir] = process.argv.slice(2);
if (!archive || !prefix || !outDir) {
  console.error('用法: node asar-extract.mjs <app.asar> <归档内前缀> <输出目录>');
  process.exit(2);
}

const fd = fs.openSync(archive, 'r');
try {
  const sizeBuf = Buffer.alloc(8);
  fs.readSync(fd, sizeBuf, 0, 8, 0);
  const headerSize = sizeBuf.readUInt32LE(4);

  const headerBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, headerBuf, 0, headerSize, 8);

  const asString = headerBuf.toString('utf8');
  const start = asString.indexOf('{');
  const jsonSize = headerBuf.readUInt32LE(0);
  let header;
  try {
    header = JSON.parse(asString.slice(start, start + jsonSize));
  } catch {
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

  const dataStart = 8 + headerSize;
  const normPrefix = prefix.replace(/\/+$/, '');
  let written = 0;

  function walk(node, current) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = current + '/' + name;
      if (entry.files) { walk(entry, p); continue; }
      if (!p.startsWith(normPrefix)) continue;

      const rel = p.slice(normPrefix.length).replace(/^\/+/, '');
      const dest = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });

      const buf = Buffer.alloc(entry.size);
      fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
      fs.writeFileSync(dest, buf);
      written++;
      console.log(`${p}  ->  ${dest}  (${entry.size} B)`);
    }
  }

  walk(header, '');
  console.log(`\n共写出 ${written} 个文件到 ${outDir}`);
} finally {
  fs.closeSync(fd);
}
