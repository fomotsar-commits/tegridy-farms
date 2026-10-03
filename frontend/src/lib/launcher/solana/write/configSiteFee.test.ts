// @vitest-environment node
//
// Whether the site's fee account can take a swap's site fee and is still the team
// vault's (SPEC_S3 2.3, `siteFeeAccountStateOf`). The opening-fee rule it builds on,
// `feeAccountStateOf`, is pinned unedited in configCreate.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { PLATFORM_TREASURY_VAULT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { SITE_FEE_WSOL_ACCOUNT } from '../../../solana/swap/siteFeeAccount';
import { feeAccountStateOf, siteFeeAccountStateOf } from './config';
import { encodeTokenAccountWith, rent, type TokenAccountOptions } from './testkit.fixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, '../../../../../scripts/solana-localnet/golden/fee-ata.mainnet.json');
const STRANGER = Keypair.generate().publicKey;
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const native = { native: { reserve: BigInt(rent(165)) } };
const account = (o: TokenAccountOptions = native, owner = PLATFORM_TREASURY_VAULT, mint = WSOL_MINT) => ({ owner: TOKEN, data: encodeTokenAccountWith(mint, owner, 0n, o) });

describe('siteFeeAccountStateOf', () => {
  it('the golden mainnet fee account (the vault’s own wrapped-SOL account, nobody else can close it) is ready', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { pubkey: string; account: { owner: string; data: [string, string] } };
    expect(golden.pubkey).toBe(SITE_FEE_WSOL_ACCOUNT.toBase58());
    const data = new Uint8Array(Buffer.from(golden.account.data[0], 'base64'));
    expect(siteFeeAccountStateOf({ owner: golden.account.owner, data })).toEqual({ kind: 'ready' });
  });

  it('a fixture account the vault owns is ready, with no close authority or with the vault as one', () => {
    expect(siteFeeAccountStateOf(account())).toEqual({ kind: 'ready' });
    expect(siteFeeAccountStateOf(account({ ...native, closeAuthority: PLATFORM_TREASURY_VAULT }))).toEqual({ kind: 'ready' });
  });

  it('no account there is missing, never ready', () => {
    expect(siteFeeAccountStateOf(null)).toEqual({ kind: 'missing' });
  });

  it('every rule an opening needs still refuses: another program, another size, another token, frozen, not set up, not native', () => {
    const wrong = [
      { owner: TOKEN_2022_PROGRAM_ID.toBase58(), data: account().data },
      { owner: TOKEN, data: account().data.subarray(0, 164) },
      account(native, PLATFORM_TREASURY_VAULT, Keypair.generate().publicKey),
      account({ ...native, state: 2 }),
      (() => {
        const a = account();
        a.data[108] = 0;
        return a;
      })(),
      account({}),
    ];
    for (const a of wrong) {
      expect(feeAccountStateOf(a).kind).not.toBe('ready');
      expect(siteFeeAccountStateOf(a).kind).toBe('wrong');
    }
  });

  it('an account another wallet owns would pass the opening rule, and is refused here', () => {
    const a = account(native, STRANGER);
    expect(feeAccountStateOf(a)).toEqual({ kind: 'ready' });
    expect(siteFeeAccountStateOf(a)).toEqual({ kind: 'wrong', detail: "it does not belong to the team's vault" });
  });

  it('a stranger as close authority (who could close it with the fees inside) is refused, and so is a tag that is neither none nor some', () => {
    const a = account({ ...native, closeAuthority: STRANGER });
    expect(feeAccountStateOf(a)).toEqual({ kind: 'ready' });
    expect(siteFeeAccountStateOf(a)).toEqual({ kind: 'wrong', detail: "someone other than the team's vault can close it" });
    const odd = account({ ...native, closeAuthority: PLATFORM_TREASURY_VAULT });
    new DataView(odd.data.buffer).setUint32(129, 2, true);
    expect(siteFeeAccountStateOf(odd).kind).toBe('wrong');
  });
});
