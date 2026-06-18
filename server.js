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
const BX24_DOMAIN     = process.env.BX24_DOMAIN   || 'gsdny.bitrix24.in';

const isIndia = (DOMAIN === 'mumbai' || DOMAIN === 'india');
const SIP_FB  = isIndia ? 'voip.in1.exotel.com' : 'voip.sgp1.exotel.com';

// ── Token cache with auto-refresh ────────────────────────────────
// Tokens are cached so we don't hit Exotel on every /token call.
// Re-fetched 1 hour before expiry (tokens last ~89 days).
const tokenCache = {
  customer: { value: null, expiresAt: 0 },
  app:      { value: null, expiresAt: 0 }
};

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return (payload.exp || 0) * 1000; // ms
  } catch { return 0; }
}

async function getCustomerToken() {
  const now = Date.now();
  const BUFFER = 60 * 60 * 1000; // 1 hour before expiry
  if (tokenCache.customer.value && now < tokenCache.customer.expiresAt - BUFFER) {
    return tokenCache.customer.value;
  }
  const res  = await fetch(`${BASE}/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ Id: CUSTOMER_ID, Secret: CUSTOMER_SECRET, Entity: 'customer' })
  });
  const data = JSON.parse(await res.text());
  if (!res.ok) throw new Error(`Customer token failed: ${JSON.stringify(data)}`);
  tokenCache.customer.value     = data.Data;
  tokenCache.customer.expiresAt = jwtExpiry(data.Data) || (now + 89 * 24 * 60 * 60 * 1000);
  console.log('[Token] Customer token refreshed, expires:', new Date(tokenCache.customer.expiresAt).toISOString());
  return data.Data;
}

async function getAppToken() {
  const now = Date.now();
  const BUFFER = 60 * 60 * 1000;
  if (tokenCache.app.value && now < tokenCache.app.expiresAt - BUFFER) {
    return tokenCache.app.value;
  }
  const res  = await fetch(`${BASE}/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ Id: APP_ID, Secret: APP_SECRET, Entity: 'app' })
  });
  const data = JSON.parse(await res.text());
  if (!res.ok) throw new Error(`App token failed: ${JSON.stringify(data)}`);
  tokenCache.app.value     = data.Data;
  tokenCache.app.expiresAt = jwtExpiry(data.Data) || (now + 89 * 24 * 60 * 60 * 1000);
  console.log('[Token] App token refreshed, expires:', new Date(tokenCache.app.expiresAt).toISOString());
  return data.Data;
}

// ── Bitrix24 helper ───────────────────────────────────────────────
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

// ── Resolve BX24 user email from numeric BX24 user ID ────────────
// Cached so repeat click-to-call doesn't hit BX24 API every time.
const bx24EmailCache = {}; // { "44": "khushdxb09@gmail.com", ... }

async function getBx24UserEmail(bx24UserId) {
  if (bx24EmailCache[bx24UserId]) return bx24EmailCache[bx24UserId];
  try {
    const result = await bx24Call('user.get', { ID: bx24UserId });
    const user   = Array.isArray(result) ? result[0] : result;
    const email  = (user && user.EMAIL) || null;
    if (email) {
      bx24EmailCache[bx24UserId] = email;
      console.log(`[BX24] user ${bx24UserId} → ${email}`);
    }
    return email;
  } catch (e) {
    console.error('[BX24] getBx24UserEmail error:', e.message);
    return null;
  }
}

// ── In-memory state (per-user, keyed by email) ───────────────────
// pendingOutboundCalls["khushdxb09@gmail.com"] = { number, callId, ts }
const pendingOutboundCalls = {};
const pendingInboundCalls  = {};
const inboundCallMap       = {}; // callSid → bxCallId
let pollCount = 0;

