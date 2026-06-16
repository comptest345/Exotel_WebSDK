const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BASE            = 'https://integrationscore.mum1.exotel.com/v2/integrations';
const CUSTOMER_ID     = process.env.EXOTEL_CUSTOMER_ID;
const CUSTOMER_SECRET = process.env.EXOTEL_CUSTOMER_SECRET;
const ACCOUNT_SID     = process.env.EXOTEL_ACCOUNT_SID;
const API_KEY         = process.env.EXOTEL_API_KEY;
const API_TOKEN       = process.env.EXOTEL_API_TOKEN;
const DOMAIN          = process.env.EXOTEL_DOMAIN || 'singapore';
const SUBDOMAIN       = process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
const APP_ID          = process.env.EXOTEL_APP_ID;
const APP_SECRET      = process.env.EXOTEL_APP_SECRET;
const EXOTEL_APP_USER_ID = process.env.EXOTEL_APP_USER_ID || '123';
const EXOTEL_VIRTUAL_NUMBER = process.env.EXOTEL_VIRTUAL_NUMBER || '';

const BX24_WEBHOOK = process.env.BX24_WEBHOOK_URL || '';
const BX24_USER_ID = process.env.BX24_USER_ID || '1';
const BX24_DOMAIN  = process.env.BX24_DOMAIN || 'gsdny.bitrix24.in';

// Build the SIP WebSocket domain from env:
// EXOTEL_DOMAIN=singapore → SIP domain = "singapore.exotel.com"
// The SDK builds: wss://singapore.exotel.com:8089/ws
function getSipDomain() {
  // If DOMAIN already contains a dot (e.g. "api.exotel.com"), use as-is
  if (DOMAIN.includes('.')) return DOMAIN;
  // Otherwise append ".exotel.com"
  return DOMAIN + '.exotel.com';
}

let callState = { state: 'idle', from: '', number: '', callId: '' };
let pendingAction = null;
let pendingOutboundCall = null;
let pollCount = 0;
const inboundCallMap = {};

// ── Exotel token helpers ────────────────────────────────────────
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

// ── Bitrix24 REST helper ────────────────────────────────────────
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

