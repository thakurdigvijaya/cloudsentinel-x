import { evaluateProofGate } from '../../engine/proofgate';
import { useMemo, useState } from 'react';
import { approvedSaving, aggregate, statusOf } from '../../engine/decisions';
import { eligibleSteps, savingFor } from '../../engine/plan';
import { executableStepsNow } from '../../engine/eventFinance';
import { buildPortfolio, RISK_APPETITES, type RiskAppetite } from '../../engine/portfolio';
import { sizeLabel } from '../../engine/pricing';
import type { Recommendation, StepAction, Verdict } from '../../engine/types';
import { Badge, Empty, Section, VerdictBadge } from '../components';
import { ACTION, RISK_TONE, inr, inr2 } from '../format';
import { useApp } from '../store';
import { FilterBar, matchesFilters } from './ResourceExplorer';

type VerdictFilter = 'all' | Verdict;

export function OptimizationCenter() {
  const { state, data } = useApp();
  const [verdict, setVerdict] = useState<VerdictFilter>('all');
  const list = useMemo(
    () =>
      state.recommendations
        .filter((r) => r.action !== 'none')
        .filter((r) => matchesFilters(data.resourceById.get(r.resourceId)!, state.filters))
        .filter((r) => verdict === 'all' || r.verdict === verdict)
        .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.monthlySavingInr - a.monthlySavingInr),
    [state.recommendations, state.filters, verdict, data.resourceById],
  );
  const tabs: [VerdictFilter, string][] = [
    ['all', 'All proposals'],
    ['PASS_UNDER_TESTED_CONDITIONS', 'Pass'],
    ['FAIL_SAFETY_CHECKS', 'Fail'],
    ['INSUFFICIENT_EVIDENCE', 'Insufficient evidence'],
  ];

  return (
    <div className="stack">
      <PortfolioPanel />
      <RefusalExplorer />
      <FilterBar />
      <div className="tabs" role="tablist">
        {tabs.map(([v, label]) => (
          <button key={v} role="tab" aria-selected={verdict === v} className={verdict === v ? 'tab active' : 'tab'} onClick={() => setVerdict(v)}>
            {label}
          </button>
        ))}
      </div>
      {state.adoptedScenario && (
        <div className="notice warn">Showing recommendations re-validated under an adopted planning assumption. Reset it in the Challenge Lab.</div>
      )}
      {list.length === 0 ? <Empty>No recommendations match these filters.</Empty> : list.map((r) => <RecommendationCard key={r.id} rec={r} />)}
    </div>
  );
}

/** Refusal ledger: demonstrate the savings the safety/data checks refuse to claim. */
function RefusalExplorer() {
  const { state, data, dispatch } = useApp();
  const totals = useMemo(() => aggregate(data.resources, state.recommendations, {}), [data.resources, state.recommendations]);
  const refused = useMemo(() => state.recommendations.map(rec => ({
    rec,
    excluded: Math.max(0, (totals.byResource[rec.resourceId]?.candidateInr ?? 0) - (totals.byResource[rec.resourceId]?.eligibleInr ?? 0)),
  })).filter(row => row.excluded > 0.005).sort((a,b)=>b.excluded-a.excluded), [state.recommendations, totals]);
  const [expanded, setExpanded] = useState(false);
  return <Section title="Why not? · Refusal Ledger" right={<span className="badge badge-fail">{inr(Math.max(0, totals.candidateInr - totals.eligibleInr))}/mo not claimed</span>}>
    <div className="refusal-overview">
      <div><div className="label">Every proposed saving</div><strong>{inr(totals.candidateInr)}</strong></div>
      <div><div className="label">Passes defined checks</div><strong className="tone-pass">{inr(totals.eligibleInr)}</strong></div>
      <div><div className="label">Not claimed</div><strong className="tone-fail">{inr(Math.max(0,totals.candidateInr-totals.eligibleInr))}</strong></div>
    </div>
    <p className="muted small">The rejected portion is calculated from each resource's candidate minus independently eligible steps. It includes safety failures and insufficient evidence, not only human rejections. Partial scheduling savings are retained where independently verified.</p>
    {refused.length === 0 ? <p>No excluded candidate savings in this dataset.</p> : <>
      <div className="refusal-rows">
        {refused.slice(0,expanded ? refused.length : 5).map(({rec,excluded})=><div key={rec.id} className="refusal-row">
          <div><b>{rec.resourceName}</b><span className="muted small"> · {rec.resourceId} · {rec.env}</span>
            <div className="small">{rec.verdict === 'INSUFFICIENT_EVIDENCE' ? 'Insufficient evidence' : rec.verdict === 'FAIL_SAFETY_CHECKS' ? 'Safety checks failed' : 'Some steps excluded from eligible savings'} · {rec.reasons.slice(0,2).join(' · ')}</div>
          </div>
          <span className="mono tone-fail">−{inr(excluded)}/mo</span>
          <button className="ghost small" onClick={() => {
            if(rec.proposed.size) dispatch({type:'openLab',recId:rec.id});
            else {dispatch({type:'select',resourceId:rec.resourceId});dispatch({type:'navigate',route:'resources'});}
          }}>Inspect evidence</button>
        </div>)}
      </div>
      {refused.length>5&&<button className="ghost small" onClick={()=>setExpanded(x=>!x)}>{expanded?'Show fewer':`View all ${refused.length} excluded resources`}</button>}
    </>}
  </Section>;
}

