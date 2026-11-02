import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SessionClient,bootstrap,ClientError} from './session.mjs';
import {LiveFlights} from './live.mjs';
import {saveSession,loadSession,withSavedSession} from './secure-store.mjs';
import {captureAppSession} from './capture-session.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
const arg=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const command=args[0]||'help';
const report={startedAt:new Date().toISOString(),sessionSource:null,refreshTested:false,authenticated:false};
let live;
try {
  if (command==='help' || args.includes('--help')) {
    console.log('Commands: capture --adb <adb.exe> [--serial emulator-5580] | live | public | settings');
    console.log('Options: --refresh --bounds north,south,west,east --limit 100 --out <result.json>');
    console.log('Sessions are stored only with Windows current-user DPAPI. No token is printed.');
  } else {
    if (command==='settings') {
      const settings=await bootstrap();
      await writeFile(resolve(root,'runtime-settings.json'),JSON.stringify(settings,null,2));
      console.log(JSON.stringify({ok:true,settingsTimestamp:settings.timestamp}));
    } else {
      if (!['capture','live','public'].includes(command)) throw new ClientError('USAGE','Unknown command');
      const settings=JSON.parse(await readFile(resolve(root,arg('--settings','runtime-settings.json')),'utf8').catch(()=>readFile(resolve(root,'bundled-settings.json'),'utf8')));
      const session=new SessionClient({settings});
      const sessionPath=resolve(root,'private/session.dpapi');
      if (command==='capture') {
        const adb=arg('--adb');if (!adb) throw new ClientError('USAGE','--adb is required');
        session.importSession(await captureAppSession({adb,serial:arg('--serial','emulator-5580')}));
        await saveSession(sessionPath,session);report.sessionSource='logged-in Android app';
      } else if (command==='live') {
        await loadSession(sessionPath,session);report.sessionSource='current-user DPAPI cache';
      }
      if (args.includes('--refresh') && command!=='public') {await session.refresh();await saveSession(sessionPath,session);report.refreshTested=true;}
      const values=arg('--bounds','36,35,50,52').split(',').map(Number);
      if (values.length!==4) throw new ClientError('BOUNDS_INVALID','Supply exactly north,south,west,east');
      const [north,south,west,east]=values;
      live=new LiveFlights({settings});
      const query=()=>live.query(command==='public'?{authorization:async()=>({})}:session,{north,south,west,east},Number(arg('--limit','100')));
      const result=command==='public'?await query():await withSavedSession(sessionPath,session,query);
      Object.assign(report,{ok:true,accountBearerSent:command!=='public',authenticated:command!=='public' && session.serverValidated,authenticationMeaning:'authenticated means a successful login or session refresh response in this process; it does not assert a Gold entitlement',bounds:{north,south,west,east},receivedAt:new Date().toISOString(),flightCount:result.flights.length,serverTimeMs:result.serverTimeMs});
      const out=resolve(root,arg('--out',command==='public'?'live-public-result.json':'live-authenticated-result.json'));
      await writeFile(out,JSON.stringify({...report,...result},null,2));
      await mkdir(resolve(root,'reports'),{recursive:true});
      await writeFile(resolve(root,'reports/last-run.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify({...report,resultFile:out,sample:result.flights.slice(0,2)},null,2));
    }
  }
} catch (e) {
  report.ok=false;report.code=e instanceof ClientError?e.code:'LOCAL_ERROR';
  report.message=e instanceof ClientError?e.message:'A local operation failed; no credentials were printed';
  if (e.cacheSaveFailed) report.cacheSaveFailed=true;
  await mkdir(resolve(root,'reports'),{recursive:true});
  await writeFile(resolve(root,'reports/last-run.json'),JSON.stringify(report,null,2));
  console.error(JSON.stringify(report,null,2));process.exitCode=1;
} finally {live?.close();}
