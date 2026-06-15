const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BASE         = 'https://integrationscore.mum1.exotel.com/v2/integrations';
const CUSTOMER_ID  = process.env.EXOTEL_CUSTOMER_ID;
const CUSTOMER_SECRET = process.env.EXOTEL_CUSTOMER_SECRET;
const ACCOUNT_SID  = process.env.EXOTEL_ACCOUNT_SID;
const API_KEY      = process.env.EXOTEL_API_KEY;
const API_TOKEN    = process.env.EXOTEL_API_TOKEN;
const DOMAIN       = process.env.EXOTEL_DOMAIN || 'singapore';
const APP_ID       = process.env.EXOTEL_APP_ID;
const APP_SECRET   = process.env.EXOTEL_APP_SECRET;
const EXOTEL_APP_USER_ID = process.env.EXOTEL_APP_USER_ID || '123'; // Exotel AppUserId — NOT Bitrix24 user ID
const EXOTEL_VIRTUAL_NUMBER = process.env.EXOTEL_VIRTUAL_NUMBER || '';

// Bitrix24 webhook for server-side REST calls (set this in Render env)
// Create it at: gsdny.bitrix24.in/devops/list/ → Add webhook → select telephony scope
const BX24_WEBHOOK = process.env.BX24_WEBHOOK_URL || '';
// Bitrix24 user ID of the agent (Khushil = 1 usually, check at /rest/user.current.json)
const BX24_USER_ID = process.env.BX24_USER_ID || '1';
const BX24_DOMAIN  = process.env.BX24_DOMAIN || 'gsdny.bitrix24.in';

// ── Exotel token helpers ───────────────────────────────────────
async function getCustomerToken() {
  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: CUSTOMER_ID, Secret: CUSTOMER_SECRET, Entity: 'customer' })
  });
  const data = JSON.parse(await res.text());
  if (!res.ok) throw new Error(`Customer token failed: ${JSON.stringify(data)}`);
  return data.Data;
}

async function getAppToken() {
  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: APP_ID, Secret: APP_SECRET, Entity: 'app' })
  });
  const data = JSON.parse(await res.text());
  if (!res.ok) throw new Error(`App token failed: ${JSON.stringify(data)}`);
  return data.Data;
}

// ── Bitrix24 REST helper ───────────────────────────────────────
async function bx24Call(method, params) {
  if (!BX24_WEBHOOK) throw new Error('BX24_WEBHOOK_URL not set in env');
  const url = `${BX24_WEBHOOK}${method}.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (data.error) throw new Error(`BX24 ${method} error: ${data.error} — ${data.error_description}`);
  return data.result;
}

// ── FIX: Handle POST to static HTML files ─────────────────────
app.all('/popup.html',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'popup.html')));
app.all('/background.html',(req, res) => res.sendFile(path.join(__dirname, 'public', 'background.html')));

// ── Install — registers placements + external telephony line ──
app.all('/install', (req, res) => {
  console.log('[Install] Called');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script src="//api.bitrix24.com/api/v1/"></script>
</head>
<body>
  <p id="msg">Installing Exotel Dialer...</p>
  <script>
    BX24.init(function() {

      // Step 1: Register background worker
      BX24.callMethod('placement.bind', {
        PLACEMENT: 'PAGE_BACKGROUND_WORKER',
        HANDLER: 'https://exotel-websdk.onrender.com/background.html',
        TITLE: 'Exotel Background Worker'
      }, function(r1) {
        var e1 = r1.error ? r1.error() : null;
        if (e1 && e1.toString().indexOf('ERROR_PLACEMENT_MAX_COUNT') === -1) {
          console.warn('[Install] background placement warning:', e1.toString());
        } else {
          console.log('[Install] Background worker registered');
        }

        // Step 2: Register external telephony line
        // This makes Bitrix24 route CRM phone clicks to our app
        BX24.callMethod('telephony.externalLine.add', {
          LINE_NAME: 'Exotel',
          APP_ID: BX24.getAuth().client_id
        }, function(r2) {
          var e2 = r2.error ? r2.error() : null;
          if (e2) {
            console.warn('[Install] externalLine.add warning:', e2.toString());
          } else {
            console.log('[Install] External telephony line registered:', r2.data());
          }

          // Step 3: Subscribe to outbound call event
          BX24.callMethod('event.bind', {
            EVENT: 'OnExternalCallStart',
            HANDLER: 'https://exotel-websdk.onrender.com/bx24-call-start'
          }, function(r3) {
            console.log('[Install] OnExternalCallStart bound');
            document.getElementById('msg').innerText = 'Exotel Dialer Installed!';
            BX24.installFinish();
          });
        });
      });
    });
  </script>
</body>
</html>`);
});

