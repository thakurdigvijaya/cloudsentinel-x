// C4–C5: project usage from the current size onto a target size.
import type { Size } from './types';

/** C4: CPU demand (vCPU units) = cpu% × currentVcpu; projected % = demand / targetVcpu. */
export function projectCpu(cpuPct: readonly (number | null)[], current: Size, target: Size): (number | null)[] {
  const factor = current.vcpu / target.vcpu;
  return cpuPct.map((v) => (v === null ? null : v * factor));
}

/** C5: memory used (GB) = mem% × currentRam; projected % = used / targetRam. Independent of CPU. */
export function projectMem(memPct: readonly (number | null)[], current: Size, target: Size): (number | null)[] {
  const factor = current.ramGb / target.ramGb;
  return memPct.map((v) => (v === null ? null : v * factor));
}
