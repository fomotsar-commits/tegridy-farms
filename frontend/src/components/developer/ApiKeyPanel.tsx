import { useCallback, useState } from 'react';
import type { ApiStatusState } from './useApiPlatformStatus';

interface KeyRow {
  id: string;
  key_prefix: string;
  tier: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

type PanelMessage = { kind: 'info' | 'error'; text: string } | null;

/**
 * Issuance takes no payment and can mint exactly one thing: the tier whose price
 * is zero. The server enforces that (`isSelfServeTier`); this panel says it out
 * loud so nobody arrives expecting a checkout.
 */
export function ApiKeyPanel({ status }: { status: ApiStatusState }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<PanelMessage>(null);

  const call = useCallback(async (init: RequestInit & { method: string }) => {
    const res = await fetch('/api/v1?route=keys', {
      ...init,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { res, body };
  }, []);

  const loadKeys = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { res, body } = await call({ method: 'GET' });
      if (!res.ok) {
        // The server's own words, never a substituted reassurance. A 503 here is a
        // deployment gap and a 401 is a missing session; collapsing them into
        // "something went wrong" sends the reader to the wrong fix.
        setMessage({ kind: 'error', text: String(body?.error ?? `Request failed (${res.status}).`) });
        setKeys(null);
        return;
      }
      setKeys((body?.keys as KeyRow[]) ?? []);
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the key service. Nothing was changed.' });
      setKeys(null);
    } finally {
      setBusy(false);
    }
  }, [call]);

