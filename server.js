const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Env vars ─────────────────────────────────────────────────────
const BASE            = 'https://integrationscore.mum1.exotel.com/v2/integrations';
const CUSTOMER_ID     = process.env.EXOTEL_CUSTOMER_ID;
const CUSTOMER_SECRET = process.env.EXOTEL_CUSTOMER_SECRET;
const ACCOUNT_SID     = process.env.EXOTEL_ACCOUNT_SID;
const API_KEY         = process.env.EXOTEL_API_KEY;
const API_TOKEN       = process.env.EXOTEL_API_TOKEN;
const DOMAIN          = process.env.EXOTEL_DOMAIN || 'singapore';
const APP_ID          = process.env.EXOTEL_APP_ID;
const APP_SECRET      = process.env.EXOTEL_APP_SECRET;
const APP_USER_ID     = process.env.EXOTEL_APP_USER_ID || '123';
const VIRTUAL_NUMBER  = process.env.EXOTEL_VIRTUAL_NUMBER || '';

const BX24_WEBHOOK    = process.env.BX24_WEBHOOK_URL || '';
const BX24_USER_ID    = process.env.BX24_USER_ID || '1';
const BX24_DOMAIN     = process.env.BX24_DOMAIN   || '';

const isIndia = (DOMAIN === 'mumbai' || DOMAIN === 'india');
const SIP_FB  = isIndia ? 'voip.in1.exotel.com' : 'voip.sgp1.exotel.com';

// ── In-memory state ───────────────────────────────────────────────────
const pendingCallMap    = {};   // email -> { number, callId, ts }
let pendingInboundCall  = null;
const inboundCallMap    = {};
let pollCount = 0;

// ── Token helpers (with simple cache) ──────────────────────────────────
let _appTokenCache = null;
let _appTokenExp   = 0;

// ── Safe JSON parse helper ──────────────────────────────────────────────
// Strips BOM / leading whitespace and throws a clear error on parse failure.
function safeParseJSON(text, label) {
  const cleaned = (text || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) throw new Error(`[${label}] Empty response body`);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const snippet = cleaned.slice(0, 120);
    throw new Error(`[${label}] JSON parse failed: ${e.message} — body starts with: ${snippet}`);
  }
}

async function getCustomerToken() {
  const res  = await fetch(`${BASE}/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ Id: CUSTOMER_ID, Secret: CUSTOMER_SECRET, Entity: 'customer' })
  });
  const data = safeParseJSON(await res.text(), 'getCustomerToken');
  if (!res.ok) throw new Error(`Customer token failed: ${JSON.stringify(data)}`);
  return data.Data;
}

async function getAppToken() {
  const now = Date.now();
  if (_appTokenCache && now < _appTokenExp - 60000) return _appTokenCache;
  const res  = await fetch(`${BASE}/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ Id: APP_ID, Secret: APP_SECRET, Entity: 'app' })
  });
  const data = safeParseJSON(await res.text(), 'getAppToken');
  if (!res.ok) throw new Error(`App token failed: ${JSON.stringify(data)}`);
  _appTokenCache = data.Data;
  try {
    const payload = JSON.parse(Buffer.from(data.Data.split('.')[1], 'base64').toString());
    _appTokenExp   = payload.exp * 1000;
    console.log('[Token] App token refreshed, expires:', new Date(_appTokenExp).toISOString());
  } catch(e) { _appTokenExp = now + 3500000; }
  return _appTokenCache;
}

// ── Bitrix24 helper ───────────────────────────────────────────────────
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

// ── BX24 user lookup cache ──────────────────────────────────────────────────
const bx24UserEmailCache = {};  // userId -> email

async function getBx24UserEmail(userId, authToken) {
  if (bx24UserEmailCache[userId]) return bx24UserEmailCache[userId];
  const url = `https://gsdny.bitrix24.in/rest/user.get.json`;
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
    body: JSON.stringify({ ID: userId })
  });
  const data = await res.json();
  const email = (data.result && data.result[0] && data.result[0].EMAIL) || null;
  if (email) {
    bx24UserEmailCache[userId] = email;
    console.log(`[BX24] user ${userId} → ${email}`);
  }
  return email;
}

