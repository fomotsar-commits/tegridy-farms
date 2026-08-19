import type { ApiErrorSemantic } from '../../../api/_lib/apiTiers';
import { API_ERROR_SEMANTICS } from '../../../api/_lib/apiTiers.js';

const SEMANTICS = API_ERROR_SEMANTICS as ApiErrorSemantic[];

function toneFor(status: number): string {
  if (status >= 500) return 'rgba(239,68,68,0.22)';
  if (status === 429) return 'rgba(234,179,8,0.22)';
  return 'rgba(255,255,255,0.08)';
}

export function ErrorSemantics() {
  return (
    <section aria-labelledby="errors-heading">
      <h2 id="errors-heading" className="text-2xl font-bold mb-2">
        What a failure means
      </h2>

      {/*
        This is the product, not the appendix. A trust API that answers "no findings"
        when it could not scan hands the integrator's user a clean bill of health
        nobody issued — with the venue's name on it. So the contract is stated before
        the table, in the words a reader will need at 3am.
      */}
      <div
        className="rounded-xl px-4 py-3 mb-4 text-sm"
        style={{ border: '1px solid var(--color-purple-12)', background: 'rgba(0,0,0,0.25)' }}
        data-testid="scanned-flag-contract"
      >
        <p className="mb-2">
          Every scan response carries a top-level <code>scanned</code> boolean, and every refusal
          omits <code>distribution</code> entirely. A <strong>502 is not a clean scan</strong> — it
          means no scan happened. If you branch on the presence of a result field rather than the
          status code, you will still find nothing to misread.
        </p>
        <p className="opacity-80">
          The single exception is <code>422 not_a_token</code>: the upstream looked and the address
          is not an ERC-20. That is an answer about the address, so it reports{' '}
          <code>scanned: true</code>.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="error-table">
          <thead>
            <tr className="text-left opacity-70">
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">code</th>
              <th className="py-2">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {SEMANTICS.map((row) => (
              <tr key={row.code} style={{ borderTop: '1px solid var(--color-purple-12)' }}>
                <td className="py-2 pr-4">
                  <span
                    className="font-mono text-xs px-2 py-0.5 rounded"
                    style={{ background: toneFor(row.status) }}
                  >
                    {row.status}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  <code>{row.code}</code>
                </td>
                <td className="py-2">{row.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs opacity-70">
        A 401 is always about your key and a 5xx is always about ours. They are never merged: a
        deployment gap reported as 401 sends you to re-read a key that was correct all along.
      </p>
    </section>
  );
}
