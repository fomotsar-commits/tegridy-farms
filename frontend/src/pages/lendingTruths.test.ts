// What the site says about NFT lending, held to Gondi's v3.2 loan contract as deployed
// (contracts/vendor/gondi-v3.2). Each line below was checked against the contract's source
// on 2026-11-14 and found stale, wrong or silent:
//   - Another lender can take a loan over between 15% and 85% of its term, at a better rate,
//     without the borrower signing (MultiSourceLoan.refinanceFull, lender-initiated). The old
//     lender is paid principal plus interest so far, less the venue's fee.
//   - The loan contract has no pause, and its collection list changes at once (no timelock);
//     a fee change needs 7 days' notice (WithProtocolFee.FEE_UPDATE_NOTICE) and each loan keeps
//     the fee it opened with (Loan.protocolFee).
//   - A default is not "automatic": someone has to call liquidateLoan.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOWELI_FAQ_DATA } from '../lib/faqData';
import { KNOWLEDGE_BASE } from '../lib/towelieKnowledge';
import { ONLY_FULL_REPAYMENT } from '../lib/shield/automation';

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');
const faq = (q: string) => TOWELI_FAQ_DATA.flatMap((s) => s.items).find((i) => i.q === q)?.a ?? '';

describe('the FAQ on NFT lending', () => {
  it('says another lender can take a loan over, and what each side gets', () => {
    const a = faq('What is NFT Lending?');
    expect(a).toMatch(/another lender can take (a|the) loan over/i);
    expect(a).toMatch(/interest so far/i);
    // A takeover needs no one's yes: say so, and name the collections in full.
    expect(a).toMatch(/at a lower rate without asking you/);
    expect(a).toMatch(/an NFT from Jungle Bay Ape Club, Nakamigos or GNSS Art\./);
  });

  it('describes the lending admin as it is: a Safe, no timelock on the collection list, 7 days for a fee', () => {
    const a = faq('Can the admin rug pull?');
    expect(a).not.toMatch(/add a malicious NFT collection to lending/);
    expect(a).toMatch(/NFT lending runs on Gondi/);
    expect(a).toMatch(/7 days/);
    expect(a).toMatch(/never applies to a loan already open/i);
    // The Safe also sets the takeover window, the rate cut, the liquidator and pool lenders at once.
    expect(a).toMatch(/change the collection list and other loan settings at once/);
  });
});

describe('Towelie on NFT lending', () => {
  it('says how the lender earns, not only what the venue keeps', () => {
    const entry = KNOWLEDGE_BASE.find((e) => e.keywords.includes('lending') && e.keywords.includes('borrow'));
    expect(entry?.answer).toMatch(/The lender keeps 95% of the interest and the venue 5%\./);
    expect(entry?.answer).toMatch(/Lock a Jungle Bay Ape Club, Nakamigos or GNSS Art NFT/);
  });
});

describe('the shield on what a borrower can do', () => {
  it('does not call full repayment the only move the contract has: it is the only one this site builds', () => {
    expect(ONLY_FULL_REPAYMENT).not.toMatch(/no deleverage/i);
    expect(ONLY_FULL_REPAYMENT).toMatch(/^Here, full repayment is the only move/);
    expect(ONLY_FULL_REPAYMENT).toMatch(/this site does not build/i);
    expect(ONLY_FULL_REPAYMENT).toMatch(/new offer/i);
    expect(ONLY_FULL_REPAYMENT).not.toMatch(/—/);
  });
});

describe('the Risks page on NFT lending', () => {
  const risks = read('src', 'pages', 'RisksPage.tsx');

  it('does not say NFT lending runs on the July batch: it runs on Gondi\'s contracts since 2026-11-07', () => {
    // The page's strings are single-quoted, so the source holds Gondi\'s.
    expect(risks).toMatch(/NFT lending \(since replaced by Gondi\\?'s own v3\.2 loan contracts, deployed unchanged on 2026-11-07\)/);
  });

  it('names the collections each feature really takes', () => {
    expect(risks).not.toContain('(JBAC, JBAY Gold, GNSS)');
    expect(risks).toMatch(/NFT lending \(JBAC, Nakamigos and GNSS Art\)/);
  });

  it('does not call a default automatic: the lender has to claim', () => {
    expect(risks).not.toMatch(/This process is automatic and enforced by the smart contract/);
    expect(risks).toMatch(/the lender can take your NFT at any moment/);
  });
});

describe('the Security page beside Gondi\'s loan contract', () => {
  it('claims no pause on a contract that has none', () => {
    const security = read('src', 'pages', 'SecurityPage.tsx');
    expect(security).toMatch(/GONDI_LOAN_ADDRESS/);
    expect(security).not.toMatch(/Emergency pause mechanism on all core contracts/);
    expect(security).toMatch(/Gondi's loan contract has no pause/);
  });
});
