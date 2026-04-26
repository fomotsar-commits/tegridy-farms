// R068: inline skeletons get the same role/aria-busy as page skeletons so AT
// users hear "loading" instead of nothing. The placeholder block uses
// `aria-hidden` for the visual bar — the wrapper carries the announcement.
export function Skeleton({
  width,
  height,
  className = '',
  label = 'Loading',
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  label?: string;
}) {
  return (
    <span
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label={label}
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
