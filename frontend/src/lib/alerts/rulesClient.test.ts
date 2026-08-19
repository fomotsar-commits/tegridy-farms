// Guard for the rule-store client's degradation contract.
//
// An empty rule list and an unreachable rule store look identical by the time
// they reach a component — both render "no rules" — and only one of them means
// the user is watching nothing on purpose. So every non-success path here is
// asserted to produce a NON-`ready` status with a reason, and `rules` is asserted
// empty in every one of them, so a caller that ignores `status` shows nothing
// rather than showing a confident falsehood.
//
// `schema-missing` gets its own assertions because the fix differs from
// `not-configured`: one is an env var, the other is a migration someone has to
// apply by hand. Collapsing them sends whoever is on call to the wrong place.

import { describe, it, expect, vi } from 'vitest';
import { coerceRule, createRule, deleteRule, listRules, toggleRule } from './rulesClient';

const SUBJECT = '0x420698cfdeddea6bc78d59bc17798113ad278f9d';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const ROW = {
  id: '11111111-2222-3333-4444-555555555555',
  kind: 'heat-tier',
  subject: SUBJECT,
  threshold: null,
  enabled: true,
  created_at: '2026-08-01T00:00:00Z',
};

describe('a good read is a good read', () => {
  it('returns ready with coerced rules', async () => {
    const fetchImpl = vi.fn(async () => response(200, { rules: [ROW] }));
    const result = await listRules({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('ready');
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.subject).toBe(SUBJECT);
    expect(result.detail).toBeNull();
  });

  it('sends credentials — the SIWE JWT rides in an httpOnly cookie', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen = init;
      return response(200, { rules: [] });
    });
    await listRules({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(seen).toMatchObject({ credentials: 'include' });
  });

  it('carries the server’s delivery report through', async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, {
        rules: [],
        delivery: { pushConfigured: false, backgroundWorker: false, detail: 'No VAPID key pair is set.' },
      }),
    );
    const result = await listRules({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.delivery?.pushConfigured).toBe(false);
    expect(result.delivery?.detail).toMatch(/VAPID/);
  });
});

describe('every failure is a named failure, never an empty list', () => {
  it('a network error is unreachable, and says it is not a claim about your rules', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('offline');
    });
    const result = await listRules({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('unreachable');
    expect(result.rules).toEqual([]);
    expect(result.detail).toMatch(/Nothing here says you have no rules/i);
  });

  it('401 is signed-out, not an outage', async () => {
    const fetchImpl = vi.fn(async () => response(401, { error: 'Not authenticated' }));
    const result = await listRules({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('signed-out');
    expect(result.rules).toEqual([]);
  });

  it('schema-missing is its own status and carries the migration step', async () => {
    const fetchImpl = vi.fn(async () =>
      response(503, {
        error: 'The alert-rule table does not exist on this deployment.',
        code: 'schema-missing',
        operatorStep: 'Apply frontend/supabase/migrations/016_alert_rules.sql.',
      }),
    );
    const result = await listRules({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('schema-missing');
    expect(result.rules).toEqual([]);
    expect(result.operatorStep).toMatch(/016_alert_rules\.sql/);
  });

  it('not-configured is distinct from schema-missing', async () => {
    const fetchImpl = vi.fn(async () =>
      response(503, { error: 'No rule store configured.', code: 'not-configured', operatorStep: 'Set SUPABASE_URL…' }),
    );
    const result = await listRules({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('not-configured');
    expect(result.operatorStep).toMatch(/SUPABASE_URL/);
  });

  it('a 200 with an unreadable body yields ready-with-nothing rather than fabricated rules', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    }) as unknown as Response);
    const result = await listRules({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.rules).toEqual([]);
  });

  it('a 500 is unreachable with the server’s own words when it gave any', async () => {
    const fetchImpl = vi.fn(async () => response(500, { error: 'boom' }));
    const result = await listRules({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('unreachable');
    expect(result.detail).toBe('boom');
  });

  it('writes degrade the same way reads do', async () => {
    const fetchImpl = vi.fn(async () => response(503, { error: 'no table', code: 'schema-missing' }));
    for (const call of [
      createRule({ kind: 'heat-tier', subject: SUBJECT as `0x${string}`, threshold: null }, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      deleteRule(ROW.id, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      toggleRule(ROW.id, false, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ]) {
      const result = await call;
      expect(result.status).toBe('schema-missing');
      expect(result.rules).toEqual([]);
    }
  });
});

describe('row coercion rejects rather than repairs', () => {
  it('accepts a well-formed row', () => {
    expect(coerceRule(ROW)).not.toBeNull();
  });

  it('drops a row with an unknown kind — a rule no evaluator understands is not a rule', () => {
    expect(coerceRule({ ...ROW, kind: 'price-prediction' })).toBeNull();
  });

  it('drops a row whose subject is not an address', () => {
    expect(coerceRule({ ...ROW, subject: 'not-an-address' })).toBeNull();
  });

  it('drops a row with no id', () => {
    expect(coerceRule({ ...ROW, id: undefined })).toBeNull();
  });

  it('a malformed row does not take the readable ones with it', async () => {
    const fetchImpl = vi.fn(async () => response(200, { rules: [ROW, { id: 'x' }] }));
    const result = await listRules({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('ready');
    expect(result.rules).toHaveLength(1);
  });
});
