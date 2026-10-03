import { ExtensionType, getAccountLen, getAccountTypeOfMintType } from '@solana/spl-token';
import type { RawAccount } from './accounts';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, decodeMintAccount, extensionPlain } from './tokenSafety';

// Its own small file because two layers need the one rule: the transaction builders
// (write/liquidity.ts, which re-exports it) and the page's own wallet read
// (walletFacts.ts). The page must not import the builders: they load only through
// lpWriteApi.ts.

/**
 * The size of a token account for this mint (D20). Classic: 165. Token-2022: the
 * account extensions the mint's own extensions require, plus ImmutableOwner, which
 * the associated-token program always adds. NOT `getAccountLenForMint`, which leaves
 * ImmutableOwner out and answers 165 for a Token-2022 mint with no extensions, where
 * the real account is 170. A string = this site cannot size it.
 */
export function tokenAccountSize(mint: RawAccount): number | string {
  if (mint.owner === TOKEN_PROGRAM) return 165;
  if (mint.owner !== TOKEN_2022_PROGRAM) return 'the token is not owned by a token program';
  const d = decodeMintAccount(mint.owner, mint.data);
  if (!d.ok) return d.reason;
  const types = new Set<ExtensionType>([ExtensionType.ImmutableOwner]);
  for (const e of d.value.extensions) {
    const t = getAccountTypeOfMintType(e as ExtensionType) as ExtensionType | undefined;
    if (t === undefined) return `it uses ${extensionPlain(e)}`;
    if (t !== ExtensionType.Uninitialized) types.add(t);
  }
  return getAccountLen([...types]);
}
