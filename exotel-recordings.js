// ═══════════════════════════════════════════════════════════════════════════
// exotel-recordings.js  ← EDIT ONLY THIS FILE for anything recording-related
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');

// ── Config ────────────────────────────────────────────────────────────────
const ACCOUNT_SID  = process.env.EXOTEL_ACCOUNT_SID || '';
const API_KEY      = process.env.EXOTEL_API_KEY      || '';
const API_TOKEN    = process.env.EXOTEL_API_TOKEN    || '';
const BX24_WEBHOOK = process.env.BX24_WEBHOOK_URL    || '';
const DOMAIN       = process.env.EXOTEL_DOMAIN       || 'singapore';
const RENDER_URL   = process.env.RENDER_URL          || 'https://exotel-websdk.onrender.com';

const isIndia         = /mum|in1|india/i.test(DOMAIN);
const EXOTEL_API_HOST = process.env.EXOTEL_API_HOST || (isIndia ? 'api.in.exotel.com' : 'api.exotel.com');
const EXOTEL_V1_BASE  = `https://${EXOTEL_API_HOST}/v1/Accounts/${ACCOUNT_SID}`;
// v2 CCM API — this is what actually places calls, and where recordings live
const EXOTEL_V2_BASE  = process.env.EXOTEL_V2_HOST
  ? `https://${process.env.EXOTEL_V2_HOST}/v2/accounts/${ACCOUNT_SID}`
  : `https://ccm-api.exotel.com/v2/accounts/${ACCOUNT_SID}`;

const RETRY_FIRST_DELAY_MS = (parseInt(process.env.EXOTEL_RECORDING_DELAY_SEC || '30') * 1000);
const RETRY_MAX_ATTEMPTS   = 4;

// ── Logger ────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[Recordings] [${new Date().toISOString()}] ${msg}`); }

// ── Startup config dump ───────────────────────────────────────────────────
log('════════════════ STARTUP CONFIG ════════════════');
log(`  EXOTEL_ACCOUNT_SID : ${ACCOUNT_SID  ? ACCOUNT_SID  : '⚠️  NOT SET'}`);
log(`  EXOTEL_API_KEY     : ${API_KEY      ? '✅ set'      : '⚠️  NOT SET'}`);
log(`  EXOTEL_API_TOKEN   : ${API_TOKEN    ? '✅ set'      : '⚠️  NOT SET'}`);
log(`  BX24_WEBHOOK_URL   : ${BX24_WEBHOOK ? '✅ set'      : '⚠️  NOT SET'}`);
log(`  EXOTEL_DOMAIN      : ${DOMAIN}`);
log(`  EXOTEL_API_HOST    : ${EXOTEL_API_HOST}`);
log(`  EXOTEL_V1_BASE     : ${EXOTEL_V1_BASE}`);
log(`  EXOTEL_V2_BASE     : ${EXOTEL_V2_BASE}`);
log(`  RENDER_URL         : ${RENDER_URL}`);
log(`  RETRY first delay  : ${RETRY_FIRST_DELAY_MS / 1000}s, max attempts: ${RETRY_MAX_ATTEMPTS}`);
log(`  POLL interval      : ${Math.max(5, parseInt(process.env.EXOTEL_RECORDING_POLL_SEC || '10'))}s`);
log(`  POLL disabled      : ${process.env.EXOTEL_RECORDING_POLL_DISABLED || 'false'}`);
log(`  AUTO_CREATE_LEAD   : ${process.env.EXOTEL_AUTO_CREATE_LEAD || 'true (default)'}`);
log('════════════════════════════════════════════════');

// ── Call registry — server.js calls registerCall() when a call is placed ──
// Maps exotelSid → { bx24CallId, agentEmail, agentBx24Id, phone, direction, ts }
const callRegistry = new Map();

function registerCall(exotelSid, data) {
  if (!exotelSid) return;
  callRegistry.set(exotelSid, { ...data, ts: Date.now(), recordingSynced: false });
  log(`[Registry] Registered SID=${exotelSid} bx24CallId=${data.bx24CallId} phone=${data.phone} agent=${data.agentEmail}`);
  // Cleanup entries older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [sid, d] of callRegistry) { if (d.ts < cutoff) { callRegistry.delete(sid); } }
}

// ── Injectable agent resolver ─────────────────────────────────────────────
let _agentResolver = null;
function setAgentResolver(fn) { _agentResolver = fn; }
async function resolveAgent(fromNum) {
  if (!_agentResolver || !fromNum) return { bx24UserId: null, email: null };
  try { return (await _agentResolver(fromNum)) || { bx24UserId: null, email: null }; }
  catch (e) { return { bx24UserId: null, email: null }; }
}

// ── Dedup ─────────────────────────────────────────────────────────────────
const DEDUP_FILE      = process.env.DEDUP_FILE || '/tmp/synced_call_sids.json';
const syncedCallSids  = new Set();
const bx24UserIdCache = {};

try {
  const fs   = require('fs');
  const data = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
  if (Array.isArray(data)) data.forEach(s => syncedCallSids.add(s));
  log(`Dedup: loaded ${syncedCallSids.size} already-synced SIDs from ${DEDUP_FILE}`);
} catch (_) { log('Dedup: no existing file — starting fresh'); }

function persistDedupSids() {
  try {
    const fs = require('fs');
    fs.writeFileSync(DEDUP_FILE, JSON.stringify([...syncedCallSids]), 'utf8');
    log(`Dedup: persisted ${syncedCallSids.size} SIDs to disk`);
  } catch (e) { log(`Dedup: persist failed (non-fatal): ${e.message}`); }
}

