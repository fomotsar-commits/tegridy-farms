export interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  targetX: number; targetY: number;
  hasTarget: boolean;
  r: number; g: number; b: number;
  size: number; alpha: number;
  angle: number; angularVel: number;
  radius: number;
  trail: Array<{ x: number; y: number; alpha: number }>;
}

export interface ExitShard {
  poly: Array<{ x: number; y: number }>;
  origCx: number; origCy: number;
  cx: number; cy: number;
  dist: number; delay: number;
  vx: number; vy: number;
  rot: number; rotSpeed: number;
  alpha: number; scale: number;
  tex: HTMLCanvasElement | null;
  texOffX: number; texOffY: number;
}

export interface MorphParticle {
  x: number; y: number;
  vx: number; vy: number;
  targetX: number; targetY: number;
  r: number; g: number; b: number;
  size: number; alpha: number;
  progress: number;
}

export interface TrailParticle {
  x: number; y: number;
  vx: number; vy: number;
  alpha: number;
  size: number;
}

export interface CrackSegment {
  points: Array<{ x: number; y: number }>;
  progress: number;
  delay: number;
  width: number;
  children: CrackSegment[];
}

export type Phase =
  | 'loading' | 'void' | 'art' | 'shatter'
  | 'vortex' | 'textForm' | 'hold'
  | 'exit-crack' | 'exit' | 'skip';

export interface LoaderState {
  phase: Phase;
  t0: number;
  images: HTMLImageElement[];
  titles: string[];
  particles: Particle[];
  morphParticles: MorphParticle[];
  exitStart: number;
  exitClickX: number;
  exitClickY: number;
  exitSnapshot: HTMLCanvasElement | null;
  exitShards: ExitShard[];
  exitShardsBuilt: boolean;
  exitCracks: CrackSegment[];
  exitSnakePath: Array<{ x: number; y: number }>;
  textTargetsReady: boolean;
  clicked: boolean;
  dpr: number;
  isMobile: boolean;
  prevFrameData: ImageData | null;
  mouseX: number;
  mouseY: number;
  vortexCenterX: number;
  vortexCenterY: number;
  trailParticles: TrailParticle[];
  audioInitialized: boolean;
}
