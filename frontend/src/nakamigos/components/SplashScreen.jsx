import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { COLLECTIONS, DEFAULT_COLLECTION, LOADING_MESSAGES } from "../constants";

// ═══ Art pieces config — SPLASH ONLY (10 unique images, no overlap with background) ═══
const ART_PIECES = [
  { src: "/splash/watercolor.png", size: 420, pixel: false },
  { src: "/splash/HBbsuPEacAAX0VA.jpg", size: 400, pixel: false },
  { src: "/splash/G24BZRrakAA1M_9.jpg", size: 380, pixel: false },
  { src: "/splash/frogking.png", size: 320, pixel: true },
  { src: "/splash/skeleton.png", size: 220, pixel: true },
  { src: "/splash/G--r5iuXIAEPwLt.jpg", size: 380, pixel: false },
  { src: "/splash/G-FPcYdXMAAKsWR.jpg", size: 420, pixel: false },
  { src: "/splash/G8jE1EcWMAAvHTy.jpg", size: 360, pixel: false },
  { src: "/splash/HA5Fd6kWMAAMqL_.jpg", size: 340, pixel: false },
  { src: "/splash/HC6HNXsW4AA-UwM.jpg", size: 420, pixel: false },
];

// ═══ Nakamigo face formation positions (normalized 0-1) ═══
const FACE_FORMATION = [
  { x: 0.5, y: 0.22 },   // head top
  { x: 0.35, y: 0.38 },  // left eye
  { x: 0.65, y: 0.38 },  // right eye
  { x: 0.5, y: 0.52 },   // nose
  { x: 0.42, y: 0.65 },  // mouth left
  { x: 0.58, y: 0.65 },  // mouth right
  { x: 0.25, y: 0.45 },  // left ear
  { x: 0.75, y: 0.45 },  // right ear
  { x: 0.5, y: 0.82 },   // chin
];

