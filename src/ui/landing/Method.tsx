// The method section: five steps on the left, and on the right one Evidence Sphere that changes meaning with the step.
// The sphere is made of the loaded dataset's real resources (one point each) and the two interactive modules (demand
// scenarios, risk appetite) run the real engine. On wide screens the scroll position picks the step; on phones the
// five step buttons do. The sphere only renders while it is on screen, and it never renders when Motion is off.
import { useEffect, useMemo, useRef, useState } from 'react';
import { RISK_APPETITES, type RiskAppetite } from '../../engine/portfolio';
import { SCENARIOS } from '../../engine/scenarios';
import type { ScenarioId } from '../../engine/types';
import type { AppData } from '../data';
import { ACTION, VERDICT, inr } from '../format';
import { prefersReducedMotion } from '../motion';
import type { Route, Theme } from '../store';
import { ArrowUpRight } from './icons';
import { DUST, computeStress, placementFor, portfolioView, targetsFor, type Fleet, type Kind, type PortfolioView, type Stress } from './model';
import { SphereScene } from './sphere';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const SCENARIO_ORDER: ScenarioId[] = ['normal', 'traffic25', 'traffic60', 'cpuBurst', 'memPressure', 'missingData'];
const APPETITES: RiskAppetite[] = ['cautious', 'balanced', 'bold'];
const KIND_LABEL: Record<Kind, string> = { safe: 'Passes every check', refused: 'A check failed', thin: 'Not enough evidence', none: 'No change proposed' };

const STEPS: { no: string; name: string; blurb: string; title: string; route: Route; link: string }[] = [
  { no: '01', name: 'Discover', blurb: 'Find the overlooked. Surface meaningful cost and usage signals worth investigating.', title: 'Every resource, one bill.', route: 'command', link: 'Open the Command Center' },
  { no: '02', name: 'Analyse', blurb: 'Understand baselines, evidence sources and where assumptions begin.', title: 'A verdict, not a suggestion.', route: 'optimize', link: 'Open the Optimization Center' },
  { no: '03', name: 'Challenge', blurb: 'See how an idea responds to peaks, dependencies and demand changes.', title: 'Break it before it ships.', route: 'lab', link: 'Open the Challenge Lab' },
  { no: '04', name: 'Verify', blurb: 'Show what was actually tested, and what remains unverified.', title: 'Leave out what the data cannot support.', route: 'plan', link: 'Open Plan Ahead' },
  { no: '05', name: 'Decide', blurb: 'Keep a clear record of reasoning, tradeoffs and next steps.', title: 'A set of changes, inside a risk budget.', route: 'optimize', link: 'Choose this set in the Optimization Center' },
];

interface Hover { i: number; x: number; y: number; pinned: boolean }
interface Props { data: AppData; fleet: Fleet; theme: Theme; motionOn: boolean; go: (r: Route) => void; openResource: (id: string) => void }