// ── Static HTML routes ────────────────────────────────────────────
app.all('/popup.html', (req, res) => {
  // Inject server-side env vars into the page so popup.js fallback works
  // even when BX24 JS is not available (e.g. opened directly, not in sidebar).
  const fs       = require('fs');
  const htmlPath = path.join(__dirname, 'public', 'popup.html');
  let   html     = fs.readFileSync(htmlPath, 'utf8');
  const inject   = `<script>window._EXOTEL_APP_USER_ID="${APP_USER_ID}";<\/script>`;
  html = html.replace('</head>', inject + '</head>');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});
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
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="//api.bitrix24.com/api/v1/"></script></head><body><p id="msg">Installing Exotel Dialer...</p><script>BX24.init(function(){BX24.callMethod('placement.bind',{PLACEMENT:'CRM_ACTIVITY_SIDEBAR',HANDLER:'https://exotel-websdk.onrender.com/popup.html',TITLE:'Exotel Dialer'},function(r1){BX24.callMethod('telephony.externalLine.add',{LINE_NAME:'Exotel',APP_ID:BX24.getAuth().client_id},function(r2){BX24.callMethod('event.bind',{EVENT:'OnExternalCallStart',HANDLER:'https://exotel-websdk.onrender.com/bx24-call-start'},function(r3){document.getElementById('msg').innerText='\\u2705 Installed!';BX24.installFinish();});});});});<\/script></body></html>`);
});

// ── BX24 outbound call trigger (webhook from Bitrix24) ────────────
// BX24 sends USER_ID (numeric). We resolve it to email, then queue.
app.post('/bx24-call-start', async (req, res) => {
  console.log('[BX24-CallStart]', JSON.stringify(req.body));
  try {
    const d       = req.body.data || req.body;
    const number  = d.PHONE_NUMBER || '';
    const callId  = d.CALL_ID     || ('ext_' + Date.now());
    const bx24Uid = String(d.USER_ID || BX24_USER_ID);

    // Resolve BX24 numeric user ID → email
    const email = await getBx24UserEmail(bx24Uid);
    if (!email) {
      console.warn('[BX24-CallStart] Could not resolve email for BX24 user', bx24Uid, '— falling back to default');
    }

    const key = email || ('bx24_' + bx24Uid);
    pendingOutboundCalls[key] = { number, callId, bx24UserId: bx24Uid, ts: Date.now() };
    console.log('[BX24-CallStart] Queued for', key, '→', number);
    res.json({ status: 'ok', email: key });
  } catch (e) {
    console.error('[BX24-CallStart] Error:', e.message);
    res.json({ status: 'error', message: e.message });
  }
});

// ── Outbound call queue endpoint (from popup.js — per agent email) ─
app.get('/pending-call', (req, res) => {
  pollCount++;
  if (pollCount % 20 === 1) console.log('[Poll] /pending-call hit #' + pollCount);

  const email = req.query.email || '';
  if (!email) return res.json({ pending: false, error: 'email param required' });

  const c = pendingOutboundCalls[email];
  if (c && (Date.now() - c.ts) < 30000) {
    delete pendingOutboundCalls[email];
    console.log('[Poll] Delivering call to', email, '→', c.number);
    res.json({ pending: true, number: c.number, callId: c.callId });
  } else {
    if (c) delete pendingOutboundCalls[email]; // expired
    res.json({ pending: false });
  }
});

// ── Inbound call queue endpoint (per agent email) ─────────────────
app.get('/pending-inbound', (req, res) => {
  const email = req.query.email || '';
  if (!email) return res.json({ pending: false });

  const c = pendingInboundCalls[email];
  if (c && (Date.now() - c.ts) < 30000) {
    delete pendingInboundCalls[email];
    res.json({ pending: true, from: c.from, callSid: c.callSid });
  } else {
    if (c) delete pendingInboundCalls[email];
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

    // Inbound calls go to the default BX24 user for now.
    // Exotel routes to specific SIP via call flow — the agent whose SIP is registered picks up.
    if (BX24_WEBHOOK) {
      const r    = await bx24Call('telephony.externalcall.register', {
        USER_ID:         BX24_USER_ID, PHONE_NUMBER: from, TYPE: 2,
        CALL_START_DATE: new Date().toISOString(), CRM_CREATE: true, LINE_NUMBER: toNum, SHOW: 1
      });
      const bxId = (r && r.CALL_ID) || sid;
      inboundCallMap[sid] = bxId;
      // Broadcast to all connected agents — each popup polls /pending-inbound?email=...
      // The one whose SIP actually rang will have received the SDK incomingCall event directly.
      // This queue is a fallback for popups that need to show UI.
      pendingInboundCalls['__broadcast__'] = { from, callSid: bxId, ts: Date.now() };
    } else {
      pendingInboundCalls['__broadcast__'] = { from, callSid: sid, ts: Date.now() };
    }
    res.json({ status: 'received' });
  } catch(e) { console.error('[Incoming]', e.message); res.json({ status: 'error', message: e.message }); }
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
  } catch(e) { console.error('[Callback]', e.message); res.json({ status: 'error', message: e.message }); }
});

// ── Client log relay ──────────────────────────────────────────────
app.post('/client-log', (req, res) => {
  console.log('[ClientLog]', JSON.stringify(req.body));
  res.json({ status: 'ok' });
});

// ── Shared helper: fetch all usermapping users (deduped) ────────
// Exotel pagination: LastEvaluatedValue = AppUserId of last item on page.
// STOP when: count returned < PAGE_SIZE (last page) OR key repeats (loop guard).
// Dedupe by AppUserId as final safety net.
const PAGE_SIZE = 20;
async function fetchAllMappedUsers(appToken) {
  const seen    = new Set();   // tracks AppUserId to prevent duplicates
  const seenKey = new Set();   // tracks pagination keys to prevent infinite loop
  let allUsers  = [];
  let lastKey   = null;
  let page      = 0;

  do {
    const url  = lastKey
      ? `${BASE}/usermapping?last_evaluated_value=${encodeURIComponent(lastKey)}`
      : `${BASE}/usermapping`;
    const r    = await fetch(url, { headers: { 'Authorization': appToken } });
    const data = JSON.parse(await r.text());
    if (!r.ok) throw new Error(`Usermapping failed [${r.status}]: ${JSON.stringify(data)}`);

    const users  = (data.Data && data.Data.Users) ? data.Data.Users : [];
    const newKey = (data.Data && data.Data.LastEvaluatedValue) ? data.Data.LastEvaluatedValue : null;

    let addedThisPage = 0;
    for (const u of users) {
      if (!seen.has(u.AppUserId)) {
        seen.add(u.AppUserId);
        allUsers.push(u);
        addedThisPage++;
      }
    }

    console.log(`[Pagination] page=${page} got=${users.length} newUnique=${addedThisPage} nextKey=${newKey}`);

    // STOP conditions:
    // 1. No next key returned
    // 2. Fewer items than page size means this was the last page
    // 3. We've seen this key before (infinite loop guard)
    if (!newKey || users.length < PAGE_SIZE || seenKey.has(newKey)) {
      break;
    }

    seenKey.add(newKey);
    lastKey = newKey;
    page++;
  } while (page < 20); // absolute safety cap

  console.log(`[Pagination] Done. Total unique users: ${allUsers.length}`);
  return allUsers;
}

// ── /token — per-user SIP credentials, looked up by email ────────
// popup.js calls GET /token?user_id=<email-of-logged-in-BX24-user>
// Matches by Email field (case-insensitive) in Exotel usermapping.
app.get('/token', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    // STRICT: only accept email-format user_id — never a bare numeric ID or 'default'
    // This prevents Arjun from accidentally getting Khushil's SIP credentials.
    if (!user_id.includes('@')) {
      return res.status(400).json({
        error: 'user_id must be an email address. BX24 user detection may have failed — open the dialer from inside a CRM contact card, not the Marketplace page.'
      });
    }

    const appToken = await getAppToken();
    const allUsers = await fetchAllMappedUsers(appToken);

    // Match ONLY by email — strict, no AppUserId fallback
    const needle = user_id.toLowerCase();
    const user   = allUsers.find(u => u.Email && u.Email.toLowerCase() === needle);

    if (!user) throw new Error(`No Exotel user found matching "${user_id}". Add them via /create-user or Postman.`);

    console.log('[Token] Issued for', user_id, '→', user.Email, '→ SipId:', user.SipId);

    res.json({
      success:        true,
      access_token:   appToken,
      app_token:      appToken,
      app_user_id:    user.AppUserId,
      sip_id:         user.SipId,
      sip_secret:     user.SipSecret,
      virtual_number: user.VirtualNumber,
      user_id:        user.AppUserId,
      email:          user.Email
    });
  } catch(e) {
    console.error('[Token] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────────────
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
  virtual_number_set:  !!VIRTUAL_NUMBER,
  token_cache: {
    customer_expires: tokenCache.customer.expiresAt ? new Date(tokenCache.customer.expiresAt).toISOString() : 'not loaded',
    app_expires:      tokenCache.app.expiresAt      ? new Date(tokenCache.app.expiresAt).toISOString()      : 'not loaded'
  }
}));

// ── Debug / admin endpoints ───────────────────────────────────────
app.get('/debug',       async (req, res) => { try { await getCustomerToken(); res.json({ success: true, message: '✅ Customer token OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/debug-app',   async (req, res) => { try { await getAppToken();      res.json({ success: true, message: '✅ App token OK'      }); } catch(e) { res.status(500).json({ error: e.message }); } });

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
    res.json({ APP_ID_in_env: APP_ID || 'NOT SET', apps: (d.Data||[]).map(a => ({ AppID: a.AppID, AppName: a.AppName, IsActive: a.IsActive, matched: a.AppID === APP_ID ? '✅' : '❌' })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── List all mapped users ─────────────────────────────────────────
app.get('/list-users', async (req, res) => {
  try {
    const at       = await getAppToken();
    const allUsers = await fetchAllMappedUsers(at);
    res.json({ total: allUsers.length, users: allUsers });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Create a new usermapping user ─────────────────────────────────
app.post('/create-user', async (req, res) => {
  try {
    const { appUserId, appUsername, email, agentNumber, virtualNumber } = req.body;
    if (!appUserId || !appUsername || !email || !virtualNumber)
      return res.status(400).json({ error: 'Missing required fields: appUserId, appUsername, email, virtualNumber' });
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

// ── Delete a usermapping user by email or AppUserId ───────────────
app.delete('/delete-user', async (req, res) => {
  try {
    const userId = req.query.user_id || req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id query param required' });
    const at = await getAppToken();
    const r  = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(userId)}`, {
      method: 'DELETE', headers: { 'Authorization': at }
    });
    const d = JSON.parse(await r.text());
    res.json({ status: r.ok ? 'deleted' : 'error', data: d });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Outbound call queue endpoint (legacy — kept for compatibility) ─
