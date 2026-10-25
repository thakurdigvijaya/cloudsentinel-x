// CloudSentinel X — app shell. A landing page plus seven workspace screens; every number comes from the engine (src/engine).
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { SCENARIOS } from './engine/scenarios';
import { Landing } from './ui/landing/Landing';
import { ChallengeLab } from './ui/screens/ChallengeLab';
import { CommandCenter } from './ui/screens/CommandCenter';
import { DataExport } from './ui/screens/DataExport';
import { DecisionCenter } from './ui/screens/DecisionCenter';
import { OptimizationCenter } from './ui/screens/OptimizationCenter';
import { PlanAhead } from './ui/screens/PlanAhead';
import { ResourceExplorer } from './ui/screens/ResourceExplorer';
import { TeamWorkspace } from './ui/screens/TeamWorkspace';
import { Cursor } from './ui/Cursor';
import { attachDepth, attachTilt, finePointer } from './ui/fx';
import { Mark } from './ui/landing/icons';
import { useMotion } from './ui/motion';
import { AppProvider, useApp, type Route } from './ui/store';

const NAV: { route: Route; label: string; hint: string }[] = [
  { route: 'command', label: 'Command Center', hint: 'Spend, waste, alerts' },
  { route: 'resources', label: 'Resource Explorer', hint: 'Every resource + history' },
  { route: 'optimize', label: 'Optimization Center', hint: 'Recommendations' },
  { route: 'lab', label: 'Challenge Lab', hint: 'Stress-test a change' },
  { route: 'plan', label: 'Plan Ahead', hint: 'What-if · events · forecast' },
  { route: 'decisions', label: 'Decision Center', hint: 'Approvals + proof' },
  { route: 'data', label: 'Data & Export', hint: 'Your CSV · reports' },
  { route: 'team', label: 'Secure Team Workspace', hint: 'Login · roles · organizations' },
];

function Shell() {
  const { state, data, dispatch } = useApp();
  const motion = useMotion();
  const isHome = state.route === 'home';
  const appRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const skyRef = useRef<HTMLDivElement>(null);
  const depthRef = useRef<HTMLDivElement>(null);

  // Depth (Motion on only): cards rise out of the page as they scroll into view and lean a little while they travel
  // (useLayoutEffect, so a card is never painted once in its final place before it is hidden for its entrance).
  useLayoutEffect(() => {
    if (isHome || !motion.on || !screenRef.current || state.route === 'resources') return;
    return attachDepth(screenRef.current, '.card:not(.inset)');
  }, [isHome, motion.on, state.route]);
  // KPI tiles tilt toward the pointer, with a glare
  useEffect(() => {
    if (isHome || !motion.on || !finePointer() || !appRef.current) return;
    return attachTilt(appRef.current, '.kpi', 6);
  }, [isHome, motion.on]);
  // the sky band and the glass shapes behind the page drift at different speeds as you scroll
  useEffect(() => {
    if (isHome || !motion.on) return;
    let queued = false;
    const write = () => {
      queued = false;
      const y = String(Math.round(scrollY));
      skyRef.current?.style.setProperty('--sy', y);
      depthRef.current?.style.setProperty('--sy', y);
    };
    const onScroll = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(write);
      }
    };
    addEventListener('scroll', onScroll, { passive: true });
    write();
    return () => removeEventListener('scroll', onScroll);
  }, [isHome, motion.on]);

  if (state.route === 'home') return <Landing />;
  const Screen = { command: CommandCenter, resources: ResourceExplorer, optimize: OptimizationCenter, lab: ChallengeLab, plan: PlanAhead, decisions: DecisionCenter, data: DataExport, team: TeamWorkspace }[state.route];
  const title = NAV.find((n) => n.route === state.route)!.label;
  return (
    <div className="app" ref={appRef}>
      <div className="grain" aria-hidden="true" />
      <Cursor hideNative={false} />
      <div className="ws-depth" ref={depthRef} aria-hidden="true">
        <i style={{ '--k': 0.22, '--rot': '-14deg' } as CSSProperties} />
        <i style={{ '--k': 0.1, '--rot': '18deg' } as CSSProperties} />
        <i style={{ '--k': 0.34, '--rot': '-6deg' } as CSSProperties} />
      </div>
      <div className="ws-sky" ref={skyRef} aria-hidden="true">
        <div className="sky-img day" />
        <div className="sky-img night" />
      </div>
      <aside className="sidebar">
        <div className="brand">
          <a
            href="#/home"
            className="brand-link"
            onClick={(e) => {
              e.preventDefault();
              dispatch({ type: 'navigate', route: 'home' });
            }}
          >
            <Mark />
            <span>
              cloudsentinel <em>x</em>
            </span>
          </a>
          <div className="muted small">Find waste. Test the change. Explain the decision.</div>
        </div>
        <nav aria-label="Workspace screens">
          {NAV.map((n, i) => (
            <a
              key={n.route}
              href={`#/${n.route}`}
              className={state.route === n.route ? 'active' : ''}
              aria-current={state.route === n.route ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                dispatch({ type: 'navigate', route: n.route });
              }}
            >
              <span className="ni" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="nt">
                {n.label}
                <span className="muted small">{n.hint}</span>
              </span>
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <div className="theme-switch" role="group" aria-label="Colour theme">
            <button type="button" aria-pressed={state.theme === 'light'} onClick={() => dispatch({ type: 'setTheme', theme: 'light' })}>
              Day
            </button>
            <button type="button" aria-pressed={state.theme === 'dark'} onClick={() => dispatch({ type: 'setTheme', theme: 'dark' })}>
              Twilight
            </button>
          </div>
          <button type="button" className="ghost small motion-switch" aria-pressed={motion.on} onClick={motion.toggle} title="Turn animation on or off">
            <i aria-hidden="true" /> Motion {motion.on ? 'on' : 'off'}
          </button>
          <a
            className="back-story"
            href="#/home"
            onClick={(e) => {
              e.preventDefault();
              dispatch({ type: 'navigate', route: 'home' });
            }}
          >
            ← The story
          </a>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="eyebrow">WORKSPACE / {title.toUpperCase()}</span>
            <h1>{title}</h1>
          </div>
          <div className="pills">
            {state.adoptedScenario && <span className="pill warn">Planning assumption: {SCENARIOS[state.adoptedScenario].label}</span>}
            {state.events.length > 0 && <span className="pill warn">Utsav Mode: {state.events.map((e) => e.name).join(', ')}</span>}
            <span className="pill">{state.route === 'team' ? 'Server-backed secure mode' : 'Offline research mode · browser-local decisions'}</span>
            <span className="pill">{data.label}</span>
          </div>
        </header>
        {state.notice && (
          <div className="notice warn" role="status">
            {state.notice}{' '}
            <button className="ghost small" onClick={() => dispatch({ type: 'dismissNotice' })}>
              Dismiss
            </button>
          </div>
        )}
        <div className="screen" key={state.route} ref={screenRef}>
          <Screen />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
