const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BASE = 'https://integrationscore.mum1.exotel.com/v2/integrations';

const CUSTOMER_ID     = process.env.EXOTEL_CUSTOMER_ID;
const CUSTOMER_SECRET = process.env.EXOTEL_CUSTOMER_SECRET;
const ACCOUNT_SID     = process.env.EXOTEL_ACCOUNT_SID;
const API_KEY         = process.env.EXOTEL_API_KEY;
const API_TOKEN       = process.env.EXOTEL_API_TOKEN;
const DOMAIN          = process.env.EXOTEL_DOMAIN || 'singapore';
const APP_ID          = process.env.EXOTEL_APP_ID;
const APP_SECRET      = process.env.EXOTEL_APP_SECRET;

// ── One-time: Customer token ───────────────────────────────────
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

// ── Runtime: App token (called every time agent opens dialer) ──
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

// ── Bitrix24 install ───────────────────────────────────────────
app.get('/install',  (req, res) => res.send('<h2>Exotel Dialer Installed!</h2>'));
app.post('/install', (req, res) => res.send('<h2>Exotel Dialer Installed!</h2>'));

// ── Health ─────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:              'ok',
  customer_id_set:     !!CUSTOMER_ID,
  customer_secret_set: !!CUSTOMER_SECRET,
  app_id_set:          !!APP_ID,
  app_secret_set:      !!APP_SECRET,
  api_key_set:         !!API_KEY,
  api_token_set:       !!API_TOKEN,
  domain:              DOMAIN,
  app_id_value:        APP_ID || 'NOT SET'
}));

