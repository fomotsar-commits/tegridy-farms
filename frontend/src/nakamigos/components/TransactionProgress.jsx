import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { getFriendlyError, isUserRejection } from "../lib/errorMessages";
import { getProvider } from "../api";

// ═══ STEPS ═══
const STEPS = {
  APPROVE: "approve",
  SIGN: "sign",
  PENDING: "pending",
  CONFIRMED: "confirmed",
};

const STEP_META = {
  [STEPS.APPROVE]: { label: "Approve", estimate: "~15s", icon: "\u{1F512}" },
  [STEPS.SIGN]: { label: "Sign Transaction", estimate: "Manual", icon: "\u{1F4F1}" },
  [STEPS.PENDING]: { label: "Pending", estimate: "~15-30s", icon: "\u231B" },
  [STEPS.CONFIRMED]: { label: "Confirmed", estimate: "", icon: "\u2713" },
};

const STEP_STATES = {
  UPCOMING: "upcoming",
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
};

// ═══ CONFETTI (canvas-based) ═══
function ConfettiCanvas({ active, duration = 3000 }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    if (!active || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const colors = ["#c8a850", "#6fa8dc", "#4ade80", "#ff6464", "#fbbf24", "#a78bfa"];
    const particles = [];
    for (let i = 0; i < 80; i++) {
      particles.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * canvas.width * 0.4,
        y: canvas.height * 0.3,
        vx: (Math.random() - 0.5) * 8,
        vy: -(Math.random() * 6 + 4),
        w: Math.random() * 8 + 4,
        h: Math.random() * 6 + 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 12,
        gravity: 0.15 + Math.random() * 0.05,
        opacity: 1,
      });
    }

    const start = performance.now();
    const animate = (now) => {
      const elapsed = now - start;
      if (elapsed > duration) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const fadeStart = duration * 0.7;

      for (const p of particles) {
        p.x += p.vx;
        p.vy += p.gravity;
        p.y += p.vy;
        p.rotation += p.rotSpeed;
        p.vx *= 0.99;

        if (elapsed > fadeStart) {
          p.opacity = Math.max(0, 1 - (elapsed - fadeStart) / (duration - fadeStart));
        }

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.globalAlpha = p.opacity;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [active, duration]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 10,
      }}
    />
  );
}

