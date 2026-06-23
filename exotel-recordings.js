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
const EXOTEL_V2_BASE  = process.env.EXOTEL_V2_HOST
  ? `https://${process.env.EXOTEL_V2_HOST}/v2/accounts/${ACCOUNT_SID}`
  : `https://ccm-api.exotel.com/v2/accounts/${ACCOUNT_SID}`;

const RETRY_FIRST_DELAY_MS = (parseInt(process.env.EXOTEL_RECORDING_DELAY_SEC || '30') * 1000);
const RETRY_MAX_ATTEMPTS   = 4;

// How many of the most-recent calls (across inbound + outbound combined,
// sorted by actual call time) the poller evaluates every cycle.
const POLL_FETCH_LIMIT = Math.max(1, parseInt(process.env.EXOTEL_RECORDING_POLL_LIMIT || '5'));

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
log(`  POLL interval      : ${Math.max(1, parseInt(process.env.EXOTEL_RECORDING_POLL_SEC || '1'))}s`);
log(`  POLL fetch limit   : last ${POLL_FETCH_LIMIT} call(s) per cycle`);
log(`  POLL disabled      : ${process.env.EXOTEL_RECORDING_POLL_DISABLED || 'false'}`);
log(`  AUTO_CREATE_LEAD   : ${process.env.EXOTEL_AUTO_CREATE_LEAD || 'true (default)'}`);
log('════════════════════════════════════════════════');

// ── Call registry ──────────────────────────────────────────────────────────
const callRegistry = new Map();

