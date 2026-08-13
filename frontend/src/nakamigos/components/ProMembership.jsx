import useProAccess, { PRO_PASS_LIVE } from "../hooks/useProAccess";
import { TEGRIDY_PRO_PASS_ADDRESS } from "../../lib/constants";

// ─── STATE OF THIS PAGE, VERIFIED ───
// 1. TEGRIDY_PRO_PASS_ADDRESS (lib/constants.ts) is the zero address, so
//    PRO_PASS_LIVE is false: there is no Pro Pass contract, and nothing on this
//    page can mint one.
// 2. `useProAccess` has exactly ONE consumer — this file. Nothing else in the app
//    reads it. So none of the perks below are wired anywhere: there is no Pro
//    badge renderer, no referral accounting, and no Pro-gated tool. They describe
//    the PLAN for the Pass, not behaviour that exists today.
// 3. Even after the address is set, `onCta` calls window.open(etherscan/address/…).
//    That is a block-explorer link-out, NOT an in-app mint.
// The page is kept whole and the roadmap is kept visible; what changed is that it
// now says which of it is shipped and which is planned. Pinned by proPageHonesty
// .test.jsx — if a perk here becomes real, wire it and move it out of the roadmap
// framing rather than deleting the disclosure.

// Additive perks only — Pro NEVER paywalls a feature that's free today; it adds
// flair, a referral cut, early access, and a tradeable membership NFT whose mint
// proceeds are real ETH to the treasury (funding real-yield staking, not emissions).
const PERKS = [
  ["✦", "Pro flair across the app", "A Pro badge on your profile, chat handle, and listings."],
  ["⇄", "Earn on who you bring", "A share of the platform fee on every buyer you refer."],
  ["⚡", "Early access to new tools", "Automation, smarter alerts, and Pro-only analytics first."],
  ["🪙", "A tradeable membership", "The Pass is an NFT — resell it anytime on the native book."],
  ["♺", "Funds real yield, not inflation", "Mint proceeds are ETH to the treasury → staker yield, not TOWELI emissions."],
];

function StatusPill({ isPro, loading }) {
  if (!PRO_PASS_LIVE) {
    // "MINTING SOON" implied a contract exists and a date is set. Neither is true:
    // the address constant is still 0x0. Say the checkable thing instead.
    return <span style={{ ...pill, color: "var(--text-dim)", borderColor: "var(--border)" }}>NOT YET DEPLOYED</span>;
  }
  if (loading) return <span style={{ ...pill, color: "var(--text-dim)", borderColor: "var(--border)" }}>CHECKING…</span>;
  if (isPro) return <span style={{ ...pill, color: "var(--gold)", borderColor: "var(--gold)", background: "rgba(212,168,67,0.1)" }}>✦ YOU'RE PRO</span>;
  return <span style={{ ...pill, color: "var(--naka-blue)", borderColor: "var(--naka-blue)" }}>NOT YET A MEMBER</span>;
}

const pill = {
  fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.06em",
  padding: "4px 12px", borderRadius: 999, border: "1px solid",
};

