// @vitest-environment node
// The pool index reader's own wrapper: a fetch that throws becomes `unread` with the
// cause inside "the pool index did not answer (...)", except when the cause already
// names the index (the 20-second timeout from readFetch.ts), which is kept as it is so
// the visitor never reads the sentence twice in one bracket.
import { describe, expect, it } from 'vitest';
import { readPoolIndex } from './poolIndex';
import { timeoutDetail } from './readFetch';

const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
const MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';

function throwing(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe('readPoolIndex when the fetch throws', () => {
  it('keeps the timeout sentence whole, never nested inside its own wrapper', async () => {
    const read = await readPoolIndex({ mint: MINT }, PROGRAM, throwing(timeoutDetail('the pool index')));
    expect(read).toEqual({ kind: 'unread', detail: 'the pool index did not answer in 20 seconds' });
  });

  it('wraps any other cause in the index sentence', async () => {
    const read = await readPoolIndex({ mint: MINT }, PROGRAM, throwing('socket hang up'));
    expect(read).toEqual({ kind: 'unread', detail: 'the pool index did not answer (socket hang up)' });
  });
});
