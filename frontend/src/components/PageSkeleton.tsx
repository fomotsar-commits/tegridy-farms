export function PageSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 12 }}>
      <div style={{
        width: 40, height: 40, border: '3px solid rgba(139,92,246,0.15)',
        borderTopColor: 'rgba(139,92,246,0.6)', borderRadius: '50%',
        animation: 'skeletonSpin 0.8s linear infinite',
      }} />
      <div style={{
        color: 'rgba(139,92,246,0.6)',
        fontSize: 14,
        fontFamily: 'monospace',
        animation: 'skeletonPulse 1.5s ease-in-out infinite',
      }}>
        Loading...
      </div>
      <style>{`
        @keyframes skeletonSpin { to { transform: rotate(360deg); } }
        @keyframes skeletonPulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
      `}</style>
    </div>
  );
}
