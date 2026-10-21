export interface ChangelogDay {
  date: string;
  items: string[];
}

const DAY_HEADING = /^### (\d{4}-\d{2}-\d{2})$/;

/**
 * The days of CHANGELOG.md, or of docs/CHANGELOG_EARLIER.md, in file order.
 * `### YYYY-MM-DD` opens a day, each `- ` line under it is one item, and any `## `
 * heading closes it. The build reads both files, so a merge that adds a line adds it here.
 */
export function daysFromChangelog(text: string): ChangelogDay[] {
  const days: ChangelogDay[] = [];
  let day: ChangelogDay | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (DAY_HEADING.test(line)) {
      day = { date: longDate(line.slice(4)), items: [] };
      days.push(day);
    } else if (line.startsWith('## ')) {
      day = null;
    } else if (day && line.startsWith('- ')) {
      day.items.push(line.slice(2).replace(/`/g, ''));
    }
  }
  return days.filter((d) => d.items.length > 0);
}

/** 2026-10-18 as "October 18, 2026", the way the hand-written entries date themselves. */
function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
