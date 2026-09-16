// Squads vault verification — the guarantee that stops a single key draining every
// Solana fee this protocol earns.
//
// ─── WHY THIS FILE EXISTS SEPARATELY ────────────────────────────────────────
//
// These assertions lived inside `dbcClient.test.ts`, which was DELETED on
// 2026-08-23 with the rest of the Meteora DBC rail. `squads.ts` itself survives
// that retirement and is load-bearing for the rail that replaces it:
// `tegridy-launch`'s `global.fee_recipient` IS the Squads vault, so the restarted
// own-venue curve needs `deriveSquadsVaultPda` / `verifySquadsVault` /
// `readMultisigConfig` exactly as much as the DBC rail did.
//
// Its only importers were DBC modules, which makes `squads.ts` LOOK deletable. It
// is not. Extracting these tests in the same change as the deletion is what keeps
// the guarantee tested rather than merely present — a module whose only coverage
// is deleted alongside its only caller is how a security check quietly stops being
// one.
//
// ─── THE MODEL THESE PIN ────────────────────────────────────────────────────
//
// A Squads-gated constant must be the VAULT PDA, not the multisig address. The
// cp-swap fork got this wrong once and made its AmmConfig uncreatable without an
// upgrade. So: the address must DERIVE from (multisig, vaultIndex); the multisig
// must be Squads-owned; it must carry the `Multisig` discriminator; and its
// threshold must be >= 2. A 1-of-1 "multisig" is a single key wearing a costume,
// and `verifySquadsVault` returns false for it.
//
// AND THE THRESHOLD MUST BE UNREACHABLE BY ONE KEY (2026-09-10). A Squads
// multisig with a `config_authority` is one instruction away from being 1-of-1
// at that authority's sole discretion, so a >= 2 read on it is a costume too —
// worn one transaction longer. The multisig must be AUTONOMOUS
// (config_authority == Pubkey::default()) for the threshold to mean anything,
// which is why the decoder hands back both facts at once.

// @vitest-environment node
// PDA derivation uses web3.js's SYNC sha256, which does not work under jsdom —
// same constraint as program.test.ts and dbcClient.test.ts before it.
import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  SQUADS_V4_PROGRAM_ID,
  deriveSquadsVaultPda,
  verifySquadsVault,
  readMultisigConfig,
} from './squads';

const SQUADS_PROGRAM = new PublicKey(SQUADS_V4_PROGRAM_ID);

// Raw account data for a Squads v4 `Multisig`: 8-byte Anchor discriminator +
// create_key(32) + config_authority(32) + threshold(u16 LE @72), zero-padded to 80.
const MULTISIG_DISC = [224, 116, 121, 186, 68, 161, 79, 236];
const CONFIG_AUTHORITY_OFFSET = 40;
function multisigData(threshold = 2, configAuthority?: Uint8Array): Uint8Array {
  const d = new Uint8Array(80);
  d.set(MULTISIG_DISC, 0);
  if (configAuthority) d.set(configAuthority, CONFIG_AUTHORITY_OFFSET);
  d[72] = threshold & 0xff;
  d[73] = (threshold >> 8) & 0xff;
  return d;
}
// A CONTROLLED multisig: one key may rewrite the config, threshold included.
const controlled = (threshold = 3) => multisigData(threshold, Keypair.generate().publicKey.toBytes());

describe('verifySquadsVault (correct vault-PDA model)', () => {
  const conn = (owner: PublicKey | null | 'throw', data: Uint8Array | undefined = multisigData(2)) =>
    ({
      getAccountInfo: vi.fn(async () => {
        if (owner === 'throw') throw new Error('RPC down');
        return owner === null ? null : { owner, data };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  const ms = () => Keypair.generate().publicKey.toBase58();

  it('returns true when the address is the derived vault PDA and the multisig is a >=2 threshold Squads Multisig', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(verifySquadsVault(conn(SQUADS_PROGRAM), { address, multisig, vaultIndex: 0 })).resolves.toBe(true);
  });

  it('returns false when the multisig threshold is 1 (single-key drain)', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(
      verifySquadsVault(conn(SQUADS_PROGRAM, multisigData(1)), { address, multisig, vaultIndex: 0 }),
    ).resolves.toBe(false);
  });

  it('returns false when a config_authority can lower the threshold to 1 after this read', async () => {
    // The threshold is MUTABLE. A Squads multisig with a non-null `config_authority`
    // is "controlled": that ONE key calls the config instructions directly, so a
    // 3-of-5 read here becomes a 1-of-1 the moment the read is over and the fee
    // address is set on-chain. Only an AUTONOMOUS multisig (config_authority ==
    // Pubkey::default()) makes the >= 2 it just reported hold going forward.
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(
      verifySquadsVault(conn(SQUADS_PROGRAM, controlled(3)), { address, multisig, vaultIndex: 0 }),
    ).resolves.toBe(false);
  });

  it('returns false when the account is Squads-owned but not a Multisig (wrong discriminator)', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    const notMultisig = multisigData(2);
    notMultisig[0] ^= 0xff; // corrupt the discriminator → not a `Multisig` account
    await expect(
      verifySquadsVault(conn(SQUADS_PROGRAM, notMultisig), { address, multisig, vaultIndex: 0 }),
    ).resolves.toBe(false);
  });

  it('returns false when the multisig account data is too short to hold a threshold', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(
      verifySquadsVault(conn(SQUADS_PROGRAM, new Uint8Array(40)), { address, multisig, vaultIndex: 0 }),
    ).resolves.toBe(false);
  });

  it('returns false (without fetching) when the address is not the multisig vault PDA', async () => {
    const multisig = ms();
    const c = conn(SQUADS_PROGRAM);
    await expect(
      verifySquadsVault(c, { address: Keypair.generate().publicKey.toBase58(), multisig, vaultIndex: 0 }),
    ).resolves.toBe(false);
    expect(c.getAccountInfo).not.toHaveBeenCalled();
  });

  it('returns false when the multisig is not Squads-owned (System program)', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(verifySquadsVault(conn(SystemProgram.programId), { address, multisig, vaultIndex: 0 })).resolves.toBe(
      false,
    );
  });

  it('returns false when the multisig account does not exist', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(verifySquadsVault(conn(null), { address, multisig, vaultIndex: 0 })).resolves.toBe(false);
  });

  it('throws on an empty address or empty multisig', async () => {
    await expect(verifySquadsVault(conn(SQUADS_PROGRAM), { address: '   ', multisig: ms(), vaultIndex: 0 })).rejects.toThrow(
      /empty/,
    );
    await expect(verifySquadsVault(conn(SQUADS_PROGRAM), { address: ms(), multisig: '   ', vaultIndex: 0 })).rejects.toThrow(
      /empty/,
    );
  });

  it('throws on a malformed multisig base58', async () => {
    await expect(
      verifySquadsVault(conn(SQUADS_PROGRAM), { address: ms(), multisig: 'not-a-valid-key!!!', vaultIndex: 0 }),
    ).rejects.toThrow();
  });

  it('propagates an RPC failure instead of coercing it to false', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(verifySquadsVault(conn('throw'), { address, multisig, vaultIndex: 0 })).rejects.toThrow(/RPC down/);
  });
});

