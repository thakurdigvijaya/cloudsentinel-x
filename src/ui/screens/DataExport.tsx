// Data & Export: bring your own CSV (same engine runs on it), download samples, export the report and change plan.
import { useState } from 'react';
import { generateDataset } from '../../data/generator';
import { changeScript, recommendationsToCsv } from '../../engine/export';
import { datasetToCsv, importCsvDataset, type ImportIssue } from '../../engine/importer';
import { Badge, Section } from '../components';
import { buildData } from '../data';
import { datasetFingerprint } from '../datasetFingerprint';
import { forgetAllImportedData, rememberImportedData, setSyntheticActive } from '../importStorage';
import { useApp } from '../store';

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const readFile = (f: File) => f.text();

export function DataExport() {
  const { state, data, dispatch } = useApp();
  const [inv, setInv] = useState<File | null>(null);
  const [met, setMet] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<ImportIssue[]>([]);
  const [warnings, setWarnings] = useState<ImportIssue[]>([]);

  const runImport = async () => {
    if (!inv || !met) return;
    setBusy(true);
    setErrors([]);
    setWarnings([]);
    try {
      const [inventoryCsv, metricsCsv] = await Promise.all([readFile(inv), readFile(met)]);
      const r = importCsvDataset(inventoryCsv, metricsCsv);
      setWarnings(r.warnings);
      if (!r.ok) {
        setErrors(r.errors);
        return;
      }
      // A content hash prevents approvals from a different same-name/same-size dataset leaking into this one.
      const id = await datasetFingerprint(inventoryCsv, metricsCsv);
      const imported = buildData(r.resources, r.series, { id, source: 'imported', start: r.start!, days: r.days });
      // Persist the selected import before switching views; IndexedDB accommodates 30-day telemetry.
      try { await rememberImportedData(imported); } catch (error) {
        setSyntheticActive(); // prevent silently switching back to a previous upload on refresh
        setWarnings((items) => [...items, { file: 'inventory', line: null, message: `Analysed successfully, but this browser could not save the import for reopening: ${(error as Error).message}. Reimport after refresh.` }]);
      }
      dispatch({ type: 'replaceData', data: imported });
    } catch (e) {
      setErrors([{ file: 'inventory', line: null, message: `Could not read the files: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const sample = () => {
    // a small sample built from the synthetic dataset (7 VMs + 4 resources), same format the importer reads
    const d = generateDataset();
    const want = ['office-hours', 'bursty-prod', 'idle', 'night-traffic', 'weekend-idle', 'steady-low', 'anomaly'];
    const vms = want.map((p) => d.resources.find((r) => r.type === 'vm' && d.patternOf.get(r.id) === p)!);
    const extras = d.resources.filter((r) => r.type !== 'vm').slice(0, 4);
    const csv = datasetToCsv([...vms, ...extras], new Map(vms.map((v) => [v.id, d.series.get(v.id)!])));
    download('sample-inventory.csv', '# CloudSentinel X sample — SYNTHETIC data\n' + csv.inventoryCsv, 'text/csv');
    download('sample-metrics.csv', '# CloudSentinel X sample — SYNTHETIC data, 15-minute samples, IST\n' + csv.metricsCsv, 'text/csv');
  };

  return (
    <div className="stack">
      <Section title="Use your own data" right={<Badge tone={data.source === 'synthetic' ? 'neutral' : 'accent'}>{data.label}</Badge>}>
        <p className="muted small">
          Upload an inventory CSV and a metrics CSV (5–15 minute samples). The same engine runs on them; nothing leaves your browser. Your last imported dataset is retained in this browser using IndexedDB when storage is permitted (not shared with the Node API or other devices). Bad rows are listed with their line
          number — the importer never guesses a value. Timestamps need a time zone (e.g. 2026-09-07T10:15:00+05:30).
        </p>
        <div className="drop">
          <label>
            Inventory CSV (id, name, type, region, env, team, created_at, vcpu, ram_gb, disk_gb, attached_to, detached_days, depends_on)
            <input type="file" accept=".csv,text/csv" onChange={(e) => setInv(e.target.files?.[0] ?? null)} />
          </label>
          <label>
            Metrics CSV (resource_id, timestamp, cpu_pct, mem_pct, disk_pct, iops, net_in_mbps, net_out_mbps)
            <input type="file" accept=".csv,text/csv" onChange={(e) => setMet(e.target.files?.[0] ?? null)} />
          </label>
          <div className="actions">
            <button disabled={!inv || !met || busy} onClick={runImport}>
              {busy ? 'Analysing…' : 'Analyse my data'}
            </button>
            <button className="ghost" onClick={sample}>
              Download sample CSVs
            </button>
            {data.source === 'imported' && (
              <button
                className="ghost"
                onClick={() => {
                  setSyntheticActive();
                  const d = generateDataset();
                  dispatch({ type: 'replaceData', data: buildData(d.resources, d.series, { id: 'synthetic-2026', source: 'synthetic', start: d.start, days: 30 }) });
                }}
              >
                Back to the synthetic dataset
              </button>
            )}
            {data.source === 'imported' && (
              <button className="ghost" onClick={async () => {
                try {
                  await forgetAllImportedData();
                  const d = generateDataset();
                  dispatch({ type: 'replaceData', data: buildData(d.resources, d.series, { id: 'synthetic-2026', source: 'synthetic', start: d.start, days: 30 }) });
                } catch (error) {
                  setErrors([{ file: 'inventory', line: null, message: `Could not clear browser storage: ${(error as Error).message}` }]);
                }
              }}>
                Forget locally saved imported data
              </button>
            )}
          </div>
          {errors.length > 0 && (
            <>
              <b className="tone-fail">Import refused — fix these rows and try again:</b>
              <ul className="error-list">
                {errors.map((e, i) => (
                  <li key={i}>
                    {e.file}
                    {e.line ? ` line ${e.line}` : ''}
                    {e.field ? ` (${e.field})` : ''}: {e.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          {warnings.length > 0 && (
            <ul className="reasons small tone-warn">
              {warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section title="Export">
        <div className="actions">
          <button onClick={() => download('cloudsentinel-recommendations.csv', recommendationsToCsv(state.recommendations, state.decisions), 'text/csv')}>
            Recommendations report (CSV)
          </button>
          <button className="ghost" onClick={() => download('cloudsentinel-change-plan.txt', changeScript(state.recommendations, state.decisions), 'text/plain')}>
            Change plan for APPROVED steps
          </button>
          <button className="ghost" onClick={() => download('cloudsentinel-change-plan-eligible.txt', changeScript(state.recommendations), 'text/plain')}>
            Change plan for all safe changes
          </button>
        </div>
        <p className="muted small">
          The change plan is pseudo-commands for review — not a real UTHO CLI; nothing is executed. Deletions take a snapshot first; event holds print “do not apply before”.
          Evidence Passports are in the Decision Center.
        </p>
      </Section>

      <Section title="API (optional backend)">
        <p className="muted small">
          The same engine also runs as an API: <span className="mono">npm run server</span> → <span className="mono">/api/health</span> (authenticated Secure Team API; start backend separately). Routes include
          /api/summary, /api/recommendations, /api/whatif, /api/utsav/*, /api/portfolio, /api/import and /api/export.csv (see README).
        </p>
      </Section>
    </div>
  );
}
