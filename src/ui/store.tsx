// App state: dataset, approvals, decision history, filters, navigation, planned events.
// Approve / reject / adopt go through ENGINE functions — the UI never computes money itself.
import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { adoptPlanningAssumptions, approve, approveCoordinated, recheckApprovedDependencies, recheckApprovedEvidence, recheckHeldApprovals, reject, type Decisions } from '../engine/decisions';
import { previewRecommendation, revalidate, SCENARIOS } from '../engine/scenarios';
import type { Env, Recommendation, Region, ResourceType, ScenarioId, StepAction } from '../engine/types';
import { applyUtsav, utsavCheck, type PlannedEvent, type UtsavReport } from '../engine/utsav';
import { loadData, type AppData } from './data';
import { isImportedDataActive, restoreImportedData } from './importStorage';

export type Route = 'home' | 'command' | 'resources' | 'optimize' | 'lab' | 'plan' | 'decisions' | 'data' | 'team';
export const ROUTES: Route[] = ['home', 'command', 'resources', 'optimize', 'lab', 'plan', 'decisions', 'data', 'team'];

export type Theme = 'light' | 'dark';
const THEME_KEY = 'cloudsentinel-x/theme';
// The choice is written to sessionStorage too: localStorage on file:// pages can lag a moment behind a quick reload,
// and the tab's own latest choice should win.
function loadTheme(): Theme {
  for (const store of ['sessionStorage', 'localStorage'] as const) {
    try {
      const v = window[store].getItem(THEME_KEY);
      if (v === 'dark' || v === 'light') return v;
    } catch {
      /* storage unavailable: try the next one */
    }
  }
  return 'light';
}

// Apply the remembered theme before the first paint, so Twilight users never see a flash of Day.
if (typeof document !== 'undefined') document.documentElement.dataset.theme = loadTheme();

export interface Filters {
  region: Region | 'all';
  env: Env | 'all';
  team: string | 'all';
  type: ResourceType | 'all';
  search: string;
}

export interface LogEntry {
  at: string;
  recId: string;
  resourceName: string;
  event: string;
}

interface State {
  data: AppData;
  route: Route;
  selectedResourceId: string | null;
  labRecId: string | null;
  /** base (or re-validated) recommendations; Utsav holds are applied on top when read through useApp() */
  recommendations: Recommendation[];
  adoptedScenario: ScenarioId | null;
  decisions: Decisions;
  log: LogEntry[];
  filters: Filters;
  notice: string | null;
  events: PlannedEvent[];
  eventsAsOf: string;
  theme: Theme;
}

type Msg =
  | { type: 'navigate'; route: Route }
  | { type: 'select'; resourceId: string | null }
  | { type: 'openLab'; recId: string }
  | { type: 'filter'; patch: Partial<Filters> }
  | { type: 'approve'; rec: Recommendation; steps?: StepAction[] }
  | { type: 'approveMany'; items: { rec: Recommendation; steps: StepAction[] }[]; label: string }
  | { type: 'reject'; rec: Recommendation; note?: string }
  | { type: 'undo'; rec: Recommendation }
  | { type: 'adopt'; scenario: ScenarioId; data?: AppData }
  | { type: 'resetAdoption'; data?: AppData }
  | { type: 'setEvents'; events: PlannedEvent[]; asOf: string }
  | { type: 'replaceData'; data: AppData }
  | { type: 'restoreImported'; data: AppData }
  | { type: 'setTheme'; theme: Theme }
  | { type: 'dismissNotice' };

const storageKey = (datasetId: string) => `cloudsentinel-x/decisions/v2/${datasetId}`;
const now = () => new Date().toISOString();
export const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