  const issue = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { res, body } = await call({ method: 'POST', body: JSON.stringify({ action: 'issue', label }) });
      if (!res.ok) {
        setMessage({ kind: 'error', text: String(body?.error ?? `Request failed (${res.status}).`) });
        return;
      }
      setIssued(String(body?.key ?? ''));
      setMessage({ kind: 'info', text: String(body?.notice ?? '') });
      await loadKeys();
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the key service. Nothing was changed.' });
    } finally {
      setBusy(false);
    }
  }, [call, label, loadKeys]);

  const revoke = useCallback(
    async (id: string) => {
      setBusy(true);
      setMessage(null);
      try {
        const { res, body } = await call({ method: 'POST', body: JSON.stringify({ action: 'revoke', id }) });
        if (!res.ok) {
          setMessage({ kind: 'error', text: String(body?.error ?? `Request failed (${res.status}).`) });
          return;
        }
        await loadKeys();
      } catch {
        setMessage({ kind: 'error', text: 'Could not reach the key service. Nothing was changed.' });
      } finally {
        setBusy(false);
      }
    },
    [call, loadKeys],
  );

  return (
    <section aria-labelledby="keys-heading">
      <h2 id="keys-heading" className="text-2xl font-bold mb-2">
        Get a key
      </h2>

      {status.phase === 'loading' && (
        <p className="text-sm opacity-80" data-testid="keys-loading">
          Checking what this deployment has configured…
        </p>
      )}

      {/*
        NOT the same as "issuance is off". We failed to read the deployment's status,
        so the only honest sentence is that we do not know — and there is no button,
        because offering one would be a claim we could not make.
      */}
      {status.phase === 'unreachable' && (
        <p
          className="text-sm rounded-xl px-4 py-3"
          style={{ border: '1px solid var(--color-purple-12)' }}
          data-testid="keys-unknown"
        >
          Could not read this deployment&apos;s API status ({status.reason}), so whether key issuance
          is enabled here is unknown. Reload to try again.
        </p>
      )}

      {status.phase === 'ready' && status.data.platform.keyIssuance === 'not_configured' && (
        <div
          className="text-sm rounded-xl px-4 py-3"
          style={{ border: '1px solid var(--color-purple-12)' }}
          data-testid="keys-not-configured"
        >
          <p className="mb-1">
            <strong>Key issuance is not enabled on this deployment.</strong>
          </p>
          <p className="opacity-80">
            The key store and the SIWE signing secret are unset here, so no key can be minted and
            none could be checked if it were. This is a configuration state, not an outage.
          </p>
        </div>
      )}

      {status.phase === 'ready' && status.data.platform.metering === 'not_configured' && (
        <p className="mt-3 text-sm opacity-80" data-testid="keys-metering-warning">
          Usage metering is also unset here, so keyed requests would be refused with{' '}
          <code>503 metering_not_configured</code> even with a valid key. Keyed calls are never
          served unmetered.
        </p>
      )}

      {status.phase === 'ready' && status.data.platform.keyIssuance === 'configured' && (
        <div data-testid="keys-panel">
          <p className="text-sm opacity-80 mb-3">
            Sign in with your wallet first — issuance is authed by your SIWE session, not by an
            existing key, so a leaked key cannot mint successors that outlive its revocation. Every
            key minted here is on the <strong>Free</strong> tier; paid tiers are granted by the
            operator, and nothing on this page takes payment.
          </p>

          <div className="flex flex-wrap gap-2 mb-3">
            <label className="sr-only" htmlFor="key-label">
              Key label
            </label>
            <input
              id="key-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (e.g. staging bot)"
              maxLength={64}
              className="px-3 py-2 rounded-lg text-sm"
              style={{ border: '1px solid var(--color-purple-12)', background: 'transparent' }}
            />
            <button
              type="button"
              onClick={issue}
              disabled={busy}
              className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
              style={{ background: 'var(--color-purple-12)' }}
            >
              Issue a free key
            </button>
            <button
              type="button"
              onClick={loadKeys}
              disabled={busy}
              className="px-4 py-2 rounded-lg text-sm disabled:opacity-50"
              style={{ border: '1px solid var(--color-purple-12)' }}
            >
              Show my keys
            </button>
          </div>

          {issued && (
            <div
              className="rounded-xl px-4 py-3 mb-3 text-sm"
              style={{ border: '1px solid var(--color-purple-12)' }}
              data-testid="issued-key"
            >
              <code className="break-all">{issued}</code>
            </div>
          )}

          {message && (
            <p
              className="text-sm mb-3"
              style={{ color: message.kind === 'error' ? '#ef4444' : undefined }}
              data-testid="keys-message"
            >
              {message.text}
            </p>
          )}

          {keys !== null && (
            /* A11Y-R04: five columns with no scroll container. The page body is
               `overflow-x: hidden`, so at 390px the Tier/Label/State/Revoke
               columns weren't merely pushed off-screen — they were CLIPPED, with
               no way to scroll to them, which took "revoke a key" off the table
               from a phone entirely. Wrapper copied from ErrorSemantics.tsx,
               the only other table in this directory; tabIndex + a named region
               so the scroll container is reachable by keyboard. */
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Your API keys">
            <table className="w-full text-sm" data-testid="key-list">
              <thead>
                <tr className="text-left opacity-70">
                  <th className="py-2 pr-4">Key</th>
                  <th className="py-2 pr-4">Tier</th>
                  <th className="py-2 pr-4">Label</th>
                  <th className="py-2 pr-4">State</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {keys.length === 0 && (
                  <tr>
                    <td className="py-2 opacity-70" colSpan={5}>
                      No keys yet.
                    </td>
                  </tr>
                )}
                {keys.map((k) => (
                  <tr key={k.id} style={{ borderTop: '1px solid var(--color-purple-12)' }}>
                    <td className="py-2 pr-4">
                      <code>{k.key_prefix}…</code>
                    </td>
                    <td className="py-2 pr-4">{k.tier}</td>
                    <td className="py-2 pr-4">{k.label}</td>
                    <td className="py-2 pr-4">{k.revoked_at ? 'Revoked' : 'Active'}</td>
                    <td className="py-2">
                      {!k.revoked_at && (
                        <button
                          type="button"
                          onClick={() => revoke(k.id)}
                          disabled={busy}
                          className="text-xs underline disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
