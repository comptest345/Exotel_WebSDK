const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const recordings = require('./exotel-recordings');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Env vars ──────────────────────────────────────────────────────
// NOTE: mum1 base URL works for ALL accounts (India + Singapore).
// Do NOT change this unless Exotel explicitly tells you otherwise.
const BASE            = 'https://integrationscore.mum1.exotel.com/v2/integrations';
const CUSTOMER_ID     = process.env.EXOTEL_CUSTOMER_ID;
const CUSTOMER_SECRET = process.env.EXOTEL_CUSTOMER_SECRET;
const ACCOUNT_SID     = process.env.EXOTEL_ACCOUNT_SID;
const API_KEY         = process.env.EXOTEL_API_KEY;
const API_TOKEN       = process.env.EXOTEL_API_TOKEN;
const DOMAIN          = process.env.EXOTEL_DOMAIN || 'singapore';
const APP_ID          = process.env.EXOTEL_APP_ID;
const APP_SECRET      = process.env.EXOTEL_APP_SECRET;
const VIRTUAL_NUMBER  = process.env.EXOTEL_VIRTUAL_NUMBER || '';

const BX24_WEBHOOK    = process.env.BX24_WEBHOOK_URL || '';
const BX24_USER_ID    = process.env.BX24_USER_ID || '1';
const RENDER_URL      = process.env.RENDER_URL || 'https://exotel-websdk.onrender.com';

// outboundCallMap: exotelCallSid → { bx24CallId, agentBx24UserId, agentEmail, toNumber, ts }
// Populated when an outbound call is placed; used by /call-callback to finish it properly.
const outboundCallMap = {};

const isIndia = /mum|in1|india/i.test(DOMAIN);
const SIP_FB  = isIndia ? 'voip.in1.exotel.com' : 'voip.sgp1.exotel.com';

// ── In-memory state ───────────────────────────────────────────────
const pendingCallMap   = {};
const pendingInboundMap = {};
const inboundClaimMap   = {};
let   pollCount = 0;

// ── SSE client registry ───────────────────────────────────────────
const sseClients = {};

function ssePush(email, event, data) {
  const key = (email || '').toLowerCase();
  const client = sseClients[key];
  if (!client) return false;
  try {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    console.log(`[SSE] Pushed '${event}' to ${key}`);
    return true;
  } catch (e) {
    console.warn(`[SSE] Push failed for ${key}:`, e.message);
    delete sseClients[key];
    return false;
  }
}

// ── Token cache ───────────────────────────────────────────────────
let _appTokenCache = null;
let _appTokenExp   = 0;

// ── Token helpers ─────────────────────────────────────────────────
async function getCustomerToken() {
  const res  = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: CUSTOMER_ID, Secret: CUSTOMER_SECRET, Entity: 'customer' })
  });
  const raw  = await res.text();
  let data;
  try { data = JSON.parse(raw); }
  catch (_) {
    console.error('[Token] Customer token raw response (HTTP ' + res.status + '):', raw.slice(0, 300));
    throw new Error('Customer token: invalid JSON from Exotel — HTTP ' + res.status);
  }
  if (!res.ok) throw new Error('Customer token failed: ' + JSON.stringify(data));
  return data.Data;
}

async function getAppToken() {
  const now = Date.now();
  if (_appTokenCache && now < _appTokenExp - 60000) return _appTokenCache;
  const res  = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: APP_ID, Secret: APP_SECRET, Entity: 'app' })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`App token failed: ${JSON.stringify(data)}`);
  _appTokenCache = data.Data;
  try {
    const payload = JSON.parse(Buffer.from(data.Data.split('.')[1], 'base64').toString());
    _appTokenExp  = payload.exp * 1000;
  } catch (_) { _appTokenExp = now + 3500000; }
  console.log('[Token] App token refreshed');
  return _appTokenCache;
}

// ── BX24 REST helper ──────────────────────────────────────────────
async function bx24Call(method, params) {
  if (!BX24_WEBHOOK) throw new Error('BX24_WEBHOOK_URL not set');
  const url = `${BX24_WEBHOOK}${method}.json`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params)
  });
  const data = await res.json();
  if (data.error) throw new Error(`BX24 ${method}: ${data.error} — ${data.error_description}`);
  return data.result;
}

// ── Fetch all usermapping pages ───────────────────────────────────
async function fetchAllMappedUsers(at) {
  let allUsers = [], seen = new Set(), nextKey = null, page = 0;
  do {
    const url = nextKey ? `${BASE}/usermapping?next_key=${nextKey}` : `${BASE}/usermapping`;
    const r   = await fetch(url, { headers: { 'Authorization': at } });
    const d   = await r.json();
    const users = (d.Data && d.Data.Users) || (Array.isArray(d.Data) ? d.Data : []);
    users.filter(u => !seen.has(u.AppUserId)).forEach(u => { seen.add(u.AppUserId); allUsers.push(u); });
    nextKey = (d.Data && d.Data.NextKey) || null;
    if (++page > 20) break;
  } while (nextKey);
  return allUsers;
}

// ── usermapping live user map — PRIMARY credential source ────────
let _mapCache    = null;
let _mapCacheExp = 0;
let _mapInflight = null;

async function getMappedUserMap(force) {
  const now = Date.now();
  if (!force && _mapCache && now < _mapCacheExp) return _mapCache;
  if (_mapInflight) return _mapInflight;

  _mapInflight = (async () => {
    try {
      const at    = await getAppToken();
      const users = await fetchAllMappedUsers(at);
      const map   = new Map();
      users.forEach(u => { if (u.Email) map.set(u.Email.toLowerCase(), u); });
      _mapCache    = map;
      _mapCacheExp = Date.now() + 60000;
      console.log(`[Mapping] Cache refreshed: ${map.size} user(s)`);
      return map;
    } finally {
      _mapInflight = null;
    }
  })();
  return _mapInflight;
}

function extractMappingCredentials(u) {
  if (!u || !u.SipId) return [];
  return [{
    sip_id:         u.SipId,
    sip_secret:     u.SipSecret || '',
    virtual_number: u.VirtualNumber || VIRTUAL_NUMBER || ''
  }];
}

// ── CCM Users API — kept only as an emergency fallback ────────────
function getCcmBaseUrl() {
  return isIndia
    ? `https://ccm-api.in.exotel.com/v2/accounts/${ACCOUNT_SID}/users`
    : `https://ccm-api.exotel.com/v2/accounts/${ACCOUNT_SID}/users`;
}

function getCcmBasicAuth() {
  return 'Basic ' + Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
}

let _ccmCache    = null;
let _ccmCacheExp = 0;
let _ccmInflight = null;

async function getCcmUserMap() {
  const now = Date.now();
  if (_ccmCache && now < _ccmCacheExp) return _ccmCache;
  if (_ccmInflight) return _ccmInflight;

  _ccmInflight = (async () => {
    try {
      const users = await fetchAllCcmUsers();
      const map   = new Map();
      users.forEach(u => {
        if (u.email) map.set(u.email.toLowerCase(), u);
      });
      _ccmCache    = map;
      _ccmCacheExp = Date.now() + 60000;
      console.log(`[CCM] Cache refreshed: ${map.size} users`);
      return map;
    } finally {
      _ccmInflight = null;
    }
  })();
  return _ccmInflight;
}