function loadSaved(datasetId: string): Pick<State, 'decisions' | 'log' | 'events' | 'eventsAsOf' | 'adoptedScenario'> {
  const defaults = { decisions: {}, log: [], events: [] as PlannedEvent[], eventsAsOf: todayIst(), adoptedScenario: null };
  try {
    const raw = localStorage.getItem(storageKey(datasetId));
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        decisions: parsed.decisions && typeof parsed.decisions === 'object' ? parsed.decisions : {},
        log: Array.isArray(parsed.log) ? parsed.log : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        eventsAsOf: typeof parsed.eventsAsOf === 'string' ? parsed.eventsAsOf : todayIst(),
        adoptedScenario: typeof parsed.adoptedScenario === 'string' && parsed.adoptedScenario in SCENARIOS && parsed.adoptedScenario !== 'normal'
          ? parsed.adoptedScenario as ScenarioId : null,
      };
    }
  } catch { /* storage unavailable — start empty */ }
  return defaults;
}

/** Restore the exact planning assumptions with a dataset, then revalidate all past approvals.
 * A new/changed dataset never inherits approvals from a different content hash. */
function restorePlanning(data: AppData) {
  const saved = loadSaved(data.id);
  let recommendations = data.baseRecommendations;
  if (saved.adoptedScenario) {
    recommendations = data.baseRecommendations.map((rec) => {
      const resource = data.resourceById.get(rec.resourceId);
      const metrics = data.series.get(rec.resourceId);
      return resource?.type === 'vm' && metrics
        ? revalidate(rec, previewRecommendation(resource, metrics, rec, saved.adoptedScenario!))
        : rec;
    });
  }
  let events = saved.events;
  let effective = recommendations;
  if (events.length) {
    const report = utsavCheck(data.resources, data.series, recommendations, events, saved.eventsAsOf);
    if (report.errors.length) events = [];
    else effective = applyUtsav(recommendations, report);
  }
  const valid = recheckApprovedDependencies(saved.decisions, { resources: data.resources, recommendations: effective }, now());
  return {
    ...saved, events, recommendations, // hold decoration is applied once in useMemo, never stored as baseline
    decisions: recheckHeldApprovals(recheckApprovedEvidence(valid, effective, now()), effective, now()),
  };
}

