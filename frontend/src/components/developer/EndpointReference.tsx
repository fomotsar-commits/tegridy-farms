import type { ApiRoute, ApiRoadmapEntry } from '../../../api/_lib/apiTiers';
import { API_ROUTES, API_ROADMAP } from '../../../api/_lib/apiTiers.js';

const ROUTES = API_ROUTES as ApiRoute[];
const ROADMAP = API_ROADMAP as ApiRoadmapEntry[];

export function EndpointReference() {
  return (
    <section aria-labelledby="endpoints-heading">
      <h2 id="endpoints-heading" className="text-2xl font-bold mb-2">
        Endpoints
      </h2>
      <p className="text-sm opacity-80 mb-4">
        Send your key as <code>X-API-Key</code> (or <code>Authorization: Bearer mtk_…</code>).
        Server-side only — a key in a browser bundle is a key anyone can read, and CORS on this
        host admits the venue&apos;s own origins only.
      </p>

      <ul className="space-y-3" data-testid="endpoint-list">
        {ROUTES.map((route) => (
          <li
            key={route.id}
            className="rounded-xl px-4 py-3"
            style={{ border: '1px solid var(--color-purple-12)' }}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)' }}>
                {route.method}
              </span>
              <code className="text-sm break-all">{route.path}</code>
              <span
                className="text-xs px-2 py-0.5 rounded"
                style={{ background: route.keyed ? 'rgba(45,139,78,0.25)' : 'rgba(255,255,255,0.08)' }}
              >
                {route.keyed ? 'API key required' : 'No key required'}
              </span>
            </div>
            <p className="text-sm mt-1">{route.summary}</p>
            <p className="text-xs opacity-70 mt-1">{route.note}</p>
          </li>
        ))}
      </ul>

      {/*
        Named, not omitted. The venue computes deployer reputation, wallet exposure
        and launch simulation and shows all three for free in the app; a reader who
        arrives here from those pages and finds no mention of them would reasonably
        conclude the API covers them. Saying what is missing, and why, costs a
        paragraph and prevents an integration built on an assumption.
      */}
      <h3 className="text-lg font-semibold mt-8 mb-2">Computed here, not served here yet</h3>
      <ul className="space-y-2 text-sm" data-testid="roadmap-list">
        {ROADMAP.map((entry) => (
          <li key={entry.id} className="opacity-80">
            <strong>{entry.summary}</strong> — {entry.blockedBy}
          </li>
        ))}
      </ul>
    </section>
  );
}
