#!/usr/bin/env node
// Advisory gate for the repo's npm projects: a high or critical advisory blocks unless a list
// forgives it. The unit is the GHSA id, never the package, so the next advisory in the same
// package still blocks. Two lists forgive, both per project and both dated:
//   baseline  "this was already here": no reason claimed, one shared expiry.
//   accepted  "we looked and decided to carry it": a written reason, its own expiry, and the
//             projects the reason was judged for. It counts in those projects and no other.

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

/**
 * `npm audit --json` exits non-zero when it finds anything, so the exit code
 * cannot distinguish "found advisories" from "could not reach the registry" —
 * and a network failure prints no `vulnerabilities` key at all. Reading that
 * as zero advisories is an outage rendering as a clean bill of health, so an
 * unusable report is a hard error rather than an empty result.
 */
export function assertUsableReport(report, source = 'npm audit') {
  if (!report || typeof report !== 'object') {
    throw new Error(`${source}: no JSON object — the audit did not produce a report`);
  }
  if (report.error) {
    const detail = report.error.summary || report.error.code || JSON.stringify(report.error);
    throw new Error(`${source}: audit reported an error (${detail})`);
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    throw new Error(
      `${source}: report has no "vulnerabilities" map. This is what a registry failure looks like; ` +
        'it is not the same as a clean audit.',
    );
  }
  const counts = report.metadata?.vulnerabilities;
  if (!counts || typeof counts.total !== 'number') {
    throw new Error(`${source}: report has no metadata.vulnerabilities.total — shape is not recognisable`);
  }
  return report;
}

/**
 * Flatten the audit tree to one row per advisory.
 *
 * npm nests: each `vulnerabilities[pkg].via[]` is either an advisory object
 * (this package's own finding) or a string (the parent package that drags the
 * finding in). Only the objects carry a GHSA id, and each id appears exactly
 * once — at the package that actually has the flaw — so the transitive chain
 * is collapsed for free.
 */
