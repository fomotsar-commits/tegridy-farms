import { useRef, useMemo, memo, useState, useEffect, useCallback } from "react";
import React from "react";
import { motion } from "framer-motion";

// ═══ Theme-aware color palette ═══
function useThemeColors() {
  const [colors, setColors] = useState(getColors());
  useEffect(() => {
    const obs = new MutationObserver(() => setColors(getColors()));
    obs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return colors;
}

function getColors() {
  const cl = document.body.className || "";
  if (cl.includes("theme-sovereign")) {
    return {
      accent1: "rgba(200, 170, 100, 0.12)",
      accent2: "rgba(111, 168, 220, 0.07)",
      accent3: "rgba(170, 100, 255, 0.05)",
      orbColor: "rgba(200, 170, 100, 0.14)",
      rayColor: "rgba(200, 170, 100, 0.05)",
      gridColor: "rgba(200, 170, 100, 0.018)",
      dustColor: "rgba(200, 170, 100, 0.4)",
      artOpacity: 0.22,
      noiseOpacity: 0.04,
      goldGlow: true,
      meshBg: "radial-gradient(ellipse at 20% 30%, rgba(200,170,100,0.14) 0%, transparent 50%), radial-gradient(ellipse at 75% 70%, rgba(111,168,220,0.08) 0%, transparent 55%), radial-gradient(ellipse at 50% 50%, rgba(200,170,100,0.06) 0%, transparent 45%), radial-gradient(ellipse at 85% 15%, rgba(170,100,255,0.04) 0%, transparent 40%)",
    };
  }
  if (cl.includes("theme-midnight")) {
    return {
      accent1: "rgba(111, 168, 220, 0.08)",
      accent2: "rgba(200, 170, 100, 0.06)",
      accent3: "rgba(170, 68, 255, 0.06)",
      orbColor: "rgba(111, 168, 220, 0.1)",
      rayColor: "rgba(111, 168, 220, 0.03)",
      gridColor: "rgba(255, 255, 255, 0.012)",
      dustColor: "rgba(111, 168, 220, 0.3)",
      artOpacity: 0.24,
      noiseOpacity: 0.05,
      goldGlow: false,
      showStars: true,
      showAurora: true,
      showMoon: true,
      meshBg: "radial-gradient(ellipse at 15% 50%, rgba(111,168,220,0.1) 0%, transparent 55%), radial-gradient(ellipse at 80% 25%, rgba(200,170,100,0.07) 0%, transparent 55%), radial-gradient(ellipse at 55% 80%, rgba(170,68,255,0.06) 0%, transparent 50%)",
    };
  }
  // Default theme — neutral, balanced
  return {
    accent1: "rgba(111, 168, 220, 0.06)",
    accent2: "rgba(200, 170, 100, 0.05)",
    accent3: "rgba(170, 68, 255, 0.04)",
    orbColor: "rgba(150, 150, 170, 0.08)",
    rayColor: "rgba(150, 150, 170, 0.025)",
    gridColor: "rgba(255, 255, 255, 0.01)",
    dustColor: "rgba(180, 180, 200, 0.25)",
    artOpacity: 0.2,
    noiseOpacity: 0.04,
    goldGlow: false,
    meshBg: "radial-gradient(ellipse at 15% 50%, rgba(111,168,220,0.07) 0%, transparent 55%), radial-gradient(ellipse at 80% 25%, rgba(200,170,100,0.05) 0%, transparent 55%), radial-gradient(ellipse at 55% 80%, rgba(170,68,255,0.04) 0%, transparent 50%)",
  };
}

// ═══ Ghost art — barely visible, deeply atmospheric ═══
// ═══ BACKGROUND ART — all 20 images in 5x4 grid, zero overlap guaranteed ═══
// Grid: 4 columns × 5 rows. Cell size = 25vw × 20vh.
// Images max 22vw wide, centered in cell with 1.5vw padding each side.
// Staggered: odd rows offset 12vw right for organic look.
const BG_ART = [
  // Row 0 (top: -5vh) — cols at 0, 25, 50, 75
  { src: "/splash/HBl2oMKbIAA813y.jpg", pos: { left: "-3vw", top: "-4vh" }, w: "clamp(340px, 30vw, 520px)", rot: -3, drift: { x: 4, y: 3 }, dur: 30 },      // BIG
  { src: "/splash/watercolor.jpg", pos: { left: "26vw", top: "0vh" }, w: "clamp(280px, 24vw, 420px)", rot: 4, drift: { x: 5, y: -3 }, dur: 32 },             // medium
  { src: "/splash/HCIMNrZWYAAqbo1.jpg", pos: { left: "52vw", top: "-2vh" }, w: "clamp(320px, 28vw, 480px)", rot: -2, drift: { x: 3, y: -3 }, dur: 34 },     // BIG
  { src: "/splash/HA5nUQ_bsAIHd55.jpg", pos: { left: "77vw", top: "2vh" }, w: "clamp(260px, 22vw, 400px)", rot: 3, drift: { x: -4, y: 5 }, dur: 28 },       // medium

  // Row 1 (top: 20vh) — staggered right 12vw
  { src: "/splash/skeleton.jpg", pos: { left: "10vw", top: "20vh" }, w: "clamp(240px, 22vw, 380px)", rot: -2, drift: { x: 3, y: -3 }, dur: 26 },             // medium
  { src: "/splash/G-FPcYdXMAAKsWR.jpg", pos: { left: "36vw", top: "22vh" }, w: "clamp(340px, 30vw, 520px)", rot: -3, drift: { x: -4, y: 4 }, dur: 27 },     // BIG
  { src: "/splash/HBbsuPEacAAX0VA.jpg", pos: { left: "62vw", top: "19vh" }, w: "clamp(280px, 24vw, 420px)", rot: 2, drift: { x: -3, y: 4 }, dur: 28 },       // medium
  { src: "/splash/sartoshi3d.jpg", pos: { left: "84vw", top: "23vh" }, w: "clamp(300px, 26vw, 460px)", rot: -4, drift: { x: -5, y: 3 }, dur: 34 },            // BIG-ish

  // Row 2 (top: 42vh) — cols at 0, 25, 50, 75
  { src: "/splash/HBTG_oqa0AAzPs4.jpg", pos: { left: "-2vw", top: "40vh" }, w: "clamp(300px, 26vw, 460px)", rot: -4, drift: { x: 6, y: -4 }, dur: 36 },      // BIG-ish
  { src: "/splash/ninja.jpg", pos: { left: "26vw", top: "44vh" }, w: "clamp(260px, 22vw, 400px)", rot: 3, drift: { x: -3, y: 5 }, dur: 24 },                  // medium
  { src: "/splash/G--r5iuXIAEPwLt.jpg", pos: { left: "52vw", top: "41vh" }, w: "clamp(340px, 30vw, 520px)", rot: -2, drift: { x: 4, y: -3 }, dur: 25 },      // BIG
  { src: "/splash/G_dkPgxX0AA-9SG.jpg", pos: { left: "78vw", top: "43vh" }, w: "clamp(280px, 24vw, 420px)", rot: 4, drift: { x: -5, y: 4 }, dur: 32 },       // medium

  // Row 3 (top: 62vh) — staggered right 12vw
  { src: "/splash/angel.jpg", pos: { left: "8vw", top: "62vh" }, w: "clamp(320px, 28vw, 480px)", rot: -3, drift: { x: -4, y: -3 }, dur: 26 },                 // BIG
  { src: "/splash/GVsANPZW4AAv1XY.jpg", pos: { left: "35vw", top: "64vh" }, w: "clamp(240px, 22vw, 380px)", rot: 2, drift: { x: 3, y: -4 }, dur: 29 },       // medium
  { src: "/splash/G24BZRrakAA1M_9.jpg", pos: { left: "60vw", top: "61vh" }, w: "clamp(300px, 26vw, 460px)", rot: -3, drift: { x: -3, y: 4 }, dur: 35 },      // BIG-ish
  { src: "/splash/frogking.jpg", pos: { left: "84vw", top: "65vh" }, w: "clamp(260px, 22vw, 400px)", rot: 5, drift: { x: 5, y: -4 }, dur: 29 },               // medium

  // Row 4 (top: 83vh) — cols at 0, 25, 50, 75
  { src: "/splash/G-AVjGGakAAuW7Z.jpg", pos: { left: "0vw", top: "83vh" }, w: "clamp(280px, 24vw, 420px)", rot: 3, drift: { x: 5, y: -5 }, dur: 30 },        // medium
  { src: "/splash/HC6HNXsW4AA-UwM.jpg", pos: { left: "27vw", top: "85vh" }, w: "clamp(340px, 30vw, 520px)", rot: 2, drift: { x: 3, y: -5 }, dur: 31 },       // BIG
  { src: "/splash/G8jE1EcWMAAvHTy.jpg", pos: { left: "53vw", top: "82vh" }, w: "clamp(280px, 24vw, 420px)", rot: -5, drift: { x: -5, y: -4 }, dur: 33 },     // medium
  { src: "/splash/HA5Fd6kWMAAMqL_.jpg", pos: { left: "78vw", top: "84vh" }, w: "clamp(300px, 26vw, 460px)", rot: -3, drift: { x: -4, y: 3 }, dur: 27 },      // BIG-ish
];

function GhostArt({ art, opacity }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={loaded ? {
        opacity,
        x: [0, art.drift.x, art.drift.x * -0.4, 0],
        y: [0, art.drift.y, art.drift.y * -0.5, 0],
        rotate: [art.rot, art.rot + 1, art.rot - 0.8, art.rot],
      } : { opacity: 0 }}
      transition={{
        opacity: { duration: 4, delay: 0.5 },
        x: { duration: art.dur, repeat: Infinity, ease: "easeInOut" },
        y: { duration: art.dur + 4, repeat: Infinity, ease: "easeInOut" },
        rotate: { duration: art.dur + 8, repeat: Infinity, ease: "easeInOut" },
      }}
      style={{ position: "fixed", ...art.pos, width: art.w, aspectRatio: "1", zIndex: 0, pointerEvents: "none" }}
    >
      <img
        src={art.src}
        alt=""
        onLoad={() => setLoaded(true)}
        style={{
          width: "100%", height: "100%", objectFit: "contain", display: "block",
          filter: "blur(0.5px) saturate(0.7) brightness(0.85) contrast(0.95)",
          maskImage: "radial-gradient(ellipse 70% 70% at center, black 20%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse 70% 70% at center, black 20%, transparent 75%)",
        }}
      />
    </motion.div>
  );
}

// ═══ Animated mesh gradient — living atmosphere ═══
function MeshGradient({ colors }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}>
      <motion.div
        animate={{ opacity: [0.6, 1, 0.6], scale: [1, 1.05, 1] }}
        transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
        style={{
          position: "absolute", inset: "-10%",
          background: colors.meshBg,
          filter: "blur(60px)",
        }}
      />
      {/* Slowly rotating accent glow */}
      <motion.div
        animate={{ rotate: [0, 360] }}
        transition={{ duration: 120, repeat: Infinity, ease: "linear" }}
        style={{
          position: "absolute", top: "20%", left: "30%",
          width: "60vw", height: "60vh",
          background: `radial-gradient(ellipse at 30% 40%, ${colors.accent1}, transparent 50%)`,
          filter: "blur(80px)",
          transformOrigin: "60% 50%",
        }}
      />
      <motion.div
        animate={{ rotate: [360, 0] }}
        transition={{ duration: 90, repeat: Infinity, ease: "linear" }}
        style={{
          position: "absolute", top: "10%", right: "10%",
          width: "50vw", height: "50vh",
          background: `radial-gradient(ellipse at 60% 50%, ${colors.accent2}, transparent 45%)`,
          filter: "blur(80px)",
          transformOrigin: "40% 60%",
        }}
      />
    </div>
  );
}