function reducer(state: State, msg: Msg): State {
  switch (msg.type) {
    case 'navigate':
      return { ...state, route: msg.route };
    case 'select':
      return { ...state, selectedResourceId: msg.resourceId };
    case 'openLab':
      return { ...state, labRecId: msg.recId, route: 'lab' };
    case 'filter':
      return { ...state, filters: { ...state.filters, ...msg.patch } };
    case 'approve': {
      const r = approve(state.decisions, msg.rec, now(), msg.steps, { resources: state.data.resources, recommendations: state.recommendations });
      if (!r.ok) return { ...state, notice: r.error ?? 'Could not approve.' };
      const steps = r.decisions[msg.rec.id].acceptedSteps?.join(' + ');
      return {
        ...state,
        decisions: r.decisions,
        notice: null,
        log: [{ at: now(), recId: msg.rec.id, resourceName: msg.rec.resourceName, event: `Approved (${steps})` }, ...state.log],
      };
    }
    case 'approveMany': {
      const result = approveCoordinated(state.decisions, msg.items, now(), { resources: state.data.resources, recommendations: state.recommendations });
      if (!result.ok) return { ...state, notice: result.error ?? 'Unsafe portfolio; no changes approved.' };
      const log = msg.items.map(({ rec, steps }): LogEntry => ({ at: now(), recId: rec.id, resourceName: rec.resourceName, event: `Approved via ${msg.label} (${steps.join(' + ')})` }));
      return { ...state, decisions: result.decisions, log: [...log, ...state.log], notice: `${log.length} coordinated change(s) approved via ${msg.label}.` };
    }
    case 'reject': {
      const r = reject(state.decisions, msg.rec, now(), msg.note);
      return {
        ...state,
        decisions: recheckApprovedDependencies(r.decisions, { resources: state.data.resources, recommendations: state.recommendations }, now()),
        log: [{ at: now(), recId: msg.rec.id, resourceName: msg.rec.resourceName, event: 'Rejected' }, ...state.log],
      };
    }
    case 'undo': {
      const next = { ...state.decisions };
      delete next[msg.rec.id];
      return {
        ...state,
        decisions: recheckApprovedDependencies(next, { resources: state.data.resources, recommendations: state.recommendations }, now()),
        log: [{ at: now(), recId: msg.rec.id, resourceName: msg.rec.resourceName, event: 'Decision undone (back to pending)' }, ...state.log],
      };
    }
    case 'adopt': {
      // Explicit adoption of new planning assumptions: re-validate every VM recommendation with the engine.
      const { resourceById, series, baseRecommendations } = state.data;
      const revalidated = baseRecommendations
        .filter((rec) => rec.resourceType === 'vm' && series.has(rec.resourceId))
        .map((rec) => revalidate(rec, previewRecommendation(resourceById.get(rec.resourceId)!, series.get(rec.resourceId)!, rec, msg.scenario)));
      const out = adoptPlanningAssumptions(baseRecommendations, state.decisions, revalidated, now());
      return {
        ...state,
        recommendations: out.recommendations,
        decisions: recheckApprovedDependencies(out.decisions, { resources: state.data.resources, recommendations: out.recommendations }, now()),
        adoptedScenario: msg.scenario,
        notice: out.flagged.length
          ? `${out.flagged.length} approved change(s) no longer pass under "${SCENARIOS[msg.scenario].label}" and need review.`
          : `Planning assumption "${SCENARIOS[msg.scenario].label}" adopted. No approvals were affected.`,
        log: [
          { at: now(), recId: '—', resourceName: 'All resources', event: `Adopted planning assumption: ${SCENARIOS[msg.scenario].label}` },
          ...out.flagged.map((id) => ({ at: now(), recId: id, resourceName: state.recommendations.find((r) => r.id === id)?.resourceName ?? id, event: 'Flagged: needs review' })),
          ...state.log,
        ],
      };
    }
    case 'resetAdoption':
      return {
        ...state,
        recommendations: state.data.baseRecommendations,
        adoptedScenario: null,
        notice: 'Back to normal historical conditions. Items flagged "needs review" stay flagged until you decide again.',
        log: [{ at: now(), recId: '—', resourceName: 'All resources', event: 'Returned to normal planning assumptions' }, ...state.log],
      };
    case 'setEvents': {
      const report = msg.events.length ? utsavCheck(state.data.resources, state.data.series, state.recommendations, msg.events, msg.asOf) : null;
      if (report && report.errors.length) return { ...state, notice: `Invalid Utsav event: ${report.errors[0]}` };
      const withHolds = report ? applyUtsav(state.recommendations, report) : state.recommendations;
      const checked = recheckHeldApprovals(state.decisions, withHolds, now());
      return {
        ...state,
        decisions: checked,
        notice: checked === state.decisions ? null : 'Some previously approved resizes are now held by Utsav and require review.',
        events: msg.events,
        eventsAsOf: msg.asOf,
        log: [
          {
            at: now(), recId: '—', resourceName: 'All resources',
            event: msg.events.length ? `Utsav Mode: planning for ${msg.events.map((e) => `${e.name} (×${e.loadMultiplier})`).join(', ')}` : 'Utsav Mode: events cleared',
          },
          ...state.log,
        ],
      };
    }
    case 'restoreImported':
    case 'replaceData': {
      if (msg.type === 'restoreImported' && state.data.source !== 'synthetic') return state;
      const restored = restorePlanning(msg.data);
      return {
        ...state,
        data: msg.data,
        ...restored,
        selectedResourceId: null,
        labRecId: null,
        filters: { region: 'all', env: 'all', team: 'all', type: 'all', search: '' },
        log: [{ at: now(), recId: '—', resourceName: 'Dataset', event: `Loaded ${msg.data.source === 'synthetic' ? 'the synthetic dataset' : 'imported data'} (${msg.data.resources.length} resources)` }, ...restored.log],
        notice: msg.data.source === 'imported' ? `${msg.type === 'restoreImported' ? 'Restored previous import' : 'Your data is loaded'}: ${msg.data.resources.length} resources. Every screen now shows it.` : 'Back to the synthetic dataset.',
      };
    }
    case 'setTheme':
      return { ...state, theme: msg.theme };
    case 'dismissNotice':
      return { ...state, notice: null };
  }
}

