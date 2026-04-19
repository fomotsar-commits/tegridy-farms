#!/usr/bin/env node
// One-shot migration: rewrite `<img src={pageArt('X', N).src} ...>` to
// `<ArtImg pageId="X" idx={N} ...>` so /art-studio's objectPosition slider
// actually propagates. Also handles `style={{ objectPosition: '...' }}` →
// `fallbackPosition="..."`.
//
// Idempotent: rerunning skips already-converted files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../src');

// Match an entire <img ... /> self-closing tag whose src is pageArt(...).src.
// Captures the full attribute blob between <img and />.
//   group 1: page id (single-quoted string)
//   group 2: idx (number, simple var, or simple expr like `2 + i`)
//   group 3: any attrs BEFORE the src
//   group 4: any attrs AFTER the src
const IMG_RE = /<img\s+([^>]*?)src=\{pageArt\(\s*'([^']+)'\s*,\s*([^)]+?)\s*\)\.src\}([^>]*?)\/>/gs;

// Pull objectPosition out of an attribute blob if present.
//   matches:  style={{ objectPosition: 'X' }}     (and double-quoted variant)
const POS_RE = /\s*style=\{\{\s*objectPosition:\s*['"]([^'"]+)['"]\s*\}\}/;

function migrateFile(absPath) {
  const orig = fs.readFileSync(absPath, 'utf8');
  let out = orig;
  let changed = false;

  out = out.replace(IMG_RE, (_, attrsBefore, pageId, idx, attrsAfter) => {
    changed = true;
    const all = `${attrsBefore} ${attrsAfter}`.replace(/\s+/g, ' ').trim();
    let cleaned = all;
    let fallbackPos = null;
    const posMatch = all.match(POS_RE);
    if (posMatch) {
      fallbackPos = posMatch[1];
      cleaned = all.replace(POS_RE, '').replace(/\s+/g, ' ').trim();
    }
    // Quote the idx prop. Numbers stay raw, expressions get JSX braces.
    const idxClean = idx.trim();
    const idxProp = /^\d+$/.test(idxClean) ? `idx={${idxClean}}` : `idx={${idxClean}}`;
    const fallbackAttr = fallbackPos ? ` fallbackPosition="${fallbackPos}"` : '';
    const trailing = cleaned ? ` ${cleaned}` : '';
    return `<ArtImg pageId="${pageId}" ${idxProp}${fallbackAttr}${trailing} />`;
  });

  if (!changed) return false;

  // Add ArtImg import if missing. Choose path relative to file location.
  if (!/from ['"][^'"]*ArtImg['"]/.test(out)) {
    const fromFile = path.dirname(absPath);
    const target = path.join(ROOT, 'components', 'ArtImg');
    let rel = path.relative(fromFile, target).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    const importLine = `import { ArtImg } from '${rel}';\n`;
    // Try to insert after the last existing `import` line.
    const lastImportIdx = out.lastIndexOf('\nimport ');
    if (lastImportIdx >= 0) {
      const eol = out.indexOf('\n', lastImportIdx + 1);
      out = out.slice(0, eol + 1) + importLine + out.slice(eol + 1);
    } else {
      out = importLine + out;
    }
  }

  fs.writeFileSync(absPath, out, 'utf8');
  return true;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'nakamigos') continue;
    if (entry.name === 'ArtImg.tsx') continue;
    if (entry.name === 'ArtStudioPage.tsx') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) yield full;
  }
}

let touched = 0;
for (const file of walk(ROOT)) {
  const before = fs.readFileSync(file, 'utf8');
  if (!IMG_RE.test(before)) continue;
  IMG_RE.lastIndex = 0; // reset stateful regex
  if (migrateFile(file)) {
    touched++;
    console.log(`✓ ${path.relative(ROOT, file)}`);
  }
}
console.log(`\n${touched} file(s) migrated.`);