// ── Exotel REST helper ────────────────────────────────────────────────────
async function exotelGet(path, params) {
  if (!ACCOUNT_SID || !API_KEY || !API_TOKEN)
    throw new Error('EXOTEL_ACCOUNT_SID / EXOTEL_API_KEY / EXOTEL_API_TOKEN not set');

  const creds = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
  const qs    = params ? '?' + new URLSearchParams(params).toString() : '';
  const url   = `${EXOTEL_V1_BASE}${path}${qs}`;

  log(`[ExotelAPI] → GET ${url}`);
  const res  = await fetch(url, { headers: { Authorization: `Basic ${creds}` } });
  const body = await res.text();
  log(`[ExotelAPI] ← HTTP ${res.status} for ${path} (body length: ${body.length} chars)`);

  if (!res.ok) {
    log(`[ExotelAPI] ❌ Error body: ${body.slice(0, 500)}`);
    throw new Error(`Exotel ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  try {
    const parsed = JSON.parse(body);
    log(`[ExotelAPI] ✅ Parsed JSON OK for ${path}`);
    return parsed;
  } catch (e) {
    log(`[ExotelAPI] ❌ JSON parse failed for ${path}: ${e.message} | raw: ${body.slice(0, 200)}`);
    throw e;
  }
}

// ── Exotel v2 CCM API helper ──────────────────────────────────────────────
// Calls are PLACED via v2 — recordings also live in v2 response.
async function exotelV2Get(path) {
  if (!ACCOUNT_SID || !API_KEY || !API_TOKEN)
    throw new Error('EXOTEL credentials not set');
  const creds = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
  const url   = `${EXOTEL_V2_BASE}${path}`;
  log(`[ExotelV2] → GET ${url}`);
  const res  = await fetch(url, { headers: { Authorization: `Basic ${creds}` } });
  const body = await res.text();
  log(`[ExotelV2] ← HTTP ${res.status} (body: ${body.length} chars)`);
  if (!res.ok) {
    log(`[ExotelV2] ❌ Error: ${body.slice(0, 300)}`);
    throw new Error(`Exotel v2 ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  try {
    const parsed = JSON.parse(body);
    log(`[ExotelV2] ✅ Parsed OK`);
    return parsed;
  } catch (e) {
    log(`[ExotelV2] ❌ JSON parse failed: ${e.message} | raw: ${body.slice(0, 200)}`);
    throw e;
  }
}

// ── Bitrix24 REST helper ──────────────────────────────────────────────────
async function bx24Call(method, params) {
  if (!BX24_WEBHOOK) throw new Error('BX24_WEBHOOK_URL not set');

  const url = `${BX24_WEBHOOK}${method}.json`;
  log(`[BX24] → POST ${method} | params: ${JSON.stringify(params).slice(0, 300)}`);

  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params)
  });
  const data = await res.json();

  if (data.error) {
    log(`[BX24] ❌ ${method} failed: error="${data.error}" desc="${data.error_description || ''}"`);
    throw new Error(`BX24 ${method}: ${data.error} — ${data.error_description || ''}`);
  }

  log(`[BX24] ✅ ${method} OK | result: ${JSON.stringify(data.result).slice(0, 300)}`);
  return data.result;
}

// ── BX24 user lookup ──────────────────────────────────────────────────────
async function getBx24UserId(email) {
  if (!email) return null;
  const key = email.toLowerCase();
  if (bx24UserIdCache[key]) {
    log(`[UserLookup] Cache hit: ${email} → ID ${bx24UserIdCache[key]}`);
    return bx24UserIdCache[key];
  }
  log(`[UserLookup] Looking up BX24 user by email: ${email}`);
  try {
    const result = await bx24Call('user.get', { filter: { EMAIL: email } });
    const user   = Array.isArray(result) ? result[0] : result;
    const id     = user && String(user.ID);
    if (id) {
      bx24UserIdCache[key] = id;
      log(`[UserLookup] ✅ ${email} → BX24 ID ${id}`);
    } else {
      log(`[UserLookup] ⚠️  No user found in BX24 for email: ${email}`);
    }
    return id || null;
  } catch (e) {
    log(`[UserLookup] ❌ Lookup failed for ${email}: ${e.message}`);
    return null;
  }
}

// ── Phone variants ────────────────────────────────────────────────────────
function phoneVariants(phoneNumber) {
  const raw    = (phoneNumber || '').trim();
  const digits = raw.replace(/\D/g, '');
  const withPlus  = digits ? `+${digits}` : '';
  const withPlus2 = raw.startsWith('+') ? raw : '';
  const local = digits.length > 10 ? digits.slice(digits.length - 10) :
                digits.length >= 7  ? digits : '';
  const with0 = local ? `0${local}` : '';
  const seen = new Set();
  const variants = [];
  for (const v of [raw, withPlus, withPlus2, digits, local, with0]) {
    if (v && v.length >= 7 && !seen.has(v)) { seen.add(v); variants.push(v); }
  }
  log(`[PhoneVariants] "${raw}" → [${variants.join(' | ')}]`);
  return variants;
}

