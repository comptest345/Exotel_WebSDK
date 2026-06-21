// ═══════════════════════════════════════════════════════════════
// keep-alive.js — Prevents Render free tier from sleeping
// Run separately: node keep-alive.js
// Or add to package.json scripts and run alongside server.js
// Pings the server every 10 minutes so it never goes idle.
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

const SERVER_URL = process.env.RENDER_URL || 'https://exotel-websdk.onrender.com';
const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function ping() {
  const url  = SERVER_URL + '/health';
  const mod  = url.startsWith('https') ? https : http;
  const time = new Date().toISOString();

  const req = mod.get(url, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log(`[KeepAlive] ${time} — HTTP ${res.statusCode} — ${url}`);
    });
  });

  req.on('error', (e) => {
    console.error(`[KeepAlive] ${time} — ERROR: ${e.message}`);
  });

  req.setTimeout(30000, () => {
    req.destroy();
    console.error(`[KeepAlive] ${time} — TIMEOUT after 30s`);
  });
}

console.log(`[KeepAlive] Starting — pinging ${SERVER_URL} every ${INTERVAL_MS / 60000} minutes`);
ping(); // ping immediately on start
setInterval(ping, INTERVAL_MS);
