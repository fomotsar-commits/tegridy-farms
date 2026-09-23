import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SafetyInspector } from './SafetyInspector';
import { componentRead, componentUnread, type RowSafety } from '../../lib/terminal/rowSafety';

// "Heat standing" prints the tier the island served beside the wallet, never the bands'
// word for its degrees: 95 degrees served as Observer reads Observer, not Resident.
const SAFETY: RowSafety = {
  kind: 'unscored',
  missing: ['deployer'],
  reasons: ['No deployer was given.'],
  heat: componentRead({ tier: 'Observer', degrees: 95, isCold: false }),
};

function mount(safety: RowSafety = SAFETY) {
  return render(
    <SafetyInspector token="0xabc" safety={safety} loading={false} deployer="" onDeployerChange={() => undefined} />,
  );
}

describe('the heat standing', () => {
  it('names the wallet by its served tier, where the bands would name another', () => {
    const { container } = mount();
    expect(screen.getByText('Observer · 95 degrees')).toBeTruthy();
    expect(container.textContent).not.toContain('Resident');
  });

  it('says why when there is no reading, and names no tier', () => {
    const { container } = mount({ ...SAFETY, heat: componentUnread('Heat could not be read.') });
    expect(screen.getByText('Heat could not be read.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Observer|Resident|Builder|Elder|Drifter/);
  });
});