// ── Find BX24 entity by phone ─────────────────────────────────────────────
async function findBx24EntityByPhone(phoneNumber) {
  if (!phoneNumber) { log('[EntitySearch] ⚠️  phoneNumber is empty — returning null'); return null; }
  const variants = phoneVariants(phoneNumber);
  log(`[EntitySearch] Searching for "${phoneNumber}" with ${variants.length} variants`);

  // 1) Try leads
  for (const num of variants) {
    try {
      const result = await bx24Call('crm.lead.list', { filter: { PHONE: num }, select: ['ID', 'TITLE', 'PHONE'] });
      const items  = Array.isArray(result) ? result : [];
      log(`[EntitySearch] crm.lead.list variant="${num}" → ${items.length} result(s)`);
      if (items.length > 0) {
        log(`[EntitySearch] ✅ Matched LEAD ID=${items[0].ID} for variant "${num}"`);
        return { entityType: 'LEAD', entityId: String(items[0].ID) };
      }
    } catch (e) { log(`[EntitySearch] crm.lead.list error for "${num}": ${e.message}`); }
  }

  // 2) Try contacts
  let contactId = null;
  for (const num of variants) {
    try {
      const result = await bx24Call('crm.contact.list', { filter: { PHONE: num }, select: ['ID', 'NAME', 'PHONE'] });
      const items  = Array.isArray(result) ? result : [];
      log(`[EntitySearch] crm.contact.list variant="${num}" → ${items.length} result(s)`);
      if (items.length > 0) {
        contactId = String(items[0].ID);
        log(`[EntitySearch] ✅ Matched CONTACT ID=${contactId} for variant "${num}"`);
        break;
      }
    } catch (e) { log(`[EntitySearch] crm.contact.list error for "${num}": ${e.message}`); }
  }

  // 3) Contact found — try to escalate to open deal
  if (contactId) {
    try {
      const deals    = await bx24Call('crm.deal.list', { filter: { CONTACT_ID: contactId, CLOSED: 'N' }, select: ['ID', 'TITLE'], order: { DATE_MODIFY: 'DESC' } });
      const dealList = Array.isArray(deals) ? deals : [];
      log(`[EntitySearch] crm.deal.list for CONTACT ${contactId} → ${dealList.length} open deal(s)`);
      if (dealList.length > 0) {
        log(`[EntitySearch] ✅ Escalating to DEAL ID=${dealList[0].ID}`);
        return { entityType: 'DEAL', entityId: String(dealList[0].ID) };
      }
    } catch (e) { log(`[EntitySearch] crm.deal.list error for CONTACT ${contactId}: ${e.message}`); }
    log(`[EntitySearch] ✅ Using CONTACT ID=${contactId} (no open deal)`);
    return { entityType: 'CONTACT', entityId: contactId };
  }

  // 4) Nothing found — auto-create lead?
  log(`[EntitySearch] ⚠️  No lead/contact/deal found for "${phoneNumber}" across all variants`);
  if (process.env.EXOTEL_AUTO_CREATE_LEAD === 'false') {
    log(`[EntitySearch] Auto-create disabled — returning null`);
    return null;
  }
  try {
    log(`[EntitySearch] Auto-creating LEAD for ${phoneNumber}...`);
    const newLead = await bx24Call('crm.lead.add', {
      fields: {
        TITLE:     `Exotel Call — ${phoneNumber}`,
        PHONE:     [{ VALUE: phoneNumber, VALUE_TYPE: 'WORK' }],
        STATUS_ID: 'NEW',
        SOURCE_ID: 'CALL'
      }
    });
    log(`[EntitySearch] ✅ Auto-created LEAD ID=${String(newLead)} for ${phoneNumber}`);
    return { entityType: 'LEAD', entityId: String(newLead) };
  } catch (e) {
    log(`[EntitySearch] ❌ Auto-create failed for ${phoneNumber}: ${e.message}`);
    return null;
  }
}

// ── Fetch Exotel calls for a specific number ──────────────────────────────
async function fetchExotelCallsForNumber(phoneNumber) {
  log(`[FetchCalls] Fetching all calls for number: ${phoneNumber}`);
  const calls = new Map();
  for (const field of ['From', 'To']) {
    try {
      const data = await exotelGet('/Calls.json', { [field]: phoneNumber, PageSize: 50 });
      const list = (data?.TwilioResponse?.Calls?.Call) || [];
      const arr  = Array.isArray(list) ? list : [list];
      arr.forEach(c => { if (c && c.Sid) calls.set(c.Sid, c); });
      log(`[FetchCalls] ${field}=${phoneNumber} → ${arr.length} call(s)`);
      arr.forEach(c => {
        if (c && c.Sid)
          log(`[FetchCalls]   SID=${c.Sid} Dir=${c.Direction} Status=${c.Status} Dur=${c.Duration}s | RecordingUrl=${c.RecordingUrl ? '✅' : '❌'} PreSigned=${c.PreSignedRecordingUrl ? '✅' : '❌'}`);
      });
    } catch (e) { log(`[FetchCalls] ❌ ${field}=${phoneNumber} fetch failed: ${e.message}`); }
  }
  log(`[FetchCalls] Total unique calls for ${phoneNumber}: ${calls.size}`);
  return Array.from(calls.values());
}

