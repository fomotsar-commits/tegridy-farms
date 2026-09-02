// Guard for the rule builder.
//
// The builder is where a user commits to watching something, so it is the last
// place a false promise can be caught before it becomes silence. Three claims:
//
//   the form WORKS — it is never greyed out, because the store is always
//     writable-or-honest and a dead form has nothing a user can act on;
//   a kind whose source is dark is offered but GROUPED and LABELLED as
//     unreadable, at the moment of choosing rather than as a later empty inbox;
//   a resident's pool can be picked without typing a base58 id by hand, which is
//     the step where a Solana subject gets a character wrong.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AlertRuleBuilder } from './AlertRuleBuilder';
import type { AlertRule } from '../../lib/alerts/rules';

const BASE_PROPS = {
  rules: [] as readonly AlertRule[],
  limit: 10,
  writeError: null,
  storeWarning: null,
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  onToggle: vi.fn(),
};

function renderBuilder(over: Partial<typeof BASE_PROPS> = {}) {
  const props = { ...BASE_PROPS, ...over, onAdd: vi.fn(), onRemove: vi.fn(), onToggle: vi.fn() };
  render(<AlertRuleBuilder {...props} />);
  return props;
}

const select = () => screen.getByRole('combobox') as HTMLSelectElement;
const subjectInput = () => screen.getByPlaceholderText(/eth:0x…|address/i) as HTMLInputElement;

describe('the form is usable, and says where its rules live', () => {
  it('the Add control is enabled with no wallet and no session', () => {
    renderBuilder();
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeEnabled();
  });

  it('the header says the rules are saved in this browser, not against a wallet', () => {
    renderBuilder({ rules: [] });
    expect(screen.getByText(/Saved in this browser — 0 of 10/)).toBeInTheDocument();
    expect(screen.getByText(/not tied to a wallet/i)).toBeInTheDocument();
    // The old header read "0 of 3 (free tier)" over a store nobody could write to.
    expect(document.body.textContent).not.toMatch(/free tier|premium/i);
  });

  it('a store warning renders as a status on a form that still works', () => {
    renderBuilder({ storeWarning: 'These rules could not be written to this browser’s storage.' });
    expect(screen.getByRole('status').textContent).toMatch(/could not be written/i);
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeEnabled();
  });

  it('every control is a 44px target', () => {
    renderBuilder({
      rules: [{ id: 'r1', kind: 'heat-tier', subject: '0x' + '1'.repeat(40), threshold: null, enabled: true, createdAt: 0 }],
    });
    expect(select().className).toContain('min-h-11');
    expect(subjectInput().className).toContain('min-h-11');
    for (const name of ['Add rule', 'Turn off', 'Delete']) {
      expect(screen.getByRole('button', { name }).className, name).toContain('min-h-11');
    }
  });
});

describe('a dark kind is disclosed where it is chosen', () => {
  it('splits the kinds into readable and not, and marks the dark ones', () => {
    renderBuilder();
    const groups = select().querySelectorAll('optgroup');
    expect([...groups].map((g) => g.label)).toEqual(['Readable on this deployment', 'Cannot evaluate here yet']);

    const dark = groups[1]!;
    const labels = [...dark.querySelectorAll('option')].map((o) => o.textContent);
    // The indexer is unhosted AND has no transfer or lock tables, so these two
    // cannot be evaluated by any rail on this deployment.
    expect(labels).toEqual([
      'Whale move — not readable here',
      'LP unlock — not readable here',
    ]);
  });

  it('picking a dark kind explains that it will report “cannot evaluate”, not calm', () => {
    renderBuilder();
    fireEvent.change(select(), { target: { value: 'whale-move' } });
    expect(screen.getByText(/will not report calm/i)).toBeInTheDocument();
  });

  it('the readable group holds the pool kinds', () => {
    renderBuilder();
    const readable = [...select().querySelectorAll('optgroup')[0]!.querySelectorAll('option')].map((o) => o.value);
    expect(readable).toContain('pool-price-above');
    expect(readable).toContain('pool-large-trade');
  });
});

describe('an island resident can be watched without typing a pool id', () => {
  it('fills PEPE’s subject in canonical network:pool form', () => {
    renderBuilder();
    fireEvent.click(screen.getByRole('button', { name: /^PEPE —/ }));
    expect(subjectInput().value).toBe('eth:0xa43fe16908251ee70ef74718545e4fe6c5ccec9f');
    // And selects a kind the subject is actually valid for, so the very next
    // click cannot produce a validation error the user did not cause.
    expect(select().value).toBe('pool-price-above');
  });

  it('fills BAYLA’s Solana pool BYTE-FOR-BYTE', () => {
    renderBuilder();
    fireEvent.click(screen.getByRole('button', { name: /^BAYLA —/ }));
    // Base58 is case-sensitive: lower-casing this anywhere on the path points
    // the rule at a pool that does not exist, and it then reports calm forever.
    expect(subjectInput().value).toBe('solana:8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n');
  });

  it('every quick-pick is a 44px target with a name that says which pair', () => {
    renderBuilder();
    const group = screen.getByRole('group', { name: 'Watch an island resident' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) {
      expect(button.className).toContain('min-h-11');
      expect(button.textContent ?? '').toMatch(/ — .+ \/ /);
    }
  });

  it('the subject field refuses the browser’s help with case', () => {
    renderBuilder();
    fireEvent.change(select(), { target: { value: 'pool-price-above' } });
    const input = subjectInput();
    // A helpfully capitalised first letter is a different pool, or no pool.
    expect(input.getAttribute('autocapitalize')).toBe('none');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });
});

describe('the rule list names what it watches', () => {
  it('shows a resident’s pair label beside a pool rule', () => {
    renderBuilder({
      rules: [
        {
          id: 'r1',
          kind: 'pool-price-above',
          subject: 'solana:8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n',
          threshold: 0.01,
          enabled: true,
          createdAt: 0,
        },
      ],
    });
    // Scoped to the LIST: the quick-pick strip names the same pair, and a
    // page-wide match would pass on the button alone.
    const list = screen.getByRole('list');
    expect(within(list).getByText(/BAYLA \/ SOL/)).toBeInTheDocument();
    expect(within(list).getByText(/Quoted price of solana pool/)).toBeInTheDocument();
  });

  it('marks a rule whose source is not readable here', () => {
    renderBuilder({
      rules: [{ id: 'r1', kind: 'whale-move', subject: '0x' + '2'.repeat(40), threshold: 1000, enabled: true, createdAt: 0 }],
    });
    expect(screen.getByText(/source not readable here/i)).toBeInTheDocument();
  });
});
