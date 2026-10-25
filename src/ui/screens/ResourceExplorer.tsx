import { useEffect, useMemo, useRef, useState } from 'react';
import { resourceMonthlyCost, sizeLabel } from '../../engine/pricing';
import type { Resource } from '../../engine/types';
import { hourlyMax } from '../../lib/downsample';
import { directDependents, transitiveDependents } from '../../engine/dependencies';
import { forecastCapacity } from '../../engine/forecast';
import { Empty, LineChart, Section, VerdictBadge } from '../components';
import { ACTION, inr, pct } from '../format';
import { useApp, type Filters } from '../store';
import { TelemetryPanels } from '../TelemetryPanels';

export function FilterBar() {
  const { state, data, dispatch } = useApp();
  const f = state.filters;
  const set = (patch: Partial<Filters>) => dispatch({ type: 'filter', patch });
  return (
    <div className="filters" role="search">
      <input placeholder="Search name or id…" value={f.search} onChange={(e) => set({ search: e.target.value })} aria-label="Search resources" />
      <select value={f.region} onChange={(e) => set({ region: e.target.value as Filters['region'] })} aria-label="Region">
        <option value="all">All regions</option>
        <option value="noida">Noida</option>
        <option value="bengaluru">Bengaluru</option>
        <option value="mumbai">Mumbai</option>
      </select>
      <select value={f.env} onChange={(e) => set({ env: e.target.value as Filters['env'] })} aria-label="Environment">
        <option value="all">All environments</option>
        <option value="prod">prod</option>
        <option value="staging">staging</option>
        <option value="dev">dev</option>
      </select>
      <select value={f.team} onChange={(e) => set({ team: e.target.value })} aria-label="Team">
        <option value="all">All teams</option>
        {data.teams.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <select value={f.type} onChange={(e) => set({ type: e.target.value as Filters['type'] })} aria-label="Type">
        <option value="all">All types</option>
        <option value="vm">VMs</option>
        <option value="volume">Volumes</option>
        <option value="ip">Public IPs</option>
      </select>
      <button className="ghost" onClick={() => set({ region: 'all', env: 'all', team: 'all', type: 'all', search: '' })}>
        Clear
      </button>
    </div>
  );
}

export function matchesFilters(r: Resource, f: Filters) {
  const q = f.search.trim().toLowerCase();
  return (
    (f.region === 'all' || r.region === f.region) &&
    (f.env === 'all' || r.env === f.env) &&
    (f.team === 'all' || r.team === f.team) &&
    (f.type === 'all' || r.type === f.type) &&
    (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
  );
}

const PAGE_SIZE = 18;

export function ResourceExplorer() {
  const { state, data, dispatch } = useApp();
  const [page, setPage] = useState(1);
  const detailRef = useRef<HTMLDivElement>(null);
  const recByResource = useMemo(() => new Map(state.recommendations.map((r) => [r.resourceId, r])), [state.recommendations]);
  const rows = useMemo(
    () => data.resources.filter((r) => matchesFilters(r, state.filters)).sort((a, b) => resourceMonthlyCost(b) - resourceMonthlyCost(a)),
    [data.resources, state.filters],
  );
  const selected = state.selectedResourceId ? data.resourceById.get(state.selectedResourceId) ?? null : null;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const eligibleCount = useMemo(() => rows.filter((r) => recByResource.get(r.id)?.eligible).length, [rows, recByResource]);
  const currentPage = Math.min(page, pageCount);
  const visibleRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => setPage(1), [state.filters, data.id]);
  useEffect(() => {
    // Detail is an independently scrolling panel: selecting a second VM should always start at its summary.
    detailRef.current?.scrollTo({ top: 0 });
    // On narrow screens the list and detail stack vertically. Bring the result into view, without a page jump on desktop.
    if (selected && typeof window !== 'undefined' && window.matchMedia('(max-width: 1150px)').matches) {
      detailRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, [selected?.id]);

  const select = (id: string) => dispatch({ type: 'select', resourceId: id });
  return (
    <div className="stack resource-explorer">
      <FilterBar />
      <div className="resource-layout">
        <Section title={`Resource fleet · ${rows.length} matching`} right={<span className="muted small">Select a resource to inspect →</span>}>
          {rows.length === 0 ? <Empty>No resources match these filters.</Empty> : <>
            <div className="resource-fleet-insight"><span className="tone-pass">● {eligibleCount} eligible resources</span><span className="muted small">Filtered fleet · decision evidence in the right panel</span></div>
            <div className="resource-list-scroll" aria-label="Resource list">
              <table className="resource-compact-table">
                <thead><tr><th>Resource</th><th>Location</th><th className="num">Cost/mo</th><th>Decision</th></tr></thead>
                <tbody>
                  {visibleRows.map((r) => {
                    const rec = recByResource.get(r.id);
                    const isSelected = r.id === selected?.id;
                    return (
                      <tr key={r.id} className={isSelected ? 'selected' : ''}>
                        <td>
                          <button className="resource-select" type="button" aria-pressed={isSelected} onClick={() => select(r.id)}>
                            <span className="resource-select-name">{r.name}</span>
                            <span className="muted small mono">{r.id} · {r.type === 'vm' ? sizeLabel({ vcpu: r.vcpu!, ramGb: r.ramGb! }) : r.type === 'volume' ? `${r.diskGb} GB` : 'Public IP'}</span>
                          </button>
                        </td>
                        <td className="small">{r.region}<br/><span className="muted">{r.env} · {r.team}</span></td>
                        <td className="num mono">{inr(resourceMonthlyCost(r))}</td>
                        <td>{rec && rec.action !== 'none' ? <VerdictBadge verdict={rec.verdict} /> : <span className="muted small">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="resource-pager" aria-label="Resource pagination">
              <span className="muted small">Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, rows.length)} of {rows.length}</span>
              <div className="actions">
                <button type="button" className="ghost small" onClick={() => setPage((v) => Math.max(1, v - 1))} disabled={currentPage === 1} aria-label="Previous resources">← Previous</button>
                <span className="mono small">{currentPage}/{pageCount}</span>
                <button type="button" className="ghost small" onClick={() => setPage((v) => Math.min(pageCount, v + 1))} disabled={currentPage === pageCount} aria-label="Next resources">Next →</button>
              </div>
            </div>
          </>}
        </Section>
        <div className="resource-detail-scroll" ref={detailRef} aria-label="Selected resource details" aria-live="polite">
          {selected ? <ResourceDetail key={selected.id} resource={selected} /> :
            <div className="card resource-empty-detail"><div className="resource-empty-glyph" aria-hidden="true">◎</div><h2>Select a resource</h2><p className="muted">CPU, RAM, disk, network, dependencies and recommendation evidence appear here without leaving the list.</p></div>}
        </div>
      </div>
    </div>
  );
}

function ResourceDetail({ resource }: { resource: Resource }) {
  const { state, data, dispatch } = useApp();
  const rec = state.recommendations.find((r) => r.resourceId === resource.id);
  const s = data.series.get(resource.id);
  const cpu = useMemo(() => (s ? hourlyMax(s.cpuPct) : []), [s]);
  const mem = useMemo(() => (s ? hourlyMax(s.memPct) : []), [s]);
  const ev = rec?.evidence;
  const dependents = useMemo(() => transitiveDependents(resource.id, directDependents(data.resources)), [data.resources, resource.id]);
  const cpuTrend = useMemo(() => (s && resource.type === 'vm' ? forecastCapacity(resource, s, 'cpu') : null), [s, resource]);
  const nameOf = (id: string) => data.resourceById.get(id)?.name ?? id;

  return (
    <Section
      title={resource.name}
      right={
        <button className="ghost" onClick={() => dispatch({ type: 'select', resourceId: null })} aria-label="Close details">
          ✕
        </button>
      }
    >
      <p className="muted small">
        {resource.id} · {resource.type} · {resource.region} · {resource.env} · team {resource.team} · created {resource.createdAt} · pattern “{resource.pattern}”
      </p>
      <p>
        Current cost <b>{inr(resourceMonthlyCost(resource))}/month</b>
        {resource.type === 'vm' && <> on {sizeLabel({ vcpu: resource.vcpu!, ramGb: resource.ramGb! })}</>}
      </p>
      {s ? (
        <>
          <h3>CPU (hourly peak, 30 days)</h3>
          <LineChart
            ariaLabel="CPU usage over 30 days"
            series={[{ name: 'CPU', values: cpu, className: 'line-cpu' }]}
            limits={ev?.cpu ? [{ value: ev.cpu.p95, label: `p95 ${ev.cpu.p95.toFixed(1)}%`, className: 'warn' }] : []}
          />
          <h3>Memory (hourly peak, 30 days)</h3>
          <LineChart
            ariaLabel="Memory usage over 30 days"
            series={[{ name: 'Memory', values: mem, className: 'line-mem' }]}
            limits={ev?.mem ? [{ value: ev.mem.p95, label: `p95 ${ev.mem.p95.toFixed(1)}%`, className: 'warn' }] : []}
          />
          {ev && (
            <table className="mini">
              <tbody>
                <tr><th /> <th className="num">p50</th><th className="num">p95</th><th className="num">p99</th><th className="num">max</th></tr>
                <tr><td>CPU</td><td className="num">{pct(ev.cpu?.p50)}</td><td className="num">{pct(ev.cpu?.p95)}</td><td className="num">{pct(ev.cpu?.p99)}</td><td className="num">{pct(ev.cpu?.max)}</td></tr>
                <tr><td>Memory</td><td className="num">{pct(ev.mem?.p50)}</td><td className="num">{pct(ev.mem?.p95)}</td><td className="num">{pct(ev.mem?.p99)}</td><td className="num">{pct(ev.mem?.max)}</td></tr>
              </tbody>
            </table>
          )}
          {ev && (
            <p className="muted small">
              Data coverage {(ev.coverage * 100).toFixed(0)}% · history {ev.historyDays.toFixed(1)} days · off-hours CPU p95 {pct(ev.offHoursCpuP95)} ·
              off-hours network p95 {ev.offHoursNetP95Mbps?.toFixed(1) ?? '—'} Mbps
            </p>
          )}
          {cpuTrend && (
            <p className="small">
              CPU trend: daily p95 {cpuTrend.currentDailyP95.toFixed(1)}%, {cpuTrend.slopePerDay >= 0 ? '+' : ''}
              {cpuTrend.slopePerDay.toFixed(2)} points/day →{' '}
              {cpuTrend.daysToLimit === null ? 'does not reach the 85% limit within 90 days' : cpuTrend.daysToLimit === 0 ? 'already at the 85% limit' : `reaches 85% in about ${cpuTrend.daysToLimit} days`}{' '}
              <span className="muted">(linear trend, not a promise)</span>
            </p>
          )}
          <TelemetryPanels series={s} />
        </>
      ) : (
        <p className="muted">No metrics for this resource type (attachment state and age only).</p>
      )}
      <h3>Dependencies (Dependency Shield)</h3>
      {(resource.dependsOn?.length ?? 0) === 0 && dependents.length === 0 ? (
        <p className="muted small">No recorded dependencies. That is not proof there are none — every shutdown still needs a human to confirm.</p>
      ) : (
        <ul className="dep-list small">
          {resource.dependsOn?.length ? <li>Depends on: {resource.dependsOn.map(nameOf).join(', ')}</li> : null}
          {dependents.length ? <li className="tone-warn">Needed by (directly or indirectly): {dependents.map(nameOf).join(', ')}</li> : null}
        </ul>
      )}
      {rec && (
        <div className="callout">
          <div>
            Suggested: <b>{ACTION[rec.action]}</b> <VerdictBadge verdict={rec.verdict} long />
            {rec.monthlySavingInr > 0 && <span className="tone-pass"> · {inr(rec.monthlySavingInr)}/mo</span>}
          </div>
          <div className="muted small">{rec.reasons[0]}</div>
          <div className="actions">
            <button onClick={() => dispatch({ type: 'navigate', route: 'optimize' })}>Review in Optimization Center</button>
            {(rec.action === 'resize' || rec.action === 'resize+schedule') && (
              <button className="ghost" onClick={() => dispatch({ type: 'openLab', recId: rec.id })}>
                Challenge this recommendation
              </button>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
