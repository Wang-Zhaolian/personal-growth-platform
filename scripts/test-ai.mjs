import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Entry } from '@napi-rs/keyring';
import { ChatGPTAuth, parseCallback, assertScopes, verifyIdentity, mergeTokens, DIRECT_SCOPE } from '../dist/server/ai-auth.js';
import { readResponseStream, parseModels, ChatGPTInference } from '../dist/server/ai-inference.js';
import { checkedFetch, AIError, normalizeError } from '../dist/server/ai-errors.js';
import { ProtectedVault } from '../dist/server/ai-vault.js';

const code = expected => error => error instanceof AIError && error.diagnostic.code === expected;
const scopes = [DIRECT_SCOPE, 'resource.invoke', 'offline_access'];
const base = () => ({ key: 'synthetic-account', clientId: 'oaiapp_synthetic', subject: 'synthetic-subject', label: '合成账号', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: 'synthetic-id', scopes, expiresAt: Date.now() + 3600000 });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req_synthetic' } });
class MemoryVault {
  constructor(data = { registrations: [] }, fail = false) { this.data = structuredClone(data); this.fail = fail; this.tail = Promise.resolve(); }
  transact(action) {
    const run = this.tail.then(async () => { const draft = structuredClone(this.data); return action(draft, async () => { if (this.fail) throw new AIError('数据保存', 'credential_storage_failed', '合成保存失败'); this.data = structuredClone(draft); }); });
    this.tail = run.catch(() => {}); return run;
  }
}
const waitFinished = async auth => { for (let n=0; n<100 && ['starting','waiting','exchanging','saving'].includes(auth.login.phase); n++) await new Promise(resolve => setTimeout(resolve, 10)); };