app.all('/popup.html',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'popup.html')));
app.all('/background.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'background.html')));

// ── Install ─────────────────────────────────────────────────────
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
      BX24.callMethod('placement.bind', {
        PLACEMENT: 'CRM_ACTIVITY_SIDEBAR',
        HANDLER: 'https://exotel-websdk.onrender.com/popup.html',
        TITLE: 'Exotel Dialer'
      }, function(rs) {
          console.log('[Install] Sidebar registered');
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

// ── OnExternalCallStart webhook ─────────────────────────────────
app.post('/bx24-call-start', async (req, res) => {
  console.log('[BX24-CallStart] Event received:', JSON.stringify(req.body));
  try {
    const eventData   = req.body.data || req.body;
    const phoneNumber = eventData.PHONE_NUMBER || '';
    const userId      = eventData.USER_ID || BX24_USER_ID;
    const callId      = eventData.CALL_ID || ('ext_' + Date.now());

    console.log(`[BX24-CallStart] Outbound to: ${phoneNumber} by user: ${userId}`);
    pendingOutboundCall = { number: phoneNumber, userId, callId, ts: Date.now() };
    console.log('[BX24-CallStart] Pending call stored');

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[BX24-CallStart] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── Poll endpoints ──────────────────────────────────────────────
app.get('/pending-call', (req, res) => {
  pollCount++;
  if (pollCount % 15 === 1) console.log('[Poll] /pending-call hit #' + pollCount + ' (popup.js is alive)');
  if (pendingOutboundCall && (Date.now() - pendingOutboundCall.ts) < 60000) {
    const call = pendingOutboundCall;
    pendingOutboundCall = null;
    console.log('[Poll] /pending-call → delivered:', call.number);
    res.json({ pending: true, number: call.number, callId: call.callId });
  } else {
    if (pendingOutboundCall) pendingOutboundCall = null;
    res.json({ pending: false });
  }
});

app.get('/call-state', (req, res) => res.json(callState));

app.post('/update-call-state', (req, res) => {
  callState = Object.assign(callState, req.body);
  console.log('[CallState] Updated:', JSON.stringify(callState));
  res.json({ status: 'ok' });
});

app.post('/call-action', (req, res) => {
  const { action, number } = req.body;
  pendingAction = { action, number };
  console.log('[CallAction] Stored pending action:', JSON.stringify(pendingAction));
  res.json({ status: 'ok' });
});

app.get('/pending-action', (req, res) => {
  const action = pendingAction;
  pendingAction = null;
  if (action) console.log('[Poll] /pending-action → delivered:', JSON.stringify(action));
  res.json(action || null);
});

// ── Inbound call webhook ────────────────────────────────────────
app.all('/incoming-call', async (req, res) => {
  const params = Object.assign({}, req.query, req.body);
  console.log('[Incoming] Call received:', JSON.stringify(params));

  const eventType = (params.EventType || params.Status || '').toLowerCase();
  if (eventType && ['free', 'terminal', 'completed', 'busy', 'noanswer'].includes(eventType)) {
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
      const registerResult = await bx24Call('telephony.externalcall.register', {
        USER_ID:         BX24_USER_ID,
        PHONE_NUMBER:    callerNumber,
        TYPE:            2,
        CALL_START_DATE: new Date().toISOString(),
        CRM_CREATE:      true,
        LINE_NUMBER:     toNumber,
        SHOW:            1
      });
      const bxCallId = (registerResult && registerResult.CALL_ID) || callSid;
      console.log('[Incoming] Registered in BX24, CALL_ID:', bxCallId);
      inboundCallMap[callSid] = bxCallId;
      callState = { state: 'incoming', from: callerNumber, number: toNumber, callId: bxCallId };
    } else {
      console.warn('[Incoming] BX24_WEBHOOK not set — skipping Bitrix24 notification');
    }

    res.json({ status: 'received' });
  } catch (err) {
    console.error('[Incoming] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── Call ended webhook ──────────────────────────────────────────
app.all('/call-callback', async (req, res) => {
  const params = Object.assign({}, req.query, req.body);
  console.log('[Callback] Call ended:', JSON.stringify(params));
  try {
    const exotelSid = params.CallSid || params.call_sid || '';
    const duration  = parseInt(params.Duration || params.duration || '0');
    const status    = params.Status  || params.status   || 'completed';
    const bxCallId  = inboundCallMap[exotelSid] || exotelSid;
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

    callState = { state: 'idle', from: '', number: '', callId: '' };
    res.json({ status: 'received' });
  } catch (err) {
    console.error('[Callback] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── Client-side log reporting ───────────────────────────────────
app.post('/client-log', (req, res) => {
  console.log('[ClientLog]', JSON.stringify(req.body));
  res.json({ status: 'ok' });
});

app.post('/heartbeat', (req, res) => {
  console.log('[Heartbeat] alive — sdkReady:', req.body.sdkReady);
  res.json({ status: 'ok' });
});

// ── Health ──────────────────────────────────────────────────────
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
  sip_domain:          getSipDomain(),
  call_state:          callState
}));

app.get('/debug',     async (req, res) => { try { await getCustomerToken(); res.json({ success: true, message: '✅ Customer token OK' }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/debug-app', async (req, res) => { try { await getAppToken();     res.json({ success: true, message: '✅ App token OK' });      } catch(e) { res.status(500).json({ error: e.message }); } });

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

app.get('/list-users', async (req, res) => {
  try {
    const at = await getAppToken();
    const r  = await fetch(`${BASE}/usermapping`, { headers: { 'Authorization': at } });
    res.json(JSON.parse(await r.text()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RUNTIME: Token for WebRTC SDK ───────────────────────────────
// Returns sip_id, sip_secret PLUS sip_domain and sip_port so
// popup.js can build the full sipAccountInfo the SDK needs.
app.get('/token', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const at   = await getAppToken();
    const r    = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(user_id)}`, { headers: { 'Authorization': at } });
    const data = JSON.parse(await r.text());
    if (!r.ok) throw new Error(`Failed [${r.status}]: ${JSON.stringify(data)}`);

    let user = data.Data?.Users?.length > 0
      ? data.Data.Users[0]
      : (data.Data?.SipId ? data.Data : null);
    if (!user) throw new Error('User not found in usermapping response: ' + JSON.stringify(data));

    const sipDomain = getSipDomain();

    console.log('[Token] Returning SIP credentials for user', user_id, {
      sip_id: user.SipId,
      sip_domain: sipDomain,
      sip_port: 8089
    });

    res.json({
      success:        true,
      app_token:      at,
      sip_id:         user.SipId,
      sip_secret:     user.SipSecret,
      sip_domain:     sipDomain,   // e.g. "singapore.exotel.com"
      sip_port:       8089,        // WSS port (SDK uses wss://domain:8089/ws)
      virtual_number: user.VirtualNumber,
      user_id:        user.AppUserId
    });
  } catch(e) {
    console.error('[Token] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Diagnostic endpoints ────────────────────────────────────────
app.get('/check-placements', async (req, res) => {
  try {
    const sideResult = await bx24Call('placement.get', { PLACEMENT: 'CRM_ACTIVITY_SIDEBAR' });
    res.json({ CRM_ACTIVITY_SIDEBAR: sideResult });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug: what does /token return right now?
app.get('/debug-token', async (req, res) => {
  try {
    const user_id = req.query.user_id || EXOTEL_APP_USER_ID;
    const at = await getAppToken();
    const r  = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(user_id)}`, { headers: { 'Authorization': at } });
    const raw = await r.text();
    res.json({ status: r.status, raw_response: JSON.parse(raw), sip_domain_computed: getSipDomain() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Static files LAST ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
