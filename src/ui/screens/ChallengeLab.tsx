import { useMemo, useState } from 'react';
import { LiveDecisionTheater } from './LiveDecisionTheater';
import { projectCpu, projectMem } from '../../engine/capacity';
import { breakPoint, closestCall, compareForUsage, safeAlternative, withExtraWorkload, type ConfigOption } from '../../engine/challenge';
import { limitsFor } from '../../engine/config';
import { statusOf } from '../../engine/decisions';
import { evaluateSize } from '../../engine/foresight';
import { sizeLabel } from '../../engine/pricing';
import { applyScenario, SCENARIOS } from '../../engine/scenarios';
import type { ScenarioId, Size } from '../../engine/types';
import { hourlyMax } from '../../lib/downsample';
import { Empty, Legend, LineChart, Section, VerdictBadge } from '../components';
import { inr, pct } from '../format';
import { useApp } from '../store';

const SCENARIO_IDS = Object.keys(SCENARIOS) as ScenarioId[];

export function ChallengeLab() {
  const { state, data, dispatch } = useApp();
  const candidates = useMemo(
    () => state.recommendations.filter((r) => (r.action === 'resize' || r.action === 'resize+schedule') && r.proposed.size),
    [state.recommendations],
  );
  const fallback = candidates.find((r) => r.eligible) ?? candidates[0];
  const rec = candidates.find((r) => r.id === state.labRecId) ?? fallback;
  const [mode, setMode] = useState<'scenario' | 'slider'>('scenario');
  const [scenario, setScenario] = useState<ScenarioId>('normal');
  const [extra, setExtra] = useState(0);

  if (!rec) return <Empty>No resize recommendations to challenge.</Empty>;
  const resource = data.resourceById.get(rec.resourceId)!;
  const series = data.series.get(rec.resourceId)!;
  const current: Size = { vcpu: resource.vcpu!, ramGb: resource.ramGb! };
  const target = rec.proposed.size!;
  const L = limitsFor(resource.env);

  return (
    <div className="stack">
      <LiveDecisionTheater />
      <div className="notice">
        <b>Preview mode.</b> The existing single-recommendation scenarios and slider below re-run the real engine for just the selected recommendation. The new fleet-wide challenge above also runs in preview mode. Neither changes approvals,
        approved savings or decision history. To change plans for everyone, use “Adopt as planning assumption”.
      </div>

      <Section title="Recommendation under test">
        <select
          value={rec.id}
          onChange={(e) => dispatch({ type: 'openLab', recId: e.target.value })}
          aria-label="Choose a recommendation to challenge"
          className="wide"
        >
          {candidates.map((r) => (
            <option key={r.id} value={r.id}>
              {r.resourceName} ({r.env}) · {r.current.size && sizeLabel(r.current.size)} → {r.proposed.size && sizeLabel(r.proposed.size)} ·{' '}
              {r.verdict === 'PASS_UNDER_TESTED_CONDITIONS' ? 'PASS' : r.verdict === 'FAIL_SAFETY_CHECKS' ? 'FAIL' : 'INSUFFICIENT'}
            </option>
          ))}
        </select>
        <p>
          {sizeLabel(current)} → <b>{sizeLabel(target)}</b> · saving {inr(rec.monthlySavingInr)}/mo under normal conditions ·{' '}
          <VerdictBadge verdict={rec.verdict} long /> · decision: <b>{statusOf(state.decisions, rec.id)}</b>
        </p>
      </Section>

      <Section title="Challenge it">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'scenario'} className={mode === 'scenario' ? 'tab active' : 'tab'} onClick={() => setMode('scenario')}>
            Stress scenarios
          </button>
          <button role="tab" aria-selected={mode === 'slider'} className={mode === 'slider' ? 'tab active' : 'tab'} onClick={() => setMode('slider')}>
            Custom workload slider
          </button>
        </div>
        {mode === 'scenario' ? (
          <div className="chips">
            {SCENARIO_IDS.map((s) => (
              <button key={s} className={scenario === s ? 'chip active' : 'chip'} onClick={() => setScenario(s)} title={SCENARIOS[s].model}>
                {SCENARIOS[s].label}
              </button>
            ))}
          </div>
        ) : (
          <label className="slider">
            Extra workload <b>+{extra}%</b>
            <input type="range" min={0} max={200} step={1} value={extra} onChange={(e) => setExtra(Number(e.target.value))} aria-label="Extra workload percent" />
            <span className="muted small">CPU demand × (1 + x), memory × (1 + 0.4x) — assumptions.md §P</span>
          </label>
        )}
        <LabResult
          key={`${rec.id}-${mode}-${scenario}-${extra}`}
          mode={mode}
          scenario={scenario}
          extra={extra}
          recId={rec.id}
          current={current}
          target={target}
          limits={L}
        />
      </Section>

      <Section title="Planning assumption (changes approvals)">
        {state.adoptedScenario ? (
          <p>
            Adopted: <b>{SCENARIOS[state.adoptedScenario].label}</b>.{' '}
            <button className="ghost" onClick={() => dispatch({ type: 'resetAdoption', data })}>
              Reset to normal
            </button>
          </p>
        ) : (
          <p className="muted">Using normal historical demand.</p>
        )}
        <button
          disabled={mode !== 'scenario' || scenario === 'normal' || scenario === 'missingData' || state.adoptedScenario === scenario}
          onClick={() => dispatch({ type: 'adopt', scenario, data })}
          title="Re-validates every recommendation under this scenario; approvals that no longer pass are flagged for review"
        >
          Adopt “{SCENARIOS[scenario].label}” as planning assumption
        </button>
      </Section>
    </div>
  );

  function LabResult(props: {
    mode: 'scenario' | 'slider';
    scenario: ScenarioId;
    extra: number;
    recId: string;
    current: Size;
    target: Size;
    limits: ReturnType<typeof limitsFor>;
  }) {
    const usage = props.mode === 'scenario' ? applyScenario(series, props.scenario) : withExtraWorkload(series, props.extra);
    const label = props.mode === 'scenario' ? SCENARIOS[props.scenario].label : `+${props.extra}% workload`;
    const e = evaluateSize(usage, props.current, props.target, resource.env);
    const cc = closestCall(usage, series.start, props.current, props.target, resource.env);
    const bp = breakPoint(series, props.current, props.target, resource.env);
    const alt = e.verdict !== 'PASS_UNDER_TESTED_CONDITIONS' ? safeAlternative(usage, props.current, props.target, resource.env, resource.region) : null;
    const cmp = compareForUsage(resource, usage, label);
    const cpu = hourlyMax(projectCpu(usage.cpuPct, props.current, props.target));
    const mem = hourlyMax(projectMem(usage.memPct, props.current, props.target));
    const markerIndex = cc.kind === 'no-data' ? -1 : Math.floor(cc.index / 4);

    return (
      <div className="lab-result">
        <div className={`verdict-panel tone-border-${e.verdict === 'PASS_UNDER_TESTED_CONDITIONS' ? 'pass' : e.verdict === 'FAIL_SAFETY_CHECKS' ? 'fail' : 'unknown'}`}>
          <div className="label">{label} · on {sizeLabel(props.target)}</div>
          <VerdictBadge verdict={e.verdict} long />
          <ul className="reasons">
            {e.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <p className="muted small">{props.mode === 'scenario' ? SCENARIOS[props.scenario].model : 'Custom extra workload'} · preview only</p>
        </div>

        <h3>Projected CPU on {sizeLabel(props.target)} (hourly peak)</h3>
        <LineChart
          ariaLabel="Projected CPU"
          series={[{ name: 'CPU', values: cpu, className: 'line-cpu' }]}
          limits={[
            { value: props.limits.cpuP95, label: `p95 limit ${props.limits.cpuP95}%`, className: 'warn' },
            { value: props.limits.cpuMax, label: `max ${props.limits.cpuMax}%`, className: 'fail' },
          ]}
          marker={cc.kind !== 'no-data' && cc.metric === 'cpu' ? { index: markerIndex, label: cc.kind === 'closest-call' ? 'closest call' : 'first breach' } : null}
        />
        <h3>Projected memory on {sizeLabel(props.target)} (hourly peak)</h3>
        <LineChart
          ariaLabel="Projected memory"
          series={[{ name: 'Memory', values: mem, className: 'line-mem' }]}
          limits={[
            { value: props.limits.memP99, label: `p99 limit ${props.limits.memP99}%`, className: 'warn' },
            { value: props.limits.memMax, label: `max ${props.limits.memMax}%`, className: 'fail' },
          ]}
          marker={cc.kind !== 'no-data' && cc.metric === 'memory' ? { index: markerIndex, label: cc.kind === 'closest-call' ? 'closest call' : 'first breach' } : null}
        />
        <Legend items={[{ label: 'projected usage', className: 'line-cpu' }, { label: 'percentile limit', className: 'warn' }, { label: 'hard limit', className: 'fail' }]} />

        <div className="grid-2">
          <div className="card inset">
            <div className="label">Closest call (replay of history)</div>
            {cc.kind === 'closest-call' && (
              <p>
                {cc.at}: {cc.metric} {pct(cc.projectedPct)} vs hard limit {cc.limitPct}% → <b>{cc.headroomPts.toFixed(1)} points</b> headroom
              </p>
            )}
            {cc.kind === 'first-breach' && (
              <p className="tone-fail">
                First breach {cc.at}: {cc.metric} {pct(cc.projectedPct)} vs {cc.limitPct}% ({cc.breachCount} samples over)
              </p>
            )}
            {cc.kind === 'no-data' && <p className="muted">No samples.</p>}
          </div>
          <div className="card inset">
            <div className="label">Break point (from normal demand)</div>
            {bp.kind === 'found' && (
              <p>
                Stops passing at <b>+{bp.percent}%</b> extra workload (still passes at +{bp.lastPassingPercent}%).
              </p>
            )}
            {bp.kind === 'already-failing' && <p className="tone-fail">Already failing at the current workload.</p>}
            {bp.kind === 'none-found' && <p>No break point found within 0–{bp.testedUpToPercent}%.</p>}
            {bp.kind === 'insufficient-evidence' && <p className="tone-unknown">Insufficient evidence to compute a break point.</p>}
          </div>
        </div>

        {alt && (
          <div className="card inset">
            <div className="label">Safe alternative</div>
            <p>{alt.message}</p>
            {alt.kind === 'found' && (
              <p>
                <b>{sizeLabel(alt.option.size)}</b> · {inr(alt.option.monthlyCostInr)}/mo · saving {inr(alt.option.savingInr)}/mo
              </p>
            )}
            <p className="muted small">Only catalog sizes up to the current one were tested.</p>
          </div>
        )}

        <h3>Current vs cheapest vs cheapest safe — {label}</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Option</th>
                <th>Size</th>
                <th className="num">Cost/mo</th>
                <th className="num">Saving/mo</th>
                <th className="num">CPU p99</th>
                <th className="num">Mem p99</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              <CompareRow name="Current" o={cmp.current} />
              <CompareRow name="Cheapest" o={cmp.cheapest} />
              <CompareRow name="Cheapest safe" o={cmp.cheapestSafe} />
            </tbody>
          </table>
        </div>
      </div>
    );
  }
}

function CompareRow({ name, o }: { name: string; o: ConfigOption | null }) {
  if (!o)
    return (
      <tr>
        <td>{name}</td>
        <td colSpan={6} className="muted">
          none among the catalog sizes tested
        </td>
      </tr>
    );
  return (
    <tr>
      <td>{name}</td>
      <td className="mono">{sizeLabel(o.size)}</td>
      <td className="num mono">{inr(o.monthlyCostInr)}</td>
      <td className="num mono">{inr(o.savingInr)}</td>
      <td className="num mono">{pct(o.evaluation.projected?.cpuP99)}</td>
      <td className="num mono">{pct(o.evaluation.projected?.memP99)}</td>
      <td>
        <VerdictBadge verdict={o.evaluation.verdict} />
      </td>
    </tr>
  );
}
