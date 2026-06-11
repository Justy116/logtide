import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import SeverityBadge from './SeverityBadge.svelte';

describe('SeverityBadge', () => {
  it('renders Critical label for critical', () => {
    const { getByText } = render(SeverityBadge, { props: { severity: 'critical' } });
    expect(getByText('Critical')).toBeTruthy();
  });

  it('renders High label for high', () => {
    const { getByText } = render(SeverityBadge, { props: { severity: 'high' } });
    expect(getByText('High')).toBeTruthy();
  });

  it('renders Medium label for medium', () => {
    const { getByText } = render(SeverityBadge, { props: { severity: 'medium' } });
    expect(getByText('Medium')).toBeTruthy();
  });

  it('renders Low label for low', () => {
    const { getByText } = render(SeverityBadge, { props: { severity: 'low' } });
    expect(getByText('Low')).toBeTruthy();
  });

  it('renders Info label for informational', () => {
    const { getByText } = render(SeverityBadge, { props: { severity: 'informational' } });
    expect(getByText('Info')).toBeTruthy();
  });

  it('falls back to raw value for unknown severity', () => {
    // cast to bypass type check for edge-case test
    const { getByText } = render(SeverityBadge, { props: { severity: 'unknown_level' as 'low' } });
    expect(getByText('unknown_level')).toBeTruthy();
  });

  it('applies sm size class when size=sm', () => {
    const { container } = render(SeverityBadge, { props: { severity: 'high', size: 'sm' } });
    expect(container.innerHTML).toContain('text-xs');
  });
});