async function fetchAllCcmUsers() {
  const users = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const url = `${getCcmBaseUrl()}?fields=devices&limit=${limit}&offset=${offset}`;
    const res  = await fetch(url, { headers: { 'Authorization': getCcmBasicAuth() } });
    const raw  = await res.text();
    if (!res.ok) throw new Error(`CCM Users API HTTP ${res.status}: ${raw.slice(0, 200)}`);
    const data = JSON.parse(raw);
    const rawList = Array.isArray(data) ? data : (data.response || data.data || []);
    console.log('[CCM] Raw sample (first user):', JSON.stringify(rawList[0] || {}).slice(0, 400));
    const page = rawList.map(r => r.data || r).filter(u => u && u.email);
    users.push(...page);
    const meta = data.metadata || {};
    if (users.length >= (meta.total || users.length) || page.length < limit) break;
    offset += limit;
  }
  await Promise.all(users.map(async u => {
    try {
      const url = `${getCcmBaseUrl()}/${u.id}?fields=devices`;
      const res  = await fetch(url, { headers: { 'Authorization': getCcmBasicAuth() } });
      if (!res.ok) return;
      const raw  = await res.text();
      const body = JSON.parse(raw);
      const userData   = body.data || body;
      const liveDevs   = userData.devices;
      if (Array.isArray(liveDevs) && liveDevs.length > 0) {
        u.devices = liveDevs;
      }
      if (!u.sip_secret && userData.sip_secret) u.sip_secret = userData.sip_secret;
    } catch (e) {
      console.warn(`[CCM] Could not fetch individual user ${u.id} (${u.email}):`, e.message);
    }
  }));
  return users;
}

async function fetchCcmUserById(ccmId) {
  try {
    const url = `${getCcmBaseUrl()}/${ccmId}?fields=devices`;
    const res  = await fetch(url, { headers: { 'Authorization': getCcmBasicAuth() } });
    if (!res.ok) return null;
    const body = await res.json();
    return body.data || body;
  } catch (e) {
    return null;
  }
}

function extractSipCredentials(ccmUser) {
  const devices = (ccmUser.devices || []).filter(d => d.type === 'sip' && d.verified !== false);
  if (devices.length === 0) {
    const sipId     = ccmUser.contact_uri || ccmUser.sip_id || ccmUser.sipId || ccmUser.SipId || '';
    const sipSecret = ccmUser.sip_secret  || ccmUser.sipSecret || ccmUser.SipSecret || '';
    const vn        = ccmUser.virtual_number || ccmUser.VirtualNumber || VIRTUAL_NUMBER || '';
    if (sipId) return [{ sip_id: sipId, sip_secret: sipSecret, virtual_number: vn }];
    return [];
  }
  const userSecret = ccmUser.sip_secret || ccmUser.sipSecret || ccmUser.SipSecret || '';
  return devices.map(d => {
    const sipId     = d.contact_uri || d.sip_id || d.SipId || '';
    const sipSecret = d.sip_secret  || d.SipSecret || userSecret || '';
    const vn        = d.virtual_number || d.VirtualNumber || ccmUser.virtual_number || VIRTUAL_NUMBER || '';
    return { sip_id: sipId, sip_secret: sipSecret, virtual_number: vn };
  }).filter(d => d.sip_id);
}

