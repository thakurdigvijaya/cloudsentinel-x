import { useMemo, useState } from 'react';
import { aggregate } from '../../engine/decisions';
import { explainBill, roleBrief, type Role } from '../../engine/explain';
import { fleetEnergy } from '../../engine/sustainability';
import { eventTimingSummary } from '../../engine/eventFinance';
import type { Env, Recommendation, Region } from '../../engine/types';
import { Badge, Bars, Kpi, Section, VerdictBadge } from '../components';
import { ACTION, VERDICT, inr } from '../format';
import { useApp } from '../store';

const ENVS: Env[] = ['prod', 'staging', 'dev'];
const REGIONS: Region[] = ['noida', 'bengaluru', 'mumbai'];

export function CommandCenter() {
  const { state, data, dispatch } = useApp();
  const recByResource = useMemo(() => new Map(state.recommendations.map((r) => [r.resourceId, r])), [state.recommendations]);
  const totals = useMemo(() => aggregate(data.resources, state.recommendations, state.decisions), [data.resources, state.recommendations, state.decisions]);
  const counts = useMemo(() => {
    const c = { PASS_UNDER_TESTED_CONDITIONS: 0, FAIL_SAFETY_CHECKS: 0, INSUFFICIENT_EVIDENCE: 0, NO_ACTION: 0 };
    for (const r of state.recommendations) c[r.verdict]++;
    return c;
  }, [state.recommendations]);
  const top = useMemo(
    () => state.recommendations.filter((r) => r.eligible).sort((a, b) => b.monthlySavingInr - a.monthlySavingInr).slice(0, 5),
    [state.recommendations],
  );
  const vms = data.resources.filter((r) => r.type === 'vm');
  const bill = useMemo(() => explainBill(data.resources, state.recommendations, data.start, Math.round(data.days)), [data, state.recommendations]);
  const energy = useMemo(() => fleetEnergy(state.recommendations.filter((r) => r.eligible)), [state.recommendations]);
  const [role, setRole] = useState<Role>('leadership');
  const brief = useMemo(() => roleBrief(role, { recs: state.recommendations, totals, bill, alerts: data.analysis.alerts }), [role, state.recommendations, totals, bill, data.analysis.alerts]);
  const critical = data.analysis.alerts.filter((a) => a.severity === 'critical').length;
  const demoResize = state.recommendations.find((r) => r.eligible && r.steps.some((step) => step.action === 'resize'));
  const timing = eventTimingSummary(state.recommendations, state.decisions);
  const potentialUnapprovedPerDay = Math.max(0, timing.eligibleNowInr - timing.approvedNowInr) * 24 / 730;
  // All four segments reconcile exactly to candidate savings. Deferred and refused
  // amounts are NOT counted as immediately actionable; approvals are only plans.
  const opportunity = useMemo(() => {
    const candidate = Math.max(0, totals.candidateInr);
    const refused = Math.max(0, totals.candidateInr - timing.eligiblePlannedInr);
    const deferred = Math.max(0, timing.deferredEligibleInr);
    const approvedNow = Math.max(0, timing.approvedNowInr);
    const pendingNow = Math.max(0, candidate - refused - deferred - approvedNow);
    const pct = (amount: number) => candidate > 0 ? `${Math.max(0, Math.min(100, 100 * amount / candidate))}%` : '0%';
    return { candidate, refused, deferred, approvedNow, pendingNow, pct };
  }, [totals.candidateInr, timing]);
  const openResource = (id: string) => {
    dispatch({ type: 'select', resourceId: id });
    dispatch({ type: 'navigate', route: 'resources' });
  };

  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Current monthly spend" value={inr(totals.originalInr)} sub={`${data.resources.length} resources · ${vms.length} VMs`} />
        <Kpi label="Potential eligible savings (PASS only)" value={inr(totals.eligibleInr)} sub={`of ${inr(totals.candidateInr)} proposed · ${timing.deferredEligibleInr ? inr(timing.deferredEligibleInr) + ' deferred by Utsav' : 'subject to human review'}`} tone="pass" />
        <Kpi label="Approved savings" value={inr(totals.approvedInr)} sub={`Projected bill ${inr(totals.projectedInr)}`} tone="pass" />
        <Kpi label="Alerts" value={String(data.analysis.alerts.length)} sub={`${critical} critical · each explains why`} tone={critical ? 'warn' : undefined} />
      </div>

      <Section title="From proposed rupees to defensible decisions" right={<span className="muted small">Engine-derived · ₹ per estimated month</span>}>
        <div className="evidence-journey" role="group" aria-label="Savings decision waterfall">
          <div className="evidence-journey-intro">
            <span>Each amount is an independently explained part of the proposed saving.</span>
            <strong className="mono">{inr(opportunity.candidate)} proposed</strong>
          </div>
          <div className="evidence-journey-track" role="img" aria-label={`${inr(opportunity.refused)} refused, ${inr(opportunity.deferred)} event deferred, ${inr(opportunity.pendingNow)} awaiting approval, ${inr(opportunity.approvedNow)} approved now`}>
            <span className="evidence-part refused" style={{ width: opportunity.pct(opportunity.refused) }} />
            <span className="evidence-part deferred" style={{ width: opportunity.pct(opportunity.deferred) }} />
            <span className="evidence-part pending" style={{ width: opportunity.pct(opportunity.pendingNow) }} />
            <span className="evidence-part approved" style={{ width: opportunity.pct(opportunity.approvedNow) }} />
          </div>
          <div className="evidence-journey-labels">
            <div><i className="legend-dot refused" aria-hidden="true"/><span>Refused / insufficient evidence</span><strong className="mono">{inr(opportunity.refused)}</strong></div>
            <div><i className="legend-dot deferred" aria-hidden="true"/><span>Deferred by Utsav</span><strong className="mono">{inr(opportunity.deferred)}</strong></div>
            <div><i className="legend-dot pending" aria-hidden="true"/><span>Eligible now · awaiting approval</span><strong className="mono">{inr(opportunity.pendingNow)}</strong></div>
            <div><i className="legend-dot approved" aria-hidden="true"/><span>Approved plan · actionable now</span><strong className="mono">{inr(opportunity.approvedNow)}</strong></div>
          </div>
          <div className="evidence-journey-foot">
            <span className="muted small">Approved is <b>not</b> executed or realized. All values use illustrative pricing and defined safety conditions.</span>
            <div className="actions"><button className="ghost small" onClick={() => dispatch({ type: 'navigate', route: 'optimize' })}>Inspect refusals</button><button className="small" onClick={() => dispatch({ type: 'navigate', route: 'decisions' })}>Before / After cost →</button></div>
          </div>
        </div>
      </Section>

      <Section title="90-second judge walkthrough" right={<span className="muted small">Real data · real calculations · no scripted outcomes</span>}>
        <p className="muted small">1 · Discover a verified recommendation → 2 · Challenge the proposed resize → 3 · Review the evidence and projected cost.</p>
        <div className="actions">
          <button className="ghost" onClick={() => dispatch({ type: 'navigate', route: 'optimize' })}>1. Find recommendations</button>
          <button disabled={!demoResize} onClick={() => demoResize && dispatch({ type: 'openLab', recId: demoResize.id })}>2. Challenge a resize</button>
          <button className="ghost" onClick={() => dispatch({ type: 'navigate', route: 'decisions' })}>3. Verify decisions</button>
        </div>
        <p className="muted small">Waste Clock · Estimated immediately eligible, unapproved opportunity: <b>{inr(potentialUnapprovedPerDay)}/day</b> on a 730-hour billing month. This is hypothetical forgone saving, <b>not real money already lost</b>. Utsav-held resizes are excluded from the immediate figure.</p>
      </Section>

      <p className="muted small">UTHO scenario: the example company’s bill rose 40% over six months. That 40% is <b>given background context</b>, not a claim measured by our 30-day telemetry. The following growth comparison is only first week versus last week in the loaded period.</p>

      <Section title="Where did the money go?" right={<span className="muted small">Bill Explainer · computed by the engine</span>}>
        <ul className="headlines">
          {bill.headlines.map((h, i) => (
            <li key={i} className={i === 1 ? 'tone-warn' : ''}>
              {h}
            </li>
          ))}
        </ul>
        <div className="grid-2">
          <div>
            <h3>Savings passing defined checks by kind ({inr(bill.wasteEligibleInr)}/mo · {bill.wasteSharePct.toFixed(1)}% of the bill)</h3>
            <Bars rows={bill.waste.map((w) => ({ label: `${w.label} · ${w.resources}`, value: w.eligibleInr }))} format={inr} wideLabels />
          </div>
          <div>
            <h3>Why spend grew (first vs last week of the window)</h3>
            <Bars
              rows={bill.growth.byTeam.filter((t) => t.deltaInr > 0).map((t) => ({ label: `team ${t.key}`, value: t.deltaInr }))}
              format={(n) => '+' + inr(n) + '/wk'}
              wideLabels
            />
            {bill.growth.newResources.length > 0 && (
              <p className="muted small">
                New resources in the window: {bill.growth.newResources.slice(0, 5).map((n) => `${n.name} (${inr(n.monthlyInr)}/mo)`).join(', ')}
                {bill.growth.newResources.length > 5 ? ` and ${bill.growth.newResources.length - 5} more` : ''}.
              </p>
            )}
          </div>
        </div>
      </Section>

      <div className="grid-2">
        <Section
          title="The same numbers, for each audience"
          right={
            <div className="tabs" role="tablist" aria-label="Audience">
              {(['leadership', 'finance', 'engineer'] as Role[]).map((r) => (
                <button key={r} role="tab" aria-selected={role === r} className={role === r ? 'tab active' : 'tab'} onClick={() => setRole(r)}>
                  {r}
                </button>
              ))}
            </div>
          }
        >
          <h3>{brief.title}</h3>
          <ul className="reasons">
            {brief.points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </Section>
        <Section title="Energy & carbon (estimate)">
          <div className="kpi-value tone-pass">{energy.tonnesCo2SavedPerYear.toFixed(1)} t CO₂/yr</div>
          <p className="muted small">
            If every safe change is made: about {Math.round(energy.kwhSavedPerMonth).toLocaleString('en-IN')} kWh/month less across {energy.recommendations} changes. {energy.method}
          </p>
        </Section>
      </div>

      <div className="verdict-strip">
        {(Object.keys(counts) as (keyof typeof counts)[]).map((v) => (
          <span key={v}>
            <VerdictBadge verdict={v} /> <b>{counts[v]}</b>
          </span>
        ))}
      </div>

      <Section title="Infrastructure map" right={<span className="muted small">Each square is one VM · click to inspect</span>}>
        <div className="map">
          <div className="map-row map-head">
            <span />
            {ENVS.map((e) => (
              <span key={e}>{e}</span>
            ))}
          </div>
          {REGIONS.map((region) => (
            <div className="map-row" key={region}>
              <span className="map-region">{region}</span>
              {ENVS.map((env) => (
                <div className="map-cell" key={env}>
                  {vms
                    .filter((v) => v.region === region && v.env === env)
                    .map((v) => {
                      const rec = recByResource.get(v.id);
                      const tone = rec ? (rec.eligible ? 'pass' : VERDICT[rec.verdict].tone) : 'neutral';
                      return (
                        <button
                          key={v.id}
                          className={`dot dot-${tone}`}
                          title={`${v.name} · ${rec ? ACTION[rec.action] + ' · ' + VERDICT[rec.verdict].short : ''}`}
                          aria-label={`${v.name}: ${rec ? VERDICT[rec.verdict].label : 'no data'}`}
                          onClick={() => openResource(v.id)}
                        />
                      );
                    })}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="legend">
          <span><i className="swatch dot-pass" /> saving that passes checks</span>
          <span><i className="swatch dot-fail" /> change blocked (fails checks)</span>
          <span><i className="swatch dot-unknown" /> insufficient evidence</span>
          <span><i className="swatch dot-neutral" /> no change needed</span>
        </div>
      </Section>

      <div className="grid-2">
        <Section title="Spend by environment" right={<span className="muted small">bar = current · inner = eligible saving</span>}>
          <Bars rows={ENVS.map((e) => ({ label: e, value: totals.byEnv[e].originalInr, secondary: totals.byEnv[e].eligibleInr }))} format={inr} />
        </Section>
        <Section title="Spend by region">
          <Bars rows={REGIONS.map((r) => ({ label: r, value: totals.byRegion[r].originalInr, secondary: totals.byRegion[r].eligibleInr }))} format={inr} />
        </Section>
      </div>

      <div className="grid-2">
        <Section title="Top savings that pass the checks">
          {top.map((r: Recommendation) => (
            <button key={r.id} className="row-button" onClick={() => dispatch({ type: 'navigate', route: 'optimize' })}>
              <span>
                <b>{r.resourceName}</b> <span className="muted">· {ACTION[r.action]}</span>
              </span>
              <span className="tone-pass">{inr(r.monthlySavingInr)}/mo</span>
            </button>
          ))}
        </Section>
        <Section title={`Alerts (${data.analysis.alerts.length})`}>
          <ul className="alerts">
            {data.analysis.alerts.map((a) => (
              <li key={a.id}>
                <Badge tone={a.severity === 'critical' ? 'fail' : a.severity === 'warning' ? 'warn' : 'neutral'}>{a.severity}</Badge> <b>{a.title}</b>
                <div className="muted small">{a.why}</div>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
