// Landing: the page people see first. Two looks of one design, "Day" (light, a soft mountain morning) and "Twilight" (dark,
// the same valley after sunset). Each has its own way of moving: Day drifts and rises, Twilight glows and fades in.
// The only heavy part, the Evidence Sphere (src/ui/landing/Method.tsx), renders only while it is on screen.
// Every figure on the page comes from the engine. Motion is decoration: the Motion switch and prefers-reduced-motion
// turn it off, and every control still works without it.
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CountUp } from '../CountUp';
import { Cursor, onCursorMove } from '../Cursor';
import { attachTilt, finePointer } from '../fx';
import { inr } from '../format';
import { useMotion } from '../motion';
import { useApp, type Route } from '../store';
import { ArrowDown, ArrowUpRight, Mark, Moon, Spark, Sun } from './icons';
import { Method } from './Method';
import { buildFleet, type FleetNode } from './model';
import './landing.css';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** fixed star positions, so the sky is the same on every visit */
function makeStars(n: number, seed: number, maxY: number) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, () => ({ x: rnd() * 100, y: rnd() * maxY, a: 0.35 + rnd() * 0.65, d: -rnd() * 6, s: rnd() < 0.15 ? 3 : 2 }));
}
const HERO_STARS = makeStars(26, 4242, 38);
const NIGHT_STARS = makeStars(70, 9001, 72);


/** a headline split into words, so each word can come into focus on its own (see .wd in landing.css) */
function Words({ text, from = 0 }: { text: string; from?: number }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <Fragment key={i}>
          <span className="wd" style={{ '--i': from + i } as CSSProperties}>{w}</span>{' '}
        </Fragment>
      ))}
    </>
  );
}

/** What is hidden in the dark: real resources of the loaded fleet, scattered around the edges and shown only inside the torch. */
function unseenTags(nodes: FleetNode[]) {
  const pick = (kind: FleetNode['kind'], n: number) => {
    const list = nodes.filter((x) => x.kind === kind);
    const step = Math.max(1, Math.floor(list.length / n));
    return Array.from({ length: Math.min(n, list.length) }, (_, i) => list[i * step]);
  };
  const chosen = [...pick('safe', 18), ...pick('refused', 9), ...pick('thin', 5), ...pick('none', 8)];
  // a 10 x 6 grid of cells, the middle ones (where the headline sits) left empty, then a fixed shuffle
  const cells: [number, number][] = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 10; c++) if (!(c >= 3 && c <= 6 && r >= 1 && r <= 3)) cells.push([c, r]);
  const order = cells.map((_, i) => (i * 17 + 5) % cells.length);
  return chosen.map((n, i) => {
    const [c, r] = cells[order[i % cells.length]];
    const jx = ((i * 37) % 11) / 11 - 0.5;
    const jy = ((i * 53) % 9) / 9 - 0.5;
    return { n, left: ((c + 0.5 + jx * 0.5) / 10) * 100, top: ((r + 0.5 + jy * 0.5) / 6) * 100 };
  });
}

const CAPABILITIES: { t: string; d: string; r: Route; l: string }[] = [
  { t: 'Cost analysis', d: 'Spend by region, team and environment, with every saving shown beside what it replaces.', r: 'command', l: 'Command Center' },
  { t: 'Opportunity detection', d: 'Rightsizing, off-hours schedules and orphaned volumes, found from the usage series.', r: 'resources', l: 'Resource Explorer' },
  { t: 'Risk evaluation', d: 'Dependency Shield blocks steps others rely on. A risk budget caps the portfolio.', r: 'optimize', l: 'Optimization Center' },
  { t: 'Scenario testing', d: 'Replay a change under higher traffic, a CPU burst, memory pressure or missing data.', r: 'lab', l: 'Challenge Lab' },
  { t: 'Plan ahead', d: 'Utsav Mode re-checks every resize at festival or sale load before the date arrives.', r: 'plan', l: 'Plan Ahead' },
  { t: 'Decision traceability', d: 'Every approval, rejection and undo is logged and exportable as a change plan.', r: 'decisions', l: 'Decision Center' },
];

