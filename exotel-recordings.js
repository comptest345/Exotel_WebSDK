// ═══════════════════════════════════════════════════════════════════════════
// exotel-recordings.js
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const fetch = require('node-fetch');

const ACCOUNT_SID  = process.env.EXOTEL_ACCOUNT_SID || '';
const API_KEY      = process.env.EXOTEL_API_KEY      || '';
const API_TOKEN    = process.env.EXOTEL_API_TOKEN    || '';
const BX24_WEBHOOK = process.env.BX24_WEBHOOK_URL    || '';
const DOMAIN       = process.env.EXOTEL_DOMAIN       || 'singapore';

const isIndia         = /mum|in1|india/i.test(DOMAIN);
const EXOTEL_API_HOST = process.env.EXOTEL_API_HOST || (isIndia ? 'api.in.exotel.com' : 'api.exotel.com');
const EXOTEL_V1_BASE  = `https://${EXOTEL_API_HOST}/v1/Accounts/${ACCOUNT_SID}`;

const syncedCallSids = new Set();
const bx24UserIdCache = {};

function log(msg) { console.log('[Recordings]', msg); }

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

// FIX 1: Country-agnostic phone variants — no hardcoded country logic
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

// FIX 3: Search Lead → Contact → Deal (inbound + outbound, all entity types)
async function findBx24EntityByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  const variants = phoneVariants(phoneNumber);

  // 1. Search Leads
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

  // 2. Search Contacts
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
    // 3. Check for open Deal linked to this Contact
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

function getOwnerTypeId(entityType) {
  return { LEAD: 1, DEAL: 2, CONTACT: 3 }[entityType] || 3;
}

// FIX 2: TYPE_ID=2 with fallback to TYPE_ID=4; handles inbound + outbound direction
async function postRecordingToBx24(call, recordingUrl, entity, agentBx24UserId) {
  const callSid    = call.Sid || '';
  const fromNum    = call.From || '';
  const toNum      = call.To   || '';
  const duration   = parseInt(call.Duration || '0');
  const startTime  = call.StartTime || call.DateCreated || new Date().toISOString();
  const rawDir     = (call.Direction || '').toLowerCase();
  const direction  = rawDir.includes('outbound') ? 'outbound' : 'inbound';
  const callDate   = new Date(startTime).toISOString();
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  const clientNum  = direction === 'outbound' ? toNum : fromNum;

  const description =
    `Exotel Call Recording\n` +
    `Direction : ${direction === 'outbound' ? 'Outbound ↑' : 'Inbound ↓'}\n` +
    `From      : ${fromNum}\n` +
    `To        : ${toNum}\n` +
    `Client    : ${clientNum}\n` +
    `Duration  : ${mins}m ${secs}s\n` +
    `Call SID  : ${callSid}\n\n` +
    `Recording link:\n${recordingUrl}`;

  const ownerTypeId   = getOwnerTypeId(entity.entityType);
  const responsibleId = agentBx24UserId || 1;
  const bx24Direction = direction === 'outbound' ? 2 : 1;
  const subject       = `Call recording — ${clientNum} (${direction})`;

  // Primary: TYPE_ID=2 (Phone call — shows as call entry with direction)
  try {
    const result = await bx24Call('crm.activity.add', { fields: {
      OWNER_TYPE_ID:    ownerTypeId,
      OWNER_ID:         entity.entityId,
      TYPE_ID:          2,
      SUBJECT:          subject,
      DESCRIPTION:      description,
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

  // Fallback: TYPE_ID=4 (custom activity — always accepted, no required sub-fields)
  try {
    const result = await bx24Call('crm.activity.add', { fields: {
      OWNER_TYPE_ID:    ownerTypeId,
      OWNER_ID:         entity.entityId,
      TYPE_ID:          4,
      SUBJECT:          subject,
      DESCRIPTION:      description,
      DESCRIPTION_TYPE: 1,
      START_TIME:       callDate,
      END_TIME:         callDate,
      COMPLETED:        'Y',
      RESPONSIBLE_ID:   responsibleId
    }});
    log(`BX24 activity (TYPE_ID=4 fallback, ${direction}) created: ID=${result} on ${entity.entityType}=${entity.entityId}`);
    return result;
  } catch (e) {
    log(`BX24 crm.activity.add failed entirely for ${callSid}: ${e.message}`);
    return null;
  }
}

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

    const rawDir    = (call.Direction || '').toLowerCase();
    const isOutbound = rawDir.includes('outbound');
    const fromNum   = call.From || '';
    const toNum     = call.To   || '';
    const clientNum = phoneNumber ? phoneNumber : (isOutbound ? toNum : fromNum);

    const recordingUrl = await fetchRecordingUrl(callSid);
    if (!recordingUrl) { syncedCallSids.add(callSid); results.skipped++; continue; }
    results.recorded++;

    const entity = await findBx24EntityByPhone(clientNum);
    if (!entity) {
      log(`No BX24 entity found for ${clientNum} (CallSid=${callSid}) — skipping`);
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
