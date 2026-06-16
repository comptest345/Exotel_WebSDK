const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Env vars ────────────────────────────────────────────────────
const BASE            = 'https://integrationscore.mum1.exotel.com/v2/integrations';
const CUSTOMER_ID     = process.env.EXOTEL_CUSTOMER_ID;
const CUSTOMER_SECRET = process.env.EXOTEL_CUSTOMER_SECRET;
const ACCOUNT_SID     = process.env.EXOTEL_ACCOUNT_SID;
const API_KEY         = process.env.EXOTEL_API_KEY;
const API_TOKEN       = process.env.EXOTEL_API_TOKEN;
const DOMAIN          = process.env.EXOTEL_DOMAIN || 'singapore';   // e.g. "singapore"
const APP_ID          = process.env.EXOTEL_APP_ID;
const APP_SECRET      = process.env.EXOTEL_APP_SECRET;
const APP_USER_ID     = process.env.EXOTEL_APP_USER_ID || '123';
const VIRTUAL_NUMBER  = process.env.EXOTEL_VIRTUAL_NUMBER || '';

const BX24_WEBHOOK    = process.env.BX24_WEBHOOK_URL || '';
const BX24_USER_ID    = process.env.BX24_USER_ID || '1';
const BX24_DOMAIN     = process.env.BX24_DOMAIN   || 'gsdny.bitrix24.in';

// ── In-memory state ─────────────────────────────────────────────
let pendingOutboundCall = null;   // set by /bx24-call-start, consumed by /pending-call
let pendingInboundCall  = null;   // set by /incoming-call,   consumed by /pending-inbound
const inboundCallMap    = {};     // exotelSid → BX24 CALL_ID
let pollCount = 0;

// ── Exotel token helpers ─────────────────────────────────────────
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
  const res  = await fetch(`${BASE}/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ Id: APP_ID, Secret: APP_SECRET, Entity: 'app' })
  });
  const data = JSON.parse(await res.text());
  if (!res.ok) throw new Error(`App token failed: ${JSON.stringify(data)}`);
  return data.Data;
}

// ── Bitrix24 REST helper ─────────────────────────────────────────
async function bx24Call(method, params) {
  if (!BX24_WEBHOOK) throw new Error('BX24_WEBHOOK_URL not set');
  const url = `${BX24_WEBHOOK}${method}.json`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params)
  });
  const data = await res.json();
  if (data.error) throw new Error(`BX24 ${method}: ${data.error} — ${data.error_description}`);
  return data.result;
}

// ── Serve HTML files (handle both GET and POST) ──────────────────
app.all('/popup.html',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'popup.html')));
app.all('/background.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'background.html')));

// ── Install ──────────────────────────────────────────────────────
// Registers CRM_ACTIVITY_SIDEBAR placement + telephony line + event handler
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

      // Step 1: Register the popup dialer inside CRM sidebar
      // This is a VISIBLE iframe so microphone permission works correctly.
      // The SDK (WebRTC) runs here, not in a hidden background worker.
      BX24.callMethod('placement.bind', {
        PLACEMENT: 'CRM_ACTIVITY_SIDEBAR',
        HANDLER:   'https://exotel-websdk.onrender.com/popup.html',
        TITLE:     'Exotel Dialer'
      }, function(r1) {
        var e1 = r1.error ? r1.error() : null;
        if (e1) {
          console.warn('[Install] CRM_ACTIVITY_SIDEBAR warning:', e1.toString());
        } else {
          console.log('[Install] CRM_ACTIVITY_SIDEBAR registered');
        }

        // Step 2: Register Exotel as an external telephony line in Bitrix24.
        // This makes phone number clicks in CRM route to our app via OnExternalCallStart.
        BX24.callMethod('telephony.externalLine.add', {
          LINE_NAME: 'Exotel',
          APP_ID:    BX24.getAuth().client_id
        }, function(r2) {
          var e2 = r2.error ? r2.error() : null;
          if (e2) {
            console.warn('[Install] externalLine.add warning:', e2.toString());
          } else {
            console.log('[Install] External telephony line registered:', r2.data());
          }

          // Step 3: Subscribe to outbound call event.
          // Fires when agent clicks a phone number in CRM — our server receives it,
          // stores the number, and popup.js picks it up via /pending-call poll.
          BX24.callMethod('event.bind', {
            EVENT:   'OnExternalCallStart',
            HANDLER: 'https://exotel-websdk.onrender.com/bx24-call-start'
          }, function(r3) {
            console.log('[Install] OnExternalCallStart bound');
            document.getElementById('msg').innerText = '✅ Exotel Dialer Installed!';
            BX24.installFinish();
          });
        });
      });
    });
  </script>
</body>
</html>`);
});

