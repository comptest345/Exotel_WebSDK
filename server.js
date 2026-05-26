const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VOIP_BASE = 'https://integrationscore.mum1.exotel.com/v2/integrations';

// ── Your credentials ──────────────────────────────────────────
const CUSTOMER_ID     = process.env.EXOTEL_CUSTOMER_ID     || '3c8213e0-6e9f-4d8f-81ea-4e78cdc7911f';
const CUSTOMER_SECRET = process.env.EXOTEL_CUSTOMER_SECRET || '5e858613-9727-41c1-a9f3-02c9b3afd167';
const ACCOUNT_SID     = process.env.EXOTEL_ACCOUNT_SID     || 'jkstar1';
const API_KEY         = process.env.EXOTEL_API_KEY         || '';
const API_TOKEN       = process.env.EXOTEL_API_TOKEN       || '';
const EXOTEL_DOMAIN   = process.env.EXOTEL_DOMAIN          || 'singapore'; // your account region
const APP_ID          = process.env.EXOTEL_APP_ID          || '';

// ── Step 1: Get customer-level auth token ─────────────────────
async function getCustomerToken() {
  const res = await fetch(`${VOIP_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Id: CUSTOMER_ID,
      Secret: CUSTOMER_SECRET,
      Entity: 'customer'
    })
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Customer token failed [${res.status}]: ${raw}`);
  const data = JSON.parse(raw);
  return data.Data; // raw base64 token string
}

// ── Step 2: Get app-level auth token ─────────────────────────
async function getAppToken() {
  if (!APP_ID) throw new Error('EXOTEL_APP_ID not set. Run /setup first.');
  const appSecret = process.env.EXOTEL_APP_SECRET || '';
  if (!appSecret) throw new Error('EXOTEL_APP_SECRET not set. Run /setup first.');
  const res = await fetch(`${VOIP_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Id: APP_ID,
      Secret: appSecret,
      Entity: 'app'
    })
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`App token failed [${res.status}]: ${raw}`);
  const data = JSON.parse(raw);
  return data.Data;
}

// ── Install (Bitrix24 sends POST) ─────────────────────────────
app.get('/install',  (req, res) => res.send('<h2>Exotel Dialer Installed!</h2>'));
app.post('/install', (req, res) => res.send('<h2>Exotel Dialer Installed!</h2>'));

// ── SETUP: Run once to create Application ─────────────────────
// Visit: https://exotel-websdk.onrender.com/setup
app.get('/setup', async (req, res) => {
  try {
    const customerToken = await getCustomerToken();

    // ── First CHECK if app already exists ──
    const checkRes = await fetch(`${VOIP_BASE}/app?entity=customer`, {
      headers: { 'Authorization': customerToken }
    });
    const checkRaw = await checkRes.text();
    const checkData = JSON.parse(checkRaw);

    // If apps already exist, return the first one — don't create new
    if (checkData.Data && checkData.Data.length > 0) {
      const existing = checkData.Data[0];
      return res.json({
        success: true,
        message: '✅ App already exists — use this AppID (do NOT run setup again)',
        AppID: existing.AppID,
        AppName: existing.AppName,
        warning: 'If EXOTEL_APP_ID and EXOTEL_APP_SECRET are already set in Render, you are good to go.'
      });
    }

    // ── Only create if no app exists ──
    const appRes = await fetch(`${VOIP_BASE}/app`, {
      method: 'POST',
      headers: {
        'Authorization': customerToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        AppName: 'BitrixDialer',
        ExotelAccountSid: ACCOUNT_SID,
        ExotelApiKey: API_KEY,
        ExotelApiToken: API_TOKEN,
        ExotelDomain: EXOTEL_DOMAIN,
        IsActive: true
      })
    });

    const raw = await appRes.text();
    if (!appRes.ok) throw new Error(`Create app failed [${appRes.status}]: ${raw}`);
    const appData = JSON.parse(raw);

    res.json({
      success: true,
      message: '✅ App created! Copy AppID and AppSecret into Render env vars NOW.',
      AppID: appData.Data.AppID,
      AppSecret: appData.Data.AppSecret
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CREATE USER: POST /create-user ────────────────────────────
// body: { appUserId, appUsername, email, agentNumber, virtualNumber }
app.post('/create-user', async (req, res) => {
  try {
    const { appUserId, appUsername, email, agentNumber, virtualNumber } = req.body;
    if (!appUserId || !appUsername || !email || !virtualNumber) {
      return res.status(400).json({ error: 'appUserId, appUsername, email, virtualNumber are required' });
    }

    const appToken = await getAppToken();

    const userRes = await fetch(`${VOIP_BASE}/usermapping`, {
      method: 'POST',
      headers: {
        'Authorization': appToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([{
        AppUserId: appUserId,
        AppUsername: appUsername,
        Email: email,
        ExotelAccountSid: ACCOUNT_SID,
        ExotelUserName: appUsername,
        AgentNumber: agentNumber || '',
        VirtualNumber: virtualNumber
      }])
    });

    const raw = await userRes.text();
    if (!userRes.ok) throw new Error(`Create user failed [${userRes.status}]: ${raw}`);
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TOKEN: popup.js calls this for WebRTC token ───────────────
app.get('/token', async (req, res) => {
  try {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id query param required' });

    const appToken = await getAppToken();

    // Get user details — SipId and SipSecret are what WebRTC SDK needs
    const userRes = await fetch(`${VOIP_BASE}/usermapping?user_id=${encodeURIComponent(userId)}`, {
      headers: { 'Authorization': appToken }
    });

    const raw = await userRes.text();
    if (!userRes.ok) throw new Error(`Get user failed [${userRes.status}]: ${raw}`);
    const userData = JSON.parse(raw);

    res.json({
      sip_id: userData.Data.SipId,
      sip_secret: userData.Data.SipSecret,
      app_token: appToken,
      user: userData.Data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DEBUG: Test token generation only ─────────────────────────
app.get('/debug', async (req, res) => {
  try {
    const customerToken = await getCustomerToken();
    res.json({
      success: true,
      message: '✅ Customer token generated successfully!',
      token_preview: customerToken.substring(0, 20) + '...',
      next_step: 'Now visit /setup to create your Application'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/list-apps', async (req, res) => {
  try {
    const customerToken = await getCustomerToken();
    const r = await fetch(`${VOIP_BASE}/app?entity=customer`, {
      headers: { 'Authorization': customerToken }
    });
    const data = JSON.parse(await r.text());
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  app_id_set: !!APP_ID,
  api_key_set: !!API_KEY,
  api_token_set: !!API_TOKEN
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
