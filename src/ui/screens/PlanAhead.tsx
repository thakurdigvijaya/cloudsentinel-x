// Plan Ahead: fleet what-if (the brief's own example), Utsav Mode (upcoming events) and 30–90 day forecasts.
// Everything here is a PREVIEW except "Plan for these events", which adds hold dates (never changes savings).
import { useMemo, useState } from 'react';
import { aggregate } from '../../engine/decisions';
import { forecastCapacity, forecastSpend } from '../../engine/forecast';
import { dailySpend } from '../../engine/spend';
import type { Env } from '../../engine/types';
import { EVENT_PRESETS, validateEvent, type PlannedEvent } from '../../engine/utsav';
import { fleetWhatIf, FLEET_WINDOWS, type FleetWindow } from '../../engine/whatif';
import { Badge, Empty, Section } from '../components';
import { inr } from '../format';
import { todayIst, useApp } from '../store';
import { nextEventPlan, type PlanEventMode } from '../utsavPlan';

const ENVS: Env[] = ['prod', 'staging', 'dev'];

export function PlanAhead() {
  return (
    <div className="stack">
      <WhatIf />
      <Utsav />
      <Forecast />
    </div>
  );
}

function WhatIf() {
  const { data } = useApp();
  const [win, setWin] = useState<FleetWindow>('nights');
  const [envs, setEnvs] = useState<Env[]>(['dev']);
  const r = useMemo(() => fleetWhatIf(data.resources, data.series, win, { env: envs }), [data, win, envs]);
  const toggle = (e: Env) => setEnvs((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));
  return (
    <Section title="What if we shut down…" right={<Badge tone="accent">preview · nothing is approved</Badge>}>
      <div className="form-row">
        <label>
          When
          <select value={win} onChange={(e) => setWin(e.target.value as FleetWindow)}>
            {(Object.keys(FLEET_WINDOWS) as FleetWindow[]).map((w) => (
              <option key={w} value={w}>
                {FLEET_WINDOWS[w].label}
              </option>
            ))}
          </select>
        </label>
        <div className="chips" role="group" aria-label="Environments">
          {ENVS.map((e) => (
            <button key={e} className={envs.includes(e) ? 'chip active' : 'chip'} aria-pressed={envs.includes(e)} onClick={() => toggle(e)}>
              all {e} VMs
            </button>
          ))}
        </div>
      </div>
      <p>{r.summary}</p>
      <div className="kpis">
        <div className="card inset">
          <div className="label">Naive saving (all {r.counts.total})</div>
          <div className="big">{inr(r.savingAllInr)}/mo</div>
        </div>
        <div className="card inset">
          <div className="label">Defensible (quiet only, {r.counts.quiet})</div>
          <div className="big tone-pass">{inr(r.savingQuietInr)}/mo</div>
        </div>
        <div className="card inset">
          <div className="label">Busy in that window</div>
          <div className="big tone-fail">{r.counts.active}</div>
        </div>
        <div className="card inset">
          <div className="label">Not enough data</div>
          <div className="big tone-unknown">{r.counts.insufficient}</div>
        </div>
      </div>
      {r.counts.active > 0 && (
        <details>
          <summary>Which VMs would be interrupted, and why</summary>
          <ul className="reasons small">
            {r.vms
              .filter((v) => v.status === 'active')
              .map((v) => (
                <li key={v.resourceId}>
                  <b>{v.name}</b> ({v.env}) — {v.reason}
                </li>
              ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

function Utsav() {
  const { state, utsav, dispatch } = useApp();
  const preset = EVENT_PRESETS[0];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState(preset.name);
  const [start, setStart] = useState(preset.start);
  const [end, setEnd] = useState(preset.end);
  const [mult, setMult] = useState(2);
  const [envs, setEnvs] = useState<Env[]>(['prod']);
  const [feedback, setFeedback] = useState('');
  const toggle = (e: Env) => setEnvs((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));
  const loadForm = (e: PlannedEvent) => {
    setEditingId(e.id); setName(e.name); setStart(e.start); setEnd(e.end);
    setMult(e.loadMultiplier); setEnvs(e.envs?.length ? [...e.envs] : ['prod']);
    setFeedback(`Editing ${e.name}. Save changes to update the existing event.`);
  };
  const cancelEdit = () => { setEditingId(null); setFeedback(''); };
  const makeEvent = (): PlannedEvent => ({
    id: editingId ?? `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim(), start, end, loadMultiplier: mult, envs,
    source: 'entered by the team in Plan Ahead',
  });
  const save = (mode: PlanEventMode) => {
    const ev = makeEvent();
    const errors = [...validateEvent(ev), ...(envs.length === 0 ? ['Select at least one environment.'] : [])];
    if (errors.length) { setFeedback(errors[0]); return; }
    // All three actions are explicit. Unlike the old form, the primary action never silently appends indefinitely.
    let next: PlannedEvent[];
    try { next = nextEventPlan(state.events, ev, mode, editingId); }
    catch (err) { setFeedback(err instanceof Error ? err.message : 'Unable to change events.'); return; }
    dispatch({ type: 'setEvents', events: next, asOf: todayIst() });
    setEditingId(null);
    setFeedback(mode === 'replace' ? 'Previous plan replaced. Holds and savings recalculated.' : mode === 'save' && editingId ? 'Event updated. Holds and savings recalculated.' : 'Event added to the existing plan.');
  };
  const remove = (id: string) => {
    dispatch({ type: 'setEvents', events: state.events.filter((e) => e.id !== id), asOf: todayIst() });
    if (editingId === id) setEditingId(null);
    setFeedback('Event removed. Holds and savings recalculated.');
  };
  return (
    <Section title="Utsav Mode — will today's resizes survive Diwali, a sale or an IPL final?" right={<Badge tone="accent">{state.events.length} planned event{state.events.length === 1 ? '' : 's'}</Badge>}>
      <p className="muted small">Your team declares dates and expected load. This is a planning simulation, not a forecast of the event itself. Edit or replace planned events at any time; an update rechecks pending and recorded decisions.</p>
      <div className="utsav-editor">
        <div className="utsav-editor-head"><strong>{editingId ? 'Edit planned event' : 'Plan a traffic event'}</strong><span className="muted small">Example: Diwali 2026 · 8 Nov festival date; affected window is team-defined</span></div>
        <div className="form-row">
          <label>Event<input value={name} onChange={(e) => setName(e.target.value)} aria-label="Event name" /></label>
          <label>From<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label>To<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          <label>Load × normal<input type="number" min={1} max={20} step={0.1} value={mult} onChange={(e) => setMult(Number(e.target.value))} /></label>
        </div>
        <div className="chips" role="group" aria-label="Affected environments">
          {ENVS.map((e) => <button type="button" key={e} className={envs.includes(e) ? 'chip active' : 'chip'} aria-pressed={envs.includes(e)} onClick={() => toggle(e)}>{e}</button>)}
        </div>
        <div className="actions utsav-actions">
          {editingId ? <>
            <button type="button" onClick={() => save('save')}>Save changes</button>
            <button type="button" className="ghost" onClick={cancelEdit}>Cancel editing</button>
          </> : <>
            <button type="button" onClick={() => save('replace')}>Replace current plan</button>
            <button type="button" className="ghost" onClick={() => save('add')}>+ Add another event</button>
          </>}
        </div>
        {feedback && <p className="muted small" role="status">{feedback}</p>}
      </div>
      {utsav?.errors.length ? <ul className="error-list">{utsav.errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
      {state.events.length === 0 ? <Empty>No events planned. Add one above to check future workload impact.</Empty> : <>
        <div className="utsav-planned-head"><b>Current event plan</b><button type="button" className="ghost small" onClick={() => { dispatch({ type: 'setEvents', events: [], asOf: todayIst() }); setEditingId(null); setFeedback('All events cleared; hold calculations reset.'); }}>Clear all events</button></div>
        <ul className="decision-list utsav-events">
          {state.events.map((e) => <li key={e.id}>
            <span><b>{e.name}</b><span className="muted small"> · {e.start} → {e.end} · load ×{e.loadMultiplier} · {(e.envs ?? ['prod']).join(', ')}</span></span>
            <span className="actions"><button type="button" className="ghost small" onClick={() => loadForm(e)}>Edit</button><button type="button" className="ghost small" onClick={() => remove(e.id)}>Remove</button></span>
          </li>)}
        </ul>
        {utsav && utsav.errors.length === 0 && <>
          <p><Badge tone="pass">{utsav.counts['safe-through-event']} safe through event</Badge>{' '}<Badge tone="warn">{utsav.counts['hold-until-after']} on hold</Badge>{' '}<Badge tone="fail">{utsav.counts['current-also-at-risk']} current size at risk</Badge>{' '}
            {utsav.heldSavingInr > 0 && <span className="muted small"> · {inr(utsav.heldSavingInr)}/mo deferred until after event</span>}
          </p>
          {utsav.results.length === 0 ? <Empty>No eligible resize affected by these events.</Empty> : <details className="utsav-impact"><summary>Review {utsav.results.length} evidence-backed event checks</summary>
            <ul className="reasons small">{utsav.results.map((x) => <li key={x.recommendationId + x.eventId} className={x.status === 'safe-through-event' ? '' : x.status === 'hold-until-after' ? 'tone-warn' : 'tone-fail'}>
              <b>{state.recommendations.find((r) => r.id === x.recommendationId)?.resourceName}</b>: {x.message}
            </li>)}</ul>
          </details>}
          <p className="muted small">Any new event hold is reflected in current recommendations and change scripts. No cloud resource is changed automatically.</p>
        </>}
      </>}
    </Section>
  );
}

function Forecast() {
  const { state, data } = useApp();
  const totals = useMemo(() => aggregate(data.resources, state.recommendations, state.decisions), [data.resources, state.recommendations, state.decisions]);
  const spend = useMemo(() => forecastSpend(dailySpend(data.resources, data.start, Math.round(data.days)), totals.eligibleInr), [data, totals.eligibleInr]);
  const risky = useMemo(
    () =>
      data.resources
        .filter((r) => r.type === 'vm' && data.series.has(r.id))
        .map((r) => ({ r, f: forecastCapacity(r, data.series.get(r.id)!, 'cpu') }))
        .filter((x) => x.f && x.f.daysToLimit !== null)
        .sort((a, b) => a.f!.daysToLimit! - b.f!.daysToLimit!),
    [data],
  );
  return (
    <Section title="Forecast — next 30 / 60 / 90 days" right={<span className="muted small">trends, not promises</span>}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Horizon</th>
              <th className="num">If nothing changes (run-rate)</th>
              <th className="num">If growth continues (trend)</th>
              <th className="num">After all safe savings</th>
            </tr>
          </thead>
          <tbody>
            {spend.points.map((p) => (
              <tr key={p.days}>
                <td>{p.days} days</td>
                <td className="num mono">{inr(p.runRateInr)}</td>
                <td className="num mono">{inr(p.trendInr)}</td>
                <td className="num mono tone-pass">{inr(p.runRateAfterSavingsInr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">{spend.method}</p>
      <h3>VMs whose CPU trend reaches the 85% capacity limit within 90 days ({risky.length})</h3>
      {risky.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <ul className="reasons small">
          {risky.map(({ r, f }) => (
            <li key={r.id}>
              <b>{r.name}</b> ({r.env}) — {f!.daysToLimit === 0 ? 'already at the limit' : `in about ${f!.daysToLimit} days`} · daily p95 now {f!.currentDailyP95.toFixed(1)}%, {f!.slopePerDay >= 0 ? '+' : ''}
              {f!.slopePerDay.toFixed(2)} points/day
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
