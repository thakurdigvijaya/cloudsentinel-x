// The Motion switch. One setting for the whole site (landing and workspace): "on" plays the animations, "off" leaves
// everything still. The operating system's "reduce motion" setting always wins over it. The choice is remembered in this
// browser (sessionStorage first, then localStorage, like the theme) and mirrored on <html data-motion>.
import { useCallback, useSyncExternalStore } from 'react';

const KEY = 'csx-motion-preference';
export type MotionPref = 'on' | 'off';

function readPref(): MotionPref {
  for (const store of ['sessionStorage', 'localStorage'] as const) {
    try {
      const v = window[store].getItem(KEY);
      if (v === 'on' || v === 'off') return v;
    } catch {
      /* storage unavailable: try the next one */
    }
  }
  return 'on';
}

export const prefersReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let pref: MotionPref = typeof window === 'undefined' ? 'on' : readPref();
const subs = new Set<() => void>();
const effective = (): 'on' | 'off' => (pref === 'on' && !prefersReducedMotion() ? 'on' : 'off');
const apply = () => {
  if (typeof document !== 'undefined') document.documentElement.dataset.motion = effective();
};
apply();

export function setMotionPref(next: MotionPref) {
  pref = next;
  for (const store of ['sessionStorage', 'localStorage'] as const) {
    try {
      window[store].setItem(KEY, next);
    } catch {
      /* ignore */
    }
  }
  apply();
  subs.forEach((f) => f());
}

function subscribe(cb: () => void) {
  subs.add(cb);
  const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const onMq = () => {
    apply();
    cb();
  };
  mq?.addEventListener?.('change', onMq);
  return () => {
    subs.delete(cb);
    mq?.removeEventListener?.('change', onMq);
  };
}

/** `on` is what animations should obey; `pref` is what the switch shows. */
export function useMotion() {
  const eff = useSyncExternalStore(subscribe, effective, () => 'on' as const);
  const toggle = useCallback(() => setMotionPref(pref === 'on' ? 'off' : 'on'), []);
  return { on: eff === 'on', pref, toggle, reducedByOs: prefersReducedMotion() };
}