// ── Fetch recent calls by direction ──────────────────────────────────────
async function fetchRecentExotelCalls(direction, fromDate, toDate) {
  log(`[FetchCalls] Fetching recent calls | direction=${direction || 'all'} from=${fromDate || '-'} to=${toDate || '-'}`);
  try {
    const params = { PageSize: 200 };
    if (direction) params.Direction = direction;
    if (fromDate)  params.DateCreated = fromDate;
    if (toDate)    params.DateUpdated = toDate;
    const data = await exotelGet('/Calls.json', params);
    const list = (data?.TwilioResponse?.Calls?.Call) || [];
    const arr  = Array.isArray(list) ? list : [list];
    log(`[FetchCalls] direction=${direction || 'all'} → ${arr.length} call(s) total`);
    // Show recording presence for first 10
    arr.slice(0, 10).forEach(c => {
      if (c && c.Sid)
        log(`[FetchCalls]   SID=${c.Sid} Dir=${c.Direction} Status=${c.Status} Dur=${c.Duration}s | RecordingUrl=${c.RecordingUrl ? '✅' : '❌'} PreSigned=${c.PreSignedRecordingUrl ? '✅' : '❌'}`);
    });
    if (arr.length > 10) log(`[FetchCalls]   ... and ${arr.length - 10} more`);
    return arr;
  } catch (e) {
    log(`[FetchCalls] ❌ Fetch failed for direction=${direction || 'all'}: ${e.message}`);
    return [];
  }
}

// ── Fetch recording URL for a single call SID ─────────────────────────────
async function fetchRecordingUrl(callSid) {
  log(`[RecordingURL] Fetching for SID=${callSid} — trying v2 CCM API first (calls are placed via v2)`);

  // ── Try v2 first (ccm-api.exotel.com) ──
  try {
    const data = await exotelV2Get(`/calls/${callSid}`);
    // v2 response: { response: { data: { recordings: [{ url, duration, ... }] } } }
    const callData   = data?.response?.data || data?.data || {};
    const recordings = callData?.recordings;
    log(`[RecordingURL][v2] call_state=${callData.call_state} recordings=${JSON.stringify(recordings)?.slice(0,200)}`);

    if (Array.isArray(recordings) && recordings.length > 0) {
      const url = recordings[0].url || recordings[0].recording_url || recordings[0].Uri || null;
      if (url) {
        log(`[RecordingURL][v2] ✅ Found recording: ${url.slice(0, 120)}…`);
        return url;
      }
    }
    if (recordings === null || recordings === undefined) {
      log(`[RecordingURL][v2] recordings field is ${recordings} — not ready yet`);
    } else {
      log(`[RecordingURL][v2] recordings array empty — no recording for this call`);
    }
  } catch (e) {
    log(`[RecordingURL][v2] ⚠️  v2 fetch failed: ${e.message} — falling back to v1`);
  }

  // ── Fallback to v1 (TwilioResponse format) ──
  log(`[RecordingURL][v1] Trying v1 fallback for SID=${callSid}`);
  try {
    const data = await exotelGet(`/Calls/${callSid}.json`);
    const call = data?.TwilioResponse?.Call || data?.Call || {};
    log(`[RecordingURL][v1] Fields: [${Object.keys(call).join(', ')}]`);
    const preSignedUrl = call.PreSignedRecordingUrl || null;
    const recordingUrl = call.RecordingUrl          || null;
    log(`[RecordingURL][v1] PreSignedRecordingUrl=${preSignedUrl ? '✅' : '❌'} RecordingUrl=${recordingUrl ? '✅' : '❌'}`);
    const url = preSignedUrl || recordingUrl || null;
    if (url) log(`[RecordingURL][v1] ✅ Found via v1: ${url.slice(0, 100)}…`);
    else     log(`[RecordingURL] ⚠️  No recording URL on either v1 or v2 for SID=${callSid}`);
    return url;
  } catch (e) {
    if (e.message.includes('404')) log(`[RecordingURL] ⚠️  404 (v1) for SID=${callSid}`);
    else                           log(`[RecordingURL] ❌ v1 error for SID=${callSid}: ${e.message}`);
    return null;
  }
}
// ── Build recording link ──────────────────────────────────────────────────
function buildRecordingLink(callSid) {
  const link = `${RENDER_URL}/recording/${callSid}`;
  log(`[RecordingLink] Built permanent link: ${link}`);
  return link;
}

function getOwnerTypeId(entityType) {
  return { LEAD: 1, DEAL: 2, CONTACT: 3 }[entityType] || 3;
}

