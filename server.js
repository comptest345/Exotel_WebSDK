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

const isIndia = /mum|in1|india/i.test(DOMAIN);
const SIP_FB  = isIndia ? 'voip.in1.exotel.com' : 'voip.sgp1.exotel.com';

// ── In-memory state ───────────────────────────────────────────────
// pendingCallMap: email → { number, callId, ts }
// Keyed by agent email so each agent only gets their own pending call.
const pendingCallMap   = {};
// pendingInboundMap: callSid → { from, to, ts }
// Holds every ringing inbound call until an agent claims it or it times out.
const pendingInboundMap = {};
// inboundClaimMap: callSid → { email, bx24UserId, bx24CallId, ts }
// Set atomically when an agent claims a call; used by /call-callback to finish it.
const inboundClaimMap   = {};
let   pollCount = 0;

// ── SSE client registry ───────────────────────────────────────────
// sseClients: email → Express Response object (one per agent tab)
// When a call event arrives we push it instantly instead of waiting for a poll.
const sseClients = {};  // email → res

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

// ── CCM Users API — single source of truth ───────────────────────
// All SIP credentials come LIVE from the CCM co-workers API.
// No usermapping cache needed for /token — usermapping is only used for
// the ExotelCRMWebSDK constructor token (app token), not SIP credentials.
//
// CCM API endpoint (Basic Auth with API_KEY:API_TOKEN):
//   GET /v2/accounts/<sid>/users?fields=devices
// Returns devices[] per user which contains SipId, SipSecret, VirtualNumber.

function getCcmBaseUrl() {
  return isIndia
    ? `https://ccm-api.in.exotel.com/v2/accounts/${ACCOUNT_SID}/users`
    : `https://ccm-api.exotel.com/v2/accounts/${ACCOUNT_SID}/users`;
}

function getCcmBasicAuth() {
  return 'Basic ' + Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
}

// ── In-memory CCM user cache ──────────────────────────────────────
// Refreshed every 60 seconds so /token never calls CCM on every login.
// Maps email.toLowerCase() → CCM user object with SIP fields extracted.
let _ccmCache    = null;   // Map<email, userObj>
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
      _ccmCacheExp = Date.now() + 60000; // 60 s TTL
      console.log(`[CCM] Cache refreshed: ${map.size} users`);
      return map;
    } finally {
      _ccmInflight = null;
    }
  })();
  return _ccmInflight;
}

// Fetch all CCM co-workers with full device/SIP data.
// CCM response per user (with ?fields=devices):
//   { id, email, first_name, last_name, status,
//     devices: [ { sip_id, sip_secret, virtual_number, device_id, ... } ] }
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
    console.log('[CCM] Raw sample (first user):', JSON.stringify((data.response||[])[0] || {}).slice(0,400));
    const page = (data.response || []).map(r => r.data || r).filter(u => u && u.email);
    users.push(...page);
    const meta = data.metadata || {};
    if (users.length >= (meta.total || users.length) || page.length < limit) break;
    offset += limit;
  }
  return users;
}

// Extract SIP credential(s) for a CCM user.
// The CCM API returns devices[] on each user when ?fields=devices is passed.
// Each device has sip_id, sip_secret, virtual_number.
// We return ALL devices so popup.js can try each in order (same multi-credential flow).
function extractSipCredentials(ccmUser) {
  const devices = ccmUser.devices || [];
  if (devices.length === 0) {
    // Fallback: some CCM responses put sip fields directly on the user object
    const sipId = ccmUser.sip_id || ccmUser.sipId || ccmUser.SipId || '';
    const sipSecret = ccmUser.sip_secret || ccmUser.sipSecret || ccmUser.SipSecret || '';
    const vn = ccmUser.virtual_number || ccmUser.VirtualNumber || VIRTUAL_NUMBER || '';
    if (sipId) return [{ sip_id: sipId, sip_secret: sipSecret, virtual_number: vn }];
    return [];
  }
  return devices.map(d => ({
    sip_id:         d.sip_id        || d.SipId        || '',
    sip_secret:     d.sip_secret    || d.SipSecret    || '',
    virtual_number: d.virtual_number|| d.VirtualNumber|| VIRTUAL_NUMBER || ''
  })).filter(d => d.sip_id);
}

