const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ────────────────────────────────────────────────────
const EXOTEL_API_KEY    = process.env.EXOTEL_API_KEY    || 'YOUR_API_KEY';
const EXOTEL_API_TOKEN  = process.env.EXOTEL_API_TOKEN  || 'YOUR_API_TOKEN';
const EXOTEL_ACCOUNT_SID = process.env.EXOTEL_ACCOUNT_SID || 'YOUR_ACCOUNT_SID';
const EXOTEL_SUBDOMAIN  = process.env.EXOTEL_SUBDOMAIN  || 'api.exotel.com'; // or your regional subdomain

// ─── INSTALL ENDPOINT (required by Bitrix24) ───────────────────
app.get('/install', (req, res) => {
  res.send(`
    <html><body>
      <h2>Exotel Dialer Installed!</h2>
      <p>You can close this window.</p>
    </body></html>
  `);
});

// ─── TOKEN ENDPOINT ────────────────────────────────────────────
// Fetches a fresh WebRTC token from Exotel and returns it to popup.js
app.get('/token', async (req, res) => {
  try {
    const userId = req.query.user_id || 'default_agent';

    const credentials = Buffer.from(`${EXOTEL_API_KEY}:${EXOTEL_API_TOKEN}`).toString('base64');

    const response = await fetch(
      `https://${EXOTEL_SUBDOMAIN}/v2/accounts/${EXOTEL_ACCOUNT_SID}/webrtc/token?user_id=${userId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Exotel token error:', errText);
      return res.status(502).json({ error: 'Failed to fetch token from Exotel', detail: errText });
    }

    const data = await response.json();
    res.json(data);

  } catch (err) {
    console.error('Token endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));