export function collectAdvisories(report) {
  const byId = new Map();
  for (const node of Object.values(report.vulnerabilities)) {
    for (const via of node?.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      const ghsa = String(via.url ?? '').split('/').pop();
      if (!ghsa || !ghsa.startsWith('GHSA-')) continue;
      if (byId.has(ghsa)) continue;
      byId.set(ghsa, {
        ghsa,
        package: via.name ?? node.name ?? 'unknown',
        severity: String(via.severity ?? 'unknown').toLowerCase(),
        title: via.title ?? '',
        url: via.url ?? '',
        fixAvailable: node?.fixAvailable ?? false,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.ghsa.localeCompare(b.ghsa));
}

/** `YYYY-MM-DD` compared as a date, not a string — a bad date must not silently pass. */
function isExpired(expires, now) {
  if (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return true;
  const t = Date.parse(`${expires}T23:59:59.999Z`);
  return Number.isNaN(t) || t < now.getTime();
}

/**
 * The projects an acceptance was judged for. A reason is about one dependency tree, so an
 * entry with no `projects` list was judged for none and forgives nothing.
 */
function scopeOf(entry) {
  return Array.isArray(entry?.projects) ? entry.projects : [];
}

/**
 * Why an advisory blocks when no list forgives it here: an acceptance may exist for another
 * project, or for none.
 */
function whyUnforgiven(entries, ghsa) {
  const sameId = entries.filter((e) => e.ghsa === ghsa);
  if (sameId.length === 0) return 'new high/critical advisory';
  const elsewhere = sameId.flatMap(scopeOf);
  return elsewhere.length > 0
    ? `accepted for ${elsewhere.join(', ')} only, not judged for this project`
    : 'accepted without a `projects` list, so for no project';
}

/**
 * Every entry in `blocking` carries `why`: the sentence the summary and the `::error`
 * annotation print, and the thing the tests assert on.
 *
 * @typedef {{ghsa: string, package: string, severity: string, title: string, url: string, fixAvailable: boolean}} Advisory
 * @returns {{blocking: (Advisory & {why: string})[], accepted: (Advisory & {reason: string, expires: string})[], baselined: (Advisory & {expires: string})[], stale: string[], suppressedTotal: number}}
 */
export function evaluate({ report, allowlist, project, now = new Date() }) {
  assertUsableReport(report, `npm audit (${project})`);
  const found = collectAdvisories(report).filter((a) => BLOCKING_SEVERITIES.has(a.severity));

  // Only this project's acceptances exist from here on: for suppressing and for the stale report.
  const entries = allowlist?.accepted ?? [];
  const accepted = new Map(entries.filter((e) => scopeOf(e).includes(project)).map((e) => [e.ghsa, e]));
  const baseline = allowlist?.baseline ?? {};
  const baselineIds = new Set(baseline.projects?.[project] ?? []);
  const baselineDead = isExpired(baseline.expires, now);

  const out = { blocking: [], accepted: [], baselined: [], stale: [], suppressedTotal: 0 };

  for (const adv of found) {
    const entry = accepted.get(adv.ghsa);
    if (entry) {
      // An accepted entry with no written reason is not an acceptance, it is a
      // silencer. Treat it as absent.
      if (!entry.reason || String(entry.reason).trim().length < 10) {
        out.blocking.push({ ...adv, why: 'allowlisted without a written reason' });
        continue;
      }
      if (isExpired(entry.expires, now)) {
        out.blocking.push({ ...adv, why: `acceptance expired ${entry.expires}` });
        continue;
      }
      out.accepted.push({ ...adv, reason: entry.reason, expires: entry.expires });
      continue;
    }
    if (baselineIds.has(adv.ghsa)) {
      if (baselineDead) {
        out.blocking.push({ ...adv, why: `baseline expired ${baseline.expires} — inherited debt is now due` });
        continue;
      }
      out.baselined.push({ ...adv, expires: baseline.expires });
      continue;
    }
    out.blocking.push({ ...adv, why: whyUnforgiven(entries, adv.ghsa) });
  }

  // This project's suppressions whose advisory is gone from it. Reported, never fatal: a
  // dependency bump that fixes something must not turn the build red.
  const present = new Set(found.map((a) => a.ghsa));
  for (const id of baselineIds) if (!present.has(id)) out.stale.push(id);
  for (const id of accepted.keys()) if (!present.has(id)) out.stale.push(id);
  out.stale.sort();

  out.suppressedTotal = out.accepted.length + out.baselined.length;
  return out;
}

export function renderSummary(project, result) {
  const lines = [`### npm advisories — \`${project}\``, ''];
  if (result.blocking.length === 0) {
    lines.push(`No unforgiven high/critical advisories. ${result.suppressedTotal} suppressed (listed below).`);
  } else {
    lines.push(`**${result.blocking.length} blocking high/critical advisor${result.blocking.length === 1 ? 'y' : 'ies'}.**`);
    lines.push('', '| severity | package | advisory | why it blocks | fix |', '|---|---|---|---|---|');
    for (const a of result.blocking) {
      const fix = a.fixAvailable === false ? 'none published' : a.fixAvailable?.isSemVerMajor ? 'semver-major' : 'available';
      lines.push(`| ${a.severity} | \`${a.package}\` | [${a.ghsa}](${a.url}) | ${a.why} | ${fix} |`);
    }
  }
  if (result.suppressedTotal > 0) {
    lines.push('', '<details><summary>Suppressed</summary>', '');
    lines.push('| kind | package | advisory | expires | reason |', '|---|---|---|---|---|');
    for (const a of result.accepted) {
      lines.push(`| accepted | \`${a.package}\` | ${a.ghsa} | ${a.expires} | ${a.reason} |`);
    }
    for (const a of result.baselined) {
      lines.push(`| baseline | \`${a.package}\` | ${a.ghsa} | ${a.expires} | inherited at arming, untriaged |`);
    }
    lines.push('', '</details>');
  }
  if (result.stale.length > 0) {
    // "For this project": an acceptance may name other projects that still need it.
    lines.push(
      '',
      `Suppressions no longer matching any advisory in \`${project}\` (prune them for this project): ` +
        result.stale.join(', '),
    );
  }
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────
// node npm-advisory-gate.mjs --project frontend --report audit.json --allowlist .github/npm-advisory-allowlist.json

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ''), argv[i + 1]);
  const project = args.get('project');
  const reportPath = args.get('report');
  const allowlistPath = args.get('allowlist');
  if (!project || !reportPath || !allowlistPath) {
    console.error('usage: npm-advisory-gate.mjs --project <name> --report <audit.json> --allowlist <allowlist.json>');
    return 2;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  } catch (e) {
    console.error(`::error title=Advisory gate could not read the audit::${reportPath}: ${e.message}`);
    return 1;
  }
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf-8'));

  let result;
  try {
    result = evaluate({ report, allowlist, project });
  } catch (e) {
    console.error(`::error title=Advisory gate could not trust the audit::${e.message}`);
    return 1;
  }

  const summary = renderSummary(project, result);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n`);
  }

  if (result.blocking.length > 0) {
    console.error(
      `::error title=Blocking npm advisories in ${project}::${result.blocking.length} high/critical advisor` +
        `${result.blocking.length === 1 ? 'y' : 'ies'} are neither baselined nor accepted for this project. Upgrade the ` +
        'dependency, or add a dated entry with a written reason, naming this project, to ' +
        '.github/npm-advisory-allowlist.json in the same PR.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
