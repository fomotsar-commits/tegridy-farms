// @vitest-environment node
//
// The signer's wrapped-SOL account, as every builder that uses it plans it (pool
// swaps and both liquidity kinds). Wrapped SOL is native: whoever holds its close
// authority can close it with SOL inside and keep every lamport. So an account
// someone else can close is never used, kept or empty, and a kept account an approved
// spender can still draw from is not either.
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { encodeTokenAccountWith } from './testkit.fixture';
import { opened, syncCredit, wsolPlanFrom } from './wsol';
import { nativeReserve } from './prepare';

const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const ATA = associatedTokenAddress(WSOL_MINT, ME);
const account = (amount: bigint, o: Parameters<typeof encodeTokenAccountWith>[3] = {}) => ({ owner: TOKEN_PROGRAM_ID, data: encodeTokenAccountWith(WSOL_MINT, ME, amount, o) });
/** What an address reads as after someone sends SOL to it and before any account is opened there. */
const BARE = { owner: SYSTEM_PROGRAM_ID, data: new Uint8Array(0), lamports: 890_880 };

describe('wsolPlanFrom', () => {
  it('absent or empty: closed at the end; holding wrapped SOL: kept', () => {
    expect(wsolPlanFrom(ME, null)).toEqual({ ata: ATA, closeAfter: true, heldBefore: 0n });
    expect(wsolPlanFrom(ME, account(0n))).toEqual({ ata: ATA, closeAfter: true, heldBefore: 0n });
    expect(wsolPlanFrom(ME, account(7n))).toEqual({ ata: ATA, closeAfter: false, heldBefore: 7n });
  });

  it('someone else can close it: refused whether it would be kept or closed, naming them', () => {
    // Kept: they could take what this transaction leaves in it. Empty: the token program
    // would refuse our close (only they may sign it), so the transaction would fail.
    for (const held of [0n, 7n]) {
      const r = wsolPlanFrom(ME, account(held, { closeAuthority: STRANGER }));
      expect(typeof r).toBe('string');
      expect(r).toBe(
        `${STRANGER.toBase58()} can close your wrapped-SOL account (${ATA.toBase58()}) and take what is in it, and only that key can change that. This site will not use that account, so nothing was built.`,
      );
    }
    // The signer as its own close authority is no one else.
    expect(wsolPlanFrom(ME, account(7n, { closeAuthority: ME }))).toEqual({ ata: ATA, closeAfter: false, heldBefore: 7n });
  });

  it('kept with a spender who can still draw from it: refused; empty, or nothing left to spend: planned', () => {
    expect(wsolPlanFrom(ME, account(7n, { delegate: STRANGER, delegatedAmount: 1_500_000_000n }))).toBe(
      `An approved spender (${STRANGER.toBase58()}) can move up to 1.5 wrapped SOL out of your wrapped-SOL account, and this would leave SOL in it. Revoke that approval in your wallet, then try again.`,
    );
    // Empty: filled, used and closed inside one transaction; a spender can take nothing.
    expect(wsolPlanFrom(ME, account(0n, { delegate: STRANGER, delegatedAmount: 5n }))).toMatchObject({ closeAfter: true });
    expect(wsolPlanFrom(ME, account(7n, { delegate: STRANGER, delegatedAmount: 0n }))).toMatchObject({ closeAfter: false });
  });

  it('an account too short to be a token account is unreadable, never planned', () => {
    expect(wsolPlanFrom(ME, { owner: TOKEN_PROGRAM_ID, data: new Uint8Array(72) })).toBe('Your wrapped-SOL account could not be read.');
  });

  // Anyone can send SOL to this address before the account exists. The transaction's own
  // create-if-missing opens the account over it, so it is absent, not unreadable.
  it('an address that only holds SOL someone sent it is absent: opened, used, and closed at the end', () => {
    expect(wsolPlanFrom(ME, BARE)).toEqual({ ata: ATA, closeAfter: true, heldBefore: 0n });
    expect(wsolPlanFrom(ME, { ...BARE, owner: SYSTEM_PROGRAM_ID.toBase58() })).toEqual({ ata: ATA, closeAfter: true, heldBefore: 0n });
  });

  it('no data under another owner, or data under the System program, is still unreadable', () => {
    expect(wsolPlanFrom(ME, { ...BARE, owner: STRANGER })).toBe('Your wrapped-SOL account could not be read.');
    expect(wsolPlanFrom(ME, { ...BARE, data: new Uint8Array(80) })).toBe('Your wrapped-SOL account could not be read.');
  });
});

