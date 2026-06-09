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
// For local apps, placement.bind must be called CLIENT-SIDE using
// BX24.getAuth() which provides a valid OAuth access_token.
// APP_SID from query params is NOT an OAuth token and cannot be
// used directly with REST methods.
app.all('/install', (req, res) => {
  console.log('[Install] Called — serving client-side installer');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <script src="//api.bitrix24.com/api/v1/"></script>
    </head>
    <body>
      <p id="status">Installing Exotel Dialer...</p>
      <script>
        BX24.init(function() {
          var auth = BX24.getAuth();
          var accessToken = auth.access_token;
          var domain = auth.domain;

          console.log('[Install] access_token present:', !!accessToken);
          console.log('[Install] domain:', domain);

          // Register PAGE_BACKGROUND_WORKER via REST using real OAuth token
          BX24.callMethod(
            'placement.bind',
            {
              PLACEMENT: 'PAGE_BACKGROUND_WORKER',
              HANDLER: 'https://exotel-websdk.onrender.com/background.html',
              OPTIONS: {
                errorHandlerUrl: 'https://exotel-websdk.onrender.com/error-handler.html'
              },
              TITLE: 'Exotel Background Worker'
            },
            function(result) {
              if (result.error()) {
                var err = result.error();
                // ERROR_PLACEMENT_MAX_COUNT = already registered = fine
                if (err.toString().indexOf('ERROR_PLACEMENT_MAX_COUNT') !== -1) {
                  console.log('[Install] PAGE_BACKGROUND_WORKER already registered — OK');
                  document.getElementById('status').innerText = 'Exotel Dialer Installed!';
                } else {
                  console.error('[Install] placement.bind error:', err);
                  document.getElementById('status').innerText = 'Installed (placement warning: ' + err + ')';
                }
              } else {
                console.log('[Install] PAGE_BACKGROUND_WORKER registered successfully');
                document.getElementById('status').innerText = 'Exotel Dialer Installed!';
              }

              // Always finish installation regardless of placement.bind result
              BX24.installFinish();
            }
          );
        });
      </script>
    </body>
    </html>
  `);
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
