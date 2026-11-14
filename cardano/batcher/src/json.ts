// JSON that keeps every integer exact, both ways. Plain JSON.parse turns 9,223,372,036,854,775,807
// (about what a pool holds in unissued LP tokens) into 9223372036854775808: a pool read that way
// is a different pool, and the node rejects the batch built from it. Every chain source (Ogmios,
// Kupo, Koios) is read and written through these two.

/** Every integer becomes a bigint, read from its own digits; other numbers stay numbers. */
export function parseExact(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    const source = context?.source;
    if (source === undefined) throw new Error('this runtime cannot read JSON numbers exactly (needs JSON.parse source access, Node 21+)');
    return /^-?\d+$/.test(source) ? BigInt(source) : value;
  });
}

/** Bigints are written as plain JSON integers, digit for digit. */
export function stringifyExact(value: unknown): string {
  const raw = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
  if (!raw) throw new Error('this runtime cannot write JSON numbers exactly (needs JSON.rawJSON, Node 21+)');
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? raw(v.toString()) : v));
}
