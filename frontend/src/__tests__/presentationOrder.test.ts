import { describe, it, expect } from 'vitest';
import { reconcileOrder } from '../pages/presentationOrder';

describe('reconcileOrder', () => {
  it('returns natural order when there is no saved order', () => {
    expect(reconcileOrder(['a', 'b', 'c'], undefined)).toEqual(['a', 'b', 'c']);
    expect(reconcileOrder(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('applies the saved order when it matches the live ids', () => {
    expect(reconcileOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('appends newly-generated sections in natural order after the saved ones', () => {
    expect(reconcileOrder(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('drops saved ids that are no longer live', () => {
    expect(reconcileOrder(['a', 'b'], ['b', 'x', 'a', 'y'])).toEqual(['b', 'a']);
  });

  it('de-duplicates a saved order containing repeats', () => {
    expect(reconcileOrder(['a', 'b', 'c'], ['b', 'b', 'a'])).toEqual(['b', 'a', 'c']);
  });

  it('always returns exactly the live id set', () => {
    const live = ['a', 'b', 'c'];
    const result = reconcileOrder(live, ['z', 'c', 'q']);
    expect([...result].sort()).toEqual([...live].sort());
  });

  it('does not mutate the input arrays', () => {
    const natural = ['a', 'b'];
    const saved = ['b', 'a'];
    reconcileOrder(natural, saved);
    expect(natural).toEqual(['a', 'b']);
    expect(saved).toEqual(['b', 'a']);
  });
});
