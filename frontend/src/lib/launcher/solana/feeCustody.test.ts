// THE FEE-CUSTODY CHECK ON THE PATH THE PUBLIC ACTUALLY WALKS — Wave 3, phase 03.
//
// The venue's strongest Solana guarantee is that the DBC config's `feeClaimer` is the
// Squads vault, so trading fees cannot be redirected to an individual. `squads.ts`
// implements exactly that check — and `submitLaunch` never calls it, deliberately: the
// config address is build-time configuration, and `verifySquadsVault` reaches
// `findProgramAddressSync`, which web3.js stubs out in its browser build.
//
// The reasoning was sound and the outcome was not. The guarantee runs in operator
// tooling and nowhere near the public submit button, so the one place a stranger's
// money is at stake is the one place nothing is verified. A build-time constant is only
// as good as the build, and nothing on this path ever asked the chain.
//
// So: ONE read-only check of the resolved config before submit, and it fails closed.
//
// Fail-closed is the whole test. An unreadable config must refuse, not proceed —
// "unknown is never zero and never a confident value" is a rail of this wave, and a
// check that waves through on RPC failure is worse than no check, because it reads as
// verified.
//
// Every refusal here is a plain Error thrown ABOVE sendTransaction, so `wasBroadcast()`
// is false and the caller can say "nothing was submitted" and be literally right.

import { describe, it, expect, vi } from 'vitest';
import { assertFeeCustody, FeeCustodyError } from './feeCustody';

const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const IMPOSTOR = 'EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK';
const CONFIG = '4HVMW8TRZmXAxERH94hkVgM279fSXSBBsjonBYmxxxMn';

describe('the resolved fee custody is verified against the chain before submit', () => {
  it('passes when the live config names the expected vault', async () => {
    const read = vi.fn(async () => VAULT);
    await expect(assertFeeCustody(CONFIG, VAULT, { readFeeClaimer: read })).resolves.toBeUndefined();
    // "the happy path costs one RPC read" — not two, not per-field.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('REFUSES when the live config names a different claimer', async () => {
    // The tampered-config case: someone points the launch at a config whose fees
    // land somewhere else, using our brand as the wrapper.
    const read = vi.fn(async () => IMPOSTOR);
    await expect(assertFeeCustody(CONFIG, VAULT, { readFeeClaimer: read })).rejects.toBeInstanceOf(FeeCustodyError);
  });

  it('names both addresses in the refusal, so the operator can see WHICH config', async () => {
    const read = vi.fn(async () => IMPOSTOR);
    const err = await assertFeeCustody(CONFIG, VAULT, { readFeeClaimer: read }).catch((e: unknown) => e);
    expect(String(err)).toContain(IMPOSTOR);
    expect(String(err)).toContain(VAULT);
  });

  it('REFUSES when the config cannot be read at all — fail closed', async () => {
    // The rail: unknown is never a confident value. An RPC outage must not read as
    // "custody verified".
    const read = vi.fn(async () => null);
    await expect(assertFeeCustody(CONFIG, VAULT, { readFeeClaimer: read })).rejects.toBeInstanceOf(FeeCustodyError);
  });

  it('REFUSES when the read throws — fail closed', async () => {
    const read = vi.fn(async () => {
      throw new Error('502 from the RPC');
    });
    await expect(assertFeeCustody(CONFIG, VAULT, { readFeeClaimer: read })).rejects.toBeInstanceOf(FeeCustodyError);
  });

  it('REFUSES when no expected vault is configured, rather than trusting the chain', async () => {
    // With no expectation there is nothing to compare against, so "it matched" would be
    // vacuous. Refusing is the only honest answer.
    const read = vi.fn(async () => VAULT);
    await expect(assertFeeCustody(CONFIG, '', { readFeeClaimer: read })).rejects.toBeInstanceOf(FeeCustodyError);
    expect(read, 'must not even read when there is nothing to verify against').not.toHaveBeenCalled();
  });

  it('is a plain Error subclass, so a denial can never look like a failed broadcast', () => {
    // Same doctrine as HeatGateDenied. `wasBroadcast()` keys off a signature; this must
    // never carry one, and must not be mistaken for a landed transaction that failed.
    const e = new FeeCustodyError('x');
    expect(e).toBeInstanceOf(Error);
    expect((e as unknown as { signature?: string }).signature).toBeUndefined();
  });
});