// ── Update existing BX24 telephony record ─────────────────────────────────
async function updateBx24CallRecord({
  bx24CallId, agentBx24Id, agentEmail, callSid,
  duration, direction, status,
  clientNum, fromNum, toNum,
  callDate, endDate
}) {
  const recordingLink = buildRecordingLink(callSid);
  log(`[UpdateBX24] ── updateBx24CallRecord START ──`);
  log(`[UpdateBX24] CALL_ID=${bx24CallId} | SID=${callSid} | direction=${direction}`);
  log(`[UpdateBX24] agent BX24 ID=${agentBx24Id || 'N/A'} | email=${agentEmail || 'N/A'}`);
  log(`[UpdateBX24] from=${fromNum} | to=${toNum} | clientNum=${clientNum} | duration=${duration}s`);
  log(`[UpdateBX24] recordingLink=${recordingLink}`);

  // Step 1: retrofit recording link onto the closed telephony entry
  log(`[UpdateBX24] Step 1: calling telephony.externalcall.finish with RECORD_URL...`);
  try {
    await bx24Call('telephony.externalcall.finish', {
      CALL_ID:     bx24CallId,
      USER_ID:     agentBx24Id || '1',
      DURATION:    duration || 0,
      STATUS_CODE: 200,
      RECORD_URL:  recordingLink
    });
    log(`[UpdateBX24] ✅ telephony.externalcall.finish with RECORD_URL succeeded`);
  } catch (e) {
    log(`[UpdateBX24] ⚠️  telephony.externalcall.finish failed: ${e.message} — continuing to activity card`);
  }

  // Step 2: create metadata activity card
  log(`[UpdateBX24] Step 2: creating metadata activity card for clientNum=${clientNum}...`);
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
    `Recording : <a href="${recordingLink}">▶ View Recording</a>`;

  const entity = await findBx24EntityByPhone(clientNum);
  if (!entity) {
    log(`[UpdateBX24] ❌ No BX24 entity for clientNum=${clientNum} — activity NOT posted`);
    return bx24CallId;
  }
  log(`[UpdateBX24] Entity resolved: ${entity.entityType} ID=${entity.entityId}`);

  try {
    const result = await bx24Call('crm.activity.add', { fields: {
      OWNER_TYPE_ID:    getOwnerTypeId(entity.entityType),
      OWNER_ID:         entity.entityId,
      TYPE_ID:          2,
      SUBJECT:          `📞 ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call — ${clientNum}`,
      DESCRIPTION:      desc,
      DESCRIPTION_TYPE: 3,
      DIRECTION:        direction === 'outbound' ? 2 : 1,
      DURATION:         duration || 0,
      START_TIME:       callDate,
      END_TIME:         endDate || callDate,
      COMPLETED:        'Y',
      RESPONSIBLE_ID:   agentBx24Id || '1',
      COMMUNICATIONS:   [{ VALUE: clientNum, TYPE: 'PHONE' }]
    }});
    log(`[UpdateBX24] ✅ crm.activity.add OK — activityId=${result} on ${entity.entityType}=${entity.entityId}`);
    return result;
  } catch (e) {
    log(`[UpdateBX24] ❌ crm.activity.add failed: ${e.message}`);
  }
  return bx24CallId;
}

// ── Create new BX24 call activity (historical / unregistered calls) ────────
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

  log(`[CreateActivity] ── createBx24CallActivity START ──`);
  log(`[CreateActivity] SID=${callSid} | direction=${direction} | clientNum=${clientNum}`);
  log(`[CreateActivity] from=${fromNum} | to=${toNum} | duration=${duration}s | status=${status}`);
  log(`[CreateActivity] callDate=${callDate} | endDate=${endDate}`);
  log(`[CreateActivity] recordingLink=${recordingLink}`);
  log(`[CreateActivity] agentBx24UserId passed in: ${agentBx24UserId || 'null — will try resolver'}`);

  const agentPhone = direction === 'outbound' ? (call.VirtualNumberUsed || fromNum) : (call.To || toNum);
  log(`[CreateActivity] agentPhone for resolver: ${agentPhone}`);
  const resolved   = agentBx24UserId ? { bx24UserId: agentBx24UserId, email: null } : await resolveAgent(agentPhone);
  const resolvedId = resolved.bx24UserId || null;
  const agentLabel = resolved.email || (resolvedId ? `User #${resolvedId}` : call.AgentEmail || 'Unassigned');
  log(`[CreateActivity] resolvedId=${resolvedId || 'null'} | agentLabel="${agentLabel}"`);

  const fmtDate = d => { try { return new Date(d).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:true}); } catch(_){ return d; } };
  const desc =
    `☎ ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call\n\n` +
    `Agent     : ${agentLabel}\n` +
    `From      : ${fromNum}\n` +
    `To        : ${toNum}\n` +
    `Customer  : ${clientNum}\n` +
    `Start     : ${fmtDate(callDate)}\n` +
    `End       : ${fmtDate(endDate)}\n` +
    `Duration  : ${mins}m ${secs}s\n` +
    `Status    : ${status}\n` +
    `Call SID  : ${callSid}\n\n` +
    `Recording : <a href="${recordingLink}">▶ View Recording</a>`;

  log(`[CreateActivity] Looking up BX24 entity for clientNum=${clientNum}...`);
  const entity = await findBx24EntityByPhone(clientNum);
  if (!entity) {
    log(`[CreateActivity] ❌ No BX24 entity for ${clientNum} (SID=${callSid}) — activity NOT posted`);
    return null;
  }
  log(`[CreateActivity] Entity resolved: ${entity.entityType} ID=${entity.entityId}`);

  const ownerTypeId   = getOwnerTypeId(entity.entityType);
  const responsibleId = resolvedId || '1';
  const bx24Direction = direction === 'outbound' ? 2 : 1;
  const subject       = `📞 ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call — ${clientNum}`;

  // Attempt TYPE_ID=2 (native phone call)
  log(`[CreateActivity] Attempting crm.activity.add with TYPE_ID=2...`);
  try {
    const result = await bx24Call('crm.activity.add', { fields: {
      OWNER_TYPE_ID:    ownerTypeId,
      OWNER_ID:         entity.entityId,
      TYPE_ID:          2,
      SUBJECT:          subject,
      DESCRIPTION:      desc,
      DESCRIPTION_TYPE: 3,
      DIRECTION:        bx24Direction,
      DURATION:         duration,
      START_TIME:       callDate,
      END_TIME:         endDate,
      COMPLETED:        'Y',
      RESPONSIBLE_ID:   responsibleId,
      COMMUNICATIONS:   [{ VALUE: clientNum, TYPE: 'PHONE' }]
    }});
    log(`[CreateActivity] ✅ TYPE_ID=2 succeeded — activityId=${result} on ${entity.entityType}=${entity.entityId}`);
    return result;
  } catch (e) {
    log(`[CreateActivity] ⚠️  TYPE_ID=2 rejected: ${e.message} — falling back to TYPE_ID=4`);
  }

  // Fallback TYPE_ID=4
  log(`[CreateActivity] Attempting crm.activity.add with TYPE_ID=4 (fallback)...`);
  try {
    const result = await bx24Call('crm.activity.add', { fields: {
      OWNER_TYPE_ID:    ownerTypeId,
      OWNER_ID:         entity.entityId,
      TYPE_ID:          4,
      SUBJECT:          subject,
      DESCRIPTION:      desc,
      DESCRIPTION_TYPE: 3,
      START_TIME:       callDate,
      END_TIME:         endDate,
      COMPLETED:        'Y',
      RESPONSIBLE_ID:   responsibleId
    }});
    log(`[CreateActivity] ✅ TYPE_ID=4 fallback succeeded — activityId=${result}`);
    return result;
  } catch (e) {
    log(`[CreateActivity] ❌ Both TYPE_ID=2 and TYPE_ID=4 failed for SID=${callSid}: ${e.message}`);
    return null;
  }
}