export function Landing() {
  const { state, data, dispatch } = useApp();
  const theme = state.theme;
  const { on: motionOn, toggle: toggleMotion } = useMotion();
  const fleet = useMemo(() => buildFleet(data), [data]);
  const [menu, setMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const contRef = useRef<HTMLElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const nightRef = useRef<HTMLElement>(null);
  const torchRef = useRef<HTMLDivElement>(null);
  const unseenRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLSpanElement>(null);
  const stageTopRef = useRef(0); // where the pinned night stage sits in the viewport (0 while it is pinned)
  const nightVisRef = useRef(false);
  const [armed, setArmed] = useState(false); // the night numbers start counting once the headline is in focus
  const motionRef = useRef(motionOn);
  motionRef.current = motionOn;
  const tags = useMemo(() => unseenTags(fleet.nodes), [fleet]);

  const go = (route: Route) => dispatch({ type: 'navigate', route });
  const scrollToId = (id: string) => {
    setMenu(false);
    document.getElementById(id)?.scrollIntoView({ behavior: motionRef.current ? 'smooth' : 'auto', block: 'start' });
  };
  const openResource = (id: string) => {
    dispatch({ type: 'select', resourceId: id });
    go('resources');
  };

  // ---- the torch in the night section: a clipped window that follows the pointer and a copy of the hidden layer that
  // moves the opposite way, so the data stays put while the light moves. Both are plain transforms (no repaint). ----
  const moveTorch = (vx: number, vy: number) => {
    const t = torchRef.current;
    const u = unseenRef.current;
    if (!t || !u) return;
    const R = innerWidth < 780 ? 150 : 220;
    const x = vx - R;
    const y = vy - stageTopRef.current - R;
    t.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
    u.style.transform = `translate3d(${(-x).toFixed(1)}px,${(-y).toFixed(1)}px,0)`;
  };
  useEffect(() => {
    if (!motionOn || !finePointer()) return;
    return onCursorMove((x, y) => {
      if (nightVisRef.current) moveTorch(x, y);
    });
  }, [motionOn]);

  // ---- scroll: progress bar, sticky nav, hero parallax, the signal path drawn by scrolling, the night focus pull ----
  useEffect(() => {
    const root = rootRef.current!;
    const hero = heroRef.current;
    const cont = contRef.current;
    const map = mapRef.current;
    const night = nightRef.current;
    let queued = false;
    let lastPct = -1;
    let lastLocked = false;
    let lastArmed = false;
    const update = () => {
      queued = false;
      const y = scrollY;
      const vh = innerHeight;
      const max = document.documentElement.scrollHeight - vh;
      if (meterRef.current) meterRef.current.style.transform = `scaleX(${max > 0 ? clamp(y / max, 0, 1).toFixed(4) : 0})`;
      root.classList.toggle('stuck', y > 40);
      if (hero && motionRef.current) {
        const k = clamp(y, 0, vh * 1.1);
        hero.style.setProperty('--heroScroll', `${(k * 0.16).toFixed(1)}px`);
        hero.style.setProperty('--typeY', `${(-k * 0.07).toFixed(1)}px`);
      }
      if (night) {
        // the night section is pinned for a while: p runs 0 -> 1 across that stretch and drives the whole focus pull
        const r = night.getBoundingClientRect();
        const span = Math.max(1, r.height - vh);
        const p = motionRef.current ? clamp(-r.top / span, 0, 1) : 1;
        night.style.setProperty('--np', p.toFixed(3));
        stageTopRef.current = r.top > 0 ? r.top : Math.min(0, r.bottom - vh);
        nightVisRef.current = r.bottom > 0 && r.top < vh;
        const pct = Math.round(p * 100);
        const locked = p >= 0.6;
        if (readRef.current && (pct !== lastPct || locked !== lastLocked)) {
          readRef.current.textContent = locked ? 'FOCUS LOCKED' : `FOCUSING ${String(pct).padStart(2, '0')}%`;
          lastPct = pct;
        }
        if (locked !== lastLocked) {
          night.classList.toggle('locked', locked);
          lastLocked = locked;
        }
        const arm = p >= 0.74;
        if (arm !== lastArmed) {
          lastArmed = arm;
          setArmed(arm);
        }
        // no mouse (phones, tablets): the torch drifts on its own as you scroll
        if (motionRef.current && !finePointer() && nightVisRef.current) moveTorch(innerWidth * (0.5 + 0.3 * Math.cos(p * 9)), vh * (0.5 + 0.2 * Math.sin(p * 13)) + stageTopRef.current);
      }
      if (cont && map) {
        const r = cont.getBoundingClientRect();
        const p = clamp((vh * 0.9 - r.top) / (r.height * 0.8 + vh * 0.2), 0, 1);
        map.style.setProperty('--pathOffset', `${(1200 * (1 - p)).toFixed(0)}`);
        map.style.setProperty('--bridge', p.toFixed(3));
      }
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
  }, [motionOn]);

  // ---- pointer: layered depth in the hero, tilting signal nodes, magnetic buttons (fine pointers, Motion on) ----
  useEffect(() => {
    const root = rootRef.current!;
    root.querySelectorAll<HTMLElement>('[style*="--px"], .lp-magnet').forEach((el) => {
      el.style.removeProperty('--px');
      el.style.removeProperty('--py');
      el.style.removeProperty('--magX');
      el.style.removeProperty('--magY');
    });
    root.querySelectorAll<HTMLElement>('[data-tilt]').forEach((el) => el.removeAttribute('data-tilt'));
    if (!motionOn || !matchMedia('(pointer: fine)').matches) return;
    const hero = heroRef.current;
    const cont = contRef.current;
    const track = (el: HTMLElement | null) => {
      if (!el) return () => {};
      let queued = false;
      let ev: PointerEvent | null = null;
      const apply = () => {
        queued = false;
        if (!ev) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--px', (((ev.clientX - r.left) / r.width) - 0.5).toFixed(3));
        el.style.setProperty('--py', (((ev.clientY - r.top) / r.height) - 0.5).toFixed(3));
        el.style.setProperty('--gx', `${(ev.clientX - r.left).toFixed(0)}px`);
        el.style.setProperty('--gy', `${(ev.clientY - r.top).toFixed(0)}px`);
      };
      const move = (e: PointerEvent) => {
        ev = e;
        if (!queued) {
          queued = true;
          requestAnimationFrame(apply);
        }
      };
      const leave = () => {
        ev = null;
        el.style.setProperty('--px', '0');
        el.style.setProperty('--py', '0');
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerleave', leave);
      return () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerleave', leave);
      };
    };
    const offs = [track(hero), track(cont), attachTilt(root, '.stat, .fcards article', 7)];
    const mags = Array.from(root.querySelectorAll<HTMLElement>('.lp-magnet'));
    const mm = (e: PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--magX', `${((e.clientX - r.left - r.width / 2) * 0.18).toFixed(1)}px`);
      el.style.setProperty('--magY', `${((e.clientY - r.top - r.height / 2) * 0.26).toFixed(1)}px`);
    };
    const ml = (e: PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      el.style.setProperty('--magX', '0px');
      el.style.setProperty('--magY', '0px');
    };
    mags.forEach((m) => {
      m.addEventListener('pointermove', mm);
      m.addEventListener('pointerleave', ml);
    });
    return () => {
      offs.forEach((f) => f());
      mags.forEach((m) => {
        m.removeEventListener('pointermove', mm);
        m.removeEventListener('pointerleave', ml);
      });
    };
  }, [motionOn]);

  // ---- reveal: each block appears once, the first time it scrolls into view (Day rises, Twilight fades in: see the CSS) ----
  useEffect(() => {
    const els = Array.from(rootRef.current!.querySelectorAll<HTMLElement>('.lp-rv'));
    if (typeof IntersectionObserver === 'undefined') {
      els.forEach((e) => e.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  const wasteShare = ((fleet.eligibleInr / fleet.originalInr) * 100).toFixed(1);
  const dark = theme === 'dark';

  return (
    <div className="lp" ref={rootRef} data-theme={theme}>
      <div className="grain" aria-hidden="true" />
      <Cursor hideNative />
      <a className="lp-skip" href="#lp-content" onClick={(e) => (e.preventDefault(), document.getElementById('lp-content')?.focus())}>Skip to content</a>
      <div className="lp-meter" aria-hidden="true"><div ref={meterRef} /></div>

      {/* ---- navigation ---- */}
      <header className="lp-top">
        <a className="lp-brand" href="#/home" aria-label="CloudSentinel X, back to top" onClick={(e) => (e.preventDefault(), scrollTo({ top: 0, behavior: motionOn ? 'smooth' : 'auto' }))}>
          <Mark />
          <span>cloudsentinel <em>x</em><small>evidence before action</small></span>
        </a>
        <nav className={`lp-nav${menu ? ' open' : ''}`} id="lp-nav" aria-label="Page sections">
          <a href="#vision" onClick={(e) => (e.preventDefault(), scrollToId('vision'))}>Our thinking</a>
          <a href="#method" onClick={(e) => (e.preventDefault(), scrollToId('method'))}>The method</a>
          <a href="#workspace" onClick={(e) => (e.preventDefault(), scrollToId('workspace'))}>The workspace</a>
          <button type="button" className="lp-enter-m" onClick={() => go('command')}>Enter Workspace <ArrowUpRight /></button>
          <button type="button" className="lp-pill lp-motion lp-motion-m" aria-pressed={motionOn} onClick={toggleMotion}>
            <i aria-hidden="true" /> <span>Motion {motionOn ? 'on' : 'off'}</span>
          </button>
        </nav>
        <div className="lp-right">
          <button type="button" className="lp-pill lp-motion lp-motion-d" aria-pressed={motionOn} onClick={toggleMotion} title="Turn the ambient animation on or off">
            <i aria-hidden="true" /> <span>Motion {motionOn ? 'on' : 'off'}</span>
          </button>
          <button type="button" className="lp-pill lp-theme" aria-label={dark ? 'Switch to the Day look' : 'Switch to the Twilight look'} onClick={() => dispatch({ type: 'setTheme', theme: dark ? 'light' : 'dark' })}>
            {dark ? <Moon /> : <Sun />} <span>{dark ? 'Twilight' : 'Day'}</span>
          </button>
          <button type="button" className="lp-cta lp-magnet" data-cursor="Enter" onClick={() => go('command')}>Enter Workspace <ArrowUpRight /></button>
          <button type="button" className="lp-burger" aria-controls="lp-nav" aria-expanded={menu} aria-label="Menu" onClick={() => setMenu((m) => !m)}><span /><span /></button>
        </div>
      </header>

      <main id="lp-content" tabIndex={-1}>
        {/* ---- hero ---- */}
        <section className="lp-hero" id="home" ref={heroRef} aria-labelledby="lp-h1">
          <div className="lp-scene" aria-hidden="true">
            <div className="lp-scene-in">
              <div className="lp-sky sky-img day" />
              <div className="lp-sky sky-img night" />
            </div>
          </div>
          <div className="lp-mist a" aria-hidden="true" />
          <div className="lp-mist b" aria-hidden="true" />
          <div className="lp-light" aria-hidden="true" />
          <div className="lp-pglow" aria-hidden="true" />
          <div className="lp-vig" aria-hidden="true" />
          <div className="lp-sun" aria-hidden="true" />
          <div className="lp-stars hero" aria-hidden="true">
            {HERO_STARS.map((s, i) => (
              <i key={i} style={{ left: `${s.x}%`, top: `${s.y}%`, '--a': s.a, animationDelay: `${s.d}s`, width: s.s, height: s.s } as CSSProperties} />
            ))}
          </div>
          <i className="lp-float a" aria-hidden="true" />
          <i className="lp-float b" aria-hidden="true" />

          <div className="lp-hero-in">
            <p className="lp-eyebrow"><Spark /> Evidence-based cloud decisions <i /> CloudSentinel X</p>
            <h1 id="lp-h1" className="lp-h1">
              <span className="ln"><span>See beyond</span></span>
              <span className="ln"><span>the <em>cloud.</em></span></span>
            </h1>
            <p className="lp-lede">Find waste. Test the change. Explain the decision.<br />A connected journey from hidden signals to decisions you can explain.</p>
            <div className="lp-actions">
              <button type="button" className="lp-btn lp-magnet" data-cursor="Enter" onClick={() => go('command')}>Enter Workspace <span className="circ"><ArrowUpRight /></span></button>
              <button type="button" className="lp-textlink" onClick={() => scrollToId('method')}>Explore the Method <ArrowDown /></button>
            </div>
          </div>

          <div className="lp-note left">
            <Spark size={26} />
            <div><small>Passes every safety check</small><strong><CountUp text={`${inr(fleet.eligibleInr)} a month`} /></strong></div>
          </div>
          <div className="lp-note right">
            <i className="ring" />
            <div><small>Proposed and refused</small><strong><CountUp text={`${inr(fleet.notClaimedInr)}`} /> · {fleet.notClaimedResources} resources</strong></div>
          </div>
          <div className="lp-mouse" aria-hidden="true"><span /></div>
          <div className="lp-herobar"><span>SCROLL TO UNCOVER <ArrowDown /></span><i /><span>01 / THE POSSIBILITY</span></div>
        </section>

        {/* ---- our thinking ---- */}
        <section className="lp-manifesto" id="vision" aria-labelledby="lp-vision">
          <div className="lp-kicker"><Spark /> THE NEW PERSPECTIVE <span>01 — 04</span></div>
          <div className="lp-mbody">
            <h2 id="lp-vision" className="lp-rv lp-words"><Words text="Your cloud has a story." /><br /><em><Words text="We help you read it." from={4} /></em></h2>
            <div className="aside lp-rv">
              <p>Cost dashboards tell you what happened. CloudSentinel X tests <strong>what you can safely question next</strong>, with every assumption visible and every saving checked against the usage data.</p>
              <button type="button" className="lp-arrowlink" onClick={() => scrollToId('method')}>Get to know the method <ArrowUpRight /></button>
            </div>
          </div>
          <div className="lp-features">
            <div className="lp-rv"><span>01 / Discover</span><strong>Surface the overlooked.</strong><p>{fleet.nodes.length} resources, {inr(fleet.originalInr)} a month. {wasteShare}% of it is waste that is safe to act on.</p></div>
            <div className="lp-rv"><span>02 / Challenge</span><strong>See another outcome.</strong><p>Replay every change under heavier traffic, a CPU burst, memory pressure or missing data.</p></div>
            <div className="lp-rv"><span>03 / Decide</span><strong>Move with evidence.</strong><p>{inr(fleet.notClaimedInr)} was proposed and refused because the data did not support it. It stays out of the total.</p></div>
          </div>
        </section>

        {/* ---- from landscape to signal ---- */}
        <section className="lp-cont" id="continuum" ref={contRef} aria-labelledby="lp-cont-h">
          <div className="lp-cont-glow" aria-hidden="true" />
          <div className="lp-overline"><span>02 / FROM LANDSCAPE TO SIGNAL</span><span>AN UNBROKEN PATH TO CLARITY <ArrowDown size={11} /></span></div>
          <div className="lp-cont-copy">
            <span className="micro lp-rv">A LIVING INTELLIGENCE MAP</span>
            <h2 id="lp-cont-h" className="lp-rv lp-words"><Words text="Beneath every cloud," /><br /><em><Words text="there’s a pattern." from={3} /></em></h2>
            <p className="lp-rv">One connected environment. Every resource leaves a trace in its usage data.<br />Bring the right details forward without losing sight of the whole.</p>
          </div>
          <div className="lp-map" ref={mapRef} role="img" aria-label="Illustration: three connected stages, observe, interpret, understand">
            <svg className="lines" viewBox="0 0 1100 680" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              <defs><linearGradient id="lpPath" x1="0" x2="1"><stop offset="0" stopColor="#b7e5d3" stopOpacity=".1" /><stop offset=".45" stopColor="#cdeee6" stopOpacity=".8" /><stop offset="1" stopColor="#fff2c7" stopOpacity=".25" /></linearGradient></defs>
              <path className="muted" d="M75 342 C245 44 396 158 542 330 S830 563 1033 266" />
              <path className="main" d="M75 342 C235 235 349 439 543 316 S852 125 1033 266" />
              <path className="faint" d="M75 342 C272 602 409 133 543 316 S845 603 1033 266" />
              <circle className="dot" r="6"><animateMotion dur="9s" repeatCount="indefinite" path="M75 342 C235 235 349 439 543 316 S852 125 1033 266" /></circle>
            </svg>
            <div className="node n1"><div className="shape"><svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 22h7l4-10 6 18 4-12 3 4h6" /></svg></div><small>ORIGIN / 001</small><strong>Observe</strong></div>
            <div className="node n2"><div className="shape"><svg width="44" height="44" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M20 5 35 20 20 35 5 20Z" /><path d="M20 13 27 20 20 27 13 20Z" /></svg></div><small>CONTINUITY / 002</small><strong>Interpret</strong></div>
            <div className="node n3"><div className="shape"><Spark size={42} /></div><small>EVIDENCE / 003</small><strong>Understand</strong></div>
            <div className="lp-focus"><i className="beacon" /><span>CONNECTED INTELLIGENCE<br /><b>Synthetic dataset · {fleet.nodes.length} resources</b></span><ArrowUpRight size={18} /></div>
          </div>
          <div className="lp-contbar"><span>SCROLL THROUGH THE SIGNALS</span><div className="line"><span /></div><span>THE VIEW IS ALWAYS CHANGING</span></div>
        </section>

        {/* ---- night: a pinned scroll moment. The headline comes into focus as you scroll; the pointer is a torch that
               shows what was hidden in the dark (real resources of the loaded fleet) ---- */}
        <section className="lp-night" ref={nightRef} aria-labelledby="lp-night-h" data-cursor="lens">
          <div className="lp-pin">
            <div className="lp-stars night" aria-hidden="true">
              {NIGHT_STARS.map((s, i) => (
                <i key={i} style={{ left: `${s.x}%`, top: `${s.y}%`, '--a': s.a, animationDelay: `${s.d}s`, width: s.s, height: s.s } as CSSProperties} />
              ))}
            </div>
            <div className="lp-rays" aria-hidden="true" />
            <div className="lp-orb" aria-hidden="true" />
            <div className="lp-beam" aria-hidden="true" />
            <div className="lp-ridge r1" aria-hidden="true" />
            <div className="lp-nlight" aria-hidden="true" />
            <div className="lp-ridge r2" aria-hidden="true" />
            <div className="lp-ridge r3" aria-hidden="true" />
            <div className="lp-lens" aria-hidden="true"><i /><i /><i /></div>
            <div className="lp-torch" ref={torchRef} aria-hidden="true">
              <div className="lp-unseen" ref={unseenRef}>
                {tags.map(({ n, left, top }) => (
                  <span key={n.id} className={`tg ${n.kind}`} style={{ left: `${left}%`, top: `${top}%` }}>
                    <i>+</i> {n.name}
                    <small>{n.kind === 'safe' ? `PASS · ${inr(n.saving)}` : n.kind === 'refused' ? 'REFUSED · a check failed' : n.kind === 'thin' ? 'THIN EVIDENCE' : 'NO CHANGE'}</small>
                  </span>
                ))}
              </div>
            </div>
            <div className="lp-ntop"><span>◈ &nbsp;SIGNALS BENEATH THE SURFACE</span><span>FROM SIGNAL TO INSIGHT, WITHOUT THE NOISE.</span></div>
            <div className="lp-ncopy">
              <div className="lp-vf" aria-hidden="true"><b /><b /><b /><b /><span ref={readRef}>FOCUSING 00%</span></div>
              <p className="eb">A clearer kind of intelligence</p>
              <h2 id="lp-night-h"><Words text="Clarity begins" /><br /><Words text="with" from={2} /> <em><Words text="curiosity." from={3} /></em></h2>
              <p className="sub">
                <span className="ln3" style={{ '--s': 0.5 } as CSSProperties}>Bring the unseen into focus.</span>{' '}
                <span className="ln3" style={{ '--s': 0.58 } as CSSProperties}>Every recommendation has a reason.</span>{' '}
                <span className="ln3" style={{ '--s': 0.66 } as CSSProperties}>Every assumption can be challenged.</span>
              </p>
            </div>
            <div className="lp-nmetrics">
              <div><span><CountUp text={`${fleet.nodes.length}`} armed={armed} /></span><small>Resources replayed</small></div>
              <div><span><CountUp text={`${data.days}`} armed={armed} /></span><small>Days of usage per VM</small></div>
              <div><span>0</span><small>Production changes made</small></div>
            </div>
            <div className="lp-nbottom">INSIGHT IS THE BEGINNING. EVIDENCE IS THE STANDARD. <span>KEEP EXPLORING <ArrowDown size={11} /></span></div>
          </div>
        </section>
        <div className="lp-seam" aria-hidden="true" />

        {/* ---- method + the evidence sphere ---- */}
        <section className="lp-method" id="method" aria-labelledby="lp-method-h">
          <div className="lp-kicker"><Spark /> A BETTER WAY TO DECIDE <span>02 — 04</span></div>
          <div className="lp-mhead">
            <h2 id="lp-method-h" className="lp-rv lp-words"><Words text="One continuous journey." /><br /><em><Words text="Five intelligent moves." from={3} /></em></h2>
            <p className="lp-rv">Scroll at your own pace. The object on the right is your own fleet: every point is a real resource of the loaded dataset, and it changes meaning as you move through the steps.</p>
          </div>
          <Method data={data} fleet={fleet} theme={theme} motionOn={motionOn} go={go} openResource={openResource} />
        </section>

        {/* ---- the workspace ---- */}
        <section className="lp-work" id="workspace" aria-labelledby="lp-work-h">
          <div className="lp-kicker"><Spark /> YOUR DECISION WORKSPACE <span>03 — 04</span></div>
          <div className="lp-whead">
            <div>
              <h2 id="lp-work-h" className="lp-rv lp-words"><Words text="Intelligence you" /><br /><Words text="can" from={2} /> <em><Words text="work with." from={3} /></em></h2>
              <p className="lp-rv">The workspace behind this page is not a mock-up. Seven screens run on the same engine and the same dataset as the sphere above.</p>
            </div>
            <span className="lp-status lp-rv"><i /> {data.source === 'synthetic' ? 'SYNTHETIC DATA · ENGINE-COMPUTED' : 'YOUR IMPORTED DATA · ENGINE-COMPUTED'}</span>
          </div>
          <div className="lp-frame lp-rv">
            <div className="fhead">
              <div className="fid"><span className="fmark"><Spark size={20} /></span><div><strong>CloudSentinel <em>X</em></strong><small>Command Center / this dataset</small></div></div>
              <button type="button" className="lp-pill" onClick={() => go('command')}>Open <ArrowUpRight size={12} /></button>
            </div>
            <div className="fbanner"><i /> {data.source === 'synthetic' ? 'DEMONSTRATION DATASET, NOT A LIVE CLOUD ACCOUNT' : 'DATA IMPORTED IN THIS BROWSER'} <span>NOTHING IS EXECUTED, APPROVALS ARE PLANNING RECORDS</span></div>
            <div className="fstats">
              <div className="stat"><span>MONTHLY BILL</span><strong><CountUp text={inr(fleet.originalInr)} /></strong><small>{fleet.nodes.length} resources, illustrative pricing</small></div>
              <div className="stat emph"><span>PASSES EVERY SAFETY CHECK</span><strong><CountUp text={inr(fleet.eligibleInr)} /></strong><small>{fleet.counts.safe} changes, {wasteShare}% of the bill</small></div>
              <div className="stat"><span>PROPOSED AND REFUSED</span><strong><CountUp text={inr(fleet.notClaimedInr)} /></strong><small>{fleet.notClaimedResources} resources, left out of the total</small></div>
            </div>
            <div className="fcards">
              {CAPABILITIES.map((c) => (
                <article key={c.t} className="lp-rv">
                  <h3>{c.t}</h3>
                  <p>{c.d}</p>
                  <button type="button" className="lp-arrowlink" onClick={() => go(c.r)}>{c.l} <ArrowUpRight /></button>
                </article>
              ))}
            </div>
          </div>
          <div className="lp-limits">
            <div className="lp-rv">
              <h3>How it is built</h3>
              <p>A deterministic analysis engine in TypeScript, a small HTTP API and this interface. Thresholds and prices are written down in the assumptions file, and the same engine produces every number on this page.</p>
              <h3>Where the data comes from</h3>
              <p>{data.source === 'synthetic' ? 'The loaded dataset is synthetic, generated for this demonstration. Prices are illustrative, not a cloud provider’s bill.' : 'The loaded dataset is data you imported in this browser. Prices are still the illustrative ones in the assumptions file.'}</p>
              <button type="button" className="lp-arrowlink" onClick={() => go('data')}>Open Data and assumptions <ArrowUpRight /></button>
            </div>
            <div className="lp-rv">
              <h3>What it does not claim</h3>
              <ul>
                <li>A passed test is a replay on historical data. It does not prove a production change is safe.</li>
                <li>Nothing is executed. Approvals are planning records.</li>
                <li>There is no live cloud connection in this build.</li>
                <li>Savings are estimates from illustrative pricing.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* ---- closing ---- */}
        <section className="lp-closing" aria-labelledby="lp-close-h">
          <div className="lp-cbg" aria-hidden="true"><div className="sky-img day" /><div className="sky-img night" /></div>
          <div className="lp-cmask" aria-hidden="true" />
          <div className="lp-cin">
            <span className="eb lp-rv">BEYOND THE NOISE, THERE IS CLARITY.</span>
            <h2 id="lp-close-h" className="lp-rv lp-words"><Words text="The future looks" /><br /><em><Words text="clearer from here." from={3} /></em></h2>
            <p className="lp-rv">{inr(fleet.eligibleInr)} a month, each change with its evidence. Start with the signal. Stay for the reasoning.</p>
            <div className="lp-rv"><button type="button" className="lp-btn lp-magnet" data-cursor="Enter" onClick={() => go('command')}>Enter Workspace <span className="circ"><ArrowUpRight /></span></button></div>
          </div>
          <div className="lp-cbottom">CLOUDSENTINEL X <span>YOUR NEXT DECISION BEGINS WITH EVIDENCE.</span></div>
        </section>
      </main>

      <footer className="lp-footer">
        <a className="fb" href="#/home" onClick={(e) => (e.preventDefault(), scrollTo({ top: 0, behavior: motionOn ? 'smooth' : 'auto' }))}><Spark size={18} /> CloudSentinel <em>X</em></a>
        <span>Built for TransfiNITTe 2026 (UTHO SmartCloud Optimizer track). Synthetic data, illustrative pricing.</span>
        <a href="#/home" onClick={(e) => (e.preventDefault(), scrollTo({ top: 0, behavior: motionOn ? 'smooth' : 'auto' }))}>Back to top <ArrowUpRight size={11} /></a>
      </footer>
    </div>
  );
}
