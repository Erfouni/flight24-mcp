import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {ClientError} from './session.mjs';

function transform(mode,input) {
  if (process.platform !== 'win32') return Promise.reject(new ClientError('STORE_UNAVAILABLE','This encrypted cache requires Windows DPAPI'));
  return new Promise((resolve,reject)=>{
    // Invoke fixed, local command code without changing Windows execution policy.
    // User data is carried on stdin, never interpolated into command text.
    const script=readFileSync(new URL('./dpapi.ps1',import.meta.url),'utf8');
    const p=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command','& {\n'+script+'\n} -Mode '+mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='';
    p.stdout.setEncoding('utf8');p.stdout.on('data',v=>out+=v);
    p.stderr.resume();
    const timer=setTimeout(()=>{p.kill();reject(new ClientError('STORE_FAILED','DPAPI operation timed out'));},15000);
    p.on('error',()=>{clearTimeout(timer);reject(new ClientError('STORE_FAILED','DPAPI process could not start'));});
    p.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(new ClientError('STORE_FAILED','DPAPI encryption or decryption failed'));});
    p.stdin.on('error',()=>{});p.stdin.end(input);
  });
}
export const protect=input=>transform('protect',input);
export const unprotect=input=>transform('unprotect',input);
export async function saveSession(path,session) {
  const encrypted=await protect(JSON.stringify(session.exportSession()));
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path+'.tmp',encrypted,{mode:0o600});await rename(path+'.tmp',path);
}
export async function loadSession(path,session) {
  const encrypted=await readFile(path,'utf8');
  let response;
  try { response=JSON.parse(await unprotect(encrypted)); } catch { throw new ClientError('STORE_FAILED','Encrypted session could not be loaded'); }
  session.importSession(response);
}
export async function withSavedSession(path,session,action) {
  let failure;
  try {return await action();} catch(e) {failure=e;throw e;}
  finally {
    try {await saveSession(path,session);}
    catch(e) {if (failure) failure.cacheSaveFailed=true;else throw e;}
  }
}