// ═══ Physics simulation — the brain ═══
function usePhysics(pieces, containerRef, phase) {
  const bodiesRef = useRef(null);
  const rafRef = useRef(null);
  const mouseRef = useRef({ x: -9999, y: -9999 });
  const lastMouseMove = useRef(Date.now());
  const sparksRef = useRef([]);
  const [positions, setPositions] = useState([]);
  const [sparks, setSparks] = useState([]);
  const [shockwave, setShockwave] = useState(null);
  const [impactFlash, setImpactFlash] = useState(0);
  const [mousePos, setMousePos] = useState({ x: -9999, y: -9999 });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const initBodies = useCallback((w, h) => {
    const bodies = [];
    const count = pieces.length;

    // Pre-defined scatter zones to ensure even distribution across viewport
    // Each zone is a region where one image spawns, with jitter
    const zones = [
      { cx: 0.08, cy: 0.15 },  // top-left
      { cx: 0.92, cy: 0.12 },  // top-right
      { cx: 0.25, cy: 0.45 },  // mid-left
      { cx: 0.75, cy: 0.40 },  // mid-right
      { cx: 0.10, cy: 0.75 },  // bottom-left
      { cx: 0.88, cy: 0.80 },  // bottom-right
      { cx: 0.50, cy: 0.20 },  // top-center
      { cx: 0.45, cy: 0.70 },  // bottom-center
      { cx: 0.35, cy: 0.88 },  // lower-left
      { cx: 0.65, cy: 0.55 },  // center-right
    ];

    for (let i = 0; i < count; i++) {
      const size = pieces[i].size;
      const radius = size / 2;
      const zone = zones[i % zones.length];
      // Add jitter within zone (±8% of viewport)
      const jitterX = (Math.random() - 0.5) * 0.16;
      const jitterY = (Math.random() - 0.5) * 0.16;
      const x = Math.max(radius, Math.min(w - radius, (zone.cx + jitterX) * w));
      const y = Math.max(radius, Math.min(h - radius, (zone.cy + jitterY) * h));

      const angle = Math.random() * Math.PI * 2;
      const speed = 0.3 + Math.random() * 0.5;
      bodies.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius, size,
        rot: -15 + Math.random() * 30,
        rotV: (-0.3 + Math.random() * 0.6) * 0.3,
        glowPulse: Math.random() * Math.PI * 2,
        trail: [],
        glitch: 0,
        breathPhase: Math.random() * Math.PI * 2,
        holoPhase: Math.random() * Math.PI * 2,
        speed: 0,
      });
    }
    return bodies;
  }, [pieces]);

  // Mouse tracking
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onMove = (e) => {
      const rect = container.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      lastMouseMove.current = Date.now();
    };
    container.addEventListener("mousemove", onMove);
    return () => container.removeEventListener("mousemove", onMove);
  }, [containerRef]);

  // Shockwave on click
  const triggerShockwave = useCallback((e) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    setShockwave({ x: sx, y: sy, id: Date.now() });
    const bodies = bodiesRef.current;
    if (!bodies) return;
    for (const b of bodies) {
      const dx = b.x - sx;
      const dy = b.y - sy;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 50);
      const force = Math.min(800 / dist, 8);
      b.vx += (dx / dist) * force;
      b.vy += (dy / dist) * force;
      b.rotV += (Math.random() - 0.5) * 2;
    }
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("mousedown", triggerShockwave);
    return () => container.removeEventListener("mousedown", triggerShockwave);
  }, [containerRef, triggerShockwave]);

  // Bass drop: pull all images to center
  useEffect(() => {
    if (phase !== "reveal") return;
    const bodies = bodiesRef.current;
    const container = containerRef.current;
    if (!bodies || !container) return;
    const rect = container.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    for (const b of bodies) {
      const dx = cx - b.x;
      const dy = cy - b.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      b.vx = (dx / dist) * 12;
      b.vy = (dy / dist) * 12;
      b.rotV = (Math.random() - 0.5) * 8;
    }
  }, [phase, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    bodiesRef.current = initBodies(rect.width, rect.height);
    setPositions(bodiesRef.current.map(b => ({
      x: b.x, y: b.y, rot: b.rot, glow: 0, glitch: 0, trail: [],
      breath: 1, holo: 0, speed: 0, tiltX: 0, tiltY: 0,
    })));

    let lastTime = performance.now();
    let sparkId = 0;
    let flashDecay = 0;
    let paused = false;

    const onVisibility = () => {
      if (document.hidden) {
        paused = true;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      } else {
        paused = false;
        lastTime = performance.now();
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const tick = (now) => {
      if (paused) return;
      const dt = Math.min((now - lastTime) / 16, 3);
      lastTime = now;
      const bodies = bodiesRef.current;
      if (!bodies) return;
      const w = rect.width;
      const h = rect.height;
      const mouse = mouseRef.current;
      const isIdle = Date.now() - lastMouseMove.current > 5000;
      const currentPhase = phaseRef.current;

      // ═══ IDLE: Nakamigo face formation ═══
      if (isIdle && currentPhase !== "reveal") {
        for (let i = 0; i < bodies.length; i++) {
          const target = FACE_FORMATION[i];
          if (!target) continue;
          const tx = target.x * w;
          const ty = target.y * h;
          const dx = tx - bodies[i].x;
          const dy = ty - bodies[i].y;
          bodies[i].vx += dx * 0.002 * dt;
          bodies[i].vy += dy * 0.002 * dt;
          bodies[i].vx *= 0.97;
          bodies[i].vy *= 0.97;
          bodies[i].rotV *= 0.95;
        }
      }

      // ═══ Mouse repulsion + glitch proximity + depth of field ═══
      const mouseRadius = 200;
      const mouseForce = 0.15;
      const glitchRadius = 250;
      for (const b of bodies) {
        const dx = b.x - mouse.x;
        const dy = b.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < mouseRadius && dist > 0 && !isIdle) {
          const strength = (1 - dist / mouseRadius) * mouseForce * dt;
          b.vx += (dx / dist) * strength;
          b.vy += (dy / dist) * strength;
        }
        const edgeDist = dist - b.radius;
        b.glitch = edgeDist < glitchRadius && edgeDist > -b.radius
          ? Math.max(0, 1 - edgeDist / glitchRadius) : 0;
        b.mouseDist = dist;
      }

      // ═══ Update positions, trail, breathing, holo ═══
      for (const b of bodies) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.rot += b.rotV * dt;
        b.glowPulse += 0.02 * dt;
        b.breathPhase += 0.015 * dt;
        b.holoPhase += 0.03 * dt;
        b.vx *= 0.999;
        b.vy *= 0.999;
        b.rotV *= 0.998;
        b.speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        // Reduced trail for performance (3 instead of 6)
        b.trail.push({ x: b.x, y: b.y, rot: b.rot, t: now });
        if (b.trail.length > 3) b.trail.shift();
      }

      // ═══ Wall bounces ═══
      for (const b of bodies) {
        if (b.x - b.radius < 0) { b.x = b.radius; b.vx = Math.abs(b.vx); b.rotV *= -0.8; }
        if (b.x + b.radius > w) { b.x = w - b.radius; b.vx = -Math.abs(b.vx); b.rotV *= -0.8; }
        if (b.y - b.radius < 0) { b.y = b.radius; b.vy = Math.abs(b.vy); b.rotV *= -0.8; }
        if (b.y + b.radius > h) { b.y = h - b.radius; b.vy = -Math.abs(b.vy); b.rotV *= -0.8; }
      }

      // ═══ Collisions with sparks + impact flash ═══
      const newSparks = [];
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = bodies[i];
          const b = bodies[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = a.radius + b.radius;
          if (dist < minDist && dist > 0) {
            const nx = dx / dist;
            const ny = dy / dist;
            const overlap = minDist - dist;
            a.x -= nx * overlap * 0.5;
            a.y -= ny * overlap * 0.5;
            b.x += nx * overlap * 0.5;
            b.y += ny * overlap * 0.5;
            const dvx = a.vx - b.vx;
            const dvy = a.vy - b.vy;
            const dot = dvx * nx + dvy * ny;
            if (dot > 0) {
              const restitution = 0.85;
              a.vx -= dot * nx * restitution;
              a.vy -= dot * ny * restitution;
              b.vx += dot * nx * restitution;
              b.vy += dot * ny * restitution;
              a.rotV += (Math.random() - 0.5) * 0.5;
              b.rotV += (Math.random() - 0.5) * 0.5;
              a.glowPulse = 0;
              b.glowPulse = 0;
              const impactX = (a.x + b.x) / 2;
              const impactY = (a.y + b.y) / 2;
              const speed = Math.sqrt(dvx * dvx + dvy * dvy);
              // Impact flash for hard hits
              if (speed > 2) flashDecay = Math.min(speed * 0.15, 0.6);
              const count = Math.min(Math.floor(speed * 2) + 2, 6);
              for (let s = 0; s < count; s++) {
                const ang = Math.random() * Math.PI * 2;
                const spd = 1 + Math.random() * 4 * Math.min(speed, 3);
                newSparks.push({
                  id: sparkId++, x: impactX, y: impactY,
                  vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
                  life: 1, size: 2 + Math.random() * 4,
                });
              }
            }
          }
        }
      }

      // ═══ Update sparks ═══
      const activeSparks = sparksRef.current;
      // Cap total sparks for performance
      if (activeSparks.length + newSparks.length < 80) {
        activeSparks.push(...newSparks);
      }
      for (let i = activeSparks.length - 1; i >= 0; i--) {
        const s = activeSparks[i];
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += 0.05 * dt;
        s.life -= 0.025 * dt;
        if (s.life <= 0) activeSparks.splice(i, 1);
      }
      sparksRef.current = activeSparks;

      // ═══ Impact flash decay ═══
      flashDecay *= 0.92;
      if (flashDecay < 0.01) flashDecay = 0;

      // ═══ Batched state update — single setState to avoid multiple re-renders per frame ═══
      const nextPositions = new Array(bodies.length);
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        nextPositions[i] = {
          x: b.x, y: b.y, rot: b.rot,
          glow: Math.sin(b.glowPulse) * 0.5 + 0.5,
          glitch: b.glitch || 0,
          trail: b.trail.slice(),
          breath: 1 + Math.sin(b.breathPhase) * 0.025,
          holo: (Math.sin(b.holoPhase) * 0.5 + 0.5),
          speed: b.speed,
          tiltX: b.vy * 3,
          tiltY: -b.vx * 3,
          mouseDist: b.mouseDist || 9999,
        };
      }
      setPositions(nextPositions);
      setSparks(activeSparks.length > 0 ? activeSparks.slice() : []);
      setImpactFlash(flashDecay);
      setMousePos(mouse);

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [containerRef, initBodies]);

  return { positions, sparks, shockwave, impactFlash, mousePos };
}

// ═══ Pixel dust particles ═══
const DUST_COLORS = [
  // Cyans
  "#00ffff", "#44ddff", "#22eeff", "#66ffff", "#00ffcc",
  // Golds
  "#c8a850", "#e8c860", "#ffd700", "#daa520", "#f0c040",
  // Magentas / pinks
  "#ff44aa", "#ff66cc", "#cc44ff", "#ff88dd", "#ee55bb",
  // Greens
  "#44ff88", "#00ff66", "#22ffaa", "#66ffaa",
  // Warm oranges
  "#ff8844", "#ffaa33", "#ff6622",
  // Purples
  "#8866ff", "#aa44ff", "#7744ee",
  // Whites
  "#ffffff", "#ddeeff", "#eeeeff",
];

function PixelDust({ count = 60 }) {
  const particles = useRef(
    Array.from({ length: count }, () => {
      const color = DUST_COLORS[Math.floor(Math.random() * DUST_COLORS.length)];
      const size = 1 + Math.floor(Math.random() * 5);
      return {
        x: Math.random() * 100, y: Math.random() * 100,
        size,
        color,
        duration: 3 + Math.random() * 9, delay: Math.random() * 8,
        driftX: -25 + Math.random() * 50, driftY: -35 + Math.random() * -15,
        peakOpacity: 0.4 + Math.random() * 0.6,
        peakScale: 1 + Math.random() * 1.5,
      };
    })
  ).current;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 8 }}>
      {particles.map((p, i) => (
        <motion.div key={i}
          initial={{ opacity: 0, x: 0, y: 0 }}
          animate={{ opacity: [0, p.peakOpacity, 0], x: p.driftX, y: p.driftY, scale: [0, p.peakScale, 0] }}
          transition={{ duration: p.duration, delay: p.delay, repeat: Infinity, ease: "easeOut" }}
          style={{
            position: "absolute", left: `${p.x}%`, top: `${p.y}%`,
            width: p.size, height: p.size, background: p.color,
            boxShadow: `0 0 ${p.size * 4}px ${p.color}88`, imageRendering: "pixelated",
          }}
        />
      ))}
    </div>
  );
}