// ── syncRecordings ────────────────────────────────────────────────────────
async function syncRecordings({ phoneNumber, agentEmail, callSid: hintSid, bx24CallId, agentBx24Id, direction, fromDate, toDate } = {}) {
  log(`[Sync] ════════════════ syncRecordings START ════════════════`);
  log(`[Sync] phoneNumber=${phoneNumber || '(all)'} | agentEmail=${agentEmail || 'N/A'}`);
  log(`[Sync] hintSid=${hintSid || 'N/A'} | bx24CallId=${bx24CallId || 'N/A'} | agentBx24Id=${agentBx24Id || 'N/A'}`);
  log(`[Sync] direction=${direction || '(all)'} | fromDate=${fromDate || '-'} | toDate=${toDate || '-'}`);

  const results = { processed: 0, recorded: 0, posted: 0, skipped: 0, errors: [] };

  const resolvedAgentId = agentBx24Id || (agentEmail ? await getBx24UserId(agentEmail) : null);
  log(`[Sync] resolvedAgentId=${resolvedAgentId || 'null'}`);

  const calls = phoneNumber
    ? await fetchExotelCallsForNumber(phoneNumber)
    : await fetchRecentExotelCalls(direction, fromDate, toDate);

  results.processed = calls.length;
  log(`[Sync] Total calls to process: ${calls.length}`);

  for (const call of calls) {
    const callSid = call.Sid || '';
    if (!callSid) { log(`[Sync] ⚠️  Skipping call with no Sid`); continue; }

    if (syncedCallSids.has(callSid)) {
      log(`[Sync] ⏭️  SID=${callSid} already in dedup set — skipping`);
      results.skipped++;
      continue;
    }

    log(`[Sync] ── Checking SID=${callSid} (Dir=${call.Direction} Status=${call.Status} Dur=${call.Duration}s) ──`);

    // Check if recording exists — prefer fields already in the list response
    let recordingExists = !!(call.RecordingUrl || call.PreSignedRecordingUrl);
    if (recordingExists) {
      log(`[Sync] Recording URL already in list response for SID=${callSid} ✅ — skipping per-call fetch`);
    } else {
      log(`[Sync] No recording URL in list response for SID=${callSid} — calling per-call API...`);
      const fetched = await fetchRecordingUrl(callSid);
      recordingExists = !!fetched;
      log(`[Sync] Per-call fetch for SID=${callSid}: ${recordingExists ? '✅ recording exists' : '❌ no recording yet'}`);
    }

    if (!recordingExists) {
      // BUG FIX: Do NOT add to dedup when recording is absent.
      // Recording may not be ready yet — poller and scheduleSync retries
      // must be able to recheck this call on the next cycle.
      log(`[Sync] SID=${callSid} has no recording yet — skipping but NOT adding to dedup (will retry next cycle)`);
      results.skipped++;
      continue;
    }

    results.recorded++;
    log(`[Sync] ✅ Recording confirmed for SID=${callSid}`);

    const isRegisteredCall = bx24CallId && callSid === hintSid;
    log(`[Sync] Path: ${isRegisteredCall ? 'UPDATE (telephony already registered)' : 'CREATE (historical/unregistered)'}`);

    let activityId = null;

    if (isRegisteredCall) {
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
      activityId = await createBx24CallActivity(call, callSid, resolvedAgentId);
    }

    log(`[Sync] activityId returned for SID=${callSid}: ${activityId !== null && activityId !== undefined ? activityId : '❌ null/undefined — post FAILED'}`);

    if (activityId) {
      results.posted++;
      syncedCallSids.add(callSid);
      persistDedupSids();
      log(`[Sync] ✅ SID=${callSid} posted to BX24 and added to dedup`);
    } else {
      log(`[Sync] ❌ Failed to push SID=${callSid} to BX24`);
      results.errors.push({ callSid, reason: 'BX24 update/create returned null' });
    }
  }

  log(`[Sync] ════════ DONE: processed=${results.processed} recorded=${results.recorded} posted=${results.posted} skipped=${results.skipped} errors=${results.errors.length} ════════`);
  if (results.errors.length > 0) log(`[Sync] Errors: ${JSON.stringify(results.errors)}`);
  return results;
}

