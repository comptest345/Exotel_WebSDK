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
const DOMAIN          = process.env.EXOTEL_DOMAIN || 'singapore';
const APP_ID          = process.env.EXOTEL_APP_ID;
const APP_SECRET      = process.env.EXOTEL_APP_SECRET;
const APP_USER_ID     = process.env.EXOTEL_APP_USER_ID || '123';
const VIRTUAL_NUMBER  = process.env.EXOTEL_VIRTUAL_NUMBER || '';

const BX24_WEBHOOK    = process.env.BX24_WEBHOOK_URL || '';
const BX24_USER_ID    = process.env.BX24_USER_ID || '1';
const BX24_DOMAIN     = process.env.BX24_DOMAIN   || 'gsdny.bitrix24.in';

const isIndia    = (DOMAIN === 'mumbai' || DOMAIN === 'india');
const CCM_BASE   = isIndia ? 'https://api.in.exotel.com' : 'https://api.exotel.com';
const SIP_FB     = isIndia ? 'voip.in1.exotel.com'       : 'voip.sgp1.exotel.com';

// ── In-memory state ──────────────────────────────────────────────
let pendingOutboundCall = null;
let pendingInboundCall  = null;
const inboundCallMap    = {};
let pollCount = 0;

// ── Token helpers ───────────────────────────────────────────────
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

async function getCCMAccessToken() {
  if (!ACCOUNT_SID || !API_KEY || !API_TOKEN)
    throw new Error('EXOTEL_ACCOUNT_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN must all be set');

  const credentials = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
  const url = `${CCM_BASE}/v2/accounts/${ACCOUNT_SID}/configuration/basicauth`;
  console.log('[CCM] POST', url);

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${credentials}` }
  });
  const raw = await res.text();
  console.log('[CCM] status:', res.status, 'body:', raw.slice(0, 400));

  let data;
  try { data = JSON.parse(raw); }
  catch(e) { throw new Error(`CCM non-JSON [${res.status}]: ${raw.slice(0, 300)}`); }

  if (!res.ok) throw new Error(`CCM failed [${res.status}]: ${JSON.stringify(data)}`);

  const token = data.access_token || data.AccessToken || data.token
    || data.data?.access_token || data.Data?.access_token
    || data.data?.AccessToken  || data.Data?.AccessToken;

  if (!token) throw new Error('No access_token in response: ' + JSON.stringify(data));
  return token;
}

// ── Bitrix24 helper ──────────────────────────────────────────────
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

// ── Serve HTML ───────────────────────────────────────────────────
app.all('/popup.html',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'popup.html')));
app.all('/background.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'background.html')));

// ── Install ──────────────────────────────────────────────────────
app.all('/install', (req, res) => {
  console.log('[Install] Called');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="//api.bitrix24.com/api/v1/"></script></head><body><p id="msg">Installing Exotel Dialer...</p><script>BX24.init(function(){BX24.callMethod('placement.bind',{PLACEMENT:'CRM_ACTIVITY_SIDEBAR',HANDLER:'https://exotel-websdk.onrender.com/popup.html',TITLE:'Exotel Dialer'},function(r1){BX24.callMethod('telephony.externalLine.add',{LINE_NAME:'Exotel',APP_ID:BX24.getAuth().client_id},function(r2){BX24.callMethod('event.bind',{EVENT:'OnExternalCallStart',HANDLER:'https://exotel-websdk.onrender.com/bx24-call-start'},function(r3){document.getElementById('msg').innerText='✅ Installed!';BX24.installFinish();});});});});<\/script></body></html>`);
});

// ── BX24 call start ───────────────────────────────────────────────
app.post('/bx24-call-start', async (req, res) => {
  console.log('[BX24-CallStart]', JSON.stringify(req.body));
  try {
    const d = req.body.data || req.body;
    pendingOutboundCall = { number: d.PHONE_NUMBER||'', userId: d.USER_ID||BX24_USER_ID, callId: d.CALL_ID||('ext_'+Date.now()), ts: Date.now() };
    res.json({ status: 'ok' });
  } catch(e) { res.json({ status: 'error', message: e.message }); }
});

// ── Pending calls ───────────────────────────────────────────────
app.get('/pending-call', (req, res) => {
  pollCount++;
  if (pollCount % 20 === 1) console.log('[Poll] /pending-call hit #' + pollCount);
  if (pendingOutboundCall && (Date.now() - pendingOutboundCall.ts) < 30000) {
    const c = pendingOutboundCall; pendingOutboundCall = null;
    res.json({ pending: true, number: c.number, callId: c.callId });
  } else { if (pendingOutboundCall) pendingOutboundCall = null; res.json({ pending: false }); }
});

app.get('/pending-inbound', (req, res) => {
  if (pendingInboundCall && (Date.now() - pendingInboundCall.ts) < 30000) {
    const c = pendingInboundCall; pendingInboundCall = null;
    res.json({ pending: true, from: c.from, callSid: c.callSid });
  } else { if (pendingInboundCall) pendingInboundCall = null; res.json({ pending: false }); }
});