async function autoRegisterUser(email, name, appToken) {
  try {
    const allMapped = await fetchAllMappedUsers(appToken);
    const exists = allMapped.find(u => u.Email && u.Email.toLowerCase() === email.toLowerCase());
    if (exists) return exists;
    const ccmMap  = await getCcmUserMap();
    const ccmUser = ccmMap.get(email.toLowerCase());
    const creds   = ccmUser ? extractSipCredentials(ccmUser) : [];
    const newId   = creds.length > 0
      ? creds[0].sip_id.replace(/^sip:/i, '')
      : (ccmUser ? ccmUser.id : ('auto_' + Date.now()));
    const payload = [{
      AppUserId:        newId,
      AppUsername:      name || email,
      Email:            email,
      ExotelAccountSid: ACCOUNT_SID,
      ExotelUserName:   name || email,
      AgentNumber:      '',
      VirtualNumber:    VIRTUAL_NUMBER
    }];
    const addRes  = await fetch(`${BASE}/usermapping`, {
      method:  'POST',
      headers: { 'Authorization': appToken, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const addData = await addRes.json();
    console.log(`[AutoRegister] Created usermapping for ${email} → AppUserId=${newId}:`, JSON.stringify(addData));
    const refreshed = await fetchAllMappedUsers(appToken);
    return refreshed.find(u => u.Email && u.Email.toLowerCase() === email.toLowerCase()) || null;
  } catch (e) {
    console.error(`[AutoRegister] Failed for ${email}:`, e.message);
    return null;
  }
}

async function syncUsers() {
  console.log('[Sync] Refreshing usermapping cache (read-only)...');
  try {
    const map = await getMappedUserMap(true);
    console.log(`[Sync] Cache refreshed: ${map.size} user(s) in usermapping`);
    return { refreshed: true, total_mapped: map.size };
  } catch (e) {
    console.error('[Sync] Error:', e.message);
    return { error: e.message };
  }
}

async function legacySyncUsersFromCcm() {
  console.log('[Sync] Starting CCM sync...');
  try {
    let ccmUsers;
    try {
      ccmUsers = await fetchAllCcmUsers();
    } catch (e) {
      console.error('[Sync] CCM Users API fetch failed — aborting to protect usermapping:', e.message);
      return { error: e.message };
    }
    if (ccmUsers.length === 0) {
      console.warn('[Sync] CCM returned 0 users — skipping to protect usermapping');
      return { skipped: true, reason: 'ccm_empty' };
    }
    console.log(`[Sync] CCM co-workers: ${ccmUsers.length}`);
    const ccmByEmail = {};
    ccmUsers.forEach(u => { if (u.email) ccmByEmail[u.email.toLowerCase()] = u; });
    const at        = await getAppToken();
    const allMapped = await fetchAllMappedUsers(at);
    const mapByEmail = {};
    allMapped.forEach(u => { if (u.Email) mapByEmail[u.Email.toLowerCase()] = u; });
    console.log(`[Sync] Mapped users: ${allMapped.length}`);
    function correctAppUserId(ccmUser) {
      const creds = extractSipCredentials(ccmUser);
      if (creds.length > 0) return creds[0].sip_id.replace(/^sip:/i, '');
      return ccmUser.id;
    }
    const toMigrate = ccmUsers.filter(u => {
      if (!u.email) return false;
      const existing = mapByEmail[u.email.toLowerCase()];
      if (!existing) return false;
      return existing.AppUserId !== correctAppUserId(u);
    });
    for (const u of toMigrate) {
      const existing   = mapByEmail[u.email.toLowerCase()];
      const newId      = correctAppUserId(u);
      const name       = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
      console.log(`[Sync] Migrating ${u.email}: AppUserId ${existing.AppUserId} → ${newId}`);
      for (const key of [existing.ExotelUserId, existing.AppUserId].filter(Boolean)) {
        const r = await fetch(`${BASE}/usermapping/${encodeURIComponent(key)}`, {
          method: 'DELETE', headers: { 'Authorization': at }
        });
        const rb = await r.text();
        if (r.ok) { console.log(`[Sync] Deleted old mapping key=${key}`); break; }
        console.log(`[Sync] Delete key=${key} HTTP ${r.status}: ${rb.slice(0, 80)}`);
      }
      const addRes  = await fetch(`${BASE}/usermapping`, {
        method:  'POST',
        headers: { 'Authorization': at, 'Content-Type': 'application/json' },
        body:    JSON.stringify([{
          AppUserId:        newId,
          AppUsername:      name,
          Email:            u.email,
          ExotelAccountSid: ACCOUNT_SID,
          ExotelUserName:   name,
          AgentNumber:      '',
          VirtualNumber:    VIRTUAL_NUMBER
        }])
      });
      const addData = await addRes.json();
      console.log(`[Sync] Migration result for ${u.email}:`, JSON.stringify(addData).slice(0, 200));
    }
    const toAdd = ccmUsers.filter(u => u.email && !mapByEmail[u.email.toLowerCase()]);
    if (toAdd.length > 0) {
      console.log(`[Sync] Adding ${toAdd.length}: ${toAdd.map(u => u.email).join(', ')}`);
      const payload = toAdd.map(u => ({
        AppUserId:        correctAppUserId(u),
        AppUsername:      [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
        Email:            u.email,
        ExotelAccountSid: ACCOUNT_SID,
        ExotelUserName:   [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
        AgentNumber:      '',
        VirtualNumber:    VIRTUAL_NUMBER
      }));
      const addRes  = await fetch(`${BASE}/usermapping`, {
        method:  'POST',
        headers: { 'Authorization': at, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
      const addData = await addRes.json();
      console.log('[Sync] Add result:', JSON.stringify(addData));
    }
    const toRemove = allMapped.filter(u => u.Email && !ccmByEmail[u.Email.toLowerCase()]);
    for (const u of toRemove) {
      console.log(`[Sync] Removing ${u.Email} (AppUserId=${u.AppUserId} ExotelUserId=${u.ExotelUserId || 'n/a'})`);
      const sipUsername = u.SipId ? u.SipId.replace(/^sip:/, '') : null;
      const candidates = [u.ExotelUserId, u.AppUserId, sipUsername].filter(Boolean);
      let deleted = false;
      for (const key of candidates) {
        const delRes = await fetch(`${BASE}/usermapping/${encodeURIComponent(key)}`, {
          method: 'DELETE', headers: { 'Authorization': at }
        });
        const body = await delRes.text();
        if (delRes.ok) {
          console.log(`[Sync] Removed ${u.Email} using key=${key}`);
          deleted = true;
          break;
        }
        console.log(`[Sync] Delete key=${key} HTTP ${delRes.status}: ${body.slice(0, 120)}`);
      }
      if (!deleted) {
        console.warn(`[Sync] Could not remove ${u.Email} — all keys failed (${candidates.join(', ')}). ` +
          'Delete manually via Exotel dashboard or DELETE /delete-user/:appUserId.');
      }
    }
    _ccmCache = null;
    console.log(`[Sync] Done. Added=${toAdd.length} Removed=${toRemove.length} CCM=${ccmUsers.length} Mapped=${allMapped.length}`);
    return { added: toAdd.length, removed: toRemove.length, total_ccm: ccmUsers.length, total_mapped: allMapped.length };
  } catch (e) {
    console.error('[Sync] Error:', e.message);
    return { error: e.message };
  }
}

// ── Static HTML routes ────────────────────────────────────────────
app.all('/popup.html',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'popup.html')));
app.all('/background.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'background.html')));
app.get('/crmBundle.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'target', 'crmBundle.js'));
});
app.get('/crmBundle.js.LICENSE.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'public', 'target', 'crmBundle.js.LICENSE.txt'));
});

// ── Install ───────────────────────────────────────────────────────
app.all('/install', (req, res) => {
  console.log('[Install] Called');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="//api.bitrix24.com/api/v1/"></script></head><body><p id="msg">Installing Exotel Dialer...</p><script>BX24.init(function(){BX24.callMethod('placement.bind',{PLACEMENT:'CRM_ACTIVITY_SIDEBAR',HANDLER:'https://exotel-websdk.onrender.com/popup.html',TITLE:'Exotel Dialer'},function(r1){BX24.callMethod('telephony.externalLine.add',{LINE_NAME:'Exotel',APP_ID:BX24.getAuth().client_id},function(r2){BX24.callMethod('event.bind',{EVENT:'OnExternalCallStart',HANDLER:'https://exotel-websdk.onrender.com/bx24-call-start'},function(r3){document.getElementById('msg').innerText='\u2705 Installed!';BX24.installFinish();});});});});<\/script></body></html>`);
});

// ── BX24 outbound call trigger ────────────────────────────────────
const bx24EmailCache = {};

const bx24AgentIdCache = {};
async function getBx24UserEmail_toBx24Id(email) {
  if (!email) return null;
  const key = email.toLowerCase();
  if (bx24AgentIdCache[key]) return bx24AgentIdCache[key];
  if (!BX24_WEBHOOK) return null;
  try {
    const res  = await fetch(`${BX24_WEBHOOK}user.get.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { EMAIL: email } })
    });
    const data = await res.json();
    const id   = (data.result && data.result[0] && String(data.result[0].ID)) || null;
    if (id) { bx24AgentIdCache[key] = id; console.log(`[BX24] agent email ${email} → ID ${id}`); }
    return id;
  } catch (e) {
    console.warn('[BX24] agent ID lookup failed:', e.message);
    return null;
  }
}

async function getBx24UserEmail(bx24UserId) {
  if (bx24EmailCache[bx24UserId]) return bx24EmailCache[bx24UserId];
  if (!BX24_WEBHOOK) return null;
  try {
    const res  = await fetch(`${BX24_WEBHOOK}user.get.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ID: bx24UserId })
    });
    const data = await res.json();
    const email = (data.result && data.result[0] && data.result[0].EMAIL) || null;
    if (email) {
      bx24EmailCache[bx24UserId] = email;
      console.log(`[BX24] user ${bx24UserId} → ${email}`);
    }
    return email;
  } catch (e) {
    console.warn('[BX24] email lookup failed:', e.message);
    return null;
  }
}

// ── Outbound call with recording ──────────────────────────────────
app.post('/make-outbound-call', async (req, res) => {
  const { toNumber, agentEmail } = req.body || {};
  if (!toNumber || !agentEmail)
    return res.status(400).json({ error: 'toNumber and agentEmail required' });

  try {
    const mapped = await getMappedUserMap();
    const user   = mapped.get(agentEmail.toLowerCase());
    if (!user) return res.status(404).json({ error: `No usermapping for ${agentEmail}` });

    const appUserId = String(user.AppUserId || '');
    const sipUri    = user.SipId || '';

    // CCM v2 calls API — correct endpoint for agent+customer outbound calls.
    // Auth: Basic API_KEY:API_TOKEN (same as the users API).
    const CCM_CALLS_URL = isIndia
      ? `https://ccm-api.in.exotel.com/v2/accounts/${ACCOUNT_SID}/calls`
      : `https://ccm-api.exotel.com/v2/accounts/${ACCOUNT_SID}/calls`;

    const payload = {
      from: sipUri
        ? { user_contact_uri: sipUri }
        : { user_id: appUserId },
      to: { customer_contact_uri: toNumber },
      virtual_number: VIRTUAL_NUMBER,
      recording: true,   // Exotel confirmed: must be true in API call (Ref: support email Jun 21)
      status_callback: [{ url: `${RENDER_URL}/call-callback`, method: 'POST' }]
    };

    console.log(`[OutboundCall] ${agentEmail} → ${toNumber} record:true`);
    console.log(`[OutboundCall] POST ${CCM_CALLS_URL} payload:`, JSON.stringify(payload));

    const callRes = await fetch(CCM_CALLS_URL, {
      method:  'POST',
      headers: { 'Authorization': getCcmBasicAuth(), 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const rawBody = await callRes.text();
    console.log(`[OutboundCall] Exotel raw response (${callRes.status}): ${rawBody}`);
    let callData;
    try { callData = JSON.parse(rawBody); }
    catch (_) { callData = { raw: rawBody }; }
    if (!callRes.ok) throw new Error(`Exotel ${callRes.status}: ${rawBody}`);

    console.log(`[OutboundCall] Placed: ${JSON.stringify(callData)}`);

    // CCM v2 response: { response: { data: { call_sid: "..." } } }
    const exotelCallSid = callData?.response?.data?.call_sid || callData?.response?.call_details?.sid || callData?.Data?.CallSid || callData?.CallSid || null;
    if (BX24_WEBHOOK && exotelCallSid) {
      // Dedup: check if we already registered a BX24 call for this agent+number combo
      const dupKey = agentEmail.toLowerCase() + '|' + toNumber;
      const recentDup = Object.values(outboundCallMap).find(
        v => (v.agentEmail || '').toLowerCase() + '|' + v.toNumber === dupKey && (Date.now() - v.ts) < 30000
      );
      if (recentDup) {
        console.log(`[OutboundCall] SKIP BX24 register — duplicate for ${dupKey} within 30s`);
        res.json({ ok: true, data: callData });
        return;
      }
      try {
        const agentBx24Id = await getBx24UserEmail_toBx24Id(agentEmail);
        const r = await bx24Call('telephony.externalcall.register', {
          USER_ID:         agentBx24Id || BX24_USER_ID,
          PHONE_NUMBER:    toNumber,
          TYPE:            1,
          CALL_START_DATE: new Date().toISOString(),
          CRM_CREATE:      true,
          LINE_NUMBER:     VIRTUAL_NUMBER || '',
          SHOW:            0
        });
        const bx24CallId = (r && r.CALL_ID) || exotelCallSid;
        outboundCallMap[exotelCallSid] = {
          bx24CallId,
          agentBx24UserId: agentBx24Id || BX24_USER_ID,
          agentEmail,
          toNumber,
          ts: Date.now()
        };
        console.log(`[OutboundCall] BX24 registered: CALL_ID=${bx24CallId} for exotel sid=${exotelCallSid}`);
        // Register with recording poller so it knows the bx24CallId without a phone lookup
        recordings.registerCall(exotelCallSid, {
          bx24CallId,
          agentBx24Id: agentBx24Id || BX24_USER_ID,
          agentEmail,
          phone:     toNumber,
          direction: 'outbound'
        });
      } catch (e) {
        console.warn('[OutboundCall] BX24 register failed (non-fatal):', e.message);
      }
    }

    res.json({ ok: true, data: callData });
  } catch (e) {
    console.error('[OutboundCall] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/bx24-call-start', async (req, res) => {
  console.log('[BX24-CallStart] raw body:', JSON.stringify(req.body));
  try {
    const d    = (typeof req.body.data === 'object' && req.body.data) ? req.body.data : req.body;
    const auth = (typeof req.body.auth === 'object' && req.body.auth) ? req.body.auth : null;
    const bx24UserId = String(d.USER_ID || d['data[USER_ID]'] || BX24_USER_ID);
    const number     = (d.PHONE_NUMBER_INTERNATIONAL || d.PHONE_NUMBER || d['data[PHONE_NUMBER]'] || '').trim();
    const callId     = d.CALL_ID || d['data[CALL_ID]'] || ('ext_' + Date.now());
    if (!number) return res.json({ status: 'ignored', reason: 'no_number' });

    // Prefer fresh access_token from event auth over static webhook
    let email = null;
    if (auth && auth.access_token && auth.client_endpoint) {
      try {
        const r = await fetch(`${auth.client_endpoint}user.current.json`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ auth: auth.access_token })
        });
        const u = await r.json();
        email = (u.result && u.result.EMAIL) || null;
        if (email) {
          bx24EmailCache[bx24UserId] = email; // also warm the cache
          console.log(`[BX24-CallStart] Resolved email from event auth: ${email}`);
        }
      } catch (e) {
        console.warn('[BX24-CallStart] auth token lookup failed, falling back to webhook:', e.message);
      }
    }

    // Fallback: use static BX24 webhook
    if (!email) email = await getBx24UserEmail(bx24UserId);

    if (!email) {
      console.warn(`[BX24-CallStart] Could not resolve email for userId ${bx24UserId} — queuing by userId`);
      pendingCallMap['bx24_' + bx24UserId] = { number, callId, ts: Date.now() };
      return res.json({ status: 'queued_no_email' });
    }

    const key    = email.toLowerCase();
    let pushed   = ssePush(key, 'outbound_call', { number, callId });
if (!pushed && bx24UserId) {
  pushed = ssePush('bx24_' + bx24UserId, 'outbound_call', { number, callId });
  console.log(`[BX24-CallStart] Tried bx24_ key fallback: ${pushed ? 'hit' : 'miss'}`);
}
    if (!pushed) pendingCallMap[key] = { number, callId, ts: Date.now() };

    res.json({ status: 'ok', email, pushed });
  } catch (e) {
    console.error('[BX24-CallStart]', e.message);
    res.json({ status: 'error', message: e.message });
  }
});

// ── Pending call poll ─────────────────────────────────────────────
app.get('/pending-call', (req, res) => {
  pollCount++;
  if (pollCount % 30 === 1) console.log('[Poll] /pending-call hit #' + pollCount);

  const email      = (req.query.email      || '').toLowerCase();
  const bx24UserId = req.query.bx24_user_id || '';

  const key   = email || (bx24UserId ? 'bx24_' + bx24UserId : null);
  if (!key) return res.json({ pending: false, reason: 'no_key' });

  const entry = pendingCallMap[key];
  if (entry && (Date.now() - entry.ts) < 60000) {
    delete pendingCallMap[key];
    console.log(`[Poll] Delivering outbound call to ${key}: ${entry.number}`);
    res.json({ pending: true, type: 'outbound', number: entry.number, callId: entry.callId });
  } else {
    if (entry) delete pendingCallMap[key];
    const inbound = Object.entries(pendingInboundMap).find(([sid, d]) => {
      if (inboundClaimMap[sid]) return false;
      if ((Date.now() - d.ts) >= 60000) return false;
      const lock = d.phoneKey ? callerLocks.get(d.phoneKey) : null;
      if (lock && lock.rejectedBy.has(email)) return false;
      return true;
    });
    if (inbound) {
      const [sid, d] = inbound;
      return res.json({ pending: true, type: 'inbound', from: d.from, callSid: sid });
    }
    const claimed = Object.entries(pendingInboundMap).find(
      ([sid, d]) => !!inboundClaimMap[sid] && (Date.now() - d.ts) < 60000
    );
    if (claimed) {
      const [sid] = claimed;
      return res.json({ pending: false, type: 'claimed', callSid: sid, claimedBy: inboundClaimMap[sid].email });
    }
    res.json({ pending: false });
  }
});

// ── SSE subscription endpoint ────────────────────────────────────
app.get('/events', (req, res) => {
  const email = (req.query.email || '').toLowerCase();
  const bx24UserId = req.query.bx24_user_id || '';
if (email) {
    // Tear down the OLD connection for this email (if any) before registering the new one
    if (sseClients[email]) {
      clearInterval(sseClients[email]._hb);          // clear old heartbeat
      try { sseClients[email].end(); } catch(_) {}   // close old socket
    }
    sseClients[email] = res;
  }
  // ALSO register under bx24_ key so /bx24-call-start can find it before email resolves
  if (bx24UserId) {
    const bx24Key = 'bx24_' + bx24UserId;
    sseClients[bx24Key] = res; // same res object, two keys
  }
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  // ── BUG FIX: removed the duplicate sseClients[email].end() block that was
  //    killing every new SSE connection immediately after flushHeaders(). ──

  console.log(`[SSE] Agent connected: ${email} (active: ${Object.keys(sseClients).length})`);

  setAgentBusy(email, false);

  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(hb); }
  }, 20000);
  res._hb = hb; // store so it can be cleared if this agent reconnects

  const entry = pendingCallMap[email];
  if (entry && (Date.now() - entry.ts) < 60000) {
    delete pendingCallMap[email];
    console.log(`[SSE] Flushing queued outbound call to ${email}: ${entry.number}`);
    ssePush(email, 'outbound_call', { number: entry.number, callId: entry.callId });
  }

  for (const [sid, callData] of Object.entries(pendingInboundMap)) {
    if (inboundClaimMap[sid]) continue;
    const lock = callData.phoneKey ? callerLocks.get(callData.phoneKey) : null;
    if (lock && lock.claimedBy) continue;
    if (lock && lock.rejectedBy.has(email)) continue;
    if ((Date.now() - callData.ts) >= 60000) continue;
    if (ssePush(email, 'inbound_call', { from: callData.from, callSid: sid })) {
      console.log(`[SSE] Flushed pending inbound call ${sid} to reconnected agent ${email}`);
    }
  }

  req.on('close', () => {
    clearInterval(hb);
    if (sseClients[email] === res) {
      delete sseClients[email];
      console.log(`[SSE] Agent disconnected: ${email}`);
    }
  });
});

// ── Claimed SIDs registry ─────────────────────────────────────────────────
const claimedSids = new Set();

// ── Caller-based call lock ─────────────────────────────────────────────────
const callerLocks = new Map();
const LOCK_TTL_MS  = 90 * 1000;
const recentHangups = new Map(); // phoneKey → timestamp of last terminal event
const HANGUP_COOLDOWN_MS = 10000; // suppress new inbounds for 10s after hangup

function normalizePhone(n) {
  const digits = String(n || '').replace(/\D/g, '');
  return digits.slice(-10) || String(n || '').trim().toLowerCase();
}

// ── Agent presence ────────────────────────────────────────────────
const agentStatus = new Map();

function setAgentBusy(email, busy) {
  const key = (email || '').toLowerCase();
  if (!key) return;
  agentStatus.set(key, { status: busy ? 'busy' : 'free', ts: Date.now() });
  console.log(`[Presence] ${key} → ${busy ? 'BUSY' : 'FREE'}`);
  // Note: no automatic re-notification on free — Exotel handles ringing.
}



// ── Incoming call (Exotel webhook) ────────────────────────────────
// ── BX24 lead deduplication helper ──────────────────────────────
// Checks if a lead with this phone already exists; creates one only if not.
// Uses crm.duplicate.findbycomm which searches across all CRM entities.
async function ensureBx24Lead(phone) {
  if (!BX24_WEBHOOK || !phone || phone === 'Unknown') return null;
  const normalized = phone.replace(/\D/g, '').slice(-10);
  try {
    // Search for existing contacts/leads with this phone
    const searchRes = await fetch(`${BX24_WEBHOOK}crm.duplicate.findbycomm.json`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'PHONE', values: [phone, normalized], entity_type: 'LEAD' })
    });
    const searchData = await searchRes.json();
    const existingIds = searchData.result && searchData.result.LEAD;
    if (existingIds && existingIds.length > 0) {
      console.log(`[Lead] Phone ${phone} already has lead(s): ${existingIds.join(',')} — skipping create`);
      return { existing: true, ids: existingIds };
    }
    // Also check CONTACT
    const contactRes = await fetch(`${BX24_WEBHOOK}crm.duplicate.findbycomm.json`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'PHONE', values: [phone, normalized], entity_type: 'CONTACT' })
    });
    const contactData = await contactRes.json();
    const contactIds  = contactData.result && contactData.result.CONTACT;
    if (contactIds && contactIds.length > 0) {
      console.log(`[Lead] Phone ${phone} already linked to contact(s): ${contactIds.join(',')} — skipping lead create`);
      return { existing: true, entity: 'CONTACT', ids: contactIds };
    }

    // No existing record — create a lead
    const r = await bx24Call('crm.lead.add', {
      fields: {
        TITLE:       `Incoming call — ${phone}`,
        PHONE:       [{ VALUE: phone, VALUE_TYPE: 'WORK' }],
        SOURCE_ID:   'CALL',
        SOURCE_DESCRIPTION: 'Inbound call via Exotel WebSDK',
        STATUS_ID:   'NEW'
      }
    });
    const leadId = r && r.result ? r.result : r;
    console.log(`[Lead] Created new lead ${leadId} for phone ${phone}`);
    return { created: true, leadId };
  } catch (e) {
    console.warn(`[Lead] ensureBx24Lead(${phone}) error:`, e.message);
    return null;
  }
}

