import { describe, it, expect } from 'vitest';
import { classifySourceCodeResponse } from './useSourceVerification';

// The badge exists to be TRUSTED, so the classifier has one load-bearing rule:
//
//   a non-answer must never become a verdict.
//
// Rendering "source unverified" because Etherscan rate-limited us would have the
// page libel our own live contracts. Rendering "source verified" on a malformed
// payload would be worse — the badge's entire value is that a skeptic can rely
// on it. Both failure directions must collapse to 'unchecked'.
describe('classifySourceCodeResponse', () => {
  const verified = {
    status: '1',
    result: [{ ContractName: 'GaugeController', SourceCode: 'contract GaugeController {}' }],
  };

  it('reports verified only when BOTH ContractName and SourceCode are present', () => {
    expect(classifySourceCodeResponse(verified)).toBe('verified');
  });

  it('reports unverified for a clean negative (empty fields — unverified contract or EOA)', () => {
    // This is the real shape Etherscan returns for an EOA, confirmed live.
    expect(classifySourceCodeResponse({ status: '1', result: [{ ContractName: '', SourceCode: '' }] }))
      .toBe('unverified');
  });

  it('does NOT claim verified when only one of the two fields is present', () => {
    expect(classifySourceCodeResponse({ status: '1', result: [{ ContractName: 'X', SourceCode: '' }] }))
      .toBe('unverified');
    expect(classifySourceCodeResponse({ status: '1', result: [{ ContractName: '', SourceCode: 'x' }] }))
      .toBe('unverified');
  });

  // ── the honesty rule: failures are 'unchecked', never 'unverified' ──
  it('returns unchecked (NOT unverified) for an Etherscan error payload', () => {
    expect(classifySourceCodeResponse({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }))
      .toBe('unchecked');
  });

  it('returns unchecked for the deprecated-v1 style response', () => {
    expect(classifySourceCodeResponse({
      status: '0', message: 'NOTOK', result: 'You are using a deprecated V1 endpoint',
    })).toBe('unchecked');
  });

  it('returns unchecked for malformed / empty / missing payloads', () => {
    expect(classifySourceCodeResponse(null)).toBe('unchecked');
    expect(classifySourceCodeResponse(undefined)).toBe('unchecked');
    expect(classifySourceCodeResponse({})).toBe('unchecked');
    expect(classifySourceCodeResponse({ status: '1' })).toBe('unchecked');
    expect(classifySourceCodeResponse({ status: '1', result: [] })).toBe('unchecked');
    expect(classifySourceCodeResponse({ status: '1', result: 'not-an-array' })).toBe('unchecked');
    expect(classifySourceCodeResponse('a string')).toBe('unchecked');
  });

  it('never returns verified for anything that is not a well-formed success', () => {
    const hostile = [
      null, undefined, {}, 'x', 0, [],
      { status: '0', result: [{ ContractName: 'X', SourceCode: 'y' }] }, // error status wins
      { status: 1, result: [{ ContractName: 'X', SourceCode: 'y' }] },   // numeric status, not '1'
      { result: [{ ContractName: 'X', SourceCode: 'y' }] },              // no status
    ];
    for (const h of hostile) expect(classifySourceCodeResponse(h)).not.toBe('verified');
  });

  it('does not treat non-string field types as present', () => {
    // A payload shape change upstream must not be able to fake a verification.
    expect(classifySourceCodeResponse({ status: '1', result: [{ ContractName: 1, SourceCode: true }] }))
      .toBe('unverified');
  });
});
