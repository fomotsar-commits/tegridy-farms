interface PulseDotProps {
  color?: string;
  size?: number;
}

export function PulseDot({ color = '#22c55e', size = 8 }: PulseDotProps) {
  return (
    <span
      className="pulse-dot-container"
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size * 3,
        height: size * 3,
        flexShrink: 0,
      }}
    >
      <span
        className="pulse-dot-ring"
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: '50%',
          border: `1.5px solid ${color}`,
          animation: 'pulse-ring 1.5s ease-out infinite',
        }}
      />
      <span
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: color,
          boxShadow: `0 0 8px ${color}`,
          position: 'relative',
          zIndex: 1,
        }}
      />
    </span>
  );
}
