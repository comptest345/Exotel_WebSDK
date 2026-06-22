// ═══════════════════════════════════════════════════════════════════════════
// exotel-recordings.js  ← EDIT ONLY THIS FILE for anything recording-related
// ═══════════════════════════════════════════════════════════════════════════
//
// IMPORTANT — NO AUDIO STREAMING INSIDE BITRIX24.
// Bitrix24 only ever shows METADATA (call type, caller, agent, start/end time,
// duration, status, Exotel Call SID, and a "View Recording" link). The
// recording itself is NEVER stored, proxied, or streamed through our server —
// clicking "View Recording" redirects the browser straight to a freshly
// fetched Exotel URL, so it can never expire and we never host any audio.
//
// Architecture:
//   Exotel records call
//     ↓ server.js /call-callback fires → calls recordings.scheduleSync(...)
//     ↓ scheduleSync() retries with exponential backoff (2 min → 4 min → 8 min)
//     ↓ syncRecordings() confirms recording exists — checks RecordingUrl /
//         PreSignedRecordingUrl already on the call object first (no extra
//         API call needed), falls back to fetchRecordingUrl() only if absent
//     ↓ buildRecordingLink() builds a permanent link on OUR server:
//         GET /recording/:callSid  ← stored in Bitrix24, never the raw Exotel URL
//     ↓ updateBx24CallRecord() / createBx24CallActivity() write ONLY
//         metadata + Call SID + the permanent link into Bitrix24
//     ↓ Bitrix24 timeline card shows: Direction, From, To, Agent, Start,
//         End, Duration, Status, Call SID, and a clickable "View Recording"
//     ↓ Agent clicks "View Recording" → GET /recording/:callSid on our server
//     ↓ recordingRedirectRoute() calls Exotel Call Details API right then,
//         reads PreSignedRecordingUrl || RecordingUrl, 302-redirects browser.
//         Nothing is stored or piped through us.
//
// Recording URL resolution (official Exotel approach):
//   GET /Calls/<CallSid>.json
//   Response: { "Call": { "RecordingUrl": "...", "PreSignedRecordingUrl": "..." } }
//   PreSignedRecordingUrl is preferred (secure-recording accounts).
//   Because the URL is fetched fresh on every click, expiring signed URLs
//   are a non-issue — we never persist a recording URL anywhere.
//
// For historical calls (POST/GET /sync-recordings):
//     ↓ fetchExotelCallsForNumber() or fetchRecentExotelCalls(direction?)
//         direction filter: 'inbound' | 'outbound-api' | 'inbound,outbound-api,outbound-dial'
//     ↓ For each call with a recording:
//         bx24CallId known → updateBx24CallRecord  (update existing timeline entry)
//         bx24CallId unknown → createBx24CallActivity (create new timeline entry)
//
// ── What server.js does for recordings (the ONLY surface you never touch) ──
//   • require('./exotel-recordings')
//   • recordings.init(app)              ← registers /recording/:callSid + /sync-recordings
//   • recordings.scheduleSync({...})    ← called from /call-callback after each call ends
//
// Everything else — retry logic, Exotel API calls, BX24 updates, redirect —
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
// First retry delay: default 30 s (fast feedback in dev/test).
// Set EXOTEL_RECORDING_DELAY_SEC=120 in env to restore the 2-min production delay.
const RETRY_FIRST_DELAY_MS = (parseInt(process.env.EXOTEL_RECORDING_DELAY_SEC || '30') * 1000);
const RETRY_MAX_ATTEMPTS   = 4;               // attempts: 30s → 60s → 120s → 240s

// ── Dedup — prevents posting the same recording twice ───────────────────
// Persisted to disk so server restarts don't create duplicate BX24 activities.
const DEDUP_FILE     = process.env.DEDUP_FILE || '/tmp/synced_call_sids.json';
const syncedCallSids = new Set();
const bx24UserIdCache = {};

// Load persisted sids on startup (non-fatal if file doesn't exist)
try {
  const fs   = require('fs');
  const data = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
  if (Array.isArray(data)) data.forEach(s => syncedCallSids.add(s));
  log(`Loaded ${syncedCallSids.size} dedup SIDs from ${DEDUP_FILE}`);
} catch (_) { /* file doesn't exist yet — that's fine */ }