export default function ProMembership({ wallet, onConnect }) {
  const { isPro, loading } = useProAccess(wallet);

  // Mint/view CTA. The in-app primary-mint call is wired once the DropV2 Pro Pass
  // is deployed (its price + mint signature are known then); until launch the
  // button stays a non-committal "minting soon", and post-launch it opens the
  // live collection so the funnel works the moment the address is set.
  const onCta = () => {
    if (!PRO_PASS_LIVE) return;
    if (!wallet) { onConnect?.(); return; }
    window.open(`https://etherscan.io/address/${TEGRIDY_PRO_PASS_ADDRESS}`, "_blank", "noopener,noreferrer");
  };
  // Labels must describe what the click DOES. `onCta` opens Etherscan — it has
  // never minted — so no label here may promise a mint.
  const ctaLabel = !PRO_PASS_LIVE
    ? "Not available yet"
    : isPro
      ? "View your Pass on Etherscan ↗"
      : !wallet ? "Connect wallet" : "View Pass contract on Etherscan ↗";

  return (
    <section style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontFamily: "var(--pixel)", fontSize: 16, color: "var(--gold)", letterSpacing: "0.1em", marginBottom: 10 }}>
          TEGRIDY PRO
        </div>
        <div style={{ fontFamily: "var(--display)", fontSize: 15, color: "var(--text-dim)", maxWidth: 480, margin: "0 auto 14px", lineHeight: 1.5 }}>
          {/* Tense matters more than wording here: unqualified, this sentence
              describes a product you could go buy. The copy itself is untouched. */}
          {!PRO_PASS_LIVE && <strong style={{ color: "var(--text-muted)" }}>The plan: </strong>}
          A membership Pass for the power users — flair, a referral cut, early tools, and a stake in a protocol funded by real fees, not inflation.
        </div>
        <StatusPill isPro={isPro} loading={loading} />
      </div>

      {/* ADDITIVE honesty block — the page above and below it is unchanged. It
          exists because everything on this page is a plan, and a marketing page
          that does not say so reads as a product you can buy today. */}
      {!PRO_PASS_LIVE && (
        <div
          data-testid="pro-not-live-disclosure"
          role="note"
          style={{
            fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.65,
            color: "var(--text-dim)", marginBottom: 20,
            padding: "14px 18px", borderRadius: 12,
            background: "rgba(250,204,21,0.05)",
            border: "1px solid rgba(250,204,21,0.22)",
          }}
        >
          <div style={{ fontFamily: "var(--display)", fontSize: 13, fontWeight: 700, color: "var(--gold)", marginBottom: 6 }}>
            Where this actually stands
          </div>
          <div>
            The Pro Pass contract <strong style={{ color: "var(--text)" }}>has not been deployed</strong>,
            so there is nothing to mint and no Pass to hold. Everything below is the
            intended design, not shipped behaviour — no Pro badge, referral payout, or
            Pro-only tool exists in the app today. Nothing here is for sale, and we
            are not taking deposits, allowlist spots, or pre-orders. If you are asked
            to pay for a &ldquo;Tegridy Pro Pass&rdquo; anywhere right now, it is not us.
          </div>
        </div>
      )}

      <div style={{
        background: "var(--surface-glass)", backdropFilter: "var(--glass-blur)",
        border: "1px solid var(--border)", borderRadius: 16, padding: 24, marginBottom: 20,
      }}>
        <div style={{
          fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.08em",
          color: "var(--text-muted)", marginBottom: 14, textTransform: "uppercase",
        }}>
          {PRO_PASS_LIVE ? "What the Pass unlocks" : "Planned perks — none of these are live yet"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {PERKS.map(([icon, title, desc]) => (
            <div key={title} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <span style={{ fontSize: 18, lineHeight: 1.2, width: 24, textAlign: "center", flexShrink: 0 }}>{icon}</span>
              <div>
                <div style={{ fontFamily: "var(--display)", fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{title}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ textAlign: "center" }}>
        <button
          className="btn-primary"
          onClick={onCta}
          disabled={!PRO_PASS_LIVE}
          style={{ padding: "12px 32px", fontSize: 12, opacity: PRO_PASS_LIVE ? 1 : 0.55, cursor: PRO_PASS_LIVE ? "pointer" : "default" }}
        >
          {ctaLabel}
        </button>
        {!PRO_PASS_LIVE && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", marginTop: 10 }}>
            There is no mint date. When the Pass is deployed, its address is wired here
            and this button goes live — perks land as they are built, not on day one.
          </div>
        )}
        {PRO_PASS_LIVE && (
          /* Post-launch the button still only opens a block explorer. Saying so
             beats letting a user click "mint" and land somewhere they did not expect. */
          <div data-testid="pro-cta-linkout-note" style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", marginTop: 10 }}>
            Minting is not wired into this page — this opens the Pass contract on Etherscan.
          </div>
        )}
        {PRO_PASS_LIVE && !isPro && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", marginTop: 10 }}>
            One mint, lifetime access — and it's yours to resell on the native book.
          </div>
        )}
      </div>
    </section>
  );
}