// ── scheduleSync ──────────────────────────────────────────────────────────
function scheduleSync({ clientNum, agentEmail, callSid, bx24CallId, agentBx24Id, onSuccess } = {}) {
  if (!clientNum) {
    log(`[ScheduleSync] ⚠️  clientNum missing — aborting`);
    return;
  }
  log(`[ScheduleSync] Scheduled for clientNum=${clientNum} | SID=${callSid || 'N/A'} | bx24CallId=${bx24CallId || 'N/A'}`);
  log(`[ScheduleSync] First attempt in ${RETRY_FIRST_DELAY_MS / 1000}s, max ${RETRY_MAX_ATTEMPTS} attempts`);

  function attempt(delayMs, attemptNum) {
    setTimeout(async () => {
      log(`[ScheduleSync] ── Attempt ${attemptNum}/${RETRY_MAX_ATTEMPTS} for ${clientNum} (waited ${delayMs / 1000}s) ──`);
      try {
        const result = await syncRecordings({ phoneNumber: clientNum, agentEmail, callSid, bx24CallId, agentBx24Id });
        log(`[ScheduleSync] Attempt ${attemptNum} → processed=${result.processed} posted=${result.posted} skipped=${result.skipped} errors=${result.errors.length}`);
        if (result && result.posted > 0) {
          log(`[ScheduleSync] ✅ Success on attempt ${attemptNum} for ${clientNum}`);
          if (onSuccess) onSuccess();
        } else if (attemptNum < RETRY_MAX_ATTEMPTS) {
          const nextDelay = delayMs * 2;
          log(`[ScheduleSync] ⏳ Not posted — scheduling attempt ${attemptNum + 1} in ${nextDelay / 1000}s`);
          attempt(nextDelay, attemptNum + 1);
        } else {
          log(`[ScheduleSync] ❌ Gave up after ${attemptNum} attempts for ${clientNum} — recording may not exist`);
          if (onSuccess) onSuccess();
        }
      } catch (e) {
        log(`[ScheduleSync] ❌ Attempt ${attemptNum} threw: ${e.message}`);
        if (attemptNum < RETRY_MAX_ATTEMPTS) {
          const nextDelay = delayMs * 2;
          log(`[ScheduleSync] Scheduling retry ${attemptNum + 1} in ${nextDelay / 1000}s`);
          attempt(nextDelay, attemptNum + 1);
        }
      }
    }, delayMs);
  }

  attempt(RETRY_FIRST_DELAY_MS, 1);
}

// ── GET /recording/:callSid ───────────────────────────────────────────────
function recordingRedirectRoute(app) {
  app.get('/recording/:callSid', async (req, res) => {
    const { callSid } = req.params;
    log(`[Redirect] ── /recording/${callSid} hit ──`);
    if (!callSid) return res.status(400).send('callSid required');

    try {
      log(`[Redirect] Fetching fresh recording URL from Exotel for SID=${callSid}...`);
      const audioUrl = await fetchRecordingUrl(callSid);
      if (!audioUrl) {
        log(`[Redirect] ❌ No recording URL for SID=${callSid} — returning 404`);
        return res.status(404).send('No recording available yet');
      }
      log(`[Redirect] ✅ 302 → ${audioUrl.slice(0, 100)}…`);
      res.redirect(302, audioUrl);
    } catch (e) {
      log(`[Redirect] ❌ Error for SID=${callSid}: ${e.message}`);
      if (!res.headersSent) res.status(500).send('Lookup error');
    }
  });
}

// ── Continuous recording poller ───────────────────────────────────────────
const POLL_INTERVAL_MS = Math.max(5, parseInt(process.env.EXOTEL_RECORDING_POLL_SEC || '10')) * 1000;
let   _pollActive = false;

