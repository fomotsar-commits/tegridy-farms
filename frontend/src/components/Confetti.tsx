import { useRef, useCallback, type ReactNode } from 'react';
import { ConfettiContext, fireConfetti, type ConfettiOptions } from '../hooks/useConfetti';

export function ConfettiProvider({ children }: { children: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const fire = useCallback((options?: ConfettiOptions) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const x = options?.x ?? window.innerWidth / 2;
    const y = options?.y ?? window.innerHeight * 0.2;

    fireConfetti(canvas, x, y);
  }, []);

  return (
    <ConfettiContext.Provider value={{ fire, canvasRef }}>
      {children}
      <canvas
        ref={canvasRef}
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 9999,
        }}
      />
    </ConfettiContext.Provider>
  );
}
