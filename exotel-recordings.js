// ═══════════════════════════════════════════════════════════════════════════
// exotel-recordings.js
// ─────────────────────────────────────────────────────────────────────────
// Fetches call recordings from the Exotel REST API (v1, Basic-Auth with
// API_KEY : API_TOKEN) for a given client phone number, then posts each
// recording as a BX24 crm.activity so it appears in the Activity timeline
// on the matching Lead / Contact (the red-circled area in the screenshot).
//
// USAGE (called from server.js)
// ─────────────────────────────
//   const recordings = require('./exotel-recordings');
//   recordings.init(app);            // registers POST/GET /sync-recordings
//
// The init() call also hooks into /call-callback via syncRecordings():
//   recordings.syncRecordings({ phoneNumber, agentEmail })
//
// ENV VARS NEEDED (already declared in server.js; read from process.env here)
//   EXOTEL_ACCOUNT_SID   — your Exotel account SID  (e.g. jkstar1)
//   EXOTEL_API_KEY       — API key  (Basic-Auth username)
//   EXOTEL_API_TOKEN     — API token (Basic-Auth password)
//   EXOTEL_DOMAIN        — 'singapore' or 'india' (defaults singapore)
//   BX24_WEBHOOK_URL     — Bitrix24 incoming webhook base URL
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');

// ── Env vars ────────────────────────────────────────────────────────────────
const ACCOUNT_SID  = process.env.EXOTEL_ACCOUNT_SID || '';
const API_KEY      = process.env.EXOTEL_API_KEY      || '';
const API_TOKEN    = process.env.EXOTEL_API_TOKEN    || '';
const BX24_WEBHOOK = process.env.BX24_WEBHOOK_URL    || '';
const DOMAIN       = process.env.EXOTEL_DOMAIN       || 'singapore';

// Exotel REST v1 host differs by region.
// Singapore: api.exotel.com   India: api.in.exotel.com
// Override with EXOTEL_API_HOST env var if needed.
const isIndia         = /mum|in1|india/i.test(DOMAIN);
const EXOTEL_API_HOST = process.env.EXOTEL_API_HOST || (isIndia ? 'api.in.exotel.com' : 'api.exotel.com');
const EXOTEL_V1_BASE  = `https://${EXOTEL_API_HOST}/v1/Accounts/${ACCOUNT_SID}`;

// ── In-memory dedup ─────────────────────────────────────────────────────────
// Tracks CallSids already synced so we never post the same recording twice.
// Clears on server restart — safe, because BX24 already has the activities.
const syncedCallSids = new Set();

// ── BX24 user-id cache (email → BX24 user id) ───────────────────────────────
const bx24UserIdCache = {};

function log(msg) { console.log('[Recordings]', msg); }

