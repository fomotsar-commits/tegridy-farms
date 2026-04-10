import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { LoaderState, Particle } from './types';
import {
  ART_COLLECTION, GOLD, T_VOID_END, T_ART_DURATION, T_ART_COUNT,
  T_CRACK_DURATION, T_EXIT_FINALIZE,
} from './constants';
import { preloadImages } from './preload';
import {
  shuffle, easeInOutCubic, coverFit, getTextPixels,
  buildCrackPaths, MAX_PARTICLES,
} from './geometry';
import { drawGoldenLine, drawPurpleMist, drawVoidPhase } from './phases/void';
import { drawArtPiece } from './phases/art';
import { drawGlitchCut, drawSubliminalText } from './phases/glitch';
import { drawShatterPhase } from './phases/shatter';
import { drawVortexPhase } from './phases/vortex';
import { drawTextFormPhase } from './phases/textForm';
import { drawHoldPhase } from './phases/hold';
import { drawCracks, drawSpiderWeb, buildExitDOM, tickRagdollShards } from './phases/exit';
import { createMorphParticles, updateMorphParticles } from './fx/particleMorph';
import { AudioEngine } from './fx/audio';
import { PostFX } from './fx/postfx';

export function AppLoader({ onComplete, children }: { onComplete?: () => void; children?: React.ReactNode }) {
  const [visible, setVisible] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const postfxRef = useRef<PostFX | null>(null);
  const [muted, setMuted] = useState(false);

  const stateRef = useRef<LoaderState>({
    phase: 'loading',
    t0: 0,
    images: [],
    titles: [],
    particles: [],
    morphParticles: [],
    exitStart: 0,
    exitClickX: 0,
    exitClickY: 0,
    exitSnapshot: null,
    exitShards: [],
    exitShardsBuilt: false,
    exitCracks: [],
    exitSnakePath: [],
    textTargetsReady: false,
    clicked: false,
    dpr: 1,
    isMobile: false,
    prevFrameData: null,
    mouseX: 0,
    mouseY: 0,
    vortexCenterX: 0,
    vortexCenterY: 0,
    trailParticles: [],
    audioInitialized: false,
  });

  const finalize = useCallback(() => {
    setVisible(false);
    audioRef.current?.fadeOutAmbient(0.3);
    setTimeout(() => {
      audioRef.current?.dispose();
      postfxRef.current?.dispose();
    }, 500);
    onComplete?.();
  }, [onComplete]);

  /* Skip for repeat visits */
  useEffect(() => {
    if (sessionStorage.getItem('tf_loaded')) {
      finalize();
    }
  }, [finalize]);

  /* Initialize audio on first user gesture */
  const initAudio = useCallback(() => {
    if (stateRef.current.audioInitialized) return;
    stateRef.current.audioInitialized = true;
    const audio = new AudioEngine();
    audio.init();
    audioRef.current = audio;
    audio.playAmbient('/audio/ambient-loop.mp3');
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const s = stateRef.current;
    initAudio();
    if (!s.clicked && (s.phase === 'hold' || s.phase === 'textForm' || s.phase === 'vortex')) {
      s.clicked = true;
      s.phase = 'exit-crack';
      s.exitStart = performance.now();
      s.exitClickX = e.clientX;
      s.exitClickY = e.clientY;

      // Build crack paths
      const W = window.innerWidth, H = window.innerHeight;
      s.exitCracks = buildCrackPaths(e.clientX, e.clientY, W, H);

      // Play crack SFX
      audioRef.current?.playCrack();

      // Snapshot canvas for shard textures (taken after cracks are drawn)
    }
  }, [initAudio]);

  /* ESC to skip with style */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && visible) {
        const s = stateRef.current;
        if (s.phase !== 'skip' && s.phase !== 'exit' && s.phase !== 'exit-crack') {
          initAudio();
          s.phase = 'skip';
          s.exitStart = performance.now();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, initAudio]);

  useEffect(() => {
    if (!visible) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const s = stateRef.current;
    s.dpr = Math.min(window.devicePixelRatio || 1, 2);
    s.isMobile = window.innerWidth < 768;

    let W = window.innerWidth;
    let H = window.innerHeight;
    s.mouseX = W / 2;
    s.mouseY = H / 2;
    s.vortexCenterX = W / 2;
    s.vortexCenterY = H / 2;

    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas!.width = W * s.dpr;
      canvas!.height = H * s.dpr;
      canvas!.style.width = W + 'px';
      canvas!.style.height = H + 'px';
      ctx!.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      postfxRef.current?.resize(W * s.dpr, H * s.dpr);
    }
    resize();
    window.addEventListener('resize', resize);

    /* Mouse tracking */
    const onMouseMove = (e: MouseEvent) => { s.mouseX = e.clientX; s.mouseY = e.clientY; };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) { s.mouseX = e.touches[0].clientX; s.mouseY = e.touches[0].clientY; }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchmove', onTouchMove);

    /* WebGL post-processing — enabled on all devices (iPhones/iPads have great WebGL2)
       Mobile uses 1x DPR for the PostFX pass to keep GPU usage reasonable */
    if (overlayRef.current) {
      const pfxDpr = s.isMobile ? 1 : s.dpr;
      const pfx = new PostFX();
      if (pfx.init(overlayRef.current, W * pfxDpr, H * pfxDpr)) {
        postfxRef.current = pfx;
      }
    }

    let rafId = 0;
    let disposed = false;
    let exitDOMState: ReturnType<typeof buildExitDOM> | null = null;

    /* Load images */
    const chosen = shuffle(ART_COLLECTION).slice(0, T_ART_COUNT);
    const srcs = chosen.map((a) => a.src);
    const titles = chosen.map((a) => a.title);

    preloadImages(srcs).then((results) => {
      if (disposed) return;
      const loaded = results.filter((r): r is HTMLImageElement => r !== null);
      if (loaded.length === 0) {
        s.images = [];
        s.titles = [];
      } else {
        s.images = loaded;
        s.titles = titles.slice(0, loaded.length);
      }
      s.phase = 'void';
      s.t0 = performance.now();
      rafId = requestAnimationFrame(tick);
    });

    /* Create particles from last art image */
    function createParticles(img: HTMLImageElement) {
      const oc = document.createElement('canvas');
      const artScale = s.isMobile ? 0.82 : 0.72;
      const artW = W * artScale;
      const artH = H * artScale;
      oc.width = Math.floor(artW);
      oc.height = Math.floor(artH);
      const ocx = oc.getContext('2d')!;
      const fit = coverFit(img, artW, artH);
      ocx.drawImage(img, fit.sx, fit.sy, fit.sw, fit.sh, 0, 0, oc.width, oc.height);

      let pixelData: ImageData | null = null;
      try { pixelData = ocx.getImageData(0, 0, oc.width, oc.height); } catch { /* tainted */ }

      // Fewer particles on mobile — less GPU work, cleaner look
      const count = Math.min(s.isMobile ? 1000 : 2000, MAX_PARTICLES);
      const particles: Particle[] = [];
      const artX = (W - artW) / 2;
      const artY = (H - artH) / 2;

      for (let i = 0; i < count; i++) {
        const px = Math.random() * oc.width;
        const py = Math.random() * oc.height;
        let r = 200, g = 180, b = 140;
        if (pixelData) {
          const idx = (Math.floor(py) * oc.width + Math.floor(px)) * 4;
          r = pixelData.data[idx];
          g = pixelData.data[idx + 1];
          b = pixelData.data[idx + 2];
        }
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 6;
        particles.push({
          x: artX + px, y: artY + py,
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          targetX: W / 2, targetY: H / 2, hasTarget: false,
          r, g, b,
          // Slightly larger particles on mobile for bolder text presence
          size: s.isMobile ? (1.5 + Math.random() * 1.5) : (1.5 + Math.random() * 2),
          alpha: 1,
          angle: Math.random() * Math.PI * 2,
          angularVel: (Math.random() - 0.5) * 0.04,
          radius: 0, trail: [],
        });
      }
      s.particles = particles;
    }

    /* Assign text targets */
    function assignTextTargets() {
      // Larger font sizes on mobile so text has enough pixel targets
      const mainSize = s.isMobile ? Math.min(130, W * 0.19) : Math.min(130, W * 0.15);
      const subSize = s.isMobile ? Math.min(60, W * 0.09) : Math.min(60, W * 0.07);
      const mainPts = getTextPixels('TEGRIDY', mainSize, W, H, -subSize * 0.5);
      const subPts = getTextPixels('FARMS', subSize, W, H, mainSize * 0.45);
      // Shuffle text pixel targets so particles spread evenly across the full text
      // Without this, scan-order (L→R, T→B) means the right side gets no coverage
      // when particle count < target count (1000 particles vs 3000+ targets on mobile)
      const allPts = shuffle([...mainPts, ...subPts]);
      const shuffled = shuffle([...Array(s.particles.length).keys()]);
      for (let i = 0; i < Math.min(allPts.length, s.particles.length); i++) {
        const p = s.particles[shuffled[i]];
        p.targetX = allPts[i].x;
        p.targetY = allPts[i].y;
        p.hasTarget = true;
      }
      s.textTargetsReady = true;
    }

    /* Main render loop */
    function tick(now: number) {
      if (disposed) return;
      const elapsed = now - s.t0;
      ctx!.clearRect(0, 0, W, H);

      // Black BG for all non-exit phases
      if (s.phase !== 'exit' && s.phase !== 'exit-crack' && s.phase !== 'skip') {
        ctx!.fillStyle = '#000';
        ctx!.fillRect(0, 0, W, H);
      }

      const phase = s.phase;
      let bloomIntensity = 0;
      let caStrength = 0;

      /* VOID */
      if (phase === 'void') {
        drawVoidPhase(ctx!, W, H, elapsed);
        if (elapsed >= T_VOID_END) {
          if (s.images.length === 0) {
            s.phase = 'textForm';
            s.t0 = now;
            const count = Math.min(s.isMobile ? 1000 : 2000, MAX_PARTICLES);
            const particles: Particle[] = [];
            for (let i = 0; i < count; i++) {
              particles.push({
                x: Math.random() * W, y: Math.random() * H,
                vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2,
                targetX: W / 2, targetY: H / 2, hasTarget: false,
                r: 180 + Math.random() * 75, g: 140 + Math.random() * 60,
                b: 80 + Math.random() * 60,
                size: 1.5 + Math.random() * 2, alpha: 0.8,
                angle: 0, angularVel: 0, radius: 0, trail: [],
              });
            }
            s.particles = particles;
            assignTextTargets();
          } else {
            s.phase = 'art';
            s.t0 = now;
          }
        }
      }

      /* ART GALLERY */
      if (phase === 'art') {
        const artElapsed = elapsed;
        const pieceIdx = Math.floor(artElapsed / T_ART_DURATION);
        const pieceTime = artElapsed % T_ART_DURATION;
        bloomIntensity = 0.3;

        drawGoldenLine(ctx!, W, H, 1, 0.2);
        drawPurpleMist(ctx!, W, H, 0.5);

        if (pieceIdx >= s.images.length) {
          s.phase = 'shatter';
          s.t0 = now;
          createParticles(s.images[s.images.length - 1]);
          rafId = requestAnimationFrame(tick);
          return;
        }

        const img = s.images[pieceIdx];
        const title = s.titles[pieceIdx] || '';

        // Particle morph during glitch window
        if (s.morphParticles.length > 0) {
          const morphProgress = Math.min(1, (pieceTime - 1400) / 1120);
          if (morphProgress > 0) {
            updateMorphParticles(ctx!, s, morphProgress);
          }
        }

        if (pieceTime < 600) {
          const fp = pieceTime / 600;
          const alpha = easeInOutCubic(fp);
          const zoom = 1 + fp * 0.01;
          drawArtPiece(ctx!, W, H, img, alpha, zoom, alpha * 0.4, title, alpha, s.mouseX, s.mouseY, s.isMobile);
        } else if (pieceTime < 1400) {
          const hp = (pieceTime - 600) / 800;
          const zoom = 1.01 + hp * 0.015;
          drawArtPiece(ctx!, W, H, img, 1, zoom, 0.4, title, 1, s.mouseX, s.mouseY, s.isMobile);
        } else if (pieceTime < 2520) {
          const glitchTime = pieceTime - 1400;
          if (glitchTime < 500) {
            // Extended glitch cut phase — 500ms of heavy distortion
            const zoom = 1.025 + (glitchTime / 500) * 0.02;
            drawArtPiece(ctx!, W, H, img, 1, zoom, 0.4, title, 1, s.mouseX, s.mouseY, s.isMobile);
            drawGlitchCut(ctx!, canvas!, W, H, glitchTime / 500, s.dpr, elapsed, s.isMobile);
          } else if (glitchTime < 900) {
            // Extended fade-out with glitch — 400ms
            const tp = (glitchTime - 500) / 400;
            const fadeAlpha = 1 - easeInOutCubic(tp);
            if (fadeAlpha > 0.05) {
              drawArtPiece(ctx!, W, H, img, fadeAlpha, 1.04, 0, '', 0, s.mouseX, s.mouseY, s.isMobile);
              if (tp < 0.6) drawGlitchCut(ctx!, canvas!, W, H, 0.5 + tp, s.dpr, elapsed, s.isMobile);
            }
          }
          if (glitchTime >= 900 && glitchTime < 1040) {
            drawSubliminalText(ctx!, W, H);
          }
          // Spawn morph particles at start of glitch
          if (glitchTime < 50 && s.morphParticles.length === 0) {
            const nextIdx = pieceIdx + 1;
            const nextImg = nextIdx < s.images.length ? s.images[nextIdx] : null;
            s.morphParticles = createMorphParticles(img, nextImg, W, H);
          }
        }
        caStrength = 0.002;
      }

      /* SHATTER */
      if (phase === 'shatter') {
        drawGoldenLine(ctx!, W, H, 1, 0.15);
        drawPurpleMist(ctx!, W, H, 0.3);
        bloomIntensity = 0.8;
        caStrength = 0.005;
        if (drawShatterPhase(ctx!, canvas!, W, H, elapsed, s)) {
          s.phase = 'vortex';
          s.t0 = now;
        }
      }

      /* VORTEX */
      if (phase === 'vortex') {
        drawGoldenLine(ctx!, W, H, 1, 0.12);
        bloomIntensity = 0.6;
        caStrength = 0.003;
        if (drawVortexPhase(ctx!, W, H, elapsed, s)) {
          s.phase = 'textForm';
          s.t0 = now;
          assignTextTargets();
        }
      }

      /* TEXT FORMATION */
      if (phase === 'textForm') {
        const tp = Math.min(elapsed / 2000, 1);
        drawGoldenLine(ctx!, W, H, 1, 0.1 + tp * 0.15);
        drawPurpleMist(ctx!, W, H, tp * 0.4);
        bloomIntensity = 0.5;
        if (drawTextFormPhase(ctx!, W, H, elapsed, s)) {
          s.phase = 'hold';
          s.t0 = now;
        }
      }

      /* HOLD */
      if (phase === 'hold') {
        drawGoldenLine(ctx!, W, H, 1, 0.15 + Math.sin(now * 0.0005) * 0.05);
        const purpleAlpha = 0.3 + Math.sin(now * 0.0007) * 0.1;
        drawPurpleMist(ctx!, W, H, purpleAlpha);
        bloomIntensity = 0.5;
        drawHoldPhase(ctx!, W, H, now, s);
      }

      /* EXIT-CRACK: Cracks spread before shattering */
      if (phase === 'exit-crack') {
        ctx!.fillStyle = '#000';
        ctx!.fillRect(0, 0, W, H);

        // Background art (same as hold phase)
        if (s.images.length > 0) {
          const bgImg = s.images[s.images.length - 1];
          const bgFit = coverFit(bgImg, W, H);
          ctx!.save();
          ctx!.globalAlpha = 0.35;
          ctx!.drawImage(bgImg, bgFit.sx, bgFit.sy, bgFit.sw, bgFit.sh, 0, 0, W, H);
          ctx!.restore();
          ctx!.save();
          const bgVig = ctx!.createRadialGradient(W / 2, H / 2, W * 0.15, W / 2, H / 2, W * 0.65);
          bgVig.addColorStop(0, 'rgba(0,0,0,0.15)');
          bgVig.addColorStop(0.5, 'rgba(0,0,0,0.5)');
          bgVig.addColorStop(1, 'rgba(0,0,0,0.85)');
          ctx!.fillStyle = bgVig;
          ctx!.fillRect(0, 0, W, H);
          ctx!.restore();
        }

        // Keep drawing the hold state underneath the cracks
        drawGoldenLine(ctx!, W, H, 1, 0.15);
        drawPurpleMist(ctx!, W, H, 0.3);
        for (const p of s.particles) {
          if (p.alpha > 0.02) {
            ctx!.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
            ctx!.fillRect(p.x, p.y, p.size, p.size);
          }
        }
        // Ghost text — desktop only (Safari renders canvas shadowBlur way too bright on mobile)
        if (!s.isMobile) {
        const mainSize = Math.min(130, W * 0.15);
        const subSize = Math.min(60, W * 0.07);
        ctx!.save();
        ctx!.globalAlpha = 0.1;
        ctx!.font = `bold ${mainSize}px "Inter", "Helvetica Neue", sans-serif`;
        ctx!.textAlign = 'center'; ctx!.textBaseline = 'middle';
        ctx!.fillStyle = '#fff'; ctx!.shadowColor = '#fff'; ctx!.shadowBlur = 20;
        ctx!.fillText('TEGRIDY', W / 2, H / 2 - subSize * 0.5);
        ctx!.font = `bold ${subSize}px "Inter", "Helvetica Neue", sans-serif`;
        ctx!.fillText('FARMS', W / 2, H / 2 + mainSize * 0.45);
        ctx!.restore();
        }

        // Draw animated cracks
        const crackElapsed = now - s.exitStart;
        drawCracks(ctx!, s.exitCracks, crackElapsed, T_CRACK_DURATION);
        if (crackElapsed > T_CRACK_DURATION * 0.8) {
          drawSpiderWeb(ctx!, s.exitCracks, Math.min(1, (crackElapsed - T_CRACK_DURATION * 0.8) / (T_CRACK_DURATION * 0.2)));
        }
        bloomIntensity = 0.8;
        caStrength = 0.006;

        // Transition to exit after crack duration
        if (crackElapsed >= T_CRACK_DURATION) {
          // Snapshot the cracked canvas
          const snap = document.createElement('canvas');
          snap.width = canvas!.width;
          snap.height = canvas!.height;
          const sctx = snap.getContext('2d');
          if (sctx) sctx.drawImage(canvas!, 0, 0);
          s.exitSnapshot = snap;

          s.phase = 'exit';
          s.exitStart = now;
          if (overlayRef.current) overlayRef.current.style.background = 'transparent';
          canvas!.style.display = 'none';

          // Hide WebGL canvas during exit
          postfxRef.current?.dispose();
          postfxRef.current = null;

          audioRef.current?.fadeOutAmbient(0.8);

          exitDOMState = buildExitDOM(s, overlayRef.current!, W, H, audioRef.current);
        }
      }

      /* EXIT: Ragdoll shards */
      if (phase === 'exit') {
        const exitElapsed = now - s.exitStart;
        if (exitDOMState) {
          const allDone = tickRagdollShards(exitDOMState.shards, W, H, now);
          if (allDone || exitElapsed >= T_EXIT_FINALIZE) {
            exitDOMState.cleanup();
            sessionStorage.setItem('tf_loaded', '1');
            finalize();
            return;
          }
        } else if (exitElapsed >= T_EXIT_FINALIZE) {
          sessionStorage.setItem('tf_loaded', '1');
          finalize();
          return;
        }
      }

      /* SKIP: Dissolve */
      if (phase === 'skip') {
        const skipElapsed = now - s.exitStart;
        const progress = Math.min(1, skipElapsed / 400);

        // Scatter particles outward
        for (const p of s.particles) {
          const dx = p.x - W / 2;
          const dy = p.y - H / 2;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          p.vx += (dx / dist) * 2;
          p.vy += (dy / dist) * 2;
          p.x += p.vx;
          p.y += p.vy;
          p.alpha *= 0.92;
        }

        ctx!.fillStyle = '#000';
        ctx!.fillRect(0, 0, W, H);
        ctx!.globalAlpha = 1 - progress;
        for (const p of s.particles) {
          if (p.alpha > 0.02) {
            ctx!.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
            ctx!.fillRect(p.x, p.y, p.size, p.size);
          }
        }
        ctx!.globalAlpha = 1;

        if (progress >= 1) {
          audioRef.current?.fadeOutAmbient(0.2);
          sessionStorage.setItem('tf_loaded', '1');
          finalize();
          return;
        }
      }

      // WebGL post-processing (not during exit/skip)
      if (postfxRef.current && phase !== 'exit' && phase !== 'exit-crack' && phase !== 'skip') {
        postfxRef.current.render(canvas!, bloomIntensity, caStrength);
      }

      rafId = requestAnimationFrame(tick);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
      exitDOMState?.cleanup();
    };
  }, [visible, finalize, initAudio]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    audioRef.current?.setMute(next);
  }, [muted]);

  return (
    <>
      {children}
      {visible && (
        <div
          ref={overlayRef}
          onClick={handleClick}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: '#000',
            cursor: 'pointer',
            touchAction: 'none',
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              position: 'relative',
              zIndex: 0,
            }}
          />
          {/* Mute button */}
          <button
            onClick={(e) => { e.stopPropagation(); toggleMute(); }}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              zIndex: 10,
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid rgba(212,160,23,0.3)',
              borderRadius: 8,
              padding: '10px 14px',
              cursor: 'pointer',
              color: GOLD,
              fontSize: 18,
              lineHeight: 1,
              opacity: 0.6,
              transition: 'opacity 0.2s',
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = '1'; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = '0.6'; }}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? '\u{1F507}' : '\u{1F50A}'}
          </button>
        </div>
      )}
    </>
  );
}
