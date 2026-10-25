import { describe, expect, it } from 'vitest';
import { nextEventPlan } from '../utsavPlan';
import type { PlannedEvent } from '../../engine/utsav';
const a: PlannedEvent = { id:'a', name:'Sale', start:'2026-11-02', end:'2026-11-03', loadMultiplier:2, envs:['prod'] };
const b: PlannedEvent = { id:'b', name:'Diwali', start:'2026-11-08', end:'2026-11-10', loadMultiplier:3, envs:['prod'] };
describe('Utsav plan operations', () => {
  it('replaces the entire old plan instead of silently appending', () => {
    expect(nextEventPlan([a,b], { ...a, name:'New sale' }, 'replace')).toEqual([{ ...a, name:'New sale' }]);
  });
  it('edits only the selected existing event and preserves its identity', () => {
    expect(nextEventPlan([a,b],{ ...a, id:'other', loadMultiplier:4 },'save','a'))
      .toEqual([{ ...a, loadMultiplier:4 }, b]);
  });
  it('intentionally adds a separate event', () => expect(nextEventPlan([a], b,'add')).toEqual([a,b]));
  it('does not duplicate the same event identity', () => expect(() => nextEventPlan([a],a,'add')).toThrow(/Edit/));
  it('does not pretend stale edit succeeded', () => expect(() => nextEventPlan([a],b,'save','missing')).toThrow(/no longer exists/));
  it('never mutates the previous plan', () => {
    const old = [a,b];
    nextEventPlan(old,{...a,loadMultiplier:5},'save','a');
    expect(old).toEqual([a,b]);
  });
});