// ── AUTO-REGISTER: create a usermapping entry on first login ──────
// Called from /token when an email has no existing usermapping entry.
async function autoRegisterUser(email, name, appToken) {
  try {
    const allMapped = await fetchAllMappedUsers(appToken);
    // Don't double-create
    const exists = allMapped.find(u => u.Email && u.Email.toLowerCase() === email.toLowerCase());
    if (exists) return exists;

    const maxId = allMapped.length > 0
      ? Math.max(...allMapped.map(u => parseInt(u.AppUserId) || 0))
      : 100;
    const newId = String(maxId + 1);

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

    // Return the newly-created entry so /token can proceed immediately
    const refreshed = await fetchAllMappedUsers(appToken);
    return refreshed.find(u => u.Email && u.Email.toLowerCase() === email.toLowerCase()) || null;
  } catch (e) {
    console.error(`[AutoRegister] Failed for ${email}:`, e.message);
    return null;
  }
}

// ── AUTO-SYNC: CCM co-workers ↔ /usermapping ─────────────────────
// Uses the correct CCM Users API (Basic Auth on ccm-api.in.exotel.com).
// Runs at startup and every 5 minutes.
// ADD: CCM users whose email isn't in usermapping yet.
// DELETE: usermapping entries whose email no longer exists in CCM.
async function syncUsers() {
  console.log('[Sync] Starting CCM sync...');
  try {
    // 1. Fetch all co-workers from CCM Users API
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
    ccmUsers.forEach(u => {
      if (u.email) ccmByEmail[u.email.toLowerCase()] = u;
    });

    // 2. Get all current usermapping entries
    const at        = await getAppToken();
    const allMapped = await fetchAllMappedUsers(at);
    const mapByEmail = {};
    allMapped.forEach(u => { if (u.Email) mapByEmail[u.Email.toLowerCase()] = u; });
    console.log(`[Sync] Mapped users: ${allMapped.length}`);

    // 3. ADD missing users
    const maxId = allMapped.length > 0
      ? Math.max(...allMapped.map(u => parseInt(u.AppUserId) || 0))
      : 100;
    let nextId = maxId + 1;

    const toAdd = ccmUsers.filter(u => u.email && !mapByEmail[u.email.toLowerCase()]);
    if (toAdd.length > 0) {
      console.log(`[Sync] Adding ${toAdd.length}: ${toAdd.map(u => u.email).join(', ')}`);
      const payload = toAdd.map(u => ({
        AppUserId:        String(nextId++),
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

    // 4. DELETE users removed from CCM
    // Exotel's DELETE endpoint accepts ExotelUserId (internal UUID), not AppUserId.
    // Try ExotelUserId first, then AppUserId, then SIP username as last resort.
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

    // Invalidate CCM cache so next /token call gets fresh SIP credentials
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
// BX24 sends USER_ID (BX24 user id). We need the agent's email to route
// the call to the right popup.js poll. We look up email from BX24 webhook.
const bx24EmailCache = {}; // bx24UserId → email

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

app.post('/bx24-call-start', async (req, res) => {
  console.log('[BX24-CallStart]', JSON.stringify(req.body));
  try {
    const d          = req.body.data || req.body;
    const bx24UserId = String(d.USER_ID || BX24_USER_ID);
    const number     = d.PHONE_NUMBER || '';
    const callId     = d.CALL_ID     || ('ext_' + Date.now());

    // Resolve agent email to use as routing key
    const email = await getBx24UserEmail(bx24UserId);
    if (!email) {
      console.warn(`[BX24-CallStart] Could not resolve email for BX24 user ${bx24UserId}`);
      // Store by bx24UserId as fallback so poll can still find it
      pendingCallMap['bx24_' + bx24UserId] = { number, callId, ts: Date.now() };
    } else {
      const key = email.toLowerCase();
      // Try instant SSE push first; fall back to poll queue if popup isn't connected yet
      const pushed = ssePush(key, 'outbound_call', { number, callId });
      if (!pushed) {
        pendingCallMap[key] = { number, callId, ts: Date.now() };
        console.log(`[BX24-CallStart] Queued (no SSE) for ${email} → ${number}`);
      }
    }
    res.json({ status: 'ok' });
  } catch (e) { res.json({ status: 'error', message: e.message }); }
});

// ── Pending call poll ─────────────────────────────────────────────
// popup.js polls with ?email=agent@email.com
app.get('/pending-call', (req, res) => {
  pollCount++;
  if (pollCount % 30 === 1) console.log('[Poll] /pending-call hit #' + pollCount);

  const email      = (req.query.email      || '').toLowerCase();
  const bx24UserId = req.query.bx24_user_id || '';

  // Try email key first, then bx24 fallback key
  const key   = email || (bx24UserId ? 'bx24_' + bx24UserId : null);
  if (!key) return res.json({ pending: false, reason: 'no_key' });

  const entry = pendingCallMap[key];
  if (entry && (Date.now() - entry.ts) < 60000) {  // 60 s: BX24 bridge init can take up to 30 s
    delete pendingCallMap[key];
    console.log(`[Poll] Delivering outbound call to ${key}: ${entry.number}`);
    res.json({ pending: true, type: 'outbound', number: entry.number, callId: entry.callId });
  } else {
    if (entry) delete pendingCallMap[key];
    // Also check for any unclaimed inbound call this agent may have missed via SSE.
    // IMPORTANT: skip calls that are already claimed — don't re-show to polling agents.
    // (read-only: do NOT delete — other agents may still need to see the result)
    const inbound = Object.entries(pendingInboundMap).find(
      ([sid, d]) => !inboundClaimMap[sid] && (Date.now() - d.ts) < 60000
    );
    if (inbound) {
      const [sid, d] = inbound;
      return res.json({ pending: true, type: 'inbound', from: d.from, callSid: sid });
    }
    // If the most recent inbound call IS claimed, tell the client so it can dismiss cleanly.
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
// popup.js connects here on open. Server pushes call events instantly.
// One connection per agent email. New tab replaces old (last-write-wins).
app.get('/events', (req, res) => {
  const email = (req.query.email || '').toLowerCase();
  if (!email) return res.status(400).end('email required');

  // SSE headers
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no'   // disable Nginx buffering on Render
  });
  res.flushHeaders();

  // Replace any existing connection for this agent
  if (sseClients[email]) {
    try { sseClients[email].end(); } catch (_) {}
  }
  sseClients[email] = res;
  console.log(`[SSE] Agent connected: ${email} (active: ${Object.keys(sseClients).length})`);

  // Heartbeat every 20 s to keep the connection alive through Render's idle timeout
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(hb); }
  }, 20000);

  // If there's already a pending call queued for this agent, flush it immediately
  const entry = pendingCallMap[email];
  if (entry && (Date.now() - entry.ts) < 60000) {  // 60 s: matches poll endpoint TTL
    delete pendingCallMap[email];
    console.log(`[SSE] Flushing queued call to ${email}: ${entry.number}`);
    ssePush(email, 'outbound_call', { number: entry.number, callId: entry.callId });
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
// Once an agent claims a call, we record the sid here so that any duplicate
// Exotel Dial webhooks (Exotel retries the webhook once per SIP leg tried)
// don't cause a second broadcast to all agents.
const claimedSids = new Set();

// ── Incoming call (Exotel webhook) ────────────────────────────────
app.all('/incoming-call', async (req, res) => {
  const p  = Object.assign({}, req.query, req.body);
  console.log('[Incoming]', JSON.stringify(p));
  const et = (p.EventType || p.Status || '').toLowerCase();
  if (['free','terminal','completed','busy','noanswer'].includes(et)) return res.json({ status: 'ignored' });
  try {
    const from  = p.From || p.CallFrom || p.caller_id || p.CallerId || p.callerid || 'Unknown';
    const sid   = p.CallSid || p.call_sid || ('in_' + Date.now());
    const toNum = p.To || p.DialWhomNumber || p.CallTo || VIRTUAL_NUMBER || 'Unknown';

    // Block re-broadcast if this call was already claimed (Exotel sends one
    // Dial webhook per SIP leg it tries — we only want the first broadcast).
    if (claimedSids.has(sid)) {
      console.log(`[Incoming] SKIP broadcast — ${sid} already claimed`);
      return res.json({ status: 'already_claimed' });
    }

    // Store the call so: (a) agents that missed the SSE get it via poll,
    // (b) /claim-call can read 'from' when registering with BX24.
    // BX24 registration is intentionally deferred to /claim-call so the CRM
    // activity is attributed to the agent who actually answers, not a hardcoded user.
    pendingInboundMap[sid] = { from, to: toNum, ts: Date.now() };

    // Broadcast to every connected agent — all of them show the incoming UI.
    // callSid is included so popup.js can reference it when claiming.
    const pushed = Object.keys(sseClients).reduce((n, agentEmail) => {
      return n + (ssePush(agentEmail, 'inbound_call', { from, callSid: sid }) ? 1 : 0);
    }, 0);
    console.log(`[Incoming] sid=${sid} from=${from} → broadcast to ${pushed} SSE agent(s)`);

    res.json({ status: 'received' });
  } catch (e) { console.error('[Incoming]', e.message); res.json({ status: 'error', message: e.message }); }
});

// ── Inbound call claim ────────────────────────────────────────────
// Called by the first agent to click "Accept". Atomically marks the call as
// claimed, registers it in BX24 under that agent, and tells every other
// connected agent to dismiss their incoming UI.
app.post('/claim-call', async (req, res) => {
  const { callSid, email, bx24UserId } = req.body;
  if (!callSid || !email) return res.status(400).json({ error: 'callSid and email required' });

  // JS is single-threaded — this check+set is atomic; no race condition.
  if (inboundClaimMap[callSid]) {
    const c = inboundClaimMap[callSid];
    console.log(`[Claim] REJECTED — ${callSid} already claimed by ${c.email}`);
    return res.json({ claimed: false, reason: 'already_claimed', claimedBy: c.email });
  }

  inboundClaimMap[callSid] = { email, bx24UserId: bx24UserId || null, bx24CallId: null, ts: Date.now() };
  claimedSids.add(callSid);  // prevent re-broadcast on duplicate Exotel webhooks
  console.log(`[Claim] ${email} claimed ${callSid}`);

  // Register the call in BX24 under the claiming agent's user ID.
  let bx24CallId = callSid;
  const callData = pendingInboundMap[callSid];
  if (BX24_WEBHOOK && callData) {
    try {
      const agentBx24Id = bx24UserId || BX24_USER_ID;
      const r = await bx24Call('telephony.externalcall.register', {
        USER_ID:         agentBx24Id,
        PHONE_NUMBER:    callData.from,
        TYPE:            2,  // inbound
        CALL_START_DATE: new Date().toISOString(),
        CRM_CREATE:      true,
        LINE_NUMBER:     callData.to || VIRTUAL_NUMBER || '',
        SHOW:            0   // popup already showed it via SSE; suppress duplicate BX24 widget
      });
      bx24CallId = (r && r.CALL_ID) || callSid;
      inboundClaimMap[callSid].bx24CallId = bx24CallId;
      console.log(`[Claim] BX24 registered: CALL_ID=${bx24CallId} USER_ID=${agentBx24Id}`);
    } catch (e) {
      console.warn('[Claim] BX24 register failed (non-fatal):', e.message);
    }
  }

  // Tell every OTHER agent to dismiss the incoming UI.
  const claimerKey = email.toLowerCase();
  Object.keys(sseClients).forEach(agentEmail => {
    if (agentEmail !== claimerKey) {
      ssePush(agentEmail, 'call_dismissed', { callSid, reason: 'claimed_by_other', claimedBy: email });
    }
  });

  res.json({ claimed: true, bx24CallId });
});

// ── Call ended (Exotel webhook) ───────────────────────────────────
app.all('/call-callback', async (req, res) => {
  const p = Object.assign({}, req.query, req.body);
  console.log('[Callback]', JSON.stringify(p));
  try {
    const sid      = p.CallSid || p.call_sid || '';
    const duration = parseInt(p.Duration || p.duration || '0');
    const status   = p.Status  || p.status  || 'completed';

    // Use the claiming agent's BX24 data; fall back to env BX24_USER_ID for
    // calls that were never claimed (e.g. abandoned before any agent answered).
    const claim    = inboundClaimMap[sid];
    const bx24Id   = claim ? claim.bx24CallId : sid;
    const agentId  = claim ? (claim.bx24UserId || BX24_USER_ID) : BX24_USER_ID;
    if (claim)  delete inboundClaimMap[sid];
    if (pendingInboundMap[sid]) delete pendingInboundMap[sid];
    claimedSids.delete(sid);  // release so memory doesn't grow forever

    if (BX24_WEBHOOK && bx24Id)
      await bx24Call('telephony.externalcall.finish', {
        CALL_ID: bx24Id, USER_ID: agentId, DURATION: duration,
        STATUS_CODE: status === 'completed' ? 200 : 304
      });

    // Auto-sync recording for this call into BX24 Activity timeline.
    // Run async — don't block the webhook response.
    const callFrom   = (p.From || p.CallFrom || p.caller_id || '').trim();
    const agentEmail = claim ? claim.email : null;
    if (callFrom) {
      recordings.syncRecordings({ phoneNumber: callFrom, agentEmail }).catch(e =>
        console.warn('[Callback] Recording sync failed (non-fatal):', e.message)
      );
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

// ── /list-users — returns LIVE CCM co-worker data (always up to date) ──
// Shows every agent with their current SIP device status, exactly as
// the Exotel dashboard shows. No stale usermapping cache.
app.get('/list-users', async (req, res) => {
  try {
    _ccmCache = null; // force a fresh fetch so this is always live
    const ccmMap = await getCcmUserMap();
    const users  = Array.from(ccmMap.values()).map(u => {
      const creds = extractSipCredentials(u);
      return {
        email:         u.email,
        name:          [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
        ccm_id:        u.id,
        status:        u.status || 'unknown',
        sip_devices:   creds.map(c => ({ sip_id: c.sip_id, virtual_number: c.virtual_number })),
        has_sip:       creds.length > 0,
        raw:           u   // full CCM object for debugging
      };
    });
    res.json({ total: users.length, source: 'ccm_live', users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /sync-users — manually trigger sync (also runs on startup + every 5min) ──
app.post('/sync-users', async (req, res) => {
  try { res.json(await syncUsers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
    // Try to find the user in usermapping to get ExotelUserId (the correct delete key)
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

// ── /token — THE critical endpoint ───────────────────────────────
// Looks up the agent by email in the LIVE CCM co-workers list.
// This guarantees SIP credentials are always fresh — no stale usermapping cache.
// The app token (for the SDK constructor) still comes from the Exotel integration API.
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

    // Fetch app token (for SDK constructor) and live CCM data in parallel
    const [appToken, ccmMap] = await Promise.all([getAppToken(), getCcmUserMap()]);

    const ccmUser = ccmMap.get(lookupEmail.toLowerCase());
    if (!ccmUser) {
      // Force a cache refresh in case user was just added
      _ccmCache = null;
      const freshMap = await getCcmUserMap();
      const freshUser = freshMap.get(lookupEmail.toLowerCase());
      if (!freshUser) {
        return res.status(404).json({
          error: `${lookupEmail} not found in Exotel co-workers. Add them in the Exotel dashboard first.`
        });
      }
      Object.assign(ccmUser || {}, freshUser);
      // Re-assign for below
      const creds = extractSipCredentials(freshUser);
      return sendTokenResponse(res, appToken, freshUser, creds, lookupEmail);
    }

    const creds = extractSipCredentials(ccmUser);
    if (creds.length === 0) {
      return res.status(500).json({
        error: `${lookupEmail} found in CCM but has no SIP device assigned. ` +
          'Check the Exotel dashboard — their softphone may be UNVERIFIED or not set up.'
      });
    }

    return sendTokenResponse(res, appToken, ccmUser, creds, lookupEmail);
  } catch (e) {
    console.error('[Token] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function sendTokenResponse(res, appToken, ccmUser, creds, email) {
  // Use the CCM user id as the AppUserId (stable, unique per Exotel account)
  const appUserId = String(ccmUser.id || ccmUser.ExotelUserId || creds[0].sip_id.replace(/[^a-z0-9]/gi,'') || email);
  const primary   = creds[0];
  const name      = [ccmUser.first_name, ccmUser.last_name].filter(Boolean).join(' ') || ccmUser.email || email;

  console.log('[Token] Issued from CCM:', {
    email,
    appUserId,
    devices: creds.map(c => c.sip_id)
  });

  // multiCredentials lets popup.js try all SIP devices in order (same as before)
  res.json({
    success:          true,
    access_token:     appToken,
    app_token:        appToken,
    app_user_id:      appUserId,
    user_id:          appUserId,
    email:            email,
    sip_id:           primary.sip_id,
    sip_username:     primary.sip_id.replace(/^sip:/, ''),
    sip_secret:       primary.sip_secret,
    virtual_number:   primary.virtual_number || VIRTUAL_NUMBER || '',
    name,
    multiCredentials: creds.map((c, i) => ({
      app_user_id:    i === 0 ? appUserId : appUserId + '_' + i,
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
recordings.init(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Exotel WebSDK server on port ${PORT} | SIP: ${SIP_FB} | India: ${isIndia}`);
  // Run sync at startup
  const result = await syncUsers();
  console.log('[Startup] Sync:', JSON.stringify(result));
  // Re-sync every 5 minutes to catch co-worker additions/deletions
  setInterval(syncUsers, 5 * 60 * 1000);
});