// Save dedup state after each new SID is added
function persistDedupSids() {
  try {
    const fs = require('fs');
    fs.writeFileSync(DEDUP_FILE, JSON.stringify([...syncedCallSids]), 'utf8');
  } catch (e) { log(`Dedup persist failed (non-fatal): ${e.message}`); }
}

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
  const raw    = (phoneNumber || '').trim();
  const digits = raw.replace(/\D/g, '');
  // Universal: works for any country — no hardcoded country code
  const withPlus  = digits ? `+${digits}` : '';
  const withPlus2 = raw.startsWith('+') ? raw : '';   // keep original if already E.164
  // Local number = strip leading country code (1–3 digits), keep last 7–10 digits
  const local = digits.length > 10 ? digits.slice(digits.length - 10) :
                digits.length >= 7  ? digits : '';
  const with0 = local ? `0${local}` : '';             // trunk prefix used in many countries
  const seen = new Set();
  const variants = [];
  for (const v of [raw, withPlus, withPlus2, digits, local, with0]) {
    if (v && v.length >= 7 && !seen.has(v)) { seen.add(v); variants.push(v); }
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

  // No existing entity — auto-create a Lead so the call appears in the timeline.
  // Set EXOTEL_AUTO_CREATE_LEAD=false in env to disable this behaviour.
  if (process.env.EXOTEL_AUTO_CREATE_LEAD === 'false') {
    log(`No BX24 entity found for ${phoneNumber} — auto-create disabled`);
    return null;
  }
  try {
    const newLead = await bx24Call('crm.lead.add', {
      fields: {
        TITLE:  `Exotel Call — ${phoneNumber}`,
        PHONE:  [{ VALUE: phoneNumber, VALUE_TYPE: 'WORK' }],
        STATUS_ID: 'NEW',
        SOURCE_ID: 'CALL'
      }
    });
    const leadId = String(newLead);
    log(`Auto-created LEAD ID=${leadId} for unknown number ${phoneNumber}`);
    return { entityType: 'LEAD', entityId: leadId };
  } catch (e) {
    log(`Auto-create Lead failed for ${phoneNumber}: ${e.message}`);
    return null;
  }
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

// Fetch recent calls, optionally filtered by direction.
// direction may be a single string or comma-separated list, e.g.:
//   'inbound'  |  'outbound-api'  |  'inbound,outbound-api,outbound-dial'
async function fetchRecentExotelCalls(direction, fromDate, toDate) {
  try {
    const params = { PageSize: 200 };
    if (direction) params.Direction = direction;
    // Date format Exotel expects: YYYY-MM-DD HH:MM:SS (URL-encoded)
    if (fromDate) params.DateCreated = fromDate;   // e.g. '2026-06-01'
    if (toDate)   params.DateUpdated = toDate;
    const data = await exotelGet('/Calls.json', params);
    const list = (data?.TwilioResponse?.Calls?.Call) || [];
    const arr  = Array.isArray(list) ? list : [list];
    log(`Exotel /Calls (direction=${direction || 'all'} from=${fromDate || '-'} to=${toDate || '-'}) → ${arr.length} result(s)`);
    return arr;
  } catch (e) { log(`Exotel all-calls fetch failed: ${e.message}`); return []; }
}

// ── Fetch recording URL from Exotel (via Call Details API) ───────────────
// Uses GET /Calls/<CallSid>.json — the official way to retrieve recordings.
// Prefers PreSignedRecordingUrl (secure accounts) over RecordingUrl.
// Returns null if the call has no recording yet.
async function fetchRecordingUrl(callSid) {
  try {
    const data = await exotelGet(`/Calls/${callSid}.json`);
    const call = data?.TwilioResponse?.Call || data?.Call || {};
    const url  = call.PreSignedRecordingUrl || call.RecordingUrl || null;
    if (url) log(`Recording URL for ${callSid}: ${url.slice(0, 80)}…`);
    return url || null;
  } catch (e) {
    if (!e.message.includes('404')) log(`Recording fetch failed for ${callSid}: ${e.message}`);
    return null;
  }
}

// ── Build permanent "View Recording" link ────────────────────────────────
// Points to our own GET /recording/:callSid.
// This is what gets stored in Bitrix24 — NEVER the raw Exotel URL.
// Clicking it does a 302-redirect to a freshly fetched Exotel URL on demand.
function buildRecordingLink(callSid) {
  return `${RENDER_URL}/recording/${callSid}`;
}

function getOwnerTypeId(entityType) {
  return { LEAD: 1, DEAL: 2, CONTACT: 3 }[entityType] || 3;
}

// ── Update existing BX24 telephony call record ───────────────────────────
// Used for new calls where telephony.externalcall.register was already called.
// Attaches the permanent "View Recording" link via telephony.externalcall.hide,
// then (always) creates a metadata activity card on the CRM entity so agents
// can see all fields: Direction, From, To, Agent, Start, End, Duration, Status,
// Call SID, and a clickable View Recording link.
async function updateBx24CallRecord({
  bx24CallId, agentBx24Id, agentEmail, callSid,
  duration, direction, status,
  clientNum, fromNum, toNum,
  callDate, endDate
}) {
  const recordingLink = buildRecordingLink(callSid);
  log(`Updating BX24 call CALL_ID=${bx24CallId} — recording link: ${recordingLink}`);

  // Attach recording link to the existing telephony entry (shows ▶ in BX24 call log).
  // RECORD_URL is our redirect link — never the raw Exotel URL.
  try {
    await bx24Call('telephony.externalcall.hide', {
      CALL_ID:    bx24CallId,
      USER_ID:    agentBx24Id || '1',
      RECORD_URL: recordingLink
    });
    log(`BX24 telephony.externalcall.hide OK — CALL_ID=${bx24CallId}`);
  } catch (e) {
    log(`telephony.externalcall.hide failed (${e.message}) — continuing to activity card`);
  }

  // Always also create a metadata activity card so agents see all fields.
  const mins = Math.floor((duration || 0) / 60);
  const secs = (duration || 0) % 60;
  const fmtDate = d => { try { return new Date(d).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:true}); } catch(_){ return d; } };
  const desc =
    `☎ ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call\n\n` +
    `Agent     : ${agentEmail || (agentBx24Id ? `User #${agentBx24Id}` : 'Unassigned')}\n` +
    `From      : ${fromNum}\n` +
    `To        : ${toNum}\n` +
    `Customer  : ${clientNum}\n` +
    `Start     : ${fmtDate(callDate)}\n` +
    `End       : ${fmtDate(endDate || callDate)}\n` +
    `Duration  : ${mins}m ${secs}s\n` +
    `Status    : ${status || 'Completed'}\n` +
    `Call SID  : ${callSid}\n\n` +
    `Recording : [URL=${recordingLink}]View Recording[/URL]`;

  const entity = await findBx24EntityByPhone(clientNum);
  if (!entity) {
    log(`⚠️  No BX24 entity for ${clientNum} and auto-create is off — activity NOT posted to timeline`);
    return bx24CallId;
  }

  try {
    const result = await bx24Call('crm.activity.add', { fields: {
      OWNER_TYPE_ID:    getOwnerTypeId(entity.entityType),
      OWNER_ID:         entity.entityId,
      TYPE_ID:          2,
      SUBJECT:          `📞 ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call — ${clientNum}`,
      DESCRIPTION:      desc,
      DESCRIPTION_TYPE: 2,   // BBCode — required for [URL=…] to render as a clickable link
      DIRECTION:        direction === 'outbound' ? 2 : 1,
      DURATION:         duration || 0,
      START_TIME:       callDate,
      END_TIME:         endDate || callDate,
      COMPLETED:        'Y',
      RESPONSIBLE_ID:   agentBx24Id || '1',
      COMMUNICATIONS:   [{ VALUE: clientNum, TYPE: 'PHONE' }]
    }});
    log(`BX24 metadata activity created: ID=${result} on ${entity.entityType}=${entity.entityId}`);
    return result;
  } catch (e) {
    log(`BX24 crm.activity.add (update path) failed: ${e.message}`);
  }
  return bx24CallId;
}