// ── OnExternalCallStart webhook ────────────────────────────────
// Bitrix24 hits this when agent clicks a phone number in CRM
app.post('/bx24-call-start', async (req, res) => {
  console.log('[BX24-CallStart] Event received:', JSON.stringify(req.body));
  try {
    const eventData   = req.body.data || req.body;
    const phoneNumber = eventData.PHONE_NUMBER || '';
    const userId      = eventData.USER_ID || BX24_USER_ID;
    const callId      = eventData.CALL_ID || ('ext_' + Date.now());

    console.log(`[BX24-CallStart] Outbound to: ${phoneNumber} by user: ${userId}`);

    // Store pending call for background worker (WebRTC path)
    pendingOutboundCall = { number: phoneNumber, userId, callId, ts: Date.now() };

    // ── PRIMARY: Server-side Exotel outbound call ──────────────
    // More reliable than waiting for background.js WebRTC poll.
    // Exotel rings the agent's registered phone/softphone first,
    // then bridges to the customer (phoneNumber).
    try {
      const at = await getAppToken();

      // Look up the agent's virtual number from Exotel user mapping
      const mapRes = await fetch(
        `${BASE}/usermapping?user_id=${encodeURIComponent(EXOTEL_APP_USER_ID)}`,
        { headers: { 'Authorization': at } }
      );
      const mapData = await mapRes.json();
      const user = (mapData.Data && mapData.Data.Users && mapData.Data.Users.length > 0)
        ? mapData.Data.Users[0]
        : (mapData.Data && mapData.Data.SipId ? mapData.Data : null);
      // Use user's VirtualNumber from Exotel, or fall back to EXOTEL_VIRTUAL_NUMBER env var
      const virtualNumber = (user && user.VirtualNumber) || EXOTEL_VIRTUAL_NUMBER;

      if (virtualNumber && API_KEY && API_TOKEN && ACCOUNT_SID) {
        // Exotel Connect API: calls From (agent) then bridges to To (customer)
        const exotelHost = DOMAIN === 'singapore' ? 'api.exotel.in' : 'api.exotel.com';
        const callPayload = new URLSearchParams({
          From:           virtualNumber,
          To:             phoneNumber,
          CallerId:       virtualNumber,
          StatusCallback: 'https://exotel-websdk.onrender.com/call-callback'
        });
        // NOTE: Append .json to force JSON response — without it Exotel returns XML
        const callRes = await fetch(
          `https://${API_KEY}:${API_TOKEN}@${exotelHost}/v1/Accounts/${ACCOUNT_SID}/Calls/connect.json`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    callPayload
          }
        );
        const callRaw = await callRes.text();
        let callData = {};
        try { callData = JSON.parse(callRaw); } catch(e) { console.error('[BX24-CallStart] Non-JSON response from Exotel:', callRaw.slice(0, 200)); }
        console.log('[BX24-CallStart] Exotel call initiated:', JSON.stringify(callData));
        if (callData.Call && callData.Call.Sid) {
          // Replace the callId with Exotel's own SID so finish() works
          pendingOutboundCall.exotelSid = callData.Call.Sid;
        }
      } else {
        console.warn('[BX24-CallStart] Server-side call skipped — virtualNumber:', virtualNumber, 'API creds:', !!(API_KEY && API_TOKEN && ACCOUNT_SID));
      }
    } catch (callErr) {
      // Non-fatal: background.js WebRTC will attempt MakeCall as fallback
      console.error('[BX24-CallStart] Server-side Exotel call error:', callErr.message);
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[BX24-CallStart] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// Temporary store for pending outbound call (picked up by background.js poll)
let pendingOutboundCall = null;

// ── Background worker polls this to get pending call ──────────
app.get('/pending-call', (req, res) => {
  if (pendingOutboundCall && (Date.now() - pendingOutboundCall.ts) < 30000) {
    const call = pendingOutboundCall;
    pendingOutboundCall = null; // consume it
    res.json({ pending: true, number: call.number, callId: call.callId });
  } else {
    pendingOutboundCall = null;
    res.json({ pending: false });
  }
});

// Map: Exotel CallSid → BX24 CALL_ID (needed so /call-callback can finish the right BX24 call)
const inboundCallMap = {};

// ── Inbound call webhook (Exotel hits this as popup URL) ───────
// Set this URL in Exotel App Bazaar → Connect applet → Popup URL:
// https://exotel-websdk.onrender.com/incoming-call
// IMPORTANT: Exotel sends a GET request to this URL, not POST — use app.all
app.all('/incoming-call', async (req, res) => {
  // Exotel sends params as query string (GET) — merge body too for safety
  const params = Object.assign({}, req.query, req.body);
  console.log('[Incoming] Call received:', JSON.stringify(params));

  // Exotel fires this URL multiple times with different EventType values.
  // Only handle the initial ringing event — ignore free/terminal/completed events.
  const eventType = (params.EventType || params.Status || '').toLowerCase();
  if (eventType && (eventType === 'free' || eventType === 'terminal' || eventType === 'completed' || eventType === 'busy' || eventType === 'noanswer')) {
    console.log('[Incoming] Ignoring terminal event:', eventType);
    return res.json({ status: 'ignored' });
  }

  try {
    const callerNumber = params.From || params.CallFrom || params.caller_id ||
                         params.CallerId || params.callerid || 'Unknown';
    const callSid      = params.CallSid || params.call_sid || ('in_' + Date.now());
    const toNumber     = params.To || params.DialWhomNumber || params.CallTo || EXOTEL_VIRTUAL_NUMBER || 'Unknown';

    console.log(`[Incoming] From: ${callerNumber} To: ${toNumber} EventType: ${eventType}`);

    if (BX24_WEBHOOK) {
      // SHOW: 1 triggers the native Bitrix24 incoming call popup immediately
      // without needing a separate telephony.externalcall.show() call
      const registerResult = await bx24Call('telephony.externalcall.register', {
        USER_ID:         BX24_USER_ID,
        PHONE_NUMBER:    callerNumber,
        TYPE:            2,            // 2 = inbound call
        CALL_START_DATE: new Date().toISOString(),
        CRM_CREATE:      true,
        LINE_NUMBER:     toNumber,
        SHOW:            1             // Show native BX24 call popup right away
      });

      const bxCallId = (registerResult && registerResult.CALL_ID) || callSid;
      console.log('[Incoming] Registered in BX24, CALL_ID:', bxCallId);

      // Store mapping so /call-callback can finish the right BX24 call
      inboundCallMap[callSid] = bxCallId;

      pendingInboundCall = { from: callerNumber, callSid: bxCallId, ts: Date.now() };
      console.log('[Incoming] BX24 popup triggered, mapped', callSid, '→', bxCallId);
    } else {
      console.warn('[Incoming] BX24_WEBHOOK not set — skipping Bitrix24 notification');
    }

    res.json({ status: 'received' });
  } catch (err) {
    console.error('[Incoming] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// Temporary store for pending inbound call
let pendingInboundCall = null;

// ── Background worker polls this for incoming calls ────────────
app.get('/pending-inbound', (req, res) => {
  if (pendingInboundCall && (Date.now() - pendingInboundCall.ts) < 30000) {
    const call = pendingInboundCall;
    pendingInboundCall = null;
    res.json({ pending: true, from: call.from, callSid: call.callSid });
  } else {
    pendingInboundCall = null;
    res.json({ pending: false });
  }
});

// ── Call ended webhook ─────────────────────────────────────────
// Exotel posts here when any call (inbound or outbound) ends.
// BX24 needs its own CALL_ID — for inbound, look it up from inboundCallMap.
// For outbound, pendingOutboundCall.callId was the BX24 CALL_ID from OnExternalCallStart.
app.all('/call-callback', async (req, res) => {
  const params = Object.assign({}, req.query, req.body);
  console.log('[Callback] Call ended:', JSON.stringify(params));
  try {
    const exotelSid = params.CallSid || params.call_sid || '';
    const duration  = parseInt(params.Duration || params.duration || '0');
    const status    = params.Status  || params.status   || 'completed';

    // Resolve BX24 CALL_ID: inbound calls are in inboundCallMap; outbound used BX24's own callId
    const bxCallId = inboundCallMap[exotelSid] || exotelSid;
    // Clean up the map entry
    if (inboundCallMap[exotelSid]) delete inboundCallMap[exotelSid];

    if (BX24_WEBHOOK && bxCallId) {
      await bx24Call('telephony.externalcall.finish', {
        CALL_ID:     bxCallId,
        USER_ID:     BX24_USER_ID,
        DURATION:    duration,
        STATUS_CODE: status === 'completed' ? 200 : 304
      });
      console.log('[Callback] Call finished in BX24, CALL_ID:', bxCallId, 'duration:', duration);
    }

    res.json({ status: 'received' });
  } catch (err) {
    console.error('[Callback] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── Health ─────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:              'ok',
  customer_id_set:     !!CUSTOMER_ID,
  customer_secret_set: !!CUSTOMER_SECRET,
  app_id_set:          !!APP_ID,
  app_secret_set:      !!APP_SECRET,
  api_key_set:         !!API_KEY,
  api_token_set:       !!API_TOKEN,
  bx24_webhook_set:    !!BX24_WEBHOOK,
  bx24_user_id:        BX24_USER_ID,
  domain:              DOMAIN,
  app_id_value:        APP_ID || 'NOT SET'
}));

app.get('/debug',     async (req, res) => { try { const t = await getCustomerToken(); res.json({ success: true, message: '✅ Customer token OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/debug-app', async (req, res) => { try { const t = await getAppToken();     res.json({ success: true, message: '✅ App token OK' });      } catch(e) { res.status(500).json({ error: e.message }); } });

app.get('/setup', async (req, res) => {
  try {
    const ct = await getCustomerToken();
    const r  = await fetch(`${BASE}/app?entity=customer`, { headers: { 'Authorization': ct } });
    const data = JSON.parse(await r.text());
    const apps = data.Data || [];
    res.json({
      total_apps: apps.length,
      EXOTEL_APP_ID_in_env: APP_ID || 'NOT SET',
      apps: apps.map(a => ({ AppID: a.AppID, AppName: a.AppName, IsActive: a.IsActive, ExotelDomain: a.ExotelDomain, matched: a.AppID === APP_ID ? '✅' : '❌' }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/create-app', async (req, res) => {
  try {
    if (APP_ID && APP_SECRET) return res.status(400).json({ error: 'Already configured.', APP_ID });
    const ct = await getCustomerToken();
    const r  = await fetch(`${BASE}/app`, { method: 'POST', headers: { 'Authorization': ct, 'Content-Type': 'application/json' }, body: JSON.stringify({ AppName: 'BitrixDialer', ExotelAccountSid: ACCOUNT_SID, ExotelApiKey: API_KEY, ExotelApiToken: API_TOKEN, ExotelDomain: DOMAIN, IsActive: true }) });
    const data = JSON.parse(await r.text());
    if (!r.ok) throw new Error(JSON.stringify(data));
    res.json({ success: true, message: '✅ SAVE THESE NOW!', EXOTEL_APP_ID: data.Data.AppID, EXOTEL_APP_SECRET: data.Data.AppSecret });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/create-user', async (req, res) => {
  try {
    const { appUserId, appUsername, email, agentNumber, virtualNumber } = req.body;
    if (!appUserId || !appUsername || !email || !virtualNumber) return res.status(400).json({ error: 'Missing fields' });
    const at = await getAppToken();
    const r  = await fetch(`${BASE}/usermapping`, { method: 'POST', headers: { 'Authorization': at, 'Content-Type': 'application/json' }, body: JSON.stringify([{ AppUserId: appUserId, AppUsername: appUsername, Email: email, ExotelAccountSid: ACCOUNT_SID, ExotelUserName: appUsername, AgentNumber: agentNumber || '', VirtualNumber: virtualNumber }]) });
    const data = JSON.parse(await r.text());
    if (!r.ok) throw new Error(JSON.stringify(data));
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/list-users', async (req, res) => {
  try {
    const at = await getAppToken();
    const r  = await fetch(`${BASE}/usermapping`, { headers: { 'Authorization': at } });
    res.json(JSON.parse(await r.text()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RUNTIME: Token for WebRTC SDK ─────────────────────────────
app.get('/token', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const at   = await getAppToken();
    const r    = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(user_id)}`, { headers: { 'Authorization': at } });
    const data = JSON.parse(await r.text());
    if (!r.ok) throw new Error(`Failed [${r.status}]: ${JSON.stringify(data)}`);
    let user = data.Data?.Users?.length > 0 ? data.Data.Users[0] : (data.Data?.SipId ? data.Data : null);
    if (!user) throw new Error('User not found');
    res.json({ success: true, app_token: at, sip_id: user.SipId, sip_secret: user.SipSecret, virtual_number: user.VirtualNumber, user_id: user.AppUserId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Static files LAST ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