app.post('/outbound-call', (req, res) => {
  const { number, callId, userId } = req.body;
  pendingOutboundCalls[userId || 'legacy'] = { number, callId, ts: Date.now() };
  res.json({ status: 'ok' });
});

// ── /cleanup-duplicates — remove duplicate usermapping entries ────
// Exotel's pagination bug caused the same users to be added 20x.
// This endpoint finds all duplicates by AppUserId and deletes extras,
// keeping only the first (oldest) entry per AppUserId.
// Hit once: GET https://exotel-websdk.onrender.com/cleanup-duplicates
app.get('/cleanup-duplicates', async (req, res) => {
  console.log('[Cleanup] Starting duplicate removal...');
  try {
    const at = await getAppToken();

    // Fetch ALL raw pages without deduplication to see true state
    const seen    = new Map(); // AppUserId -> first occurrence
    const dupes   = [];        // AppUserIds to delete (extras)
    let lastKey   = null;
    let page      = 0;
    const seenKey = new Set();

    do {
      const url  = lastKey
        ? `${BASE}/usermapping?last_evaluated_value=${encodeURIComponent(lastKey)}`
        : `${BASE}/usermapping`;
      const r    = await fetch(url, { headers: { 'Authorization': at } });
      const data = JSON.parse(await r.text());
      const users  = (data.Data && data.Data.Users) ? data.Data.Users : [];
      const newKey = (data.Data && data.Data.LastEvaluatedValue) ? data.Data.LastEvaluatedValue : null;

      for (const u of users) {
        if (!seen.has(u.AppUserId)) {
          seen.set(u.AppUserId, u);
        } else {
          // Duplicate — mark for deletion
          if (!dupes.includes(u.AppUserId)) dupes.push(u.AppUserId);
        }
      }

      if (!newKey || users.length < PAGE_SIZE || seenKey.has(newKey)) break;
      seenKey.add(newKey);
      lastKey = newKey;
      page++;
    } while (page < 30);

    console.log(`[Cleanup] Unique users: ${seen.size}, Duplicate AppUserIds: ${dupes.length}`);

    if (dupes.length === 0) {
      return res.json({ status: 'ok', message: 'No duplicates found.', unique: seen.size });
    }

    // Delete all duplicate AppUserIds
    const results = [];
    for (const appUserId of dupes) {
      try {
        const r = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(appUserId)}`, {
          method: 'DELETE', headers: { 'Authorization': at }
        });
        const d = JSON.parse(await r.text());
        console.log(`[Cleanup] Deleted duplicate ${appUserId}:`, r.status);
        results.push({ appUserId, status: r.ok ? 'deleted' : 'error', data: d });
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (e) {
        results.push({ appUserId, status: 'error', message: e.message });
      }
    }

    res.json({
      status:  'ok',
      unique:  seen.size,
      deleted: results.filter(r => r.status === 'deleted').length,
      results
    });
  } catch (e) {
    console.error('[Cleanup] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /sync-users — auto-register Exotel co-workers into usermapping ─
// Fetches all users from Exotel CCM (co-workers with verified SIP),
// compares with current usermapping, and adds any missing ones.
// Call this manually from browser after inviting a new user in Exotel:
//   GET https://exotel-websdk.onrender.com/sync-users
// It's also called automatically on server startup (see bottom).
//
// CCM Users API: GET https://<key>:<token>@ccm-api.exotel.com/v2/accounts/<sid>/users
// Uses Basic Auth (API Key + API Token) — different from integration JWT tokens.
const CCM_BASE = isIndia
  ? `https://ccm-api.in.exotel.com/v2/accounts/${ACCOUNT_SID}/users`
  : `https://ccm-api.exotel.com/v2/accounts/${ACCOUNT_SID}/users`;

async function fetchAllCcmUsers() {
  const auth    = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
  let allUsers  = [];
  let offset    = 0;
  const limit   = 50;
  let total     = null;

  do {
    const url = `${CCM_BASE}?fields=devices&offset=${offset}&limit=${limit}`;
    const r   = await fetch(url, { headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' } });
    const raw = await r.text();
    if (!r.ok) throw new Error(`CCM users fetch failed [${r.status}]: ${raw}`);
    const data = JSON.parse(raw);

    // Each item in response array has { code, status, data: { id, email, ... devices } }
    const users = (data.response || []).map(item => item.data).filter(Boolean);
    allUsers = allUsers.concat(users);

    if (total === null && data.metadata) total = data.metadata.total;
    offset += users.length;
  } while (total !== null && allUsers.length < total && offset < total);

  return allUsers;
}

app.get('/sync-users', async (req, res) => {
  console.log('[Sync] Starting user sync...');
  try {
    const appToken = await getAppToken();

    // Step 1: Get all CCM co-workers (invited users in Exotel dashboard)
    const ccmUsers = await fetchAllCcmUsers();
    console.log(`[Sync] CCM users found: ${ccmUsers.length}`);

    // Step 2: Get all already-mapped users from usermapping (deduped)
    const mappedUsers = await fetchAllMappedUsers(appToken);

    const mappedEmails = new Set(mappedUsers.map(u => (u.Email || '').toLowerCase()));
    console.log(`[Sync] Already mapped: ${mappedUsers.length} — emails: ${[...mappedEmails].join(', ')}`);

    // Step 3: Find CCM users with verified SIP device who are NOT yet in usermapping
    const toAdd = [];
    for (const u of ccmUsers) {
      const email = (u.email || '').toLowerCase();
      if (!email) continue;
      if (mappedEmails.has(email)) continue; // already mapped

      // Check if they have a verified SIP device
      const devices = u.devices || [];
      const hasSip  = devices.some(d => d.type === 'sip' && d.verified === true);
      if (!hasSip) {
        console.log(`[Sync] Skipping ${email} — no verified SIP device yet`);
        continue;
      }

      // Generate a sequential AppUserId
      const maxId = mappedUsers.reduce((m, mu) => {
        const n = parseInt(mu.AppUserId);
        return isNaN(n) ? m : Math.max(m, n);
      }, 123);
      const newAppUserId = String(maxId + toAdd.length + 1);

      toAdd.push({
        AppUserId:        newAppUserId,
        AppUsername:      `${u.first_name || ''} ${u.last_name || ''}`.trim() || email,
        Email:            u.email,
        ExotelAccountSid: ACCOUNT_SID,
        ExotelUserName:   `${u.first_name || ''} ${u.last_name || ''}`.trim() || email,
        AgentNumber:      '',
        VirtualNumber:    VIRTUAL_NUMBER
      });
    }

    if (toAdd.length === 0) {
      console.log('[Sync] Nothing to add — all verified users already mapped.');
      return res.json({
        status:   'ok',
        message:  'All verified Exotel users are already in usermapping.',
        mapped:   mappedUsers.length,
        ccm_total: ccmUsers.length
      });
    }

    // Step 4: POST new users into usermapping in one batch
    console.log(`[Sync] Adding ${toAdd.length} new users:`, toAdd.map(u => u.Email).join(', '));
    const r = await fetch(`${BASE}/usermapping`, {
      method:  'POST',
      headers: { 'Authorization': appToken, 'Content-Type': 'application/json' },
      body:    JSON.stringify(toAdd)
    });
    const result = JSON.parse(await r.text());
    if (!r.ok) throw new Error(`Usermapping POST failed: ${JSON.stringify(result)}`);

    console.log('[Sync] Done:', JSON.stringify(result));
    res.json({
      status:  'ok',
      added:   toAdd.length,
      users:   toAdd.map(u => ({ email: u.Email, appUserId: u.AppUserId, name: u.AppUsername })),
      raw:     result
    });
  } catch (e) {
    console.error('[Sync] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Static files LAST ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public', 'target')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Exotel WebSDK server on port ${PORT} | SIP: ${SIP_FB}`);

  // Auto-sync Exotel co-workers into usermapping on startup.
  // 5s delay lets the server fully initialise before calling itself.
  setTimeout(async () => {
    try {
      console.log('[Startup] Auto-syncing Exotel users...');
      const r = await fetch(`http://localhost:${PORT}/sync-users`);
      const d = await r.json();
      console.log('[Startup] Sync result:', JSON.stringify(d));
    } catch (e) {
      console.warn('[Startup] Auto-sync failed (non-fatal):', e.message);
    }
  }, 5000);
});