// ═══ STEPPER STEP ═══
function StepItem({ step, state, isLast }) {
  const meta = STEP_META[step];
  const isActive = state === STEP_STATES.ACTIVE;
  const isCompleted = state === STEP_STATES.COMPLETED;
  const isFailed = state === STEP_STATES.FAILED;
  const isUpcoming = state === STEP_STATES.UPCOMING;

  const circleColor = isCompleted
    ? "var(--green, #4ade80)"
    : isFailed
      ? "var(--red, #ff6464)"
      : isActive
        ? "var(--naka-blue, #6fa8dc)"
        : "var(--border, #333)";

  const textColor = isUpcoming ? "var(--text-muted, #555)" : "var(--text, #eee)";

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, position: "relative" }}>
      {/* Vertical connector line */}
      {!isLast && (
        <div
          style={{
            position: "absolute",
            left: 13,
            top: 28,
            width: 2,
            height: "calc(100% - 4px)",
            background: isCompleted ? "var(--green, #4ade80)" : "var(--border, #333)",
            transition: "background 0.3s",
          }}
        />
      )}

      {/* Circle indicator */}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          border: `2px solid ${circleColor}`,
          background: isCompleted || isFailed ? circleColor : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          transition: "all 0.3s",
          animation: isActive ? "txPulse 1.5s ease-in-out infinite" : "none",
        }}
      >
        {isCompleted && (
          <span style={{ color: "#000", fontSize: 14, fontWeight: 700 }}>{"\u2713"}</span>
        )}
        {isFailed && (
          <span style={{ color: "#fff", fontSize: 14, fontWeight: 700 }}>{"\u2717"}</span>
        )}
        {isActive && (
          <span style={{ fontSize: 12 }}>{step === STEPS.SIGN ? "\u{1F4F1}" : "\u231B"}</span>
        )}
      </div>

      {/* Label + estimate */}
      <div style={{ flex: 1, paddingBottom: isLast ? 0 : 20 }}>
        <div
          style={{
            fontFamily: "var(--display)",
            fontSize: 13,
            fontWeight: 600,
            color: textColor,
            transition: "color 0.3s",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {meta.label}
          {step === STEPS.SIGN && isActive && (
            <span style={{
              fontFamily: "var(--mono)",
              fontSize: 9,
              color: "var(--naka-blue)",
              background: "rgba(111,168,220,0.1)",
              border: "1px solid rgba(111,168,220,0.2)",
              borderRadius: 4,
              padding: "1px 6px",
            }}>
              CHECK WALLET
            </span>
          )}
        </div>
        {meta.estimate && !isCompleted && (
          <div style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--text-muted, #555)",
            marginTop: 2,
          }}>
            {meta.estimate}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══ TX HASH DISPLAY ═══
function TxHashLink({ hash }) {
  if (!hash) return null;
  const truncated = `${hash.slice(0, 8)}...${hash.slice(-6)}`;
  const url = `https://etherscan.io/tx/${hash}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        fontFamily: "var(--mono)",
        fontSize: 11,
        color: "var(--naka-blue, #6fa8dc)",
        textDecoration: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
      onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
    >
      {truncated} {"\u2197"}
    </a>
  );
}

// ═══ ELAPSED TIMER ═══
function ElapsedTimer({ startTime }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
      {minutes > 0 ? `${minutes}m ` : ""}{seconds}s
    </span>
  );
}

// ═══ SUCCESS RECEIPT ═══
function SuccessReceipt({ nft, price, gasUsed, txHash, onShareX, onClose, celebrationLevel }) {
  const totalCost = (price || 0) + (gasUsed || 0);

  return (
    <div style={{ textAlign: "center" }}>
      {/* Checkmark / animation */}
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "var(--green, #4ade80)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 16px",
          animation: celebrationLevel === "small" ? "txBounce 0.5s ease" : "txBounce 0.6s ease",
        }}
      >
        <span style={{ fontSize: 28, color: "#000", fontWeight: 700 }}>{"\u2713"}</span>
      </div>

      <div style={{
        fontFamily: "var(--display)",
        fontSize: 18,
        fontWeight: 700,
        color: "var(--text, #eee)",
        marginBottom: 4,
      }}>
        Purchase Complete
      </div>

      {/* NFT preview */}
      {nft && (
        <div style={{
          width: 120,
          height: 120,
          borderRadius: 10,
          overflow: "hidden",
          margin: "16px auto",
          border: "2px solid var(--gold, #c8a850)",
        }}>
          <NftImage nft={nft} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      )}

      {/* Receipt details */}
      <div style={{
        background: "rgba(255,255,255,0.03)",
        borderRadius: 8,
        padding: "12px 16px",
        margin: "12px 0",
        textAlign: "left",
      }}>
        {nft?.name && (
          <ReceiptRow label="Item" value={nft.name} />
        )}
        {price != null && price > 0 && (
          <ReceiptRow label="Price" value={<><Eth size={11} /> {Number(price).toFixed(4)}</>} />
        )}
        {gasUsed != null && gasUsed > 0 && (
          <ReceiptRow label="Gas" value={<><Eth size={11} /> {gasUsed.toFixed(4)}</>} />
        )}
        {totalCost > 0 && gasUsed != null && gasUsed > 0 && (
          <ReceiptRow label="Total" value={<><Eth size={11} /> {totalCost.toFixed(4)}</>} bold />
        )}
        {txHash && (
          <ReceiptRow label="Tx" value={<TxHashLink hash={txHash} />} />
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          onClick={onShareX}
          style={{
            flex: 1,
            fontFamily: "var(--display)",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.04em",
            color: "#fff",
            background: "#1d9bf0",
            border: "none",
            borderRadius: 8,
            padding: "10px 0",
            cursor: "pointer",
            transition: "filter 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.15)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
        >
          Share on X
        </button>
        <button
          onClick={onClose}
          style={{
            flex: 1,
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: "0.04em",
            color: "var(--text-dim)",
            background: "none",
            border: "1px solid var(--border, #333)",
            borderRadius: 8,
            padding: "10px 0",
            cursor: "pointer",
            transition: "color 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text, #eee)";
            e.currentTarget.style.borderColor = "var(--text-muted)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-dim)";
            e.currentTarget.style.borderColor = "var(--border, #333)";
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function ReceiptRow({ label, value, bold }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "5px 0",
      borderBottom: "1px solid rgba(255,255,255,0.04)",
    }}>
      <span style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        color: "var(--text-dim)",
        letterSpacing: "0.06em",
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: "var(--mono)",
        fontSize: bold ? 12 : 11,
        fontWeight: bold ? 700 : 400,
        color: bold ? "var(--text, #eee)" : "var(--text, #eee)",
        display: "flex",
        alignItems: "center",
        gap: 3,
      }}>
        {value}
      </span>
    </div>
  );
}

// ═══ ERROR PANEL ═══
function ErrorPanel({ message, onRetry, onBack }) {
  return (
    <div style={{ textAlign: "center", padding: "10px 0" }}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          background: "var(--red, #ff6464)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 14px",
        }}
      >
        <span style={{ fontSize: 24, color: "#fff", fontWeight: 700 }}>{"\u2717"}</span>
      </div>

      <div style={{
        fontFamily: "var(--display)",
        fontSize: 15,
        fontWeight: 700,
        color: "var(--text, #eee)",
        marginBottom: 8,
      }}>
        Transaction Failed
      </div>

      <div style={{
        fontFamily: "var(--mono)",
        fontSize: 12,
        color: "var(--text-dim)",
        lineHeight: 1.6,
        marginBottom: 16,
        padding: "0 8px",
      }}>
        {message}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {onRetry && (
          <button
            onClick={onRetry}
            style={{
              flex: 1,
              fontFamily: "var(--display)",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.06em",
              color: "var(--bg, #000)",
              background: "var(--gold, #c8a850)",
              border: "none",
              borderRadius: 8,
              padding: "10px 0",
              cursor: "pointer",
              transition: "filter 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.1)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
          >
            RETRY
          </button>
        )}
        <button
          onClick={onBack}
          style={{
            flex: 1,
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: "0.04em",
            color: "var(--text-dim)",
            background: "none",
            border: "1px solid var(--border, #333)",
            borderRadius: 8,
            padding: "10px 0",
            cursor: "pointer",
            transition: "color 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text, #eee)";
            e.currentTarget.style.borderColor = "var(--text-muted)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-dim)";
            e.currentTarget.style.borderColor = "var(--border, #333)";
          }}
        >
          BACK
        </button>
      </div>
    </div>
  );
}

// ═══ SPEED UP BUTTON ═══
function SpeedUpButton({ txHash, onSpeedUp, visible }) {
  if (!visible) return null;
  return (
    <button
      onClick={() => onSpeedUp?.(txHash)}
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        color: "var(--yellow, #fbbf24)",
        background: "rgba(251,191,36,0.08)",
        border: "1px solid rgba(251,191,36,0.2)",
        borderRadius: 6,
        padding: "5px 10px",
        cursor: "pointer",
        marginTop: 8,
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(251,191,36,0.15)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(251,191,36,0.08)"; }}
    >
      SPEED UP
    </button>
  );
}

// ═══ PENDING TX MONITOR ═══
function PendingMonitor({ txHash, startTime, onConfirmed, onError }) {
  const [showSpeedUp, setShowSpeedUp] = useState(false);
  const pollRef = useRef(null);
  const speedUpTimerRef = useRef(null);
  // Use refs for callbacks to avoid restarting the polling effect
  const onConfirmedRef = useRef(onConfirmed);
  const onErrorRef = useRef(onError);
  useEffect(() => { onConfirmedRef.current = onConfirmed; }, [onConfirmed]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!txHash) return;

    // Poll for receipt every 3 seconds
    const poll = async () => {
      try {
        const ethProvider = getProvider();
        if (!ethProvider) return;
        const { ethers } = await import("ethers");
        const provider = new ethers.BrowserProvider(ethProvider);
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt) {
          if (receipt.status === 1) {
            const gasUsed = receipt.gasUsed && receipt.gasPrice
              ? Number(receipt.gasUsed * receipt.gasPrice) / 1e18
              : null;
            onConfirmedRef.current?.({ receipt, gasUsed });
          } else {
            onErrorRef.current?.("Transaction reverted on-chain");
          }
          return; // Stop polling
        }
      } catch (err) {
        console.warn("Polling tx receipt:", err.message);
      }
      pollRef.current = setTimeout(poll, 3000);
    };

    pollRef.current = setTimeout(poll, 3000);

    // Show speed-up after 2 minutes
    speedUpTimerRef.current = setTimeout(() => {
      setShowSpeedUp(true);
    }, 120000);

    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
      if (speedUpTimerRef.current) clearTimeout(speedUpTimerRef.current);
    };
  }, [txHash]);

  const handleSpeedUp = useCallback(async () => {
    try {
      const ethProvider = getProvider();
      if (!ethProvider) return;
      const { ethers } = await import("ethers");
      const provider = new ethers.BrowserProvider(ethProvider);
      const tx = await provider.getTransaction(txHash);
      if (!tx) return;
      const signer = await provider.getSigner();
      // Resubmit with 20% higher gas
      const newMaxFee = tx.maxFeePerGas ? tx.maxFeePerGas * 120n / 100n : undefined;
      const newMaxPriority = tx.maxPriorityFeePerGas ? tx.maxPriorityFeePerGas * 120n / 100n : undefined;
      await signer.sendTransaction({
        to: tx.to,
        value: tx.value,
        data: tx.data,
        nonce: tx.nonce,
        maxFeePerGas: newMaxFee,
        maxPriorityFeePerGas: newMaxPriority,
      });
    } catch (err) {
      console.warn("Speed up failed:", err.message);
    }
  }, [txHash]);

  return (
    <div style={{
      background: "rgba(111,168,220,0.06)",
      borderRadius: 8,
      padding: "10px 14px",
      marginTop: 12,
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <TxHashLink hash={txHash} />
        <ElapsedTimer startTime={startTime} />
      </div>
      <SpeedUpButton txHash={txHash} onSpeedUp={handleSpeedUp} visible={showSpeedUp} />
    </div>
  );
}

// ═══ CSS KEYFRAMES (injected once) ═══
const STYLE_ID = "tx-progress-styles";
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes txPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(111,168,220,0.4); }
      50% { box-shadow: 0 0 0 8px rgba(111,168,220,0); }
    }
    @keyframes txBounce {
      0% { transform: scale(0.3); opacity: 0; }
      50% { transform: scale(1.1); }
      70% { transform: scale(0.95); }
      100% { transform: scale(1); opacity: 1; }
    }
    @keyframes txFadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

// ═══ CELEBRATION LEVEL ═══
function getCelebrationLevel(priceEth) {
  if (priceEth == null || priceEth < 0.1) return "small";
  return "medium"; // 0.1+ ETH gets confetti
}

// ═══ MAIN COMPONENT ═══
/**
 * TransactionProgress — overlay component for NFT purchase flow.
 *
 * Props:
 *   visible       - boolean, show/hide overlay
 *   nft           - the NFT being purchased (for receipt)
 *   price         - price in ETH
 *   needsApproval - whether an approval step is needed
 *   onExecute     - async fn that performs the purchase, returns { success, hash, error, message }
 *   onClose       - called when user closes the overlay
 *   onSuccess     - called after confirmed with { hash, gasUsed }
 *   collectionName - for share text
 */
export default function TransactionProgress({
  visible,
  nft,
  price,
  needsApproval = false,
  onExecute,
  onClose,
  onSuccess,
  collectionName = "",
}) {
  const [phase, setPhase] = useState("idle"); // idle | signing | pending | confirmed | error
  const [stepStates, setStepStates] = useState({});
  const [txHash, setTxHash] = useState(null);
  const [pendingStart, setPendingStart] = useState(null);
  const [gasUsed, setGasUsed] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [showConfetti, setShowConfetti] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const executedRef = useRef(false);
  const txHashRef = useRef(null);

  // Inject keyframe styles
  useEffect(() => { injectStyles(); }, []);

  const steps = useMemo(() => {
    const s = [];
    if (needsApproval) s.push(STEPS.APPROVE);
    s.push(STEPS.SIGN, STEPS.PENDING, STEPS.CONFIRMED);
    return s;
  }, [needsApproval]);

  // Build step states from phase
  useEffect(() => {
    const states = {};
    const stepOrder = [...steps];

    if (phase === "idle" || phase === "signing") {
      for (let i = 0; i < stepOrder.length; i++) {
        const step = stepOrder[i];
        if (step === STEPS.SIGN && phase === "signing") {
          states[step] = STEP_STATES.ACTIVE;
        } else if (step === STEPS.APPROVE && phase === "signing" && needsApproval) {
          states[step] = STEP_STATES.COMPLETED;
        } else if (i < stepOrder.indexOf(STEPS.SIGN)) {
          states[step] = phase === "signing" ? STEP_STATES.COMPLETED : STEP_STATES.UPCOMING;
        } else {
          states[step] = STEP_STATES.UPCOMING;
        }
      }
    } else if (phase === "pending") {
      for (const step of stepOrder) {
        if (step === STEPS.PENDING) states[step] = STEP_STATES.ACTIVE;
        else if (step === STEPS.CONFIRMED) states[step] = STEP_STATES.UPCOMING;
        else states[step] = STEP_STATES.COMPLETED;
      }
    } else if (phase === "confirmed") {
      for (const step of stepOrder) {
        states[step] = STEP_STATES.COMPLETED;
      }
    } else if (phase === "error") {
      for (const step of stepOrder) {
        if (step === STEPS.PENDING && txHash) {
          states[step] = STEP_STATES.FAILED;
        } else if (step === STEPS.SIGN && !txHash) {
          states[step] = STEP_STATES.FAILED;
        } else if (states[step] === undefined) {
          // Earlier steps may be completed
          const idx = stepOrder.indexOf(step);
          const failIdx = txHash
            ? stepOrder.indexOf(STEPS.PENDING)
            : stepOrder.indexOf(STEPS.SIGN);
          states[step] = idx < failIdx ? STEP_STATES.COMPLETED : STEP_STATES.UPCOMING;
        }
      }
    }

    setStepStates(states);
  }, [phase, steps, needsApproval, txHash]);

  // Keep txHashRef in sync
  useEffect(() => { txHashRef.current = txHash; }, [txHash]);

  // Auto-execute when visible (retryCount in deps forces re-run on retry)
  useEffect(() => {
    if (!visible || !onExecute || executedRef.current) return;
    executedRef.current = true;

    const run = async () => {
      setPhase("signing");
      setErrorMsg("");
      setTxHash(null);
      setGasUsed(null);
      setShowConfetti(false);

      try {
        const result = await onExecute();

        if (result.success && result.hash) {
          setTxHash(result.hash);
          setPhase("pending");
          setPendingStart(Date.now());
        } else if (result.error === "rejected") {
          // User rejected — just close, no error display
          onClose?.();
        } else {
          const friendly = getFriendlyError(result.message || result.error || "Transaction failed");
          setErrorMsg(friendly);
          setPhase("error");
        }
      } catch (err) {
        if (isUserRejection(err)) {
          onClose?.();
        } else {
          setErrorMsg(getFriendlyError(err));
          setPhase("error");
        }
      }
    };

    run();
  }, [visible, onExecute, onClose, retryCount]);

  // Reset on hide
  useEffect(() => {
    if (!visible) {
      executedRef.current = false;
      setPhase("idle");
      setTxHash(null);
      setPendingStart(null);
      setGasUsed(null);
      setErrorMsg("");
      setShowConfetti(false);
    }
  }, [visible]);

  const handleConfirmed = useCallback(({ gasUsed: gas }) => {
    setGasUsed(gas);
    setPhase("confirmed");
    const level = getCelebrationLevel(price);
    if (level === "medium") {
      setShowConfetti(true);
    }
    onSuccess?.({ hash: txHashRef.current, gasUsed: gas });
  }, [price, onSuccess]);

  const handlePendingError = useCallback((msg) => {
    setErrorMsg(getFriendlyError(msg));
    setPhase("error");
  }, []);

  const handleRetry = useCallback(() => {
    executedRef.current = false;
    setPhase("idle");
    setTxHash(null);
    setErrorMsg("");
    setGasUsed(null);
    setShowConfetti(false);
    // Increment retryCount to force the auto-execute effect to re-run
    setRetryCount((c) => c + 1);
  }, []);

  const handleShareX = useCallback(() => {
    const name = nft?.name || `#${nft?.id}` || "an NFT";
    const collection = collectionName || "";
    const text = `Just bought ${name}${collection ? ` from the ${collection} collection` : ""}!`;
    const url = txHash ? `https://etherscan.io/tx/${txHash}` : "";
    window.open(
      `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      "_blank",
      "noopener,noreferrer,width=600,height=400"
    );
  }, [nft, collectionName, txHash]);

  if (!visible) return null;

  const celebrationLevel = getCelebrationLevel(price);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(8px)",
        animation: "txFadeIn 0.25s ease",
      }}
      onClick={(e) => {
        // Only allow closing on backdrop click if in error/confirmed state
        if (e.target === e.currentTarget && (phase === "error" || phase === "confirmed")) {
          onClose?.();
        }
      }}
    >
      <div
        style={{
          position: "relative",
          width: 360,
          maxWidth: "90vw",
          maxHeight: "85vh",
          overflowY: "auto",
          background: "var(--surface, #111)",
          border: "1px solid var(--border, #222)",
          borderRadius: 14,
          padding: "24px 20px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <ConfettiCanvas active={showConfetti} duration={3000} />

        {/* Close button (only in final states) */}
        {(phase === "confirmed" || phase === "error") && (
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              position: "absolute",
              top: 12,
              right: 14,
              fontFamily: "var(--mono)",
              fontSize: 16,
              color: "var(--text-dim)",
              background: "none",
              border: "none",
              cursor: "pointer",
              zIndex: 20,
              padding: "2px 6px",
            }}
          >
            {"\u2715"}
          </button>
        )}

        {/* Header */}
        {phase !== "confirmed" && phase !== "error" && (
          <div style={{
            fontFamily: "var(--display)",
            fontSize: 14,
            fontWeight: 700,
            color: "var(--text, #eee)",
            letterSpacing: "0.04em",
            marginBottom: 20,
          }}>
            {phase === "signing" ? "Waiting for Signature" : phase === "pending" ? "Transaction Pending" : "Processing"}
          </div>
        )}

        {/* STEPPER (visible during signing / pending) */}
        {(phase === "signing" || phase === "pending") && (
          <div style={{ marginBottom: 12 }}>
            {steps.map((step, i) => (
              <StepItem
                key={step}
                step={step}
                state={stepStates[step] || STEP_STATES.UPCOMING}
                isLast={i === steps.length - 1}
              />
            ))}
          </div>
        )}

        {/* PENDING MONITOR */}
        {phase === "pending" && txHash && (
          <PendingMonitor
            txHash={txHash}
            startTime={pendingStart}
            onConfirmed={handleConfirmed}
            onError={handlePendingError}
          />
        )}

        {/* SUCCESS */}
        {phase === "confirmed" && (
          <SuccessReceipt
            nft={nft}
            price={price}
            gasUsed={gasUsed}
            txHash={txHash}
            onShareX={handleShareX}
            onClose={onClose}
            celebrationLevel={celebrationLevel}
          />
        )}

        {/* ERROR */}
        {phase === "error" && (
          <ErrorPanel
            message={errorMsg}
            onRetry={handleRetry}
            onBack={onClose}
          />
        )}
      </div>
    </div>
  );
}

/**
 * useTransactionProgress — hook to manage the overlay state.
 *
 * Returns:
 *   { showProgress, startTransaction, closeProgress, progressProps }
 */
export function useTransactionProgress({ collectionName = "" } = {}) {
  const [visible, setVisible] = useState(false);
  const [txConfig, setTxConfig] = useState(null);

  const startTransaction = useCallback(({ nft, price, needsApproval = false, onExecute, onSuccess, onError }) => {
    setTxConfig({ nft, price, needsApproval, onExecute, onSuccess, onError });
    setVisible(true);
  }, []);

  const closeProgress = useCallback(() => {
    setVisible(false);
    setTxConfig(null);
  }, []);

  const progressProps = useMemo(() => ({
    visible,
    nft: txConfig?.nft,
    price: txConfig?.price,
    needsApproval: txConfig?.needsApproval,
    onExecute: txConfig?.onExecute,
    onClose: (...args) => {
      closeProgress(...args);
      txConfig?.onError?.();
    },
    onSuccess: (...args) => {
      txConfig?.onSuccess?.(...args);
    },
    collectionName,
  }), [visible, txConfig, closeProgress, collectionName]);

  return { showProgress: visible, startTransaction, closeProgress, progressProps };
}
