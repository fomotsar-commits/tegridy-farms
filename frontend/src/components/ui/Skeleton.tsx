export function Skeleton({ width, height, className = '' }: { width?: number | string; height?: number | string; className?: string }) {
  return (
    <span
      className={`skeleton inline-block ${className}`}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        minHeight: height ? undefined : '1em',
        verticalAlign: 'middle',
      }}
    />
  );
}
