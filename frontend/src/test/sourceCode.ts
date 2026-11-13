/**
 * Source with comments removed, read once from the top: a `//` line that carries `/*`
 * (41 files open with one: "any @solana/* import") is a line comment and nothing more,
 * and `//` inside a string stays in the string. The structural fences read source through
 * this, so a comment that NAMES a call is not the call, and no comment hides one
 * (lib/solana/senders.guard.test.ts, hooks/receiptConsumers.guard.test.ts). Island answer
 * thirty-three, §3.
 */
export function code(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    const d = s[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n && s[i] !== c) {
        if (s[i] === '\\') out += s[i++];
        if (c !== '`' && s[i] === '\n') break;
        out += s[i++];
      }
      if (i < n) out += s[i++];
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
