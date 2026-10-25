// Local-first secure team backend. Explicit opt-in required before any network exposure.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createTeamGateway } from './teamAuth';
const port=Number(process.env.PORT??8787);
const host=process.env.HOST??'127.0.0.1';
const origin=process.env.CORS_ORIGIN??'http://localhost:5173';
if(!new Set(['127.0.0.1','::1','localhost']).has(host)){
  if(process.env.CSX_ALLOW_PUBLIC!=='1'||process.env.AUTH_COOKIE_SECURE!=='1'||!origin.startsWith('https://'))
    throw new Error('Public bind refused. Require CSX_ALLOW_PUBLIC=1, HTTPS CORS_ORIGIN and AUTH_COOKIE_SECURE=1, and deploy behind trusted HTTPS proxy.');
}
const dataDir=process.env.DATA_DIR??join(process.cwd(),'data');
const app=createTeamGateway({dataDir,corsOrigin:origin,secureCookie:process.env.AUTH_COOKIE_SECURE==='1'});
const handler=(req:Parameters<typeof app>[0],res:Parameters<typeof app>[1])=>void app(req,res);
function listenOn(address:string,optional=false){
  const server=createServer(handler);
  server.on('error',error=>{
    if(optional) console.warn(`Optional IPv6 localhost listener unavailable (${address}):`,error.message);
    else throw error;
  });
  server.listen(port,address,()=>console.log(`CloudSentinel X Secure Team API listening on ${address}:${port}`));
}
// Explicitly bind both local loopback families; browsers may resolve "localhost" to IPv6 first.
if(host==='127.0.0.1') {listenOn('127.0.0.1');listenOn('::1',true)}
else listenOn(host);
console.log(`Sign in at ${origin}/#/team  (organization files in ${dataDir})`);