// ── OnExternalCallStart (agent clicked phone number in CRM) ──────
// Bitrix24 posts here when an agent clicks a phone number.
// We store the number so popup.js can pick it up via /pending-call.
// NOTE: We do NOT make a server-side Exotel call here anymore.
//       The WebRTC SDK in popup.js calls MakeCall() directly —
//       no need for the agent to accept a separate softphone ring.
app.post('/bx24-call-start', async (req, res) => {
  console.log('[BX24-CallStart] Received:', JSON.stringify(req.body));
  try {
    const eventData   = req.body.data || req.body;
    const phoneNumber = eventData.PHONE_NUMBER || '';
    const userId      = eventData.USER_ID      || BX24_USER_ID;
    const callId      = eventData.CALL_ID      || ('ext_' + Date.now());

    console.log(`[BX24-CallStart] Outbound to: ${phoneNumber}, userId: ${userId}, callId: ${callId}`);

    // Store for popup.js to consume via /pending-call
    pendingOutboundCall = { number: phoneNumber, userId, callId, ts: Date.now() };

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[BX24-CallStart] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── /pending-call — popup.js polls this for BX24-originated outbound calls ──
app.get('/pending-call', (req, res) => {
  pollCount++;
  if (pollCount % 20 === 1) console.log('[Poll] /pending-call hit #' + pollCount + ' (popup.js alive)');

  if (pendingOutboundCall && (Date.now() - pendingOutboundCall.ts) < 30000) {
    const call      = pendingOutboundCall;
    pendingOutboundCall = null;  // consume
    console.log('[Poll] /pending-call → delivering:', call.number);
    res.json({ pending: true, number: call.number, callId: call.callId });
  } else {
    if (pendingOutboundCall) pendingOutboundCall = null;
    res.json({ pending: false });
  }
});

// ── /incoming-call — Exotel posts/gets here when an inbound call arrives ────
// Set this URL in Exotel App Bazaar → your app → Popup URL:
//   https://exotel-websdk.onrender.com/incoming-call
// Exotel fires GET with query params. We register the call in BX24 and
// store it so popup.js can show the ringing UI via /pending-inbound.
app.all('/incoming-call', async (req, res) => {
  const params = Object.assign({}, req.query, req.body);
  console.log('[Incoming] Received:', JSON.stringify(params));

  // Exotel sends multiple events (ringing, terminal, free…) — only handle ringing
  const eventType = (params.EventType || params.Status || '').toLowerCase();
  if (['free', 'terminal', 'completed', 'busy', 'noanswer'].includes(eventType)) {
    console.log('[Incoming] Ignoring terminal event:', eventType);
    return res.json({ status: 'ignored' });
  }

  try {
    const callerNumber = params.From || params.CallFrom || params.caller_id ||
                         params.CallerId || params.callerid || 'Unknown';
    const callSid      = params.CallSid || params.call_sid || ('in_' + Date.now());
    const toNumber     = params.To || params.DialWhomNumber || params.CallTo ||
                         VIRTUAL_NUMBER || 'Unknown';

    console.log(`[Incoming] From: ${callerNumber}, To: ${toNumber}, EventType: ${eventType}`);

    if (BX24_WEBHOOK) {
      // Register with BX24 — SHOW:1 pops the native BX24 call notification
      const result = await bx24Call('telephony.externalcall.register', {
        USER_ID:         BX24_USER_ID,
        PHONE_NUMBER:    callerNumber,
        TYPE:            2,              // 2 = inbound
        CALL_START_DATE: new Date().toISOString(),
        CRM_CREATE:      true,
        LINE_NUMBER:     toNumber,
        SHOW:            1               // shows BX24 native call popup
      });

      const bxCallId = (result && result.CALL_ID) || callSid;
      console.log('[Incoming] BX24 registered, CALL_ID:', bxCallId);
      inboundCallMap[callSid] = bxCallId;

      // Store so popup.js polls and shows ringing UI
      pendingInboundCall = { from: callerNumber, callSid: bxCallId, ts: Date.now() };
    } else {
      console.warn('[Incoming] BX24_WEBHOOK not set — skipping BX24 notification');
      pendingInboundCall = { from: callerNumber, callSid, ts: Date.now() };
    }

    res.json({ status: 'received' });
  } catch (err) {
    console.error('[Incoming] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── /pending-inbound — popup.js polls this for inbound calls ────
app.get('/pending-inbound', (req, res) => {
  if (pendingInboundCall && (Date.now() - pendingInboundCall.ts) < 30000) {
    const call     = pendingInboundCall;
    pendingInboundCall = null;  // consume
    console.log('[Poll] /pending-inbound → delivering from:', call.from);
    res.json({ pending: true, from: call.from, callSid: call.callSid });
  } else {
    if (pendingInboundCall) pendingInboundCall = null;
    res.json({ pending: false });
  }
});

// ── /call-callback — Exotel posts here when any call ends ───────
// Configure in Exotel: StatusCallback = https://exotel-websdk.onrender.com/call-callback
app.all('/call-callback', async (req, res) => {
  const params = Object.assign({}, req.query, req.body);
  console.log('[Callback] Call ended:', JSON.stringify(params));
  try {
    const exotelSid = params.CallSid || params.call_sid || '';
    const duration  = parseInt(params.Duration || params.duration || '0');
    const status    = params.Status  || params.status   || 'completed';

    // Resolve BX24 CALL_ID — inbound calls are mapped, outbound used BX24's callId
    const bxCallId = inboundCallMap[exotelSid] || exotelSid;
    if (inboundCallMap[exotelSid]) delete inboundCallMap[exotelSid];

    if (BX24_WEBHOOK && bxCallId) {
      await bx24Call('telephony.externalcall.finish', {
        CALL_ID:     bxCallId,
        USER_ID:     BX24_USER_ID,
        DURATION:    duration,
        STATUS_CODE: status === 'completed' ? 200 : 304
      });
      console.log('[Callback] BX24 call finished, CALL_ID:', bxCallId, 'duration:', duration + 's');
    }

    res.json({ status: 'received' });
  } catch (err) {
    console.error('[Callback] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── Client-side log relay (popup.js → Render logs) ──────────────
app.post('/client-log', (req, res) => {
  console.log('[ClientLog]', JSON.stringify(req.body));
  res.json({ status: 'ok' });
});

// ── Health check ─────────────────────────────────────────────────
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
  app_user_id:         APP_USER_ID,
  virtual_number_set:  !!VIRTUAL_NUMBER
}));

// ── Debug / Setup endpoints ──────────────────────────────────────
app.get('/debug',     async (req, res) => {
  try { await getCustomerToken(); res.json({ success: true, message: '✅ Customer token OK' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-app', async (req, res) => {
  try { await getAppToken(); res.json({ success: true, message: '✅ App token OK' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-token', async (req, res) => {
  try {
    const user_id = req.query.user_id || APP_USER_ID;
    const at  = await getAppToken();
    const r   = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(user_id)}`, { headers: { 'Authorization': at } });
    const raw = await r.text();
    res.json({ status: r.status, raw: JSON.parse(raw) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/setup', async (req, res) => {
  try {
    const ct   = await getCustomerToken();
    const r    = await fetch(`${BASE}/app?entity=customer`, { headers: { 'Authorization': ct } });
    const data = JSON.parse(await r.text());
    const apps = data.Data || [];
    res.json({
      EXOTEL_APP_ID_in_env: APP_ID || 'NOT SET',
      apps: apps.map(a => ({
        AppID:        a.AppID,
        AppName:      a.AppName,
        IsActive:     a.IsActive,
        ExotelDomain: a.ExotelDomain,
        matched:      a.AppID === APP_ID ? '✅' : '❌'
      }))
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

app.post('/create-user', async (req, res) => {
  try {
    const { appUserId, appUsername, email, agentNumber, virtualNumber } = req.body;
    if (!appUserId || !appUsername || !email || !virtualNumber)
      return res.status(400).json({ error: 'Missing fields: appUserId, appUsername, email, virtualNumber required' });
    const at = await getAppToken();
    const r  = await fetch(`${BASE}/usermapping`, {
      method:  'POST',
      headers: { 'Authorization': at, 'Content-Type': 'application/json' },
      body:    JSON.stringify([{
        AppUserId:       appUserId,
        AppUsername:     appUsername,
        Email:           email,
        ExotelAccountSid: ACCOUNT_SID,
        ExotelUserName:  appUsername,
        AgentNumber:     agentNumber || '',
        VirtualNumber:   virtualNumber
      }])
    });
    const data = JSON.parse(await r.text());
    if (!r.ok) throw new Error(JSON.stringify(data));
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── /token — WebRTC SDK credential endpoint ──────────────────────
// Returns app_token (for SDK auth) + sip_id + sip_secret (SIP credentials).
// popup.js calls: new ExotelCRMWebSDK(data.app_token, EXOTEL_APP_USER_ID, false)
app.get('/token', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const at   = await getAppToken();
    const r    = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(user_id)}`, {
      headers: { 'Authorization': at }
    });
    const data = JSON.parse(await r.text());
    if (!r.ok) throw new Error(`Usermapping failed [${r.status}]: ${JSON.stringify(data)}`);

    // Handle both response shapes the API returns
    let user = data.Data?.Users?.length > 0
      ? data.Data.Users[0]
      : (data.Data?.SipId ? data.Data : null);

    if (!user) throw new Error('User not found in usermapping: ' + JSON.stringify(data));

    console.log('[Token] Returning credentials for user', user_id, '| sip_id:', user.SipId);

    res.json({
      success:        true,
      app_token:      at,
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

// ── Static files — MUST be last ──────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Exotel WebSDK server running on port ${PORT}`));
