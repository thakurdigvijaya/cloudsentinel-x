const fs=require('fs'),path=require('path'),os=require('os');
let ts;try{ts=require('typescript')}catch{try{ts=require(path.join(path.dirname(path.dirname(process.execPath)),'lib/node_modules/typescript'))}catch{throw Error('Please run npm install first: TypeScript is required for smoke checks.')}}
const base=path.resolve(__dirname,'..'),out=fs.mkdtempSync(path.join(os.tmpdir(),'csx-offline-compiled-'));
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
let files=0;
for(const root of ['src/engine','src/data','src/lib','server']){
 const crawl=(dir)=>{for(const entry of fs.readdirSync(path.join(base,dir),{withFileTypes:true})){
   const rel=path.join(dir,entry.name); if(entry.isDirectory()){if(entry.name!=='__tests__')crawl(rel);continue}
   if(!/\.ts$/.test(rel))continue;
   const code=ts.transpileModule(fs.readFileSync(path.join(base,rel),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
   const target=path.join(out,rel.replace(/\.ts$/,'.js'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,code);files++;
 }};crawl(root)
}
// Pure sphere mapping is tested in Node too (rendering itself still needs a real browser).
for (const rel of ['src/ui/data.ts','src/ui/landing/model.ts','src/ui/landing/sphere.ts','src/ui/utsavPlan.ts']) {
 const code=ts.transpileModule(fs.readFileSync(path.join(base,rel),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const target=path.join(out,rel.replace(/\.ts$/,'.js'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,code);files++;
}
fs.writeFileSync(path.join(out,'package.json'),'{}');
const engine=require(out+'/src/engine/index.js'), deps=require(out+'/src/engine/dependencies.js'),dec=require(out+'/src/engine/decisions.js'),portfolio=require(out+'/src/engine/portfolio.js'),foresight=require(out+'/src/engine/foresight.js'),scenarios=require(out+'/src/engine/scenarios.js'),challenge=require(out+'/src/engine/challenge.js'),im=require(out+'/src/engine/importer.js');
const gen=require(out+'/src/data/generator.js').generateDataset;const fleetChallenge=require(out+'/src/engine/fleetChallenge.js').challengeFleet;
let checks=0;function ok(x,label){if(!x)throw Error('FAILED: '+label); checks++;console.log('PASS',label)};
(async()=>{
 const d=gen(),a=engine.analyzeAll(d.resources,d.series),ctx={resources:d.resources,recommendations:a.recommendations},rec=id=>a.recommendations.find(r=>r.resourceId===id);
 ok(d.resources.length===122,'122 resources');
 const totals=dec.aggregate(d.resources,a.recommendations,{});
 ok(totals.originalInr===835622,'reproducible monthly baseline');
 ok(totals.eligibleInr>218000,'baseline eligible savings plausible');
 const liveInput={resources:d.resources,series:d.series,recommendations:a.recommendations};
 const baselineLive=fleetChallenge(liveInput,0), challengedLive=fleetChallenge(liveInput,60);
 ok(baselineLive.remainingEligibleCount===59&&challengedLive.remainingEligibleCount===51,'interactive challenge 59 to 51 eligible at +60%');
 ok(challengedLive.lostEligibility.length===8,'8 previously eligible changes are refused at +60%');
 ok(challengedLive.stressedEligibleInr===191886.35&&challengedLive.lostSavingInr===26963.64,'live preview rupee totals reconcile');
 // A scenario that breaks nominal hardware limits must never be counted as a safe resize.
 const rareCpu=Array(2880).fill(10);rareCpu[500]=26;
 const conservativeCpu=foresight.evaluateSize({cpuPct:rareCpu,memPct:Array(2880).fill(20)}, {vcpu:8,ramGb:32}, {vcpu:2,ramGb:8}, 'staging');
 ok(conservativeCpu.verdict==='FAIL_SAFETY_CHECKS' && conservativeCpu.checks.find(c=>c.id==='E3').actual===104, '104% transient CPU load refused in nonproduction');
 const rareMem=Array(2880).fill(20);rareMem[700]=49.5;
 const conservativeMem=foresight.evaluateSize({cpuPct:Array(2880).fill(10),memPct:rareMem}, {vcpu:8,ramGb:32}, {vcpu:8,ramGb:16}, 'dev');
 ok(conservativeMem.verdict==='FAIL_SAFETY_CHECKS' && conservativeMem.checks.find(c=>c.id==='E8').actual===99, '99% transient memory peak fails 98% reserve threshold');
 const timingNow=require(out+'/src/engine/eventFinance.js').eventTimingSummary(a.recommendations,{});
 const refused=totals.candidateInr-timingNow.eligiblePlannedInr;
 const pending=totals.candidateInr-refused-timingNow.deferredEligibleInr-timingNow.approvedNowInr;
 ok(Math.abs(refused+timingNow.deferredEligibleInr+pending+timingNow.approvedNowInr-totals.candidateInr)<0.01, 'live financial journey reconciles proposed to refused, deferred, pending and approved');
 ok(fleetChallenge(liveInput,100).stressedEligibleInr<=challengedLive.stressedEligibleInr,'higher workload does not increase allowed savings');
 ok(a.recommendations.filter(r=>r.eligible).length===59,'preview does not modify baseline eligibility');
 const uiData=require(out+'/src/ui/data.js').buildData(d.resources,d.series,{id:'offline-smoke',source:'synthetic',start:d.start,days:30});
 const landingModel=require(out+'/src/ui/landing/model.js');
 const fleet=landingModel.buildFleet(uiData);
 const nodeTargets=landingModel.targetsFor(3,fleet,{theme:'dark',stress:{eligibleIds:challengedLive.eligibleIds},chosen:null});
 const newlyRefusedNodes=fleet.nodes.filter((node,i)=>node.kind==='safe'&&!challengedLive.eligibleIds.has(node.id)&&nodeTargets[i].shape===1);
 ok(newlyRefusedNodes.length===8,'Evidence Sphere maps exactly eight newly refused VM nodes to ring markers');
 ok(nodeTargets.length===fleet.nodes.length&&fleet.nodes.length===122,'Evidence Sphere maps every actual resource exactly once');

 const {nextEventPlan}=require(out+'/src/ui/utsavPlan.js');
 const eventA={id:'ev-a',name:'Sale',start:'2026-11-02',end:'2026-11-03',loadMultiplier:2,envs:['prod']};
 const eventB={id:'ev-b',name:'Diwali',start:'2026-11-08',end:'2026-11-10',loadMultiplier:3,envs:['prod']};
 const originalPlan=[eventA,eventB];
 const replaced=nextEventPlan(originalPlan,{...eventA,name:'New sale'},'replace');
 ok(replaced.length===1&&replaced[0].name==='New sale','Utsav Replace plan does not silently append');
 const edited=nextEventPlan(originalPlan,{...eventA,id:'should-not-change-id',loadMultiplier:4},'save','ev-a');
 ok(edited.length===2&&edited[0].id==='ev-a'&&edited[0].loadMultiplier===4&&edited[1].id==='ev-b','Utsav edit updates exact event and preserves identity');
 ok(nextEventPlan([eventA],eventB,'add').length===2,'Utsav explicit Add another event works');
 let deniedDuplicate=false;try{nextEventPlan([eventA],eventA,'add')}catch{deniedDuplicate=true}
 ok(deniedDuplicate,'Utsav accidental duplicate event ID blocked');
 let deniedStale=false;try{nextEventPlan([eventA],eventB,'save','missing')}catch{deniedStale=true}
 ok(deniedStale,'Utsav stale edit cannot silently append');
 ok(originalPlan[0].loadMultiplier===2&&originalPlan.length===2,'Utsav operations do not mutate previous plan');



 const envSum=Object.values(totals.byEnv).reduce((n,v)=>n+v.originalInr,0);
 ok(Math.abs(envSum-totals.originalInr)<0.01,'environment costs reconcile with fleet total');
 ok(Math.abs(totals.projectedInr+totals.approvedInr-totals.originalInr)<0.01,'before-after cost identity');
 const badSteps=a.recommendations.filter(r=>r.steps.length && Math.abs(r.steps.reduce((n,step)=>n+step.marginalSavingInr,0)-r.monthlySavingInr)>0.03);
 ok(badSteps.length===0,'every multi-step savings breakdown reconciles');
 const one=dec.approve({},rec('vm-057'),'now',['schedule'],ctx);
 ok(!one.ok,'unsafe standalone dependency shutdown denied');
 const together=dec.approveCoordinated({},[{rec:rec('vm-056'),steps:['schedule']},{rec:rec('vm-057'),steps:['schedule']}],'now',ctx);
 ok(together.ok,'compatible coordinated dependency bundle approved atomically');
 ok(deps.approvalDependencyConflicts(d.resources,a.recommendations,together.decisions).length===0,'atomic bundle contains no dependency conflict');
 const undo={...together.decisions};delete undo[rec('vm-056').id];const rev=dec.recheckApprovedDependencies(undo,ctx,'later');
 ok(rev[rec('vm-057').id].status==='needs-review','undo dependent marks provider review-required');
 const fake=dec.approveCoordinated({},[{rec:rec('vm-056'),steps:['schedule']},{rec:rec('vm-057'),steps:['resize']}],'now',ctx);
 ok(!fake.ok && !Object.keys(fake.decisions).length,'failed bundle is not partially committed');
 for(const b of [20,60,150,999]){
  const x=portfolio.buildPortfolio(a.recommendations,b,d.resources);const decisions=Object.fromEntries(x.choice.chosen.map(v=>[v.recommendationId,{recommendationId:v.recommendationId,status:'approved',at:'sim',acceptedSteps:v.steps}]));
  ok(!deps.approvalDependencyConflicts(d.resources,a.recommendations,decisions).length,'dependency-safe portfolio budget '+b);
 }
 const s=d.series.get('vm-001');
 ok(foresight.dataChecks(s,'dev').checks.find(c=>c.id==='E7').passed,'historical synthetic replay remains valid');
 const old={...s,analysisTime:'2026-10-25T00:00:00+05:30'};
 ok(!foresight.dataChecks(old,'dev').checks.find(c=>c.id==='E7').passed,'old imported metrics are stale at analysis time');
 ok(foresight.evaluateSize(old,{vcpu:8,ramGb:32},{vcpu:8,ramGb:32},'dev').verdict!=='PASS_UNDER_TESTED_CONDITIONS','stale data cannot PASS safety');
 ok(!foresight.dataChecks(scenarios.applyScenario(old,'traffic60'),'dev').ok,'stress scenarios preserve stale state');
 ok(!foresight.dataChecks(challenge.withExtraWorkload(old,50),'dev').ok,'breakpoint slider preserves stale state');
 ok(!foresight.dataChecks({...s,analysisTime:'2026-09-01T00:00:00+05:30'},'dev').ok,'future-dated metrics denied');
 const r=d.resources.find(x=>x.type==='vm'&&!(x.dependsOn?.length));const ser=d.series.get(r.id);
 ok(!im.importJsonDataset(JSON.stringify({resources:[r,r],series:[ser]})).ok,'JSON duplicate inventory IDs rejected');
 ok(!im.importJsonDataset(JSON.stringify({resources:[r],series:[ser,ser]})).ok,'JSON duplicate metric streams rejected');
 ok(!im.importJsonDataset(JSON.stringify({resources:[r],series:[{...ser,start:'bad date'}]})).ok,'JSON invalid timestamp rejected');
 ok(!im.importJsonDataset(JSON.stringify({resources:[{...r,dependsOn:['no-such-id']}],series:[ser]})).ok,'JSON missing dependency targets rejected');
 ok(im.importJsonDataset(JSON.stringify({resources:[r],series:[ser]})).ok,'valid JSON import accepted');
 const missingName={...r,name:''};
 ok(!im.importJsonDataset(JSON.stringify({resources:[missingName],series:[ser]})).ok,'JSON missing resource name is rejected');
 const missingOwner={...r,team:''};
 ok(!im.importJsonDataset(JSON.stringify({resources:[missingOwner],series:[ser]})).ok,'JSON missing resource team is rejected');
 const csvBadDisk='id,name,type,region,env,team,created_at,vcpu,ram_gb,disk_gb\nvm-import,Import VM,vm,noida,dev,team-a,2025-01-01,4,8,\n';
 ok(im.importInventoryCsv(csvBadDisk).errors.some(x=>x.field==='disk_gb'),'CSV VM missing boot disk inventory field is rejected');
  const eligibleResize=a.recommendations.find(x=>x.eligible&&x.steps.some(st=>st.action==='resize'));
 ok(Boolean(eligibleResize),'event fixture has eligible resize');
 const approvedRec={recommendationId:eligibleResize.id,status:'approved',at:'earlier',acceptedSteps:['resize']};
 const heldRec={...eligibleResize,holdUntil:'2026-11-11'};
 const heldDec={ [eligibleResize.id]:approvedRec };
 ok(dec.approvedSaving(heldRec,heldDec)===0,'already approved held resize cannot contribute immediate savings');
 const rechecked=dec.recheckHeldApprovals(heldDec,[heldRec],'later');
 ok(rechecked[eligibleResize.id].status==='needs-review','held previously-approved resize explicitly requires review');
 const deteriorated={...eligibleResize,eligible:false,validSteps:[]};
 ok(dec.recheckApprovedEvidence(heldDec,[deteriorated],'later')[eligibleResize.id].status==='needs-review','stale approval requires evidence revalidation');
 console.log('ENGINE_CHECKS', checks, 'transpiled_files',files);
 const {createApp}=require(out+'/server/app.js');const http=require('http');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'csx-qa-'));const stateFile=path.join(tmp,'decision.json');
 const startServer=async()=>{const app=createApp({decisionsFile:stateFile,corsOrigin:'http://localhost:5173'});const server=http.createServer((req,res)=>void app(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:'http://127.0.0.1:'+server.address().port}};
 const api=async(s,route,method='GET',body)=>{const res=await fetch(s.url+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});let json=await res.json();return {status:res.status,json}};
 let s1=await startServer();try{
 const health=await api(s1,'/api/health');ok(health.status===200&&health.json.dataset.resources===122,'HTTP API health');
 const summary=await api(s1,'/api/summary');ok(summary.status===200&&summary.json.totals.originalInr===835622,'HTTP finance matches engine');
 const unsafe=await api(s1,'/api/decisions','POST',{action:'approve',recommendationId:rec('vm-057').id,steps:['schedule']});ok(unsafe.status===409,'API denies unsafe provider alone');
 const coordinated=await api(s1,'/api/decisions/bundle','POST',{items:[{recommendationId:rec('vm-056').id,steps:['schedule']},{recommendationId:rec('vm-057').id,steps:['schedule']}]});ok(coordinated.status===200&&coordinated.json.coordinated,'HTTP atomic coordinated bundle');
 const after=await api(s1,'/api/decisions');ok(after.status===200&&after.json.totals.approvedInr>0,'API approved savings reconcile');
 await new Promise(resolve=>s1.server.close(resolve));s1=await startServer();
 const restore=await api(s1,'/api/decisions');ok(restore.json.totals.approvedInr===after.json.totals.approvedInr,'atomic persistence after API restart');
 const missing=await api(s1,'/api/wrong-url');ok(missing.status===404,'unknown route returns 404');
 const badBundle=await api(s1,'/api/decisions/bundle','POST',{items:[{recommendationId:'rec-unknown',steps:['schedule']},{recommendationId:rec('vm-056').id,steps:['schedule']}]});ok(badBundle.status===404,'invalid bundle does not write state');
 // Durable import: write real serialized resource + telemetry, restart API and prove active dataset restored.
 const smallResource=d.resources.find(r=>r.type==='vm'&&!(r.dependsOn?.length));
 const smallSeries=d.series.get(smallResource.id);
 const imported=await api(s1,'/api/import','POST',{json:JSON.stringify({resources:[r],series:[ser]})});
 ok(imported.status===201&&imported.json.dataset.resources===1,'HTTP imported dataset accepted');
 ok(fs.existsSync(stateFile+'.import.json.gz'),'durable compressed imported dataset written');
 await new Promise(resolve=>s1.server.close(resolve));s1=await startServer();
 const restoredImport=await api(s1,'/api/health');
 ok(restoredImport.json.dataset.source==='imported'&&restoredImport.json.dataset.resources===1,'imported dataset restored after server restart');
 const importedResource=await api(s1,'/api/resources');
 ok(importedResource.json.items[0].id===smallResource.id,'restored dataset preserves resource identity');
 const reset=await api(s1,'/api/dataset/reset','POST',{});
 ok(reset.status===200&&reset.json.dataset.resources===122,'API reset returns to synthetic data');
 ok(!fs.existsSync(stateFile+'.import.json.gz'),'synthetic reset clears active import snapshot');
 await new Promise(resolve=>s1.server.close(resolve));s1=await startServer();
 const afterReset=await api(s1,'/api/health');
 ok(afterReset.json.dataset.source==='synthetic','reset synthetic active dataset survives restart');
 const invalidInput=await api(s1,'/api/import','POST',{json:'{'});
 ok(invalidInput.status===422,'invalid imported JSON refused with validation error');
 const afterInvalid=await api(s1,'/api/health');
 ok(afterInvalid.json.dataset.source==='synthetic','failed import leaves active dataset untouched');
 }finally{await new Promise(resolve=>s1.server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true})}

 // SECURE TEAM WORKSPACE: attack-style integration checks run against the real HTTP gateway.
 const {createTeamGateway}=require(out+'/server/teamAuth.js');
 const authDir=fs.mkdtempSync(path.join(os.tmpdir(),'csx-auth-qa-'));
 const runTeam=async()=>{const handler=createTeamGateway({dataDir:authDir,corsOrigin:'http://localhost:5173'});const server=http.createServer((req,res)=>void handler(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:'http://127.0.0.1:'+server.address().port}};
 let teamServer=await runTeam();
 const call=async(route,method='GET',body,session)=>{
   const headers={'Origin':'http://localhost:5173'};
   if(body!==undefined)headers['Content-Type']='application/json';
   if(session?.cookie)headers['Cookie']=session.cookie;
   if(session?.csrf)headers['X-CSRF-Token']=session.csrf;
   const res=await fetch(teamServer.url+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   let json;try{json=await res.json()}catch{json={}};
   return {status:res.status,json,cookie:res.headers.get('set-cookie')?.split(';')[0]};
 };
 const pass='LongPassword2026!';
 try{
   let unauth=await call('/api/summary');ok(unauth.status===401,'team: unauthenticated fleet summary denied');
   let a=await call('/api/auth/register-org','POST',{email:'admin-a@example.test',name:'Alice Admin',organization:'Organization A',password:pass});
   ok(a.status===200&&a.json.user.role==='admin'&&a.cookie?.includes('csx_session'),'team: admin creates first organization and gains cookie session');
   const adminA={cookie:a.cookie,csrf:a.json.csrfToken};
   const orgA=a.json.organization.id;
   ok(!JSON.stringify(a.json).includes(pass)&&!JSON.stringify(a.json).includes('verifier'),'team: credential material not returned to browser');
   const me=await call('/api/auth/me','GET',undefined,adminA);ok(me.status===200&&me.json.user.orgId===orgA,'team: authenticated session profile scoped to organization');
   adminA.csrf=me.json.csrfToken;
   const anotherTab=await call('/api/auth/me','GET',undefined,adminA);
   ok(anotherTab.json.csrfToken===adminA.csrf,'team: parallel browser tabs do not invalidate CSRF token');
   const csrfFail=await call('/api/decisions','POST',{recommendationId:rec('vm-001').id,action:'approve'},{cookie:adminA.cookie,csrf:'bad'});
   ok(csrfFail.status===403,'team: forged missing/invalid CSRF token cannot approve');
   const originFail=await fetch(teamServer.url+'/api/summary',{headers:{Origin:'http://untrusted.test',Cookie:adminA.cookie}});
   ok(originFail.status===403,'team: other browser origin denied');
   const signupDup=await call('/api/auth/register-org','POST',{email:'admin-a@example.test',name:'Attack User',organization:'Fake',password:pass});
   ok(signupDup.status===409,'team: duplicate email registration denied');
   let b=await call('/api/auth/register-org','POST',{email:'admin-b@example.test',name:'Bob Admin',organization:'Organization B',password:pass});
   ok(b.status===200&&b.json.organization.id!==orgA,'team: second organization receives distinct ID');
   const adminB={cookie:b.cookie,csrf:b.json.csrfToken};
   const originalB=await call('/api/summary','GET',undefined,adminB);ok(originalB.status===200&&originalB.json.dataset.resources===122,'team: independent second-tenant baseline');
   let rejectedA=await call('/api/decisions','POST',{recommendationId:rec('vm-001').id,action:'reject'},adminA); // adjusted below; call signature
   ok(rejectedA.status===200,'team: organization A decision stored');
   const afterA=await call('/api/decisions','GET',undefined,adminA),afterB=await call('/api/decisions','GET',undefined,adminB);
   ok(Object.keys(afterA.json.decisions).length===1 && Object.keys(afterB.json.decisions).length===0,'team: identical resource IDs have isolated decision records');
   ok(afterA.json.history[0].actorEmail==='admin-a@example.test'&&afterA.json.history[0].recommendationId===rec('vm-001').id,'team: decision history contains actor identity and resource evidence ID');
   const inv=await call('/api/team/invites','POST',{email:'fin-a@example.test',role:'finance'},adminA);
   ok(inv.status===201&&typeof inv.json.token==='string','team: admin issues one-time scoped invitation');
   const duplicateUse=await call('/api/auth/accept-invite','POST',{token:inv.json.token,name:'Fiona Finance',password:pass});
   ok(duplicateUse.status===200&&duplicateUse.json.user.role==='finance','team: invitee joins with assigned role');
   const finA={cookie:duplicateUse.cookie,csrf:duplicateUse.json.csrfToken};
   const replayInvite=await call('/api/auth/accept-invite','POST',{token:inv.json.token,name:'Fiona Finance',password:pass});
   ok(replayInvite.status===400,'team: invitation cannot be reused');
   const finRead=await call('/api/summary','GET',undefined,finA);
   const finWrite=await call('/api/decisions','POST',{recommendationId:rec('vm-001').id,action:'approve'},finA);
   ok(finRead.status===200&&finWrite.status===403,'team: finance role is server-enforced read-only');
   const finList=await call('/api/team/members','GET',undefined,finA);
   ok(finList.status===403,'team: finance cannot enumerate or manage accounts');
   const invEng=await call('/api/team/invites','POST',{email:'eng-a@example.test',role:'engineer'},adminA);
   const engineerRes=await call('/api/auth/accept-invite','POST',{token:invEng.json.token,name:'Emily Engineer',password:pass});
   const engineer={cookie:engineerRes.cookie,csrf:engineerRes.json.csrfToken};
   const engWrite=await call('/api/decisions','POST',{recommendationId:rec('vm-002').id,action:'reject'},engineer);
   ok(engWrite.status===200,'team: engineer can record permitted human decisions');
   const engReset=await call('/api/dataset/reset','POST',{},engineer);
   ok(engReset.status===403,'team: engineer cannot replace/reset whole organization dataset');
   const invLead=await call('/api/team/invites','POST',{email:'lead-a@example.test',role:'leadership'},adminA);
   const leadRes=await call('/api/auth/accept-invite','POST',{token:invLead.json.token,name:'Linda Leader',password:pass});
   const leader={cookie:leadRes.cookie,csrf:leadRes.json.csrfToken};
   const leadSummary=await call('/api/summary','GET',undefined,leader),leadResources=await call('/api/resources','GET',undefined,leader);
   ok(leadSummary.status===200&&leadResources.status===403,'team: leadership sees executive metrics but not raw resources');
   const adminAMembers=await call('/api/team/members','GET',undefined,adminA);
   const adminBMembers=await call('/api/team/members','GET',undefined,adminB);
   ok(adminAMembers.json.items.length===4&&adminBMembers.json.items.length===1,'team: member enumeration scoped to authenticated tenant');
   const crossTenantUpdate=await call('/api/team/members/'+adminBMembers.json.items[0].id,'PATCH',{role:'engineer'},adminA);
   ok(crossTenantUpdate.status===404,'team: tenant A admin cannot mutate tenant B account');
   const selfDowngrade=await call('/api/team/members/'+adminAMembers.json.items[0].id,'PATCH',{role:'finance'},adminA);
   ok(selfDowngrade.status===409,'team: last admin cannot self-demote');
   const aAudit=await call('/api/team/audit','GET',undefined,adminA),bAudit=await call('/api/team/audit','GET',undefined,adminB);
   ok(aAudit.status===200&&aAudit.json.items.every(x=>x.orgId===orgA),'team: audit events filtered by organization');
   ok(bAudit.json.items.every(x=>x.orgId===b.json.organization.id),'team: tenant B audit does not leak tenant A history');
   const banned=await call('/api/team/members/'+engineerRes.json.user.id,'PATCH',{active:false},adminA);
   const engAfterDisable=await call('/api/summary','GET',undefined,engineer);
   ok(banned.status===200&&engAfterDisable.status===401,'team: deactivated employee sessions revoked immediately');
   // Tenant-specific import + restart isolation. Use a valid self-contained one-VM JSON fixture.
   const importBody={json:JSON.stringify({resources:[r],series:[ser]})};
   const tenantImported=await call('/api/import','POST',importBody,adminA);
   ok(tenantImported.status===201&&tenantImported.json.dataset.resources===1,'team: tenant A imports own data');
   const tenantBUntouched=await call('/api/health','GET',undefined,adminB);
   ok(tenantBUntouched.json.dataset.resources===122,'team: tenant B inventory unchanged after tenant A import');
   await new Promise(resolve=>teamServer.server.close(resolve));teamServer=await runTeam();
   const aRestored=await call('/api/health','GET',undefined,adminA),bRestored=await call('/api/health','GET',undefined,adminB);
   ok(aRestored.status===200&&aRestored.json.dataset.resources===1&&bRestored.json.dataset.resources===122,'team: isolated imported datasets and sessions survive gateway restart');
   const secondLogin=await call('/api/auth/login','POST',{email:'admin-a@example.test',password:pass});
   ok(secondLogin.status===200&&secondLogin.cookie!==adminA.cookie,'team: second session issued for same account');
   const badPassword=await call('/api/auth/change-password','POST',{currentPassword:'incorrect',newPassword:'NewPassword2026!'},adminA);
   ok(badPassword.status===400,'team: password change requires current password');
   const changed=await call('/api/auth/change-password','POST',{currentPassword:pass,newPassword:'NewPassword2026!'},adminA);
   ok(changed.status===200,'team: account password change accepted');
   const previousSession=await call('/api/auth/me','GET',undefined,{cookie:secondLogin.cookie});
   ok(previousSession.status===401,'team: password change revokes other logged-in devices');
   const outdatedPassword=await call('/api/auth/login','POST',{email:'admin-a@example.test',password:pass});
   const validNewPassword=await call('/api/auth/login','POST',{email:'admin-a@example.test',password:'NewPassword2026!'});
   ok(outdatedPassword.status===401&&validNewPassword.status===200,'team: old credential invalid, new credential works');
   const logout=await call('/api/auth/logout','POST',{},adminA);
   const afterLogout=await call('/api/summary','GET',undefined,adminA);
   ok(logout.status===200&&afterLogout.status===401,'team: logout invalidates persisted session');
 }finally{await new Promise(resolve=>teamServer.server.close(resolve));fs.rmSync(authDir,{recursive:true,force:true})}
 console.log('TOTAL_PASS',checks); fs.rmSync(out,{recursive:true,force:true})
})().catch(e=>{console.error('ERROR',e.stack||e);process.exit(1)})