// ═══ Premium glass orbs — bokeh-like floating lights ═══
function GlassOrbs({ color }) {
  const orbs = useMemo(() =>
    Array.from({ length: 8 }, (_, i) => ({
      x: 10 + Math.random() * 80,
      y: 10 + Math.random() * 80,
      size: 60 + Math.random() * 120,
      delay: Math.random() * 6,
      dur: 18 + Math.random() * 14,
      driftX: (Math.random() - 0.5) * 30,
      driftY: (Math.random() - 0.5) * 25,
    })),
  []);

  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "hidden" }}>
      {orbs.map((o, i) => (
        <motion.div
          key={i}
          animate={{
            x: [0, o.driftX, o.driftX * -0.6, 0],
            y: [0, o.driftY, o.driftY * -0.5, 0],
            opacity: [0.3, 0.7, 0.4, 0.6, 0.3],
            scale: [1, 1.15, 0.9, 1.08, 1],
          }}
          transition={{
            duration: o.dur,
            delay: o.delay,
            repeat: Infinity,
            ease: "easeInOut",
          }}
          style={{
            position: "absolute",
            left: `${o.x}%`,
            top: `${o.y}%`,
            width: o.size,
            height: o.size,
            borderRadius: "50%",
            background: `radial-gradient(circle at 35% 35%, ${color}, transparent 70%)`,
            filter: "blur(30px)",
          }}
        />
      ))}
    </div>
  );
}