// ═══ Particle Canvas — luxury golden energy motes ═══
function ParticleCanvas() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    function resize() {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      // Reset transform before scaling — setting canvas.width clears it,
      // but be explicit to avoid accumulation if browser behavior varies
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    const w = () => window.innerWidth;
    const h = () => window.innerHeight;

    // Luxury color palette for particles
    const COLORS = [
      [200, 170, 100],  // gold
      [230, 200, 130],  // champagne
      [180, 100, 255],  // amethyst
      [111, 168, 220],  // sapphire
      [220, 100, 160],  // rose
      [255, 220, 180],  // warm white
      [160, 130, 100],  // bronze
    ];

    const particles = Array.from({ length: 50 }, () => ({
      x: Math.random() * w(),
      y: Math.random() * h(),
      vx: (Math.random() - 0.5) * 0.3,
      vy: -0.2 - Math.random() * 0.5,
      size: 1 + Math.random() * 2.5,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      alpha: 0.2 + Math.random() * 0.6,
      life: Math.random(),
      lifeSpeed: 0.002 + Math.random() * 0.004,
      twinkle: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.02 + Math.random() * 0.04,
    }));

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

    function draw() {
      if (paused) return;
      ctx.clearRect(0, 0, w(), h());

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.life += p.lifeSpeed;
        p.twinkle += p.twinkleSpeed;

        if (p.y < -10 || p.life > 1) {
          p.x = Math.random() * w();
          p.y = h() + 10;
          p.life = 0;
        }

        const fade = Math.sin(p.life * Math.PI);
        const twinkle = 0.5 + 0.5 * Math.sin(p.twinkle);
        const a = p.alpha * fade * twinkle;
        if (a < 0.02) continue;

        const [r, g, b] = p.color;

        // Glow
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.15})`;
        ctx.fill();

        // Core
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", resize);
      // Dispose canvas context to free GPU memory
      canvas.width = 0;
      canvas.height = 0;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none",
        width: "100%", height: "100%",
      }}
    />
  );
}

// ═══ Bokeh background orbs ═══
function BokehOrbs({ count = 12 }) {
  const orbs = useRef(
    Array.from({ length: count }, () => ({
      x: Math.random() * 100, y: Math.random() * 100,
      size: 40 + Math.random() * 120,
      color: ["rgba(0,255,255,0.04)", "rgba(100,200,255,0.03)", "rgba(255,100,255,0.03)", "rgba(0,255,200,0.04)"][Math.floor(Math.random() * 4)],
      duration: 15 + Math.random() * 20, delay: Math.random() * 10,
      driftX: -30 + Math.random() * 60, driftY: -20 + Math.random() * 40,
    }))
  ).current;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 1 }}>
      {orbs.map((o, i) => (
        <motion.div key={i}
          animate={{ x: [0, o.driftX, -o.driftX * 0.5, 0], y: [0, o.driftY, -o.driftY * 0.7, 0], opacity: [0.3, 0.7, 0.3] }}
          transition={{ duration: o.duration, delay: o.delay, repeat: Infinity, ease: "easeInOut" }}
          style={{
            position: "absolute", left: `${o.x}%`, top: `${o.y}%`,
            width: o.size, height: o.size, borderRadius: "50%",
            background: o.color, filter: "blur(30px)",
          }}
        />
      ))}
    </div>
  );
}

// ═══ Film grain overlay ═══
function FilmGrain() {
  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 11, pointerEvents: "none",
      opacity: 0.06, mixBlendMode: "overlay",
      backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
      backgroundSize: "128px 128px",
      animation: "grain 0.5s steps(4) infinite",
    }} />
  );
}

// ═══ Pixel grid overlay ═══
function PixelOverlay() {
  return (
    <>
      <motion.div
        animate={{ opacity: [0.03, 0.07, 0.03] }}
        transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
        style={{
          position: "absolute", inset: 0, zIndex: 6, pointerEvents: "none",
          backgroundImage: `linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)`,
          backgroundSize: "6px 6px", imageRendering: "pixelated",
        }}
      />
      <div style={{
        position: "absolute", inset: 0, zIndex: 7, pointerEvents: "none",
        background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)",
        imageRendering: "pixelated",
      }} />
    </>
  );
}

// ═══ Shockwave ring ═══
function ShockwaveEffect({ shockwave }) {
  if (!shockwave) return null;
  return (
    <motion.div key={shockwave.id}
      initial={{ scale: 0, opacity: 0.8 }}
      animate={{ scale: 8, opacity: 0 }}
      transition={{ duration: 0.7, ease: "easeOut" }}
      style={{
        position: "absolute", left: shockwave.x - 50, top: shockwave.y - 50,
        width: 100, height: 100, borderRadius: "50%",
        border: "2px solid rgba(0,255,255,0.6)",
        boxShadow: "0 0 30px rgba(0,255,255,0.3), inset 0 0 30px rgba(0,255,255,0.1)",
        zIndex: 9, pointerEvents: "none",
      }}
    />
  );
}

// ═══ Main Splash Screen ═══
export default function SplashScreen({ onComplete }) {
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("loading");
  const [showContent, setShowContent] = useState(false);
  const containerRef = useRef(null);
  const { positions, sparks, shockwave, impactFlash, mousePos } = usePhysics(ART_PIECES, containerRef, phase);

  useEffect(() => {
    const t = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const start = Date.now();
    const TOTAL_DURATION = 4000; // 4 seconds total splash
    const iv = setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.min((elapsed / TOTAL_DURATION) * 100, 100);
      setProgress(pct);
      if (pct >= 100) clearInterval(iv);
    }, 30);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (progress >= 100 && phase === "loading") {
      setTimeout(() => setPhase("ready"), 400);
    }
  }, [progress, phase]);

  // Safety timeout — force ready after 8 seconds no matter what
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (phase === "loading") {
        setProgress(100);
        setPhase("ready");
      }
    }, 8000);
    return () => clearTimeout(timeout);
  }, [phase]);

  const [exitPhase, setExitPhase] = useState("none"); // none | glitch | cover | flash | collapse
  const [clickPos, setClickPos] = useState({ x: "50%", y: "50%" });

  const handleEnter = (e) => {
    if (phase !== "ready") return;
    // Capture click position for shockwave origin
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && e) {
      setClickPos({ x: `${e.clientX}px`, y: `${e.clientY}px` });
    }
    setPhase("reveal");

    // Glitch phase — CSS animation on the container
    setExitPhase("glitch");
    setTimeout(() => {
      // Flash phase — brief white/gold burst before blocks
      setExitPhase("flash");
      setTimeout(() => {
        // Cover phase — dark blocks sweep in
        setExitPhase("cover");
        // CRT collapse after blocks cover
        setTimeout(() => {
          setExitPhase("collapse");
          setTimeout(() => onComplete(), 400);
        }, 1200);
      }, 150);
    }, 900);
  };

  // Generate dark blocks for the cover phase
  const renderExitBlocks = () => {
    const COLS = 12;
    const ROWS = 10;
    const blocks = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const w = 100 / COLS;
        const h = 100 / ROWS;
        // Radial stagger from center for more dramatic implosion feel
        const cx = (c - COLS / 2) / (COLS / 2);
        const cy = (r - ROWS / 2) / (ROWS / 2);
        const radialDist = Math.sqrt(cx * cx + cy * cy) / 1.414;
        // Mix diagonal + radial for organic feel
        const diagDist = (r + c) / (ROWS + COLS - 2);
        const dist = diagDist * 0.6 + radialDist * 0.4;
        const delay = dist * 700;
        const dur = 500;
        // Subtle color variation per block
        const hue = Math.floor(180 + (r * COLS + c) * 3) % 360;
        const glowColor = `hsla(${hue}, 80%, 50%, 0.12)`;

        blocks.push(
          <div
            key={`${r}-${c}`}
            style={{
              position: "absolute",
              left: `${c * w}%`,
              top: `${r * h}%`,
              width: `${w}%`,
              height: `${h}%`,
              background: `linear-gradient(135deg, rgba(5,5,10,0.99), rgba(10,8,20,0.97))`,
              borderRight: `1px solid ${glowColor}`,
              borderBottom: `1px solid ${glowColor}`,
              boxShadow: `inset 0 0 8px rgba(0,255,255,0.03), 0 0 4px ${glowColor}`,
              opacity: 0,
              zIndex: 100,
              animation: `splashBlockCover ${dur}ms ${delay}ms cubic-bezier(0.22, 0.68, 0.36, 1) forwards`,
            }}
          />
        );
      }
    }
    return blocks;
  };

  return (
    <div
      ref={containerRef}
      className={exitPhase === "glitch" ? "splash-glitch" : ""}
      style={{ position: "fixed", inset: 0, zIndex: 9999, overflow: "hidden", cursor: phase === "ready" ? "pointer" : "default" }}
      onClick={handleEnter}
    >
      {/* Shockwave ripple from click point */}
      {(exitPhase === "glitch" || exitPhase === "flash") && (
        <div style={{
          position: "absolute", zIndex: 103, pointerEvents: "none",
          left: clickPos.x, top: clickPos.y,
          width: 0, height: 0,
          borderRadius: "50%",
          transform: "translate(-50%, -50%)",
          boxShadow: "0 0 0 0 rgba(200,168,80,0.6), 0 0 0 0 rgba(0,255,255,0.3)",
          animation: "splashShockwave 900ms cubic-bezier(0.22, 0.68, 0.36, 1) forwards",
        }} />
      )}

      {/* Exit transition: RGB split ghost layers during glitch */}
      {exitPhase === "glitch" && (
        <>
          <div style={{
            position: "absolute", inset: 0, zIndex: 99, pointerEvents: "none",
            mixBlendMode: "screen",
            boxShadow: "inset 0 0 150px rgba(255,0,50,0.2)",
            animation: "splashRGBRed 900ms steps(8) forwards",
          }} />
          <div style={{
            position: "absolute", inset: 0, zIndex: 99, pointerEvents: "none",
            mixBlendMode: "screen",
            boxShadow: "inset 0 0 150px rgba(0,100,255,0.2)",
            animation: "splashRGBBlue 900ms steps(8) forwards",
          }} />
          {/* Green channel offset */}
          <div style={{
            position: "absolute", inset: 0, zIndex: 99, pointerEvents: "none",
            mixBlendMode: "screen",
            boxShadow: "inset 0 0 100px rgba(0,255,100,0.1)",
            animation: "splashRGBGreen 900ms steps(8) forwards",
          }} />
          {/* Horizontal noise lines — thicker CRT scanlines */}
          <div style={{
            position: "absolute", inset: 0, zIndex: 98, pointerEvents: "none",
            background: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(255,255,255,0.04) 3px, rgba(255,255,255,0.04) 4px)",
            animation: "splashNoise 900ms linear forwards",
          }} />
          {/* Edge chromatic glow */}
          <div style={{
            position: "absolute", inset: 0, zIndex: 97, pointerEvents: "none",
            boxShadow: "inset 8px 0 25px rgba(255,0,80,0.15), inset -8px 0 25px rgba(0,150,255,0.15), inset 0 6px 20px rgba(0,255,200,0.08), inset 0 -6px 20px rgba(200,168,80,0.1)",
            animation: "splashEdgeGlow 900ms ease-in-out forwards",
          }} />
          {/* Afterimage echoes — 3 fading ghost duplicates */}
          {[0.15, 0.3, 0.45].map((d, i) => (
            <div key={`echo-${i}`} style={{
              position: "absolute", inset: 0, zIndex: 96 - i, pointerEvents: "none",
              border: `1px solid rgba(0,255,255,${0.08 - i * 0.02})`,
              animation: `splashEcho${i} 900ms ${d * 900}ms ease-out forwards`,
              opacity: 0,
            }} />
          ))}
        </>
      )}

      {/* Flash burst between glitch and cover — more intense */}
      {exitPhase === "flash" && (
        <>
          <div style={{
            position: "absolute", inset: 0, zIndex: 102, pointerEvents: "none",
            background: `radial-gradient(circle at ${clickPos.x} ${clickPos.y}, rgba(255,255,255,0.7) 0%, rgba(200,168,80,0.5) 20%, rgba(0,255,255,0.2) 50%, transparent 70%)`,
            animation: "splashFlashBurst 150ms ease-out forwards",
          }} />
          {/* Screen-wide horizontal line flash */}
          <div style={{
            position: "absolute", left: 0, right: 0, height: "3px", top: "50%",
            zIndex: 103, pointerEvents: "none",
            background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.9), transparent)",
            animation: "splashHLineFlash 150ms ease-out forwards",
          }} />
        </>
      )}

      {/* Exit transition: dark blocks sweep in */}
      {(exitPhase === "cover" || exitPhase === "collapse") && renderExitBlocks()}
      {(exitPhase === "cover" || exitPhase === "collapse") && (
        <>
          {/* Triple scanline — gold + white + cyan */}
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, height: 5,
            background: "linear-gradient(90deg, transparent 0%, #c8a850 15%, #fff 50%, #6fa8dc 85%, transparent 100%)",
            zIndex: 101, pointerEvents: "none",
            filter: "blur(1px) brightness(1.5)",
            animation: "splashScanline 1.3s ease-in-out forwards",
          }} />
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, height: 2,
            background: "linear-gradient(90deg, transparent 0%, rgba(0,255,255,0.8) 30%, rgba(200,168,80,0.6) 70%, transparent 100%)",
            zIndex: 101, pointerEvents: "none",
            animation: "splashScanline2 1.3s 0.12s ease-in-out forwards",
          }} />
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, height: 1,
            background: "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.5) 40%, rgba(255,255,255,0.5) 60%, transparent 100%)",
            zIndex: 101, pointerEvents: "none",
            animation: "splashScanline2 1.3s 0.25s ease-in-out forwards",
          }} />
          {/* Vignette darken during cover */}
          <div style={{
            position: "absolute", inset: 0, zIndex: 99, pointerEvents: "none",
            background: "radial-gradient(ellipse at center, transparent 20%, rgba(0,0,0,0.5) 100%)",
            animation: "splashVignette 1.2s ease-in forwards",
          }} />
        </>
      )}

      {/* CRT power-down collapse */}
      {exitPhase === "collapse" && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 110, pointerEvents: "none",
          background: "black",
          animation: "splashCRTCollapse 400ms cubic-bezier(0.4, 0, 1, 1) forwards",
        }}>
          {/* Final bright line */}
          <div style={{
            position: "absolute", left: "10%", right: "10%", top: "50%",
            height: "2px", transform: "translateY(-50%)",
            background: "linear-gradient(90deg, transparent, rgba(200,168,80,0.8), #fff, rgba(0,255,255,0.8), transparent)",
            filter: "blur(1px)",
            animation: "splashCRTLine 400ms ease-out forwards",
          }} />
        </div>
      )}

      {/* Keyframes for exit transition */}
      <style>{`
        @keyframes splashBlockCover {
          0%   { opacity: 0; transform: scale(1.3) rotate(3deg); filter: brightness(3); }
          20%  { opacity: 0.6; filter: brightness(1.8); }
          40%  { opacity: 0.9; filter: brightness(1.2); }
          70%  { opacity: 1; transform: scale(0.98); filter: brightness(1); }
          85%  { transform: scale(1.01); }
          100% { opacity: 1; transform: none; filter: none; }
        }
        @keyframes splashShockwave {
          0%   { width: 0; height: 0; box-shadow: 0 0 0 2px rgba(200,168,80,0.8), 0 0 30px 4px rgba(0,255,255,0.4); }
          50%  { width: 250vmax; height: 250vmax; box-shadow: 0 0 0 3px rgba(200,168,80,0.3), 0 0 60px 8px rgba(0,255,255,0.15); }
          100% { width: 300vmax; height: 300vmax; box-shadow: 0 0 0 1px rgba(200,168,80,0), 0 0 0 0 rgba(0,255,255,0); }
        }
        @keyframes splashScanline {
          0%   { top: -2%; opacity: 1; }
          100% { top: 102%; opacity: 0.4; }
        }
        @keyframes splashScanline2 {
          0%   { top: -2%; opacity: 0.8; }
          100% { top: 102%; opacity: 0; }
        }
        @keyframes splashFlashBurst {
          0%   { opacity: 1; transform: scale(0.95); }
          50%  { opacity: 0.8; transform: scale(1.05); }
          100% { opacity: 0; transform: scale(1.15); }
        }
        @keyframes splashHLineFlash {
          0%   { opacity: 1; transform: translateY(-50%) scaleY(1); }
          50%  { opacity: 0.8; transform: translateY(-50%) scaleY(8); }
          100% { opacity: 0; transform: translateY(-50%) scaleY(0.5); }
        }
        @keyframes splashRGBRed {
          0%, 100% { transform: none; opacity: 0; }
          10% { transform: translate(15px, -5px) skewX(-1deg); opacity: 1; }
          25% { transform: translate(-10px, 8px) skewX(2deg); opacity: 0.8; }
          40% { transform: translate(18px, 3px); opacity: 1; }
          55% { transform: translate(-12px, -10px) skewX(-1deg); opacity: 0.9; }
          70% { transform: translate(8px, 6px); opacity: 0.6; }
          85% { transform: translate(-6px, -4px) skewX(1deg); opacity: 0.4; }
        }
        @keyframes splashRGBBlue {
          0%, 100% { transform: none; opacity: 0; }
          10% { transform: translate(-12px, 6px) skewX(1deg); opacity: 1; }
          25% { transform: translate(14px, -4px) skewX(-2deg); opacity: 0.9; }
          40% { transform: translate(-16px, -5px); opacity: 1; }
          55% { transform: translate(10px, 9px) skewX(1deg); opacity: 0.8; }
          70% { transform: translate(-7px, -7px); opacity: 0.7; }
          85% { transform: translate(5px, 4px) skewX(-1deg); opacity: 0.5; }
        }
        @keyframes splashRGBGreen {
          0%, 100% { transform: none; opacity: 0; }
          12% { transform: translate(5px, 10px); opacity: 0.8; }
          30% { transform: translate(-8px, -6px) skewY(1deg); opacity: 0.6; }
          48% { transform: translate(12px, -3px); opacity: 0.9; }
          65% { transform: translate(-6px, 7px) skewY(-1deg); opacity: 0.5; }
          80% { transform: translate(4px, -5px); opacity: 0.3; }
        }
        @keyframes splashNoise {
          0%   { opacity: 0; }
          10%  { opacity: 0.9; }
          50%  { opacity: 0.7; }
          90%  { opacity: 0.8; }
          100% { opacity: 0; }
        }
        @keyframes splashEdgeGlow {
          0%   { opacity: 0; }
          20%  { opacity: 1; }
          80%  { opacity: 0.8; }
          100% { opacity: 0; }
        }
        @keyframes splashEcho0 {
          0%   { opacity: 0; transform: scale(1); }
          30%  { opacity: 0.15; transform: scale(1.02) translate(6px, -4px); }
          100% { opacity: 0; transform: scale(1.06) translate(12px, -8px); }
        }
        @keyframes splashEcho1 {
          0%   { opacity: 0; transform: scale(1); }
          30%  { opacity: 0.1; transform: scale(0.98) translate(-8px, 5px); }
          100% { opacity: 0; transform: scale(0.94) translate(-15px, 10px); }
        }
        @keyframes splashEcho2 {
          0%   { opacity: 0; transform: scale(1); }
          30%  { opacity: 0.08; transform: scale(1.01) translate(4px, 6px); }
          100% { opacity: 0; transform: scale(1.04) translate(8px, 12px); }
        }
        @keyframes splashVignette {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }
        @keyframes splashCRTCollapse {
          0%   { clip-path: inset(0 0 0 0); opacity: 0.95; }
          40%  { clip-path: inset(35% 0 35% 0); opacity: 1; }
          70%  { clip-path: inset(48% 5% 48% 5%); opacity: 1; }
          90%  { clip-path: inset(49.5% 15% 49.5% 15%); opacity: 0.9; }
          100% { clip-path: inset(50% 50% 50% 50%); opacity: 0; }
        }
        @keyframes splashCRTLine {
          0%   { opacity: 1; width: 80%; left: 10%; filter: blur(1px) brightness(2); }
          50%  { opacity: 0.8; width: 50%; left: 25%; filter: blur(0.5px) brightness(1.5); }
          100% { opacity: 0; width: 0; left: 50%; filter: blur(0) brightness(1); }
        }
        .splash-glitch {
          animation: splashGlitch 900ms steps(12) forwards;
        }
        @keyframes splashGlitch {
          0%   { filter: none; transform: none; }
          6%   { filter: saturate(6) hue-rotate(30deg) brightness(1.5); transform: translate(15px, -5px) skewX(-3deg) scale(1.02); }
          12%  { filter: saturate(0.1) hue-rotate(-40deg) brightness(2); transform: translate(-18px, 7px) skewX(4deg) scale(0.98); }
          18%  { filter: saturate(8) hue-rotate(60deg) contrast(2); transform: translate(10px, 4px) skewX(-2deg) scale(1.03); }
          24%  { filter: invert(0.2) hue-rotate(-50deg) brightness(0.5); transform: translate(-14px, -8px) skewY(2deg); }
          30%  { filter: saturate(4) hue-rotate(70deg) brightness(1.7) contrast(1.4); transform: translate(20px, -3px) skewX(3deg) scale(1.01); }
          36%  { filter: saturate(0.05) brightness(2.5) contrast(0.3); transform: translate(-8px, 10px) skewX(-4deg); }
          42%  { filter: hue-rotate(-60deg) brightness(0.3) saturate(7); transform: translate(12px, -6px) skewX(2deg) scale(0.97); }
          48%  { filter: saturate(5) hue-rotate(80deg) brightness(1.6); transform: translate(-16px, 5px) skewY(-2deg) scale(1.04); }
          54%  { filter: invert(0.25) saturate(3) brightness(0.7); transform: translate(10px, -10px) skewX(-3deg); }
          60%  { filter: hue-rotate(50deg) brightness(2) saturate(8); transform: translate(-12px, 3px) scale(1.02); }
          70%  { filter: saturate(0.2) brightness(2.5) contrast(0.3); transform: translate(8px, -4px) skewX(2deg); }
          80%  { filter: hue-rotate(-30deg) saturate(6) brightness(1.4); transform: translate(-6px, 6px) scale(0.99); }
          90%  { filter: invert(0.1) brightness(2) saturate(2); transform: translate(4px, -2px) skewX(-1deg) scale(1.01); }
          100% { filter: brightness(2) saturate(0.5); transform: scale(1.03); }
        }
        @keyframes splashAurora1 {
          0%, 100% { transform: translateX(0) translateY(0) scale(1); opacity: 0.6; }
          33% { transform: translateX(5%) translateY(-3%) scale(1.1); opacity: 1; }
          66% { transform: translateX(-3%) translateY(2%) scale(0.95); opacity: 0.7; }
        }
        @keyframes splashAurora2 {
          0%, 100% { transform: translateX(0) translateY(0) scale(1); opacity: 0.5; }
          50% { transform: translateX(-4%) translateY(-2%) scale(1.08); opacity: 0.9; }
        }
        @keyframes splashAurora3 {
          0%, 100% { transform: scale(1) rotate(0deg); opacity: 0.4; }
          50% { transform: scale(1.15) rotate(3deg); opacity: 0.8; }
        }
        @keyframes splashTypewriter {
          from { width: 0; }
          to { width: 100%; }
        }
        @keyframes splashCursorBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes splashParticleFloat {
          0% { transform: translateY(0) translateX(0); opacity: 0; }
          20% { opacity: 0.8; }
          80% { opacity: 0.6; }
          100% { transform: translateY(-60px) translateX(20px); opacity: 0; }
        }
        @keyframes splashPixelScan {
          0%   { top: -2%; opacity: 0.6; }
          50%  { opacity: 1; }
          100% { top: 100%; opacity: 0.6; }
        }
        @keyframes grain {
          0%, 100% { transform: translate(0, 0); }
          25% { transform: translate(-2px, 2px); }
          50% { transform: translate(2px, -1px); }
          75% { transform: translate(-1px, -2px); }
        }
      `}</style>

      {/* Deep luxury gallery void with aurora hints */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 0,
        background: "linear-gradient(160deg, #030006 0%, #08001a 25%, #000812 50%, #0a0018 75%, #050008 100%)",
      }} />
      {/* Flowing aurora color waves */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none", overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", top: "-20%", left: "-10%", width: "120%", height: "60%",
          background: "radial-gradient(ellipse at 30% 50%, rgba(200,170,100,0.06) 0%, transparent 50%), radial-gradient(ellipse at 70% 30%, rgba(100,60,200,0.05) 0%, transparent 45%)",
          filter: "blur(80px)",
          animation: "splashAurora1 20s ease-in-out infinite",
        }} />
        <div style={{
          position: "absolute", bottom: "-15%", right: "-10%", width: "100%", height: "50%",
          background: "radial-gradient(ellipse at 60% 60%, rgba(111,168,220,0.05) 0%, transparent 50%), radial-gradient(ellipse at 30% 70%, rgba(220,80,160,0.04) 0%, transparent 45%)",
          filter: "blur(80px)",
          animation: "splashAurora2 25s ease-in-out infinite",
        }} />
        <div style={{
          position: "absolute", top: "30%", left: "20%", width: "60%", height: "40%",
          background: "radial-gradient(ellipse at 50% 50%, rgba(200,170,100,0.04) 0%, transparent 60%)",
          filter: "blur(100px)",
          animation: "splashAurora3 30s ease-in-out infinite",
        }} />
      </div>

      {/* ═══ BOKEH BACKGROUND ═══ */}
      <BokehOrbs count={8} />

      {/* ═══ PARTICLE SYSTEM — golden energy motes ═══ */}
      <ParticleCanvas />

      {/* ═══ CURSOR SPOTLIGHT — warm luxury glow ═══ */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none",
        background: `radial-gradient(circle 500px at ${mousePos.x}px ${mousePos.y}px, rgba(200,170,100,0.12) 0%, rgba(180,100,255,0.06) 30%, rgba(111,168,220,0.04) 50%, transparent 70%)`,
        transition: "background 0.15s ease-out",
      }} />
      {/* Inner bright spotlight */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none",
        background: `radial-gradient(circle 200px at ${mousePos.x}px ${mousePos.y}px, rgba(255,245,230,0.08) 0%, transparent 60%)`,
        transition: "background 0.1s ease-out",
      }} />

      {/* Constellation lines removed for performance */}

      {/* ═══ BOUNCING ART PIECES ═══ */}
      {positions.map((pos, i) => {
        const piece = ART_PIECES[i];
        const glowIntensity = pos.glow;
        const velocityChroma = Math.min(pos.speed * 2, 1);
        // Disabled depth blur for performance — was causing per-frame filter recalc
        const depthBlur = 0;
        const holoAngle = (pos.x + pos.y + pos.holo * 360) % 360;

        return (
          <div key={i}>
            {/* Ghost trail afterimages */}
            {pos.trail && pos.trail.slice(0, -1).map((t, ti) => {
              const age = (pos.trail.length - ti) / pos.trail.length;
              const opacity = (1 - age) * 0.12;
              return (
                <div key={ti} style={{
                  position: "absolute",
                  left: t.x - piece.size / 2, top: t.y - piece.size / 2,
                  width: piece.size, zIndex: 1,
                  pointerEvents: "none",
                  transform: `rotate(${t.rot}deg) scale(${0.95 + age * 0.05})`,
                  opacity, filter: "blur(3px) saturate(0.5)",
                }}>
                  <img src={piece.src} alt="" style={{
                    width: "100%", height: "auto", objectFit: "contain", borderRadius: 12,
                    imageRendering: piece.pixel ? "pixelated" : "auto",
                  }} />
                </div>
              );
            })}

            {/* Main image */}
            <div style={{
              position: "absolute",
              left: 0, top: 0,
              width: piece.size,
              zIndex: piece.pixel ? 3 : 2,
              pointerEvents: "none",
              transform: `translate3d(${pos.x - piece.size / 2}px, ${pos.y - piece.size / 2}px, 0) rotate(${pos.rot}deg) scale(${pos.breath}) perspective(800px) rotateX(${pos.tiltX * 1.3}deg) rotateY(${pos.tiltY * 1.3}deg)`,
              willChange: "transform",
              filter: depthBlur > 0.5 ? `blur(${depthBlur}px)` : "none",
            }}>
              {/* Luxury multi-color glow aura */}
              <div style={{
                position: "absolute", inset: -24, borderRadius: 18,
                background: `radial-gradient(ellipse, rgba(200,170,100,${0.12 + glowIntensity * 0.2}), rgba(111,168,220,${0.08 + glowIntensity * 0.15}), rgba(180,100,255,${0.05 + glowIntensity * 0.1}), transparent 70%)`,
                filter: "blur(30px)", zIndex: 0,
              }} />

              {/* Animated luxury border — gold/rose/sapphire gradient */}
              <div style={{
                position: "absolute", inset: -3, borderRadius: 14,
                background: `linear-gradient(${(holoAngle * 0.5) % 360}deg, rgba(200,170,100,${0.5 + glowIntensity * 0.4}), rgba(220,100,180,${0.4 + glowIntensity * 0.3}), rgba(100,160,255,${0.5 + glowIntensity * 0.4}), rgba(200,170,100,${0.5 + glowIntensity * 0.4}))`,
                padding: 2,
                zIndex: 2,
              }}>
                <div style={{ width: "100%", height: "100%", borderRadius: 12, background: "rgba(5,0,15,0.7)" }} />
              </div>
              {/* Outer glow */}
              <div style={{
                position: "absolute", inset: -3, borderRadius: 14,
                boxShadow: `0 0 ${16 + glowIntensity * 25}px rgba(200,170,100,${0.2 + glowIntensity * 0.25}), 0 0 ${30 + glowIntensity * 40}px rgba(111,168,220,${0.1 + glowIntensity * 0.15}), 0 0 ${50 + glowIntensity * 60}px rgba(180,100,255,${0.05 + glowIntensity * 0.08})`,
                zIndex: 0, pointerEvents: "none",
              }} />

              {/* The artwork */}
              <img src={piece.src} alt="" style={{
                width: "100%", height: "auto", objectFit: "contain", display: "block",
                borderRadius: 12, imageRendering: piece.pixel ? "pixelated" : "auto",
                position: "relative", zIndex: 1,
                filter: `${piece.pixel ? "saturate(1.3) contrast(1.1) brightness(1.1)" : "saturate(1.2) contrast(1.05) brightness(1.1)"}`,
              }} />

              {/* Subtle static vignette on art — no rotating light */}
              <div style={{
                position: "absolute", inset: 0, borderRadius: 12, zIndex: 3,
                background: "radial-gradient(ellipse at 40% 35%, transparent 50%, rgba(0,0,0,0.15) 100%)",
                pointerEvents: "none",
              }} />

              {/* Subtle bottom shadow instead of full reflection (perf) */}
              <div style={{
                position: "absolute", left: "10%", right: "10%", top: "100%",
                height: 20, zIndex: 0, pointerEvents: "none",
                background: "radial-gradient(ellipse at center, rgba(200,170,100,0.15) 0%, transparent 70%)",
                filter: "blur(8px)",
              }} />

              {/* RGB glitch split on mouse proximity */}
              {pos.glitch > 0.05 && (
                <>
                  <img src={piece.src} alt="" style={{
                    position: "absolute", inset: 0, width: "100%", height: "100%",
                    objectFit: "contain", borderRadius: 12,
                    imageRendering: piece.pixel ? "pixelated" : "auto",
                    zIndex: 3, mixBlendMode: "screen",
                    opacity: pos.glitch * 0.6,
                    transform: `translate(${pos.glitch * 8}px, ${pos.glitch * -2}px)`,
                    filter: "saturate(2) brightness(1.2) hue-rotate(-30deg)",
                    pointerEvents: "none",
                  }} />
                  <img src={piece.src} alt="" style={{
                    position: "absolute", inset: 0, width: "100%", height: "100%",
                    objectFit: "contain", borderRadius: 12,
                    imageRendering: piece.pixel ? "pixelated" : "auto",
                    zIndex: 3, mixBlendMode: "screen",
                    opacity: pos.glitch * 0.5,
                    transform: `translate(${pos.glitch * -6}px, ${pos.glitch * 3}px)`,
                    filter: "saturate(2) brightness(1.2) hue-rotate(180deg)",
                    pointerEvents: "none",
                  }} />
                  <div style={{
                    position: "absolute", inset: 0, zIndex: 4, borderRadius: 12,
                    opacity: pos.glitch * 0.4,
                    background: `repeating-linear-gradient(0deg, transparent 0px, transparent 3px, rgba(0,255,255,${pos.glitch * 0.15}) 3px, rgba(0,255,255,${pos.glitch * 0.15}) 5px)`,
                    pointerEvents: "none",
                  }} />
                </>
              )}

              {/* Scan line for pixel art — CSS-driven sweep */}
              {piece.pixel && (
                <div style={{
                  position: "absolute", left: 0, right: 0,
                  top: 0, height: 3, borderRadius: 12,
                  background: "linear-gradient(90deg, transparent, rgba(0,255,255,0.4), transparent)",
                  zIndex: 5, pointerEvents: "none",
                  animation: `splashPixelScan ${3 + i * 0.5}s linear infinite`,
                }} />
              )}
            </div>
          </div>
        );
      })}

      {/* ═══ GOLDEN EMBER BURST ═══ */}
      <div style={{ position: "absolute", inset: 0, zIndex: 5, pointerEvents: "none" }}>
        {sparks.map((s) => {
          // Warm gold/orange/amber palette based on spark id
          const emberColors = [
            [255, 180, 50],  // gold
            [255, 140, 30],  // amber
            [255, 100, 20],  // orange
            [255, 200, 80],  // champagne
            [230, 160, 60],  // dark gold
          ];
          const c = emberColors[s.id % emberColors.length];
          return (
            <div key={s.id} style={{
              position: "absolute", left: s.x - s.size / 2, top: s.y - s.size / 2,
              width: s.size, height: s.size,
              background: `rgba(${c[0]},${c[1]},${c[2]},${s.life})`,
              boxShadow: `0 0 ${s.size * 3}px rgba(${c[0]},${c[1]},${c[2]},${s.life * 0.7}), 0 0 ${s.size * 6}px rgba(${c[0]},${c[1]},${c[2]},${s.life * 0.3})`,
              borderRadius: "50%",
            }} />
          );
        })}
      </div>

      {/* ═══ IMPACT FLASH ═══ */}
      {impactFlash > 0.01 && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 12, pointerEvents: "none",
          background: `rgba(255,220,150,${impactFlash * 0.6})`,
          mixBlendMode: "overlay",
        }} />
      )}

      {/* ═══ SHOCKWAVE ═══ */}
      <ShockwaveEffect shockwave={shockwave} />

      <PixelOverlay />
      <PixelDust count={60} />
      <FilmGrain />

      {/* ═══ VIGNETTE (moved out of PixelOverlay for better layering) ═══ */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 7, pointerEvents: "none",
        background: "radial-gradient(ellipse 70% 70% at 50% 50%, transparent 30%, rgba(0,0,0,0.6) 100%)",
      }} />

      {/* ═══ Center content ═══ */}
      <div style={{
        position: "relative", zIndex: 10,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        height: "100%", padding: "40px 20px", pointerEvents: "none",
      }}>
        {/* Collection title */}
        <div style={{ marginBottom: 8, overflow: "hidden", position: "relative" }}>
          <div style={{ display: "flex", justifyContent: "center", gap: 5, position: "relative" }}>
            {(COLLECTIONS[DEFAULT_COLLECTION]?.name || "NAKAMIGOS").toUpperCase().split("").map((letter, i) => {
              const palette = ["#c8a850", "#e8c080", "#ff8fa0", "#c8a850", "#7eb8e0", "#a088d0", "#e0a0c0", "#c8a850", "#7eb8e0"];
              const colors = palette;
              return (
                <motion.span key={i}
                  initial={{ opacity: 0, y: 80, scale: 0.3, rotateX: 90 }}
                  animate={showContent ? { opacity: 1, y: 0, scale: 1, rotateX: 0 } : undefined}
                  transition={{ type: "spring", stiffness: 180, damping: 15, delay: 0.3 + i * 0.08 }}
                  style={{
                    fontFamily: "var(--pixel)", fontSize: "clamp(32px, 7vw, 64px)",
                    color: colors[i % colors.length], display: "inline-block",
                    textShadow: `0 0 30px ${colors[i % colors.length]}aa, 0 0 60px ${colors[i % colors.length]}55, 0 0 100px ${colors[i % colors.length]}33, 0 4px 8px rgba(0,0,0,0.95)`,
                    willChange: "transform, opacity", imageRendering: "pixelated",
                  }}
                >{letter}</motion.span>
              );
            })}
            <motion.div
              initial={{ x: "-140%" }}
              animate={showContent ? { x: "280%" } : undefined}
              transition={{ delay: 1.5, duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
              style={{
                position: "absolute", top: -6, left: 0,
                width: "35%", height: "calc(100% + 12px)",
                background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.5), rgba(255,220,100,0.3), transparent)",
                pointerEvents: "none", zIndex: 2,
              }}
            />
          </div>
        </div>

        {/* Tagline */}
        <motion.div
          initial={{ opacity: 0, letterSpacing: "1em" }}
          animate={showContent ? { opacity: 0.7, letterSpacing: "0.4em" } : undefined}
          transition={{ type: "spring", stiffness: 100, damping: 18, delay: 1.2 }}
          style={{
            fontFamily: "var(--pixel)", fontSize: "clamp(8px, 1.2vw, 12px)",
            color: "#c8a850", textShadow: "0 0 20px rgba(200,168,80,0.5), 0 0 40px rgba(200,168,80,0.2)",
            marginBottom: 48, imageRendering: "pixelated",
          }}
        >THE DIGITAL ART GALLERY</motion.div>

        {/* Progress bar */}
        <motion.div
          initial={{ opacity: 0, scaleX: 0.5 }}
          animate={showContent ? { opacity: 1, scaleX: 1 } : undefined}
          transition={{ type: "spring", stiffness: 120, damping: 16, delay: 1.5 }}
          style={{ width: "clamp(220px, 35vw, 420px)", marginBottom: 16 }}
        >
          <div style={{
            width: "100%", height: 6, borderRadius: 0,
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)",
            position: "relative", overflow: "hidden", imageRendering: "pixelated",
          }}>
            <motion.div
              style={{
                width: `${progress}%`, height: "100%",
                background: "linear-gradient(90deg, #c8a850, #e8c080, #ff8fa0, #a088d0, #7eb8e0, #c8a850)",
                backgroundSize: "200% 100%", transition: "width 0.12s steps(20)",
                imageRendering: "pixelated",
              }}
              animate={{ backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"] }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            />
            <div style={{
              position: "absolute", right: `${100 - progress}%`, top: -3,
              width: 8, height: 12, background: "#fff", filter: "blur(4px)",
              opacity: 0.6, transform: "translateX(50%)", imageRendering: "pixelated",
            }} />
          </div>
        </motion.div>

        {/* Status text */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={showContent ? { opacity: 1 } : undefined}
          transition={{ delay: 1.8 }}
          style={{
            fontFamily: "var(--pixel)", fontSize: 10, letterSpacing: "0.15em",
            imageRendering: "pixelated", marginBottom: 32, textAlign: "center",
          }}
        >
          {phase === "ready" ? (
            <motion.span
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: [0.5, 1, 0.5], y: 0 }}
              transition={{ opacity: { duration: 2, repeat: Infinity, ease: "easeInOut" }, y: { duration: 0.4 } }}
              style={{
                color: "#ffdd00",
                textShadow: "0 0 20px rgba(255,221,0,0.6), 0 0 40px rgba(255,221,0,0.3)",
                fontSize: 12, letterSpacing: "0.3em", cursor: "pointer", pointerEvents: "auto",
              }}
            >CLICK TO ENTER</motion.span>
          ) : (
            <motion.span
              animate={{ color: ["#ff2244", "#ffdd00", "#44ddff", "#ff44ff", "#00ff66", "#ff2244"] }}
              transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
            >
              {(() => {
                if (progress >= 100) return "WELCOME";
                const allMsgs = [...(LOADING_MESSAGES.nakamigos || []), ...(LOADING_MESSAGES.gnssart || []), ...(LOADING_MESSAGES.junglebay || [])];
                if (allMsgs.length === 0) return progress < 50 ? "LOADING..." : "ALMOST THERE...";
                return allMsgs[Math.floor((progress / 100) * (allMsgs.length - 1))].toUpperCase();
              })()}
            </motion.span>
          )}
        </motion.div>

        {/* Stats plaque */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={showContent ? { opacity: 1, y: 0 } : undefined}
          transition={{ type: "spring", stiffness: 100, damping: 16, delay: 2.0 }}
          style={{
            display: "flex", gap: 32, padding: "8px 24px",
            background: "rgba(0,0,0,0.4)", border: "1px solid rgba(0,255,255,0.15)",
            boxShadow: "0 0 20px rgba(0,255,255,0.08)", backdropFilter: "blur(10px)",
            imageRendering: "pixelated",
          }}
        >
          {(() => {
            const col = COLLECTIONS[DEFAULT_COLLECTION] || {};
            return [
              { val: (col.supply || 20000).toLocaleString(), label: "WORKS", color: "#ff2244" },
              { val: (col.tags?.[0]) || "ERC-721", label: "STANDARD", color: "#ffdd00" },
              { val: (col.tags?.[1]) || "ETHEREUM", label: "CHAIN", color: "#44ddff" },
            ];
          })().map((s, i) => (
            <motion.div key={i}
              initial={{ opacity: 0 }}
              animate={showContent ? { opacity: 1 } : undefined}
              transition={{ delay: 2.1 + i * 0.1 }}
              style={{ textAlign: "center" }}
            >
              <div style={{
                fontFamily: "var(--pixel)", fontSize: 13, color: s.color,
                textShadow: `0 0 12px ${s.color}55`, lineHeight: 1.4,
              }}>{s.val}</div>
              <div style={{
                fontFamily: "var(--pixel)", fontSize: 7,
                color: "rgba(255,255,255,0.25)", letterSpacing: "0.15em",
              }}>{s.label}</div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </div>
  );
}
