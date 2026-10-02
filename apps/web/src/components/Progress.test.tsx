import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Progress, pctPaginas } from './Progress';

describe('Progress', () => {
  it('sem total de páginas fica indeterminada (não finge 50%)', () => {
    expect(pctPaginas(3, undefined)).toBeNull();
    render(<Progress pct={pctPaginas(3, undefined)} />);
    const b = screen.getByRole('progressbar');
    expect(b.getAttribute('data-indeterminate')).toBe('true');
    expect(b.getAttribute('aria-valuenow')).toBeNull();
  });
  it('com total mostra a porcentagem real', () => {
    expect(pctPaginas(1, 4)).toBe(25);
    render(<Progress pct={25} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
  });
});
