import { useState, useCallback, useRef, useEffect } from 'react';

const NOTE = (name, octave) => 440 * Math.pow(2, ({ C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[name] + (octave - 4) * 12) / 12);

const SOUNDS = {
  click: {
    wave: 'square',
    notes: [{ freq: 800, end: 600, dur: 50 }],
    gain: 0.08,
  },
  favorite: {
    wave: 'triangle',
    notes: [
      { freq: NOTE('C', 5), dur: 80 },
      { freq: NOTE('E', 5), dur: 80 },
    ],
    gain: 0.1,
  },
  cart: {
    wave: 'square',
    notes: [
      { freq: NOTE('C', 4), dur: 40 },
      { freq: NOTE('E', 4), dur: 40 },
      { freq: NOTE('G', 4), dur: 40 },
    ],
    gain: 0.09,
  },
  buy: {
    wave: 'square',
    notes: [
      { freq: NOTE('C', 4), dur: 100 },
      { freq: NOTE('E', 4), dur: 100 },
      { freq: NOTE('G', 4), dur: 100 },
      { freq: NOTE('C', 5), dur: 100 },
    ],
    gain: 0.1,
    reverb: true,
  },
  alert: {
    wave: 'square',
    notes: [
      { freq: NOTE('A', 5), dur: 100 },
      { freq: NOTE('E', 5), dur: 100 },
      { freq: NOTE('A', 5), dur: 100 },
    ],
    gain: 0.1,
  },
  error: {
    wave: 'sawtooth',
    notes: [
      { freq: NOTE('E', 4), dur: 80 },
      { freq: NOTE('C', 4), dur: 80 },
    ],
    gain: 0.08,
  },
  snipe: {
    wave: 'triangle',
    notes: [
      { freq: NOTE('E', 5), dur: 60 },
      { freq: NOTE('G', 5), dur: 60 },
      { freq: NOTE('B', 5), dur: 60 },
    ],
    gain: 0.1,
  },
  sweep: {
    wave: 'square',
    notes: ['C', 'D', 'E', 'F', 'G', 'A', 'B'].map((n) => ({ freq: NOTE(n, 4), dur: 30 })).concat({ freq: NOTE('C', 5), dur: 30 }),
    gain: 0.09,
  },
};

function playSound(ctx, { wave, notes, gain: vol, reverb }) {
  const now = ctx.currentTime;
  let offset = 0;

  const destination = reverb ? (() => {
    const convolver = ctx.createConvolver();
    const len = ctx.sampleRate * 0.3;
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    convolver.buffer = buffer;
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    dry.gain.value = 0.7;
    wet.gain.value = 0.3;
    dry.connect(ctx.destination);
    wet.connect(convolver).connect(ctx.destination);
    const split = ctx.createGain();
    split.connect(dry);
    split.connect(wet);
    return split;
  })() : ctx.destination;

  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(note.freq, now + offset);
    if (note.end) osc.frequency.linearRampToValueAtTime(note.end, now + offset + note.dur / 1000);

    const t = now + offset;
    const dur = note.dur / 1000;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.005);
    gain.gain.setValueAtTime(vol, t + dur - 0.01);
    gain.gain.linearRampToValueAtTime(0, t + dur);

    osc.connect(gain).connect(destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
    offset += dur;
  }
}

export default function useSound() {
  const ctxRef = useRef(null);
  const mutedRef = useRef(false);
  const [muted, setMuted] = useState(() => {
    try {
      const stored = localStorage.getItem('nakamigos_sound_muted') === 'true';
      mutedRef.current = stored;
      return stored;
    } catch { return false; }
  });

  // Keep ref in sync with state
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  // Close AudioContext on unmount
  useEffect(() => {
    return () => {
      if (ctxRef.current) {
        ctxRef.current.close().catch(() => {});
        ctxRef.current = null;
      }
    };
  }, []);

  const getCtx = useCallback(() => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctxRef.current = new AC();
    }
    if (ctxRef.current.state === 'suspended') ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const play = useCallback((name) => {
    if (mutedRef.current) return;
    const sound = SOUNDS[name];
    if (!sound) return;
    const ctx = getCtx();
    if (!ctx) return;
    playSound(ctx, sound);
  }, [getCtx]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      try { localStorage.setItem('nakamigos_sound_muted', String(next)); } catch {}
      return next;
    });
  }, []);

  return { play, muted, toggleMute };
}