describe('opened: an address that only holds SOL is not an account yet', () => {
  it('null for nothing there and for a System-owned address with no data; anything else is handed back as it is', () => {
    expect(opened(null)).toBeNull();
    expect(opened(undefined)).toBeNull();
    expect(opened(BARE)).toBeNull();
    expect(opened({ ...BARE, owner: SYSTEM_PROGRAM_ID.toBase58() })).toBeNull();
    const real = account(0n);
    const withData = { ...BARE, data: new Uint8Array(80) };
    const otherOwner = { ...BARE, owner: STRANGER };
    for (const a of [real, withData, otherOwner]) expect(opened(a)).toBe(a);
  });
});

// Mainnet, 2026-10-02: the pool program's fee account was set up when 165 bytes of rent
// cost 2,039,280 lamports; today they cost 1,488,440, and mainnet's token program
// re-prices a native account's reserve when it syncs. Its first sync credited the
// 550,840 difference as balance, and an exact balance row blocked every opening.
describe('syncCredit: exactly what one sync adds on top of what the transaction moves', () => {
  const OLD = 2_039_280n;
  const NOW = 1_488_440n;
  const native = (o: { amount: bigint; reserve: bigint; extra?: bigint }) => ({
    exists: true,
    amount: o.amount,
    lamports: o.reserve + o.amount + (o.extra ?? 0n),
    nativeReserve: o.reserve,
  });

  it('set up under the old rent: the old reserve’s surplus, re-priced to today’s rent as mainnet does', () => {
    expect(syncCredit(native({ amount: 0n, reserve: OLD }), NOW)).toBe(550_840n);
    expect(syncCredit(native({ amount: 7n, reserve: OLD }), NOW)).toBe(550_840n);
  });

  it('lamports sent to it and never synced are credited too, and only those', () => {
    expect(syncCredit(native({ amount: 0n, reserve: NOW, extra: 1_000n }), NOW)).toBe(1_000n);
    expect(syncCredit(native({ amount: 0n, reserve: OLD, extra: 1_000n }), NOW)).toBe(551_840n);
  });

  it('nothing for an account in step, missing or not native', () => {
    expect(syncCredit(native({ amount: 9n, reserve: NOW }), NOW)).toBe(0n);
    expect(syncCredit(undefined, NOW)).toBe(0n);
    expect(syncCredit({ exists: false, amount: 0n, lamports: 0n, nativeReserve: null }, NOW)).toBe(0n);
    expect(syncCredit({ exists: true, amount: 5n, lamports: OLD + 5n, nativeReserve: null }, NOW)).toBe(0n);
  });

  it('a rent RISE is not modelled: no credit, so a sync that lowers the balance lands off the row and is refused', () => {
    expect(syncCredit(native({ amount: 0n, reserve: NOW }), OLD)).toBe(0n);
  });

  it('never negative, even for an account holding less than its reserve and balance', () => {
    expect(syncCredit({ exists: true, amount: 10n, lamports: NOW, nativeReserve: NOW }, NOW)).toBe(0n);
  });
});

describe('nativeReserve: the reserve a wrapped-SOL account stores', () => {
  it('reads is_native at bytes 109-120; not native or too short is null', () => {
    expect(nativeReserve(encodeTokenAccountWith(WSOL_MINT, ME, 0n, { native: { reserve: 2_039_280n } }))).toBe(2_039_280n);
    expect(nativeReserve(encodeTokenAccountWith(WSOL_MINT, ME, 0n))).toBeNull();
    expect(nativeReserve(new Uint8Array(120))).toBeNull();
    expect(nativeReserve(null)).toBeNull();
  });
});