// ═══ Volumetric light rays ═══
function LightRays({ color }) {
  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "hidden" }}>
      <motion.div
        animate={{ opacity: [0.3, 0.8, 0.3], rotate: [-2, 2, -2] }}
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
        style={{
          position: "absolute",
          top: "-30%", left: "10%",
          width: "35vw", height: "160vh",
          background: `linear-gradient(180deg, ${color}, transparent 80%)`,
          filter: "blur(40px)",
          transformOrigin: "top center",
        }}
      />
      <motion.div
        animate={{ opacity: [0.2, 0.6, 0.2], rotate: [3, -1, 3] }}
        transition={{ duration: 25, repeat: Infinity, ease: "easeInOut", delay: 5 }}
        style={{
          position: "absolute",
          top: "-20%", right: "20%",
          width: "25vw", height: "140vh",
          background: `linear-gradient(180deg, ${color}, transparent 75%)`,
          filter: "blur(50px)",
          transformOrigin: "top center",
        }}
      />
    </div>
  );
}

// ═══ Premium floating dust motes ═══
function DustMotes({ color }) {
  const motes = useMemo(() =>
    Array.from({ length: 20 }, (_, i) => ({
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: 2 + Math.random() * 3,
      delay: Math.random() * 12,
      dur: 12 + Math.random() * 10,
      driftY: -30 - Math.random() * 40,
      driftX: (Math.random() - 0.5) * 20,
    })),
  []);

  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 1, overflow: "hidden" }}>
      {motes.map((m, i) => (
        <motion.div
          key={i}
          animate={{
            y: [0, m.driftY],
            x: [0, m.driftX],
            opacity: [0, 0.6, 0.8, 0.4, 0],
          }}
          transition={{ duration: m.dur, delay: m.delay, repeat: Infinity, ease: "easeInOut" }}
          style={{
            position: "absolute",
            left: `${m.x}%`,
            top: `${m.y}%`,
            width: m.size,
            height: m.size,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 ${m.size * 3}px ${color}`,
          }}
        />
      ))}
    </div>
  );
}

// ═══ Subtle grid overlay ═══
function GridOverlay({ color }) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1, pointerEvents: "none",
        opacity: 0.5,
        backgroundImage: `
          linear-gradient(${color} 1px, transparent 1px),
          linear-gradient(90deg, ${color} 1px, transparent 1px)
        `,
        backgroundSize: "48px 48px",
      }}
    />
  );
}

// ═══ Film noise texture — premium feel ═══
function NoiseOverlay({ opacity }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = 256;
    canvas.height = 256;

    const imageData = ctx.createImageData(256, 256);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.random() * 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 20;
    }
    ctx.putImageData(imageData, 0, 0);

    return () => {
      // Dispose canvas context to free GPU memory
      canvas.width = 0;
      canvas.height = 0;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed", inset: 0, zIndex: 2, pointerEvents: "none",
        width: "100%", height: "100%",
        opacity,
        mixBlendMode: "overlay",
        imageRendering: "pixelated",
      }}
    />
  );
}

// ═══ Starfield — twinkling stars for midnight mode ═══
function Starfield() {
  const canvasRef = useRef(null);

  useEffect(() => {
    // Skip animation entirely for users who prefer reduced motion
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    let w = window.innerWidth;
    let h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    function handleResize() {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Redistribute stars across new dimensions
      for (const s of stars) {
        s.x = Math.random() * w;
        s.y = Math.random() * h;
      }
    }
    window.addEventListener("resize", handleResize);

    // Generate stars with different layers
    const stars = [];
    // Tiny dim stars (background)
    for (let i = 0; i < 300; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.4 + Math.random() * 0.8,
        alpha: 0.5 + Math.random() * 0.5,
        twinkleSpeed: 0.003 + Math.random() * 0.008,
        twinkleOffset: Math.random() * Math.PI * 2,
        color: Math.random() > 0.7 ? [140, 190, 255] : Math.random() > 0.5 ? [200, 225, 255] : [255, 255, 255],
      });
    }
    // Medium stars
    for (let i = 0; i < 80; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 1 + Math.random() * 1.5,
        alpha: 0.6 + Math.random() * 0.4,
        twinkleSpeed: 0.005 + Math.random() * 0.012,
        twinkleOffset: Math.random() * Math.PI * 2,
        color: Math.random() > 0.6 ? [120, 175, 255] : Math.random() > 0.4 ? [180, 210, 255] : [255, 255, 255],
      });
    }
    // Bright accent stars (rare)
    for (let i = 0; i < 25; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 1.5 + Math.random() * 2,
        alpha: 0.8 + Math.random() * 0.2,
        twinkleSpeed: 0.008 + Math.random() * 0.015,
        twinkleOffset: Math.random() * Math.PI * 2,
        color: Math.random() > 0.5 ? [100, 160, 255] : [160, 210, 255],
        glow: true,
      });
    }

    // Shooting stars
    const shootingStars = [];
    let lastShootTime = 0;
    let nextShootInterval = 3000 + Math.random() * 8000;

    let raf;
    let paused = false;
    const onVisibility = () => {
      if (document.hidden) {
        paused = true;
        cancelAnimationFrame(raf);
      } else {
        paused = false;
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    function draw(t) {
      if (paused) return;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        const twinkle = Math.sin(t * s.twinkleSpeed + s.twinkleOffset);
        const a = Math.min(1, s.alpha * (0.6 + 0.4 * twinkle));
        if (a < 0.05) continue;

        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${s.color[0]}, ${s.color[1]}, ${s.color[2]}, ${a})`;
        ctx.fill();

        // Glow for bright stars
        if (s.glow && a > 0.3) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${s.color[0]}, ${s.color[1]}, ${s.color[2]}, ${a * 0.25})`;
          ctx.fill();
          // Outer glow
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 8, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${s.color[0]}, ${s.color[1]}, ${s.color[2]}, ${a * 0.08})`;
          ctx.fill();
        }
      }
      // Shooting stars
      if (t - lastShootTime > nextShootInterval) {
        lastShootTime = t;
        nextShootInterval = 3000 + Math.random() * 8000;
        shootingStars.push({
          x: Math.random() * w * 0.8,
          y: Math.random() * h * 0.3,
          vx: 3 + Math.random() * 4,
          vy: 1 + Math.random() * 2,
          life: 1,
          decay: 0.015 + Math.random() * 0.01,
          len: 40 + Math.random() * 60,
          color: [180, 210, 255],
        });
      }
      for (let i = shootingStars.length - 1; i >= 0; i--) {
        const ss = shootingStars[i];
        ss.x += ss.vx;
        ss.y += ss.vy;
        ss.life -= ss.decay;
        if (ss.life <= 0) { shootingStars.splice(i, 1); continue; }
        const grad = ctx.createLinearGradient(ss.x, ss.y, ss.x - ss.vx * ss.len / 4, ss.y - ss.vy * ss.len / 4);
        grad.addColorStop(0, `rgba(${ss.color[0]}, ${ss.color[1]}, ${ss.color[2]}, ${ss.life * 0.9})`);
        grad.addColorStop(1, `rgba(${ss.color[0]}, ${ss.color[1]}, ${ss.color[2]}, 0)`);
        ctx.beginPath();
        ctx.moveTo(ss.x, ss.y);
        ctx.lineTo(ss.x - ss.vx * ss.len / 4, ss.y - ss.vy * ss.len / 4);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // Bright head
        ctx.beginPath();
        ctx.arc(ss.x, ss.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${ss.life * 0.8})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", handleResize);
      // Dispose canvas context to free GPU memory
      canvas.width = 0;
      canvas.height = 0;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed", inset: 0, zIndex: 3, pointerEvents: "none",
        width: "100%", height: "100%",
      }}
    />
  );
}

