import { describe, it, expect, afterEach } from 'vitest';
import { getFocusable } from './trapFocus';

describe('getFocusable (Naka focus trap)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(html) {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }

  it('returns enabled, focusable controls in DOM order', () => {
    const root = mount(`
      <a href="#one">one</a>
      <button>two</button>
      <input />
    `);
    const els = getFocusable(root);
    expect(els.map((e) => e.tagName)).toEqual(['A', 'BUTTON', 'INPUT']);
  });

  it('excludes disabled buttons (the F800 bug)', () => {
    const root = mount(`
      <button id="keep">enabled</button>
      <button id="drop" disabled>buying…</button>
    `);
    const els = getFocusable(root);
    expect(els).toHaveLength(1);
    expect(els[0].id).toBe('keep');
  });

  it('excludes disabled inputs and tabindex=-1', () => {
    const root = mount(`
      <input id="a" />
      <input id="b" disabled />
      <div id="c" tabindex="-1">nope</div>
      <div id="d" tabindex="0">yep</div>
    `);
    const ids = getFocusable(root).map((e) => e.id);
    expect(ids).toContain('a');
    expect(ids).toContain('d');
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('c');
  });

  it('returns [] for a null container', () => {
    expect(getFocusable(null)).toEqual([]);
    expect(getFocusable(undefined)).toEqual([]);
  });
});
