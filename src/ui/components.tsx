// Small shared UI pieces + SVG charts (no chart library).
import type { ReactNode } from 'react';
import type { Verdict } from '../engine/types';
import { CountUp } from './CountUp';
import { VERDICT } from './format';

export function Badge({ tone, children, title }: { tone: 'pass' | 'fail' | 'warn' | 'unknown' | 'neutral' | 'accent'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const ICON: Record<string, string> = { pass: '✓', fail: '✕', unknown: '?', neutral: '–' };

export function VerdictBadge({ verdict, long = false }: { verdict: Verdict; long?: boolean }) {
  const v = VERDICT[verdict];
  return (
    <Badge tone={v.tone} title={v.label}>
      <span aria-hidden>{ICON[v.tone]}</span> {long ? v.label : v.short}
    </Badge>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'pass' | 'fail' | 'warn' }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className={`kpi-value ${tone ? 'tone-' + tone : ''}`}>
        <CountUp text={value} />
      </div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card section">
      <header className="section-head">
        <h2>{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// ---------------------------------------------------------------- charts

export interface LineSeries {
  name: string;
  values: (number | null)[];
  className: string;
}

export interface LimitLine {
  value: number;
  label: string;
  className: string;
}

/** Simple responsive SVG line chart for 0–N% series with dashed limit lines and an optional marker. */
export function LineChart({
  series,
  limits = [],
  marker,
  height = 180,
  yMax,
  ariaLabel,
}: {
  series: LineSeries[];
  limits?: LimitLine[];
  marker?: { index: number; label: string } | null;
  height?: number;
  yMax?: number;
  ariaLabel: string;
}) {
  const W = 720;
  const H = height;
  const pad = { l: 34, r: 8, t: 8, b: 18 };
  const n = Math.max(...series.map((s) => s.values.length), 1);
  const dataMax = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)), ...limits.map((l) => l.value));
  const top = yMax ?? Math.max(100, Math.ceil(dataMax / 10) * 10);
  const x = (i: number) => pad.l + (i / Math.max(n - 1, 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);

  const path = (values: (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const ticks = [0, top / 2, top];
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
          <text x={pad.l - 4} y={y(t) + 4} className="axis" textAnchor="end">
            {Math.round(t)}%
          </text>
        </g>
      ))}
      {limits.map((l) => (
        <g key={l.label}>
          <line x1={pad.l} x2={W - pad.r} y1={y(l.value)} y2={y(l.value)} className={`limit ${l.className}`} />
          <text x={W - pad.r - 2} y={y(l.value) - 3} className={`axis ${l.className}`} textAnchor="end">
            {l.label}
          </text>
        </g>
      ))}
      {series.map((s) => (
        <path key={s.name} d={path(s.values)} className={`line ${s.className}`} />
      ))}
      {marker && marker.index >= 0 && (
        <g>
          <line x1={x(marker.index)} x2={x(marker.index)} y1={pad.t} y2={H - pad.b} className="marker" />
          <text x={Math.min(x(marker.index) + 4, W - 160)} y={pad.t + 12} className="axis marker-text">
            {marker.label}
          </text>
        </g>
      )}
      <text x={pad.l} y={H - 4} className="axis">
        day 1
      </text>
      <text x={W - pad.r} y={H - 4} className="axis" textAnchor="end">
        day 30
      </text>
    </svg>
  );
}

export function Legend({ items }: { items: { label: string; className: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <i className={`swatch ${i.className}`} /> {i.label}
        </span>
      ))}
    </div>
  );
}

/** Horizontal bars, e.g. spend by environment. Values are passed in already computed by the engine. */
export function Bars({ rows, format, wideLabels = false }: { rows: { label: string; value: number; secondary?: number }[]; format: (n: number) => string; wideLabels?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <Empty>Nothing to show.</Empty>;
  return (
    <div className={wideLabels ? 'bars wide' : 'bars'}>
      {rows.map((r) => (
        <div className="bar-row" key={r.label}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
            {r.secondary !== undefined && <span className="bar-fill secondary" style={{ width: `${(r.secondary / max) * 100}%` }} />}
          </span>
          <span className="bar-value">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