/** Risk Budget Portfolio: the best set of changes for the team's risk appetite (exact, engine-computed). */
function PortfolioPanel() {
  const { state, data, dispatch } = useApp();
  const [appetite, setAppetite] = useState<RiskAppetite>('balanced');
  const p = useMemo(() => buildPortfolio(state.recommendations, RISK_APPETITES[appetite], data.resources), [state.recommendations, data.resources, appetite]);
  const pending = p.choice.chosen.filter((c) => statusOf(state.decisions, c.recommendationId) !== 'approved');
  const W = 720;
  const H = 120;
  const maxB = Math.max(1, p.totalRiskPoints);
  const maxS = Math.max(1, p.totalSavingInr);
  const pts = p.frontier.map((f) => [12 + (f.budget / maxB) * (W - 24), H - 14 - (f.savingInr / maxS) * (H - 28)] as const);
  const sel = [12 + (Math.min(RISK_APPETITES[appetite], maxB) / maxB) * (W - 24), H - 14 - (p.choice.savingInr / maxS) * (H - 28)];
  return (
    <Section
      title="Risk Budget Portfolio — how much risk will you take this month?"
      right={
        <div className="tabs" role="tablist" aria-label="Risk appetite">
          {(Object.keys(RISK_APPETITES) as RiskAppetite[]).map((a) => (
            <button key={a} role="tab" aria-selected={appetite === a} className={appetite === a ? 'tab active' : 'tab'} onClick={() => setAppetite(a)}>
              {a} · {RISK_APPETITES[a]} pts
            </button>
          ))}
        </div>
      }
    >
      <p>
        Best set for <b>{appetite}</b>: <b>{p.choice.chosen.length}</b> changes, <b className="tone-pass">{inr(p.choice.savingInr)}/mo</b>, using {p.choice.riskPointsUsed} of {RISK_APPETITES[appetite]} risk points
        <span className="muted"> (all {p.candidates.length} safe changes: {inr(p.totalSavingInr)}/mo, {p.totalRiskPoints} points)</span>.
      </p>
      <svg className="frontier" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Savings versus risk frontier">
        <polyline className="line" points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} />
        <circle className="pt" cx={sel[0]} cy={sel[1]} r={5} />
        <text x={12} y={H - 2} className="axis">0 risk points</text>
        <text x={W - 12} y={H - 2} className="axis" textAnchor="end">{maxB} points</text>
        <text x={12} y={12} className="axis">{inr(maxS)}/mo</text>
      </svg>
      <details>
        <summary>Which changes, and how risk points are counted</summary>
        <p className="muted small">{p.method}</p>
        <ul className="reasons small">
          {p.choice.chosen.map((c) => (
            <li key={c.recommendationId}>
              {c.resourceName} · {c.steps.join(' + ')} · {inr(c.savingInr)}/mo · {c.riskPoints} pts ({c.why})
            </li>
          ))}
        </ul>
      </details>
      <div className="actions">
        <button
          disabled={pending.length === 0}
          onClick={() =>
            dispatch({
              type: 'approveMany',
              label: `the ${appetite} portfolio`,
              items: pending.map((c) => ({ rec: state.recommendations.find((r) => r.id === c.recommendationId)!, steps: c.steps as StepAction[] })),
            })
          }
        >
          Approve these {pending.length} changes
        </button>
        <span className="muted small">Simulated approvals — nothing is changed in any cloud. Each one is recorded in the Decision Center.</span>
      </div>
    </Section>
  );
}

