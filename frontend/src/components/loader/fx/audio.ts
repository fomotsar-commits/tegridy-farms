export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private ambientSource: AudioBufferSourceNode | null = null;
  private ambientGain: GainNode | null = null;
  private muted = false;

  /**
   * Initialize AudioContext. Must be called from a user-gesture handler
   * (click / keypress) to comply with browser autoplay policies (#85 audit).
   */
  init() {
    if (this.ctx) return;
    // Guard: only create AudioContext after a trusted user gesture.
    // Modern browsers require this — calling outside a gesture will suspend the context.
    if (typeof navigator !== 'undefined' && (navigator as any).userActivation &&
        !(navigator as any).userActivation.hasBeenActive) {
      return; // No user gesture yet — skip init
    }
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
  }

  private createNoise(duration: number): AudioBuffer {
    const ctx = this.ctx!;
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  playCrack() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // High-frequency filtered noise burst
    const noise = ctx.createBufferSource();
    noise.buffer = this.createNoise(0.2);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(4000, now);
    filter.frequency.exponentialRampToValueAtTime(1000, now + 0.15);
    filter.Q.value = 2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    noise.connect(filter).connect(gain).connect(this.masterGain!);
    noise.start(now);
    noise.stop(now + 0.2);
  }

  playShatter() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Broadband noise through highpass
    const noise = ctx.createBufferSource();
    noise.buffer = this.createNoise(0.4);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2000;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.5, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    noise.connect(hp).connect(noiseGain).connect(this.masterGain!);
    noise.start(now);
    noise.stop(now + 0.4);

    // Low metallic ring for impact weight
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.3);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.3, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(oscGain).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  playWhoosh() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = this.createNoise(0.8);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400, now);
    lp.frequency.exponentialRampToValueAtTime(100, now + 0.8);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    noise.connect(lp).connect(gain).connect(this.masterGain!);
    noise.start(now);
    noise.stop(now + 0.8);
  }

  async playAmbient(url: string) {
    if (!this.ctx) return;
    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

      this.ambientGain = this.ctx.createGain();
      this.ambientGain.gain.value = this.muted ? 0 : 0.15;
      this.ambientGain.connect(this.masterGain!);

      this.ambientSource = this.ctx.createBufferSource();
      this.ambientSource.buffer = audioBuffer;
      this.ambientSource.loop = true;
      this.ambientSource.connect(this.ambientGain);
      this.ambientSource.start();
    } catch {
      // Audio file not available — silent fallback
    }
  }

  fadeOutAmbient(duration = 0.8) {
    if (!this.ctx || !this.ambientGain) return;
    const now = this.ctx.currentTime;
    this.ambientGain.gain.setValueAtTime(this.ambientGain.gain.value, now);
    this.ambientGain.gain.linearRampToValueAtTime(0, now + duration);
    setTimeout(() => {
      this.ambientSource?.stop();
      this.ambientSource = null;
    }, duration * 1000 + 100);
  }

  setMute(m: boolean) {
    this.muted = m;
    if (this.ambientGain) {
      this.ambientGain.gain.value = m ? 0 : 0.15;
    }
  }

  get isMuted() { return this.muted; }

  dispose() {
    this.ambientSource?.stop();
    this.ctx?.close();
    this.ctx = null;
  }
}
