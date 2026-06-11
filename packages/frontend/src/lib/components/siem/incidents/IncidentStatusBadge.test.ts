import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import IncidentStatusBadge from './IncidentStatusBadge.svelte';

describe('IncidentStatusBadge', () => {
  it('renders Open label for open status', () => {
    const { getByText } = render(IncidentStatusBadge, { props: { status: 'open' } });
    expect(getByText('Open')).toBeTruthy();
  });

  it('renders Investigating label for investigating status', () => {
    const { getByText } = render(IncidentStatusBadge, { props: { status: 'investigating' } });
    expect(getByText('Investigating')).toBeTruthy();
  });

  it('renders Resolved label for resolved status', () => {
    const { getByText } = render(IncidentStatusBadge, { props: { status: 'resolved' } });
    expect(getByText('Resolved')).toBeTruthy();
  });

  it('renders False Positive label for false_positive status', () => {
    const { getByText } = render(IncidentStatusBadge, { props: { status: 'false_positive' } });
    expect(getByText('False Positive')).toBeTruthy();
  });

  it('falls back to raw status for unknown value', () => {
    const { getByText } = render(IncidentStatusBadge, { props: { status: 'unknown_state' as 'open' } });
    expect(getByText('unknown_state')).toBeTruthy();
  });

  it('applies sm size class when size=sm', () => {
    const { container } = render(IncidentStatusBadge, { props: { status: 'open', size: 'sm' } });
    expect(container.innerHTML).toContain('text-xs');
  });

  it('hides icon when showIcon=false', () => {
    const { container } = render(IncidentStatusBadge, { props: { status: 'open', showIcon: false } });
    // icon is an svg; badge should still show text
    expect(container.querySelector('svg')).toBeNull();
  });
});
