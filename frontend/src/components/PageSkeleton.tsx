import React from 'react';

export const PageSkeleton = React.memo(function PageSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading page"
      className="flex flex-col items-center justify-center min-h-[60vh] gap-3"
    >
      <div className="size-8 sm:size-10 md:size-12 rounded-full border-3 border-primary-dim border-t-primary-glow animate-[spin_0.8s_linear_infinite]" />
      <span className="text-primary-glow text-xs sm:text-sm font-mono animate-[skeleton-pulse_1.5s_ease-in-out_infinite]">
        Loading...
      </span>
    </div>
  );
});
