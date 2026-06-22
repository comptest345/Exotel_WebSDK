// ═══════════════════════════════════════════════════════════════════════════
// exotel-recordings.js  ← EDIT ONLY THIS FILE for anything recording-related
// ═══════════════════════════════════════════════════════════════════════════
//
// Architecture:
//   Exotel records call
//     ↓ server.js /call-callback fires → calls recordings.scheduleSync(...)
//     ↓ scheduleSync() retries with exponential backoff (2 min → 4 min → 8 min)
//     ↓ syncRecordings() confirms recording exists via fetchRecordingUrl()
//     ↓ buildProxyUrl() builds a permanent proxy URL on OUR server
//     ↓ updateBx24CallRecord() calls telephony.externalcall.hide to attach RECORD_URL
//     ↓ Bitrix24 timeline shows native call entry with ▶ Play button
//     ↓ Agent clicks play → browser hits GET /recording/:callSid
//     ↓ proxyRecordingRoute() streams audio from Exotel (authenticated, no storage)
//
// For historical calls (POST/GET /sync-recordings):
//     ↓ fetchExotelCallsForNumber() or fetchRecentExotelCalls()
//     ↓ For each call with a recording:
//         bx24CallId known → updateBx24CallRecord  (update existing timeline entry)
//         bx24CallId unknown → createBx24CallActivity (create new timeline entry)
//
// ── What server.js does for recordings (the ONLY surface you never touch) ──
//   • require('./exotel-recordings')
//   • recordings.init(app)              ← registers /recording/:callSid + /sync-recordings
//   • recordings.scheduleSync({...})    ← called from /call-callback after each call ends
//
// Everything else — retry logic, Exotel API calls, BX24 updates, proxy streaming —
// lives here. Edit only this file.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');

// ── Config (all from env vars — same ones server.js uses) ────────────────
const ACCOUNT_SID  = process.env.EXOTEL_ACCOUNT_SID || '';
const API_KEY      = process.env.EXOTEL_API_KEY      || '';
const API_TOKEN    = process.env.EXOTEL_API_TOKEN    || '';
const BX24_WEBHOOK = process.env.BX24_WEBHOOK_URL    || '';
const DOMAIN       = process.env.EXOTEL_DOMAIN       || 'singapore';
const RENDER_URL   = process.env.RENDER_URL          || 'https://exotel-websdk.onrender.com';

const isIndia         = /mum|in1|india/i.test(DOMAIN);
const EXOTEL_API_HOST = process.env.EXOTEL_API_HOST || (isIndia ? 'api.in.exotel.com' : 'api.exotel.com');
const EXOTEL_V1_BASE  = `https://${EXOTEL_API_HOST}/v1/Accounts/${ACCOUNT_SID}`;

// ── Retry config — change these to tune how long we wait for Exotel ──────
const RETRY_FIRST_DELAY_MS = 2 * 60 * 1000;  // 2 minutes after call ends
const RETRY_MAX_ATTEMPTS   = 3;               // attempts: 2 min → 4 min → 8 min

// ── In-memory dedup — prevents posting the same recording twice ──────────
const syncedCallSids  = new Set();
const bx24UserIdCache = {};

function log(msg) { console.log('[Recordings]', msg); }