// ── readMultisigConfig, directly ────────────────────────────────────────────
//
// The decoder underneath the >= 2 rule. It was reachable only through
// `verifySquadsVault` in the deleted suite, so its own failure modes were covered
// by implication rather than by assertion. Every branch returns `null` — never 0,
// never a guess — because a threshold this cannot read must not be comparable
// against 2 at the call site.
//
// It returns `autonomous` ALONGSIDE the threshold, and that pairing is the point:
// it was `readMultisigThreshold` until 2026-09-10, and a caller holding only a
// number cannot tell whether the number is a property of the multisig or of one
// key's current mood.
describe('readMultisigConfig', () => {
  it('decodes a little-endian u16 at offset 72', () => {
    expect(readMultisigConfig(multisigData(2))?.threshold).toBe(2);
    expect(readMultisigConfig(multisigData(3))?.threshold).toBe(3);
    // Genuinely two-byte, so a >255 threshold is not silently truncated to its low byte.
    expect(readMultisigConfig(multisigData(300))?.threshold).toBe(300);
  });

  it('reads config_authority at offset 40 and reports whether anyone can rewrite the config', () => {
    // Zeroed config_authority == Pubkey::default() == autonomous: config changes go
    // through the multisig's own proposal process, so the threshold above holds.
    expect(readMultisigConfig(multisigData(2))?.autonomous).toBe(true);
    // Any non-zero byte in those 32 makes it CONTROLLED — one key, one instruction,
    // any threshold it likes.
    expect(readMultisigConfig(controlled(3))?.autonomous).toBe(false);
    // The whole 32-byte field is read, not just its first byte: a config_authority
    // whose leading bytes happen to be zero is still a config_authority.
    const trailingByteOnly = multisigData(2);
    trailingByteOnly[71] = 1; // last byte of config_authority
    expect(readMultisigConfig(trailingByteOnly)?.autonomous).toBe(false);
    const leadingByteOnly = multisigData(2);
    leadingByteOnly[40] = 1; // first byte of config_authority
    expect(readMultisigConfig(leadingByteOnly)?.autonomous).toBe(false);
  });

  it('does not mistake a neighbouring field for config_authority', () => {
    // The field is exactly [40, 72). create_key sits below it and the threshold
    // bytes sit above; neither may drag `autonomous` false, or every real
    // autonomous multisig would be rejected — a funds-lock, not a leak.
    const createKeySet = multisigData(2);
    createKeySet[39] = 0xff; // last byte of create_key
    expect(readMultisigConfig(createKeySet)?.autonomous).toBe(true);
    // A threshold of 2 already puts a non-zero byte at 72; 300 puts one at 73 too.
    expect(readMultisigConfig(multisigData(300))?.autonomous).toBe(true);
  });

  it('returns null — not 0 — for data too short to hold a threshold', () => {
    // 0 would compare as "below 2" and fail closed by accident. null makes the
    // caller decide, which is the same distinction _lockEndOf got wrong elsewhere
    // in this repo: an unreadable value must not wear a real value's clothes.
    expect(readMultisigConfig(new Uint8Array(73))).toBeNull();
    expect(readMultisigConfig(new Uint8Array(0))).toBeNull();
  });

  it('returns null for a missing account', () => {
    expect(readMultisigConfig(null)).toBeNull();
    expect(readMultisigConfig(undefined)).toBeNull();
  });

  it('returns null when the account is not a Multisig (discriminator mismatch)', () => {
    const notMultisig = multisigData(2);
    notMultisig[0] ^= 0xff;
    expect(readMultisigConfig(notMultisig)).toBeNull();
    // ...and it checks the WHOLE discriminator, not just the first byte.
    const lastByteWrong = multisigData(2);
    lastByteWrong[7] ^= 0xff;
    expect(readMultisigConfig(lastByteWrong)).toBeNull();
  });
});
