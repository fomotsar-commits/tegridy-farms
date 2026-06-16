import useProAccess, { PRO_PASS_LIVE } from "../hooks/useProAccess";
import { TEGRIDY_PRO_PASS_ADDRESS } from "../../lib/constants";

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
    return <span style={{ ...pill, color: "var(--text-dim)", borderColor: "var(--border)" }}>MINTING SOON</span>;
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
  const ctaLabel = !PRO_PASS_LIVE
    ? "Minting soon"
    : isPro ? "Manage your Pass" : !wallet ? "Connect to mint" : "Mint Pro Pass";

  return (
    <section style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontFamily: "var(--pixel)", fontSize: 16, color: "var(--gold)", letterSpacing: "0.1em", marginBottom: 10 }}>
          TEGRIDY PRO
        </div>
        <div style={{ fontFamily: "var(--display)", fontSize: 15, color: "var(--text-dim)", maxWidth: 480, margin: "0 auto 14px", lineHeight: 1.5 }}>
          A membership Pass for the power users — flair, a referral cut, early tools, and a stake in a protocol funded by real fees, not inflation.
        </div>
        <StatusPill isPro={isPro} loading={loading} />
      </div>

      <div style={{
        background: "var(--surface-glass)", backdropFilter: "var(--glass-blur)",
        border: "1px solid var(--border)", borderRadius: 16, padding: 24, marginBottom: 20,
      }}>
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
            The Pro Pass drops with the next wave — perks light up automatically for holders.
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
