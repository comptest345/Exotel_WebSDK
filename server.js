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
const ACCOUNT_SID     = process.env.EXOTEL_ACCOUNT_SID;   // jkstar1
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

// ── Exotel region config ─────────────────────────────────────────
// Singapore: subdomain = api.exotel.com  → CCM base = https://api.exotel.com
// Mumbai:    subdomain = api.in.exotel.com → CCM base = https://api.in.exotel.com
//
// CCM basicauth endpoint:
//   POST https://<subdomain>/v2/accounts/<sid>/configuration/basicauth
//   Auth: Basic base64(API_KEY:API_TOKEN)
//
const isIndia = (DOMAIN === 'mumbai' || DOMAIN === 'india');
const CCM_BASE       = isIndia ? 'https://api.in.exotel.com'  : 'https://api.exotel.com';
const SIP_DOMAIN_FB  = isIndia ? 'voip.in1.exotel.com'        : 'voip.sgp1.exotel.com';

// ── In-memory state ──────────────────────────────────────────────
let pendingOutboundCall = null;
let pendingInboundCall  = null;
const inboundCallMap    = {};
let pollCount = 0;

// ── Exotel integration token helpers ────────────────────────────
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

// ── CCM access token for WebRTC SDK ─────────────────────────────
// Singapore: POST https://api.exotel.com/v2/accounts/jkstar1/configuration/basicauth
// Returns: { "access_token": "<jwt>" }
async function getCCMAccessToken() {
  if (!ACCOUNT_SID || !API_KEY || !API_TOKEN) {
    throw new Error('EXOTEL_ACCOUNT_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN must all be set');
  }
  const credentials = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
  const url = `${CCM_BASE}/v2/accounts/${ACCOUNT_SID}/configuration/basicauth`;

  console.log('[CCM] POST', url);

  const res  = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Basic ${credentials}`
    }
  });

  const raw  = await res.text();
  console.log('[CCM] status:', res.status, 'body:', raw.slice(0, 300));

  let data;
  try { data = JSON.parse(raw); } catch(e) { throw new Error(`CCM returned non-JSON [${res.status}]: ${raw.slice(0,200)}`); }

  if (!res.ok) throw new Error(`CCM basicauth failed [${res.status}]: ${JSON.stringify(data)}`);

  const token = data.access_token
    || data.AccessToken
    || data.token
    || data.data?.access_token
    || data.Data?.access_token
    || data.data?.AccessToken
    || data.Data?.AccessToken;

  if (!token) throw new Error('CCM basicauth returned no access_token. Full response: ' + JSON.stringify(data));
  return token;
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

// ── Serve HTML files ─────────────────────────────────────────────
app.all('/popup.html',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'popup.html')));
app.all('/background.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'background.html')));

// ── Install ──────────────────────────────────────────────────────
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
        HANDLER:   'https://exotel-websdk.onrender.com/popup.html',
        TITLE:     'Exotel Dialer'
      }, function(r1) {
        var e1 = r1.error ? r1.error() : null;
        if (e1) {
          console.warn('[Install] CRM_ACTIVITY_SIDEBAR warning:', e1.toString());
        } else {
          console.log('[Install] CRM_ACTIVITY_SIDEBAR registered');
        }
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

// ── OnExternalCallStart ──────────────────────────────────────────
app.post('/bx24-call-start', async (req, res) => {
  console.log('[BX24-CallStart] Received:', JSON.stringify(req.body));
  try {
    const eventData   = req.body.data || req.body;
    const phoneNumber = eventData.PHONE_NUMBER || '';
    const userId      = eventData.USER_ID      || BX24_USER_ID;
    const callId      = eventData.CALL_ID      || ('ext_' + Date.now());
    console.log(`[BX24-CallStart] Outbound to: ${phoneNumber}, userId: ${userId}, callId: ${callId}`);
    pendingOutboundCall = { number: phoneNumber, userId, callId, ts: Date.now() };
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[BX24-CallStart] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── /pending-call ────────────────────────────────────────────────
app.get('/pending-call', (req, res) => {
  pollCount++;
  if (pollCount % 20 === 1) console.log('[Poll] /pending-call hit #' + pollCount + ' (popup.js alive)');
  if (pendingOutboundCall && (Date.now() - pendingOutboundCall.ts) < 30000) {
    const call      = pendingOutboundCall;
    pendingOutboundCall = null;
    console.log('[Poll] /pending-call → delivering:', call.number);
    res.json({ pending: true, number: call.number, callId: call.callId });
  } else {
    if (pendingOutboundCall) pendingOutboundCall = null;
    res.json({ pending: false });
  }
});

// ── /incoming-call ───────────────────────────────────────────────
app.all('/incoming-call', async (req, res) => {
  const params = Object.assign({}, req.query, req.body);
  console.log('[Incoming] Received:', JSON.stringify(params));
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
      const result = await bx24Call('telephony.externalcall.register', {
        USER_ID:         BX24_USER_ID,
        PHONE_NUMBER:    callerNumber,
        TYPE:            2,
        CALL_START_DATE: new Date().toISOString(),
        CRM_CREATE:      true,
        LINE_NUMBER:     toNumber,
        SHOW:            1
      });
      const bxCallId = (result && result.CALL_ID) || callSid;
      console.log('[Incoming] BX24 registered, CALL_ID:', bxCallId);
      inboundCallMap[callSid] = bxCallId;
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

// ── /pending-inbound ─────────────────────────────────────────────
app.get('/pending-inbound', (req, res) => {
  if (pendingInboundCall && (Date.now() - pendingInboundCall.ts) < 30000) {
    const call     = pendingInboundCall;
    pendingInboundCall = null;
    console.log('[Poll] /pending-inbound → delivering from:', call.from);
    res.json({ pending: true, from: call.from, callSid: call.callSid });
  } else {
    if (pendingInboundCall) pendingInboundCall = null;
    res.json({ pending: false });
  }
});

// ── /call-callback ───────────────────────────────────────────────
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
      console.log('[Callback] BX24 call finished, CALL_ID:', bxCallId, 'duration:', duration + 's');
    }
    res.json({ status: 'received' });
  } catch (err) {
    console.error('[Callback] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── Client-side log relay ────────────────────────────────────────
app.post('/client-log', (req, res) => {
  console.log('[ClientLog]', JSON.stringify(req.body));
  res.json({ status: 'ok' });
});

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:              'ok',
  account_sid:         ACCOUNT_SID || 'NOT SET',
  customer_id_set:     !!CUSTOMER_ID,
  customer_secret_set: !!CUSTOMER_SECRET,
  app_id_set:          !!APP_ID,
  app_secret_set:      !!APP_SECRET,
  api_key_set:         !!API_KEY,
  api_token_set:       !!API_TOKEN,
  bx24_webhook_set:    !!BX24_WEBHOOK,
  bx24_user_id:        BX24_USER_ID,
  domain:              DOMAIN,
  ccm_base:            CCM_BASE,
  sip_domain_fb:       SIP_DOMAIN_FB,
  app_user_id:         APP_USER_ID,
  virtual_number_set:  !!VIRTUAL_NUMBER
}));

// ── Debug endpoints ──────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  try { await getCustomerToken(); res.json({ success: true, message: '✅ Customer token OK' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-app', async (req, res) => {
  try { await getAppToken(); res.json({ success: true, message: '✅ App token OK' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Test CCM token — visit this after deploy to verify access_token works
app.get('/debug-ccm-token', async (req, res) => {
  try {
    const token = await getCCMAccessToken();
    res.json({ success: true, message: '✅ CCM access_token obtained', token_preview: token.slice(0, 40) + '...' });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
        AppUserId:        appUserId,
        AppUsername:      appUsername,
        Email:            email,
        ExotelAccountSid: ACCOUNT_SID,
        ExotelUserName:   appUsername,
        AgentNumber:      agentNumber || '',
        VirtualNumber:    virtualNumber
      }])
    });
    const data = JSON.parse(await r.text());
    if (!r.ok) throw new Error(JSON.stringify(data));
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── /token — popup.js calls this on load ─────────────────────────
// Returns CCM JWT (access_token) + app_user_id for SDK constructor.
app.get('/token', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const accessToken = await getCCMAccessToken();
    console.log('[Token] CCM access_token issued for user_id:', user_id);

    res.json({
      success:      true,
      access_token: accessToken,  // → ExotelCRMWebSDK constructor arg 1
      app_user_id:  user_id       // → ExotelCRMWebSDK constructor arg 2
    });
  } catch(e) {
    console.error('[Token] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Static files — MUST be last ──────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Exotel WebSDK server running on port ${PORT} | CCM: ${CCM_BASE} | SIP: ${SIP_DOMAIN_FB}`));
