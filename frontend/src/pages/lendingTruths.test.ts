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
    // The window is the loan contract's setting (getMinLockPeriod), which the Safe can change at once.
    // ...with the date it was read, as every chain figure on the site (1500 bps on 2026-11-24).
    expect(a).toMatch(/Between 15% and 85% of a loan's term \(read on chain 2026‑11‑24; the venue's Safe can change that window at once\), another lender/);
    expect(a).toMatch(/an NFT from Jungle Bay Ape Club, Nakamigos or GNSS Art\./);
  });

  // AuctionLoanLiquidator.liquidateLoan reverts while a currency's min bid is 0
  // (MinBidForCurrencyNotSetError), and the liquidator's WETH min bid read 0 on 2026-11-24:
  // a loan with several lenders cannot go to auction, so no screen says it does, yet.
  it('says auctions are not switched on yet, and what that does to a loan with several lenders', () => {
    for (const a of [faq('What is NFT Lending?'), faq('What happens if I default on a loan?')]) {
      expect(a).toMatch(/3-day auction/);
      expect(a).toContain(
        "auctions are not switched on yet (read on chain 2026‑11‑24): until the venue's Safe switches them on, nobody can repay or claim such a loan once it is overdue, and the NFT stays locked.",
      );
      // The venue never tells a visitor "Cannot" (e2e/cannot-zero.spec.ts walks /toweli for it).
      expect(a).not.toMatch(/\bcannot\b/i);
    }
  });

  it('describes the lending admin as it is: a Safe, no timelock on the collection list, 7 days for a fee', () => {
    const a = faq('Can the admin rug pull?');
    expect(a).not.toMatch(/add a malicious NFT collection to lending/);
    expect(a).toMatch(/NFT lending runs on Gondi/);
    // For lending the honest answer is yes: said before the how.
    expect(a).toContain("NFT lending runs on Gondi's contracts, owned by the venue's two-key Safe, and there the answer is yes.");
    expect(a).toMatch(/7 days/);
    expect(a).toMatch(/never applies to a loan already open/i);
    // The Safe also sets the takeover window, the rate cut, the liquidator and pool lenders at once.
    expect(a).toMatch(/change the collection list and other loan settings at once/);
    // And it can stop a repayment with no wait: said as the Risks page's NFT Lending card says it.
    expect(a).toMatch(/With no wait, both keys together can stop a loan from being repaid, then take the NFT once the loan is due, leaving the lender unpaid\./);
  });

  it("the admin answer and the Risks page say the Safe's power over a loan in the same words", () => {
    const words = 'With no wait, both keys together can stop a loan from being repaid, then take the NFT once the loan is due, leaving the lender unpaid';
    expect(faq('Can the admin rug pull?')).toContain(words);
    expect(read('src', 'pages', 'RisksPage.tsx')).toContain(words);
  });
});

describe('Towelie on NFT lending', () => {
  it('says how the lender earns, not only what the venue keeps', () => {
    const entry = KNOWLEDGE_BASE.find((e) => e.keywords.includes('lending') && e.keywords.includes('borrow'));
    expect(entry?.answer).toMatch(/The lender keeps 95% of the interest and the venue 5%\./);
    expect(entry?.answer).toMatch(/Lock a Jungle Bay Ape Club, Nakamigos or GNSS Art NFT/);
  });

  it('says another lender can take a loan over, inside a window the Safe can change', () => {
    const entry = KNOWLEDGE_BASE.find((e) => e.keywords.includes('lending') && e.keywords.includes('borrow'));
    expect(entry?.answer).toContain(
      "Between 15% and 85% of the term (read on chain 2026‑11‑24; the venue's Safe can change that window at once), another lender can take your loan over at a lower rate without asking you.",
    );
  });

  it('says to repay before the deadline: Gondi refuses a repayment at the deadline second', () => {
    const entry = KNOWLEDGE_BASE.find((e) => e.keywords.includes('default'));
    expect(entry?.answer).toMatch(/repay your NFT loan before the deadline/);
    expect(entry?.answer).not.toMatch(/by the deadline/);
    // No auction can start while the liquidator's WETH min bid is 0 (read on 2026-11-24).
    expect(entry?.answer).toContain(
      "With several lenders it goes to a 3-day auction, but auctions are not switched on yet (read on chain 2026‑11‑24): until the venue's Safe switches them on, the NFT stays locked.",
    );
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

  // LoanManagerRegistry.addLoanManager is onlyOwner with no delay, and repaying a registered lender
  // calls ILoanManager.loanRepayment on it, which a wallet reverts. A registered lender's due loan
  // then goes to the loan contract's liquidator, which updateLiquidationContract re-points at once
  // (LiquidationHandler). No auction can stand in the way: the liquidator's WETH min bid reads 0, so
  // starting one reverts. All owned by the treasury Safe, 2 of 2 (read on chain 2026-11-14).
  it('says what the Safe can do to a loan at once: stop its repayment, then take the NFT', () => {
    expect(risks).toMatch(/value: "Venue's 2-key Safe"/);
    expect(risks).toMatch(/With no wait, both keys together can stop a loan from being repaid/);
    expect(risks).toMatch(/then take the NFT once the loan is due, leaving the lender unpaid/);
    expect(risks).not.toMatch(/ends at auction/);
    expect(risks.replaceAll("\\'", "'")).toContain(
      "with several lenders it goes to a 3-day auction, once the venue's Safe switches auctions on (not yet when read on chain 2026‑11‑24); until then the NFT stays locked",
    );
  });

  it('names the collections each feature really takes', () => {
    expect(risks).not.toContain('(JBAC, JBAY Gold, GNSS)');
    expect(risks).toMatch(/NFT lending \(JBAC, Nakamigos and GNSS Art\)/);
  });

  it('does not call a default automatic: the lender has to claim', () => {
    expect(risks).not.toMatch(/This process is automatic and enforced by the smart contract/);
    expect(risks).toMatch(/the lender can take your NFT at any moment/);
  });

  it('section 5 says another lender can take a loan over without the borrower, and repaying must come before the deadline', () => {
    // The window with its read date, and what a takeover changes for the borrower (the borrow tab's own words).
    expect(risks.replaceAll("\\'", "'")).toContain(
      "Another lender can also take your loan over at a lower rate without asking you, between 15% and 85% of its term (read on chain 2026‑11‑24; the venue's Safe can change that window at once). The loan then has a new number and its deadline can only move later; if the new lender lends more, the extra WETH is sent to you and you owe it too.",
    );
    expect(risks).toMatch(/failure to repay the loan before the agreed-upon deadline/);
    expect(risks).not.toMatch(/repay the loan by the agreed-upon deadline/);
  });

  it("section 8 says which contracts its timelock, instant pause and setters are on, and that Gondi's have neither", () => {
    // NFT lending is on Ethereum too, with no pause and no timelock: the timelock sentence must not cover it.
    const plain = risks.replaceAll("\\'", "'");
    expect(plain).not.toContain('On the Ethereum contracts, sensitive');
    expect(plain).toContain(
      "NFT lending runs on Gondi's loan contracts instead, which have no pause and no timelock: the venue's two-key Safe changes their settings with no wait, except a fee change, which needs 7 days' notice.",
    );
    expect(plain).toMatch(/On the Protocol's own Ethereum contracts, sensitive administrative actions \(treasury, fee recipients, fees, emission budget, oracle floors\) are subject to a 24-48 hour timelock to allow community review, but emergency pause and some operational setters take effect immediately/);
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
