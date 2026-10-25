// B1–B6 and H1–H6. Every rupee in the app comes from these functions.
import { CONFIG, offHoursFraction } from './config';
import type { Region, Resource, Size } from './types';

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** B1 × B2 */
export function vmMonthlyCost(size: Size, region: Region): number {
  const p = CONFIG.pricing;
  return round2((size.vcpu * p.perVcpuInr + size.ramGb * p.perGbRamInr) * p.regionMultiplier[region]);
}

/** B4 */
export function volumeMonthlyCost(diskGb: number): number {
  return round2(diskGb * CONFIG.pricing.perGbDiskInr);
}

/** B5 */
export function ipMonthlyCost(): number {
  return CONFIG.pricing.publicIpInr;
}

export function resourceMonthlyCost(r: Resource): number {
  if (r.type === 'vm') return vmMonthlyCost({ vcpu: r.vcpu!, ramGb: r.ramGb! }, r.region);
  if (r.type === 'volume') return volumeMonthlyCost(r.diskGb ?? 0);
  return ipMonthlyCost();
}

/** H1 */
export function resizeSaving(current: Size, proposed: Size, region: Region): number {
  return round2(vmMonthlyCost(current, region) - vmMonthlyCost(proposed, region));
}

/** H2 */
export function scheduleSaving(size: Size, region: Region, offFraction: number = offHoursFraction()): number {
  return round2(vmMonthlyCost(size, region) * offFraction);
}

/** H3 — computed on the FINAL state, never resize + schedule added together. */
export function resizeScheduleSaving(current: Size, proposed: Size, region: Region, offFraction: number = offHoursFraction()): number {
  return round2(vmMonthlyCost(current, region) - vmMonthlyCost(proposed, region) * (1 - offFraction));
}

/** H4 — compute cost of a stopped VM is 0. */
export function stopSaving(size: Size, region: Region): number {
  return vmMonthlyCost(size, region);
}

export function cheaperCatalogSizes(current: Size, region: Region): Size[] {
  const currentCost = vmMonthlyCost(current, region);
  return CONFIG.catalog
    .filter((s) => vmMonthlyCost(s, region) < currentCost)
    .sort((a, b) => vmMonthlyCost(a, region) - vmMonthlyCost(b, region));
}

export function isCatalogSize(size: Size): boolean {
  return CONFIG.catalog.some((s) => s.vcpu === size.vcpu && s.ramGb === size.ramGb);
}

export const sizeLabel = (s: Size) => `${s.vcpu} vCPU / ${s.ramGb} GB`;