async function pollOnce() {
  if (_pollActive) { log(`[Poll] Skipping — previous poll still in progress`); return; }
  _pollActive = true;
  log(`[Poll] ── Poll cycle START ──`);
  try {
    // Only look at calls from the last 24 hours to avoid burning quota on old calls
    const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since = sinceDate.toISOString().replace('T', ' ').slice(0, 19);
    log(`[Poll] Fetching calls since ${since}`);
    const [inbound, outbound] = await Promise.all([
      fetchRecentExotelCalls('inbound',      since, null).catch(e => { log(`[Poll] ❌ inbound fetch error: ${e.message}`); return []; }),
      fetchRecentExotelCalls('outbound-api', since, null).catch(e => { log(`[Poll] ❌ outbound fetch error: ${e.message}`); return []; })
    ]);
    log(`[Poll] Fetched: inbound=${inbound.length} outbound=${outbound.length}`);

    const seen = new Set();
    const calls = [];
    for (const c of [...inbound, ...outbound]) {
      if (c && c.Sid && !seen.has(c.Sid)) { seen.add(c.Sid); calls.push(c); }
    }
    log(`[Poll] Unique calls after merge+dedup: ${calls.length}`);

    let alreadySynced = 0, noRecording = 0, posted = 0, failed = 0;

    for (const call of calls) {
      const callSid = call.Sid;
      if (!callSid) continue;

      if (syncedCallSids.has(callSid)) { alreadySynced++; continue; }

      const callDuration = parseInt(call.Duration || '0');
      const callStatus   = (call.Status || '').toLowerCase();
      log(`[Poll] Checking SID=${callSid} (Dir=${call.Direction} Status=${call.Status} Dur=${callDuration}s)`);

      // Skip and dedup calls that are too short to have a recording (unanswered / <5s)
      if (callDuration < 5 && (callStatus === 'no-answer' || callStatus === 'busy' || callStatus === 'failed' || callStatus === 'canceled')) {
        log(`[Poll] SID=${callSid} unanswered (status=${callStatus} dur=${callDuration}s) — deduping so it's not checked again`);
        syncedCallSids.add(callSid);
        alreadySynced++;
        continue;
      }

      let recUrl = call.RecordingUrl || call.PreSignedRecordingUrl || null;
      if (recUrl) {
        log(`[Poll] Recording URL from list response: ✅ ${recUrl.slice(0, 80)}…`);
      } else {
        log(`[Poll] No URL in list response — fetching per-call detail for SID=${callSid}...`);
        recUrl = await fetchRecordingUrl(callSid);
        if (recUrl) log(`[Poll] Per-call fetch: ✅ ${recUrl.slice(0, 80)}…`);
        else        { log(`[Poll] Per-call fetch: ❌ no recording yet for SID=${callSid}`); noRecording++; continue; }
      }

      if (!call.RecordingUrl) call.RecordingUrl = recUrl;

      log(`[Poll] Pushing SID=${callSid} to BX24...`);

      // ── Use callRegistry if available (gives us bx24CallId directly) ──
      const regEntry = callRegistry.get(callSid);
      let activityId = null;

      if (regEntry && regEntry.bx24CallId) {
        log(`[Poll] Found registry entry for SID=${callSid} → using updateBx24CallRecord (bx24CallId=${regEntry.bx24CallId})`);
        const rawDir   = (call.Direction || '').toLowerCase();
        const dir      = rawDir.includes('outbound') ? 'outbound' : 'inbound';
        const fromNum  = call.From || '';
        const toNum    = call.To   || '';
        activityId = await updateBx24CallRecord({
          bx24CallId:  regEntry.bx24CallId,
          agentBx24Id: regEntry.agentBx24Id || null,
          agentEmail:  regEntry.agentEmail  || null,
          callSid,
          duration:   parseInt(call.Duration || '0'),
          direction:  dir,
          status:     call.Status || 'completed',
          clientNum:  regEntry.phone || (dir === 'outbound' ? toNum : fromNum),
          fromNum,
          toNum,
          callDate:  new Date(call.StartTime || call.DateCreated || Date.now()).toISOString(),
          endDate:   call.EndTime ? new Date(call.EndTime).toISOString() : undefined
        });
      } else {
        log(`[Poll] No registry entry for SID=${callSid} — using createBx24CallActivity (phone lookup)`);
        activityId = await createBx24CallActivity(call, callSid, null);
      }

      if (activityId) {
        posted++;
        syncedCallSids.add(callSid);
        if (regEntry) regEntry.recordingSynced = true;
        persistDedupSids();
        log(`[Poll] ✅ SID=${callSid} → BX24 activityId=${activityId}`);
      } else {
        failed++;
        log(`[Poll] ❌ Failed to push SID=${callSid} to BX24`);
      }
    }

    log(`[Poll] ── Cycle DONE: total=${calls.length} alreadySynced=${alreadySynced} noRecording=${noRecording} posted=${posted} failed=${failed} ──`);
  } catch (e) {
    log(`[Poll] ❌ Unexpected error: ${e.message}\n${e.stack}`);
  } finally {
    _pollActive = false;
  }
}

function startPolling() {
  if (process.env.EXOTEL_RECORDING_POLL_DISABLED === 'true') {
    log('Recording poller DISABLED (EXOTEL_RECORDING_POLL_DISABLED=true)');
    return;
  }
  log(`Recording poller started — interval ${POLL_INTERVAL_MS / 1000}s`);
  pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

// ── init ──────────────────────────────────────────────────────────────────
function init(app) {
  recordingRedirectRoute(app);

  app.post('/sync-recordings', async (req, res) => {
    const { phoneNumber, agentEmail, direction, fromDate, toDate } = req.body || {};
    log(`[Route] POST /sync-recordings | phoneNumber=${phoneNumber || '(all)'} direction=${direction || '(all)'} from=${fromDate || '-'} to=${toDate || '-'}`);
    try { res.json({ status: 'ok', ...await syncRecordings({ phoneNumber, agentEmail, direction, fromDate, toDate }) }); }
    catch (e) { log(`[Route] POST /sync-recordings threw: ${e.message}`); res.status(500).json({ status: 'error', message: e.message }); }
  });

  app.get('/sync-recordings', async (req, res) => {
    const { phoneNumber, agentEmail, direction, fromDate, toDate } = req.query;
    log(`[Route] GET /sync-recordings | phoneNumber=${phoneNumber || '(all)'} direction=${direction || '(all)'} from=${fromDate || '-'} to=${toDate || '-'}`);
    try { res.json({ status: 'ok', ...await syncRecordings({ phoneNumber, agentEmail, direction, fromDate, toDate }) }); }
    catch (e) { log(`[Route] GET /sync-recordings threw: ${e.message}`); res.status(500).json({ status: 'error', message: e.message }); }
  });

  log('Routes registered: GET /recording/:callSid | POST /sync-recordings | GET /sync-recordings');
  startPolling();
}

module.exports = { init, scheduleSync, syncRecordings, startPolling, pollOnce, setAgentResolver, registerCall };