// ── FIX: Handle POST to static HTML files ───────────────────
app.all('/popup.html',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'popup.html')));
app.all('/background.html',(req, res) => res.sendFile(path.join(__dirname, 'public', 'background.html')));

app.get('/crmBundle.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'target', 'crmBundle.js'));
});
app.get('/crmBundle.js.LICENSE.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'public', 'target', 'crmBundle.js.LICENSE.txt'));
});

// ── Install ────────────────────────────────────────────────────────────────
app.all('/install', (req, res) => {
  console.log('[Install] Called');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="//api.bitrix24.com/api/v1/"></script></head><body><p id="msg">Installing Exotel Dialer...</p><script>BX24.init(function(){BX24.callMethod('placement.bind',{PLACEMENT:'CRM_ACTIVITY_SIDEBAR',HANDLER:'https://exotel-websdk.onrender.com/popup.html',TITLE:'Exotel Dialer'},function(r1){BX24.callMethod('telephony.externalLine.add',{LINE_NAME:'Exotel',APP_ID:BX24.getAuth().client_id},function(r2){BX24.callMethod('event.bind',{EVENT:'OnExternalCallStart',HANDLER:'https://exotel-websdk.onrender.com/bx24-call-start'},function(r3){document.getElementById('msg').innerText='\\u2705 Installed!';BX24.installFinish();});});});});<\/script></body></html>`);
});

// ── BX24 outbound call trigger ────────────────────────────────────────────────
app.post('/bx24-call-start', async (req, res) => {
  console.log('[BX24-CallStart]', JSON.stringify(req.body));
  try {
    const d          = req.body.data || req.body;
    const bx24UserId = String(d.USER_ID || BX24_USER_ID);
    const authToken  = (req.body.auth && req.body.auth.access_token) || '';

    let agentEmail = null;
    if (authToken && bx24UserId) {
      agentEmail = await getBx24UserEmail(bx24UserId, authToken).catch(() => null);
    }

    if (!agentEmail) {
      console.log(`[BX24-CallStart] Could not resolve email for BX24 user ${bx24UserId} — skipping queue`);
      return res.json({ status: 'ok', warning: 'agent email not resolved' });
    }

    pendingCallMap[agentEmail] = {
      number: d.PHONE_NUMBER || '',
      callId: d.CALL_ID     || ('ext_' + Date.now()),
      ts:     Date.now()
    };
    console.log(`[BX24-CallStart] Queued for ${agentEmail} → ${d.PHONE_NUMBER}`);
    res.json({ status: 'ok' });
  } catch(e) { res.json({ status: 'error', message: e.message }); }
});

// ── Pending call polls ──────────────────────────────────────────────────────
app.get('/pending-call', (req, res) => {
  pollCount++;
  if (pollCount % 20 === 1) console.log('[Poll] /pending-call hit #' + pollCount);

  const email  = req.query.email || null;
  const bx24Id = req.query.bx24_user_id || null;

  let agentEmail = email;
  if (!agentEmail && bx24Id) {
    agentEmail = bx24UserEmailCache[bx24Id] || null;
    if (agentEmail) console.log(`[Poll] Resolved bx24_user_id=${bx24Id} → ${agentEmail}`);
  }

  if (!agentEmail) {
    return res.json({ pending: false, reason: 'no_email' });
  }

  const entry = pendingCallMap[agentEmail];
  if (entry && (Date.now() - entry.ts) < 30000) {
    delete pendingCallMap[agentEmail];
    console.log(`[Poll] Delivering call to ${agentEmail}: ${entry.number}`);
    res.json({ pending: true, number: entry.number, callId: entry.callId });
  } else {
    if (entry) delete pendingCallMap[agentEmail];
    res.json({ pending: false });
  }
});

app.get('/pending-inbound', (req, res) => {
  if (pendingInboundCall && (Date.now() - pendingInboundCall.ts) < 30000) {
    const c = pendingInboundCall; pendingInboundCall = null;
    res.json({ pending: true, from: c.from, callSid: c.callSid });
  } else { pendingInboundCall = null; res.json({ pending: false }); }
});

// ── Incoming call (Exotel webhook) ────────────────────────────────────────────
app.all('/incoming-call', async (req, res) => {
  const p  = Object.assign({}, req.query, req.body);
  console.log('[Incoming]', JSON.stringify(p));
  const et = (p.EventType || p.Status || '').toLowerCase();
  if (['free','terminal','completed','busy','noanswer'].includes(et)) return res.json({ status: 'ignored' });
  try {
    const from  = p.From || p.CallFrom || p.caller_id || p.CallerId || p.callerid || 'Unknown';
    const sid   = p.CallSid || p.call_sid || ('in_' + Date.now());
    const toNum = p.To || p.DialWhomNumber || p.CallTo || VIRTUAL_NUMBER || 'Unknown';
    if (BX24_WEBHOOK) {
      const r    = await bx24Call('telephony.externalcall.register', {
        USER_ID:         BX24_USER_ID, PHONE_NUMBER: from, TYPE: 2,
        CALL_START_DATE: new Date().toISOString(), CRM_CREATE: true, LINE_NUMBER: toNum, SHOW: 1
      });
      const bxId = (r && r.CALL_ID) || sid;
      inboundCallMap[sid]  = bxId;
      pendingInboundCall   = { from, callSid: bxId, ts: Date.now() };
    } else {
      pendingInboundCall   = { from, callSid: sid, ts: Date.now() };
    }
    res.json({ status: 'received' });
  } catch(e) { console.error('[Incoming]', e.message); res.json({ status: 'error', message: e.message }); }
});

// ── Call ended (Exotel webhook) ─────────────────────────────────────────────────
app.all('/call-callback', async (req, res) => {
  const p = Object.assign({}, req.query, req.body);
  console.log('[Callback]', JSON.stringify(p));
  try {
    const sid      = p.CallSid || p.call_sid || '';
    const duration = parseInt(p.Duration || p.duration || '0');
    const status   = p.Status  || p.status  || 'completed';
    const bxId     = inboundCallMap[sid] || sid;
    if (inboundCallMap[sid]) delete inboundCallMap[sid];
    if (BX24_WEBHOOK && bxId)
      await bx24Call('telephony.externalcall.finish', {
        CALL_ID: bxId, USER_ID: BX24_USER_ID, DURATION: duration,
        STATUS_CODE: status === 'completed' ? 200 : 304
      });
    res.json({ status: 'received' });
  } catch(e) { console.error('[Callback]', e.message); res.json({ status: 'error', message: e.message }); }
});

// ── Client log relay ───────────────────────────────────────────────────────────
app.post('/client-log', (req, res) => {
  console.log('[ClientLog]', JSON.stringify(req.body));
  res.json({ status: 'ok' });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:              'ok',
  account_sid:         ACCOUNT_SID       || 'NOT SET',
  api_key_set:         !!API_KEY,
  api_token_set:       !!API_TOKEN,
  app_id_set:          !!APP_ID,
  app_secret_set:      !!APP_SECRET,
  customer_id_set:     !!CUSTOMER_ID,
  customer_secret_set: !!CUSTOMER_SECRET,
  bx24_webhook_set:    !!BX24_WEBHOOK,
  bx24_user_id:        BX24_USER_ID,
  domain:              DOMAIN,
  sip_domain_fb:       SIP_FB,
  app_user_id:         APP_USER_ID,
  virtual_number_set:  !!VIRTUAL_NUMBER
}));

// ── Debug endpoints ─────────────────────────────────────────────────────────────
app.get('/debug',       async (req, res) => { try { await getCustomerToken(); res.json({ success: true, message: '\u2705 Customer token OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/debug-app',   async (req, res) => { try { await getAppToken();      res.json({ success: true, message: '\u2705 App token OK'      }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/debug-token', async (req, res) => {
  try {
    const uid = req.query.user_id || APP_USER_ID;
    const at  = await getAppToken();
    const r   = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(uid)}`, { headers: { 'Authorization': at } });
    res.json({ status: r.status, raw: safeParseJSON(await r.text(), 'debug-token') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/setup', async (req, res) => {
  try {
    const ct = await getCustomerToken();
    const r  = await fetch(`${BASE}/app?entity=customer`, { headers: { 'Authorization': ct } });
    const d  = safeParseJSON(await r.text(), 'setup');
    res.json({ APP_ID_in_env: APP_ID || 'NOT SET', apps: (d.Data||[]).map(a => ({ AppID: a.AppID, AppName: a.AppName, IsActive: a.IsActive, matched: a.AppID === APP_ID ? '\u2705' : '\u274c' })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Helper: fetch ALL usermapping pages ──────────────────────────────────────
async function fetchAllMappedUsers(at) {
  let allUsers = [];
  let seen     = new Set();
  let nextKey  = null;
  let page     = 0;
  do {
    const url = nextKey ? `${BASE}/usermapping?next_key=${nextKey}` : `${BASE}/usermapping`;
    const r   = await fetch(url, { headers: { 'Authorization': at } });
    const d   = safeParseJSON(await r.text(), 'fetchAllMappedUsers');
    const users = (d.Data && d.Data.Users) || (Array.isArray(d.Data) ? d.Data : []);
    const newU = users.filter(u => !seen.has(u.AppUserId));
    newU.forEach(u => { seen.add(u.AppUserId); allUsers.push(u); });
    console.log(`[Pagination] page=${page} got=${users.length} newUnique=${newU.length} nextKey=${(d.Data && d.Data.NextKey) || 'null'}`);
    nextKey = (d.Data && d.Data.NextKey) || null;
    page++;
    if (page > 20) break;
  } while (nextKey);
  console.log(`[Pagination] Done. Total unique users: ${allUsers.length}`);
  return allUsers;
}

// ── /list-users ──────────────────────────────────────────────────────────────
app.get('/list-users', async (req, res) => {
  try {
    const at       = await getAppToken();
    const allUsers = await fetchAllMappedUsers(at);
    res.json({ total: allUsers.length, users: allUsers });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/create-user', async (req, res) => {
  try {
    const { appUserId, appUsername, email, agentNumber, virtualNumber } = req.body;
    if (!appUserId || !appUsername || !email || !virtualNumber)
      return res.status(400).json({ error: 'Missing required fields' });
    const at = await getAppToken();
    const r  = await fetch(`${BASE}/usermapping`, {
      method: 'POST', headers: { 'Authorization': at, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ AppUserId: appUserId, AppUsername: appUsername, Email: email, ExotelAccountSid: ACCOUNT_SID, ExotelUserName: appUsername, AgentNumber: agentNumber || '', VirtualNumber: virtualNumber }])
    });
    const d = safeParseJSON(await r.text(), 'create-user');
    if (!r.ok) throw new Error(JSON.stringify(d));
    res.json({ success: true, data: d });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE user from Exotel usermapping ────────────────────────────────────────────
app.delete('/delete-user/:appUserId', async (req, res) => {
  try {
    const { appUserId } = req.params;
    if (!appUserId) return res.status(400).json({ error: 'appUserId required' });
    const at = await getAppToken();
    const r  = await fetch(`${BASE}/usermapping/${encodeURIComponent(appUserId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': at }
    });
    const text = await r.text();
    let d = {};
    try { d = JSON.parse(text); } catch(e) {}
    if (!r.ok) throw new Error(`Delete failed [${r.status}]: ${text}`);
    console.log(`[DeleteUser] Deleted appUserId=${appUserId}`);
    res.json({ success: true, appUserId, data: d });
  } catch(e) {
    console.error('[DeleteUser]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /token ──────────────────────────────────────────────────────────────────────────────────────
app.get('/token', async (req, res) => {
  try {
    const { user_id, bx24_user_id } = req.query;
    let lookupId = user_id;

    if (!lookupId && bx24_user_id) {
      lookupId = bx24UserEmailCache[bx24_user_id] || null;
      if (!lookupId) {
        return res.status(400).json({ error: `BX24 user ${bx24_user_id} not yet resolved. Ensure bx24-call-start was triggered first.` });
      }
    }

    if (!lookupId) return res.status(400).json({ error: 'user_id or bx24_user_id required' });

    const appToken = await getAppToken();
    const r    = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(lookupId)}`, {
      headers: { 'Authorization': appToken }
    });
    const data = safeParseJSON(await r.text(), 'token');
    if (!r.ok) throw new Error(`Usermapping failed [${r.status}]: ${JSON.stringify(data)}`);

    const user = (data.Data && data.Data.Users && data.Data.Users.length > 0)
      ? data.Data.Users[0]
      : (data.Data && data.Data.SipId ? data.Data : null);

    if (!user) throw new Error(`No user found for user_id=${lookupId}. Run /list-users to check.`);

    console.log('[Token] Issued for user_id:', lookupId, 'SipId:', user.SipId);

    res.json({
      success:        true,
      access_token:   appToken,
      app_token:      appToken,
      app_user_id:    user.AppUserId,
      sip_id:         user.SipId,
      sip_secret:     user.SipSecret,
      virtual_number: user.VirtualNumber,
      user_id:        user.AppUserId
    });
  } catch(e) {
    console.error('[Token] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Manual sync trigger endpoint ─────────────────────────────────────────────
app.post('/sync-users', async (req, res) => {
  try {
    const result = await syncExotelUsers();
    res.json(result);
  } catch(e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ── Auto-sync Exotel CCM users to usermapping on startup ─────────────────────
// Logic:
//   1. Fetch all CCM co-workers from /user?entity=customer
//   2. Fetch all currently mapped users from /usermapping (paginated)
//   3. ADD:    CCM users with a verified SIP device not yet in usermapping
//   4. REMOVE: Users in usermapping whose email no longer exists in CCM
//              (skip removal of users with no email — may be manually added)
//   5. UPDATE: Users in usermapping where the name differs from CCM (log only, no-op for now)
async function syncExotelUsers() {
  console.log('[Sync] Starting user sync...');
  try {
    // ── Step 1: Fetch CCM co-workers ────────────────────────────────────────
    const ct       = await getCustomerToken();
    const ccmRes   = await fetch(`${BASE}/user?entity=customer`, { headers: { 'Authorization': ct } });
    const ccmRaw   = await ccmRes.text();
    const ccmData  = safeParseJSON(ccmRaw, 'syncExotelUsers/ccm');
    const ccmUsers = Array.isArray(ccmData.Data) ? ccmData.Data : [];
    console.log(`[Sync] CCM users found: ${ccmUsers.length}`);

    // Build a set of CCM emails for quick lookup
    const ccmEmailSet = new Set(ccmUsers.filter(u => u.Email).map(u => u.Email.toLowerCase()));

    // ── Step 2: Fetch all currently mapped users ─────────────────────────────
    const at         = await getAppToken();
    const allMapped  = await fetchAllMappedUsers(at);

    const mappedByEmail = {};
    allMapped.forEach(u => {
      if (u.Email) mappedByEmail[u.Email.toLowerCase()] = u;
    });
    const mappedEmails = new Set(Object.keys(mappedByEmail));
    console.log(`[Sync] Already mapped: ${mappedEmails.size} — emails: ${[...mappedEmails].join(', ')}`);

    const maxId  = allMapped.length > 0 ? Math.max(...allMapped.map(u => parseInt(u.AppUserId) || 0)) : 100;
    let   nextId = maxId + 1;

    // ── Step 3: ADD new users ────────────────────────────────────────────────
    const toAdd = ccmUsers.filter(u => {
      if (!u.Email) return false;
      if (mappedEmails.has(u.Email.toLowerCase())) return false;
      if (!u.SipDeviceID) {
        console.log(`[Sync] Skipping ${u.Email} — no verified SIP device yet`);
        return false;
      }
      return true;
    });

    let addedUsers = [];
    if (toAdd.length > 0) {
      console.log(`[Sync] Adding ${toAdd.length} new users: ${toAdd.map(u => u.Email).join(', ')}`);
      const payload = toAdd.map(u => ({
        AppUserId:         String(nextId++),
        AppUsername:       u.Name || u.Email,
        Email:             u.Email,
        ExotelAccountSid:  ACCOUNT_SID,
        ExotelUserName:    u.Name || u.Email,
        AgentNumber:       u.AgentNumber || '',
        VirtualNumber:     VIRTUAL_NUMBER
      }));

      const addRes  = await fetch(`${BASE}/usermapping`, {
        method: 'POST', headers: { 'Authorization': at, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const addData = safeParseJSON(await addRes.text(), 'syncExotelUsers/add');
      console.log('[Sync] Add result:', JSON.stringify(addData));
      addedUsers = toAdd.map((u, i) => ({ email: u.Email, appUserId: String(maxId + 1 + i), name: u.Name || u.Email }));
    } else {
      console.log('[Sync] Nothing to add — all verified users already mapped.');
    }

    // ── Step 4: REMOVE users no longer in CCM ────────────────────────────────
    // Only remove mapped users whose email exists in the mapping AND is NOT
    // present in CCM. Users with no email in the mapping are left alone.
    const toRemove = allMapped.filter(u => {
      if (!u.Email) return false;                                  // no email → skip
      return !ccmEmailSet.has(u.Email.toLowerCase());             // not in CCM anymore
    });

    let removedUsers = [];
    for (const u of toRemove) {
      try {
        const delRes = await fetch(`${BASE}/usermapping/${encodeURIComponent(u.AppUserId)}`, {
          method: 'DELETE',
          headers: { 'Authorization': at }
        });
        const delText = await delRes.text();
        if (delRes.ok) {
          console.log(`[Sync] Removed user no longer in CCM: ${u.Email} (AppUserId=${u.AppUserId})`);
          removedUsers.push({ email: u.Email, appUserId: u.AppUserId });
        } else {
          console.warn(`[Sync] Failed to remove ${u.Email}: ${delText}`);
        }
      } catch(e) {
        console.warn(`[Sync] Error removing ${u.Email}:`, e.message);
      }
    }

    // ── Step 5: LOG name mismatches (no API update needed unless CCM provides a PATCH) ──
    allMapped.forEach(mapped => {
      if (!mapped.Email) return;
      const ccm = ccmUsers.find(u => u.Email && u.Email.toLowerCase() === mapped.Email.toLowerCase());
      if (ccm && ccm.Name && ccm.Name !== mapped.AppUsername) {
        console.log(`[Sync] Name mismatch for ${mapped.Email}: mapped="${mapped.AppUsername}" ccm="${ccm.Name}" (update if API supports PATCH)`);
      }
    });

    return {
      status:       'ok',
      added:        addedUsers.length,
      removed:      removedUsers.length,
      mapped_total: mappedEmails.size,
      ccm_total:    ccmUsers.length,
      users_added:  addedUsers,
      users_removed: removedUsers
    };

  } catch(e) {
    console.error('[Sync] Error:', e.message);
    return { status: 'error', message: e.message };
  }
}

// ── Static files LAST ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public', 'target')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\u2705 Exotel WebSDK server on port ${PORT} | SIP: ${SIP_FB}`);
  console.log('[Startup] Auto-syncing Exotel users...');
  const result = await syncExotelUsers();
  console.log('[Startup] Sync result:', JSON.stringify(result));
});
