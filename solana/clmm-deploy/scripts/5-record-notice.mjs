#!/usr/bin/env node
// RECORD THE FEE NOTICE. READ-ONLY on chain. It reads mvp-launch's history on GitHub: every commit
// on its merge line since this folder was staged, and the changelog at each (CHANGELOG.md, or
// docs/CHANGELOG_EARLIER.md once the day moves there). The notice runs from the merge since which
// every commit has carried the exact line, and never before this script first saw it public; a
// commit without the line starts it again. It writes owner-run\notice.json with the network's time.
// Run it again before the approval and before the execute: the page wants a check under an hour old.
//
//   node 5-record-notice.mjs [--rpc <url>]
import fs from 'node:fs';
import path from 'node:path';
import { CFG, PACK, args, connect, cluster, rpcFor, clock, Report, main, Unread } from './lib/pack.mjs';
import { noticeEnds } from './lib/tiers.mjs';

async function get(url, json) {
  let r;
  try { r = await fetch(url, { headers: { accept: json ? 'application/vnd.github+json' : 'text/plain', 'user-agent': 'memetics-range-pools-notice' } }); } catch (e) { throw new Unread(`UNREAD: ${url} could not be read (${e.message})`); }
  if (!json && r.status === 404) return null;
  if (!r.ok) throw new Unread(`UNREAD: ${url} answered HTTP ${r.status}${r.status === 403 || r.status === 429 ? ' (GitHub limits how often it may be asked: wait an hour)' : ''}`);
  return json ? r.json() : r.text();
}

/** The line on mvp-launch's merge line (first parents) since staging: { live, continuousSince, ... }. */
export async function readNotice(n = CFG.notice, since = CFG.stagedAt) {
  const { api, raw, branch } = n.repo;
  const head = (await get(`${api}/commits/${branch}`, true)).sha;
  const known = new Map();
  for (let page = 1; ; page++) {
    const list = await get(`${api}/commits?sha=${branch}&since=${since}&per_page=100&page=${page}`, true);
    for (const c of list) known.set(c.sha, { sha: c.sha, date: c.commit.committer.date, parent: c.parents[0]?.sha ?? null });
    if (list.length < 100) break;
    if (page === 30) throw new Unread('UNREAD: more than 3,000 commits since staging');
  }
  // The merge line, newest first. It ends at the first commit older than the staging (or one
  // fast-forwarded in with an older date): a shorter line only makes the notice start later.
  const line = [];
  for (let sha = head; known.has(sha); sha = known.get(sha).parent) line.push(known.get(sha));
  const has = async (sha) => {
    for (const f of n.files) {
      const t = await get(`${raw}/${sha}/${f}`, false);
      if (t !== null && t.replace(/\r/g, '').split('\n').includes(n.line)) return true;
    }
    return false;
  };
  // Nothing merged since staging: the newest commit is older than this folder.
  if (!line.length) {
    if (await has(head)) throw new Unread(`UNREAD: the line is on ${branch}'s newest commit ${head}, older than this folder (${since}): stop and ask`);
    return { head, commits: 0, live: false, continuousSince: null, firstCommit: null, gapBefore: null };
  }
  let run = 0;
  for (const c of line) { if (!(await has(c.sha))) break; run++; }
  const first = line[run - 1];
  return { head, commits: line.length, live: run > 0, continuousSince: first?.date ?? null, firstCommit: first?.sha ?? null, gapBefore: run < line.length ? line[run].sha : null };
}

if (process.argv[1]?.endsWith('5-record-notice.mjs')) await main(async () => {
  const a = args();
  a.known(['--rpc']);
  const conn = connect(rpcFor(a));
  const c = await cluster(conn, ['mainnet', 'local']);
  const R = new Report(`RECORD THE FEE NOTICE (the network's clock: ${c.words})\nNothing is sent.\n`);
  R.note(`the notice line, exactly: ${CFG.notice.line}`);
  const f = await readNotice();
  const net = await clock(conn);
  // A network answering with another time could move the notice: it must agree with this computer.
  if (Math.abs(net - Date.now() / 1000) > 600) { R.refuse(`the network's clock (${new Date(net * 1000).toISOString()}) and this computer's (${new Date().toISOString()}) are more than 10 minutes apart: stop and ask`); return R.end('', 'Nothing was recorded.'); }
  const now = new Date(net * 1000).toISOString();
  const file = path.join(PACK, 'owner-run', 'notice.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
  const seenAt = before?.line === CFG.notice.line && before.seenAt ? before.seenAt : f.live ? now : null;
  const rec = { line: CFG.notice.line, seenAt, live: f.live, continuousSince: f.continuousSince, firstCommit: f.firstCommit, headSha: f.head, commits: f.commits, checkedAt: now };
  if (seenAt) fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
  R.note(`read ${f.commits} commits of ${CFG.notice.repo.branch}'s merge line, up to ${f.head}`);
  if (!f.live) {
    R.refuse(`the line is NOT in ${CFG.notice.files.join(' or ')} at ${CFG.notice.repo.branch}'s newest commit. The notice is that line, merged to ${CFG.notice.repo.branch}; ${seenAt ? 'it was there before: stop and ask' : 'wait until it is, then run this again'}`);
    return R.end('', 'The notice is not public.');
  }
  const start = new Date(Math.max(Date.parse(seenAt), Date.parse(f.continuousSince))).toISOString();
  const end = noticeEnds(CFG, { start: Date.parse(start) / 1000 });
  if (!end.ok) { R.refuse(end.why); return R.end('', 'The date the notice names does not read.'); }
  const opens = new Date(end.at * 1000).toISOString();
  R.pass(`every commit since ${f.firstCommit} (${f.continuousSince}) carries the line${f.gapBefore ? `; the commit before it, ${f.gapBefore}, did not` : ''}`);
  R.pass(`recorded: first seen public at ${seenAt} by the network's clock; the notice runs from ${start}, so the fee tiers may execute from ${opens}, not before`);
  return R.end(`the notice is public. The tiers may execute from ${opens}. Run this again within the hour before the approval and before the execute.`, '');
});
