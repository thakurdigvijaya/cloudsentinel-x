/** Pure Utsav event-plan operations. Editing and replacing are distinct from intentionally adding a second event.
 * Returning new arrays ensures React recalculates all event holds and pending approval checks through setEvents. */
import type { PlannedEvent } from '../engine/utsav';

export type PlanEventMode = 'save' | 'replace' | 'add';

export function nextEventPlan(
  current: readonly PlannedEvent[],
  incoming: PlannedEvent,
  mode: PlanEventMode,
  editingId: string | null = null,
): PlannedEvent[] {
  if (mode === 'replace') return [incoming];
  if (mode === 'save') {
    if (!editingId || !current.some((e) => e.id === editingId)) throw new Error('The event being edited no longer exists. Select it again.');
    return current.map((e) => e.id === editingId ? { ...incoming, id: editingId } : e);
  }
  if (current.some((e) => e.id === incoming.id)) throw new Error('An event with this identity is already planned. Use Edit instead.');
  return [...current, incoming];
}
