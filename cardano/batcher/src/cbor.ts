// A check on bytes from strangers before EMURGO's library (CSL) sees them. CSL's wasm parser
// recurses: a datum nested about 1,600 deep makes it fail with "memory access out of bounds", and
// from then on every CSL call in the process fails the same way. Anyone can put such a datum on
// an output at the order script, the pool script or the batcher's address. So every datum and
// script a source hands over is walked here first, in plain JavaScript, without recursion.

/** CSL's wasm trapped: its memory is broken for the whole process, until it restarts. */
export const isWasmTrap = (e: unknown): boolean => e instanceof Error && e.constructor.name === 'RuntimeError';

/** The deepest nesting a datum or script this batcher reads may have. Real Minswap V2 data is under 17. */
export const MAX_CBOR_DEPTH = 64;

/** Whether `hex` is one well-formed CBOR item, nested no deeper than `max`, with nothing after it. */
export function shallowCbor(hex: string, max = MAX_CBOR_DEPTH): boolean {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return false;
  const b = Buffer.from(hex, 'hex');
  // Each frame: how many items are still to read at that level (-1: indefinite, until 0xff).
  const stack: number[] = [];
  let p = 0;
  const arg = (info: number): number | null => {
    if (info < 24) return info;
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (n === 0 || p + n >= b.length) return null;
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + b[p + 1 + i]!;
    return v;
  };
  const headLen = (info: number) => (info < 24 ? 1 : 1 + (info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 8));
  const done = () => {
    // One item finished: count it against the enclosing levels that are now complete.
    while (stack.length) {
      const top = stack.length - 1;
      if (stack[top] === -1) return;
      stack[top]!--;
      if (stack[top]! > 0) return;
      stack.pop();
    }
  };
  for (;;) {
    if (p >= b.length) return false;
    const first = b[p]!;
    if (first === 0xff) {
      if (!stack.length || stack[stack.length - 1] !== -1) return false;
      p++;
      stack.pop();
      done();
      if (!stack.length) return p === b.length;
      continue;
    }
    const major = first >> 5;
    const info = first & 31;
    if (info >= 28 && info <= 30) return false;
    const indefinite = info === 31;
    if (major === 0 || major === 1 || major === 7) {
      if (indefinite) return false;
      p += headLen(info);
    } else if (major === 2 || major === 3) {
      if (indefinite) {
        // Chunks of a definite length, until 0xff.
        p++;
        while (b[p] !== 0xff) {
          if (p >= b.length || b[p]! >> 5 !== major || (b[p]! & 31) === 31) return false;
          const n = arg(b[p]! & 31);
          if (n === null) return false;
          p += headLen(b[p]! & 31) + n;
        }
        p++;
      } else {
        const n = arg(info);
        if (n === null) return false;
        p += headLen(info) + n;
      }
    } else if (major === 4 || major === 5) {
      if (stack.length >= max) return false;
      const n = indefinite ? -1 : arg(info);
      if (n === null) return false;
      p += indefinite ? 1 : headLen(info);
      // An empty list or map is one finished item (counted below); any other opens a level.
      if (n !== 0) {
        stack.push(n === -1 ? -1 : major === 5 ? n * 2 : n);
        continue;
      }
    } else if (major === 6) {
      // A tag wraps one item: it nests too.
      if (indefinite || stack.length >= max) return false;
      const n = arg(info);
      if (n === null) return false;
      p += headLen(info);
      stack.push(1);
      continue;
    }
    if (p > b.length) return false;
    done();
    if (!stack.length) return p === b.length;
  }
}