function RecommendationCard({ rec }: { rec: Recommendation }) {
  const { state, data, dispatch } = useApp();
  const proof = evaluateProofGate(rec, data.resources, state.recommendations, state.decisions);
  const status = statusOf(state.decisions, rec.id);
  const decision = state.decisions[rec.id];
  const multi = rec.steps.length > 1;
  const allowed = executableStepsNow(rec, eligibleSteps(rec)); // Utsav-held resizes are not immediately approvable
  const [steps, setSteps] = useState<StepAction[]>(allowed);
  const selectedSteps = steps.filter(s => allowed.includes(s));
  const selectedSaving = savingFor(rec, selectedSteps);
  const toggle = (a: StepAction) => setSteps((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]));

  return (
    <article className={`card rec status-${status}`}>
      <header className="rec-head">
        <div>
          <h3>
            {rec.resourceName} <span className="muted small mono">{rec.resourceId}</span>
          </h3>
          <div className="muted small">
            {rec.resourceType} · {rec.region} · {rec.env} · team {rec.team}
          </div>
        </div>
        <div className="rec-badges">
          <VerdictBadge verdict={rec.verdict} long />
          <Badge tone={RISK_TONE[rec.risk]}>risk {rec.risk}</Badge>
          <Badge tone="neutral" title="How complete the data is — not a probability that the change is safe">
            data adequacy {(rec.dataAdequacyScore * 100).toFixed(0)}%
          </Badge>
          {rec.requiresHumanReview && <Badge tone="warn">needs human review</Badge>}
          {rec.blockedSteps?.length ? <Badge tone="fail" title="A running resource depends on this one">Dependency Shield: {rec.blockedSteps.join(' + ')} blocked</Badge> : null}
          {rec.holdUntil && <Badge tone="warn" title="An upcoming event would break the smaller size">Utsav hold until {rec.holdUntil}</Badge>}
        </div>
      </header>

      <div className="rec-body">
        <div className="rec-change">
          <div className="label">{ACTION[rec.action]}</div>
          <div className="mono">
            {rec.current.size ? sizeLabel(rec.current.size) : rec.resourceType} · {inr2(rec.current.monthlyCostInr)}/mo
            {' → '}
            {rec.proposed.size && rec.proposed.monthlyCostInr > 0 ? sizeLabel(rec.proposed.size) + ' · ' : ''}
            {inr2(rec.proposed.monthlyCostInr)}/mo
          </div>
          <div className={rec.eligible ? 'big tone-pass' : 'big muted'}>
            {inr(rec.monthlySavingInr)}/mo {rec.eligible ? 'saving' : 'not eligible'}
          </div>
          {!rec.eligible && allowed.length > 0 && (
            <div className="small tone-pass">Still approvable on its own: {allowed.join(' + ')} · {inr2(savingFor(rec, allowed))}/mo</div>
          )}
        </div>
        <ul className="reasons">
          {rec.reasons.map((x, i) => (
            <li
              key={i}
              className={
                x.startsWith('Blocked by Dependency Shield') || x.startsWith('Not scheduled')
                  ? 'tone-fail'
                  : x.startsWith('Utsav Mode') || x.startsWith('Warning')
                    ? 'tone-warn'
                    : x.startsWith('Assumes') || x.startsWith('Dependency Shield:')
                      ? 'muted small'
                      : ''
              }
            >
              {x}
            </li>
          ))}
        </ul>
      </div>

      <details>
        <summary>ProofGate · {proof.verdict.replace('-', ' ')} · four evidence gates</summary>
        <ul className="reasons small">
          {proof.gates.map(g => <li key={g.name}>
            <b>{g.name} — {g.state}</b>: {g.explanation}
          </li>)}
        </ul>
        <p className="muted small">{proof.caveat}</p>
      </details>
      <details>
        <summary>How calculated?</summary>
        <p className="mono small">{rec.savingFormula}</p>
        {rec.steps.length > 0 && (
          <table className="mini">
            <thead>
              <tr>
                <th>Step (fixed order)</th>
                <th className="num">Cost after</th>
                <th className="num">Saving</th>
              </tr>
            </thead>
            <tbody>
              {rec.steps.map((s) => (
                <tr key={s.action}>
                  <td>{s.label}</td>
                  <td className="num">{inr2(s.costAfterInr)}</td>
                  <td className="num">−{inr2(s.marginalSavingInr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rec.checks.length > 0 && (
          <table className="mini">
            <thead>
              <tr>
                <th>Check</th>
                <th className="num">Limit</th>
                <th className="num">Actual</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {rec.checks.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.id} {c.label}
                  </td>
                  <td className="num">{c.unit === 'ratio' ? `${(c.limit * 100).toFixed(0)}%` : `${c.limit}${c.unit === '%' ? '%' : ' ' + c.unit}`}</td>
                  <td className="num">
                    {c.actual === null ? '—' : c.unit === 'ratio' ? `${(c.actual * 100).toFixed(0)}%` : `${c.actual.toFixed(1)}${c.unit === '%' ? '%' : ' ' + c.unit}`}
                  </td>
                  <td className={c.passed ? 'tone-pass' : c.passed === false ? 'tone-fail' : ''}>{c.passed === null ? 'n/a' : c.passed ? 'pass' : 'FAIL'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Assumptions: {rec.assumptionIds.join(', ')} (see assumptions.md). Synthetic data · illustrative pricing.</p>
      </details>

      <footer className="rec-foot">
        {multi && allowed.length > 0 && status !== 'approved' && (
          <fieldset className="steps">
            <legend className="small muted">Approve which steps?</legend>
            {rec.steps.map((s) => (
              <label key={s.action} title={allowed.includes(s.action) ? '' : 'Blocked — cannot be approved'}>
                <input type="checkbox" disabled={!allowed.includes(s.action)} checked={selectedSteps.includes(s.action)} onChange={() => toggle(s.action)} /> {s.label}
                {!allowed.includes(s.action) && <span className="tone-fail small"> (blocked)</span>}
              </label>
            ))}
            <span className="small">→ saving {inr2(selectedSaving)}/mo</span>
          </fieldset>
        )}
        <div className="actions">
          <span className={`status status-${status}`}>
            {status === 'approved'
              ? `Approved · ${inr2(approvedSaving(rec, state.decisions))}/mo${decision?.acceptedSteps && multi ? ' (' + decision.acceptedSteps.join(' + ') + ')' : ''}`
              : status === 'needs-review'
                ? 'Needs review — evidence changed'
                : status === 'rejected'
                  ? 'Rejected'
                  : 'Pending'}
          </span>
          {status === 'pending' || status === 'needs-review' ? (
            <>
              <button
                disabled={selectedSteps.length === 0}
                title={allowed.length ? 'Simulated approval — nothing is changed in any cloud' : 'Only changes that PASS the checks can be approved'}
                onClick={() => dispatch({ type: 'approve', rec, steps: selectedSteps })}
              >
                Approve
              </button>
              <button className="ghost" onClick={() => dispatch({ type: 'reject', rec })}>
                Reject
              </button>
            </>
          ) : (
            <button className="ghost" onClick={() => dispatch({ type: 'undo', rec })}>
              Undo
            </button>
          )}
          {(rec.action === 'resize' || rec.action === 'resize+schedule') && (
            <button className="ghost" onClick={() => dispatch({ type: 'openLab', recId: rec.id })}>
              Challenge
            </button>
          )}
        </div>
      </footer>
    </article>
  );
}
