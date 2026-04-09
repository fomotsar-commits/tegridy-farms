import { useState, useEffect, useCallback, useRef } from "react";
import { getProfile, saveProfile } from "../lib/userdata";
import { useActiveCollection } from "../contexts/CollectionContext";
import { lockScroll, unlockScroll } from "../lib/scrollLock";

/* Deterministic gradient avatar from wallet address */
function walletHue(addr) {
  if (!addr) return 200;
  const hex = addr.slice(2, 10);
  return parseInt(hex, 16) % 360;
}
function walletHue2(addr) {
  if (!addr) return 40;
  const hex = addr.slice(10, 18);
  return parseInt(hex, 16) % 360;
}

export default function EditProfile({ wallet, onClose, onConnect, addToast, onSave }) {
  const { slug } = useActiveCollection();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [twitter, setTwitter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const modalRef = useRef(null);

  // Close on Escape + focus trap
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); onClose(); return; }
      if (e.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
    };
    window.addEventListener("keydown", h);
    lockScroll();
    const closeBtn = modalRef.current?.querySelector('[aria-label="Close modal"]');
    closeBtn?.focus();
    return () => {
      window.removeEventListener("keydown", h);
      unlockScroll();
    };
  }, [onClose]);

  // Load existing profile — reset fields when wallet or collection changes
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    setLoading(true);
    setDisplayName("");
    setBio("");
    setTwitter("");
    (async () => {
      try {
        const p = await getProfile(wallet, slug);
        if (cancelled) return;
        if (p) {
          setDisplayName(p.displayName || "");
          setBio(p.bio || "");
          setTwitter(p.twitter || "");
        }
      } catch (err) {
        console.error("Failed to load profile:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [wallet, slug]);

  const handleTwitterChange = useCallback((e) => {
    let val = e.target.value;
    // strip leading @ if user types it, we auto-prepend
    val = val.replace(/^@/, "");
    if (val.length <= 40) setTwitter(val);
  }, []);

  const handleSave = useCallback(async () => {
    if (!wallet) return;
    setSaving(true);
    try {
      await saveProfile(wallet, {
        displayName: displayName.trim(),
        bio: bio.trim(),
        twitter: twitter.trim(),
      }, slug);
      addToast?.("Profile saved", "success");
      onSave?.();
      onClose();
    } catch (err) {
      console.error("Save profile error:", err);
      addToast?.("Failed to save profile. Please try again.", "error");
    } finally {
      setSaving(false);
    }
  }, [wallet, displayName, bio, twitter, slug, addToast, onSave, onClose]);

  const h1 = walletHue(wallet);
  const h2 = walletHue2(wallet);

  if (!wallet) {
    return (
      <div className="modal-bg" onClick={onClose} style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label="Edit Profile">
        <div
          ref={modalRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            background: "var(--card)", border: "1px solid var(--border)",
            borderRadius: 14, maxWidth: 420, width: "90%", margin: "auto",
            padding: "28px 24px", position: "relative",
          }}
        >
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close modal"
            style={{
              position: "absolute", top: 12, right: 14, background: "none",
              border: "none", color: "var(--text-dim)", fontSize: 18, cursor: "pointer",
            }}
          >{"\u2715"}</button>
          <div className="wallet-connect-prompt" style={{ padding: "20px 0" }}>
            <div className="wallet-connect-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <h3 className="wallet-connect-title">Connect Your Wallet</h3>
            <p className="wallet-connect-desc">
              Connect your wallet to edit your profile, set a display name, and link your socials.
            </p>
            <button className="btn-primary wallet-connect-btn" onClick={onConnect}>
              Connect Wallet
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-bg" onClick={onClose} style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label="Edit Profile">
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--card)", border: "1px solid var(--border)",
          borderRadius: 14, maxWidth: 420, width: "90%", margin: "auto",
          padding: "28px 24px", position: "relative",
        }}
      >
        {/* Close button */}
        <button
          className="modal-close"
          onClick={onClose}
          aria-label="Close modal"
          style={{
            position: "absolute", top: 12, right: 14, background: "none",
            border: "none", color: "var(--text-dim)", fontSize: 18, cursor: "pointer",
          }}
        >{"\u2715"}</button>

        {/* Type label */}
        <div style={{
          fontFamily: "var(--pixel)", fontSize: 10, color: "var(--naka-blue)",
          letterSpacing: "0.1em", marginBottom: 6,
        }}>
          EDIT PROFILE
        </div>

        {/* Title */}
        <div style={{
          fontFamily: "var(--display)", fontSize: 18, fontWeight: 600,
          color: "var(--text)", marginBottom: 20,
        }}>
          Your Profile
        </div>

        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "24px 0" }}>
            <div className="skeleton" style={{ width: 80, height: 80, borderRadius: "50%", margin: "0 auto" }} />
            <div className="skeleton" style={{ height: 40, borderRadius: 10 }} />
            <div className="skeleton" style={{ height: 80, borderRadius: 10, animationDelay: "60ms" }} />
            <div className="skeleton" style={{ height: 40, borderRadius: 10, animationDelay: "120ms" }} />
          </div>
        ) : (
          <>
            {/* Avatar */}
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
              <div style={{
                width: 72, height: 72, borderRadius: "50%",
                background: `linear-gradient(135deg, hsl(${h1},65%,55%), hsl(${h2},65%,45%))`,
                border: "2px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: "var(--display)", fontSize: 24, fontWeight: 700,
                color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.4)",
              }}>
                {(displayName || wallet || "?").slice(0, 2).toUpperCase()}
              </div>
            </div>

            {/* Display Name */}
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="display-name-input" style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
                letterSpacing: "0.06em", display: "block", marginBottom: 6,
              }}>
                DISPLAY NAME
              </label>
              <input
                id="display-name-input"
                type="text"
                value={displayName}
                onChange={(e) => { if (e.target.value.length <= 32) setDisplayName(e.target.value); }}
                placeholder="Enter display name"
                maxLength={32}
                style={{
                  width: "100%", boxSizing: "border-box",
                  background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)",
                  borderRadius: 8, padding: "10px 14px",
                  fontFamily: "var(--mono)", fontSize: 14, color: "var(--text)",
                  outline: "none",
                }}
              />
            </div>

            {/* Bio */}
            <div style={{ marginBottom: 16 }}>
              <div style={{
                display: "flex", justifyContent: "space-between", alignItems: "baseline",
                marginBottom: 6,
              }}>
                <label htmlFor="bio-textarea" style={{
                  fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
                  letterSpacing: "0.06em",
                }}>
                  BIO
                </label>
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 10,
                  color: bio.length > 140 ? "var(--gold)" : "var(--text-muted)",
                }}>
                  {bio.length}/160
                </span>
              </div>
              <textarea
                id="bio-textarea"
                value={bio}
                onChange={(e) => { if (e.target.value.length <= 160) setBio(e.target.value); }}
                placeholder="Tell us about yourself"
                maxLength={160}
                rows={3}
                style={{
                  width: "100%", boxSizing: "border-box", resize: "vertical",
                  background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)",
                  borderRadius: 8, padding: "10px 14px",
                  fontFamily: "var(--mono)", fontSize: 13, color: "var(--text)",
                  outline: "none", lineHeight: 1.5,
                }}
              />
            </div>

            {/* Twitter */}
            <div style={{ marginBottom: 24 }}>
              <label htmlFor="twitter-input" style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
                letterSpacing: "0.06em", display: "block", marginBottom: 6,
              }}>
                TWITTER
              </label>
              <div style={{
                display: "flex", alignItems: "center", gap: 0,
                background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)",
                borderRadius: 8, overflow: "hidden",
              }}>
                <span style={{
                  padding: "10px 0 10px 14px",
                  fontFamily: "var(--mono)", fontSize: 14, color: "var(--text-muted)",
                  userSelect: "none",
                }}>@</span>
                <input
                  id="twitter-input"
                  type="text"
                  value={twitter}
                  onChange={handleTwitterChange}
                  placeholder="handle"
                  maxLength={40}
                  style={{
                    flex: 1, background: "transparent", border: "none", outline: "none",
                    padding: "10px 14px 10px 4px",
                    fontFamily: "var(--mono)", fontSize: 14, color: "var(--text)",
                  }}
                />
              </div>
            </div>

            {/* Save button */}
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={saving}
              style={{
                width: "100%", opacity: saving ? 0.6 : 1,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "Saving..." : "Save Profile"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
