// @vitest-environment node
// PDA derivation under jsdom fails on a realm mismatch inside web3.js (see curve/program.ts).
//
// The plant (island ruling 2): its constants pinned literal by literal, the Workshop's
// $BAYLA account re-derived with spl-token's own helper, its two instructions byte for
// byte, and the two readers that decide whether a launch may plant at all.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ATA_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { BAYLA_MINT as BUNGALOW_BAYLA_MINT } from '../../../bungalows';
import { BAYLA_MINT as LP_BAYLA_MINT } from '../../../solana/lp/tokenSafety';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import {
  BAYLA_DECIMALS,
  BAYLA_MINT,
  PLANT_BURN_RAW,
  PLANT_TOTAL_RAW,
  PLANT_WORKSHOP_RAW,
  WORKSHOP_BAYLA_ACCOUNT,
  WORKSHOP_WALLET,
  baylaAccountOf,
  plantInstructions,
  readPlantBalance,
  readWorkshopAccount,
} from './plant';
import { FakeChain, WORKSHOP_BAYLA, encodeToken2022Account, rent, u64le } from './testkit.fixture';
import type { WriteRpc } from './types';

const R = (c: FakeChain) => c as unknown as Pick<WriteRpc, 'getAccountInfo'>;
const MAKER = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;

