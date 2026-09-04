// ONE PLACE MAY CONSTRUCT AN OS NOTIFICATION.
//
// `new Notification()` is an illegal constructor in page context on Android
// Chrome: it throws TypeError regardless of permission. Four hooks each held a
// private `try { new Notification(...) } catch { }`, so on Android four features
// showed nothing while their code paths carried on as though they had. The fix is
// a shared helper with a service-worker fallback and a boolean return — and the
// fix only stays fixed if nobody adds a fifth private copy.
//
// A source grep rather than a runtime assertion, in the artStudioCoverage
// pattern: the failure being prevented is a new call site, which no runtime test
// would ever reach.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const HELPER = join(SRC, 'lib', 'alerts', 'webNotification.ts');

/**
 * `src/nakamigos` is excluded on purpose: it is a separately-mounted surface with
 * its own notification module (nakamigos/lib/notifications.js) that already
 * routes through a service-worker registration for this exact reason.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'nakamigos') out.push(...sourceFiles(path));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.(test|stories)\./.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function filesMatching(pattern: RegExp): string[] {
  return sourceFiles(SRC).filter((file) => {
    const source = readFileSync(file, 'utf8');
    // Skip the lines that only TALK about the API in a comment.
    return source
      .split('\n')
      .some((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*') && pattern.test(line));
  });
}

describe('the notification API has exactly one call site', () => {
  it('only lib/alerts/webNotification.ts constructs a Notification', () => {
    const sites = filesMatching(/new Notification\(/);
    expect(
      sites,
      `a private new Notification() is dead code on Android Chrome — call showNotification() from lib/alerts/webNotification.ts instead:\n${sites.join('\n')}`,
    ).toEqual([HELPER]);
  });

  it('only lib/alerts/webNotification.ts requests permission', () => {
    // A permission request fired from anywhere but a click handler is denied,
    // and Chrome penalises the origin for having asked.
    const sites = filesMatching(/Notification\.requestPermission\(/);
    expect(sites, `request permission through the shared helper:\n${sites.join('\n')}`).toEqual([HELPER]);
  });
});
