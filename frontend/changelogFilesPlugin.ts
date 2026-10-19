import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

// The Changelog page shows CHANGELOG.md and docs/CHANGELOG_EARLIER.md. Vite will not read a
// file outside frontend/ as text, so this module hands over those two and nothing else
// (src/changelogFiles.d.ts). vite.config.ts and vitest.config.ts both register it.
export function changelogFilesPlugin(): Plugin {
  const id = 'virtual:changelog-files';
  const files = { changelog: '../CHANGELOG.md', earlierDays: '../docs/CHANGELOG_EARLIER.md' };
  let root = process.cwd();
  return {
    name: 'changelog-files',
    configResolved(config) {
      root = config.root;
    },
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(loaded) {
      if (loaded !== `\0${id}`) return undefined;
      return Object.entries(files)
        .map(([name, file]) => {
          const path = resolve(root, file);
          this.addWatchFile(path);
          return `export const ${name} = ${JSON.stringify(readFileSync(path, 'utf-8'))};`;
        })
        .join('\n');
    },
  };
}
