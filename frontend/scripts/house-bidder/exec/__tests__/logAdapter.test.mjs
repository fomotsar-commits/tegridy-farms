// @vitest-environment node
//
// The data layer logs through makeLog(log), which calls a function logger as
// log(level, message, details). The CLI's own logger prints one line. Joined directly, every data
// message printed as just its level ("debug", "warn") and the text was lost: a failed chain read
// or an unreachable OpenSea showed up as a bare "warn". The adapter keeps the message.
import { describe, it, expect } from 'vitest';
import { levelLogger } from '../logAdapter.mjs';
import { makeLog } from '../../data/util.mjs';

const capture = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
};

describe('the data layer logs through the CLI with its message intact', () => {
  it('a warning keeps its text and says it is a warning', () => {
    const c = capture();
    makeLog(levelLogger(c.log)).warn('chain snapshot failed: HTTP request failed');
    expect(c.lines).toEqual(['warn: chain snapshot failed: HTTP request failed']);
  });

  it('info and error keep their text', () => {
    const c = capture();
    const out = makeLog(levelLogger(c.log));
    out.info('stream joined collection:junglebay');
    out.error('OpenSea could not be reached');
    expect(c.lines).toEqual(['stream joined collection:junglebay', 'error: OpenSea could not be reached']);
  });

  it('debug lines (one per OpenSea call) are dropped unless verbose', () => {
    const quiet = capture();
    makeLog(levelLogger(quiet.log)).debug('opensea GET /api/v2/collections/junglebay -> 200');
    expect(quiet.lines).toEqual([]);
    const loud = capture();
    makeLog(levelLogger(loud.log, { verbose: true })).debug('opensea GET /api/v2/collections/junglebay -> 200');
    expect(loud.lines).toEqual(['debug: opensea GET /api/v2/collections/junglebay -> 200']);
  });

  it('details are added as compact JSON, and bigint amounts do not throw', () => {
    const c = capture();
    makeLog(levelLogger(c.log)).warn('rate slowed', { remaining: 18, limit: 120, wei: 10n ** 16n });
    expect(c.lines).toEqual(['warn: rate slowed {"remaining":18,"limit":120,"wei":"10000000000000000"}']);
  });
});