// ── Create new BX24 call activity (historical / unregistered calls) ──────
// Used when telephony.externalcall.register was never called for this call.
// Stores ONLY metadata + the permanent "View Recording" link — never the raw
// Exotel URL. The activity description is BBCode so the link is clickable.
async function createBx24CallActivity(call, callSid, agentBx24UserId) {
  const fromNum   = call.From || '';
  const toNum     = call.To   || '';
  const duration  = parseInt(call.Duration || '0');
  const startTime = call.StartTime || call.DateCreated || new Date().toISOString();
  const endTime   = call.EndTime   || null;
  const status    = call.Status    || 'completed';
  const rawDir    = (call.Direction || '').toLowerCase();
  const direction = rawDir.includes('outbound') ? 'outbound' : 'inbound';
  const callDate  = new Date(startTime).toISOString();
  const endDate   = endTime ? new Date(endTime).toISOString() : callDate;
  const clientNum = direction === 'outbound' ? toNum : fromNum;
  const recordingLink = buildRecordingLink(callSid);
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;

  const fmtDate = d => { try { return new Date(d).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:true}); } catch(_){ return d; } };
  const desc =
    `☎ ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call\n\n` +
    `Agent     : ${agentBx24UserId ? `User #${agentBx24UserId}` : 'Unassigned'}\n` +
    `From      : ${fromNum}\n` +
    `To        : ${toNum}\n` +
    `Customer  : ${clientNum}\n` +
    `Start     : ${fmtDate(callDate)}\n` +
    `End       : ${fmtDate(endDate)}\n` +
    `Duration  : ${mins}m ${secs}s\n` +
    `Status    : ${status}\n` +
    `Call SID  : ${callSid}\n\n` +
    `Recording : [URL=${recordingLink}]View Recording[/URL]`;

  const entity = await findBx24EntityByPhone(clientNum);
  if (!entity) {
    log(`⚠️  No BX24 entity for ${clientNum} (CallSid=${callSid}) and auto-create is off — activity NOT posted to timeline`);
    return null;
  }

  const ownerTypeId   = getOwnerTypeId(entity.entityType);
  const responsibleId = agentBx24UserId || '1';
  const bx24Direction = direction === 'outbound' ? 2 : 1;
  const subject       = `📞 ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call — ${clientNum}`;

  // Try TYPE_ID=2 (native phone call activity)
  try {
    const result = await bx24Call('crm.activity.add', { fields: {
      OWNER_TYPE_ID:    ownerTypeId,
      OWNER_ID:         entity.entityId,
      TYPE_ID:          2,
      SUBJECT:          subject,
      DESCRIPTION:      desc,
      DESCRIPTION_TYPE: 2,   // BBCode — required for [URL=…] to render as a clickable link
      DIRECTION:        bx24Direction,
      DURATION:         duration,
      START_TIME:       callDate,
      END_TIME:         endDate,
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
      DESCRIPTION_TYPE: 2,
      START_TIME:       callDate,
      END_TIME:         endDate,
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
//   direction    — optional direction filter for bulk fetch: 'inbound', 'outbound-api',
//                  or comma-separated e.g. 'inbound,outbound-api,outbound-dial'
async function syncRecordings({ phoneNumber, agentEmail, callSid: hintSid, bx24CallId, agentBx24Id, direction, fromDate, toDate } = {}) {
  const results = { processed: 0, recorded: 0, posted: 0, skipped: 0, errors: [] };

  const resolvedAgentId = agentBx24Id || (agentEmail ? await getBx24UserId(agentEmail) : null);

  const calls = phoneNumber
    ? await fetchExotelCallsForNumber(phoneNumber)
    : await fetchRecentExotelCalls(direction, fromDate, toDate);

  results.processed = calls.length;
  log(`Processing ${calls.length} call(s)` + (phoneNumber ? ` for ${phoneNumber}` : ' (all recent)'));

  for (const call of calls) {
    const callSid = call.Sid || '';
    if (!callSid) continue;
    if (syncedCallSids.has(callSid)) { results.skipped++; continue; }

    // Check recording existence from the already-fetched call object first
    // (most Exotel list responses include RecordingUrl / PreSignedRecordingUrl).
    // Only fall back to a per-call API hit if neither field is present.
    let recordingExists = !!(call.RecordingUrl || call.PreSignedRecordingUrl);
    if (!recordingExists) recordingExists = !!(await fetchRecordingUrl(callSid));

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
      const dir       = rawDir.includes('outbound') ? 'outbound' : 'inbound';
      const fromNum   = call.From || '';
      const toNum     = call.To   || '';
      const duration  = parseInt(call.Duration || '0');
      const startTime = call.StartTime || call.DateCreated || new Date().toISOString();
      const endTime   = call.EndTime   || null;
      const status    = call.Status    || 'completed';
      const clientNum = dir === 'outbound' ? toNum : fromNum;

      activityId = await updateBx24CallRecord({
        bx24CallId,
        agentBx24Id: resolvedAgentId,
        agentEmail,
        callSid,
        duration,
        direction:  dir,
        status,
        clientNum,
        fromNum,
        toNum,
        callDate: new Date(startTime).toISOString(),
        endDate:  endTime ? new Date(endTime).toISOString() : undefined
      });
    } else {
      // Historical call: no prior BX24 registration → create a fresh activity
      activityId = await createBx24CallActivity(call, callSid, resolvedAgentId);
    }

    if (activityId) {
      results.posted++;
      syncedCallSids.add(callSid);
      persistDedupSids();
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

// ── GET /recording/:callSid — "View Recording" redirect ─────────────────
// NO AUDIO IS STREAMED OR STORED HERE.
// On every click, fetches Call Details API fresh and 302-redirects the browser
// straight to Exotel's RecordingUrl / PreSignedRecordingUrl.
// Because the URL is fetched at click-time, it can never have expired.
// We never persist a recording URL anywhere — not in Bitrix24, not in memory.
function recordingRedirectRoute(app) {
  app.get('/recording/:callSid', async (req, res) => {
    const { callSid } = req.params;
    if (!callSid) return res.status(400).send('callSid required');

    try {
      const audioUrl = await fetchRecordingUrl(callSid);
      if (!audioUrl) {
        log(`[Redirect] No recording URL available yet for ${callSid}`);
        return res.status(404).send('No recording available yet');
      }
      log(`[Redirect] ${callSid} → ${audioUrl.slice(0, 80)}…`);

      // 302 temporary redirect — browser goes straight to Exotel.
      // Nothing is read, stored, or piped through our server.
      res.redirect(302, audioUrl);
    } catch (e) {
      log(`[Redirect] Error for ${callSid}: ${e.message}`);
      if (!res.headersSent) res.status(500).send('Lookup error');
    }
  });
}

// ── init — registers all routes with the Express app ────────────────────
// Called once from server.js: recordings.init(app)
// Registers:
//   GET  /recording/:callSid   — 302 redirect to fresh Exotel recording URL
//   POST /sync-recordings      — manual sync trigger
//   GET  /sync-recordings      — manual sync trigger (browser-friendly)
function init(app) {
  recordingRedirectRoute(app);

  app.post('/sync-recordings', async (req, res) => {
    const { phoneNumber, agentEmail, direction, fromDate, toDate } = req.body || {};
    log(`POST /sync-recordings — phoneNumber=${phoneNumber || '(all)'} direction=${direction || '(all)'} from=${fromDate || '-'} to=${toDate || '-'}`);
    try { res.json({ status: 'ok', ...await syncRecordings({ phoneNumber, agentEmail, direction, fromDate, toDate }) }); }
    catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
  });

  app.get('/sync-recordings', async (req, res) => {
    const { phoneNumber, agentEmail, direction, fromDate, toDate } = req.query;
    log(`GET /sync-recordings — phoneNumber=${phoneNumber || '(all)'} direction=${direction || '(all)'} from=${fromDate || '-'} to=${toDate || '-'}`);
    try { res.json({ status: 'ok', ...await syncRecordings({ phoneNumber, agentEmail, direction, fromDate, toDate }) }); }
    catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
  });

  log('Routes registered: GET /recording/:callSid (redirect), POST /sync-recordings, GET /sync-recordings');
}

module.exports = { init, scheduleSync, syncRecordings };
