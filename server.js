const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

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
let   pendingInboundCall = null;
const inboundCallMap   = {};
let   pollCount = 0;

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
  const data = await res.json();
  if (!res.ok) throw new Error(`Customer token failed: ${JSON.stringify(data)}`);
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

// ── AUTO-SYNC: Exotel CCM co-workers ↔ usermapping ───────────────
// Runs at startup and every 5 minutes.
// ADD: any CCM user with an email not yet in usermapping → POST to usermapping
// DELETE: any usermapping entry whose email is no longer in CCM → DELETE from usermapping
// Email is the unique key — names can be duplicated, IDs are internal.
async function syncUsers() {
  console.log('[Sync] Starting...');
  try {
    // 1. Get all CCM co-workers
    const ct       = await getCustomerToken();
    const ccmRes   = await fetch(`${BASE}/user?entity=customer`, { headers: { 'Authorization': ct } });
    const ccmData  = await ccmRes.json();
    const ccmUsers = Array.isArray(ccmData.Data) ? ccmData.Data : [];
    console.log(`[Sync] CCM users: ${ccmUsers.length}`);

    const ccmByEmail = {};
    ccmUsers.forEach(u => { if (u.Email) ccmByEmail[u.Email.toLowerCase()] = u; });

    // 2. Get all current usermapping entries
    const at         = await getAppToken();
    const allMapped  = await fetchAllMappedUsers(at);
    const mapByEmail = {};
    allMapped.forEach(u => { if (u.Email) mapByEmail[u.Email.toLowerCase()] = u; });
    console.log(`[Sync] Mapped users: ${allMapped.length}`);

    // 3. ADD missing users
    const maxId = allMapped.length > 0
      ? Math.max(...allMapped.map(u => parseInt(u.AppUserId) || 0))
      : 100;
    let nextId = maxId + 1;

    const toAdd = ccmUsers.filter(u => u.Email && !mapByEmail[u.Email.toLowerCase()]);
    if (toAdd.length > 0) {
      console.log(`[Sync] Adding ${toAdd.length}: ${toAdd.map(u => u.Email).join(', ')}`);
      const payload = toAdd.map(u => ({
        AppUserId:        String(nextId++),
        AppUsername:      u.Name || u.Email,
        Email:            u.Email,
        ExotelAccountSid: ACCOUNT_SID,
        ExotelUserName:   u.Name || u.Email,
        AgentNumber:      u.AgentNumber || '',
        VirtualNumber:    VIRTUAL_NUMBER
      }));
      const addRes  = await fetch(`${BASE}/usermapping`, {
        method: 'POST',
        headers: { 'Authorization': at, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const addData = await addRes.json();
      console.log('[Sync] Add result:', JSON.stringify(addData));
    }

    // 4. DELETE users removed from CCM
    const toRemove = allMapped.filter(u => u.Email && !ccmByEmail[u.Email.toLowerCase()]);
    for (const u of toRemove) {
      console.log(`[Sync] Removing ${u.Email} (AppUserId=${u.AppUserId})`);
      const delRes = await fetch(`${BASE}/usermapping/${encodeURIComponent(u.AppUserId)}`, {
        method: 'DELETE', headers: { 'Authorization': at }
      });
      if (delRes.ok) console.log(`[Sync] Removed: ${u.Email}`);
      else console.warn(`[Sync] Remove failed for ${u.Email}: ${await delRes.text()}`);
    }

    console.log(`[Sync] Done. Added=${toAdd.length} Removed=${toRemove.length}`);
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
      pendingCallMap[email.toLowerCase()] = { number, callId, ts: Date.now() };
      console.log(`[BX24-CallStart] Queued for ${email} → ${number}`);
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
  if (entry && (Date.now() - entry.ts) < 30000) {
    delete pendingCallMap[key];
    console.log(`[Poll] Delivering call to ${key}: ${entry.number}`);
    res.json({ pending: true, number: entry.number, callId: entry.callId });
  } else {
    if (entry) delete pendingCallMap[key];
    res.json({ pending: false });
  }
});

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
    if (BX24_WEBHOOK) {
      const r    = await bx24Call('telephony.externalcall.register', {
        USER_ID: BX24_USER_ID, PHONE_NUMBER: from, TYPE: 2,
        CALL_START_DATE: new Date().toISOString(), CRM_CREATE: true, LINE_NUMBER: toNum, SHOW: 1
      });
      const bxId = (r && r.CALL_ID) || sid;
      inboundCallMap[sid] = bxId;
      pendingInboundCall  = { from, callSid: bxId, ts: Date.now() };
    } else {
      pendingInboundCall = { from, callSid: sid, ts: Date.now() };
    }
    res.json({ status: 'received' });
  } catch (e) { console.error('[Incoming]', e.message); res.json({ status: 'error', message: e.message }); }
});

// ── Call ended (Exotel webhook) ───────────────────────────────────
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

