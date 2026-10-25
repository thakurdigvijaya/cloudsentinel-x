// Section J: reject invalid input before any recommendation is made.
import { isCatalogSize } from './pricing';
import type { MetricSeries, Resource, ValidationError } from './types';

const REGIONS = ['noida', 'bengaluru', 'mumbai'];
const ENVS = ['prod', 'staging', 'dev'];

export function validateResource(r: Resource): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!r.id) errors.push({ field: 'id', message: 'Resource id is required.' });
  if (typeof r.name !== 'string' || !r.name.trim()) errors.push({ field: 'name', message: 'Resource name is required.' });
  if (typeof r.team !== 'string' || !r.team.trim()) errors.push({ field: 'team', message: 'Resource owner/team is required.' });
  if (typeof r.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.createdAt) || !Number.isFinite(Date.parse(r.createdAt))) errors.push({ field: 'createdAt', message: 'Valid creation date (YYYY-MM-DD) is required.' });
  if (!REGIONS.includes(r.region)) errors.push({ field: 'region', message: `Unknown region "${r.region}".` });
  if (!ENVS.includes(r.env)) errors.push({ field: 'env', message: `Unknown environment "${r.env}".` });

  if (r.type === 'vm') {
    const { vcpu, ramGb } = r;
    if (!Number.isFinite(vcpu) || (vcpu ?? 0) <= 0) errors.push({ field: 'vcpu', message: 'vCPU must be a positive number.' });
    if (!Number.isFinite(ramGb) || (ramGb ?? 0) <= 0) errors.push({ field: 'ramGb', message: 'RAM must be a positive number.' });
    if (errors.length === 0 && !isCatalogSize({ vcpu: vcpu!, ramGb: ramGb! }))
      errors.push({ field: 'size', message: `${vcpu} vCPU / ${ramGb} GB is not a catalog size.` });
    if (r.diskGb !== undefined && (!Number.isFinite(r.diskGb) || r.diskGb <= 0))
      errors.push({ field: 'diskGb', message: 'Disk size must be positive.' });
  } else if (r.type === 'volume') {
    if (!Number.isFinite(r.diskGb) || (r.diskGb ?? 0) <= 0) errors.push({ field: 'diskGb', message: 'Disk size must be positive.' });
  } else if (r.type !== 'ip') {
    errors.push({ field: 'type', message: `Unknown resource type "${String(r.type)}".` });
  }
  return errors;
}

export function validateSeries(s: MetricSeries): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!Number.isFinite(Date.parse(s.start))) errors.push({ field: 'start', message: 'A valid ISO sampling start timestamp is required.' });
  if (s.stepMinutes !== 15) errors.push({ field: 'stepMinutes', message: 'The engine expects 15-minute interval data.' });
  if (s.analysisTime !== undefined && !Number.isFinite(Date.parse(s.analysisTime))) errors.push({ field: 'analysisTime', message: 'A valid analysis reference timestamp is required.' });
  const n = s.cpuPct.length;
  const all = { cpuPct: s.cpuPct, memPct: s.memPct, diskPct: s.diskPct, iops: s.iops, netInMbps: s.netInMbps, netOutMbps: s.netOutMbps };
  for (const [name, arr] of Object.entries(all)) {
    if (arr.length !== n) errors.push({ field: name, message: `Series length ${arr.length} does not match cpuPct length ${n}.` });
    const isPct = name.endsWith('Pct');
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v === null) continue;
      if (!Number.isFinite(v)) {
        errors.push({ field: name, message: `Sample ${i} is not a finite number.` });
        break;
      }
      if (v < 0 || (isPct && v > 100)) {
        errors.push({ field: name, message: `Sample ${i} = ${v} is out of range.` });
        break;
      }
    }
  }
  return errors;
}
