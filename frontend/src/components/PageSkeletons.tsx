import React from 'react';

/** Swap page skeleton — token inputs, route info, button */
export const SwapSkeleton = React.memo(function SwapSkeleton() {
  return (
    <div role="status" aria-label="Loading swap" className="max-w-[480px] mx-auto pt-8 px-4 space-y-4">
      <div className="skeleton h-6 w-32 mb-6" />
      {/* From input */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--color-purple-08)' }}>
        <div className="flex justify-between">
          <div className="skeleton h-4 w-16" />
          <div className="skeleton h-4 w-24" />
        </div>
        <div className="flex justify-between items-center">
          <div className="skeleton h-10 w-40" />
          <div className="skeleton h-10 w-24 rounded-lg" />
        </div>
      </div>
      {/* Arrow */}
      <div className="flex justify-center"><div className="skeleton h-8 w-8 rounded-full" /></div>
      {/* To input */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--color-purple-08)' }}>
        <div className="flex justify-between">
          <div className="skeleton h-4 w-16" />
          <div className="skeleton h-4 w-24" />
        </div>
        <div className="flex justify-between items-center">
          <div className="skeleton h-10 w-40" />
          <div className="skeleton h-10 w-24 rounded-lg" />
        </div>
      </div>
      {/* Route info */}
      <div className="space-y-2">
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-3/4" />
      </div>
      {/* Button */}
      <div className="skeleton h-12 w-full rounded-xl" />
    </div>
  );
});

/** Farm page skeleton — stats row, staking card, pool cards */
export const FarmSkeleton = React.memo(function FarmSkeleton() {
  return (
    <div role="status" aria-label="Loading farm" className="max-w-[1200px] mx-auto pt-8 px-4 space-y-6">
      <div className="skeleton h-8 w-48 mb-2" />
      <div className="skeleton h-5 w-64 mb-6" />
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1,2,3,4].map(i => (
          <div key={i} className="rounded-xl p-4 space-y-2" style={{ background: 'var(--color-purple-06)' }}>
            <div className="skeleton h-3 w-16" />
            <div className="skeleton h-6 w-24" />
          </div>
        ))}
      </div>
      {/* Staking card */}
      <div className="rounded-xl p-6 space-y-4" style={{ background: 'var(--color-purple-06)', border: '1px solid var(--color-purple-12)' }}>
        <div className="skeleton h-6 w-32" />
        <div className="skeleton h-12 w-full rounded-lg" />
        <div className="grid grid-cols-4 gap-2">
          {[1,2,3,4].map(i => <div key={i} className="skeleton h-10 rounded-lg" />)}
        </div>
        <div className="skeleton h-12 w-full rounded-xl" />
      </div>
      {/* Pool cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[1,2].map(i => (
          <div key={i} className="rounded-xl p-5 space-y-3" style={{ background: 'var(--color-purple-06)', border: '1px solid var(--color-purple-12)' }}>
            <div className="flex items-center gap-3">
              <div className="skeleton h-10 w-10 rounded-full" />
              <div className="skeleton h-5 w-32" />
            </div>
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
});

/** Dashboard page skeleton — stat grid, chart area */
export const DashboardSkeleton = React.memo(function DashboardSkeleton() {
  return (
    <div role="status" aria-label="Loading dashboard" className="max-w-[1200px] mx-auto pt-8 px-4 space-y-6">
      <div className="skeleton h-8 w-48 mb-6" />
      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1,2,3,4,5,6,7,8].map(i => (
          <div key={i} className="rounded-xl p-4 space-y-2" style={{ background: 'var(--color-purple-06)' }}>
            <div className="skeleton h-3 w-20" />
            <div className="skeleton h-7 w-28" />
          </div>
        ))}
      </div>
      {/* Chart area */}
      <div className="rounded-xl p-4" style={{ background: 'var(--color-purple-06)', border: '1px solid var(--color-purple-12)' }}>
        <div className="skeleton h-4 w-24 mb-4" />
        <div className="skeleton h-[300px] w-full rounded-lg" />
      </div>
    </div>
  );
});
