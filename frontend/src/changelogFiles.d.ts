// The text of CHANGELOG.md and docs/CHANGELOG_EARLIER.md, from vite.config.ts's
// changelogFilesPlugin, read at build time.
declare module 'virtual:changelog-files' {
  export const changelog: string;
  export const earlierDays: string;
}
