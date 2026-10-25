/** Additional Challenge Lab experience. Original Challenge Lab, home/sphere styling and planning workflow are unchanged.
 * The live preview uses the actual stored measurements and ForeSight; does not approve or mutate anything.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { projectCpu, projectMem } from '../../engine/capacity';
import { withExtraWorkload } from '../../engine/challenge';
import { limitsFor } from '../../engine/config';
import { challengeFleet } from '../../engine/fleetChallenge';
import { hourlyMax } from '../../lib/downsample';
import { LineChart, Section } from '../components';
import { inr, pct } from '../format';
import { useMotion } from '../motion';
import { useApp } from '../store';
import { buildFleet, targetsFor, type Fleet } from '../landing/model';
import { SphereScene } from '../landing/sphere';

const PRESETS = [0, 25, 60, 100];

export function LiveDecisionTheater() {
  const { state, data, dispatch } = useApp();
  const [requested, setRequested] = useState(0);
  const [applied, setApplied] = useState(0);
  const [tour, setTour] = useState(-1);
  const [point, setPoint] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fleet = useMemo(() => buildFleet(data), [data]);
  // Avoid recomputing 30 days × 90 VMs on every physical pixel of a drag.
  useEffect(() => {
    const t = setTimeout(() => setApplied(requested), 160);
    return () => clearTimeout(t);
  }, [requested]);
  const report = useMemo(() => challengeFleet({ resources: data.resources, series: data.series, recommendations: data.baseRecommendations }, applied), [data, applied]);
  const resizeCandidates = useMemo(() => data.baseRecommendations.filter((r) => r.proposed.size && r.eligible && data.series.has(r.resourceId)), [data]);
  const selected = resizeCandidates.find((r) => r.id === selectedId)
    ?? resizeCandidates.find((r) => report.lostEligibility.some((x) => x.recommendationId === r.id))
    ?? resizeCandidates[0];
  const series = selected ? data.series.get(selected.resourceId) : undefined;
  const res = selected ? data.resourceById.get(selected.resourceId) : undefined;
  const replay = useMemo(() => {
    if (!selected || !series || !res?.vcpu || !res.ramGb || !selected.proposed.size) return null;
    const oldSize = { vcpu: res.vcpu, ramGb: res.ramGb };
    const usage = withExtraWorkload(series, applied);
    return {
      cpu: projectCpu(usage.cpuPct, oldSize, selected.proposed.size),
      mem: projectMem(usage.memPct, oldSize, selected.proposed.size),
      limits: limitsFor(res.env),
      samples: usage.cpuPct.length,
      start: series.start,
      stepMinutes: series.stepMinutes,
    };
  }, [series, res, selected, applied]);
  const index = replay ? Math.max(0, Math.min(point, replay.samples - 1)) : 0;
  const instantCpu = replay?.cpu[index] ?? null;
  const instantMem = replay?.mem[index] ?? null;
  const breach = !!replay && ((instantCpu !== null && instantCpu > replay.limits.cpuMax) || (instantMem !== null && instantMem > replay.limits.memMax));
  const onSelectNode = (id: string) => {
    const rec = data.baseRecommendations.find((r) => r.resourceId === id && r.proposed.size);
    if (rec) { setSelectedId(rec.id); setPoint(0); }
    else {
      dispatch({ type: 'select', resourceId: id });
      dispatch({ type: 'navigate', route: 'resources' });
    }
  };
  const nextTour = () => {
    const next = tour + 1;
    if (next >= 4) { setTour(-1); return; }
    setTour(next);
    if (next === 0) setRequested(0);
    if (next === 1) setRequested(60);
    if (next === 2) {
      const changed = report.lostEligibility[0];
      if (changed) setSelectedId(changed.recommendationId);
      setPoint(0);
    }
  };
  const tourCaptions = [
    'DISCOVER — Start with the exact savings that pass the engine’s baseline safety checks.',
    'CHALLENGE — Workload increases by 60%. Watch real ForeSight results change the fleet and eligible savings.',
    'VERIFY — Inspect a rejected resize and scrub real sampled CPU/RAM against its target size.',
    'DECIDE — Preview only. No cloud change or historical approval is modified; open Decision Center to review actions.',
  ];
  return (
    <Section title="Challenge the Optimizer · Live Decision Theater" right={<span className="badge badge-accent">NEW · ENGINE-DRIVEN</span>}>
      <div className="theater-intro">
        <div>
          <span className="eyebrow">DON'T JUST TRUST THE OPTIMIZER — CHALLENGE IT.</span>
          <p>Stress-test proposed resizes across the loaded fleet. The resource sphere, refusals and financial totals reflect the same engine calculation.</p>
        </div>
        <button className="ghost" type="button" onClick={nextTour}>{tour < 0 ? 'Start guided judge demo' : tour === 3 ? 'Finish guided demo' : `Next · ${tour + 1}/4`}</button>
      </div>
      {tour >= 0 && <div className="notice" role="status"><b>GUIDED DEMO {tour + 1}/4</b> — {tourCaptions[tour]}</div>}
      <div className="theater-controls">
        <label className="slider" htmlFor="fleet-workload">Judge-controlled workload <strong>+{requested}%</strong>
          <input id="fleet-workload" type="range" min={0} max={100} step={5} value={requested} onChange={(e) => setRequested(Number(e.target.value))} />
        </label>
        <div className="chips" role="group" aria-label="Workload presets">
          {PRESETS.map((n) => <button key={n} type="button" className={requested === n ? 'chip active' : 'chip'} aria-pressed={requested === n} onClick={() => setRequested(n)}>+{n}%</button>)}
        </div>
        <p className="muted small">CPU demand × (1 + stress); memory demand × (1 + 0.4 × stress). Evaluates historical resize targets; original data and approvals are never changed. {applied !== requested ? 'Updating scenario…' : 'Preview current.'}</p>
      </div>
      <div className="theater-figures" aria-live="polite" aria-atomic="true">
        <div><div className="label">Baseline eligible changes</div><strong>{report.baselineEligibleCount}</strong></div>
        <div><div className="label">Still passing capacity checks</div><strong className="tone-pass">{report.remainingEligibleCount}</strong></div>
        <div><div className="label">Resize plans newly refused</div><strong className="tone-fail">{report.lostEligibility.length}</strong></div>
        <div><div className="label">Monthly saving after stress</div><strong>{inr(report.stressedEligibleInr)}</strong></div>
        <div><div className="label">Saving no longer eligible</div><strong className="tone-warn">{inr(report.lostSavingInr)}</strong></div>
      </div>
      <div className="theater-split">
        <div className="theater-orbit">
          <div className="label">REAL FLEET · {fleet.nodes.length} RESOURCES · CLICK A POINT</div>
          <LiveFleetSphere fleet={fleet} eligibleIds={report.eligibleIds} theme={state.theme} onSelect={onSelectNode}/>
          <p className="muted small">Solid = remains eligible · outlined ring = fails under stress · faded = no eligible change. GPU animation has a reduced-motion/2D fallback.</p>
        </div>
        <div className="theater-refusals">
          <div className="label">REFUSALS FROM THIS STRESS TEST</div>
          {report.lostEligibility.length === 0 ? <p className="muted">No baseline-eligible resize lost full eligibility under this stress. Try +60%.</p> : (
            <div className="theater-refusal-list">
              {report.lostEligibility.slice(0, 9).map((change) => <button key={change.id} type="button" className={selected?.id === change.recommendationId ? 'theater-item selected' : 'theater-item'} onClick={() => {setSelectedId(change.recommendationId);setPoint(0);}}>
                <span><b>{change.name}</b><small className="tone-fail">{change.reason}</small></span>
                <span className="mono">−{inr(change.deltaInr)}/mo</span>
              </button>)}
            </div>
          )}
          {report.lostEligibility.length > 9 && <p className="small muted">And {report.lostEligibility.length - 9} other refused resizes. Every figure is computed, not scripted.</p>}
          <p className="muted small">Partial resize+schedule proposals can retain independently eligible scheduling savings. “Lost saving” is the financial difference, not necessarily the whole proposal value.</p>
        </div>
      </div>
      {selected && replay && (
        <div className="theater-replay">
          <div className="theater-replay-head">
            <div><div className="eyebrow">PROOF REPLAY · HISTORICAL DATA SCRUBBER</div><h3>{selected.resourceName} · projected utilization on {selected.proposed.size!.vcpu} vCPU / {selected.proposed.size!.ramGb} GB</h3></div>
            <button className="ghost small" onClick={() => dispatch({ type: 'openLab', recId: selected.id })}>Full ForeSight evidence</button>
          </div>
          <label className="slider" htmlFor="proof-time">Scrub observed history · sample {index + 1} of {replay.samples}
            <input id="proof-time" type="range" min={0} max={Math.max(0, replay.samples - 1)} step={1} value={index} onChange={(e) => setPoint(Number(e.target.value))}/>
          </label>
          <div className="theater-proof">
            <span className="mono small">{new Date(Date.parse(replay.start) + index * replay.stepMinutes * 60000).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})} IST</span>
            <span>CPU projected <b className={instantCpu !== null && instantCpu > replay.limits.cpuMax ? 'tone-fail' : ''}>{pct(instantCpu)}</b></span>
            <span>Memory projected <b className={instantMem !== null && instantMem > replay.limits.memMax ? 'tone-fail' : ''}>{pct(instantMem)}</b></span>
            <span className={breach ? 'tone-fail' : 'tone-pass'}><b>{breach ? 'Hard-limit breach at this sample' : 'No hard-limit breach at this sample'}</b></span>
          </div>
          <LineChart ariaLabel="Projected CPU time history with scrubber marker" height={156}
            series={[{name:'Projected CPU',values:hourlyMax(replay.cpu),className:'line-cpu'}]}
            limits={[{value:replay.limits.cpuMax,label:`instant limit ${replay.limits.cpuMax}%`,className:'fail'}]}
            marker={{index:Math.floor(index * replay.stepMinutes / 60),label:'selected hour'}}/>
          <p className="muted small">A single time-sample crossing is evidence, not the complete safety verdict. ForeSight evaluates p95/p99, peaks, memory and data adequacy across the full analysis window. Scheduling/idle evidence is not revalidated by this resize-focused stress control.</p>
        </div>
      )}
    </Section>
  );
}

function LiveFleetSphere({fleet,eligibleIds,theme,onSelect}:{fleet:Fleet;eligibleIds:Set<string>;theme:'light'|'dark';onSelect:(id:string)=>void}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SphereScene|null>(null);
  const [fallback,setFallback] = useState(false);
  const motion = useMotion();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !motion.on) return;
    let disposed = false;
    const scene = new SphereScene(canvas, fleet.nodes.length, {dust:550, reduced:!motion.on, onLost:()=>{if(!disposed)setFallback(true);}});
    sceneRef.current = scene;
    let width = 0, height = 0, raf = 0, visible = true, last = performance.now();
    const resize = () => {const rect=canvas.getBoundingClientRect(); width=rect.width;height=rect.height;scene.resize(width,height,Math.min(devicePixelRatio||1,1.5));scene.place({cx:width/2,cy:height/2,r:Math.min(width,height)*0.31},true);};
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    resize();
    const io=typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??false;}) : null;
    io?.observe(canvas);
    const tick=(now:number)=>{const dt=Math.min(0.05,(now-last)/1000);last=now;if(visible)scene.frame(dt,now/1000);raf=requestAnimationFrame(tick);};
    raf=requestAnimationFrame(tick);
    return ()=>{disposed=true;cancelAnimationFrame(raf);io?.disconnect();observer?.disconnect();scene.dispose();sceneRef.current=null;};
  },[fleet,motion.on,fallback]);
  useEffect(()=>{sceneRef.current?.setTargets(targetsFor(3,fleet,{theme,stress:{eligibleIds},chosen:null}));},[fleet,eligibleIds,theme,motion.on]);
  if(!motion.on || fallback) return <div className="theater-fleet-fallback" aria-label="Fleet as a motion-free resource grid">{fleet.nodes.map(n=><button key={n.id} title={`${n.name}: ${n.kind==='safe' ? eligibleIds.has(n.id)?'eligible':'refused after stress':n.kind}`} className={n.kind==='safe'?(eligibleIds.has(n.id)?'fpass':'ffail'):'fneutral'} onClick={()=>onSelect(n.id)} aria-label={`Inspect ${n.name}`}/>)}</div>;
  return <canvas className="theater-sphere" ref={canvasRef} role="img" aria-label="Engine-driven resource sphere. Select a resource to inspect." onClick={e=>{const r=e.currentTarget.getBoundingClientRect();const idx=sceneRef.current?.pick(e.clientX-r.left,e.clientY-r.top)??-1;if(idx>=0)onSelect(fleet.nodes[idx].id);}}/>;
}
