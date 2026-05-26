const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── YOUR CREDENTIALS ──────────────────────────────────────────
// From Exotel API Settings page (your last screenshot)
const EXOTEL_ACCOUNT_SID  = process.env.EXOTEL_ACCOUNT_SID  || 'jkstar1';
const EXOTEL_API_KEY      = process.env.EXOTEL_API_KEY      || '97ea4aad8ee9b133db098f2cb6e3f2dc4dfafb02743cd080';
const EXOTEL_API_TOKEN    = process.env.EXOTEL_API_TOKEN    || 'YOUR_API_TOKEN_FROM_DASHBOARD';
const EXOTEL_SUBDOMAIN    = process.env.EXOTEL_SUBDOMAIN    || 'api.exotel.com'; // Singapore region

// From Exotel Support (they will give you these)
const EXOTEL_CLIENT_ID     = process.env.EXOTEL_CLIENT_ID    || 'YOUR_CLIENT_ID_FROM_SUPPORT';
const EXOTEL_CLIENT_SECRET = process.env.EXOTEL_CLIENT_SECRET || 'YOUR_CLIENT_SECRET_FROM_SUPPORT';

// From Image 6 — your already created Customer entity
const EXOTEL_CUSTOMER_ID     = process.env.EXOTEL_CUSTOMER_ID     || '3c8213e0-6e9f-4d8f-81ea-4e78cdc7911f';
const EXOTEL_CUSTOMER_SECRET = process.env.EXOTEL_CUSTOMER_SECRET || '5e858613-9727-41c1-a9f3-02c9b3afd167';

// Your Application ID — created in Step 3 below (fill after running /setup)
const EXOTEL_APP_ID = process.env.EXOTEL_APP_ID || '';

const VOIP_BASE = 'https://integrationscore.mum1.exotel.com';

// ─── STEP 1: Get JWT Auth Token ────────────────────────────────
async function getAuthToken() {
  const response = await fetch(`${VOIP_BASE}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: EXOTEL_CUSTOMER_ID,       // 3c8213e0-6e9f-...
      client_secret: EXOTEL_CUSTOMER_SECRET, // 5e858613-9727-...
      grant_type: 'client_credentials'
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Auth token failed: ' + JSON.stringify(data));
  return data.access_token;
}

// ─── INSTALL (Bitrix24 calls this on app open — must handle POST) 
app.get('/install', (req, res) => {
  res.send('<html><body><h2>Exotel Dialer Installed!</h2><p>You can close this window.</p></body></html>');
});
app.post('/install', (req, res) => {
  res.send('<html><body><h2>Exotel Dialer Installed!</h2><p>You can close this window.</p></body></html>');
});

// ─── SETUP ROUTE: Run this ONCE to create Application + test user
// Visit: https://your-app.onrender.com/setup
app.get('/setup', async (req, res) => {
  try {
    const token = await getAuthToken();
    const results = {};

    // Create Application under your Customer
    const appRes = await fetch(`${VOIP_BASE}/v1/customers/${EXOTEL_CUSTOMER_ID}/applications`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        AppName: 'BitrixDialer',
        AppType: 'crm'
      })
    });
    const appData = await appRes.json();
    results.application = appData;
    results.note = 'Copy the AppID from application.Data.AppID and set it as EXOTEL_APP_ID env var on Render';

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE USER: Call this for each agent ─────────────────────
// POST /create-user  body: { email: "agent@company.com", name: "Agent Name" }
app.post('/create-user', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!EXOTEL_APP_ID) return res.status(400).json({ error: 'EXOTEL_APP_ID not set. Run /setup first.' });

    const token = await getAuthToken();

    const userRes = await fetch(
      `${VOIP_BASE}/v1/customers/${EXOTEL_CUSTOMER_ID}/applications/${EXOTEL_APP_ID}/users`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          UserID: email,       // Email is used as UserID per Exotel docs
          DisplayName: name || email
        })
      }
    );
    const userData = await userRes.json();
    res.json(userData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TOKEN: popup.js calls this to get WebRTC token ───────────
app.get('/token', async (req, res) => {
  try {
    const userId = req.query.user_id || 'default_agent';
    if (!EXOTEL_APP_ID) return res.status(400).json({ error: 'EXOTEL_APP_ID not set. Run /setup first.' });

    const token = await getAuthToken();

    const tokenRes = await fetch(
      `${VOIP_BASE}/v1/customers/${EXOTEL_CUSTOMER_ID}/applications/${EXOTEL_APP_ID}/users/${encodeURIComponent(userId)}/token`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(tokenData));
    res.json(tokenData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DEBUG: Test each step individually ────────────────────────
app.get('/debug', async (req, res) => {
  const results = {};

  // Test 1: Can we reach the auth endpoint at all?
  const endpointsToTry = [
    'https://integrationscore.mum1.exotel.com/v1/oauth/token',
    'https://integrationscore.sin1.exotel.com/v1/oauth/token',  // Singapore
    'https://integrationscore.exotel.com/v1/oauth/token',        // Generic
  ];

  for (const url of endpointsToTry) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.EXOTEL_CUSTOMER_ID,
          client_secret: process.env.EXOTEL_CUSTOMER_SECRET,
          grant_type: 'client_credentials'
        })
      });
      const raw = await r.text();
      results[url] = {
        status: r.status,
        contentType: r.headers.get('content-type'),
        body: raw.substring(0, 300)   // first 300 chars to see what's returned
      };
    } catch (err) {
      results[url] = { error: err.message };
    }
  }

  res.json(results);
});

// ─── HEALTH ────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', appId: EXOTEL_APP_ID || 'NOT SET' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