app.all('/incoming-call', async (req, res) => {
  const p  = Object.assign({}, req.query, req.body);
  console.log('[Incoming]', JSON.stringify(p));
  const et = (p.EventType || p.Status || '').toLowerCase();
  if (['free','terminal','completed','busy','noanswer','terminated','failed'].includes(et)) return res.json({ status: 'ignored' });
  try {
    const from     = p.From || p.CallFrom || p.caller_id || p.CallerId || p.callerid || 'Unknown';
    const toNum    = p.To || p.DialWhomNumber || p.CallTo || VIRTUAL_NUMBER || 'Unknown';
    const rawSid   = p.CallSid || p.call_sid || p.ParentCallSid || p.DialCallSid || null;
    const phoneKey = normalizePhone(from);

    // Dedup: if this caller already has an active non-stale lock, skip re-broadcast
    let lock  = callerLocks.get(phoneKey);
    const stale = lock && (Date.now() - lock.ts > LOCK_TTL_MS) && !lock.claimedBy;
    if (!lock || stale) {
      lock = {
        sid:        rawSid || ('in_' + Date.now() + '_' + phoneKey),
        claimedBy:  null,
        rejectedBy: new Set(),
        ts:         Date.now()
      };
      callerLocks.set(phoneKey, lock);
    }
    const sid = lock.sid;

    if (lock.claimedBy || claimedSids.has(sid)) {
      console.log(`[Incoming] SKIP broadcast — ${sid} (from ${from}) already claimed by ${lock.claimedBy}`);
      return res.json({ status: 'already_claimed' });
    }

    pendingInboundMap[sid] = { from, to: toNum, ts: Date.now(), phoneKey };

    // Create BX24 lead immediately on inbound (deduped by phone number)
    if (BX24_WEBHOOK) {
      ensureBx24Lead(from).catch(e => console.warn('[Incoming] lead create (non-fatal):', e.message));
    }

    // Broadcast to ALL connected agents — Exotel decides who gets audio,
    // first agent to click Accept wins via /claim-call race.
    const allConnected = Object.keys(sseClients).filter(e => !e.startsWith('bx24_'));
    if (allConnected.length === 0) {
      console.log(`[Incoming] sid=${sid} from=${from} — no agents connected`);
      return res.json({ status: 'no_agents' });
    }

    let notified = 0;
    for (const agentEmail of allConnected) {
      if (ssePush(agentEmail, 'inbound_call', { from, callSid: sid })) notified++;
    }
    console.log(`[Incoming] sid=${sid} from=${from} → broadcast to ${notified}/${allConnected.length} agents`);

    res.json({ status: 'received' });
  } catch (e) { console.error('[Incoming]', e.message); res.json({ status: 'error', message: e.message }); }
});

