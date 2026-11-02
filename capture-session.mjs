import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ClientError} from './session.mjs';
const exec=promisify(execFile);

function xmlText(value) {
  const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,key)=>key[0]==='#'?String.fromCodePoint(key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1))):entities[key.toLowerCase()]);
}
export function parseAppPreferences(xml) {
  const cache=xml.match(/<string\s+name="user_cache"\s*>([\s\S]*?)<\/string>/);
  if (!cache) throw new ClientError('APP_SESSION_MISSING','The app has no cached user session');
  let value;
  try { value=JSON.parse(xmlText(cache[1])); } catch { throw new ClientError('APP_SESSION_MISSING','The app session cache is malformed'); }
  const user=value.userData;
  if (!user?.accessToken || !user?.tokenLogin) throw new ClientError('APP_SESSION_MISSING','The app cache has no accessToken and tokenLogin pair');
  const stamp=xml.match(/<long\s+name="user_key_token_timestamp"\s+value="(\d+)"/);
  return {success:value.success===true,userData:{accessToken:user.accessToken,tokenLogin:user.tokenLogin},receivedAt:stamp?Number(stamp[1])*1000:0};
}
export async function captureAppSession({adb,serial='emulator-5580'}) {
  if (!/^emulator-\d+$/.test(serial)) throw new ClientError('DEVICE_INVALID','This helper is limited to an explicitly selected emulator');
  const args=['-s',serial,'exec-out','run-as','com.flightradar24free'];
  let files;
  try {files=(await exec(adb,[...args,'ls','shared_prefs'],{windowsHide:true,maxBuffer:200000})).stdout.trim().split(/\s+/);}
  catch {throw new ClientError('APP_DEBUG_REQUIRED','The diagnostic app update is required to inspect this app session');}
  // Restrict inspection to the app's default preference file identified by the APK.
  const filename=files.find(n=>n==='com.flightradar24free_preferences.xml');
  if (!filename) throw new ClientError('APP_SESSION_MISSING','The app default preferences were not found');
  let xml;
  try {xml=(await exec(adb,[...args,'cat','shared_prefs/'+filename],{windowsHide:true,maxBuffer:5000000})).stdout;}
  catch {throw new ClientError('APP_SESSION_MISSING','The app session could not be read');}
  return parseAppPreferences(xml);
}
