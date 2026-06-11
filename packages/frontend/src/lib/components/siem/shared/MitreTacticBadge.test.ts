import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import MitreTacticBadge from './MitreTacticBadge.svelte';

describe('MitreTacticBadge', () => {
  it('renders a known tactic name for TA0001', () => {
    const { container } = render(MitreTacticBadge, { props: { tactic: 'TA0001' } });
    // getTacticName('TA0001') => 'Initial Access'
    expect(container.textContent).toContain('Initial Access');
  });

  it('renders raw tactic id when tactic is unknown', () => {
    const { container } = render(MitreTacticBadge, { props: { tactic: 'TA9999' } });
    expect(container.textContent).toContain('TA9999');
  });

  it('includes id in text when showId=true', () => {
    const { container } = render(MitreTacticBadge, { props: { tactic: 'TA0001', showId: true } });
    expect(container.textContent).toContain('TA0001');
  });

  it('renders as a link when clickable=true (default)', () => {
    const { container } = render(MitreTacticBadge, { props: { tactic: 'TA0001' } });
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.href).toContain('attack.mitre.org');
  });

  it('renders without a link when clickable=false', () => {
    const { container } = render(MitreTacticBadge, { props: { tactic: 'TA0001', clickable: false } });
    expect(container.querySelector('a')).toBeNull();
  });
});
