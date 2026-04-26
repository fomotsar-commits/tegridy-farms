import React from 'react';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
}

export const Sparkline = React.memo(function Sparkline({
  data,
  width = 60,
  height = 20,
  color,
  className,
}: SparklineProps) {
  if (!data || data.length < 2) return null;

  // R068: single-pass min/max instead of two `Math.min/max(...data)` calls
  // that spread arguments. Spreading hits a browser argument-count cap on
  // long arrays (Chrome ~125k args) and double-iterates the data for no
  // reason. One pass also dodges Math.min(NaN, ...) corruption.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1; // prevent division by zero

  // Determine color based on trend if not provided
  const trendColor = color ?? ((data[data.length - 1] ?? 0) >= (data[0] ?? 0) ? '#22c55e' : '#ef4444');

  // Padding so the line doesn't clip at edges
  const pad = 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  // Generate points
  const points = data.map((val, i) => {
    const x = pad + (i / (data.length - 1)) * innerW;
    const y = pad + innerH - ((val - min) / range) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={trendColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
});