interface Ctx {
  state: State;
  data: AppData;
  /** the Utsav Mode report for the current events (null when none are planned) */
  utsav: UtsavReport | null;
  dispatch: (m: Msg) => void;
}

const AppContext = createContext<Ctx | null>(null);

const routeFromHash = (): Route => {
  let h = '';
  try {
    h = (typeof location !== 'undefined' ? location.hash : '').replace('#/', '');
  } catch {
    /* location unavailable — start on the Command Center */
  }
  return ROUTES.includes(h as Route) ? (h as Route) : 'home';
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, (): State => {
    const data = loadData();
    const restored = restorePlanning(data);
    return {
      data,
      route: routeFromHash(),
      selectedResourceId: null,
      labRecId: null,
      filters: { region: 'all', env: 'all', team: 'all', type: 'all', search: '' },
      notice: null,
      theme: loadTheme(),
      ...restored,
    };
  });

  // Recover the last validated CSV import from IndexedDB; decisions remain namespaced by content hash.
  // This does not contact the optional Node API and does not promise cross-device synchronization.
  useEffect(() => {
    let active = true;
    void restoreImportedData().then((previous) => {
      if (active && previous && isImportedDataActive(previous.id)) dispatch({ type: 'restoreImported', data: previous });
    });
    return () => { active = false; };
  }, []);

  // Decisions persist per dataset in this browser; imports use IndexedDB instead of localStorage.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(state.data.id), JSON.stringify({
        decisions: state.decisions, log: state.log, events: state.events,
        eventsAsOf: state.eventsAsOf, adoptedScenario: state.adoptedScenario,
      }));
    } catch {
      /* ignore */
    }
  }, [state.decisions, state.log, state.events, state.eventsAsOf, state.adoptedScenario, state.data.id]);

  useEffect(() => {
    // Keeping the URL in sync is a convenience only: preview panes and sandboxed frames refuse replaceState (SecurityError).
    try {
      window.scrollTo(0, 0);
    } catch {
      /* no scrolling here */
    }
    try {
      if (location.hash !== `#/${state.route}`) history.replaceState(null, '', `#/${state.route}`);
    } catch {
      /* the app works without a URL hash */
    }
  }, [state.route]);

  // Theme: one attribute on <html> drives both the landing page and the workspace; the choice is remembered in this browser.
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    for (const store of ['sessionStorage', 'localStorage'] as const) {
      try {
        window[store].setItem(THEME_KEY, state.theme);
      } catch {
        /* ignore */
      }
    }
  }, [state.theme]);

  useEffect(() => {
    const onHash = () => dispatch({ type: 'navigate', route: routeFromHash() });
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Utsav Mode: holds are derived from the planned events on every change — never stored as truth.
  const utsav = useMemo(
    () => (state.events.length ? utsavCheck(state.data.resources, state.data.series, state.recommendations, state.events, state.eventsAsOf) : null),
    [state.events, state.eventsAsOf, state.recommendations, state.data],
  );
  const recommendations = useMemo(() => (utsav && utsav.errors.length === 0 ? applyUtsav(state.recommendations, utsav) : state.recommendations), [utsav, state.recommendations]);
  const value = useMemo(() => ({ state: { ...state, recommendations }, data: state.data, utsav, dispatch }), [state, recommendations, utsav]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): Ctx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