// ═══ Aurora Borealis — northern lights for midnight mode ═══
function Aurora() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1, pointerEvents: "none", overflow: "hidden" }}>
      <motion.div
        animate={{
          x: [0, 30, -20, 10, 0],
          scaleX: [1, 1.2, 0.9, 1.1, 1],
          opacity: [0.3, 0.5, 0.35, 0.45, 0.3],
        }}
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
        style={{
          position: "absolute",
          top: "-15%",
          left: "5%",
          width: "90%",
          height: "35%",
          background: "linear-gradient(180deg, rgba(60, 180, 255, 0.06) 0%, rgba(100, 220, 180, 0.04) 30%, rgba(80, 140, 255, 0.03) 60%, transparent 100%)",
          filter: "blur(50px)",
          transformOrigin: "center top",
        }}
      />
      <motion.div
        animate={{
          x: [-15, 20, -30, 15, -15],
          scaleX: [1, 0.85, 1.15, 0.95, 1],
          opacity: [0.25, 0.4, 0.3, 0.5, 0.25],
        }}
        transition={{ duration: 25, repeat: Infinity, ease: "easeInOut", delay: 3 }}
        style={{
          position: "absolute",
          top: "-10%",
          left: "15%",
          width: "70%",
          height: "30%",
          background: "linear-gradient(180deg, rgba(120, 80, 255, 0.05) 0%, rgba(80, 200, 160, 0.04) 40%, rgba(60, 140, 220, 0.02) 70%, transparent 100%)",
          filter: "blur(60px)",
          transformOrigin: "center top",
        }}
      />
    </div>
  );
}

