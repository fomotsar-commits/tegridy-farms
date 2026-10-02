/**
 * Reading back a generated overrides module, so a SCOPED save can keep the keys
 * it is not responsible for.
 *
 * Dev-tooling only — imported by vite.config.ts's save middleware, never by the
 * app. It lives under src/ purely so vitest can reach it; nothing in the client
 * bundle imports it.
 *
 * WHY THIS EXISTS. Both studios used to POST the ENTIRE overrides map and the
 * middleware rewrote the whole file. Each studio tab seeds that map once, when
 * it mounts, and holds the snapshot — so the last tab to save silently erased
 * everything saved from any other tab since. Measured 2026-08-31: three tabs
 * wiped each other's placements in 3.3 seconds. A scoped save replaces only
 * `${scope}|*` and leaves every other resident's keys exactly as found.
 */

export type OverrideEntry = { artId: string; objectPosition?: string; scale?: number };

/**
 * Entry lines as the middleware itself writes them:
 *
 *     "bayla|farm:0": { artId: "bayla-03", objectPosition: "50% 20%", scale: 1.2 },
 *
 * A regex is adequate because this only ever parses machine-written output (the
 * module header tells humans not to hand-edit it). It is deliberately strict:
 * any line inside the literal that does not match throws.
 */
const ENTRY_LINE =
  /^\s*"((?:[^"\\]|\\.)*)":\s*\{\s*artId:\s*"((?:[^"\\]|\\.)*)"(?:,\s*objectPosition:\s*"((?:[^"\\]|\\.)*)")?(?:,\s*scale:\s*(-?[\d.]+))?\s*\},?\s*$/;

/**
 * Parse the `export const <exportName>` object literal out of a generated
 * overrides module.
 *
 * Throws rather than returning what it managed to read. That is the whole
 * contract: the caller is about to REWRITE this file from the result, so a
 * partial read would silently delete every key it failed to recover — the exact
 * data loss the scoped save exists to prevent. An unreadable file must not read
 * as an empty one.
 */
export function parseOverrideModule(src: string, exportName: string): Record<string, OverrideEntry> {
  const open = new RegExp(`export const ${exportName}\\s*:[^=]*=\\s*\\{\\s*\\n`).exec(src);
  if (!open) throw new Error(`could not find "export const ${exportName}" object literal`);
  const bodyStart = open.index + open[0].length;
  const close = src.indexOf('\n};', bodyStart);
  if (close === -1) throw new Error(`unterminated ${exportName} object literal`);

  const out: Record<string, OverrideEntry> = {};
  for (const line of src.slice(bodyStart, close).split('\n')) {
    if (line.trim() === '') continue;
    const m = ENTRY_LINE.exec(line);
    if (!m) throw new Error(`unparseable override line: ${line.trim().slice(0, 120)}`);
    const entry: OverrideEntry = { artId: JSON.parse(`"${m[2]}"`) as string };
    if (m[3] !== undefined) entry.objectPosition = JSON.parse(`"${m[3]}"`) as string;
    if (m[4] !== undefined) entry.scale = Number(m[4]);
    out[JSON.parse(`"${m[1]}"`) as string] = entry;
  }
  return out;
}

/**
 * The keys that should end up in the file: everything on disk that is NOT this
 * scope, plus everything the scope just sent.
 */
export function mergeScoped(
  existing: Record<string, OverrideEntry>,
  scope: string,
  incoming: Record<string, OverrideEntry>,
): Record<string, OverrideEntry> {
  const prefix = `${scope}|`;
  const kept = Object.fromEntries(Object.entries(existing).filter(([k]) => !k.startsWith(prefix)));
  return { ...kept, ...incoming };
}