// ── Inbound call claim ────────────────────────────────────────────
app.post('/claim-call', async (req, res) => {
  const { callSid, email, bx24UserId } = req.body;
  if (!callSid || !email) return res.status(400).json({ error: 'callSid and email required' });

  if (inboundClaimMap[callSid]) {
    const c = inboundClaimMap[callSid];
    console.log(`[Claim] REJECTED — ${callSid} already claimed by ${c.email}`);
    return res.json({ claimed: false, reason: 'already_claimed', claimedBy: c.email });
  }

  inboundClaimMap[callSid] = { email, bx24UserId: bx24UserId || null, bx24CallId: null, ts: Date.now() };
  claimedSids.add(callSid);
  console.log(`[Claim] ${email} claimed ${callSid}`);

  const callData = pendingInboundMap[callSid];
  if (callData && callData.phoneKey) {
    const lock = callerLocks.get(callData.phoneKey);
    if (lock) lock.claimedBy = email.toLowerCase();
  }

  setAgentBusy(email, true);

  let bx24CallId = callSid;
  if (BX24_WEBHOOK && callData) {
    try {
      const agentBx24Id = bx24UserId || BX24_USER_ID;
      const r = await bx24Call('telephony.externalcall.register', {
        USER_ID:         agentBx24Id,
        PHONE_NUMBER:    callData.from,
        TYPE:            2,
        CALL_START_DATE: new Date().toISOString(),
        CRM_CREATE:      true,
        LINE_NUMBER:     callData.to || VIRTUAL_NUMBER || '',
        SHOW:            0
      });
      bx24CallId = (r && r.CALL_ID) || callSid;
      inboundClaimMap[callSid].bx24CallId = bx24CallId;
      console.log(`[Claim] BX24 registered: CALL_ID=${bx24CallId} USER_ID=${agentBx24Id}`);
      // Register with recording poller
      recordings.registerCall(callSid, {
        bx24CallId,
        agentBx24Id,
        agentEmail:  email,
        phone:       callData.from,
        direction:   'inbound'
      });
    } catch (e) {
      console.warn('[Claim] BX24 register failed (non-fatal):', e.message);
    }
  }

  const claimerKey = email.toLowerCase();
  Object.keys(sseClients).forEach(agentEmail => {
    if (agentEmail !== claimerKey) {
      ssePush(agentEmail, 'call_dismissed', { callSid, reason: 'claimed_by_other', claimedBy: email });
    }
  });

  res.json({ claimed: true, bx24CallId });
});