// ═══ Crescent Moon — midnight atmosphere ═══
function CrescentMoon() {
  return (
    <motion.div
      animate={{ y: [0, -5, 0], opacity: [0.6, 0.75, 0.6] }}
      transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
      style={{
        position: "fixed",
        top: "8%",
        right: "12%",
        width: 40,
        height: 40,
        borderRadius: "50%",
        background: "radial-gradient(circle at 65% 40%, transparent 40%, rgba(180, 210, 255, 0.7) 42%, rgba(180, 210, 255, 0.5) 50%, transparent 70%)",
        boxShadow: "0 0 30px rgba(150, 190, 255, 0.2), 0 0 60px rgba(150, 190, 255, 0.08)",
        zIndex: 3,
        pointerEvents: "none",
        filter: "blur(0.5px)",
      }}
    />
  );
}

// ═══ Vignette — cinematic edge darkening ═══
function Vignette() {
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 2, pointerEvents: "none",
        background: "radial-gradient(ellipse 75% 70% at center, transparent 40%, rgba(0,0,0,0.4) 100%)",
      }}
    />
  );
}

// ═══ Error Boundary ═══
class BackgroundErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err) { console.warn("Background error:", err); }
  render() { return this.state.hasError ? null : this.props.children; }
}

// ═══ Main Background ═══
export default memo(function Background() {
  const colors = useThemeColors();

  return (
    <BackgroundErrorBoundary>
      {/* Layer 0: Animated mesh gradient atmosphere */}
      <MeshGradient colors={colors} />

      {/* Layer 1: Volumetric light rays */}
      <LightRays color={colors.rayColor} />

      {/* Layer 2: Glass bokeh orbs */}
      <GlassOrbs color={colors.orbColor} />

      {/* Layer 3: Ghost art — barely visible images deeply embedded */}
      {BG_ART.map((art, i) => (
        <GhostArt key={i} art={art} opacity={colors.artOpacity} />
      ))}

      {/* Layer 4: Floating dust motes */}
      <DustMotes color={colors.dustColor} />

      {/* Layer 5: Subtle grid overlay */}
      <GridOverlay color={colors.gridColor} />

      {/* Layer 6: Film noise texture */}
      <NoiseOverlay opacity={colors.noiseOpacity} />

      {/* Layer 7: Starfield (Midnight only) */}
      {colors.showStars && <Starfield />}

      {/* Layer 7b: Aurora (Midnight only) */}
      {colors.showAurora && <Aurora />}

      {/* Layer 7c: Moon (Midnight only) */}
      {colors.showMoon && <CrescentMoon />}

      {/* Layer 8: Gold ambient glow (Sovereign only) */}
      {colors.goldGlow && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1, pointerEvents: "none" }}>
          {/* Corner gold pools */}
          <div style={{
            position: "absolute", top: "-5%", left: "-5%",
            width: "45%", height: "40%",
            background: "radial-gradient(ellipse at 30% 30%, rgba(200,170,100,0.07) 0%, transparent 65%)",
            filter: "blur(40px)",
          }} />
          <div style={{
            position: "absolute", bottom: "-5%", right: "-5%",
            width: "50%", height: "45%",
            background: "radial-gradient(ellipse at 70% 70%, rgba(200,170,100,0.06) 0%, transparent 60%)",
            filter: "blur(50px)",
          }} />
          {/* Subtle gold edge vignette */}
          <div style={{
            position: "absolute", inset: 0,
            boxShadow: "inset 0 0 200px rgba(200,170,100,0.04), inset 0 0 80px rgba(200,170,100,0.02)",
          }} />
        </div>
      )}

      {/* Layer 8: Cinematic vignette */}
      <Vignette />
    </BackgroundErrorBoundary>
  );
});
