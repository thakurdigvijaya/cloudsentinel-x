import { useMemo, useState } from 'react';
import { aggregate, approvedSaving, statusOf, type DecisionStatus } from '../../engine/decisions';
import { buildPassport, passportToMarkdown } from '../../engine/passport';
import { eventTimingSummary, executableStepsNow } from '../../engine/eventFinance';
import { eligibleSteps, savingFor } from '../../engine/plan';
import type { Env, Recommendation } from '../../engine/types';
import { Empty, Kpi, Section, VerdictBadge } from '../components';
import { ACTION, inr, inr2 } from '../format';
import { useApp } from '../store';

const ENVS: Env[] = ['prod', 'staging', 'dev'];

export function DecisionCenter() {
  const { state, data, dispatch } = useApp();
  const totals = useMemo(() => aggregate(data.resources, state.recommendations, state.decisions), [data.resources, state.recommendations, state.decisions]);
  const [passportFor, setPassportFor] = useState<string | null>(null);
  const timing = useMemo(() => eventTimingSummary(state.recommendations, state.decisions), [state.recommendations, state.decisions]);
  const byStatus = (s: DecisionStatus) => state.recommendations.filter((r) => r.action !== 'none' && statusOf(state.decisions, r.id) === s);
  const approved = byStatus('approved');
  const review = byStatus('needs-review');
  const rejected = byStatus('rejected');
  const pendingEligible = byStatus('pending').filter((r) => r.eligible && executableStepsNow(r, eligibleSteps(r)).length > 0);

  const rows = (list: Recommendation[], showSaving: boolean) =>
    list.length === 0 ? (
      <Empty>None.</Empty>
    ) : (
      <ul className="decision-list">
        {list.map((r) => (
          <li key={r.id}>
            <span>
              <b>{r.resourceName}</b> <span className="muted small">· {r.env} · {ACTION[r.action]}</span>{' '}
              {state.decisions[r.id]?.acceptedSteps && r.steps.length > 1 && <span className="muted small">({state.decisions[r.id].acceptedSteps!.join(' + ')})</span>}
            </span>
            <span className="actions">
              {showSaving && <span className="tone-pass mono">{inr2(approvedSaving(r, state.decisions))}/mo</span>}
              <VerdictBadge verdict={r.verdict} />
              <button className="ghost small" onClick={() => setPassportFor(r.id)}>
                Passport
              </button>
              <button className="ghost small" onClick={() => dispatch({ type: 'undo', rec: r })}>
                Undo
              </button>
            </span>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Current monthly bill" value={inr(totals.originalInr)} />
        <Kpi label="Approved savings" value={inr(totals.approvedInr)} tone="pass" sub={`${approved.length} change(s) approved`} />
        <Kpi label="Projected bill after planned changes" value={inr(totals.projectedInr)} />
        <Kpi label="Immediately eligible, not yet approved" value={inr(Math.max(0, timing.eligibleNowInr - timing.approvedNowInr))} sub={`${pendingEligible.length} pending recommendations · event holds excluded; partial approvals also affect the amount`} />
      </div>

      <SavingsWaterfall />

      {timing.deferredEligibleInr > 0 && (
        <Section title="Utsav timing — planned versus immediately actionable">
          <p>Safety-eligible after all allowed timing conditions: <b>{inr(timing.eligiblePlannedInr)}/mo</b> · Immediately actionable under the declared event: <b className="tone-pass">{inr(timing.eligibleNowInr)}/mo</b> · Temporarily deferred: <b className="tone-warn">{inr(timing.deferredEligibleInr)}/mo</b>.</p>
          <p className="muted small">Of the human-approved future plan, {inr(timing.approvedNowInr)}/mo can be considered for immediate execution and {inr(timing.deferredApprovedInr)}/mo waits for the declared event to finish. Approval is a planning record, never a real cloud change.</p>
        </Section>
      )}

      <Section title="Before vs after, by environment">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Environment</th>
                <th className="num">Current</th>
                <th className="num">Eligible saving</th>
                <th className="num">Approved saving</th>
                <th className="num">Projected</th>
              </tr>
            </thead>
            <tbody>
              {ENVS.map((e) => (
                <tr key={e}>
                  <td>{e}</td>
                  <td className="num mono">{inr(totals.byEnv[e].originalInr)}</td>
                  <td className="num mono">{inr(totals.byEnv[e].eligibleInr)}</td>
                  <td className="num mono tone-pass">{inr(totals.byEnv[e].approvedInr)}</td>
                  <td className="num mono">{inr(totals.byEnv[e].projectedInr)}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total</td>
                <td className="num mono">{inr(totals.originalInr)}</td>
                <td className="num mono">{inr(totals.eligibleInr)}</td>
                <td className="num mono tone-pass">{inr(totals.approvedInr)}</td>
                <td className="num mono">{inr(totals.projectedInr)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Approved savings are recomputed from the accepted steps of each plan (remove → resize → schedule); a resource is never counted twice.
          Approvals are simulated decisions — nothing is changed in any cloud.
        </p>
      </Section>

      <Section title="How this estimated bill is calculated">
        <p className="muted small">These are <b>projected monthly amounts for synthetic or imported resources</b>, not realized bill savings. VM compute is priced as (vCPU × ₹700 + RAM GB × ₹180) × region factor (Noida 0.95; Bengaluru/Mumbai 1.00). Block storage is ₹8/GB-month and public IPs ₹300/month. A planning approval changes this estimate only; no real cloud service is modified.</p>
        <p className="muted small">Excluded from the illustrative model: VM boot-disk billing, metered network egress, taxes, negotiated discounts and other provider-specific usage charges. See <code>assumptions.md</code>. Resize projections use the available size catalog; shutdown estimates assume workload owners confirm the necessary operational conditions.</p>
      </Section>

      {review.length > 0 && <Section title={`Needs review (${review.length})`}>{rows(review, false)}</Section>}
      <Section title={`Approved (${approved.length})`}>{rows(approved, true)}</Section>
      <Section title={`Rejected (${rejected.length})`}>{rows(rejected, false)}</Section>

      {passportFor && <PassportPanel recId={passportFor} onClose={() => setPassportFor(null)} />}

      <Section title="Decision history">
        {state.log.length === 0 ? (
          <Empty>No decisions yet. Approve or reject recommendations in the Optimization Center.</Empty>
        ) : (
          <ul className="log">
            {state.log.slice(0, 50).map((l, i) => (
              <li key={i}>
                <span className="mono small muted">{new Date(l.at).toLocaleString('en-IN')}</span> <b>{l.resourceName}</b> — {l.event}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function PassportPanel({ recId, onClose }: { recId: string; onClose: () => void }) {
  const { state, data } = useApp();
  const rec = state.recommendations.find((r) => r.id === recId);
  const md = useMemo(() => {
    if (!rec) return '';
    const res = data.resourceById.get(rec.resourceId)!;
    return passportToMarkdown(buildPassport(res, data.series.get(res.id), rec, state.decisions[rec.id]));
  }, [rec, data, state.decisions]);
  if (!rec) return null;
  const download = () => {
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `evidence-passport-${rec.resourceId}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Section
      title={`Evidence Passport — ${rec.resourceName}`}
      right={
        <span className="actions">
          <button onClick={download}>Download .md</button>
          <button className="ghost" onClick={() => window.print()}>
            Print / PDF
          </button>
          <button className="ghost" onClick={onClose} aria-label="Close passport">
            ✕
          </button>
        </span>
      }
    >
      <pre className="passport">{md}</pre>
    </Section>
  );
}

/** Live cost bridge. No synthetic approval records: approved mode uses real saved human planning decisions. */
function SavingsWaterfall() {
  const { state, data, dispatch } = useApp();
  const [view,setView] = useState<'eligible'|'approved'>('eligible');
  const total = useMemo(()=>aggregate(data.resources,state.recommendations,state.decisions),[data.resources,state.recommendations,state.decisions]);
  const steps = useMemo(() => state.recommendations.map(rec => ({
    id:rec.id, name:rec.resourceName,
    saving:view==='approved' ? approvedSaving(rec,state.decisions) : savingFor(rec,executableStepsNow(rec,eligibleSteps(rec))),
  })).filter(x=>x.saving>0).sort((a,b)=>b.saving-a.saving), [state.recommendations,state.decisions,view]);
  const sum=steps.reduce((n,x)=>n+x.saving,0);
  const shown=steps.slice(0,7);
  const rest=steps.slice(7).reduce((n,x)=>n+x.saving,0);
  const rows=rest>0?[...shown,{id:'remaining',name:`Other ${steps.length-7} eligible changes`,saving:rest}]:shown;
  let left=total.originalInr;
  return <Section title="Explain every rupee · Live cost waterfall" right={<div className="tabs" role="group" aria-label="Savings waterfall view">
    <button className={view==='eligible'?'tab active':'tab'} aria-pressed={view==='eligible'} onClick={()=>setView('eligible')}>Potential, not approved</button>
    <button className={view==='approved'?'tab active':'tab'} aria-pressed={view==='approved'} onClick={()=>setView('approved')}>Actual planning approvals</button>
  </div>}>
    <p className="muted small">{view==='eligible'?'Hypothetical if all immediately eligible changes were approved; Utsav-held changes excluded. No real actions have occurred.':'Only recorded, still-valid human planning approvals contribute. No cloud resource has been changed.'} Every segment comes from the engine's non-overlapping step cost model.</p>
    <div className="waterfall-flow" role="list" aria-label="Monthly cost bridge">
      <div className="waterfall-step waterfall-start" role="listitem"><span><b>Current monthly bill</b></span><b className="mono">{inr(total.originalInr)}</b><div className="waterfall-track"><span style={{width:'100%'}}/></div></div>
      {rows.map(row=>{left-=row.saving;return <div className="waterfall-step" key={row.id} role="listitem">
        <span>{row.name} <small className="tone-pass">−{inr(row.saving)}</small></span><b className="mono">{inr(left)}</b>
        <div className="waterfall-track"><span style={{width:`${Math.max(0,Math.min(100,left/Math.max(1,total.originalInr)*100))}%`}}/></div>
      </div>})}
      <div className="waterfall-end" role="listitem"><span>Projected monthly bill · {view==='eligible'?'hypothetical':'approved planning'}</span><strong>{inr(total.originalInr - sum)}</strong></div>
    </div>
    {view==='approved'&&steps.length===0&&<div className="actions"><span className="muted">No valid approvals recorded yet.</span><button onClick={()=>dispatch({type:'navigate',route:'optimize'})}>Review recommendations</button></div>}
    <p className="muted small">Price assumptions and exclusions are documented below. Rounding is for display; mathematical reconciliation is computed by the engine.</p>
  </Section>;
}