// ── Agent-initiated hangup → terminate call on Exotel ────────────
app.post('/hangup', async (req, res) => {
  const { email, direction } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  // Find the active call SID for this agent
  let callSid = null;
  // Check outbound map first
  for (const [sid, d] of Object.entries(outboundCallMap)) {
    if (d.agentEmail && d.agentEmail.toLowerCase() === email.toLowerCase()) {
      callSid = sid; break;
    }
  }
  // Then check inbound claim map
  if (!callSid) {
    for (const [sid, d] of Object.entries(inboundClaimMap)) {
      if (d.email && d.email.toLowerCase() === email.toLowerCase()) {
        callSid = sid; break;
      }
    }
  }

  if (!callSid) {
    console.log(`[Hangup] No active callSid found for ${email} — SDK HangupCall should suffice`);
    return res.json({ ok: true, note: 'no_sid_found' });
  }

  const CCM_CALL_URL = isIndia
    ? `https://ccm-api.in.exotel.com/v2/accounts/${ACCOUNT_SID}/calls/${callSid}`
    : `https://ccm-api.exotel.com/v2/accounts/${ACCOUNT_SID}/calls/${callSid}`;

  try {
    const r = await fetch(CCM_CALL_URL, {
      method:  'DELETE',
      headers: { 'Authorization': getCcmBasicAuth() }
    });
    const body = await r.text();
    console.log(`[Hangup] DELETE ${CCM_CALL_URL} → ${r.status}: ${body.slice(0, 200)}`);
    res.json({ ok: true, callSid, status: r.status });
  } catch (e) {
    console.error('[Hangup] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Inbound call reject ───────────────────────────────────────────
app.post('/reject-call', (req, res) => {
  const { callSid, email } = req.body || {};
  if (!callSid || !email) return res.status(400).json({ error: 'callSid and email required' });
  const callData = pendingInboundMap[callSid];
  const lock = callData && callData.phoneKey ? callerLocks.get(callData.phoneKey) : null;
  if (lock) lock.rejectedBy.add(email.toLowerCase());
  setAgentBusy(email, false);
  console.log(`[Reject] ${email} declined ${callSid}`);
  // Exotel handles re-ringing other agents; no server-side round-robin needed.
  res.json({ ok: true });
});

// ── Call ended (Exotel webhook) ───────────────────────────────────
app.all('/call-callback', async (req, res) => {
  const p = Object.assign({}, req.query, req.body);
  console.log('[Callback]', JSON.stringify(p));
  try {
    const sid        = p.CallSid || p.call_sid || '';
    const callState  = (p.CallState || p.call_state || '').toLowerCase();
    const callDetail = (p.CallDetail || p.call_detail || '').toLowerCase();
    const duration   = parseInt(p.Duration || p.duration || '0');
    const status     = p.Status  || p.status  || 'completed';

    const isTerminal = callState === 'terminal' || callState === 'terminated' ||
                       status === 'completed' || status === 'terminated' || status === 'failed' ||
                       callDetail === 'terminal' || callDetail === 'completed' ||
                       (p.EndTime && String(p.EndTime).trim() !== '');
    if (!isTerminal) {
      console.log(`[Callback] SKIP mid-call webhook — CallState=${callState} CallDetail=${callDetail} sid=${sid}`);
      return res.json({ status: 'ignored_mid_call' });
    }

    if (sid && claimedSids.has('cb_done_' + sid)) {
      console.log(`[Callback] SKIP duplicate terminal webhook for sid=${sid}`);
      return res.json({ status: 'ignored_duplicate' });
    }
    if (sid) claimedSids.add('cb_done_' + sid);

    const claim    = inboundClaimMap[sid];
    const bx24Id   = claim ? claim.bx24CallId : sid;
    const agentId  = claim ? (claim.bx24UserId || BX24_USER_ID) : BX24_USER_ID;
    const outbound = outboundCallMap[sid];

    // Declare finishEmail BEFORE using it
    const finishBx24Id  = outbound ? outbound.bx24CallId      : bx24Id;
    const finishAgentId = outbound ? outbound.agentBx24UserId  : agentId;
    const finishEmail   = outbound ? outbound.agentEmail        : (claim ? claim.email : null);

    if (claim)   { setAgentBusy(claim.email, false); delete inboundClaimMap[sid]; }
    if (outbound) { setAgentBusy(outbound.agentEmail, false); }

    // Push call_ended SSE to agent popup immediately
    if (finishEmail) {
      ssePush(finishEmail, 'call_ended', { callSid: sid, reason: 'terminal' });
      console.log(`[Callback] Pushed call_ended SSE to ${finishEmail} for sid=${sid}`);
    }

    const callData = pendingInboundMap[sid];
    if (callData && callData.phoneKey) callerLocks.delete(callData.phoneKey);
    if (pendingInboundMap[sid]) delete pendingInboundMap[sid];
    claimedSids.delete(sid);

    if (BX24_WEBHOOK && finishBx24Id) {
      try {
        await bx24Call('telephony.externalcall.finish', {
          CALL_ID:     finishBx24Id,
          USER_ID:     finishAgentId,
          DURATION:    duration,
          STATUS_CODE: status === 'completed' ? 200 : 304
        });
        console.log(`[Callback] BX24 finish: CALL_ID=${finishBx24Id}`);
      } catch (e) {
        console.warn('[Callback] BX24 finish failed (non-fatal):', e.message);
      }
    }

    const callFrom  = (p.From || p.CallFrom || p.caller_id || p.FromNumber || '').trim();
    const direction = (p.Direction || '').toLowerCase();
    const clientNum = direction.includes('outbound')
      ? (p.To || p.ToNumber || callFrom).trim()   // p.To is the standard Exotel field
      : callFrom;

    console.log(`[Callback-Recording] Direction="${p.Direction}" From="${p.From}" To="${p.To}" CallFrom="${p.CallFrom}" FromNumber="${p.FromNumber}" ToNumber="${p.ToNumber}" → callFrom="${callFrom}" clientNum="${clientNum}" sid="${sid}"`);

    if (!clientNum) {
      console.warn(`[Callback-Recording] ⚠️  clientNum is EMPTY — recording sync will be skipped. Full payload: ${JSON.stringify(p)}`);
    }

    if (clientNum) {
      console.log(`[Callback-Recording] ✅ Calling scheduleSync for clientNum="${clientNum}" sid="${sid}"`);
      recordings.scheduleSync({
        phoneNumber: clientNum,
        clientNum: clientNum,
        agentEmail:  finishEmail,
        callSid:     sid,
        bx24CallId:  finishBx24Id,
        agentBx24Id: finishAgentId,
        onSuccess:   () => { if (outbound) delete outboundCallMap[sid]; }
      });
    }

    res.json({ status: 'received' });
  } catch (e) { console.error('[Callback]', e.message); res.json({ status: 'error', message: e.message }); }
});

// ── Client log relay ──────────────────────────────────────────────
app.post('/client-log', (req, res) => {
  console.log('[ClientLog]', JSON.stringify(req.body));
  res.json({ status: 'ok' });
});

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:              'ok',
  account_sid:         ACCOUNT_SID       || 'NOT SET',
  api_key_set:         !!API_KEY,
  app_id_set:          !!APP_ID,
  customer_id_set:     !!CUSTOMER_ID,
  bx24_webhook_set:    !!BX24_WEBHOOK,
  domain:              DOMAIN,
  sip_domain:          SIP_FB,
  is_india:            isIndia,
  base_url:            BASE,
  virtual_number_set:  !!VIRTUAL_NUMBER
}));

// ── Debug endpoints ───────────────────────────────────────────────
app.get('/debug',     async (req, res) => { try { await getCustomerToken(); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/debug-app', async (req, res) => { try { const t = await getAppToken(); res.json({ success: true, prefix: t.slice(0,20) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/setup', async (req, res) => {
  try {
    const ct = await getCustomerToken();
    const r  = await fetch(`${BASE}/app?entity=customer`, { headers: { 'Authorization': ct } });
    const d  = await r.json();
    res.json({ APP_ID_in_env: APP_ID || 'NOT SET', apps: (d.Data||[]).map(a => ({ AppID: a.AppID, AppName: a.AppName, matched: a.AppID === APP_ID ? '\u2705' : '\u274c' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/list-users', async (req, res) => {
  try {
    const mapped = await getMappedUserMap(true);
    const users  = Array.from(mapped.values()).map(u => {
      const creds = extractMappingCredentials(u);
      return {
        email:          u.Email,
        name:           u.AppUsername || u.ExotelUserName || u.Email,
        app_user_id:    u.AppUserId,
        exotel_user_id: u.ExotelUserId,
        status:         u.IsActive ? 'active' : 'inactive',
        sip_devices:    creds.map(c => ({ sip_id: c.sip_id, virtual_number: c.virtual_number })),
        has_sip:        creds.length > 0 && !!creds[0].sip_secret,
        raw:            u
      };
    });
    res.json({ total: users.length, source: 'usermapping_live', users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sync-users', async (req, res) => {
  try { res.json(await syncUsers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/force-resync', async (req, res) => {
  try {
    _mapCache = null;
    res.json(await syncUsers());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/create-user', async (req, res) => {
  try {
    const { appUserId, appUsername, email, agentNumber, virtualNumber } = req.body;
    if (!appUserId || !appUsername || !email || !virtualNumber)
      return res.status(400).json({ error: 'Missing required fields' });
    const at = await getAppToken();
    const r  = await fetch(`${BASE}/usermapping`, {
      method: 'POST',
      headers: { 'Authorization': at, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ AppUserId: appUserId, AppUsername: appUsername, Email: email, ExotelAccountSid: ACCOUNT_SID, ExotelUserName: appUsername, AgentNumber: agentNumber || '', VirtualNumber: virtualNumber }])
    });
    const d = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(d));
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/delete-user/:appUserId', async (req, res) => {
  try {
    const at = await getAppToken();
    const allUsers = await fetchAllMappedUsers(at);
    const target = allUsers.find(u => u.AppUserId === req.params.appUserId);
    const sipUsername = target && target.SipId ? target.SipId.replace(/^sip:/, '') : null;
    const candidates = [
      target && target.ExotelUserId,
      req.params.appUserId,
      sipUsername
    ].filter(Boolean);
    for (const key of candidates) {
      const r = await fetch(`${BASE}/usermapping/${encodeURIComponent(key)}`, {
        method: 'DELETE', headers: { 'Authorization': at }
      });
      if (r.ok) return res.json({ success: true, deletedKey: key });
      const body = await r.text();
      if (r.status !== 404) throw new Error(`Delete failed [${r.status}] key=${key}: ${body.slice(0,200)}`);
    }
    throw new Error(`Not found with any key: ${candidates.join(', ')}`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /token ────────────────────────────────────────────────────────
app.get('/token', async (req, res) => {
  try {
    const { user_id, bx24_user_id } = req.query;
    let lookupEmail = user_id;

    if (!lookupEmail && bx24_user_id) {
      lookupEmail = bx24EmailCache[bx24_user_id] || await getBx24UserEmail(bx24_user_id);
      if (!lookupEmail)
        return res.status(400).json({ error: `Cannot resolve email for BX24 user ${bx24_user_id}` });
    }
    if (!lookupEmail) return res.status(400).json({ error: 'user_id (email) required' });
    const emailKey = lookupEmail.toLowerCase();

    const [appToken, mapped] = await Promise.all([getAppToken(), getMappedUserMap()]);

    let mappedUser = mapped.get(emailKey);
    let creds      = extractMappingCredentials(mappedUser);

    if (!mappedUser || creds.length === 0 || !creds[0].sip_secret) {
      console.log(`[Token] No usable usermapping row for ${lookupEmail} — forcing refresh`);
      const fresh = await getMappedUserMap(true);
      mappedUser  = fresh.get(emailKey);
      creds       = extractMappingCredentials(mappedUser);
    }

    if (!mappedUser) {
      return res.status(404).json({
        error: `${lookupEmail} not found in Exotel usermapping yet. Invite them as a Co-worker in ` +
          'Exotel and have them verify their SIP softphone — Exotel adds the row automatically ' +
          '(usually within a minute, definitely within 5).'
      });
    }
    if (creds.length === 0) {
      return res.status(500).json({
        error: `${lookupEmail} exists in usermapping but has no SipId yet — their device is ` +
          'probably UNVERIFIED. Ask them to complete verification in the Exotel app/SMS link.'
      });
    }
    if (!creds[0].sip_secret) {
      console.warn(`[Token] WARNING: SipSecret missing for ${lookupEmail} — SDK may fail to register.`);
    }

    return sendTokenResponse(res, appToken, mappedUser, creds, lookupEmail);
  } catch (e) {
    console.error('[Token] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function sendTokenResponse(res, appToken, userObj, creds, email) {
  const primary = creds[0];
  const sipUsername = primary.sip_id.replace(/^sip:/i, '');
  const appUserId    = String(userObj.AppUserId || sipUsername || userObj.id || email);
  const name = userObj.AppUsername || userObj.ExotelUserName ||
    [userObj.first_name, userObj.last_name].filter(Boolean).join(' ') ||
    userObj.Email || userObj.email || email;

  console.log('[Token] Issued from usermapping:', {
    email,
    appUserId,
    sip_username: sipUsername,
    has_secret:   !!primary.sip_secret,
    devices: creds.map(c => c.sip_id)
  });

  res.json({
    success:          true,
    access_token:     appToken,
    app_token:        appToken,
    app_user_id:      appUserId,
    user_id:          appUserId,
    email:            email,
    sip_id:           primary.sip_id,
    sip_username:     sipUsername,
    sip_secret:       primary.sip_secret,
    virtual_number:   primary.virtual_number || VIRTUAL_NUMBER || '',
    name,
    multiCredentials: creds.map((c) => ({
      app_user_id:    appUserId,
      sip_id:         c.sip_id,
      sip_secret:     c.sip_secret,
      virtual_number: c.virtual_number || VIRTUAL_NUMBER || ''
    }))
  });
}

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public', 'target')));

// ── Recording sync routes (Exotel → BX24 Activity timeline) ──────
// Wire the agent resolver so the poller can map virtual/SIP numbers → BX24 user.
// getMappedUserMap() returns a Map<email, {SipId, BxUserId, Email, ...}>
// We build a reverse map: virtualNumber/sipId → { bx24UserId, email }
recordings.setAgentResolver(async (phoneOrSip) => {
  try {
    const map = await getMappedUserMap(false);
    for (const [email, u] of map.entries()) {
      const sipId  = (u.SipId          || '').toLowerCase();
      const virtNr = (u.VirtualNumber  || VIRTUAL_NUMBER || '').replace(/\D/g,'');
      const lookup = (phoneOrSip || '').replace(/\D/g,'');
      if (lookup && (sipId === lookup || (virtNr && virtNr === lookup))) {
        const bx24UserId = u.BxUserId || u.Bx24UserId || null;
        return { bx24UserId: bx24UserId ? String(bx24UserId) : null, email };
      }
    }
  } catch (e) { console.warn('[AgentResolver]', e.message); }
  return null;
});
recordings.init(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Exotel WebSDK server on port ${PORT} | SIP: ${SIP_FB} | India: ${isIndia}`);
  const result = await syncUsers();
  console.log('[Startup] Sync:', JSON.stringify(result));
  setInterval(syncUsers, 5 * 60 * 1000);
});
