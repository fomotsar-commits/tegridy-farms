#!/usr/bin/env node
// Advisory gate for the repo's npm projects.
//
// `npm audit` has never failed a build here. Dependabot raises version-drift
// PRs, which is a different question: drift asks "is there a newer release",
// an advisory asks "is the version you ship known-exploitable". At arming time
// this repo carried 40 advisories in frontend/ and 15 in indexer/, including a
// bigint-buffer heap overflow reachable through @solana/spl-token — in an
// application that signs transactions.
//
// WHY THIS IS NOT A PLAIN `npm audit --audit-level=high`:
//
// A gate that is red on the day it is armed is deleted within a week, and the
// 10 high advisories inherited on 2026-08-18 cannot all be fixed in the commit
// that arms it (@solana/spl-token's only fix is a semver-major downgrade to
// 0.1.8). So inherited debt is recorded — every GHSA id, verbatim, from the
// arming measurement — under a BASELINE that carries a hard expiry date. New
// advisories are blocking from the first run; inherited ones become blocking
// on the baseline's expiry whether or not anyone looked at them.
//
// Two suppression mechanisms, deliberately not one:
//   * `baseline`  — "this was already here." No judgement claimed, no reason
//                   invented. Expires as a block.
//   * `accepted`  — "we looked at this and decided to carry it." Requires a
//                   written reason and its own expiry.
// Collapsing them into one list would mean writing a fabricated rationale for
// 32 advisories nobody has triaged, which is the exact shape of dishonesty the
// house forbids.
//
// The unit of suppression is the GHSA id, never the package name. Suppressing
// "axios" would silently absorb next quarter's axios advisory too.

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
 * @returns {{blocking: object[], accepted: object[], baselined: object[], stale: string[], suppressedTotal: number}}
 */
export function evaluate({ report, allowlist, project, now = new Date() }) {
  assertUsableReport(report, `npm audit (${project})`);
  const found = collectAdvisories(report).filter((a) => BLOCKING_SEVERITIES.has(a.severity));

  const accepted = new Map((allowlist?.accepted ?? []).map((e) => [e.ghsa, e]));
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
    out.blocking.push({ ...adv, why: 'new high/critical advisory' });
  }

  // Suppressions for advisories that are gone. Reported, never fatal: a
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
    lines.push('', `Suppressions no longer matching any advisory (prune them): ${result.stale.join(', ')}`);
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
        `${result.blocking.length === 1 ? 'y' : 'ies'} are neither baselined nor accepted. Upgrade the dependency, or ` +
        'add a dated entry with a written reason to .github/npm-advisory-allowlist.json in the same PR.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
