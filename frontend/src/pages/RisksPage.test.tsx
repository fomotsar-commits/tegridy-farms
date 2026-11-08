// Island answer twenty-six's owed line (the word walk's DEBT on /risks): the Risks page's launcher
// heading read as if launching were open. While the launch door is closed (lib/launcher/door.ts)
// the heading says so first, in the venue's plain words, and the owner's legal copy under it is
// kept word for word behind one plain sentence. Once the door opens the owner's heading reads as
// written.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/analytics', () => ({ trackPageView: () => {} }));

const OWNERS_HEADING = 'Anyone can launch a token, and a launch is permanent';
const CLOSED_HEADING = 'Launching a new token here is not switched on yet; once it is, anyone can, and a launch is permanent';

async function mount(open: boolean) {
  vi.resetModules();
  vi.doMock('../lib/launcher/door', () => ({ LAUNCH_DOOR_OPEN: open, isLaunchDoorOpen: () => open }));
  const { default: RisksPage } = await import('./RisksPage');
  return render(
    <MemoryRouter initialEntries={['/risks']}>
      <RisksPage />
    </MemoryRouter>,
  );
}

// The page draws each risk's heading in two places, and takes seconds to render under jsdom.
const headings = (name: string) => screen.queryAllByRole('heading', { name });
const SLOW = 60_000;

describe('the Risks page while launching is not switched on', () => {
  it('says so first in the launcher risk’s heading, and the page never reads "launch a token"', async () => {
    const { container } = await mount(false);
    expect(headings(CLOSED_HEADING).length).toBeGreaterThan(0);
    expect(headings(OWNERS_HEADING)).toHaveLength(0);
    expect(container.textContent).not.toMatch(/\blaunch a token\b/i);
    // One plain sentence, then the owner's legal copy word for word.
    expect(container.textContent).toContain(
      'Launching a new token here is not switched on yet, on any rail. What follows describes the launcher once it opens. The token launcher is permissionless: there is no application, no human approval and no allowlist',
    );
  }, SLOW);

  it('reads the owner’s heading and copy as written once the door is open', async () => {
    const { container } = await mount(true);
    expect(headings(OWNERS_HEADING).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('not switched on yet');
    expect(container.textContent).toContain('The token launcher is permissionless:');
  }, SLOW);
});
