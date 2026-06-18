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

async function getCustomerToken() {
  const res  = await fetch(`${BASE}/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ Id: CUSTOMER_ID, Secret: CUSTOMER_SECRET, Entity: 'customer' })
  });
  const data = JSON.parse(await res.text());
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
  const data = JSON.parse(await res.text());
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
    res.json({ status: r.status, raw: JSON.parse(await r.text()) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/setup', async (req, res) => {
  try {
    const ct = await getCustomerToken();
    const r  = await fetch(`${BASE}/app?entity=customer`, { headers: { 'Authorization': ct } });
    const d  = JSON.parse(await r.text());
    res.json({ APP_ID_in_env: APP_ID || 'NOT SET', apps: (d.Data||[]).map(a => ({ AppID: a.AppID, AppName: a.AppName, IsActive: a.IsActive, matched: a.AppID === APP_ID ? '\u2705' : '\u274c' })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/list-users', async (req, res) => {
  try {
    const at = await getAppToken();
    let allUsers = [];
    let nextKey  = null;
    let page     = 0;
    do {
      const url = nextKey ? `${BASE}/usermapping?next_key=${nextKey}` : `${BASE}/usermapping`;
      const r   = await fetch(url, { headers: { 'Authorization': at } });
      const d   = JSON.parse(await r.text());
      const users = (d.Data && d.Data.Users) || (Array.isArray(d.Data) ? d.Data : []);
      const newU = users.filter(u => !allUsers.find(x => x.AppUserId === u.AppUserId));
      allUsers = allUsers.concat(newU);
      nextKey  = (d.Data && d.Data.NextKey) || null;
      page++;
      if (page > 20) break;
    } while (nextKey);
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
    const d = JSON.parse(await r.text());
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
    const data = JSON.parse(await r.text());
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

// ── Auto-sync Exotel CCM users to usermapping on startup ────────────────────
async function syncExotelUsers() {
  console.log('[Sync] Starting user sync...');
  try {
    const ct = await getCustomerToken();
    const ccmRes  = await fetch(`${BASE}/user?entity=customer`, { headers: { 'Authorization': ct } });
    const ccmData = JSON.parse(await ccmRes.text());
    const ccmUsers = ccmData.Data || [];
    console.log(`[Sync] CCM users found: ${ccmUsers.length}`);

    const at = await getAppToken();
    let mappedEmails = new Set();
    let allMapped = [];
    let nextKey = null;
    let page = 0;
    do {
      const url = nextKey ? `${BASE}/usermapping?next_key=${nextKey}` : `${BASE}/usermapping`;
      const r   = await fetch(url, { headers: { 'Authorization': at } });
      const d   = JSON.parse(await r.text());
      const users = (d.Data && d.Data.Users) || (Array.isArray(d.Data) ? d.Data : []);
      const unique = users.filter(u => !mappedEmails.has(u.Email));
      unique.forEach(u => { mappedEmails.add(u.Email); allMapped.push(u); });
      console.log(`[Pagination] page=${page} got=${users.length} newUnique=${unique.length} nextKey=${(d.Data && d.Data.NextKey) || 'null'}`);
      nextKey = (d.Data && d.Data.NextKey) || null;
      page++;
      if (page > 20) break;
    } while (nextKey);
    console.log(`[Pagination] Done. Total unique users: ${mappedEmails.size}`);
    console.log(`[Sync] Already mapped: ${mappedEmails.size} — emails: ${[...mappedEmails].join(', ')}`);

    const maxId = allMapped.length > 0 ? Math.max(...allMapped.map(u => parseInt(u.AppUserId) || 0)) : 126;
    let nextId = maxId + 1;

    const toAdd = ccmUsers.filter(u => {
      if (!u.Email) return false;
      if (mappedEmails.has(u.Email)) return false;
      if (!u.SipDeviceID) {
        console.log(`[Sync] Skipping ${u.Email} — no verified SIP device yet`);
        return false;
      }
      return true;
    });

    if (toAdd.length === 0) {
      console.log('[Sync] Nothing to add — all verified users already mapped.');
      return { status: 'ok', message: 'All verified Exotel users are already in usermapping.', mapped: mappedEmails.size, ccm_total: ccmUsers.length };
    }

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
    const addData = JSON.parse(await addRes.text());
    console.log('[Sync] Done:', JSON.stringify(addData));
    return { status: 'ok', added: toAdd.length, users: toAdd.map((u, i) => ({ email: u.Email, appUserId: String(maxId + 1 + i), name: u.Name })), raw: addData };
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