// ── /list-users — returns all usermapping entries (your source of truth) ──
app.get('/list-users', async (req, res) => {
  try {
    const at    = await getAppToken();
    const users = await fetchAllMappedUsers(at);
    res.json({ total: users.length, users });
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
    const at  = await getAppToken();
    const r   = await fetch(`${BASE}/usermapping/${encodeURIComponent(req.params.appUserId)}`, {
      method: 'DELETE', headers: { 'Authorization': at }
    });
    if (!r.ok) throw new Error(`Delete failed [${r.status}]: ${await r.text()}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /token — THE critical endpoint ───────────────────────────────
// popup.js sends ?user_id=agent@email.com (resolved from BX24.user.current)
// We look up by email in usermapping → return the correct SipSecret for that agent.
// Email is unique per agent — this is the correct bridge between BX24 and Exotel.
app.get('/token', async (req, res) => {
  try {
    const { user_id, bx24_user_id } = req.query;
    let lookupEmail = user_id;

    // If popup sends bx24_user_id instead of email, try to resolve from cache
    if (!lookupEmail && bx24_user_id) {
      lookupEmail = bx24EmailCache[bx24_user_id] || null;
      if (!lookupEmail) {
        // Try fetching from BX24 now
        lookupEmail = await getBx24UserEmail(bx24_user_id);
      }
      if (!lookupEmail) {
        return res.status(400).json({ error: `Cannot resolve email for BX24 user ${bx24_user_id}` });
      }
    }
    if (!lookupEmail) return res.status(400).json({ error: 'user_id (email) required' });

    const appToken  = await getAppToken();

    // Direct lookup by email
    const r    = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(lookupEmail)}`, {
      headers: { 'Authorization': appToken }
    });
    const data = await r.json();

    let user = null;
    if (data.Data) {
      if (Array.isArray(data.Data)) user = data.Data[0] || null;
      else if (data.Data.Users && data.Data.Users.length > 0) user = data.Data.Users[0];
      else if (data.Data.SipId) user = data.Data;
    }

    // Always scan ALL usermapping entries for this email.
    // Some agents (e.g. Khushil) have two entries — one per email alias —
    // and we need to return all of them so popup.js can try each SIP credential
    // in turn until one registers successfully.
    const allUsers    = await fetchAllMappedUsers(appToken);
    const matchedUsers = allUsers.filter(
      u => u.Email && u.Email.toLowerCase() === lookupEmail.toLowerCase()
    );

    // Also include the user found by direct lookup (may have a different Email field)
    if (user && !matchedUsers.find(u => u.AppUserId === user.AppUserId)) {
      matchedUsers.unshift(user);
    }

    // Fallback: use whatever the direct lookup found
    if (matchedUsers.length === 0 && user) matchedUsers.push(user);

    if (matchedUsers.length === 0) {
      return res.status(404).json({
        error: `No usermapping found for ${lookupEmail}. Check /list-users.`
      });
    }

    // Primary credential = first match (highest AppUserId wins — most recently created)
    matchedUsers.sort((a, b) => parseInt(b.AppUserId) - parseInt(a.AppUserId));
    const primary = matchedUsers[0];

    console.log('[Token] Issued:', {
      email:       lookupEmail,
      credentials: matchedUsers.map(u => ({ AppUserId: u.AppUserId, SipId: u.SipId }))
    });

    // SipSecret must reach the SDK RAW — no encoding.
    // Special chars like ! $ & in the password must be preserved exactly
    // so the MD5 Digest hash matches what Kamailio expects.
    //
    // multiCredentials: array of all credential sets for this email.
    // popup.js will try them in order and use the first that registers.
    // For agents with a single usermapping entry this array has length 1
    // and behaviour is identical to before.
    res.json({
      success:           true,
      access_token:      appToken,          // SDK constructor arg 1
      app_token:         appToken,
      app_user_id:       primary.AppUserId, // SDK constructor arg 2
      user_id:           primary.AppUserId,
      email:             primary.Email,
      sip_id:            primary.SipId,
      sip_username:      primary.SipId ? primary.SipId.replace(/^sip:/, '') : '',
      sip_secret:        primary.SipSecret,
      virtual_number:    primary.VirtualNumber,
      name:              primary.AppUsername,
      // All credential sets for this email (≥1 entry; >1 only for multi-mapped agents)
      multiCredentials:  matchedUsers.map(u => ({
        app_user_id:  u.AppUserId,
        sip_id:       u.SipId,
        sip_secret:   u.SipSecret,
        virtual_number: u.VirtualNumber,
        name:         u.AppUsername
      }))
    });
  } catch (e) {
    console.error('[Token] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public', 'target')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Exotel WebSDK server on port ${PORT} | SIP: ${SIP_FB} | India: ${isIndia}`);
  // Run sync at startup
  const result = await syncUsers();
  console.log('[Startup] Sync:', JSON.stringify(result));
  // Re-sync every 5 minutes to catch co-worker additions/deletions
  setInterval(syncUsers, 5 * 60 * 1000);
});
