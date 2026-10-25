// Engine speed check. Run: npx tsx scripts/benchmark.ts
// Targets (phases.md): full analysis < 300 ms, one Challenge Lab scenario re-check < 50 ms.
import { generateDataset } from '../src/data/generator';
import { analyzeAll, previewRecommendation } from '../src/engine';

const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;

for (const scale of [1, 3, 10]) {
  const g = performance.now();
  const d = generateDataset(2026, scale);
  const genTime = ms(g);
  const vms = d.resources.filter((r) => r.type === 'vm').length;

  const cold = performance.now();
  const a = analyzeAll(d.resources, d.series);
  const coldTime = ms(cold);

  const warm = performance.now();
  analyzeAll(d.resources, d.series);
  const warmTime = ms(warm);

  const rec = a.recommendations.find((r) => r.action === 'resize' && r.eligible)!;
  const res = d.resources.find((r) => r.id === rec.resourceId)!;
  const p = performance.now();
  previewRecommendation(res, d.series.get(res.id)!, rec, 'traffic60');
  const previewTime = ms(p);

  console.log(
    `${String(vms).padStart(4)} VMs (${d.resources.length} resources): generate ${genTime} · analyze first run ${coldTime} · ` +
      `analyze again ${warmTime} · one scenario preview ${previewTime}`,
  );
}
