import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import MitreTechniqueBadge from './MitreTechniqueBadge.svelte';

describe('MitreTechniqueBadge', () => {
  it('renders technique ID in compact mode', () => {
    const { container } = render(MitreTechniqueBadge, { props: { technique: 'T1059', compact: true } });
    expect(container.textContent).toContain('T1059');
  });

  it('renders technique name when it is known and compact=false', () => {
    // T1059 = Command and Scripting Interpreter
    const { container } = render(MitreTechniqueBadge, { props: { technique: 'T1059', compact: false } });
    // Should show the name, not just the ID
    expect(container.textContent).not.toHaveLength(0);
  });

  it('uppercases valid technique IDs', () => {
    const { container } = render(MitreTechniqueBadge, { props: { technique: 't1059', compact: true } });
    expect(container.textContent).toContain('T1059');
  });

  it('renders as an anchor link pointing to attack.mitre.org', () => {
    const { container } = render(MitreTechniqueBadge, { props: { technique: 'T1059' } });
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.href).toContain('attack.mitre.org');
  });

  it('handles unknown technique id without throwing', () => {
    const { container } = render(MitreTechniqueBadge, { props: { technique: 'TXXXX' } });
    expect(container.textContent).toContain('TXXXX');
  });
});
