// Writes small sample CSVs (judges/teams can upload them) and times a full-size import. Run: npx tsx scripts/sample-csv.ts
import { writeFileSync } from 'node:fs';
import { generateDataset } from '../src/data/generator';
import { datasetToCsv, importCsvDataset } from '../src/engine/importer';

const d = generateDataset();
// one VM of a few telling patterns + their volumes/IPs-free sample
const want = ['office-hours', 'bursty-prod', 'idle', 'night-traffic', 'weekend-idle', 'steady-low', 'anomaly'];
const vms = want.map((p) => d.resources.find((r) => r.type === 'vm' && d.patternOf.get(r.id) === p)!);
const extras = d.resources.filter((r) => r.type !== 'vm').slice(0, 4).map((r) => ({ ...r, attachedTo: null }));
const sub = [...vms, ...extras];
const { inventoryCsv, metricsCsv } = datasetToCsv(sub, new Map(vms.map((v) => [v.id, d.series.get(v.id)!])));
writeFileSync('docs/sample-data/inventory.csv', '# CloudSentinel X sample — SYNTHETIC data\n' + inventoryCsv);
writeFileSync('docs/sample-data/metrics.csv', '# CloudSentinel X sample — SYNTHETIC data, 15-minute samples, IST\n' + metricsCsv);
console.log(`sample: ${sub.length} resources, ${metricsCsv.split('\n').length - 2} metric rows`);

const full = datasetToCsv(d.resources, d.series);
const t = performance.now();
const r = importCsvDataset(full.inventoryCsv, full.metricsCsv);
console.log(`full import: ${full.metricsCsv.split('\n').length - 2} rows (${(full.metricsCsv.length / 1e6).toFixed(1)} MB) in ${(performance.now() - t).toFixed(0)} ms, ok=${r.ok}`);
