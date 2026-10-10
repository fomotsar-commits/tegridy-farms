import { useSyncExternalStore, type ReactNode } from 'react';
import { PageSkeleton } from './PageSkeleton';
import { staleBuildState, subscribeStaleBuild } from '../lib/staleBuild';

/**
 * What an error boundary shows for a lazy load that failed (lib/staleBuild.ts): the
 * spinner while the host's page is read or the tab reloads, and the notice when the host
 * serves a newer build and the tab did not reload itself. Anything else is not known to
 * be an update, so the boundary's own words (`children`) stand.
 */
export function StaleBuildFallback({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeStaleBuild, staleBuildState);
  if (state.kind === 'checking' || state.kind === 'reloading') return <PageSkeleton />;
  if (state.kind !== 'updated') return <>{children}</>;
  return (
    <div role="alert" className="min-h-[200px] flex items-center justify-center px-6">
      <div className="text-center max-w-sm">
        <h2 className="heading-luxury text-2xl text-white mb-2">The site was updated</h2>
        <p className="text-white text-[13px] mb-6">Refresh the page to load the new version.</p>
        <button type="button" onClick={() => window.location.reload()} className="btn-primary px-7 py-2.5 text-[14px]">
          Refresh
        </button>
      </div>
    </div>
  );
}