function registerCall(exotelSid, data) {
  if (!exotelSid) return;
  callRegistry.set(exotelSid, { ...data, ts: Date.now(), recordingSynced: false });
  log(`[Registry] Registered SID=${exotelSid} bx24CallId=${data.bx24CallId} phone=${data.phone} agent=${data.agentEmail}`);
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
// SIDs land here once they're "settled" — pushed to BX24, OR genuinely
// unmatched (no number / no BX24 entity). Settled SIDs are never re-checked.
// Only "no recording yet" stays un-dedup'd so it retries until the recording
// shows up.
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

// ── Parse Exotel call list response (handles all known shapes) ────────────
function parseCallList(data, label) {
  // Shape 1: { TwilioResponse: { Calls: { Call: [...] } } }
  const s1 = data?.TwilioResponse?.Calls?.Call;
  if (s1) {
    const arr = Array.isArray(s1) ? s1 : [s1];
    log(`[ParseCalls][${label}] Shape=TwilioResponse.Calls.Call → ${arr.length} call(s)`);
    return arr;
  }
  // Shape 2: { Calls: { Call: [...] } }
  const s2 = data?.Calls?.Call;
  if (s2) {
    const arr = Array.isArray(s2) ? s2 : [s2];
    log(`[ParseCalls][${label}] Shape=Calls.Call → ${arr.length} call(s)`);
    return arr;
  }
  // Shape 3: { Calls: [...] }
  const s3 = data?.Calls;
  if (Array.isArray(s3)) {
    log(`[ParseCalls][${label}] Shape=Calls[] → ${s3.length} call(s)`);
    return s3;
  }
  // Shape 4: top-level array
  if (Array.isArray(data)) {
    log(`[ParseCalls][${label}] Shape=root[] → ${data.length} call(s)`);
    return data;
  }
  // Unknown — log the top-level keys so we can fix it next time
  log(`[ParseCalls][${label}] ⚠️  Unknown response shape. Top-level keys: [${Object.keys(data || {}).join(', ')}] | sample: ${JSON.stringify(data).slice(0, 300)}`);
  return [];
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
// (single definition — original file had this defined twice)
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
// Tries phone variants (with/without country code, +, 0, local).
// If not found in CRM → returns null. Never auto-creates leads.
async function findBx24EntityByPhone(phoneNumber) {
  if (!phoneNumber) { log('[EntitySearch] phoneNumber empty — skip'); return null; }
  const variants = phoneVariants(phoneNumber);
  if (variants.length === 0) { log(`[EntitySearch] No usable variants for "${phoneNumber}" — skip`); return null; }
  log(`[EntitySearch] Searching CRM for ${phoneNumber} with ${variants.length} variants`);

  // 1) Try leads across all variants
  for (const num of variants) {
    try {
      const result = await bx24Call('crm.lead.list', { filter: { PHONE: num }, select: ['ID'] });
      const items  = Array.isArray(result) ? result : [];
      if (items.length > 0) {
        log(`[EntitySearch] ✅ LEAD ID=${items[0].ID} (variant ${num})`);
        return { entityType: 'LEAD', entityId: String(items[0].ID) };
      }
    } catch (e) { log(`[EntitySearch] lead search error for ${num}: ${e.message}`); }
  }

  // 2) Try contacts across all variants
  let contactId = null;
  for (const num of variants) {
    try {
      const result = await bx24Call('crm.contact.list', { filter: { PHONE: num }, select: ['ID'] });
      const items  = Array.isArray(result) ? result : [];
      if (items.length > 0) {
        contactId = String(items[0].ID);
        log(`[EntitySearch] ✅ CONTACT ID=${contactId} (variant ${num})`);
        break;
      }
    } catch (e) { log(`[EntitySearch] contact search error for ${num}: ${e.message}`); }
  }

  if (contactId) {
    try {
      const deals = await bx24Call('crm.deal.list', { filter: { CONTACT_ID: contactId, CLOSED: 'N' }, select: ['ID'], order: { DATE_MODIFY: 'DESC' } });
      const dl = Array.isArray(deals) ? deals : [];
      if (dl.length > 0) {
        log(`[EntitySearch] ✅ DEAL ID=${dl[0].ID} (via CONTACT ${contactId})`);
        return { entityType: 'DEAL', entityId: String(dl[0].ID) };
      }
    } catch (_) {}
    log(`[EntitySearch] ✅ Using CONTACT ID=${contactId}`);
    return { entityType: 'CONTACT', entityId: contactId };
  }

  // Not found — skip, never create
  log(`[EntitySearch] ⚠️  ${phoneNumber} not found in CRM across all variants — skipping`);
  return null;
}

// ── Fetch Exotel calls for a specific number ──────────────────────────────
async function fetchExotelCallsForNumber(phoneNumber, pageSize) {
  log(`[FetchCalls] Fetching all calls for number: ${phoneNumber}`);
  const calls = new Map();
  for (const field of ['From', 'To']) {
    try {
      const data = await exotelGet('/Calls.json', { [field]: phoneNumber, PageSize: pageSize || 100 });
      const arr  = parseCallList(data, `${field}=${phoneNumber}`).filter(c => c && c.Sid);
      arr.forEach(c => calls.set(c.Sid, c));
      arr.forEach(c => log(`[FetchCalls]   SID=${c.Sid} Dir=${c.Direction} Status=${c.Status} Dur=${c.Duration}s | RecordingUrl=${c.RecordingUrl ? '✅' : '❌'} PreSigned=${c.PreSignedRecordingUrl ? '✅' : '❌'}`));
    } catch (e) { log(`[FetchCalls] ❌ ${field}=${phoneNumber} fetch failed: ${e.message}`); }
  }
  log(`[FetchCalls] Total unique calls for ${phoneNumber}: ${calls.size}`);
  return Array.from(calls.values());
}

// ── Fetch recent calls by direction ──────────────────────────────────────
// pageSize controls how many calls Exotel returns for this direction
// (defaults to 100 for the historical sync/backfill routes; the poller
// passes a small number since it only cares about the latest few calls).
async function fetchRecentExotelCalls(direction, pageSize) {
  const size = pageSize || 100;
  log(`[FetchCalls] Fetching recent calls | direction=${direction || 'all'} | PageSize=${size}`);
  try {
    const params = { PageSize: size };
    if (direction) params.Direction = direction;
    const data = await exotelGet('/Calls.json', params);
    const arr  = parseCallList(data, direction || 'all').filter(c => c && c.Sid);
    log(`[FetchCalls] direction=${direction || 'all'} → ${arr.length} call(s) total`);
    arr.slice(0, 10).forEach(c =>
      log(`[FetchCalls]   SID=${c.Sid} Dir=${c.Direction} Status=${c.Status} Dur=${c.Duration}s RecordingUrl=${c.RecordingUrl ? '✅' : '❌'} PreSigned=${c.PreSignedRecordingUrl ? '✅' : '❌'}`)
    );
    if (arr.length > 10) log(`[FetchCalls]   ... and ${arr.length - 10} more`);
    return arr;
  } catch (e) {
    log(`[FetchCalls] ❌ Fetch failed for direction=${direction || 'all'}: ${e.message}`);
    return [];
  }
}

// ── Fetch recording URL for a single call SID ─────────────────────────────
async function fetchRecordingUrl(callSid, direction) {
  // v2 CCM API only supports outbound calls — inbound returns 404 "Unsupported call direction"
  const isOutbound = direction ? direction.toLowerCase().includes('outbound') : true; // default try v2
  if (!isOutbound) {
    log(`[RecordingURL] SID=${callSid} is inbound — skipping v2, going straight to v1`);
  } else {
    log(`[RecordingURL] Fetching for SID=${callSid} — trying v2 CCM API first`);
  }

  if (isOutbound) try {
    const data = await exotelV2Get(`/calls/${callSid}`);
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

  log(`[RecordingURL][v1] Trying v1 fallback for SID=${callSid}`);
  try {
    const data = await exotelGet(`/Calls/${callSid}.json`);
    const call = data?.TwilioResponse?.Call || data?.Call || {};
    log(`[RecordingURL][v1] Fields: [${Object.keys(call).join(', ')}]`);
    const preSignedUrl = call.PreSignedRecordingUrl || null;
    const recordingUrl = call.RecordingUrl          || null;
    log(`[RecordingURL][v1] raw RecordingUrl=${call.RecordingUrl} | raw PreSigned=${call.PreSignedRecordingUrl}`);
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
  log(`[BX24Push] ══════════════ updateBx24CallRecord START ══════════════`);
  log(`[BX24Push] CALL_ID=${bx24CallId} | SID=${callSid} | direction=${direction}`);
  log(`[BX24Push] agent BX24 ID=${agentBx24Id || 'N/A'} | email=${agentEmail || 'N/A'}`);
  log(`[BX24Push] from=${fromNum} | to=${toNum} | clientNum=${clientNum} | duration=${duration}s`);
  log(`[BX24Push] recordingLink=${recordingLink}`);

  log(`[BX24Push] Step 1 — telephony.externalcall.finish with RECORD_URL...`);
  try {
    await bx24Call('telephony.externalcall.finish', {
      CALL_ID:     bx24CallId,
      USER_ID:     agentBx24Id || '1',
      DURATION:    duration || 0,
      STATUS_CODE: 200,
      RECORD_URL:  recordingLink
    });
    log(`[BX24Push] ✅ Step 1 OK — recording URL attached to telephony entry`);
  } catch (e) {
    log(`[BX24Push] ⚠️  Step 1 FAILED: ${e.message} — continuing to activity card`);
  }

  log(`[BX24Push] Step 2 — crm.activity.add for clientNum=${clientNum}...`);
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
    `🔗 Recording: ${recordingLink}`;

  // No number at all on the call — nothing to search BX24 for.
  if (!clientNum) {
    log(`[BX24Push] ⚠️  Step 2 SKIPPED — no clientNum on call (SID=${callSid})`);
    return 'NO_NUMBER';
  }

  const entity = await findBx24EntityByPhone(clientNum);
  if (!entity) {
    log(`[BX24Push] ❌ Step 2 SKIPPED — no BX24 entity for clientNum=${clientNum}`);
    return 'NOT_FOUND';
  }
  log(`[BX24Push] Step 2 entity resolved: ${entity.entityType} ID=${entity.entityId}`);

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
      COMMUNICATIONS:   [{ VALUE: clientNum, TYPE: 'PHONE' }],
      WEBDAV_INFOS:     [{ NAME: '▶ Call Recording', LINK: recordingLink, ICON: 'audio' }]
    }});
    log(`[BX24Push] ✅ Step 2 OK — activityId=${result} on ${entity.entityType} ID=${entity.entityId}`);
    log(`[BX24Push] ══════════════ updateBx24CallRecord DONE ✅ ══════════════`);
    return result;
  } catch (e) {
    log(`[BX24Push] ❌ Step 2 crm.activity.add FAILED: ${e.message}`);
  }
  return null;
}