// ── Incoming call ───────────────────────────────────────────────
app.all('/incoming-call', async (req, res) => {
  const p = Object.assign({}, req.query, req.body);
  console.log('[Incoming]', JSON.stringify(p));
  const et = (p.EventType||p.Status||'').toLowerCase();
  if (['free','terminal','completed','busy','noanswer'].includes(et)) return res.json({ status: 'ignored' });
  try {
    const from   = p.From||p.CallFrom||p.caller_id||p.CallerId||p.callerid||'Unknown';
    const sid    = p.CallSid||p.call_sid||('in_'+Date.now());
    const toNum  = p.To||p.DialWhomNumber||p.CallTo||VIRTUAL_NUMBER||'Unknown';
    if (BX24_WEBHOOK) {
      const r = await bx24Call('telephony.externalcall.register',{USER_ID:BX24_USER_ID,PHONE_NUMBER:from,TYPE:2,CALL_START_DATE:new Date().toISOString(),CRM_CREATE:true,LINE_NUMBER:toNum,SHOW:1});
      const bxId = (r&&r.CALL_ID)||sid;
      inboundCallMap[sid] = bxId;
      pendingInboundCall = { from, callSid: bxId, ts: Date.now() };
    } else {
      pendingInboundCall = { from, callSid: sid, ts: Date.now() };
    }
    res.json({ status: 'received' });
  } catch(e) { console.error('[Incoming]', e.message); res.json({ status: 'error', message: e.message }); }
});

// ── Call callback ───────────────────────────────────────────────
app.all('/call-callback', async (req, res) => {
  const p = Object.assign({}, req.query, req.body);
  console.log('[Callback]', JSON.stringify(p));
  try {
    const sid      = p.CallSid||p.call_sid||'';
    const duration = parseInt(p.Duration||p.duration||'0');
    const status   = p.Status||p.status||'completed';
    const bxId     = inboundCallMap[sid]||sid;
    if (inboundCallMap[sid]) delete inboundCallMap[sid];
    if (BX24_WEBHOOK && bxId)
      await bx24Call('telephony.externalcall.finish',{CALL_ID:bxId,USER_ID:BX24_USER_ID,DURATION:duration,STATUS_CODE:status==='completed'?200:304});
    res.json({ status: 'received' });
  } catch(e) { console.error('[Callback]', e.message); res.json({ status: 'error', message: e.message }); }
});

// ── Client log ───────────────────────────────────────────────────
app.post('/client-log', (req, res) => { console.log('[ClientLog]', JSON.stringify(req.body)); res.json({ status: 'ok' }); });

// ── Health ──────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', account_sid: ACCOUNT_SID||'NOT SET',
  api_key_set: !!API_KEY, api_token_set: !!API_TOKEN,
  app_id_set: !!APP_ID, app_secret_set: !!APP_SECRET,
  customer_id_set: !!CUSTOMER_ID, customer_secret_set: !!CUSTOMER_SECRET,
  bx24_webhook_set: !!BX24_WEBHOOK, bx24_user_id: BX24_USER_ID,
  domain: DOMAIN, ccm_base: CCM_BASE, sip_fb: SIP_FB,
  app_user_id: APP_USER_ID, virtual_number_set: !!VIRTUAL_NUMBER
}));

// ── Debug: RAW CCM response — tells us exactly what Exotel returns ──────
// Visit: https://exotel-websdk.onrender.com/debug-raw-ccm
app.get('/debug-raw-ccm', async (req, res) => {
  const results = [];

  // Try multiple possible CCM endpoints
  const endpoints = [
    `https://api.exotel.com/v2/accounts/${ACCOUNT_SID}/configuration/basicauth`,
    `https://api.exotel.com/v1/Accounts/${ACCOUNT_SID}/configuration/basicauth`,
    `https://ccm-api.exotel.com/v2/accounts/${ACCOUNT_SID}/configuration/basicauth`,
  ];

  const credentials = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');

  for (const url of endpoints) {
    try {
      const r   = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${credentials}` }
      });
      const raw = await r.text();
      results.push({ url, status: r.status, body: raw.slice(0, 500) });
    } catch(e) {
      results.push({ url, error: e.message });
    }
  }

  res.json({
    env_check: {
      account_sid:    ACCOUNT_SID   || 'MISSING',
      api_key_set:    !!API_KEY,
      api_token_set:  !!API_TOKEN,
      domain:         DOMAIN,
      ccm_base:       CCM_BASE
    },
    results
  });
});

app.get('/debug',     async (req, res) => { try { await getCustomerToken(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/debug-app', async (req, res) => { try { await getAppToken();      res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/debug-ccm-token', async (req, res) => {
  try { const t = await getCCMAccessToken(); res.json({ success: true, preview: t.slice(0,40)+'...' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
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
    res.json({ APP_ID_in_env: APP_ID||'NOT SET', apps: (d.Data||[]).map(a=>({ AppID:a.AppID, AppName:a.AppName, IsActive:a.IsActive, matched:a.AppID===APP_ID?'✅':'❌' })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/list-users', async (req, res) => {
  try { const at = await getAppToken(); const r = await fetch(`${BASE}/usermapping`, { headers: { 'Authorization': at } }); res.json(JSON.parse(await r.text())); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/create-user', async (req, res) => {
  try {
    const { appUserId, appUsername, email, agentNumber, virtualNumber } = req.body;
    if (!appUserId||!appUsername||!email||!virtualNumber) return res.status(400).json({ error: 'Missing required fields' });
    const at = await getAppToken();
    const r  = await fetch(`${BASE}/usermapping`, {
      method: 'POST', headers: { 'Authorization': at, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ AppUserId:appUserId, AppUsername:appUsername, Email:email, ExotelAccountSid:ACCOUNT_SID, ExotelUserName:appUsername, AgentNumber:agentNumber||'', VirtualNumber:virtualNumber }])
    });
    const d = JSON.parse(await r.text());
    if (!r.ok) throw new Error(JSON.stringify(d));
    res.json({ success: true, data: d });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── /token ──────────────────────────────────────────────────────
app.get('/token', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const accessToken = await getCCMAccessToken();
    console.log('[Token] Issued for', user_id);
    res.json({ success: true, access_token: accessToken, app_user_id: user_id });
  } catch(e) {
    console.error('[Token]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Static ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT} | CCM: ${CCM_BASE} | SIP: ${SIP_FB}`));