// ── Exotel V1 REST helper ────────────────────────────────────────────────
async function exotelGet(path, params) {
  if (!ACCOUNT_SID || !API_KEY || !API_TOKEN)
    throw new Error('EXOTEL_ACCOUNT_SID / EXOTEL_API_KEY / EXOTEL_API_TOKEN not set');
  const creds = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
  const qs    = params ? '?' + new URLSearchParams(params).toString() : '';
  const url   = `${EXOTEL_V1_BASE}${path}${qs}`;
  log(`GET ${url}`);
  const res  = await fetch(url, { headers: { Authorization: `Basic ${creds}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`Exotel ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// ── Bitrix24 REST helper ─────────────────────────────────────────────────
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

// ── BX24 user ID lookup ──────────────────────────────────────────────────
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

// ── Phone number variants (handles +91, 0, raw digits) ──────────────────
function phoneVariants(phoneNumber) {
  const raw      = (phoneNumber || '').trim();
  const digits   = raw.replace(/\D/g, '');
  const withPlus = digits ? `+${digits}` : '';
  const seen = new Set();
  const variants = [];
  for (const v of [raw, withPlus, digits]) {
    if (v && !seen.has(v)) { seen.add(v); variants.push(v); }
  }
  return variants;
}

// ── Find BX24 CRM entity by phone (Lead → Contact → Deal) ───────────────
async function findBx24EntityByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  const variants = phoneVariants(phoneNumber);

  for (const num of variants) {
    try {
      const result = await bx24Call('crm.lead.list', {
        filter: { PHONE: num }, select: ['ID', 'TITLE', 'PHONE']
      });
      const items = Array.isArray(result) ? result : [];
      if (items.length > 0) {
        log(`Found LEAD ID=${items[0].ID} for ${num}`);
        return { entityType: 'LEAD', entityId: String(items[0].ID) };
      }
    } catch (e) { log(`crm.lead.list failed for ${num}: ${e.message}`); }
  }

  let contactId = null;
  for (const num of variants) {
    try {
      const result = await bx24Call('crm.contact.list', {
        filter: { PHONE: num }, select: ['ID', 'NAME', 'PHONE']
      });
      const items = Array.isArray(result) ? result : [];
      if (items.length > 0) {
        contactId = String(items[0].ID);
        log(`Found CONTACT ID=${contactId} for ${num}`);
        break;
      }
    } catch (e) { log(`crm.contact.list failed for ${num}: ${e.message}`); }
  }

  if (contactId) {
    try {
      const deals = await bx24Call('crm.deal.list', {
        filter: { CONTACT_ID: contactId, CLOSED: 'N' },
        select: ['ID', 'TITLE'],
        order:  { DATE_MODIFY: 'DESC' }
      });
      const dealList = Array.isArray(deals) ? deals : [];
      if (dealList.length > 0) {
        log(`Found DEAL ID=${dealList[0].ID} (linked to CONTACT ${contactId})`);
        return { entityType: 'DEAL', entityId: String(dealList[0].ID) };
      }
    } catch (e) { log(`crm.deal.list failed for CONTACT ${contactId}: ${e.message}`); }
    return { entityType: 'CONTACT', entityId: contactId };
  }

  log(`No BX24 Lead/Contact/Deal found for ${phoneNumber}`);
  return null;
}

// ── Fetch Exotel calls for a specific number ─────────────────────────────
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

async function fetchRecentExotelCalls() {
  try {
    const data = await exotelGet('/Calls.json', { PageSize: 100 });
    const list = (data?.TwilioResponse?.Calls?.Call) || [];
    const arr  = Array.isArray(list) ? list : [list];
    log(`Exotel /Calls (all recent) → ${arr.length} result(s)`);
    return arr;
  } catch (e) { log(`Exotel all-calls fetch failed: ${e.message}`); return []; }
}

// ── Fetch recording URL from Exotel ─────────────────────────────────────
async function fetchRecordingUrl(callSid) {
  try {
    const data = await exotelGet(`/Calls/${callSid}/Recordings.json`);
    const list = (data?.TwilioResponse?.Recordings?.Recording) || [];
    const arr  = Array.isArray(list) ? list : [list];
    if (!arr[0]) return null;
    const uri = arr[0].Uri || '';
    return uri.startsWith('http')
      ? uri.replace(/\.json$/, '')
      : `https://${EXOTEL_API_HOST}${uri}`.replace(/\.json$/, '');
  } catch (e) {
    if (!e.message.includes('404')) log(`Recording fetch failed for ${callSid}: ${e.message}`);
    return null;
  }
}

// ── Build permanent proxy URL ────────────────────────────────────────────
// Points to our own /recording/:callSid — never expires, handles Exotel auth invisibly.
function buildProxyUrl(callSid) {
  return `${RENDER_URL}/recording/${callSid}`;
}

function getOwnerTypeId(entityType) {
  return { LEAD: 1, DEAL: 2, CONTACT: 3 }[entityType] || 3;
}

// ── Update existing BX24 telephony call record with recording URL ────────
// Used for new calls where telephony.externalcall.register was already called.
async function updateBx24CallRecord({ bx24CallId, agentBx24Id, callSid, duration, direction, clientNum, fromNum, toNum, callDate }) {
  const proxyUrl = buildProxyUrl(callSid);
  log(`Updating BX24 call CALL_ID=${bx24CallId} with RECORD_URL=${proxyUrl}`);

  // telephony.externalcall.hide attaches recording to an existing telephony entry.
  try {
    await bx24Call('telephony.externalcall.hide', {
      CALL_ID:    bx24CallId,
      USER_ID:    agentBx24Id || '1',
      RECORD_URL: proxyUrl
    });
    log(`BX24 telephony.externalcall.hide OK — CALL_ID=${bx24CallId} recording attached`);
    return bx24CallId;
  } catch (e) {
    log(`telephony.externalcall.hide failed (${e.message}) — falling back to activity update`);
  }

  // Fallback: create a plain CRM activity with the recording link in the description.
  try {
    const mins = Math.floor((duration || 0) / 60);
    const secs = (duration || 0) % 60;
    const desc =
      `📞 Exotel Call Recording\n` +
      `Direction : ${direction === 'outbound' ? 'Outbound ↑' : 'Inbound ↓'}\n` +
      `From      : ${fromNum}\n` +
      `To        : ${toNum}\n` +
      `Client    : ${clientNum}\n` +
      `Duration  : ${mins}m ${secs}s\n` +
      `Call SID  : ${callSid}\n\n` +
      `▶ Play Recording:\n${proxyUrl}`;

    const entity = await findBx24EntityByPhone(clientNum);
    if (entity) {
      const result = await bx24Call('crm.activity.add', { fields: {
        OWNER_TYPE_ID:    getOwnerTypeId(entity.entityType),
        OWNER_ID:         entity.entityId,
        TYPE_ID:          2,
        SUBJECT:          `📞 Call recording — ${clientNum} (${direction})`,
        DESCRIPTION:      desc,
        DESCRIPTION_TYPE: 1,
        DIRECTION:        direction === 'outbound' ? 2 : 1,
        DURATION:         duration || 0,
        START_TIME:       callDate,
        END_TIME:         callDate,
        COMPLETED:        'Y',
        RESPONSIBLE_ID:   agentBx24Id || '1',
        COMMUNICATIONS:   [{ VALUE: clientNum, TYPE: 'PHONE' }]
      }});
      log(`BX24 activity fallback created: ID=${result}`);
      return result;
    }
  } catch (e2) {
    log(`BX24 activity fallback also failed: ${e2.message}`);
  }
  return null;
}

// ── Create new BX24 call activity (historical calls) ────────────────────
// Used when telephony.externalcall.register was never called for this call.
async function createBx24CallActivity(call, callSid, agentBx24UserId) {
  const fromNum   = call.From || '';
  const toNum     = call.To   || '';
  const duration  = parseInt(call.Duration || '0');
  const startTime = call.StartTime || call.DateCreated || new Date().toISOString();
  const rawDir    = (call.Direction || '').toLowerCase();
  const direction = rawDir.includes('outbound') ? 'outbound' : 'inbound';
  const callDate  = new Date(startTime).toISOString();
  const clientNum = direction === 'outbound' ? toNum : fromNum;
  const proxyUrl  = buildProxyUrl(callSid);
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;

  const desc =
    `📞 Exotel Call Recording\n` +
    `Direction : ${direction === 'outbound' ? 'Outbound ↑' : 'Inbound ↓'}\n` +
    `From      : ${fromNum}\n` +
    `To        : ${toNum}\n` +
    `Client    : ${clientNum}\n` +
    `Duration  : ${mins}m ${secs}s\n` +
    `Call SID  : ${callSid}\n\n` +
    `▶ Play Recording:\n${proxyUrl}`;

  const entity = await findBx24EntityByPhone(clientNum);
  if (!entity) {
    log(`No BX24 entity found for ${clientNum} (CallSid=${callSid}) — skipping`);
    return null;
  }

  const ownerTypeId   = getOwnerTypeId(entity.entityType);
  const responsibleId = agentBx24UserId || '1';
  const bx24Direction = direction === 'outbound' ? 2 : 1;
  const subject       = `📞 Call recording — ${clientNum} (${direction})`;

  // Try TYPE_ID=2 (native phone call activity with ▶ player support)
  try {
    const result = await bx24Call('crm.activity.add', { fields: {
      OWNER_TYPE_ID:    ownerTypeId,
      OWNER_ID:         entity.entityId,
      TYPE_ID:          2,
      SUBJECT:          subject,
      DESCRIPTION:      desc,
      DESCRIPTION_TYPE: 1,
      DIRECTION:        bx24Direction,
      DURATION:         duration,
      START_TIME:       callDate,
      END_TIME:         callDate,
      COMPLETED:        'Y',
      RESPONSIBLE_ID:   responsibleId,
      COMMUNICATIONS:   [{ VALUE: clientNum, TYPE: 'PHONE' }]
    }});
    log(`BX24 activity (TYPE_ID=2, ${direction}) created: ID=${result} on ${entity.entityType}=${entity.entityId}`);
    return result;
  } catch (e) {
    log(`TYPE_ID=2 rejected (${e.message}) — falling back to TYPE_ID=4`);
  }

  // Fallback: TYPE_ID=4 (custom activity — always accepted by BX24)
  try {
    const result = await bx24Call('crm.activity.add', { fields: {
      OWNER_TYPE_ID:    ownerTypeId,
      OWNER_ID:         entity.entityId,
      TYPE_ID:          4,
      SUBJECT:          subject,
      DESCRIPTION:      desc,
      DESCRIPTION_TYPE: 1,
      START_TIME:       callDate,
      END_TIME:         callDate,
      COMPLETED:        'Y',
      RESPONSIBLE_ID:   responsibleId
    }});
    log(`BX24 activity (TYPE_ID=4 fallback, ${direction}) created: ID=${result}`);
    return result;
  } catch (e) {
    log(`BX24 crm.activity.add failed entirely for ${callSid}: ${e.message}`);
    return null;
  }
}

// ── syncRecordings ───────────────────────────────────────────────────────
// Called by scheduleSync() for new calls, and directly by /sync-recordings for historical ones.
// Parameters:
//   phoneNumber  — client phone number (fetch calls from Exotel + find CRM entity)
//   agentEmail   — agent email (BX24 user ID lookup)
//   callSid      — specific Exotel CallSid we're retrying (hint: don't permanently skip)
//   bx24CallId   — BX24 CALL_ID if telephony.externalcall.register was already called
//   agentBx24Id  — BX24 numeric user ID (skips lookup when already known)
async function syncRecordings({ phoneNumber, agentEmail, callSid: hintSid, bx24CallId, agentBx24Id } = {}) {
  const results = { processed: 0, recorded: 0, posted: 0, skipped: 0, errors: [] };

  const resolvedAgentId = agentBx24Id || (agentEmail ? await getBx24UserId(agentEmail) : null);

  const calls = phoneNumber
    ? await fetchExotelCallsForNumber(phoneNumber)
    : await fetchRecentExotelCalls();

  results.processed = calls.length;
  log(`Processing ${calls.length} call(s)` + (phoneNumber ? ` for ${phoneNumber}` : ' (all recent)'));

  for (const call of calls) {
    const callSid = call.Sid || '';
    if (!callSid) continue;
    if (syncedCallSids.has(callSid)) { results.skipped++; continue; }

    const recordingExists = await fetchRecordingUrl(callSid);
    if (!recordingExists) {
      // Don't permanently skip the hint call — it may just not be ready yet
      if (callSid !== hintSid) syncedCallSids.add(callSid);
      results.skipped++;
      continue;
    }
    results.recorded++;

    let activityId = null;

    if (bx24CallId && callSid === hintSid) {
      // New call: telephony.externalcall.register was already called → update it
      const rawDir    = (call.Direction || '').toLowerCase();
      const direction = rawDir.includes('outbound') ? 'outbound' : 'inbound';
      const fromNum   = call.From || '';
      const toNum     = call.To   || '';
      const duration  = parseInt(call.Duration || '0');
      const startTime = call.StartTime || call.DateCreated || new Date().toISOString();
      const clientNum = direction === 'outbound' ? toNum : fromNum;

      activityId = await updateBx24CallRecord({
        bx24CallId,
        agentBx24Id: resolvedAgentId,
        callSid,
        duration,
        direction,
        clientNum,
        fromNum,
        toNum,
        callDate: new Date(startTime).toISOString()
      });
    } else {
      // Historical call: no prior BX24 registration → create a fresh activity
      activityId = await createBx24CallActivity(call, callSid, resolvedAgentId);
    }

    if (activityId) {
      results.posted++;
      syncedCallSids.add(callSid);
    } else {
      results.errors.push({ callSid, reason: 'BX24 update/create failed' });
    }
  }

  log(`Sync complete: ${JSON.stringify(results)}`);
  return results;
}

// ── scheduleSync ─────────────────────────────────────────────────────────
// Called from server.js /call-callback after every call ends.
// Handles the entire retry loop with exponential backoff internally —
// server.js never needs to know about retries or timing.
//
// Usage in server.js:
//   recordings.scheduleSync({ clientNum, agentEmail: finishEmail, callSid: sid,
//                             bx24CallId: finishBx24Id, agentBx24Id: finishAgentId,
//                             onSuccess: () => delete outboundCallMap[sid] });
function scheduleSync({ clientNum, agentEmail, callSid, bx24CallId, agentBx24Id, onSuccess } = {}) {
  if (!clientNum) return;

  function attempt(delayMs, attemptNum) {
    setTimeout(async () => {
      try {
        log(`Recording sync attempt ${attemptNum} for ${clientNum} (delay ${delayMs / 1000}s)`);
        const result = await syncRecordings({
          phoneNumber: clientNum,
          agentEmail,
          callSid,
          bx24CallId,
          agentBx24Id
        });
        if (result && result.posted > 0) {
          log(`Recording synced on attempt ${attemptNum}: ${JSON.stringify(result)}`);
          if (onSuccess) onSuccess();
        } else if (attemptNum < RETRY_MAX_ATTEMPTS) {
          attempt(delayMs * 2, attemptNum + 1); // exponential: 2min → 4min → 8min
        } else {
          log(`Recording not found after ${attemptNum} attempts for ${clientNum}`);
          if (onSuccess) onSuccess();
        }
      } catch (e) {
        log(`Recording sync attempt ${attemptNum} failed: ${e.message}`);
      }
    }, delayMs);
  }

  attempt(RETRY_FIRST_DELAY_MS, 1);
}

// ── GET /recording/:callSid — audio proxy ────────────────────────────────
// Streams audio from Exotel directly to the browser, authenticated server-side.
// Bitrix24's audio player loads this URL — no storage needed, never expires.
function proxyRecordingRoute(app) {
  app.get('/recording/:callSid', async (req, res) => {
    const { callSid } = req.params;
    if (!callSid) return res.status(400).send('callSid required');

    const creds = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');

    try {
      // Step 1: Fetch recording metadata to get the actual audio file URL
      const metaUrl = `${EXOTEL_V1_BASE}/Calls/${callSid}/Recordings.json`;
      const metaRes = await fetch(metaUrl, { headers: { Authorization: `Basic ${creds}` } });
      if (!metaRes.ok) {
        log(`[Proxy] Recordings.json HTTP ${metaRes.status} for ${callSid}`);
        return res.status(404).send('Recording not found');
      }
      const metaBody = await metaRes.json();
      const recList  = metaBody?.TwilioResponse?.Recordings?.Recording;
      const rec      = Array.isArray(recList) ? recList[0] : recList;
      if (!rec) return res.status(404).send('No recording available yet');

      // Step 2: Build the raw audio URL (strip .json suffix)
      let audioUrl = rec.Uri || '';
      if (!audioUrl.startsWith('http'))
        audioUrl = `https://${EXOTEL_API_HOST}${audioUrl}`;
      audioUrl = audioUrl.replace(/\.json$/, '');
      log(`[Proxy] Streaming ${callSid} → ${audioUrl}`);

      // Step 3: Fetch audio from Exotel and pipe directly to the browser response
      const audioRes = await fetch(audioUrl, { headers: { Authorization: `Basic ${creds}` } });
      if (!audioRes.ok) {
        log(`[Proxy] Audio fetch HTTP ${audioRes.status} for ${callSid}`);
        return res.status(audioRes.status).send('Audio fetch failed');
      }

      res.setHeader('Content-Type', audioRes.headers.get('content-type') || 'audio/mpeg');
      const contentLength = audioRes.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*'); // allow BX24 iframe to load
      res.setHeader('Cache-Control', 'private, max-age=3600');

      audioRes.body.pipe(res);
    } catch (e) {
      log(`[Proxy] Error for ${callSid}: ${e.message}`);
      if (!res.headersSent) res.status(500).send('Proxy error');
    }
  });
}

// ── init — registers all routes with the Express app ────────────────────
// Called once from server.js: recordings.init(app)
// Registers:
//   GET  /recording/:callSid   — audio proxy (used by BX24 ▶ player)
//   POST /sync-recordings      — manual sync trigger
//   GET  /sync-recordings      — manual sync trigger (browser-friendly)
function init(app) {
  proxyRecordingRoute(app);

  app.post('/sync-recordings', async (req, res) => {
    const { phoneNumber, agentEmail } = req.body || {};
    log(`POST /sync-recordings — phoneNumber=${phoneNumber || '(all)'} agentEmail=${agentEmail || '(none)'}`);
    try { res.json({ status: 'ok', ...await syncRecordings({ phoneNumber, agentEmail }) }); }
    catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
  });

  app.get('/sync-recordings', async (req, res) => {
    const { phoneNumber, agentEmail } = req.query;
    log(`GET /sync-recordings — phoneNumber=${phoneNumber || '(all)'} agentEmail=${agentEmail || '(none)'}`);
    try { res.json({ status: 'ok', ...await syncRecordings({ phoneNumber, agentEmail }) }); }
    catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
  });

  log('Routes registered: GET /recording/:callSid, POST /sync-recordings, GET /sync-recordings');
}

module.exports = { init, scheduleSync, syncRecordings };
