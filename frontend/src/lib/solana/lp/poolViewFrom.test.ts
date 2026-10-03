// @vitest-environment node
//
// `poolViewFrom` is the per-pool body of `readPools`, taken out so the liquidity
// builders can judge the pool they write to from their own single read, exactly as the
// finder judges it. poolFinder.test.ts pins `readPools` itself, unedited.
import { describe, it, expect } from 'vitest';
import { poolStatePda } from '../../launcher/solana/curve/program';
import { decodePoolState } from '../cpswap/program';
import { getMultipleAccounts } from './accounts';
import { poolViewFrom, readPools, type ReadPoolsOptions } from './poolFinder';
import { TOKEN_PROGRAM } from './tokenSafety';
import { CLOCK, LAUNCH, PROGRAM, buildPool, clockAccount, fakeRpc, key, observationBytes, tokenAccountBytes, type FakeAccount } from './testkit.fixture';

const opts: ReadPoolsOptions = { programId: PROGRAM, launchProgramId: LAUNCH };

describe('poolViewFrom', () => {
  it('gives the same entry readPools gives, for every kind of answer', async () => {
    const mint = key();
    // A pool at its own address, with fees owed in its SOL vault.
    const plain = buildPool({ mint, configIndex: 1, address: key(), quoteReserve: 5_000_000_000n, tokenReserve: 1_000_000_000n, protocolFeesSol: 7n });
    // The standard address, with a frozen vault.
    const standard = buildPool({ mint, configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n, frozenVault: true });
    // The launch pool, with its price record.
    const launch = buildPool({ mint, configIndex: 0, address: poolStatePda(mint, LAUNCH), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    // A pool whose vault is not a working token account.
    const badVault = buildPool({ mint: key(), configIndex: 1, address: key(), quoteReserve: 10n, tokenReserve: 10n });
    const vaultAddr = Object.keys(badVault.accounts).find((a) => a !== badVault.address.toBase58() && badVault.accounts[a]!.data.length === 165)!;
    badVault.accounts[vaultAddr] = { owner: TOKEN_PROGRAM, data: tokenAccountBytes(mint, key(), 5n, 0) };
    // A pool whose fee settings are owned by someone else.
    const strangeConfig = buildPool({ mint, configIndex: 0, address: key(), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 9n });
    strangeConfig.accounts[strangeConfig.config.toBase58()] = { ...strangeConfig.accounts[strangeConfig.config.toBase58()]!, owner: key().toBase58() };
    const strangerAddr = key().toBase58();
    const absentAddr = key().toBase58();
    const accounts: Record<string, FakeAccount> = {
      ...plain.accounts, ...standard.accounts, ...launch.accounts, ...badVault.accounts,
      [launch.observation.toBase58()]: { owner: PROGRAM.toBase58(), data: observationBytes({ pool: launch.address, initialized: false }) },
      [strangerAddr]: { owner: key().toBase58(), data: new Uint8Array(637) },
      [CLOCK]: clockAccount(5n),
    };
    const separate = { ...strangeConfig.accounts, [CLOCK]: clockAccount(5n) };
    const cases: Array<[Record<string, FakeAccount>, string]> = [
      ...[plain.address, standard.address, launch.address, badVault.address].map((a) => [accounts, a.toBase58()] as [Record<string, FakeAccount>, string]),
      [accounts, strangerAddr],
      [accounts, absentAddr],
      [separate, strangeConfig.address.toBase58()],
    ];
    const kinds: string[] = [];
    for (const [chain, address] of cases) {
      const read = await readPools(fakeRpc(chain), [address], opts);
      if (read.kind !== 'ok') throw new Error('readPools did not read');
      const entry = read.entries[0]!;
      kinds.push(entry.kind === 'pool' ? `pool:${entry.view.origin}:${entry.view.config ? 'config' : 'no-config'}` : entry.kind);
      // The same accounts, read by the pool's own recorded addresses.
      const rpc = fakeRpc(chain);
      const [pool] = await getMultipleAccounts(rpc, [address]);
      const decoded = pool ? decodePoolState(address, pool.data) : null;
      const [vault0, vault1, config, observation] = decoded
        ? await getMultipleAccounts(rpc, [decoded.token0Vault, decoded.token1Vault, decoded.ammConfig, decoded.observationKey])
        : [null, null, null, null];
      expect(
        poolViewFrom({ address, pool: pool ?? null, vault0: vault0 ?? null, vault1: vault1 ?? null, config: config ?? null, observation: observation ?? null, opts }),
        address,
      ).toEqual(entry);
    }
    // Every kind of answer was covered; fee settings owned by anyone but the pool program are not read.
    expect(kinds).toEqual(['pool:other:config', 'pool:standard:config', 'pool:launch-pool:config', 'unread', 'not-a-pool', 'absent', 'pool:other:no-config']);
  });

  it('reads a launch pool’s price record, and ignores one handed in for any other pool', () => {
    const mint = key();
    const launch = buildPool({ mint, configIndex: 0, address: poolStatePda(mint, LAUNCH), quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const other = buildPool({ mint, configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 12n });
    const acc = (b: typeof launch, a: string) => {
      const x = b.accounts[a]!;
      return { address: a, owner: x.owner, data: x.data, lamports: 1 };
    };
    const entryFor = (b: typeof launch) => {
      const pool = acc(b, b.address.toBase58());
      const d = decodePoolState(b.address.toBase58(), pool.data)!;
      return poolViewFrom({
        address: b.address.toBase58(),
        pool,
        vault0: acc(b, d.token0Vault),
        vault1: acc(b, d.token1Vault),
        config: acc(b, d.ammConfig),
        observation: { address: b.observation.toBase58(), owner: PROGRAM.toBase58(), data: observationBytes({ pool: b.address, initialized: false }), lamports: 1 },
        opts,
      });
    };
    const l = entryFor(launch);
    const o = entryFor(other);
    expect(l.kind === 'pool' && l.view.history.kind).toBe('ok');
    expect(o.kind === 'pool' && o.view.history.kind).toBe('not-read');
  });
});
