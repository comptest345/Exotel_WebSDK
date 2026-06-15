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
const EXOTEL_APP_USER_ID = process.env.EXOTEL_APP_USER_ID || '123';
const EXOTEL_VIRTUAL_NUMBER = process.env.EXOTEL_VIRTUAL_NUMBER || '';

const BX24_WEBHOOK = process.env.BX24_WEBHOOK_URL || '';
const BX24_USER_ID = process.env.BX24_USER_ID || '1';
const BX24_DOMAIN  = process.env.BX24_DOMAIN || 'gsdny.bitrix24.in';

// ── In-memory call state (background.js is the single source of truth for SDK) ──
let callState = { state: 'idle', from: '', number: '', callId: '' };

// ── Pending action: popup → server → background.js ────────────
let pendingAction = null;

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

// ── Install — registers placements ────────────────────────────
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

        // Step 2: Register CRM sidebar dialer
        BX24.callMethod('placement.bind', {
          PLACEMENT: 'CRM_ACTIVITY_SIDEBAR',
          HANDLER: 'https://exotel-websdk.onrender.com/popup.html',
          TITLE: 'Exotel Dialer'
        }, function(rs) {
          console.log('[Install] Sidebar registered');

          // Step 3: Register external telephony line
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

            // Step 4: Subscribe to outbound call event
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
    });
  </script>
</body>
</html>`);
});

// ── OnExternalCallStart webhook ────────────────────────────────
// Bitrix24 hits this when agent clicks a phone number in CRM.
// Server stores the pending call — background.js does the actual MakeCall() via WebRTC.
app.post('/bx24-call-start', async (req, res) => {
  console.log('[BX24-CallStart] Event received:', JSON.stringify(req.body));
  try {
    const eventData   = req.body.data || req.body;
    const phoneNumber = eventData.PHONE_NUMBER || '';
    const userId      = eventData.USER_ID || BX24_USER_ID;
    const callId      = eventData.CALL_ID || ('ext_' + Date.now());

    console.log(`[BX24-CallStart] Outbound to: ${phoneNumber} by user: ${userId}`);

    // Store pending call — background.js will pick this up and call MakeCall()
    pendingOutboundCall = { number: phoneNumber, userId, callId, ts: Date.now() };
    console.log('[BX24-CallStart] Pending call stored, background.js will handle MakeCall()');

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[BX24-CallStart] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// Temporary store for pending outbound call (picked up by background.js poll)
let pendingOutboundCall = null;

// ── Background worker polls this to get pending outbound call ──
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

// ── Call state endpoints ───────────────────────────────────────

// GET /call-state — popup polls this every second to update its UI
app.get('/call-state', (req, res) => {
  res.json(callState);
});

// POST /update-call-state — background.js posts SDK state changes here
app.post('/update-call-state', (req, res) => {
  callState = Object.assign(callState, req.body);
  console.log('[CallState] Updated:', JSON.stringify(callState));
  res.json({ status: 'ok' });
});

// ── Action endpoints (popup → server → background.js) ─────────

// POST /call-action — popup sends user actions (answer / hangup / makecall)
app.post('/call-action', (req, res) => {
  const { action, number } = req.body;
  pendingAction = { action, number };
  console.log('[CallAction] Stored pending action:', JSON.stringify(pendingAction));
  res.json({ status: 'ok' });
});

// GET /pending-action — background.js polls this; consumed on read
app.get('/pending-action', (req, res) => {
  const action = pendingAction;
  pendingAction = null; // consume it
  res.json(action || null);
});

// Map: Exotel CallSid → BX24 CALL_ID
const inboundCallMap = {};

// ── Inbound call webhook (Exotel hits this as popup URL) ───────
app.all('/incoming-call', async (req, res) => {
  const params = Object.assign({}, req.query, req.body);
  console.log('[Incoming] Call received:', JSON.stringify(params));

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

      // Update shared call state so popup can show incoming panel
      callState = { state: 'incoming', from: callerNumber, number: toNumber, callId: bxCallId };
      console.log('[Incoming] callState updated to incoming');
    } else {
      console.warn('[Incoming] BX24_WEBHOOK not set — skipping Bitrix24 notification');
    }

    res.json({ status: 'received' });
  } catch (err) {
    console.error('[Incoming] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── Call ended webhook ─────────────────────────────────────────
app.all('/call-callback', async (req, res) => {
  const params = Object.assign({}, req.query, req.body);
  console.log('[Callback] Call ended:', JSON.stringify(params));
  try {
    const exotelSid = params.CallSid || params.call_sid || '';
    const duration  = parseInt(params.Duration || params.duration || '0');
    const status    = params.Status  || params.status   || 'completed';

    const bxCallId = inboundCallMap[exotelSid] || exotelSid;
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

    // Reset call state
    callState = { state: 'idle', from: '', number: '', callId: '' };
    console.log('[Callback] callState reset to idle');

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
  app_id_value:        APP_ID || 'NOT SET',
  call_state:          callState
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
