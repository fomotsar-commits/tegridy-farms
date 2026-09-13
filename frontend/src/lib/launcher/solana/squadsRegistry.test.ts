// @vitest-environment node
//
// `deriveSquadsVaultPda` calls `PublicKey.findProgramAddressSync`, which throws
// "Unable to find a viable program address nonce" under this project's jsdom default.
// Same reason as every other derivation test in the repo.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `addresses.json` registers a Squads v4 multisig and a vault, and the vault's own entry
// says: "Re-derive it from the multisig rather than trusting this literal;
// System-ownership alone proves nothing." Until now nothing did.
//
// The correction recorded beside that entry is what makes it worth a test: the MULTISIG
// account was once used where the VAULT was meant. A v4 multisig config account can
// neither sign (v4 signs CPIs as the vault PDA) nor be debited, and putting it where a
// signer was required is what bricked graduation. The two addresses look equally like
// "the Squads address" in a runbook, and only a derivation tells them apart.
//
// Pinned here because the bayla-ladder mainnet deploy hands this vault the program's
// UPGRADE authority (BAYLA_LADDER_MAINNET_RUNBOOK.md §3) — the one transfer that cannot
// be undone by anyone but the recipient.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveSquadsVaultPda } from './squads';

interface Entry { id?: string; address?: string }

const registry = JSON.parse(
  readFileSync(new URL('../../../../scripts/addresses.json', import.meta.url), 'utf8'),
) as { solana?: Entry[] };

const entry = (id: string): Entry | undefined => (registry.solana ?? []).find((e) => e?.id === id);

describe('the registered Squads vault is derivable from the registered multisig', () => {
  it('both entries are still in the registry', () => {
    // Their absence would mean this guard is checking nothing, which must fail loudly
    // rather than pass quietly.
    expect(entry('squads-multisig')?.address, 'squads-multisig is not in addresses.json').toBeTruthy();
    expect(entry('squads-vault')?.address, 'squads-vault is not in addresses.json').toBeTruthy();
  });

  it('vault index 0 of the registered multisig IS the registered vault', () => {
    const multisig = entry('squads-multisig')!.address!;
    const vault = entry('squads-vault')!.address!;
    expect(deriveSquadsVaultPda(multisig, 0)).toBe(vault);
  });

  it('the multisig account is NOT the vault — the confusion that bricked graduation', () => {
    expect(entry('squads-multisig')!.address).not.toBe(entry('squads-vault')!.address);
  });

  it('a different vault index would NOT match, so the check is not vacuous', () => {
    // If any index satisfied the assertion above, it would prove nothing about index 0.
    const multisig = entry('squads-multisig')!.address!;
    const vault = entry('squads-vault')!.address!;
    expect(deriveSquadsVaultPda(multisig, 1)).not.toBe(vault);
    expect(deriveSquadsVaultPda(multisig, 2)).not.toBe(vault);
  });
});