// ── Create new BX24 call activity (historical / unregistered calls) ────────
// Returns:
//   activityId (truthy)  → pushed successfully
//   'NOT_FOUND'           → number present, but no matching BX24 entity — permanent, dedupe it
//   'NO_NUMBER'           → call has no usable phone number — permanent, dedupe it
//   null                  → a real BX24 API failure — transient, caller should retry
async function createBx24CallActivity(call, callSid, agentBx24UserId) {
  const fromNum   = call.From || '';
  const rawToNum  = call.To   || '';
  // Strip SIP URI — Exotel puts sip:username in To for inbound calls routed to agents
  const toNum     = rawToNum.startsWith('sip:') ? (rawToNum.split('@')[0].replace(/^sip:/i,'')) : rawToNum;
  const duration  = parseInt(call.Duration || '0');
  const startTime = call.StartTime || call.DateCreated || new Date().toISOString();
  const endTime   = call.EndTime   || null;
  const status    = call.Status    || 'completed';
  const rawDir    = (call.Direction || '').toLowerCase();
  const direction = rawDir.includes('outbound') ? 'outbound' : 'inbound';
  const callDate  = new Date(startTime).toISOString();
  const endDate   = endTime ? new Date(endTime).toISOString() : callDate;
  // For inbound: customer = caller (From). For outbound: customer = called party (raw To number).
  const clientNum = direction === 'outbound' ? rawToNum : fromNum;

  log(`[BX24Push] ══════════════ createBx24CallActivity START ══════════════`);
  log(`[BX24Push] SID=${callSid} | direction=${direction} | clientNum=${clientNum || '(none)'}`);
  log(`[BX24Push] from=${fromNum} | to=${toNum} | duration=${duration}s | status=${status}`);
  log(`[BX24Push] callDate=${callDate} | endDate=${endDate}`);

  // No number on the call at all — ignore it, nothing to look up.
  if (!clientNum) {
    log(`[BX24Push] ⚠️  No phone number on call (SID=${callSid}) — IGNORING`);
    return 'NO_NUMBER';
  }

  const recordingLink = buildRecordingLink(callSid);
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;

  const agentPhone = direction === 'outbound' ? (call.VirtualNumberUsed || fromNum) : (call.To || toNum);
  const resolved   = agentBx24UserId ? { bx24UserId: agentBx24UserId, email: null } : await resolveAgent(agentPhone);
  const resolvedId = resolved.bx24UserId || null;
  const agentLabel = resolved.email || (resolvedId ? `User #${resolvedId}` : call.AgentEmail || 'Unassigned');
  log(`[BX24Push] resolvedId=${resolvedId || 'null'} | agentLabel="${agentLabel}"`);

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
    `🔗 Recording: ${recordingLink}`;

  log(`[BX24Push] Looking up BX24 entity for clientNum=${clientNum}...`);
  const entity = await findBx24EntityByPhone(clientNum);
  if (!entity) {
    log(`[BX24Push] ❌ No BX24 entity for ${clientNum} (SID=${callSid}) — SKIPPING (will not retry)`);
    return 'NOT_FOUND';
  }
  log(`[BX24Push] Entity resolved: ${entity.entityType} ID=${entity.entityId}`);

  const ownerTypeId   = getOwnerTypeId(entity.entityType);
  const responsibleId = resolvedId || '1';
  const bx24Direction = direction === 'outbound' ? 2 : 1;
  const subject       = `📞 ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call — ${clientNum}`;

  log(`[BX24Push] Calling crm.activity.add (TYPE_ID=2)...`);
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
      COMMUNICATIONS:   [{ VALUE: clientNum, TYPE: 'PHONE' }],
      WEBDAV_INFOS:     [{ NAME: '▶ Call Recording', LINK: recordingLink, ICON: 'audio' }]
    }});
    log(`[BX24Push] ✅ TYPE_ID=2 OK — activityId=${result} on ${entity.entityType} ID=${entity.entityId}`);
    log(`[BX24Push] ══════════════ createBx24CallActivity DONE ✅ ══════════════`);
    return result;
  } catch (e) {
    log(`[BX24Push] ⚠️  TYPE_ID=2 rejected: ${e.message} — trying TYPE_ID=4`);
  }

  log(`[BX24Push] Calling crm.activity.add (TYPE_ID=4 fallback)...`);
  try {
    const result = await bx24Call('crm.activity.add', { fields: {
      OWNER_TYPE_ID:    ownerTypeId,
      OWNER_ID:         entity.entityId,
      TYPE_ID:          4,
      SUBJECT:          subject,
      DESCRIPTION:      desc,
      START_TIME:       callDate,
      END_TIME:         endDate,
      COMPLETED:        'Y',
      RESPONSIBLE_ID:   responsibleId
    }});
    log(`[BX24Push] ✅ TYPE_ID=4 fallback OK — activityId=${result}`);
    log(`[BX24Push] ══════════════ createBx24CallActivity DONE ✅ ══════════════`);
    return result;
  } catch (e) {
    log(`[BX24Push] ❌ Both TYPE_ID=2 and TYPE_ID=4 FAILED for SID=${callSid}: ${e.message} — will retry next cycle`);
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
    : await fetchRecentExotelCalls(direction);

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

    let recordingExists = !!(call.RecordingUrl || call.PreSignedRecordingUrl);
    if (recordingExists) {
      log(`[Sync] Recording URL already in list response ✅`);
    } else {
      const fetched = await fetchRecordingUrl(callSid, call.Direction);
      recordingExists = !!fetched;
      log(`[Sync] Per-call fetch for SID=${callSid}: ${recordingExists ? '✅' : '❌ no recording yet'}`);
    }

    if (!recordingExists) {
      log(`[Sync] SID=${callSid} no recording yet — IGNORING (will retry next cycle, not an error)`);
      results.skipped++;
      continue;
    }

    results.recorded++;
    const isRegisteredCall = bx24CallId && callSid === hintSid;
    log(`[Sync] Path: ${isRegisteredCall ? 'UPDATE (telephony registered)' : 'CREATE (historical)'}`);

    let activityResult = null;

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

      activityResult = await updateBx24CallRecord({
        bx24CallId, agentBx24Id: resolvedAgentId, agentEmail, callSid,
        duration, direction: dir, status, clientNum, fromNum, toNum,
        callDate: new Date(startTime).toISOString(),
        endDate:  endTime ? new Date(endTime).toISOString() : undefined
      });
    } else {
      activityResult = await createBx24CallActivity(call, callSid, resolvedAgentId);
    }

    if (activityResult === 'NOT_FOUND' || activityResult === 'NO_NUMBER') {
      // Permanent, non-retryable outcome — dedupe so we never re-check this SID again.
      log(`[Sync] ⏭️  SID=${callSid} permanently skipped (${activityResult}) — deduping`);
      results.skipped++;
      syncedCallSids.add(callSid);
      persistDedupSids();
    } else if (activityResult) {
      results.posted++;
      syncedCallSids.add(callSid);
      persistDedupSids();
      log(`[Sync] ✅ SID=${callSid} pushed to BX24 — activityId=${activityResult}`);
    } else {
      log(`[Sync] ❌ SID=${callSid} FAILED to push to BX24 — will retry next cycle`);
      results.errors.push({ callSid, reason: 'BX24 returned null' });
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
          log(`[ScheduleSync] ❌ Gave up after ${attemptNum} attempts for ${clientNum}`);
          if (onSuccess) onSuccess();
        }
      } catch (e) {
        log(`[ScheduleSync] ❌ Attempt ${attemptNum} threw: ${e.message}`);
        if (attemptNum < RETRY_MAX_ATTEMPTS) {
          attempt(delayMs * 2, attemptNum + 1);
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
      const audioUrl = await fetchRecordingUrl(callSid, null); // direction unknown at redirect time
      if (!audioUrl) {
        log(`[Redirect] ❌ No recording URL for SID=${callSid}`);
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
// Polls every second and only ever evaluates the most recent POLL_FETCH_LIMIT
// calls (across inbound + outbound combined, sorted by actual call time).
const POLL_INTERVAL_MS = Math.max(1, parseInt(process.env.EXOTEL_RECORDING_POLL_SEC || '1')) * 1000;
let   _pollActive = false;

function callTimeMs(c) {
  const t = c.StartTime || c.DateCreated;
  const ms = t ? new Date(t).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

async function pollOnce() {
  if (_pollActive) { log(`[Poll] Skipping — previous poll still in progress`); return; }
  _pollActive = true;
  log(`[Poll] ── Poll cycle START ──`);
  try {
    // Fetch a small buffer per direction (more than POLL_FETCH_LIMIT) so that
    // after merging inbound+outbound and sorting by real call time, we can
    // reliably pick the true latest POLL_FETCH_LIMIT calls overall.
    const fetchSize = Math.max(POLL_FETCH_LIMIT * 2, 10);
    const [inbound, outbound] = await Promise.all([
      fetchRecentExotelCalls('inbound', fetchSize).catch(e => { log(`[Poll] ❌ inbound fetch error: ${e.message}`); return []; }),
      fetchRecentExotelCalls('outbound-api', fetchSize).catch(e => { log(`[Poll] ❌ outbound fetch error: ${e.message}`); return []; })
    ]);

    const seen = new Set();
    const merged = [];
    for (const c of [...inbound, ...outbound]) {
      if (c && c.Sid && !seen.has(c.Sid)) { seen.add(c.Sid); merged.push(c); }
    }
    merged.sort((a, b) => callTimeMs(b) - callTimeMs(a));
    const calls = merged.slice(0, POLL_FETCH_LIMIT);
    log(`[Poll] Merged ${merged.length} unique call(s) → evaluating last ${calls.length} (limit=${POLL_FETCH_LIMIT})`);

    let alreadySynced = 0, noRecording = 0, posted = 0, failed = 0, noNumber = 0, notInCrm = 0;

    for (const call of calls) {
      const callSid = call.Sid;
      if (!callSid) continue;

      if (syncedCallSids.has(callSid)) { alreadySynced++; continue; }

      const callDuration = parseInt(call.Duration || '0');
      const callStatus   = (call.Status || '').toLowerCase();
      log(`[Poll] Evaluating SID=${callSid} Dir=${call.Direction} Status=${call.Status} Dur=${callDuration}s`);

      if (callDuration < 5 && ['no-answer','busy','failed','canceled'].includes(callStatus)) {
        log(`[Poll] SID=${callSid} unanswered — deduping`);
        syncedCallSids.add(callSid);
        alreadySynced++;
        continue;
      }

      // No number on the call at all — nothing to look up, ignore permanently.
      if (!call.From && !call.To) {
        log(`[Poll] SID=${callSid} has no From/To number — IGNORING`);
        syncedCallSids.add(callSid);
        persistDedupSids();
        noNumber++;
        continue;
      }

      let recUrl = call.RecordingUrl || call.PreSignedRecordingUrl || null;
      if (recUrl) {
        log(`[Poll] SID=${callSid} recording in list ✅`);
      } else {
        log(`[Poll] SID=${callSid} no URL in list — fetching per-call...`);
        recUrl = await fetchRecordingUrl(callSid, call.Direction);
        if (recUrl) log(`[Poll] SID=${callSid} per-call fetch ✅`);
        else { log(`[Poll] SID=${callSid} ❌ no recording yet — IGNORING this cycle (will retry)`); noRecording++; continue; }
      }
      if (!call.RecordingUrl) call.RecordingUrl = recUrl;

      log(`[Poll] ── Pushing SID=${callSid} to BX24 ──`);
      const regEntry = callRegistry.get(callSid);
      let activityResult = null;

      if (regEntry && regEntry.bx24CallId) {
        log(`[Poll] Registry entry found → updateBx24CallRecord (bx24CallId=${regEntry.bx24CallId})`);
        const rawDir  = (call.Direction || '').toLowerCase();
        const dir     = rawDir.includes('outbound') ? 'outbound' : 'inbound';
        const fromNum = call.From || '';
        const toNum   = call.To   || '';
        activityResult = await updateBx24CallRecord({
          bx24CallId:  regEntry.bx24CallId,
          agentBx24Id: regEntry.agentBx24Id || null,
          agentEmail:  regEntry.agentEmail  || null,
          callSid,
          duration:   parseInt(call.Duration || '0'),
          direction:  dir,
          status:     call.Status || 'completed',
          clientNum:  regEntry.phone || (dir === 'outbound' ? toNum : fromNum),
          fromNum, toNum,
          callDate: new Date(call.StartTime || call.DateCreated || Date.now()).toISOString(),
          endDate:  call.EndTime ? new Date(call.EndTime).toISOString() : undefined
        });
      } else {
        log(`[Poll] No registry entry → createBx24CallActivity`);
        activityResult = await createBx24CallActivity(call, callSid, null);
      }

      if (activityResult === 'NOT_FOUND' || activityResult === 'NO_NUMBER') {
        // Permanent, non-retryable outcome: number not in BX24 (or no number at all).
        // Dedupe immediately so we stop re-checking this SID every poll cycle.
        if (activityResult === 'NOT_FOUND') notInCrm++; else noNumber++;
        syncedCallSids.add(callSid);
        persistDedupSids();
        const dir2     = (call.Direction || '').toLowerCase().includes('outbound') ? 'outbound' : 'inbound';
        const clientN2 = regEntry?.phone || (dir2 === 'outbound' ? call.To : call.From) || '(unknown)';
        log(`[Poll] ⏭️  SID=${callSid} permanently skipped (${activityResult}) | clientNum="${clientN2}" — deduped, will not retry`);
      } else if (activityResult) {
        posted++;
        syncedCallSids.add(callSid);
        if (regEntry) regEntry.recordingSynced = true;
        persistDedupSids();
        log(`[Poll] ✅ SID=${callSid} → BX24 activityId=${activityResult}`);
      } else {
        failed++;
        const dir2     = (call.Direction || '').toLowerCase().includes('outbound') ? 'outbound' : 'inbound';
        const clientN2 = regEntry?.phone || (dir2 === 'outbound' ? call.To : call.From) || '(unknown)';
        log(`[Poll] ❌ SID=${callSid} push to BX24 FAILED (transient) | clientNum="${clientN2}" from="${call.From}" to="${call.To}" dir="${call.Direction}" — will retry next cycle`);
      }
    }

    log(`[Poll] ── Cycle DONE: total=${calls.length} alreadySynced=${alreadySynced} noRecording=${noRecording} noNumber=${noNumber} notInCrm=${notInCrm} posted=${posted} failed=${failed} ──`);
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
  log(`Recording poller started — interval ${POLL_INTERVAL_MS / 1000}s, evaluating last ${POLL_FETCH_LIMIT} call(s) per cycle`);
  pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

// ── Backfill old recordings (POST /backfill-recordings) ──────────────────
// Clears dedup and re-pushes ALL calls fetched from Exotel (up to PageSize=100 per direction).
// Use once to push historical calls that were missed before the poller was working.
async function backfillOldRecordings() {
  log(`[Backfill] ════════════════ BACKFILL START ════════════════`);
  log(`[Backfill] Clearing dedup set (${syncedCallSids.size} entries) so all calls are re-evaluated`);
  syncedCallSids.clear();
  persistDedupSids();

  const [inbound, outbound] = await Promise.all([
    fetchRecentExotelCalls('inbound', 100).catch(e => { log(`[Backfill] ❌ inbound: ${e.message}`); return []; }),
    fetchRecentExotelCalls('outbound-api', 100).catch(e => { log(`[Backfill] ❌ outbound: ${e.message}`); return []; })
  ]);

  const seen  = new Set();
  const calls = [];
  for (const c of [...inbound, ...outbound]) {
    if (c && c.Sid && !seen.has(c.Sid)) { seen.add(c.Sid); calls.push(c); }
  }
  log(`[Backfill] Total unique calls to process: ${calls.length}`);

  let posted = 0, skipped = 0, failed = 0;

  for (const call of calls) {
    const callSid      = call.Sid;
    const callDuration = parseInt(call.Duration || '0');
    const callStatus   = (call.Status || '').toLowerCase();

    if (callDuration < 5 && ['no-answer','busy','failed','canceled'].includes(callStatus)) {
      log(`[Backfill] SID=${callSid} unanswered — skipping`);
      skipped++;
      continue;
    }

    let recUrl = call.RecordingUrl || call.PreSignedRecordingUrl || null;
    if (!recUrl) {
      recUrl = await fetchRecordingUrl(callSid, call.Direction);
    }
    if (!recUrl) {
      log(`[Backfill] SID=${callSid} no recording — skipping`);
      skipped++;
      continue;
    }
    if (!call.RecordingUrl) call.RecordingUrl = recUrl;

    log(`[Backfill] Pushing SID=${callSid} to BX24...`);
    const activityResult = await createBx24CallActivity(call, callSid, null);
    if (activityResult === 'NOT_FOUND' || activityResult === 'NO_NUMBER') {
      log(`[Backfill] ⏭️  SID=${callSid} permanently skipped (${activityResult})`);
      syncedCallSids.add(callSid);
      skipped++;
    } else if (activityResult) {
      posted++;
      syncedCallSids.add(callSid);
      log(`[Backfill] ✅ SID=${callSid} → activityId=${activityResult}`);
    } else {
      failed++;
      log(`[Backfill] ❌ SID=${callSid} push FAILED`);
    }
  }

  persistDedupSids();
  log(`[Backfill] ════════ DONE: total=${calls.length} posted=${posted} skipped=${skipped} failed=${failed} ════════`);
  return { total: calls.length, posted, skipped, failed };
}

// ── init ──────────────────────────────────────────────────────────────────
function init(app) {
  recordingRedirectRoute(app);

  app.post('/sync-recordings', async (req, res) => {
    const { phoneNumber, agentEmail, direction, fromDate, toDate } = req.body || {};
    log(`[Route] POST /sync-recordings | phoneNumber=${phoneNumber || '(all)'} direction=${direction || '(all)'}`);
    try { res.json({ status: 'ok', ...await syncRecordings({ phoneNumber, agentEmail, direction, fromDate, toDate }) }); }
    catch (e) { log(`[Route] POST /sync-recordings threw: ${e.message}`); res.status(500).json({ status: 'error', message: e.message }); }
  });

  app.get('/sync-recordings', async (req, res) => {
    const { phoneNumber, agentEmail, direction, fromDate, toDate } = req.query;
    log(`[Route] GET /sync-recordings | phoneNumber=${phoneNumber || '(all)'} direction=${direction || '(all)'}`);
    try { res.json({ status: 'ok', ...await syncRecordings({ phoneNumber, agentEmail, direction, fromDate, toDate }) }); }
    catch (e) { log(`[Route] GET /sync-recordings threw: ${e.message}`); res.status(500).json({ status: 'error', message: e.message }); }
  });

  // POST /backfill-recordings — push ALL historical calls from Exotel into BX24
  app.post('/backfill-recordings', async (req, res) => {
    log(`[Route] POST /backfill-recordings`);
    try { res.json({ status: 'ok', ...await backfillOldRecordings() }); }
    catch (e) { log(`[Route] /backfill-recordings threw: ${e.message}`); res.status(500).json({ status: 'error', message: e.message }); }
  });

  log('Routes registered: GET /recording/:callSid | POST /sync-recordings | GET /sync-recordings | POST /backfill-recordings');
  startPolling();
}

module.exports = { init, scheduleSync, syncRecordings, startPolling, pollOnce, setAgentResolver, registerCall, backfillOldRecordings };
