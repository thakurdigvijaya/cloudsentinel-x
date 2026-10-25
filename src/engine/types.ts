// Shared types for the CloudSentinel X engine. No UI code here.

export type Region = 'noida' | 'bengaluru' | 'mumbai';
export type Env = 'prod' | 'staging' | 'dev';
export type ResourceType = 'vm' | 'volume' | 'ip';

export interface Size {
  vcpu: number;
  ramGb: number;
}

export interface Resource {
  id: string;
  name: string;
  type: ResourceType;
  region: Region;
  env: Env;
  team: string;
  createdAt: string;
  /** VMs only */
  vcpu?: number;
  ramGb?: number;
  /** volumes: size; VMs: boot disk size (inventory only — VM price is compute only, assumptions B7) */
  diskGb?: number;
  /** volumes: VM id it is attached to; IPs: VM id it is attached to. null = unattached */
  attachedTo?: string | null;
  /** volumes / IPs: days since detached (0 if attached) */
  detachedDays?: number;
  /** ids of resources THIS resource depends on ("A depends on B" → A.dependsOn includes B). Dependency Shield, §X */
  dependsOn?: string[];
  /** intentional synthetic scenario label (documentation + tests); "imported" for user data */
  pattern: string;
}

/** 15-minute samples. null = missing sample. Values are % of the CURRENT size (cpu, mem, disk). */
export interface MetricSeries {
  resourceId: string;
  /** ISO timestamp of sample 0, a Monday 00:00 IST */
  start: string;
  stepMinutes: 15;
  /** When imported as live telemetry, check freshness against this clock. Synthetic replays omit it. */
  analysisTime?: string;
  cpuPct: (number | null)[];
  memPct: (number | null)[];
  diskPct: (number | null)[];
  iops: (number | null)[];
  netInMbps: (number | null)[];
  netOutMbps: (number | null)[];
}

export type Action =
  | 'resize'
  | 'stop'
  | 'schedule'
  | 'resize+schedule'
  | 'delete-volume'
  | 'release-ip'
  | 'none';

export type Verdict =
  | 'PASS_UNDER_TESTED_CONDITIONS'
  | 'FAIL_SAFETY_CHECKS'
  | 'INSUFFICIENT_EVIDENCE'
  | 'NO_ACTION';

export type Risk = 'low' | 'medium' | 'high';

export type ScenarioId = 'normal' | 'traffic25' | 'traffic60' | 'cpuBurst' | 'memPressure' | 'missingData';

export interface CheckResult {
  id: string; // E1..E7
  label: string;
  limit: number;
  /** null when it could not be measured */
  actual: number | null;
  /** null when not applicable */
  passed: boolean | null;
  unit: '%' | 'days' | 'h' | 'ratio' | 'count';
}

export interface UsageStats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  count: number;
}

export interface Evidence {
  cpu: UsageStats | null;
  mem: UsageStats | null;
  netP95Mbps: number | null;
  offHoursCpuP95: number | null;
  /** network (in + out) p95 outside business hours — evidence of off-hours dependencies */
  offHoursNetP95Mbps: number | null;
  /** Saturday + Sunday (all hours) — for the weekend-only schedule (D3b) */
  weekendCpuP95?: number | null;
  weekendNetP95Mbps?: number | null;
  coverage: number;
  historyDays: number;
  lastSampleAgeHours: number;
  burstiness: number | null;
  /** projected on the proposed size, when a resize is proposed */
  projected?: { cpuP95: number; cpuP99: number; cpuMax: number; memP99: number };
}

export interface PlanSide {
  size?: Size;
  hoursOnPerMonth: number;
  monthlyCostInr: number;
}

export type StepAction = 'remove' | 'resize' | 'schedule';

export interface PlanStep {
  action: StepAction;
  /** remove = stop VM / delete volume / release IP */
  label: string;
  /** monthly cost after this step (when all earlier steps are also applied) */
  costAfterInr: number;
  marginalSavingInr: number;
  /** resize target, for resize steps */
  size?: Size;
  /** schedule steps: share of the month the VM is off (nights+weekends ≈ 0.6433, weekends only ≈ 0.2866) */
  offFraction?: number;
}

export interface Recommendation {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: ResourceType;
  env: Env;
  region: Region;
  team: string;
  action: Action;
  current: PlanSide;
  proposed: PlanSide;
  monthlySavingInr: number;
  savingFormula: string;
  /**
   * Ordered breakdown (remove → resize → schedule). Each step's marginal saving is applied to the
   * cost left by the previous step, so the steps add up exactly to monthlySavingInr.
   */
  steps: PlanStep[];
  evidence: Evidence;
  checks: CheckResult[];
  verdict: Verdict;
  risk: Risk;
  /** 0..1 — data coverage × history completeness */
  dataAdequacyScore: number;
  reasons: string[];
  assumptionIds: string[];
  requiresHumanReview: boolean;
  /** true only when verdict is PASS and saving > 0 */
  eligible: boolean;
  /**
   * Set only after revalidation under adopted planning assumptions: the steps that still pass on their own
   * (e.g. ['schedule'] when the resize of a resize+schedule plan fails but the schedule does not).
   * Absent → all steps when eligible, none otherwise.
   */
  validSteps?: StepAction[];
  /** Utsav Mode (§Z): do not apply the resize before this date (YYYY-MM-DD) because an upcoming event would break it. */
  holdUntil?: string;
  /** Dependency Shield: steps blocked because a dependent would keep running (§X). Never re-enabled by a preview. */
  blockedSteps?: StepAction[];
  /** schedule / resize+schedule only: which hours the VM is off. Absent = nights and weekends. */
  scheduleWindow?: 'nights-and-weekends' | 'weekends';
}

export interface ValidationError {
  field: string;
  message: string;
}

export type AnalysisResult =
  | { ok: true; recommendation: Recommendation }
  | { ok: false; resourceId: string; errors: ValidationError[] };

export type AlertType = 'usage-spike' | 'capacity-trend' | 'insufficient-data' | 'spend-increase' | 'budget-overrun' | 'unexpected-pattern';

export interface Alert {
  id: string;
  type: AlertType;
  severity: 'info' | 'warning' | 'critical';
  resourceId: string | null;
  title: string;
  why: string;
  firstSeen?: string;
  /** every alert is computed from synthetic data */
  synthetic: true;
}
