// A minimal ustar writer and reader, so a backup is bundled in memory and the plaintext
// never touches disk. The writer emits what `tar -xz` expects; the reader also accepts
// GNU tar output (the GitHub workflow's `tar -czf`), including long-name and pax records.

const BLOCK = 512;

function octal(value, width) {
  const s = value.toString(8);
  if (s.length > width - 1) throw new Error(`tar: ${value} does not fit a ${width}-byte field`);
  return s.padStart(width - 1, '0') + '\0';
}

function header({ name, type, size, mtime, mode }) {
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > 100) throw new Error(`tar: name longer than 100 bytes: ${name}`);
  const h = Buffer.alloc(BLOCK, 0);
  nameBytes.copy(h, 0);
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(mtime, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

/** entries: [{ name, dir?: true, data?: Buffer }]. Returns the uncompressed archive. */
export function createTar(entries, { mtime = Math.floor(Date.now() / 1000) } = {}) {
  const parts = [];
  for (const e of entries) {
    const data = e.dir ? Buffer.alloc(0) : Buffer.from(e.data ?? '');
    parts.push(header({ name: e.name, type: e.dir ? '5' : '0', size: data.length, mtime, mode: e.dir ? 0o755 : 0o644 }));
    if (data.length) {
      parts.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

function cstring(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

function readSize(h) {
  if (h[124] & 0x80) {
    let n = 0n;
    for (let i = 125; i < 136; i++) n = (n << 8n) | BigInt(h[i]);
    return Number(n);
  }
  const s = cstring(h, 124, 12).trim();
  return s ? parseInt(s, 8) : 0;
}

function checksumOk(h) {
  const stored = parseInt(cstring(h, 148, 8).trim(), 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

/** Parse an uncompressed archive into [{ name, type: 'file'|'dir'|'other', data }]. Throws on damage. */
export function readTar(buf) {
  const out = [];
  let off = 0;
  let longName = null;
  let paxPath = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) return out;
    if (!checksumOk(h)) throw new Error(`tar: bad header checksum at byte ${off}`);
    const size = readSize(h);
    const type = String.fromCharCode(h[156] || 0x30);
    const dataStart = off + BLOCK;
    if (dataStart + size > buf.length) throw new Error(`tar: entry at byte ${off} runs past the end`);
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') { longName = cstring(data, 0, data.length); continue; }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;
    let name = cstring(h, 0, 100);
    const prefix = cstring(h, 345, 155);
    if (cstring(h, 257, 5) === 'ustar' && prefix) name = `${prefix}/${name}`;
    name = paxPath ?? longName ?? name;
    longName = null;
    paxPath = null;
    const kind = type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'dir' : 'other';
    out.push({ name, type: kind, data: kind === 'file' ? Buffer.from(data) : Buffer.alloc(0) });
  }
  throw new Error('tar: archive ended without its end-of-archive blocks (truncated?)');
}
