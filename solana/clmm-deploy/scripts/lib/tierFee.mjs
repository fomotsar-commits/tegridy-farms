// The decision for a fee-change folder (config.json's `change`): one vault proposal that sets one
// existing fee tier's trade fee, and nothing else (tiers.mjs compiles it: `feeIxs`). The page offers
// propose, approve and execute only for that proposal, byte for byte, and nothing while the program,
// the tiers or another proposal is not as this folder expects.

const pct = (r) => `${(r / 10000).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`;

/** The changed tier as it reads after the execute: every field as before, the trade fee the new one. */
export function tierAfter(cfg, t) {
  const want = cfg.tiers.find((x) => x.index === cfg.change.index);
  const g = t?.got;
  return t?.state === 'wrong' && !!g && g.index === want.index && g.tickSpacing === want.tickSpacing && g.tradeFeeRate === cfg.change.to
    && g.protocolFeeRate === want.protocolFeeRate && g.fundFeeRate === want.fundFeeRate && g.owner === cfg.addr.vault && g.fundOwner === cfg.addr.workshop;
}

/**
 * One action at most, and every reason. `s` is tiers.mjs's readState: { ms, program, proposals,
 * tiers, clock, member }. No notice and no position link: the tier and its pools exist already.
 */
export function decideFee(cfg, s) {
  const c = cfg.change;
  const lines = [];
  const ok = (w) => lines.push({ ok: true, w });
  const stop = (w) => { lines.push({ ok: false, w }); return false; };
  const lockWanted = cfg.timeLock;
  let fine = true;
  if (!s.ms) fine = stop('the multisig could not be read as a Squads multisig');
  else {
    fine = (s.ms.threshold === 2 && s.ms.members.length === 2 ? ok(`2 approvals of 2 members (${s.ms.members.map((m) => m.key).join(', ')})`) : stop(`the multisig wants ${s.ms.threshold} of ${s.ms.members.length}, not 2 of 2`)) && fine;
    fine = (s.ms.timeLock === lockWanted ? ok(`the time lock is ${lockWanted.toLocaleString('en-US')} seconds (${lockWanted / 3600} hours)`) : stop(`the time lock is ${s.ms.timeLock} seconds, not ${lockWanted}: a change to the multisig itself has executed. Stop and ask`)) && fine;
    fine = (s.ms.configAuthority === '11111111111111111111111111111111' ? ok('nobody can change the multisig alone (no config authority)') : stop(`the multisig has a config authority, ${s.ms.configAuthority}`)) && fine;
  }
  const p = s.program;
  if (!p?.exists) fine = stop('the range program is not on this network');
  else {
    fine = (p.sameBuild ? ok(`the program on chain is byte for byte the build this folder was made against (${cfg.binary.sha256})`) : stop(`the program on chain is NOT the build this folder was made against: ${p.why}. It changed since this folder was made: a session restages it, then check again`)) && fine;
    fine = (p.authority === cfg.addr.vault ? ok('its upgrade authority is the vault') : stop(`its upgrade authority is ${p.authority ?? 'NONE'}, not the vault: stop and ask`)) && fine;
  }
  for (const t of s.tiers ?? []) {
    if (t.want.index === c.index) continue;
    fine = (t.state === 'exact' ? ok(`tier ${t.want.index} is as made: ${pct(t.want.tradeFeeRate)} of each swap, price steps ${t.want.tickSpacing}; this proposal does not touch it`)
      : stop(`tier ${t.want.index} is not as made (${t.state === 'absent' ? 'it does not exist' : JSON.stringify(t.got)}): stop and ask`)) && fine;
  }
  const t = s.tiers?.find((x) => x.want.index === c.index);
  if (tierAfter(cfg, t)) return { action: 'done', lines: [...lines, { ok: true, w: `ALREADY DONE: tier ${c.index} charges ${pct(c.to)} of each swap, everything else about it as before` }] };
  if (t?.state === 'exact') ok(`tier ${c.index} charges ${pct(c.from)} of each swap now; this proposal sets it to ${pct(c.to)} and changes nothing else`);
  else fine = stop(t?.state === 'absent' ? `tier ${c.index} does not exist on this network` : `tier ${c.index} reads other values than this folder expects (${JSON.stringify(t?.got)}): someone changed it outside this page. Stop and ask`);
  const foreign = s.proposals?.filter((x) => x.live && x.touches && !x.ours) ?? [];
  for (const x of foreign) fine = stop(x.kind === 'vault'
    ? `proposal #${x.index} (${x.proposal.status}) touches the range program or a fee tier but is NOT this page's: never approve or execute it. ${x.proposal.status === 'Approved' ? 'Both members cancel it' : 'A member rejects it'} in the Squads app; then check again`
    : `proposal #${x.index} (${x.proposal.status}) is a ${x.kind === 'batch' ? 'batch' : 'kind of transaction'} this page cannot read inside: it could touch the range program. Stop and ask`);
  const mine = (s.proposals ?? []).filter((x) => x.ours && x.live);
  if (mine.length > 1) fine = stop(`two open fee proposals (#${mine.map((x) => x.index).join(', #')}): only one may ever execute. Stop and ask`);
  const member = s.member && s.ms?.members.find((m) => m.key === s.member);
  if (!s.member) return { action: null, lines: [...lines, { ok: false, w: 'connect a member wallet' }] };
  if (!member) return { action: null, lines: [...lines, { ok: false, w: `${s.member} is not a member of the multisig` }] };
  if (!fine) return { action: null, lines };
  const open = mine[0];
  if (!open) {
    if (!(member.mask & 1)) return { action: null, lines: [...lines, { ok: false, w: 'this member may not propose' }] };
    return { action: 'propose', lines: [...lines, { ok: true, w: `no fee proposal yet: #${s.ms.transactionIndex + 1} will be created, with your approval` }] };
  }
  const pr = open.proposal;
  const at = (x) => new Date(x * 1000).toISOString().replace('.000', '');
  if (pr.status === 'Active') {
    if (pr.approved.includes(s.member)) return { action: null, lines: [...lines, { ok: true, w: `#${open.index} has your approval; the other member approves next` }] };
    if (!(member.mask & 2)) return { action: null, lines: [...lines, { ok: false, w: 'this member may not approve' }] };
    return { action: 'approve', index: open.index, lines: [...lines, { ok: true, w: `#${open.index} is this page's proposal, waiting for your approval. Yours is the last one needed: it starts the ${lockWanted / 3600}-hour time lock` }] };
  }
  if (pr.status !== 'Approved' || !Number.isFinite(pr.timestamp)) return { action: null, lines: [...lines, { ok: false, w: `#${open.index} is ${pr.status}, not Approved with an approval time: stop and ask` }] };
  const lockEnds = pr.timestamp + s.ms.timeLock;
  if (s.clock < lockEnds) return { action: null, lines: [...lines, { ok: true, w: `#${open.index} has both approvals. The time lock holds it until ${at(lockEnds)} by the network's clock` }] };
  ok(`approved at ${at(pr.timestamp)}; the time lock was over at ${at(lockEnds)}`);
  return { action: 'execute', index: open.index, lines };
}
