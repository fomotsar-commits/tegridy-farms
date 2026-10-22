import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

// The Changelog page shows CHANGELOG.md and docs/CHANGELOG_EARLIER.md. Vite will not read a
// file outside frontend/ as text, so this module hands over those two and nothing else
// (src/changelogFiles.d.ts). vite.config.ts and vitest.config.ts both register it.

/** Relative to frontend/. The deploy uploads both only because .vercelignore re-includes them
 *  (src/test/vercelUploadExcludesEnv.test.ts reads this list). */
export const CHANGELOG_FILES = { changelog: '../CHANGELOG.md', earlierDays: '../docs/CHANGELOG_EARLIER.md' } as const;

export function changelogFilesPlugin(): Plugin {
  const id = 'virtual:changelog-files';
  let root = process.cwd();
  return {
    name: 'changelog-files',
    configResolved(config) {
      root = config.root;
    },
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(loaded) {
      if (loaded !== `\0${id}`) return undefined;
      return Object.entries(CHANGELOG_FILES)
        .map(([name, file]) => {
          const path = resolve(root, file);
          this.addWatchFile(path);
          return `export const ${name} = ${JSON.stringify(readFileSync(path, 'utf-8'))};`;
        })
        .join('\n');
    },
  };
}