// ── Debug customer token ───────────────────────────────────────
app.get('/debug', async (req, res) => {
  try {
    const token = await getCustomerToken();
    res.json({ success: true, message: '✅ Customer token OK', preview: token.substring(0, 30) + '...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Debug app token ────────────────────────────────────────────
app.get('/debug-app', async (req, res) => {
  try {
    const token = await getAppToken();
    res.json({ success: true, message: '✅ App token OK', preview: token.substring(0, 30) + '...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ONE-TIME: View all apps under customer ─────────────────────
app.get('/setup', async (req, res) => {
  try {
    const customerToken = await getCustomerToken();
    const r = await fetch(`${BASE}/app?entity=customer`, {
      headers: { 'Authorization': customerToken }
    });
    const data = JSON.parse(await r.text());
    const apps = data.Data || [];
    res.json({
      total_apps:           apps.length,
      EXOTEL_APP_ID_in_env: APP_ID || 'NOT SET',
      apps: apps.map(a => ({
        AppID:            a.AppID,
        AppName:          a.AppName,
        IsActive:         a.IsActive,
        ExotelDomain:     a.ExotelDomain,
        matched_with_env: a.AppID === APP_ID ? '✅ MATCH' : '❌ MISMATCH'
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ONE-TIME: Create app (only if none exists) ─────────────────
app.get('/create-app', async (req, res) => {
  try {
    if (APP_ID && APP_SECRET) {
      return res.status(400).json({
        error: 'App already configured.',
        current_app_id: APP_ID,
        instruction: 'Remove EXOTEL_APP_ID and EXOTEL_APP_SECRET from Render env vars first if you need a new app.'
      });
    }
    const customerToken = await getCustomerToken();
    const r = await fetch(`${BASE}/app`, {
      method: 'POST',
      headers: { 'Authorization': customerToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        AppName:          'BitrixDialer',
        ExotelAccountSid: ACCOUNT_SID,
        ExotelApiKey:     API_KEY,
        ExotelApiToken:   API_TOKEN,
        ExotelDomain:     DOMAIN,
        IsActive:         true
      })
    });
    const data = JSON.parse(await r.text());
    if (!r.ok) throw new Error(`Failed: ${JSON.stringify(data)}`);
    res.json({
      success:           true,
      message:           '✅ SAVE THESE NOW — AppSecret is never shown again!',
      EXOTEL_APP_ID:     data.Data.AppID,
      EXOTEL_APP_SECRET: data.Data.AppSecret
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ONE-TIME: Create user/agent ────────────────────────────────
app.post('/create-user', async (req, res) => {
  try {
    const { appUserId, appUsername, email, agentNumber, virtualNumber } = req.body;
    if (!appUserId || !appUsername || !email || !virtualNumber)
      return res.status(400).json({ error: 'appUserId, appUsername, email, virtualNumber are required' });

    const appToken = await getAppToken();
    const r = await fetch(`${BASE}/usermapping`, {
      method: 'POST',
      headers: { 'Authorization': appToken, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
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
    if (!r.ok) throw new Error(`Failed [${r.status}]: ${JSON.stringify(data)}`);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ONE-TIME: List all users ───────────────────────────────────
app.get('/list-users', async (req, res) => {
  try {
    const appToken = await getAppToken();
    const r = await fetch(`${BASE}/usermapping`, {
      headers: { 'Authorization': appToken }
    });
    const data = JSON.parse(await r.text());
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RUNTIME: Token endpoint — popup.js calls this ──────────────
// Returns app_token + SIP credentials for WebRTC SDK
// This is the ONLY endpoint called repeatedly at runtime
app.get('/token', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const appToken = await getAppToken();
    const r = await fetch(`${BASE}/usermapping?user_id=${encodeURIComponent(user_id)}`, {
      headers: { 'Authorization': appToken }
    });
    const data = JSON.parse(await r.text());
    if (!r.ok) throw new Error(`Failed [${r.status}]: ${JSON.stringify(data)}`);

    // Handle both response formats from Exotel
    let user = null;
    if (data.Data && data.Data.Users && data.Data.Users.length > 0) {
      user = data.Data.Users[0]; // paginated format
    } else if (data.Data && data.Data.SipId) {
      user = data.Data; // direct format
    } else {
      throw new Error('User not found or no SIP credentials');
    }

    res.json({
      success:        true,
      app_token:      appToken,
      sip_id:         user.SipId,
      sip_secret:     user.SipSecret,
      virtual_number: user.VirtualNumber,
      user_id:        user.AppUserId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Inbound call webhook (Exotel hits this) ────────────────────
app.post('/incoming-call', (req, res) => {
  console.log('📞 Incoming call:', JSON.stringify(req.body, null, 2));
  res.json({ status: 'received' });
});

// ── Outbound call callback webhook ────────────────────────────
app.post('/call-callback', (req, res) => {
  console.log('📤 Call callback:', JSON.stringify(req.body, null, 2));
  res.json({ status: 'received' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ── ONE-TIME: Register PAGE_BACKGROUND_WORKER placement ──────
app.get('/register-background', async (req, res) => {
  try {
    const { auth_token, domain } = req.query;

    if (!auth_token || !domain) {
      return res.status(400).json({
        error: 'Missing params',
        usage: '/register-background?auth_token=YOUR_ACCESS_TOKEN&domain=gsdny.bitrix24.in'
      });
    }

    const response = await fetch(`https://${domain}/rest/placement.bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        PLACEMENT: 'PAGE_BACKGROUND_WORKER',
        HANDLER: 'https://exotel-websdk.onrender.com/background.html',
        OPTIONS: {
          errorHandlerUrl: 'https://exotel-websdk.onrender.com/error-handler.html'
        },
        TITLE: 'Exotel Background Worker',
        auth: auth_token
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({
        error: data.error,
        description: data.error_description,
        note: data.error === 'ERROR_PLACEMENT_MAX_COUNT'
          ? '⚠️ Already registered! This is fine — it means PAGE_BACKGROUND_WORKER is already active.'
          : 'Check the error above'
      });
    }

    res.json({
      success: true,
      message: '✅ PAGE_BACKGROUND_WORKER registered!',
      result: data.result
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