// ── Exotel v1 GET helper (Basic-Auth) ───────────────────────────────────────
async function exotelGet(path, params) {
  if (!ACCOUNT_SID || !API_KEY || !API_TOKEN) {
    throw new Error('EXOTEL_ACCOUNT_SID / EXOTEL_API_KEY / EXOTEL_API_TOKEN not set');
  }
  const creds = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
  const qs    = params ? '?' + new URLSearchParams(params).toString() : '';
  const url   = `${EXOTEL_V1_BASE}${path}${qs}`;
  log(`GET ${url}`);
  const res  = await fetch(url, { headers: { Authorization: `Basic ${creds}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`Exotel ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// ── BX24 REST helper ─────────────────────────────────────────────────────────
async function bx24Call(method, params) {
  if (!BX24_WEBHOOK) throw new Error('BX24_WEBHOOK_URL not set');
  const url = `${BX24_WEBHOOK}${method}.json`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params)
  });
  const data = await res.json();
  if (data.error) throw new Error(`BX24 ${method}: ${data.error} — ${data.error_description || ''}`);
  return data.result;
}

// ── Resolve agent email → BX24 user ID ──────────────────────────────────────
async function getBx24UserId(email) {
  if (!email) return null;
  const key = email.toLowerCase();
  if (bx24UserIdCache[key]) return bx24UserIdCache[key];
  try {
    const result = await bx24Call('user.get', { filter: { EMAIL: email } });
    const user   = Array.isArray(result) ? result[0] : result;
    const id     = user && String(user.ID);
    if (id) { bx24UserIdCache[key] = id; log(`BX24 user ${email} → ID ${id}`); }
    return id || null;
  } catch (e) { log(`BX24 user lookup failed for ${email}: ${e.message}`); return null; }
}

// ── Find BX24 Lead or Contact by phone number ────────────────────────────────
// Returns { entityType: 'LEAD'|'CONTACT', entityId: string } or null.
async function findBx24EntityByPhone(phoneNumber) {
  const clean = (phoneNumber || '').replace(/[\s\-().]/g, '');
  if (!clean) return null;

  // Also try the last 10 digits (handles +91 prefix variants)
  const last10 = clean.replace(/^\+?\d{0,3}/, '').slice(-10);

  for (const [entityType, method] of [
    ['LEAD',    'crm.lead.list'],
    ['CONTACT', 'crm.contact.list']
  ]) {
    for (const num of [clean, last10]) {
      if (!num) continue;
      try {
        const result = await bx24Call(method, {
          filter: { PHONE: num },
          select: ['ID', 'NAME', 'PHONE']
        });
        const items = Array.isArray(result) ? result : [];
        if (items.length > 0) {
          log(`Found ${entityType} ID=${items[0].ID} for ${num}`);
          return { entityType, entityId: String(items[0].ID) };
        }
      } catch (e) { log(`BX24 ${method} failed: ${e.message}`); }
    }
  }
  return null;
}

// ── Fetch Exotel calls for a specific phone number ───────────────────────────
// Queries both From= and To= and dedupes by CallSid.
async function fetchExotelCallsForNumber(phoneNumber) {
  const calls = new Map();
  for (const field of ['From', 'To']) {
    try {
      const data = await exotelGet('/Calls.json', { [field]: phoneNumber, PageSize: 50 });
      const list = (data?.TwilioResponse?.Calls?.Call) || [];
      const arr  = Array.isArray(list) ? list : [list];
      arr.forEach(c => { if (c && c.Sid) calls.set(c.Sid, c); });
      log(`Exotel /Calls?${field}=${phoneNumber} → ${arr.length} result(s)`);
    } catch (e) { log(`Exotel calls fetch (${field}=${phoneNumber}) failed: ${e.message}`); }
  }
  return Array.from(calls.values());
}

// ── Fetch the most recent Exotel calls (no number filter) ────────────────────
async function fetchRecentExotelCalls() {
  try {
    const data = await exotelGet('/Calls.json', { PageSize: 100 });
    const list = (data?.TwilioResponse?.Calls?.Call) || [];
    const arr  = Array.isArray(list) ? list : [list];
    log(`Exotel /Calls (all recent) → ${arr.length} result(s)`);
    return arr;
  } catch (e) { log(`Exotel all-calls fetch failed: ${e.message}`); return []; }
}

// ── Fetch recording URL for a single call ────────────────────────────────────
async function fetchRecordingUrl(callSid) {
  try {
    const data = await exotelGet(`/Calls/${callSid}/Recordings.json`);
    const list = (data?.TwilioResponse?.Recordings?.Recording) || [];
    const arr  = Array.isArray(list) ? list : [list];
    if (!arr[0]) return null;
    // Uri is relative (/v1/Accounts/…/Recordings/RE…) — prepend host, strip .json
    const uri = arr[0].Uri || '';
    return uri.startsWith('http')
      ? uri.replace(/\.json$/, '')
      : `https://${EXOTEL_API_HOST}${uri}`.replace(/\.json$/, '');
  } catch (e) {
    // 404 = no recording for this call — expected for unanswered calls
    if (!e.message.includes('404')) log(`Recording fetch failed for ${callSid}: ${e.message}`);
    return null;
  }
}

// ── Post recording as BX24 crm.activity (TYPE_ID=2 = Call) ──────────────────
// Appears in the Activity timeline on the Lead / Contact (the marked area).
async function postRecordingToBx24(call, recordingUrl, entity, agentBx24UserId) {
  const callSid   = call.Sid || '';
  const fromNum   = call.From || '';
  const toNum     = call.To   || '';
  const duration  = parseInt(call.Duration || '0');
  const startTime = call.StartTime || call.DateCreated || new Date().toISOString();
  const direction = (call.Direction || '').toLowerCase().includes('outbound')
    ? 'outbound' : 'inbound';
  const callDate  = new Date(startTime).toISOString();

  // Description shown inside the Activity card on the timeline
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  const description =
    `📞 Exotel Call Recording\n` +
    `Direction : ${direction === 'outbound' ? '↗ Outbound' : '↙ Inbound'}\n` +
    `From      : ${fromNum}\n` +
    `To        : ${toNum}\n` +
    `Duration  : ${mins}m ${secs}s\n` +
    `Call SID  : ${callSid}\n\n` +
    `🎧 Recording link:\n${recordingUrl}`;

  try {
    const result = await bx24Call('crm.activity.add', {
      fields: {
        OWNER_TYPE_ID:    entity.entityType === 'LEAD' ? 1 : 3, // 1=Lead 3=Contact
        OWNER_ID:         entity.entityId,
        TYPE_ID:          2,          // 2 = Phone call activity
        SUBJECT:          `Call recording — ${fromNum} (${direction})`,
        DESCRIPTION:      description,
        DESCRIPTION_TYPE: 1,          // 1 = plain text
        DIRECTION:        direction === 'outbound' ? 2 : 1,
        DURATION:         duration,
        START_TIME:       callDate,
        END_TIME:         callDate,
        COMPLETED:        'Y',
        RESPONSIBLE_ID:   agentBx24UserId || 1,
        COMMUNICATIONS:   [{ VALUE: fromNum, TYPE: 'PHONE' }]
      }
    });
    log(`BX24 activity created: ID=${result} for CallSid=${callSid} on ${entity.entityType} ID=${entity.entityId}`);
    return result;
  } catch (e) {
    log(`BX24 crm.activity.add failed for ${callSid}: ${e.message}`);
    return null;
  }
}

// ── Core sync function ───────────────────────────────────────────────────────
// Called from:
//  • POST /sync-recordings  (manual trigger)
//  • GET  /sync-recordings  (browser/test trigger)
//  • /call-callback hook    (auto-trigger on call end)
//
// phoneNumber — client's phone number; omit to sync all recent calls.
// agentEmail  — agent's email; used to set RESPONSIBLE_ID on BX24 activities.
async function syncRecordings({ phoneNumber, agentEmail } = {}) {
  const results = { processed: 0, recorded: 0, posted: 0, skipped: 0, errors: [] };

  const agentBx24UserId = agentEmail ? await getBx24UserId(agentEmail) : null;

  const calls = phoneNumber
    ? await fetchExotelCallsForNumber(phoneNumber)
    : await fetchRecentExotelCalls();

  results.processed = calls.length;
  log(`Processing ${calls.length} call(s)` + (phoneNumber ? ` for ${phoneNumber}` : ' (all recent)'));

  for (const call of calls) {
    const callSid = call.Sid || '';
    if (!callSid) continue;

    if (syncedCallSids.has(callSid)) { results.skipped++; continue; }

    // Determine the client-side number (non-virtual-number end)
    const fromNum   = call.From || '';
    const toNum     = call.To   || '';
    const clientNum = phoneNumber
      ? phoneNumber
      : ((call.Direction || '').toLowerCase().includes('outbound') ? toNum : fromNum);

    const recordingUrl = await fetchRecordingUrl(callSid);
    if (!recordingUrl) { syncedCallSids.add(callSid); results.skipped++; continue; }
    results.recorded++;

    const entity = await findBx24EntityByPhone(clientNum);
    if (!entity) {
      log(`No BX24 Lead/Contact found for ${clientNum} (CallSid=${callSid}) — skipping`);
      results.errors.push({ callSid, reason: `No BX24 entity for ${clientNum}` });
      syncedCallSids.add(callSid);
      continue;
    }

    const activityId = await postRecordingToBx24(call, recordingUrl, entity, agentBx24UserId);
    if (activityId) {
      results.posted++;
      syncedCallSids.add(callSid);
    } else {
      results.errors.push({ callSid, reason: 'crm.activity.add failed' });
    }
  }

  log(`Sync complete: ${JSON.stringify(results)}`);
  return results;
}

// ── Register Express routes ──────────────────────────────────────────────────
// Called once from server.js:  recordings.init(app)
function init(app) {
  // POST /sync-recordings  { phoneNumber?, agentEmail? }
  app.post('/sync-recordings', async (req, res) => {
    const { phoneNumber, agentEmail } = req.body || {};
    log(`POST /sync-recordings — phoneNumber=${phoneNumber || '(all)'} agentEmail=${agentEmail || '(none)'}`);
    try {
      const results = await syncRecordings({ phoneNumber, agentEmail });
      res.json({ status: 'ok', ...results });
    } catch (e) {
      console.error('[Recordings] POST /sync-recordings error:', e.message);
      res.status(500).json({ status: 'error', message: e.message });
    }
  });

  // GET /sync-recordings?phoneNumber=+91...&agentEmail=... (handy for browser testing)
  app.get('/sync-recordings', async (req, res) => {
    const { phoneNumber, agentEmail } = req.query;
    log(`GET /sync-recordings — phoneNumber=${phoneNumber || '(all)'} agentEmail=${agentEmail || '(none)'}`);
    try {
      const results = await syncRecordings({ phoneNumber, agentEmail });
      res.json({ status: 'ok', ...results });
    } catch (e) {
      console.error('[Recordings] GET /sync-recordings error:', e.message);
      res.status(500).json({ status: 'error', message: e.message });
    }
  });

  log('Routes registered: POST /sync-recordings, GET /sync-recordings');
}

module.exports = { init, syncRecordings };
