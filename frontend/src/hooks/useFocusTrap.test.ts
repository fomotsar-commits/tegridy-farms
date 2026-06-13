import { describe, it, expect, afterEach } from 'vitest';
import { getFocusableDescendants } from './useFocusTrap';

// jsdom reports offsetParent === null for every element (no layout engine), so
// the real-browser visibility filter would drop everything. Stub offsetParent
// to a truthy value for the nodes under test so we exercise the selector logic
// the way a browser would. This mirrors the standard jsdom focus-trap pattern.
function makeVisible(root: HTMLElement) {
  root.querySelectorAll('*').forEach((el) => {
    Object.defineProperty(el, 'offsetParent', {
      configurable: true,
      get() {
        return document.body;
      },
    });
  });
}

describe('getFocusableDescendants (shared useFocusTrap)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);
    makeVisible(root);
    return root;
  }

  it('returns enabled, focusable controls in DOM order', () => {
    const root = mount(`
      <a href="#one">one</a>
      <button>two</button>
      <input />
      <select></select>
      <textarea></textarea>
    `);
    const els = getFocusableDescendants(root);
    expect(els.map((e) => e.tagName)).toEqual([
      'A',
      'BUTTON',
      'INPUT',
      'SELECT',
      'TEXTAREA',
    ]);
  });

  it('excludes disabled controls', () => {
    const root = mount(`
      <button id="keep">enabled</button>
      <button id="drop" disabled>saving…</button>
      <input id="ki" />
      <input id="di" disabled />
    `);
    const ids = getFocusableDescendants(root).map((e) => e.id);
    expect(ids).toContain('keep');
    expect(ids).toContain('ki');
    expect(ids).not.toContain('drop');
    expect(ids).not.toContain('di');
  });

  it('respects tabindex (skips -1, keeps >=0)', () => {
    const root = mount(`
      <div id="a" tabindex="-1">nope</div>
      <div id="b" tabindex="0">yep</div>
    `);
    const ids = getFocusableDescendants(root).map((e) => e.id);
    expect(ids).toContain('b');
    expect(ids).not.toContain('a');
  });

  it('skips anchors without href', () => {
    const root = mount(`
      <a id="nolink">no href</a>
      <a id="link" href="#x">href</a>
    `);
    const ids = getFocusableDescendants(root).map((e) => e.id);
    expect(ids).toEqual(['link']);
  });
});
