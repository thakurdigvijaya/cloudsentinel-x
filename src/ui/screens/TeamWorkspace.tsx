/** Authenticated team workflow: server-owned data, decisions, roles and audit. 
 * Deliberately independent of offline Lab/localStorage approvals; never falsely synchronizes the two modes.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Section } from '../components';

type Role = 'admin' | 'engineer' | 'finance' | 'leadership';
type Profile = {user:{id:string;name:string;email:string;role:Role;active:boolean};organization:{id:string;name:string};csrfToken:string};
type Member = {id:string;name:string;email:string;role:Role;active:boolean};
type Rec = {id:string;resourceId:string;resourceName:string;action:string;eligible:boolean;monthlySavingInr:number;reasons:string[];steps:{action:string;marginalSavingInr:number}[];decision?:{status:string}};
type TenantResource = {id:string;name:string;type:string;region:string;env:string;team:string;vcpu?:number;ramGb?:number};
type Audit = {at:string;actor:string;action:string;detail:string};
type DecisionHistory = {at:string;recommendationId:string;action:string;actorEmail?:string;note?:string};
type Summary = {dataset:{resources:number;vms:number;source:string};totals:{originalInr:number;candidateInr:number;eligibleInr:number;approvedInr:number;projectedInr:number}};
// Same-origin requests: Vite proxies /api locally; production must reverse-proxy /api.
// Avoid absolute localhost URLs, which break on mobile/LAN/hosted clients and cross-site cookies.
const API = '';
const money = (v:number) => `₹${Math.round(v).toLocaleString('en-IN')}`;

export function TeamWorkspace(){
  const [profile,setProfile]=useState<Profile|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [mode,setMode]=useState<'login'|'register'|'invite'>('login');
  const [email,setEmail]=useState('');const [name,setName]=useState('');const [organization,setOrganization]=useState('');const [password,setPassword]=useState('');
  const [inviteToken,setInviteToken]=useState(()=>new URLSearchParams(location.search).get('invite')??'');
  const [summary,setSummary]=useState<Summary|null>(null);
  const [recs,setRecs]=useState<Rec[]>([]);const [resources,setResources]=useState<TenantResource[]>([]);
  const [resourceSearch,setResourceSearch]=useState('');const [resourcePage,setResourcePage]=useState(0);
  const [resourceDetail,setResourceDetail]=useState<Record<string,any>|null>(null);
  const [members,setMembers]=useState<Member[]>([]);const [audits,setAudits]=useState<Audit[]>([]);const [decisionHistory,setDecisionHistory]=useState<DecisionHistory[]>([]);
  const [inviteEmail,setInviteEmail]=useState('');const [inviteRole,setInviteRole]=useState<'engineer'|'finance'|'leadership'>('engineer');
  const [issuedInvite,setIssuedInvite]=useState('');const [busy,setBusy]=useState(false);
  const [currentPassword,setCurrentPassword]=useState('');const [newPassword,setNewPassword]=useState('');
  const [inventory,setInventory]=useState<File|null>(null);const [metrics,setMetrics]=useState<File|null>(null);
  const [view,setView]=useState<'recommendations'|'resources'|'people'|'audit'|'account'>('recommendations');
  const canDecide=profile?.user.role==='admin'||profile?.user.role==='engineer';
  const isAdmin=profile?.user.role==='admin';
  const canInspect=profile?.user.role!=='leadership';

  const request=useCallback(async(path:string, method='GET', body?:unknown, csrf?:string)=>{
    const res=await fetch(API+path,{method,credentials:'include',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(method==='GET'?{}:{'X-CSRF-Token':csrf??profile?.csrfToken??''})},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await res.json() as Record<string,any>;
    if(!res.ok) throw new Error(String(result.error??`HTTP ${res.status}`));
    return result;
  },[profile?.csrfToken]);
  const refresh=useCallback(async(role?:Role)=>{
    const [s,r,all]=await Promise.all([request('/api/summary'),role==='leadership'?Promise.resolve({items:[]}):request('/api/recommendations'),role==='leadership'?Promise.resolve({items:[]}):request('/api/resources')]);
    setSummary(s as unknown as Summary);setRecs((r.items??[]) as Rec[]);setResources((all.items??[]) as TenantResource[]);
    if(role==='admin') {const m=await request('/api/team/members');setMembers(m.items as Member[]);}
    if(role==='admin'||role==='engineer') {const [a,h]=await Promise.all([request('/api/team/audit'),request('/api/decisions')]);setAudits(a.items as Audit[]);setDecisionHistory((h.history??[]) as DecisionHistory[]);}
  },[request]);
  useEffect(()=>{
    let active=true;
    void fetch(API+'/api/auth/me',{credentials:'include'}).then(async res=>{
      if(!res.ok) return null;
      return await res.json() as Profile;
    }).then(async p=>{
      if(!active)return;
      if(p){setProfile(p);}
      else if(inviteToken)setMode('invite');
    }).catch(()=>{if(active)setError('Secure API unavailable. Start it with npm run server and check the /api proxy.');}).finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
    // Only on mount: rotating CSRF on each /me request requires a single initial call.
  },[]);
  useEffect(()=>{if(!profile)return;let alive=true;void refresh(profile.user.role).catch(e=>{if(alive)setError(String(e))});return()=>{alive=false};},[profile?.user.id,profile?.user.role,refresh]);
  const authenticate=async(e:FormEvent)=>{
    e.preventDefault();setError('');setNotice('');setBusy(true);
    try{
      const path=mode==='login'?'/api/auth/login':mode==='register'?'/api/auth/register-org':'/api/auth/accept-invite';
      const body=mode==='login'?{email,password}:mode==='register'?{email,name,organization,password}:{token:inviteToken,name,password};
      const p=await request(path,'POST',body) as unknown as Profile;
      setProfile(p);setPassword('');setNotice(`Signed in as ${p.user.role}. Team decisions are now server-backed.`);
    }catch(e){setError((e as Error).message)}finally{setBusy(false)}
  };
  const logout=async()=>{
    try{await request('/api/auth/logout','POST',{});}catch(e){setError('Could not revoke session: '+(e as Error).message);return;}
    setProfile(null);setSummary(null);setRecs([]);setResources([]);setResourceDetail(null);setMembers([]);setAudits([]);setDecisionHistory([]);setNotice('Signed out.');
  };
  const act=async(id:string,action:'approve'|'reject')=>{
    setError('');setNotice('');setBusy(true);
    try{await request('/api/decisions','POST',{recommendationId:id,action});await refresh(profile?.user.role);setNotice(`${action==='approve'?'Approved':'Rejected'} — decision saved on your organization server.`)}
    catch(e){setError((e as Error).message)}finally{setBusy(false)}
  };
  const issueInvite=async(e:FormEvent)=>{
    e.preventDefault();setBusy(true);setError('');
    try{const x=await request('/api/team/invites','POST',{email:inviteEmail,role:inviteRole});setIssuedInvite(String(x.token));setNotice('One-time invitation created. Share token privately; no email was sent.');}
    catch(e){setError((e as Error).message)}finally{setBusy(false)}
  };
  const updateMember=async(m:Member,change:Record<string,unknown>)=>{
    setBusy(true);setError('');
    try{await request(`/api/team/members/${encodeURIComponent(m.id)}`,'PATCH',change);await refresh(profile?.user.role);setNotice('Team permission updated on the server.');}
    catch(e){setError((e as Error).message)}finally{setBusy(false)}
  };
  const openResource=async(id:string)=>{setError('');try{setResourceDetail(await request('/api/resources/'+encodeURIComponent(id)));}catch(e){setError((e as Error).message)}};
  const visibleResources=resources.filter(r=>[r.id,r.name,r.env,r.region,r.team].some(v=>String(v??'').toLowerCase().includes(resourceSearch.toLowerCase())));
  const resourcePages=Math.max(1,Math.ceil(visibleResources.length/18));
  const changePassword=async(e:FormEvent)=>{e.preventDefault();setBusy(true);setError('');try{await request('/api/auth/change-password','POST',{currentPassword,newPassword});setCurrentPassword('');setNewPassword('');setNotice('Password changed. Other active sessions revoked.');}catch(err){setError((err as Error).message)}finally{setBusy(false)}};
  const importTenant=async()=>{
    if(!inventory||!metrics)return;setBusy(true);setError('');
    try{
      const x=await request('/api/import','POST',{inventoryCsv:await inventory.text(),metricsCsv:await metrics.text()});
      await refresh(profile?.user.role);setNotice(`Imported ${x.dataset.resources} resources for ${profile?.organization.name}. Other organizations are unchanged.`);
    }catch(e){setError((e as Error).message)}finally{setBusy(false)}
  };
  return <div className="stack team-workspace">
    <Section title="Secure Team Workspace" right={<span className="badge badge-accent">Organization-isolated · Server-backed</span>}>
      <p className="muted small">This is the authenticated workflow. Your original seven screens remain an offline, browser-local analytical demonstration; their decisions do not silently sync to the team server.</p>
      {loading&&<p>Checking your team session…</p>}
      {error&&<div className="notice warn" role="alert">{error}</div>}
      {notice&&<div className="notice" role="status">{notice}</div>}
      {!loading&&!profile&&<div className="stack">
        <div className="tabs" role="group" aria-label="Account action">
          <button className={mode==='login'?'tab active':'tab'} onClick={()=>setMode('login')}>Sign in</button>
          <button className={mode==='register'?'tab active':'tab'} onClick={()=>setMode('register')}>Create organization</button>
          <button className={mode==='invite'?'tab active':'tab'} onClick={()=>setMode('invite')}>Join with invitation</button>
        </div>
        <form className="team-form" onSubmit={e=>void authenticate(e)}>
          {mode!=='invite'&&<label>Email<input type="email" required maxLength={254} autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>}
          {mode!=='login'&&<label>Your name<input required minLength={2} maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>}
          {mode==='register'&&<label>Organization name<input required minLength={2} maxLength={100} value={organization} onChange={e=>setOrganization(e.target.value)}/></label>}
          {mode==='invite'&&<label>One-time invitation token<input required value={inviteToken} onChange={e=>setInviteToken(e.target.value)}/></label>}
          <label>Password (minimum 12 characters)<input required minLength={12} maxLength={128} type="password" autoComplete={mode==='login'?'current-password':'new-password'} value={password} onChange={e=>setPassword(e.target.value)}/></label>
          <button disabled={busy} type="submit">{busy?'Working…':mode==='login'?'Sign in':mode==='register'?'Create organization and admin account':'Join organization securely'}</button>
        </form>
      </div>}
      {profile&&<div className="team-session"><div><strong>{profile.organization.name}</strong><div className="muted small">{profile.user.name} · {profile.user.email} · {profile.user.role.toUpperCase()}</div></div><button className="ghost" onClick={()=>void logout()}>Sign out</button></div>}
    </Section>
    {profile&&<>
      {summary&&<div className="team-kpis">
        <div className="card"><div className="label">Organization resources</div><strong>{summary.dataset.resources}</strong><div className="muted small">{summary.dataset.source} dataset · {summary.dataset.vms} VMs</div></div>
        <div className="card"><div className="label">Illustrative current bill</div><strong>{money(summary.totals.originalInr)}</strong></div>
        <div className="card"><div className="label">Eligible monthly savings</div><strong>{money(summary.totals.eligibleInr)}</strong></div>
        <div className="card"><div className="label">After approved plans</div><strong>{money(summary.totals.projectedInr)}</strong><div className="muted small">Approved: {money(summary.totals.approvedInr)}</div></div>
      </div>}
      <div className="tabs" role="tablist" aria-label="Team workspace tabs">
        <button className={view==='recommendations'?'tab active':'tab'} onClick={()=>setView('recommendations')}>Shared decisions</button>
        {canInspect&&<button className={view==='resources'?'tab active':'tab'} onClick={()=>setView('resources')}>Tenant resources</button>}
        {isAdmin&&<button className={view==='people'?'tab active':'tab'} onClick={()=>setView('people')}>Users & roles</button>}
        {(isAdmin||profile.user.role==='engineer')&&<button className={view==='audit'?'tab active':'tab'} onClick={()=>setView('audit')}>Audit trail</button>}
        <button className={view==='account'?'tab active':'tab'} onClick={()=>setView('account')}>My account</button>
        <button className="ghost small" onClick={()=>void refresh(profile.user.role).catch(e=>setError((e as Error).message))}>Refresh server</button>
      </div>
      {view==='recommendations'&&<Section title="Organization-specific optimization decisions">
        <p className="muted small">Recommendations, approvals, cost estimates and decision history are read from this organization's authenticated backend. A finance account has read-only access; leadership sees executive totals only.</p>
        {!canInspect?<p>Leadership summary-only access. Detailed resources and approval controls are restricted.</p>:<div className="team-recs">
          {recs.filter(r=>r.action!=='none').slice(0,60).map(r=><div className="team-rec" key={r.id}>
            <div><b>{r.resourceName}</b> <span className="muted small">{r.resourceId} · {r.action}</span><div className="muted small">{r.reasons.slice(0,2).join(' · ')}</div></div>
            <div><strong>{money(r.monthlySavingInr)}/mo</strong><div className="small">{r.eligible?'Eligible under defined checks':'Not currently eligible'} · {r.decision?.status??'pending'}</div></div>
            {canDecide&&<div className="team-actions"><button disabled={busy||!r.eligible} onClick={()=>void act(r.id,'approve')}>Approve</button><button className="ghost" disabled={busy} onClick={()=>void act(r.id,'reject')}>Reject</button></div>}
          </div>)}
          <p className="muted small">First 60 actionable candidates shown; full organization dataset remains accessible through authenticated API. No live infrastructure changes are executed.</p>
        </div>}
      </Section>}
      {view==='resources'&&canInspect&&<Section title="Private tenant resource inventory">
        <p className="muted small">These resources come from your authenticated organization's Node backend, not the browser-local demo dataset.</p>
        <input aria-label="Search organization resources" placeholder="Search resource ID, name, region, team…" value={resourceSearch} onChange={e=>{setResourceSearch(e.target.value);setResourcePage(0);}}/>
        <p className="muted small">{visibleResources.length} resources · page {Math.min(resourcePage+1,resourcePages)} of {resourcePages}</p>
        <div className="team-recs">{visibleResources.slice(resourcePage*18,(resourcePage+1)*18).map(r=><div className="team-rec" key={r.id}>
          <div><b>{r.name}</b><div className="mono small muted">{r.id} · {r.type}</div></div>
          <div className="small">{r.region} · {r.env} · {r.team}</div>
          <button className="ghost small" onClick={()=>void openResource(r.id)}>Inspect server metrics</button>
        </div>)}</div>
        <div className="actions"><button className="ghost small" disabled={resourcePage===0} onClick={()=>setResourcePage(n=>n-1)}>Previous</button>
          <button className="ghost small" disabled={resourcePage+1>=resourcePages} onClick={()=>setResourcePage(n=>n+1)}>Next</button></div>
        {resourceDetail&&<div className="card inset"><h3>{String(resourceDetail.resource?.name??'Resource detail')}</h3>
          <p className="muted small">ID: {String(resourceDetail.resource?.id??'')} · {String(resourceDetail.series?.aggregation??'No metrics')} · {String(resourceDetail.series?.stepMinutes??'—')} minute buckets</p>
          <p className="small">CPU readings: {Array.isArray(resourceDetail.series?.cpuPct)?resourceDetail.series.cpuPct.filter((v:unknown)=>v!==null).length:0} · Memory readings: {Array.isArray(resourceDetail.series?.memPct)?resourceDetail.series.memPct.filter((v:unknown)=>v!==null).length:0}</p>
          <p className="small">Related recommendation: {String(resourceDetail.recommendation?.id??'None')}</p>
          <button className="ghost small" onClick={()=>setResourceDetail(null)}>Close</button>
        </div>}
      </Section>}
      {view==='people'&&isAdmin&&<>
        <Section title="Organization members — backend-enforced roles">
          <div className="team-members">{members.map(m=><div className="team-member" key={m.id}>
            <span><b>{m.name}</b> <span className="muted small">{m.email}</span></span>
            <select aria-label={`Role for ${m.name}`} disabled={busy} value={m.role} onChange={e=>void updateMember(m,{role:e.target.value})}>{(['admin','engineer','finance','leadership'] as Role[]).map(r=><option key={r} value={r}>{r}</option>)}</select>
            <button className="ghost small" disabled={busy||m.id===profile.user.id} onClick={()=>void updateMember(m,{active:!m.active})}>{m.active?'Deactivate':'Reactivate'}</button>
          </div>)}</div>
        </Section>
        <Section title="Invite a teammate (24-hour token)">
          <form className="team-form" onSubmit={e=>void issueInvite(e)}><label>Teammate email<input type="email" required value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)}/></label>
            <label>Role<select value={inviteRole} onChange={e=>setInviteRole(e.target.value as typeof inviteRole)}><option value="engineer">Engineer (approvals)</option><option value="finance">Finance (read only)</option><option value="leadership">Leadership (summary only)</option></select></label>
            <button disabled={busy}>Generate one-time invitation</button>
          </form>
          {issuedInvite&&<div className="notice"><b>One-time token (copy now; it won't be shown again):</b><code className="team-token">{issuedInvite}</code><button className="ghost small" onClick={()=>void navigator.clipboard?.writeText(issuedInvite)}>Copy token</button></div>}
        </Section>
        <Section title="Import cloud dataset for this organization">
          <p className="muted small">Only an organization admin can import data. Existing other tenant datasets remain isolated. Upload the original inventory + metrics CSV files.</p>
          <div className="team-form"><label>Inventory CSV<input type="file" accept=".csv,text/csv" onChange={e=>setInventory(e.target.files?.[0]??null)}/></label>
            <label>Metrics CSV<input type="file" accept=".csv,text/csv" onChange={e=>setMetrics(e.target.files?.[0]??null)}/></label>
            <button disabled={!inventory||!metrics||busy} onClick={()=>void importTenant()}>Validate and import into this organization</button></div>
        </Section>
      </>}
      {view==='account'&&<Section title="Account password and session management">
        <form className="team-form" onSubmit={e=>void changePassword(e)}><label>Current password<input type="password" required value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></label>
          <label>New password (12+ characters)<input type="password" minLength={12} maxLength={128} required value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label>
          <button disabled={busy}>Change my password</button></form>
      </Section>}
      {view==='audit'&&(isAdmin||profile.user.role==='engineer')&&<Section title="Server-recorded decision and access audit">
        <p className="muted small">Most recent 100 organizational actions. Includes actor, timestamp and endpoint. This local JSONL log is not tamper-proof or enterprise immutable storage.</p>
        <h3>Per-recommendation decision history</h3>
        <div className="team-audit">{decisionHistory.length===0?<p>No decisions yet.</p>:decisionHistory.slice(-100).reverse().map((d,i)=><div key={i}><span className="mono small">{new Date(d.at).toLocaleString('en-IN')}</span> <b>{d.actorEmail??'Legacy/unattributed'}</b> · {d.action} · {d.recommendationId} {d.note&&<span className="muted small">{d.note}</span>}</div>)}</div>
        <h3>Account and API audit</h3>
        <div className="team-audit">{audits.length===0?<p>No audited actions yet.</p>:audits.map((a,i)=><div key={i}><span className="mono small">{new Date(a.at).toLocaleString('en-IN')}</span> <b>{a.actor}</b> · {a.action} <span className="muted small">{a.detail}</span></div>)}</div>
      </Section>}
    </>}
  </div>;
}
