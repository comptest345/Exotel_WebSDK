// ═══════════════════════════════════════════════════════════════════════════
// exotel-recordings.js
// ═══════════════════════════════════════════════════════════════════════════
// Architecture:
//   Exotel records call
//     ↓ /call-callback fires (server.js, 2-5 min after call ends)
//     ↓ syncRecordings() called with callSid + bx24CallId
//     ↓ fetchRecordingUrl() confirms recording exists in Exotel
//     ↓ buildProxyUrl() builds permanent proxy URL on OUR server
//     ↓ updateBx24CallRecord() calls telephony.externalcall.hide +
//                              crm.activity.update to attach RECORD_URL
//     ↓ Bitrix24 timeline shows native call entry with ▶ Play button
//     ↓ Agent clicks play → browser hits /recording/:callSid on our server
//     ↓ Our server streams audio from Exotel (authenticated, no storage)
//
// For historical calls (/sync-recordings):
//     ↓ fetchRecentExotelCalls() or fetchExotelCallsForNumber()
//     ↓ For each call with a recording:
//       - If bx24CallId known → updateBx24CallRecord (update existing entry)
//       - If not known       → createBx24CallActivity (create new entry)
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');

const ACCOUNT_SID  = process.env.EXOTEL_ACCOUNT_SID || '';
const API_KEY      = process.env.EXOTEL_API_KEY      || '';
const API_TOKEN    = process.env.EXOTEL_API_TOKEN    || '';
const BX24_WEBHOOK = process.env.BX24_WEBHOOK_URL    || '';
const DOMAIN       = process.env.EXOTEL_DOMAIN       || 'singapore';
const RENDER_URL   = process.env.RENDER_URL          || 'https://exotel-websdk.onrender.com';

const isIndia         = /mum|in1|india/i.test(DOMAIN);
const EXOTEL_API_HOST = process.env.EXOTEL_API_HOST || (isIndia ? 'api.in.exotel.com' : 'api.exotel.com');
const EXOTEL_V1_BASE  = `https://${EXOTEL_API_HOST}/v1/Accounts/${ACCOUNT_SID}`;

// In-memory skip set — prevents duplicate activity creation within one server session.
// Entries are only added when a recording was SUCCESSFULLY posted to BX24.
const syncedCallSids  = new Set();
const bx24UserIdCache = {};

function log(msg) { console.log('[Recordings]', msg); }

// ── Exotel V1 API helper ─────────────────────────────────────────────────
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

// ── Phone number variants ────────────────────────────────────────────────
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

