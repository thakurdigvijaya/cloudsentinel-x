/** Local-first authenticated multi-organization gateway around the proven optimization API.
 * Design: one isolated createApp() instance + files per organization, server-side permission checks,
 * HttpOnly session cookie, explicit CSRF header and origin checks for all state changes.
 * NOT an internet-scale identity provider or a substitute for HTTPS/reverse proxy hardening.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createApp } from './app';

export type TeamRole = 'admin' | 'engineer' | 'finance' | 'leadership';
interface Organization { id: string; name: string; createdAt: string }
interface Account { id: string; orgId: string; email: string; name: string; role: TeamRole; salt: string; verifier: string; active: boolean; createdAt: string }
interface Session { hash: string; userId: string; csrf: string; expiresAt: string }
interface Invitation { tokenHash: string; orgId: string; email: string; role: Exclude<TeamRole,'admin'>; expiresAt: string; createdBy: string }
interface AuthStore { organizations: Organization[]; accounts: Account[]; sessions: Session[]; invitations: Invitation[] }
export interface GatewayOptions { dataDir: string; corsOrigin?: string; secureCookie?: boolean; maxBodyBytes?: number }
interface Principal { account: Account; org: Organization; csrf: string; sessionHash: string }
class ApiError extends Error { constructor(public status: number, message: string) { super(message) } }
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
const emailKey = (v: unknown) => typeof v === 'string' ? v.trim().toLowerCase() : '';
const roleOk = (r: unknown): r is Exclude<TeamRole,'admin'> => r === 'engineer' || r === 'finance' || r === 'leadership';
const publicUser = (a: Account) => ({ id:a.id, orgId:a.orgId, name:a.name, email:a.email, role:a.role, active:a.active });
const safeEqual = (a: string, b: string) => { const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y) };
const saltAndHash = (password: string) => { const salt = randomBytes(16).toString('hex'); return { salt, verifier:scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex') } };
const matchesPassword = (a: Account, password: string) => safeEqual(a.verifier,scryptSync(password,Buffer.from(a.salt,'hex'),64).toString('hex'));
const validPassword = (p: unknown) => typeof p === 'string' && p.length >= 12 && p.length <= 128;
const iso = () => new Date().toISOString();
const cookieName = 'csx_session';
const readCookie = (s: string | undefined) => s?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1) ?? '';

export function createTeamGateway(options: GatewayOptions) {
  const origin = options.corsOrigin ?? 'http://localhost:5173';
  const storePath = join(options.dataDir,'team-accounts.json');
  const auditPath = join(options.dataDir,'team-audit.jsonl');
  mkdirSync(options.dataDir,{recursive:true});
  let db: AuthStore = {organizations:[],accounts:[],sessions:[],invitations:[]};
  if (existsSync(storePath)) {
    try {
      const loaded = JSON.parse(readFileSync(storePath,'utf8')) as AuthStore;
      if (!Array.isArray(loaded.organizations)||!Array.isArray(loaded.accounts)||!Array.isArray(loaded.sessions)||!Array.isArray(loaded.invitations)) throw Error('Invalid auth state');
      db = loaded;
    } catch (e) { throw new Error('Auth store cannot be parsed; refusing to start instead of discarding accounts. '+(e as Error).message); }
  }
  const save = () => {
    const temp = storePath+'.'+randomUUID()+'.tmp';
    writeFileSync(temp,JSON.stringify(db,null,2),{mode:0o600});
    renameSync(temp,storePath);
  };
  const audit = (actor: Account | null, orgId: string | null, action: string, detail?: string) => {
    appendFileSync(auditPath,JSON.stringify({at:iso(),orgId,actorId:actor?.id??null,actor:actor?.email??'anonymous',action,detail:detail?.slice(0,200)??''})+'\n',{mode:0o600});
  };
  const tenantApis = new Map<string,ReturnType<typeof createApp>>();
  const teamApi = (orgId: string) => {
    let api = tenantApis.get(orgId);
    if (!api) {
      const dir=join(options.dataDir,'tenants',orgId);
      api=createApp({decisionsFile:join(dir,'decisions.json'),corsOrigin:origin, maxBodyBytes:options.maxBodyBytes ?? 50*1024*1024,
        actorForRequest:req=>(req as IncomingMessage & {csxActor?:{id:string;email:string}}).csxActor??null});
      tenantApis.set(orgId,api);
    }
    return api;
  };
  const json = (res: ServerResponse,status: number,value: unknown, headers:Record<string,string> = {}) => {
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff', ...headers});
    res.end(JSON.stringify(value));
  };
  const readJson = async(req:IncomingMessage) => {
    const chunks:Buffer[]=[]; let size=0;
    if (!(req.headers['content-type']??'').includes('application/json')) throw new ApiError(415,'JSON content type required.');
    for await(const chunk of req){ size+=chunk.length; if(size>16384)throw new ApiError(413,'Account request too large.');chunks.push(chunk) }
    try {return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>}catch{throw new ApiError(400,'Invalid JSON.')}
  };
  const authenticate = (req:IncomingMessage):Principal => {
    const raw=readCookie(req.headers.cookie);
    if (!raw) throw new ApiError(401,'Sign in to the secure Team Workspace.');
    const s=db.sessions.find(x=>x.hash===sha(raw)&&Date.parse(x.expiresAt)>Date.now());
    const a=s&&db.accounts.find(x=>x.id===s.userId&&x.active);
    const org=a&&db.organizations.find(x=>x.id===a.orgId);
    if (!s||!a||!org) throw new ApiError(401,'Session expired or account disabled. Sign in again.');
    return {account:a,org,csrf:s.csrf,sessionHash:s.hash};
  };
  const ensureCsrf = (req:IncomingMessage,p:Principal) => {
    const supplied=req.headers['x-csrf-token'];
    if(typeof supplied!=='string'||!safeEqual(supplied,p.csrf)) throw new ApiError(403,'CSRF verification failed. Reload your team session.');
  };
  const loginResponse = (res:ServerResponse,a:Account) => {
    const session=token(), csrf=token();
    db.sessions.push({hash:sha(session),userId:a.id,csrf,expiresAt:new Date(Date.now()+7*24*3600000).toISOString()});
    db.sessions=db.sessions.filter(s=>Date.parse(s.expiresAt)>Date.now());
    save();
    json(res,200,{user:publicUser(a),organization:db.organizations.find(o=>o.id===a.orgId),csrfToken:csrf}, {'Set-Cookie':`${cookieName}=${session}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800${options.secureCookie?'; Secure':''}`});
  };
  const attempts = new Map<string,{count:number;until:number}>();
  return async function gateway(req:IncomingMessage,res:ServerResponse) {
    const u=new URL(req.url??'/', 'http://localhost'); const path=u.pathname; const method=req.method??'GET';
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Vary','Origin');
    res.setHeader('X-Content-Type-Options','nosniff');
    try {
      // Reject browser origins except the explicitly configured UI; no wildcard credential leakage.
      if(req.headers.origin && req.headers.origin!==origin) throw new ApiError(403,'Untrusted origin.');
      if(method==='OPTIONS'){
        res.writeHead(204,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-CSRF-Token','Vary':'Origin'});res.end();return;
      }
      if (path==='/api/auth/register-org' && method==='POST') {
        const b=await readJson(req);const email=emailKey(b.email);const name=String(b.name??'').trim();const orgName=String(b.organization??'').trim();
        if(!emailOk(email)||!validPassword(b.password)||name.length<2||name.length>100||orgName.length<2||orgName.length>100)throw new ApiError(400,'Provide valid email, name, organization and password (12–128 characters).');
        if(db.accounts.some(a=>a.email===email))throw new ApiError(409,'An account with this email already exists.');
        const org={id:randomUUID(),name:orgName,createdAt:iso()}, hashed=saltAndHash(b.password as string);
        const a:Account={id:randomUUID(),orgId:org.id,email,name,role:'admin',active:true,createdAt:iso(),...hashed};
        db.organizations.push(org);db.accounts.push(a);audit(a,org.id,'organization.created');loginResponse(res,a);return;
      }
      if(path==='/api/auth/login'&&method==='POST'){
        const b=await readJson(req);const email=emailKey(b.email);const key=email+'|'+(req.socket.remoteAddress??'');const attempt=attempts.get(key);
        if(attempt && attempt.count>=5&&attempt.until>Date.now())throw new ApiError(429,'Too many attempts. Try again later.');
        const a=db.accounts.find(x=>x.email===email&&x.active);
        const valid=typeof b.password==='string'&&b.password.length<=128&&a?matchesPassword(a,b.password):false;
        if(!valid){attempts.set(key,{count:(attempt?.until??0)>Date.now()?(attempt?.count??0)+1:1,until:Date.now()+15*60000});throw new ApiError(401,'Incorrect email or password.');}
        attempts.delete(key);audit(a,a.orgId,'session.login');loginResponse(res,a);return;
      }
      if(path==='/api/auth/accept-invite'&&method==='POST'){
        const b=await readJson(req);const inviteToken=typeof b.token==='string'?b.token:'';const inv=db.invitations.find(i=>safeEqual(i.tokenHash,sha(inviteToken))&&Date.parse(i.expiresAt)>Date.now());
        const name=String(b.name??'').trim();
        if(!inv||!validPassword(b.password)||name.length<2||name.length>100)throw new ApiError(400,'Invitation invalid/expired or account details insufficient.');
        if(db.accounts.some(a=>a.email===inv.email))throw new ApiError(409,'Email already registered.');
        const a:Account={id:randomUUID(),orgId:inv.orgId,email:inv.email,name,role:inv.role,active:true,createdAt:iso(),...saltAndHash(b.password as string)};
        db.accounts.push(a);db.invitations=db.invitations.filter(i=>i!==inv);audit(a,inv.orgId,'invite.accepted');loginResponse(res,a);return;
      }
      const p=authenticate(req);
      if(path==='/api/auth/me'&&method==='GET'){
        // Stable per-session CSRF prevents React StrictMode, multiple tabs and refreshes from invalidating each other.
        json(res,200,{user:publicUser(p.account),organization:p.org,csrfToken:p.csrf});return;
      }
      if(method!=='GET'&&method!=='HEAD')ensureCsrf(req,p);
      if(path==='/api/auth/change-password'&&method==='POST'){
        const b=await readJson(req);
        if(typeof b.currentPassword!=='string'||!matchesPassword(p.account,b.currentPassword)||!validPassword(b.newPassword))
          throw new ApiError(400,'Current password incorrect or new password must contain 12–128 characters.');
        Object.assign(p.account,saltAndHash(b.newPassword as string));
        // Password change revokes any sessions held by other browsers/devices.
        db.sessions=db.sessions.filter(s=>s.userId!==p.account.id||s.hash===p.sessionHash);
        save();audit(p.account,p.org.id,'account.password-changed');
        json(res,200,{ok:true,otherSessionsRevoked:true});return;
      }
      if(path==='/api/auth/logout'&&method==='POST'){
        db.sessions=db.sessions.filter(s=>s.hash!==p.sessionHash);save();audit(p.account,p.org.id,'session.logout');json(res,200,{ok:true},{'Set-Cookie':`${cookieName}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${options.secureCookie?'; Secure':''}`});return;
      }
      if(path==='/api/team/members'&&method==='GET'){
        if(p.account.role!=='admin')throw new ApiError(403,'Admin role required.');
        json(res,200,{items:db.accounts.filter(a=>a.orgId===p.org.id).map(publicUser)});return;
      }
      if(path==='/api/team/invites'&&method==='POST'){
        if(p.account.role!=='admin')throw new ApiError(403,'Admin role required.');
        const b=await readJson(req);const email=emailKey(b.email);
        if(!emailOk(email)||!roleOk(b.role)||db.accounts.some(a=>a.email===email))throw new ApiError(400,'Use a new email and a valid non-admin role.');
        db.invitations=db.invitations.filter(i=>i.orgId!==p.org.id||i.email!==email);
        const raw=token(); db.invitations.push({tokenHash:sha(raw),orgId:p.org.id,email,role:b.role,expiresAt:new Date(Date.now()+24*3600000).toISOString(),createdBy:p.account.id});save();
        audit(p.account,p.org.id,'invite.created',`${email} as ${b.role}`);
        json(res,201,{token:raw,email,role:b.role,expiresInHours:24,note:'Copy this one-time token to your teammate securely. No email has been sent.'});return;
      }
      if(path.startsWith('/api/team/members/')&&method==='PATCH'){
        if(p.account.role!=='admin')throw new ApiError(403,'Admin role required.');
        const id=decodeURIComponent(path.slice('/api/team/members/'.length));const a=db.accounts.find(x=>x.id===id&&x.orgId===p.org.id);
        if(!a)throw new ApiError(404,'Team member not found.');
        const b=await readJson(req);const role=b.role, active=b.active;
        if(role!==undefined && !roleOk(role) && role!=='admin')throw new ApiError(400,'Invalid role.');
        if(active!==undefined&&typeof active!=='boolean')throw new ApiError(400,'active must be boolean.');
        if(a.id===p.account.id && (active===false || (role!==undefined&&role!=='admin')))throw new ApiError(409,'Cannot deactivate/demote your own admin account.');
        const otherAdmins=db.accounts.filter(x=>x.orgId===p.org.id && x.active && x.role==='admin' && x.id!==a.id).length;
        if(a.role==='admin' && otherAdmins===0 && (active===false||(role!==undefined&&role!=='admin')))throw new ApiError(409,'Organization must retain one active admin.');
        if(role!==undefined)a.role=role as TeamRole;
        if(active!==undefined)a.active=active;
        if(active===false)db.sessions=db.sessions.filter(s=>s.userId!==a.id);
        save();audit(p.account,p.org.id,'member.updated',`${a.email}: ${a.role}, active=${a.active}`);
        json(res,200,{user:publicUser(a)});return;
      }
      if(path==='/api/team/audit'&&method==='GET'){
        if(!['admin','engineer'].includes(p.account.role))throw new ApiError(403,'Engineer or admin role required.');
        let entries:unknown[]=[];if(existsSync(auditPath)){
          const lines=readFileSync(auditPath,'utf8').trim().split('\n').slice(-1000);
          entries=lines.filter(Boolean).map(line=>{try{return JSON.parse(line) as {orgId?:string}}catch{return null}}).filter((e):e is {orgId?:string}=>!!e&&e.orgId===p.org.id).slice(-100).reverse();
        }
        json(res,200,{items:entries});return;
      }
      // All existing optimization endpoints now require a valid authenticated organization session.
      // Mutations are never allowed for finance or leadership, even when called directly with curl.
      if(method!=='GET'&&method!=='HEAD'){
        if(p.account.role!=='admin'&&p.account.role!=='engineer')throw new ApiError(403,'Only engineers/admins can modify optimization plans.');
        if((path==='/api/import'||path==='/api/dataset/reset'||(method==='DELETE'&&path==='/api/decisions'))&&p.account.role!=='admin')throw new ApiError(403,'Organization admin required for dataset/reset operations.');
      }
      if(p.account.role==='leadership'&&!(['/api/health','/api/summary','/api/alerts','/api/explain','/api/forecast','/api/sustainability','/api/config'].includes(path))) throw new ApiError(403,'Leadership role has summary-only access.');
      // No way to select a tenant by query/path. Authenticated session fixes the tenant scope.
      const handler=teamApi(p.org.id);
      (req as IncomingMessage & {csxActor?:{id:string;email:string}}).csxActor={id:p.account.id,email:p.account.email};
      if(method!=='GET'&&method!=='HEAD'){
        res.once('finish',()=>{if(res.statusCode>=200&&res.statusCode<300) {
          try { audit(p.account,p.org.id,`${method} ${path}`,`status=${res.statusCode}`); }
          catch(err) { console.error('Audit append failed:',err); }
        }});
      }
      res.setHeader('Access-Control-Allow-Credentials','true');
      await handler(req,res);
    } catch (e) {
      if(res.headersSent)return;
      if(e instanceof ApiError)json(res,e.status,{error:e.message});
      else {console.error('Team gateway error',e);json(res,500,{error:'Internal error.'})}
    }
  };
}
