// Two explainable, dependency-free Resource Explorer additions.
// No predictions, neural-network claims or changes to ForeSight decisions.
import { useMemo, useState } from 'react';
import { telemetryQuality, weeklyPulse } from '../engine/workloadInsights';
import type { MetricSeries } from '../engine/types';
import { Badge, Section } from './components';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function TelemetryPanels({ series }: { series: MetricSeries }) {
  const [metric, setMetric] = useState<'cpu' | 'memory'>('cpu');
  const quality = useMemo(() => telemetryQuality(series), [series]);
  const cells = useMemo(() => weeklyPulse(series, metric), [series, metric]);
  const missing = cells.filter((b) => b.expectedSamples > 0 && b.samples === 0).length;
  return (
    <div className="telemetry-panels">
      <Section title="Data Trust Radar" right={<Badge tone={quality.status === 'good' ? 'pass' : quality.status === 'review' ? 'warn' : 'unknown'}>{quality.status === 'good' ? 'Good coverage' : quality.status === 'review' ? 'Review gaps' : 'Insufficient telemetry'}</Badge>}>
        <p className="muted small">Checks observed CPU and memory records. This is data quality, <b>not a percentage probability of a safe resize</b>. ForeSight remains responsible for approval eligibility.</p>
        <div className="data-quality-grid">
          <div><span className="label">Complete intervals</span><strong>{(quality.coverage * 100).toFixed(1)}%</strong><progress max={100} value={quality.coverage * 100} aria-label="Complete telemetry intervals" /></div>
          <div><span className="label">Missing CPU / memory</span><strong>{quality.missingCpu} / {quality.missingMemory}</strong></div>
          <div><span className="label">Longest missing gap</span><strong>{quality.longestGapMinutes} min</strong></div>
          <div><span className="label">Zero-memory readings</span><strong>{quality.zeroMemoryPct.toFixed(1)}%</strong></div>
        </div>
        {quality.zeroMemoryPct > 1 && <p className="tone-warn small">More than 1% of complete readings show exactly zero memory; investigate telemetry quality before optimization.</p>}
      </Section>
      <Section title="Cloud Pulse · weekly activity" right={<label className="small">Metric <select aria-label="Cloud Pulse metric" value={metric} onChange={(e) => setMetric(e.target.value as 'cpu' | 'memory')}><option value="cpu">CPU</option><option value="memory">Memory</option></select></label>}>
        <p className="muted small">Observed average utilization at each day/hour in IST across the selected 30-day window. Hover a cell for its value and sample count. Empty cells are not estimated.</p>
        <div className="pulse-scroll">
          <div className="pulse-heatmap" role="img" aria-label={`${metric} activity by weekday and hour, India Standard Time`}>
            <span className="pulse-corner">IST</span>
            {Array.from({length:24}, (_,h) => <span className="pulse-hour" key={`h${h}`}>{h % 3 === 0 ? String(h).padStart(2,'0') : '·'}</span>)}
            {DAYS.map((day, d) => [
              <span className="pulse-day" key={`label${day}`}>{day}</span>,
              ...cells.slice(d * 24, d * 24 + 24).map((b) => {
                const coverage = b.expectedSamples ? b.samples/b.expectedSamples : 0;
                const intensity = b.value === null ? 0 : Math.min(1,Math.max(0,b.value/100));
                return <span className={`pulse-cell${coverage < 0.75 ? ' pulse-incomplete' : ''}`} key={`${day}${b.hour}`}
                  style={{ opacity: 0.14 + intensity * 0.86 }}
                  title={`${day} ${String(b.hour).padStart(2,'0')}:00 IST · ${b.value === null ? 'no data' : b.value.toFixed(1)+'%'} · ${b.samples}/${b.expectedSamples} samples`} />;
              }),
            ])}
          </div>
        </div>
        <p className="muted small">{missing} hour buckets without observations · Dots indicate low or missing coverage. Low utilization alone is never permission to shut down a service.</p>
      </Section>
    </div>
  );
}