// ── Fetch Exotel calls ───────────────────────────────────────────────────
async function fetchExotelCallsForNumber(phoneNumber) {
  const calls = new Map();
  for (const field of ['From', 'To']) {
    try {
      const data = await exotelGet('/Calls.json', { [field]: phoneNumber, PageSize: 50 });
      const list = (data && data.TwilioResponse && data.TwilioResponse.Calls && data.TwilioResponse.Calls.Call) || [];
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
    const list = (data && data.TwilioResponse && data.TwilioResponse.Calls && data.TwilioResponse.Calls.Call) || [];
    const arr  = Array.isArray(list) ? list : [list];
    log(`Exotel /Calls (all recent) → ${arr.length} result(s)`);
    return arr;
  } catch (e) { log(`Exotel all-calls fetch failed: ${e.message}`); return []; }
}

// ── Fetch recording URL from Exotel ─────────────────────────────────────
async function fetchRecordingUrl(callSid) {
  try {
    const data = await exotelGet(`/Calls/${callSid}/Recordings.json`);
    const list = (data && data.TwilioResponse && data.TwilioResponse.Recordings && data.TwilioResponse.Recordings.Recording) || [];
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
// Instead of storing Exotel's auth-required URL in BX24, we point to our
// own /recording/:callSid endpoint which proxies the audio on demand.
// This URL never expires and handles auth invisibly.
function buildProxyUrl(callSid) {
  return `${RENDER_URL}/recording/${callSid}`;
}

function getOwnerTypeId(entityType) {
  return { LEAD: 1, DEAL: 2, CONTACT: 3 }[entityType] || 3;
}

// ── Update existing BX24 telephony call record with RECORD_URL ───────────
// Used for new calls (inbound + outbound) where telephony.externalcall.register
// was already called and we have the BX24 CALL_ID.
// telephony.externalcall.hide updates the call's recording URL so BX24
// renders a native ▶ Play button in the timeline.
async function updateBx24CallRecord({ bx24CallId, agentBx24Id, callSid, duration, direction, clientNum, fromNum, toNum, callDate }) {
  const proxyUrl = buildProxyUrl(callSid);
  log(`Updating BX24 call CALL_ID=${bx24CallId} with RECORD_URL=${proxyUrl}`);

  // telephony.externalcall.hide attaches the recording URL to an existing call activity.
  // This is the correct BX24 API for attaching recordings — it updates the call entry
  // that was created by telephony.externalcall.register/finish and adds the audio player.
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

  // Fallback: find the CRM activity created by telephony and update it with the recording URL
  // in the DESCRIPTION so agents can at least click the link.
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
      const ownerTypeId   = getOwnerTypeId(entity.entityType);
      const bx24Direction = direction === 'outbound' ? 2 : 1;
      const result = await bx24Call('crm.activity.add', { fields: {
        OWNER_TYPE_ID:    ownerTypeId,
        OWNER_ID:         entity.entityId,
        TYPE_ID:          2,
        SUBJECT:          `📞 Call recording — ${clientNum} (${direction})`,
        DESCRIPTION:      desc,
        DESCRIPTION_TYPE: 1,
        DIRECTION:        bx24Direction,
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

// ── Create new BX24 call activity ────────────────────────────────────────
// Used for HISTORICAL calls where telephony.externalcall.register was never
// called (e.g. calls before this code was deployed, or outbound calls
// from before the BX24 registration was added).
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

  // Fallback: TYPE_ID=4 (custom activity — always accepted)
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

// ── Main sync function ───────────────────────────────────────────────────
// Called from server.js /call-callback (for new calls) and /sync-recordings (historical).
// Parameters:
//   phoneNumber  — client phone number (used to fetch calls + find CRM entity)
//   agentEmail   — agent's email (for BX24 user ID lookup)
//   callSid      — specific Exotel CallSid we're retrying for (hint: don't permanently skip)
//   bx24CallId   — BX24 CALL_ID if telephony.externalcall.register was already called
//   agentBx24Id  — BX24 numeric user ID (skips lookup if already known)
async function syncRecordings({ phoneNumber, agentEmail, callSid: hintSid, bx24CallId, agentBx24Id } = {}) {
  const results = { processed: 0, recorded: 0, posted: 0, skipped: 0, errors: [] };

  // Resolve agent BX24 ID — prefer passed-in value, fall back to email lookup
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

    // Confirm recording exists in Exotel before doing anything
    const recordingExists = await fetchRecordingUrl(callSid);
    if (!recordingExists) {
      // Don't permanently skip the hint call — it may not be ready yet (retry handles it)
      if (callSid !== hintSid) syncedCallSids.add(callSid);
      results.skipped++;
      continue;
    }
    results.recorded++;

    let activityId = null;

    if (bx24CallId && callSid === hintSid) {
      // NEW CALL PATH: telephony.externalcall.register was already called.
      // Update the existing BX24 call record with our proxy RECORD_URL.
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
      // HISTORICAL CALL PATH: no prior BX24 registration → create a fresh activity.
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

// ── Express routes ───────────────────────────────────────────────────────
function init(app) {
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

  log('Routes registered: POST /sync-recordings, GET /sync-recordings');
}

module.exports = { init, syncRecordings };