describe('the plant constants', () => {
  it('pins every literal', () => {
    expect(BAYLA_MINT.toBase58()).toBe('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
    expect(BAYLA_DECIMALS).toBe(6);
    expect(WORKSHOP_WALLET.toBase58()).toBe('G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu');
    expect(WORKSHOP_BAYLA_ACCOUNT.toBase58()).toBe('9i7vMCBcTSs3CsEZNcNDmH5Lh8yuH6aqYULNHWfxatwT');
    expect(PLANT_TOTAL_RAW).toBe(100_000n * 10n ** 6n);
    expect(PLANT_BURN_RAW).toBe(50_000n * 10n ** 6n);
    expect(PLANT_WORKSHOP_RAW).toBe(50_000n * 10n ** 6n);
    expect(PLANT_BURN_RAW + PLANT_WORKSHOP_RAW).toBe(PLANT_TOTAL_RAW);
    expect(TOKEN_2022_PROGRAM_ID.equals(SPL_TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it('the $BAYLA mint is the one string the rest of the site names', () => {
    expect(BAYLA_MINT.toBase58()).toBe(BUNGALOW_BAYLA_MINT);
    expect(BAYLA_MINT.toBase58()).toBe(LP_BAYLA_MINT);
  });

  it('the Workshop account is ATA($BAYLA, Workshop) under Token-2022, bump 255, and NOT the legacy derivation', () => {
    expect(getAssociatedTokenAddressSync(BAYLA_MINT, WORKSHOP_WALLET, false, SPL_TOKEN_2022_PROGRAM_ID, SPL_ATA_PROGRAM_ID).toBase58())
      .toBe(WORKSHOP_BAYLA_ACCOUNT.toBase58());
    const [address, bump] = PublicKey.findProgramAddressSync(
      [WORKSHOP_WALLET.toBytes(), SPL_TOKEN_2022_PROGRAM_ID.toBytes(), BAYLA_MINT.toBytes()],
      SPL_ATA_PROGRAM_ID,
    );
    expect(address.toBase58()).toBe('9i7vMCBcTSs3CsEZNcNDmH5Lh8yuH6aqYULNHWfxatwT');
    expect(bump).toBe(255);
    expect(baylaAccountOf(WORKSHOP_WALLET).toBase58()).toBe(WORKSHOP_BAYLA_ACCOUNT.toBase58());
    // curve/ix.ts derives under the LEGACY program: for $BAYLA that address does not exist.
    expect(associatedTokenAddress(BAYLA_MINT, WORKSHOP_WALLET).toBase58()).toBe('G2JTfWMphD9LEy6cw8aTCFyxrVNuVpsC41tUTBBww4BB');
  });

  it('a maker’s $BAYLA account is the Token-2022 associated account, for any wallet', () => {
    for (let i = 0; i < 5; i++) {
      const w = Keypair.generate().publicKey;
      expect(baylaAccountOf(w).toBase58()).toBe(
        getAssociatedTokenAddressSync(BAYLA_MINT, w, false, SPL_TOKEN_2022_PROGRAM_ID, SPL_ATA_PROGRAM_ID).toBase58(),
      );
    }
  });
});

describe('the plant’s two instructions, byte for byte', () => {
  const [burn, give] = plantInstructions(MAKER);
  const from = baylaAccountOf(MAKER).toBase58();
  const flags = (ix: typeof burn) => ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);

  it('burnChecked: your $BAYLA (w), the mint (w), you (s); tag 15, 50,000,000,000, decimals 6', () => {
    expect(burn.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(flags(burn)).toEqual([
      [from, false, true],
      [BAYLA_MINT.toBase58(), false, true],
      [MAKER.toBase58(), true, false],
    ]);
    expect(Array.from(burn.data)).toEqual([15, ...u64le(50_000_000_000n), 6]);
  });

  it('transferChecked: your $BAYLA (w), the mint, the Workshop’s $BAYLA (w), you (s); tag 12, 50,000,000,000, decimals 6', () => {
    expect(give.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(flags(give)).toEqual([
      [from, false, true],
      [BAYLA_MINT.toBase58(), false, false],
      ['9i7vMCBcTSs3CsEZNcNDmH5Lh8yuH6aqYULNHWfxatwT', false, true],
      [MAKER.toBase58(), true, false],
    ]);
    expect(Array.from(give.data)).toEqual([12, ...u64le(50_000_000_000n), 6]);
  });
});

describe('readPlantBalance: the maker’s own $BAYLA account, never a sum of others', () => {
  it('reads the amount of a Token-2022 $BAYLA account the maker owns', async () => {
    const chain = new FakeChain().token2022Account(baylaAccountOf(MAKER), BAYLA_MINT, MAKER, 123_456_789n);
    expect(await readPlantBalance(R(chain), MAKER)).toEqual({
      kind: 'ok',
      value: { account: baylaAccountOf(MAKER), amount: 123_456_789n, accountExists: true },
    });
  });

  it('no account is "holds 0 there", not a failure', async () => {
    expect(await readPlantBalance(R(new FakeChain()), MAKER)).toEqual({
      kind: 'ok',
      value: { account: baylaAccountOf(MAKER), amount: 0n, accountExists: false },
    });
  });

  it('an account that is not a Token-2022 $BAYLA account of this maker never reads as a balance', async () => {
    const at = baylaAccountOf(MAKER);
    const cases: Array<[string, FakeChain]> = [
      ['owned by the legacy token program', new FakeChain().set(at, { lamports: rent(170), owner: TOKEN_PROGRAM_ID, data: encodeToken2022Account(BAYLA_MINT, MAKER, 1n) })],
      ['another mint', new FakeChain().token2022Account(at, Keypair.generate().publicKey, MAKER, 1n)],
      ['another owner', new FakeChain().token2022Account(at, BAYLA_MINT, STRANGER, 1n)],
      ['too short', new FakeChain().set(at, { lamports: 1, owner: TOKEN_2022_PROGRAM_ID, data: new Uint8Array(100) })],
      ['a mint, not a token account', new FakeChain().set(at, { lamports: 1, owner: TOKEN_2022_PROGRAM_ID, data: (() => { const d = encodeToken2022Account(BAYLA_MINT, MAKER, 1n); d[165] = 1; return d; })() })],
      ['not initialized', new FakeChain().set(at, { lamports: 1, owner: TOKEN_2022_PROGRAM_ID, data: (() => { const d = encodeToken2022Account(BAYLA_MINT, MAKER, 1n); d[108] = 0; return d; })() })],
    ];
    for (const [label, chain] of cases) {
      const r = await readPlantBalance(R(chain), MAKER);
      expect(r.kind, label).toBe('undecodable');
    }
  });

  it('a read that fails is unreadable, never zero', async () => {
    const chain = new FakeChain();
    chain.getAccountInfo = async () => {
      throw new Error('HTTP 429');
    };
    expect(await readPlantBalance(R(chain), MAKER)).toMatchObject({ kind: 'unreadable', detail: 'HTTP 429' });
  });
});

describe('readWorkshopAccount: the Workshop’s $BAYLA account, exactly as the plant needs it', () => {
  it('ok for a Token-2022 $BAYLA account owned by the Workshop', async () => {
    const chain = new FakeChain().token2022Account(WORKSHOP_BAYLA_ACCOUNT, BAYLA_MINT, WORKSHOP_WALLET, WORKSHOP_BAYLA);
    expect(await readWorkshopAccount(R(chain))).toEqual({ kind: 'ok', value: { amount: WORKSHOP_BAYLA } });
  });

  it('absent, wrong program, wrong mint, wrong owner: each refused', async () => {
    expect((await readWorkshopAccount(R(new FakeChain()))).kind).toBe('absent');
    const wrong: Array<[string, FakeChain]> = [
      ['legacy program', new FakeChain().set(WORKSHOP_BAYLA_ACCOUNT, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: encodeToken2022Account(BAYLA_MINT, WORKSHOP_WALLET, 1n) })],
      ['another mint', new FakeChain().token2022Account(WORKSHOP_BAYLA_ACCOUNT, Keypair.generate().publicKey, WORKSHOP_WALLET, 1n)],
      ['another owner', new FakeChain().token2022Account(WORKSHOP_BAYLA_ACCOUNT, BAYLA_MINT, STRANGER, 1n)],
    ];
    for (const [label, chain] of wrong) expect((await readWorkshopAccount(R(chain))).kind, label).toBe('undecodable');
  });

  it('a read that fails is unreadable', async () => {
    const chain = new FakeChain();
    chain.getAccountInfo = async () => {
      throw new Error('down');
    };
    expect(await readWorkshopAccount(R(chain))).toMatchObject({ kind: 'unreadable' });
  });
});