test('callback rejects foreign state, refusal, bootstrap ID and changed client', () => {
  assert.throws(() => parseCallback(new URL('http://127.0.0.1/auth/callback?state=wrong'), 'expected'), code('state_mismatch'));
  assert.throws(() => parseCallback(new URL('http://127.0.0.1/auth/callback?state=s&error=access_denied'), 's'), code('access_denied'));
  assert.throws(() => parseCallback(new URL('http://127.0.0.1/auth/callback?state=s&code=c&client_id=dynamic_agent_client'), 's'), code('registration_incomplete'));
  assert.throws(() => parseCallback(new URL('http://127.0.0.1/auth/callback?state=s&code=c&client_id=other'), 's', 'own'), code('client_mismatch'));
  assert.equal(parseCallback(new URL('http://127.0.0.1/auth/callback?state=s&code=c'), 's', 'own').clientId, 'own');
});
test('ID token signature, nonce, issuer, audience and expiration validation', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'synthetic';
  const fetcher = async url => response(String(url).includes('openid-configuration') ? { issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' } : { keys: [jwk] });
  const token = async (overrides = {}) => new SignJWT({ nonce: 'nonce', ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic' }).setSubject('synthetic').setIssuer(overrides.iss ?? 'https://auth.openai.com').setAudience(overrides.aud ?? 'own').setIssuedAt().setExpirationTime(overrides.exp ?? '2m').sign(privateKey);
  assert.equal(await verifyIdentity(await token(), 'own', 'nonce', fetcher), 'synthetic');
  for (const claims of [{ nonce: 'wrong' }, { iss: 'https://invalid.example' }, { aud: 'borrowed' }, { exp: 1 }]) await assert.rejects(verifyIdentity(await token(claims), 'own', 'nonce', fetcher), code('id_token_invalid'));
  const signed = await token(); await assert.rejects(verifyIdentity(signed.slice(0,-8)+'corrupt!', 'own', 'nonce', fetcher), code('id_token_invalid'));
});
test('own registration: listener first, exact callback, granted scopes, protected save and safe status', async () => {
  const vault = new MemoryVault(); let exchange;
  const auth = new ChatGPTAuth(vault, () => 'urn:uuid:synthetic', () => true, () => {}, async (_url, init) => { exchange = new URLSearchParams(init.body); return response({ access_token: 'synthetic-token', refresh_token: 'synthetic-refresh', id_token: 'synthetic-id', scope: scopes.join(' '), expires_in: 3600 }); }, async () => 'synthetic-subject');
  try {
    const [login, duplicate] = await Promise.all([auth.begin(), auth.begin()]); assert.equal(login.attemptId, duplicate.attemptId);
    const url = new URL(login.authUrl); assert.equal(url.searchParams.get('agent_name_hint'), '昭濂个人成长平台');
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state'), client_id: 'oaiapp_own' });
    assert.equal((await fetch(callback)).status, 200); await waitFinished(auth);
    assert.equal(auth.login.phase, 'succeeded'); assert.equal(exchange.get('client_id'), 'oaiapp_own'); assert.equal(exchange.get('redirect_uri'), url.searchParams.get('redirect_uri'));
    assert.equal(vault.data.registrations[0].subject, 'synthetic-subject'); assert.ok(!JSON.stringify(await auth.status()).includes('synthetic-token'));
    const returning = new URL((await auth.begin()).authUrl); assert.equal(returning.searchParams.get('client_id'), 'oaiapp_own'); assert.equal(returning.searchParams.has('agent_name_hint'), false);
  } finally { auth.cancel(auth.login.attemptId); }
});
test('eligibility gate, cancellation, timeout and retry clean listeners', async () => {
  const denied = new ChatGPTAuth(new MemoryVault(), () => 'host', () => false, () => {});
  await assert.rejects(denied.begin(), code('private_client_approval_required'));
  const auth = new ChatGPTAuth(new MemoryVault(), () => 'host', () => true, () => {});
  for (const timeout of [false,true]) { const login = await auth.begin(); assert.ok(auth.cancel(login.attemptId, timeout)); assert.equal(auth.login.phase, timeout ? 'timed_out' : 'cancelled'); }
});
test('save failure never reports connected', async () => {
  const vault = new MemoryVault(undefined, true);
  const auth = new ChatGPTAuth(vault, () => 'host', () => true, () => {}, async () => response({ access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 3600, scope: scopes.join(' ') }), async () => 'sub');
  const login = await auth.begin(), url = new URL(login.authUrl), callback = new URL(url.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'c', client_id: 'own' });
  await fetch(callback); await waitFinished(auth); assert.equal(auth.login.phase, 'failed'); assert.equal(auth.login.diagnostic.stage, '数据保存'); assert.equal((await auth.status()).configured, false);
});
test('scope, quota, expired grant and offline errors remain distinguishable', async () => {
  assert.throws(() => assertScopes(['openid']), code('insufficient_scope'));
  for (const [status, errorCode] of [[403,'insufficient_scope'],[429,'insufficient_quota'],[400,'invalid_grant'],[403,'unsupported_country_region_territory']]) {
    await assert.rejects(checkedFetch('推理请求', 'https://example.invalid', {}, async () => response({ error: { code: errorCode, message: 'secret must never appear' } }, status)), error => code(errorCode)(error) && error.diagnostic.requestId === 'req_synthetic' && !JSON.stringify(error).includes('secret must never appear'));
  }
  await assert.rejects(checkedFetch('模型列表', 'https://example.invalid', {}, async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); }), code('network_error'));
  assert.equal(normalizeError({ code:'CERT_HAS_EXPIRED' }, '授权').diagnostic.code, 'certificate_error');
});
test('concurrent expiry refresh rotates once; transient failure preserves registration', async () => {
  const record = base(); record.expiresAt = 1;
  const vault = new MemoryVault({ active: record.key, registrations: [record] }); let calls=0;
  const auth = new ChatGPTAuth(vault, () => 'host', () => true, () => {}, async (_url, init) => { calls++; const form = new URLSearchParams(init.body); assert.equal(form.get('client_id'), record.clientId); assert.equal(form.has('scope'), false); return response({ access_token:'rotated-access', refresh_token:'rotated-refresh', expires_in:3600 }); });
  const results = await Promise.all([auth.credential(),auth.credential(),auth.credential()]); assert.equal(calls,1); assert.ok(results.every(r => r.refreshToken === 'rotated-refresh'));
  assert.throws(() => mergeTokens(base(), { access_token:'x', expires_in:3600 }, false), code('invalid_token_response'));
  vault.data.registrations[0].expiresAt=1;
  const offline = new ChatGPTAuth(vault, () => 'host', () => true, () => {}, async () => { throw new TypeError('offline'); });
  await assert.rejects(offline.credential(), code('network_error')); assert.equal(vault.data.registrations[0].clientId, record.clientId); assert.equal(vault.data.registrations[0].refreshToken,'rotated-refresh');
});
const stream = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), { headers:{'content-type':'text/event-stream','x-request-id':'req_stream'} });
test('stream requires completed event; rejects failure, incomplete, malformed, truncation', async () => {
  const delta = { type:'response.output_text.delta',delta:'Hello, world!' };
  assert.equal((await readResponseStream(stream([delta,{type:'response.completed',response:{status:'completed'}}]))).text,'Hello, world!');
  await assert.rejects(readResponseStream(stream([delta])),code('stream_interrupted'));
  await assert.rejects(readResponseStream(stream([delta,{type:'response.incomplete'}])),code('response_incomplete'));
  await assert.rejects(readResponseStream(stream([{type:'response.failed',response:{error:{code:'insufficient_quota'}}}])),code('insufficient_quota'));
  await assert.rejects(readResponseStream(new Response('data: {broken}\n\n',{headers:{'content-type':'text/event-stream'}})),code('invalid_event'));
});
test('account model catalog and actual Responses request use documented protocol', async () => {
  assert.throws(() => parseModels({data:[{id:'guessed-model'}]}),code('invalid_catalog'));
  assert.deepEqual(parseModels({models:[{slug:'actual-slug',display_name:'Display',visibility:'list'},{slug:'hidden',display_name:'Hidden',visibility:'hide'}]}),[{id:'actual-slug',name:'Display'}]);
  const record=base(), auth = new ChatGPTAuth(new MemoryVault({active:record.key,registrations:[record]}),()=> 'host',()=>true,()=>{});
  const inference = new ChatGPTInference(auth,async (url,init) => {
    if (String(url).endsWith('/models')) return response({models:[{slug:'actual-slug',display_name:'Display',visibility:'list'}]});
    const body=JSON.parse(init.body); assert.deepEqual(Object.keys(body).sort(),['input','instructions','model','store','stream']); assert.equal(body.store,false); assert.equal(body.stream,true); assert.equal(body.model,'actual-slug');
    return stream([{type:'response.output_text.delta',delta:'ok'},{type:'response.completed',response:{status:'completed'}}]);
  });
  assert.equal((await inference.text('actual-slug','Be brief','Synthetic test')).text,'ok');
});
test('OS-protected vault: large synthetic token, restart, encrypted bytes, process lock', async () => {
  const dir = await mkdtemp(join(tmpdir(),'zhaolian-ai-vault-')), service=`Zhaolian-synthetic-test-${randomUUID()}`;
  try {
    const vault = new ProtectedVault(dir, service), record = base(); record.accessToken = 'synthetic-private-token'.repeat(1000);
    await vault.transact(async(data,save)=>{data.registrations.push(record);data.active=record.key;await save();});
    assert.equal((await readFile(join(dir,'siwc.credentials.sqlite'))).includes(Buffer.from('synthetic-private-token')),false);
    await new ProtectedVault(dir,service).transact(async data=>assert.equal(data.registrations[0].accessToken.length,record.accessToken.length));
    const childCode = `import { ProtectedVault } from './dist/server/ai-vault.js'; const v=new ProtectedVault(process.argv[1],process.argv[2]); await v.transact(async(d,save)=>{d.registrations[0].label=String(Number(d.registrations[0].label||0)+1);await new Promise(r=>setTimeout(r,100));await save();});`;
    await vault.transact(async(d,save)=>{d.registrations[0].label='0';await save();});
    await Promise.all([1,2,3].map(()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',childCode,dir,service],{cwd:resolvePath(),windowsHide:true,stdio:'ignore'});child.on('exit',code=>code===0?resolve():reject(new Error('Synthetic lock child failed')));} )));
    await vault.transact(async data=>assert.equal(data.registrations[0].label,'3'));
  } finally { new Entry(service,'siwc-encryption-key-v1').deletePassword(); if(!resolve(dir).startsWith(resolve(tmpdir()))) throw new Error('Invalid test path'); await rm(dir,{recursive:true,force:true}); }
});
function resolvePath(){return resolve('.');}
test('encrypted SQLite vault commits under the real Windows user-data root', async () => {
  if (!process.env.LOCALAPPDATA) return;
  const root = resolve(join(process.env.LOCALAPPDATA, '个人成长平台', 'auth'));
  const unique = randomUUID(), dir = resolve(join(root, `synthetic-vault-${unique}`)), service = `Zhaolian-synthetic-${unique}`;
  if (!dir.startsWith(root + '\\')) throw new Error('Refusing to use an unverified probe path.');
  try {
    const vault = new ProtectedVault(dir, service);
    await vault.transact(async (data, save) => { data.registrations.push(base()); await save(); });
    await new ProtectedVault(dir, service).transact(async data => assert.equal(data.registrations[0].clientId, 'oaiapp_synthetic'));
  } finally {
    try { new Entry(service, 'siwc-encryption-key-v1').deletePassword(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
