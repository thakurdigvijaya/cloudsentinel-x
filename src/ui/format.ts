// Display formatting only. No calculations that produce money or verdicts.
import type { Action, Risk, Verdict } from '../engine/types';

export const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');
export const inr2 = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`);

export const VERDICT: Record<Verdict, { label: string; short: string; tone: 'pass' | 'fail' | 'unknown' | 'neutral' }> = {
  PASS_UNDER_TESTED_CONDITIONS: { label: 'PASS under tested conditions', short: 'PASS', tone: 'pass' },
  FAIL_SAFETY_CHECKS: { label: 'FAIL safety checks', short: 'FAIL', tone: 'fail' },
  INSUFFICIENT_EVIDENCE: { label: 'Insufficient evidence', short: 'INSUFFICIENT', tone: 'unknown' },
  NO_ACTION: { label: 'No action needed', short: 'NO ACTION', tone: 'neutral' },
};

export const ACTION: Record<Action, string> = {
  resize: 'Resize',
  stop: 'Stop VM',
  schedule: 'Schedule off-hours',
  'resize+schedule': 'Resize + schedule',
  'delete-volume': 'Delete volume',
  'release-ip': 'Release IP',
  none: 'No change',
};

export const RISK_TONE: Record<Risk, 'pass' | 'warn' | 'fail'> = { low: 'pass', medium: 'warn', high: 'fail' };