export function Method({ data, fleet, theme, motionOn, go, openResource }: Props) {
  const portfolios = useMemo(() => Object.fromEntries(APPETITES.map((a) => [a, portfolioView(data, a)])) as Record<RiskAppetite, PortfolioView>, [data]);
  const [step, setStep] = useState(0);
  const [scenario, setScenario] = useState<ScenarioId>('normal');
  const [appetite, setAppetite] = useState<RiskAppetite>('balanced');
  const [calculating, setCalculating] = useState(false);
  const [stressVersion, setStressVersion] = useState(0);
  const [force2d, setForce2d] = useState(false);
  const [mode, setMode] = useState<'webgl' | 'canvas2d'>('webgl');
  const [sceneKey, setSceneKey] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SphereScene | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<(immediate: boolean) => void>(() => {});
  const stepRef = useRef(0);
  const motionRef = useRef(motionOn);
  const hoverRef = useRef<Hover | null>(null);
  const redrawRef = useRef<() => void>(() => {});
  const syncRef = useRef<() => void>(() => {});
  const stressCache = useRef(new Map<ScenarioId, Stress>());
  stepRef.current = step;
  motionRef.current = motionOn;
  hoverRef.current = hover;

  // ---- stress explorer: compute a scenario once, keep it ----
  const stress = stressCache.current.get(scenario) ?? null;
  useEffect(() => {
    if (stressCache.current.has(scenario)) return;
    setCalculating(true);
    const id = setTimeout(() => {
      stressCache.current.set(scenario, computeStress(data, scenario));
      setStressVersion((v) => v + 1);
      setCalculating(false);
    }, 40);
    return () => clearTimeout(id);
  }, [scenario, data]);
  useEffect(() => {
    const timers = SCENARIO_ORDER.map((s, k) =>
      setTimeout(() => {
        if (!stressCache.current.has(s)) stressCache.current.set(s, computeStress(data, s));
      }, 6000 + k * 700),
    );
    return () => timers.forEach(clearTimeout);
  }, [data]);

  // ---- which step: scroll position on wide screens, the buttons on phones ----
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let queued = false;
    const update = () => {
      queued = false;
      if (innerWidth < 900) {
        list.style.removeProperty('--stepFill');
        return;
      }
      const mid = innerHeight * 0.52;
      const items = Array.from(list.querySelectorAll<HTMLElement>('.lp-step'));
      let best = 0;
      let bd = Infinity;
      items.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      setStep(best);
      const lr = list.getBoundingClientRect();
      list.style.setProperty('--stepFill', `${(clamp((mid - lr.top) / lr.height, 0, 1) * 100).toFixed(1)}%`);
    };
    const onScroll = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    update();
    return () => {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
    };
  }, []);
  const pickStep = (i: number) => {
    const list = listRef.current;
    if (innerWidth < 900 || !list) {
      setStep(i);
      return;
    }
    const el = list.querySelectorAll<HTMLElement>('.lp-step')[i];
    const r = el.getBoundingClientRect();
    scrollTo({ top: scrollY + r.top + r.height / 2 - innerHeight * 0.52, behavior: motionRef.current ? 'smooth' : 'auto' });
  };

  const tipPos = (x: number, y: number) => {
    const st = stageRef.current;
    const w = st?.clientWidth ?? 400;
    const h = st?.clientHeight ?? 500;
    return { left: clamp(x + 14, 8, Math.max(8, w - 238)), top: clamp(y + 14, 44, Math.max(44, h - 250)) };
  };

  // ---- the sphere: created once, drawn only while visible ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const scene = new SphereScene(canvas, fleet.nodes.length, {
      dust: stage.clientWidth < 520 ? 1600 : 2400,
      reduced: !motionRef.current,
      forceCanvas2d: force2d,
      onLost: () => setForce2d(true),
    });
    sceneRef.current = scene;
    setMode(scene.mode);
    let W = 1;
    let H = 1;
    let raf = 0;
    let running = false;
    let visible = false;
    let last = performance.now();
    const t0 = last;
    const pt = { x: 0, y: 0 };
    const pm = { x: 0, y: 0 };
    let down: { x: number; y: number; moved: number } | null = null;

    const draw = (dt: number, time: number) => {
      const soft = scene.reduced ? 1 : 1 - Math.exp(-dt / 0.14);
      pm.x += (pt.x - pm.x) * soft;
      pm.y += (pt.y - pm.y) * soft;
      scene.pointer.x = scene.reduced ? 0 : pm.x;
      scene.pointer.y = scene.reduced ? 0 : pm.y;
      scene.frame(dt, time);
    };
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      draw(dt, (now - t0) / 1000);
      raf = requestAnimationFrame(tick);
    };
    const sync = () => {
      const should = visible && !document.hidden && !scene.reduced;
      if (should && !running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(tick);
      } else if (!should && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
      if (!should && (visible || scene.reduced)) draw(0.016, 0);
    };
    syncRef.current = sync;
    redrawRef.current = () => {
      if (!running) draw(0.016, 0);
    };

    // Phones: the sphere has its own 330px band above the card. Wide screens: the sphere fills the panel and the card overlays its lower part.
    const bandH = () => (matchMedia('(max-width: 899px)').matches ? 330 : stage.clientHeight);
    const freeH = () => (matchMedia('(max-width: 899px)').matches ? 330 : Math.max(240, stage.clientHeight - (cardRef.current?.offsetHeight ?? 230) - 6));
    const layout = (immediate: boolean) => {
      scene.place(placementFor(stepRef.current + 1, W, freeH()), immediate);
      redrawRef.current();
    };
    layoutRef.current = layout;
    const resize = () => {
      W = stage.clientWidth;
      H = bandH();
      const dpr = Math.min(devicePixelRatio || 1, W < 520 ? 1.5 : 2);
      scene.resize(W, H, dpr);
      layout(true);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(stage);
    const roCard = typeof ResizeObserver !== 'undefined' && cardRef.current ? new ResizeObserver(() => layout(false)) : null;
    if (roCard) roCard.observe(cardRef.current!);
    if (!ro) addEventListener('resize', resize);
    resize();
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((e) => ((visible = e[0].isIntersecting), sync()), { threshold: 0.01 }) : null;
    if (io) io.observe(stage);
    else visible = true;
    document.addEventListener('visibilitychange', sync);

    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (e.pointerType !== 'touch') {
        pt.x = (p.x / W) * 2 - 1;
        pt.y = (p.y / H) * 2 - 1;
      }
      if (down) {
        const dx = e.clientX - down.x;
        const dy = e.clientY - down.y;
        down.moved += Math.abs(dx) + Math.abs(dy);
        down.x = e.clientX;
        down.y = e.clientY;
        scene.drag(dx, dy);
        return;
      }
      if (e.pointerType === 'touch' || hoverRef.current?.pinned) return;
      const i = scene.pick(p.x, p.y);
      if (i < 0) {
        if (hoverRef.current) setHover(null);
      } else if (hoverRef.current?.i !== i) {
        setHover({ i, x: p.x, y: p.y, pinned: false });
      } else if (tipRef.current) {
        const pos = tipPos(p.x, p.y);
        tipRef.current.style.left = `${pos.left}px`;
        tipRef.current.style.top = `${pos.top}px`;
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, moved: 0 };
      canvas.setPointerCapture?.(e.pointerId);
      stage.classList.add('drag');
    };
    const onUp = (e: PointerEvent) => {
      stage.classList.remove('drag');
      if (!down) return;
      const moved = down.moved;
      down = null;
      if (moved < 6) {
        const p = local(e);
        const i = scene.pick(p.x, p.y);
        setHover(i >= 0 ? { i, x: p.x, y: p.y, pinned: true } : null);
      }
    };
    const onLeave = () => {
      pt.x = pt.y = 0;
      if (!hoverRef.current?.pinned) setHover(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setHover(null);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    addEventListener('keydown', onKey);
    setSceneKey((k) => k + 1);

    return () => {
      cancelAnimationFrame(raf);
      running = false;
      ro?.disconnect();
      roCard?.disconnect();
      io?.disconnect();
      removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', sync);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      removeEventListener('keydown', onKey);
      scene.dispose();
      sceneRef.current = null;
      syncRef.current = () => {};
      redrawRef.current = () => {};
    };
  }, [fleet, force2d]);

  // Motion switch: a still sphere when off (snaps to its state, no loop); the loop restarts when on
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.reduced = !motionOn || prefersReducedMotion();
    if (s.reduced) s.intro = 1;
    syncRef.current();
  }, [motionOn, sceneKey]);

  // what the sphere shows now
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.dark = theme === 'dark';
    s.dustColors = DUST[theme];
    s.setTargets(targetsFor(step + 1, fleet, { theme, stress, chosen: portfolios[appetite].chosen }));
    redrawRef.current();
  }, [step, theme, stress, stressVersion, appetite, fleet, portfolios, sceneKey]);
  useEffect(() => {
    layoutRef.current(false);
  }, [step, sceneKey]);

  // ---- words ----
  const droppedCount = stress ? stress.dropped.length : 0;
  const stressedInr = stress ? stress.eligibleInr : fleet.eligibleInr;
  const stressText = !stress
    ? 'Calculating with the engine…'
    : scenario === 'normal'
      ? `Nothing changes under normal demand: ${fleet.counts.safe} changes pass, ${inr(fleet.eligibleInr)} a month.`
      : droppedCount === 0
        ? `All ${fleet.counts.safe} changes still pass under “${SCENARIOS[scenario].label}”. ${inr(stressedInr)} a month stays safe.`
        : `${droppedCount} of ${fleet.counts.safe} changes stop passing under “${SCENARIOS[scenario].label}”. ${inr(stressedInr)} a month stays safe, ${inr(fleet.eligibleInr - stressedInr)} less than before.`;
  const legend: { kind: Kind | 'dropped'; label: string; n: number }[] =
    step === 2 && stress
      ? [
          { kind: 'safe', label: 'Still passes', n: fleet.counts.safe - droppedCount },
          { kind: 'dropped', label: 'Stops passing', n: droppedCount },
          { kind: 'refused', label: 'Refused already', n: fleet.counts.refused + fleet.counts.thin },
          { kind: 'none', label: 'No change', n: fleet.counts.none },
        ]
      : (['safe', 'refused', 'thin', 'none'] as Kind[]).map((k) => ({ kind: k, label: KIND_LABEL[k], n: fleet.counts[k] }));
  const shown = hover ? fleet.nodes[hover.i] : null;
  const rows = useMemo(() => [...fleet.nodes].sort((a, b) => b.saving - a.saving), [fleet]);
  const pf = portfolios[appetite];
  const cur = STEPS[step];
  const wasteShare = ((fleet.eligibleInr / fleet.originalInr) * 100).toFixed(1);

  const facts: [string, string][] =
    step === 0
      ? [[inr(fleet.originalInr), 'monthly bill'], [`${wasteShare}%`, 'safe to act on'], [`${data.analysis.alerts.length}`, 'alerts']]
      : step === 1
        ? [[`${fleet.counts.safe}`, 'pass'], [`${fleet.counts.refused}`, 'fail a check'], [`${fleet.counts.thin}`, 'thin evidence']]
        : step === 3
          ? [[inr(fleet.notClaimedInr), `not claimed, ${fleet.notClaimedResources} resources`], [`${fleet.blockedCount}`, 'plans blocked by Dependency Shield']]
          : step === 4
            ? [[`${pf.count}`, 'changes chosen'], [inr(pf.savingInr), 'a month'], [`${pf.riskUsed} / ${RISK_APPETITES[appetite]}`, 'risk points']]
            : [];
  const lede = [
    `${fleet.nodes.length} resources, one point each. Bigger points cost more a month; amber points have a saving worth a look.`,
    'ForeSight tests each change against 30 days of usage. The shape of a point carries the verdict as well as its colour.',
    'Pick a demand scenario. The engine re-tests every approvable change under it and the points move to show which survive.',
    'A saving that fails a check, or rests on thin data, stays out of the total. Anything others depend on is never switched off.',
    'Choose how much risk you will accept. The portfolio picks the best set inside that budget and every approval keeps its evidence.',
  ][step];

  return (
    <>
      <div className="lp-flow">
        <div className="lp-steps" ref={listRef} role="group" aria-label="Decision journey stages">
          <div className="lp-track" aria-hidden="true"><i /></div>
          {STEPS.map((s, i) => (
            <button key={s.name} type="button" className={`lp-step${i === step ? ' active' : ''}`} aria-current={i === step ? 'step' : undefined} onClick={() => pickStep(i)}>
              <span className="no">{s.no}</span>
              <span className="tx">
                <strong>{s.name}</strong>
                <small>{s.blurb}</small>
              </span>
              <span className="arr" aria-hidden="true"><ArrowUpRight size={18} /></span>
            </button>
          ))}
        </div>

        <div className="lp-sticky">
          <div className="lp-stage" ref={stageRef} data-step={step}>
            <div className="lp-grid" aria-hidden="true" />
            <canvas className="lp-canvas" ref={canvasRef} key={force2d ? 'c2d' : 'gl'} aria-hidden="true" />
            <div className="lp-foot" aria-hidden="true">
              <span>EVIDENCE SPHERE · {fleet.nodes.length} RESOURCES</span>
              <span>{mode === 'canvas2d' ? 'SIMPLIFIED RENDERING' : 'DRAG TO TURN · HOVER TO READ'}</span>
            </div>
            <aside className="lp-legend" aria-label="What the shapes mean">
              {legend.map((l) => (
                <span key={l.kind} className="row">
                  <i className={`lg lg-${l.kind}`} aria-hidden="true" />
                  {l.label} <b>{l.n}</b>
                </span>
              ))}
            </aside>

            {shown && hover && (
              <div className={`lp-tip${hover.pinned ? ' pinned' : ''}`} ref={tipRef} style={tipPos(hover.x, hover.y)} role="status">
                <div className="nm">{shown.name}</div>
                <div className="mt">{shown.env}, {shown.region}, team {shown.team}</div>
                <div className="kd"><i className={`lg lg-${shown.kind}`} aria-hidden="true" />{shown.rec ? VERDICT[shown.rec.verdict].label : 'No recommendation'}</div>
                {shown.saving > 0 ? (
                  <div className="sv">{ACTION[shown.rec!.action]}: <b>{inr(shown.saving)}</b> a month</div>
                ) : (
                  <div className="sv">No change proposed. Costs {inr(shown.cost)} a month.</div>
                )}
                {hover.pinned && (
                  <div className="ac">
                    <button type="button" className="lp-link" onClick={() => openResource(shown.id)}>Open in Resource Explorer</button>
                    <button type="button" className="lp-link quiet" onClick={() => setHover(null)}>Close</button>
                  </div>
                )}
              </div>
            )}

            <div className="lp-card" ref={cardRef} aria-live="polite">
              <span className="ct">{cur.no} / 05 · {cur.name.toUpperCase()}</span>
              <h3>{cur.title}</h3>
              {step !== 2 && <p>{lede}</p>}
              {step === 2 && (
                <>
                  <div className="lp-seg" role="group" aria-label="Demand scenario">
                    {SCENARIO_ORDER.map((s) => (
                      <button key={s} type="button" aria-pressed={scenario === s} onClick={() => setScenario(s)}>{SCENARIOS[s].label}</button>
                    ))}
                  </div>
                  <p className="out">{calculating ? 'Calculating with the engine…' : stressText}</p>
                </>
              )}
              {step === 4 && (
                <div className="lp-seg" role="group" aria-label="Risk appetite">
                  {APPETITES.map((a) => (
                    <button key={a} type="button" aria-pressed={appetite === a} onClick={() => setAppetite(a)}>{a[0].toUpperCase() + a.slice(1)}</button>
                  ))}
                </div>
              )}
              {facts.length > 0 && (
                <dl className="lp-facts">
                  {facts.map(([k, v]) => (
                    <div key={v}><dt>{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl>
              )}
              <div className="lp-row">
                <button type="button" className="lp-arrowlink" onClick={() => go(cur.route)}>{cur.link} <ArrowUpRight /></button>
                {step === 2 && scenario !== 'normal' && (
                  <button type="button" className="lp-arrowlink quiet" onClick={() => setScenario('normal')}>Reset</button>
                )}
              </div>
              {step === 2 && <p className="fine">Replayed on historical data. A test, not a guarantee of production safety.</p>}
            </div>
          </div>
        </div>
      </div>

      <details className="lp-table">
        <summary>Read the same fleet as a table</summary>
        <div className="wrap">
          <table>
            <thead>
              <tr><th>Resource</th><th>Environment</th><th>Proposed change</th><th className="num">Saving a month</th><th>Verdict</th></tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id}>
                  <td>{n.name}</td>
                  <td>{n.env}</td>
                  <td>{n.rec && n.saving > 0 ? ACTION[n.rec.action] : 'None'}</td>
                  <td className="num">{n.saving > 0 ? inr(n.saving) : '-'}</td>
                  <td>{n.rec ? VERDICT[n.rec.verdict].short : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

