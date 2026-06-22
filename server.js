const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const recordings = require('./exotel-recordings');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Env vars ──────────────────────────────────────────────────────
// NOTE: mum1 base URL works for ALL accounts (India + Singapore).
// Do NOT change this unless Exotel explicitly tells you otherwise.
const BASE            = 'https://integrationscore.mum1.exotel.com/v2/integrations';
const CUSTOMER_ID     = process.env.EXOTEL_CUSTOMER_ID;
const CUSTOMER_SECRET = process.env.EXOTEL_CUSTOMER_SECRET;
const ACCOUNT_SID     = process.env.EXOTEL_ACCOUNT_SID;
const API_KEY         = process.env.EXOTEL_API_KEY;
const API_TOKEN       = process.env.EXOTEL_API_TOKEN;
const DOMAIN          = process.env.EXOTEL_DOMAIN || 'singapore';
const APP_ID          = process.env.EXOTEL_APP_ID;
const APP_SECRET      = process.env.EXOTEL_APP_SECRET;
const VIRTUAL_NUMBER  = process.env.EXOTEL_VIRTUAL_NUMBER || '';

const BX24_WEBHOOK    = process.env.BX24_WEBHOOK_URL || '';
const BX24_USER_ID    = process.env.BX24_USER_ID || '1';
const RENDER_URL      = process.env.RENDER_URL || 'https://exotel-websdk.onrender.com';

// outboundCallMap: exotelCallSid → { bx24CallId, agentBx24UserId, agentEmail, toNumber, ts }
// Populated when an outbound call is placed; used by /call-callback to finish it properly.
const outboundCallMap = {};

const isIndia = /mum|in1|india/i.test(DOMAIN);
const SIP_FB  = isIndia ? 'voip.in1.exotel.com' : 'voip.sgp1.exotel.com';

// ── In-memory state ───────────────────────────────────────────────
const pendingCallMap   = {};
const pendingInboundMap = {};
const inboundClaimMap   = {};
let   pollCount = 0;

// ── SSE client registry ───────────────────────────────────────────
const sseClients = {};

function ssePush(email, event, data) {
  const key = (email || '').toLowerCase();
  const client = sseClients[key];
  if (!client) return false;
  try {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    console.log(`[SSE] Pushed '${event}' to ${key}`);
    return true;
  } catch (e) {
    console.warn(`[SSE] Push failed for ${key}:`, e.message);
    delete sseClients[key];
    return false;
  }
}

// ── Token cache ───────────────────────────────────────────────────
let _appTokenCache = null;
let _appTokenExp   = 0;

// ── Token helpers ─────────────────────────────────────────────────
async function getCustomerToken() {
  const res  = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: CUSTOMER_ID, Secret: CUSTOMER_SECRET, Entity: 'customer' })
  });
  const raw  = await res.text();
  let data;
  try { data = JSON.parse(raw); }
  catch (_) {
    console.error('[Token] Customer token raw response (HTTP ' + res.status + '):', raw.slice(0, 300));
    throw new Error('Customer token: invalid JSON from Exotel — HTTP ' + res.status);
  }
  if (!res.ok) throw new Error('Customer token failed: ' + JSON.stringify(data));
  return data.Data;
}

async function getAppToken() {
  const now = Date.now();
  if (_appTokenCache && now < _appTokenExp - 60000) return _appTokenCache;
  const res  = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: APP_ID, Secret: APP_SECRET, Entity: 'app' })
  });
  const raw  = await res.text();
  let data;
  try { data = JSON.parse(raw); }
  catch (_) {
    console.error('[Token] App token raw response (HTTP ' + res.status + '):', raw.slice(0, 300));
    throw new Error('App token: invalid JSON from Exotel — HTTP ' + res.status);
  }
  if (!res.ok) throw new Error('App token failed: ' + JSON.stringify(data));
  _appTokenCache = data.Data?.Token;
  _appTokenExp   = now + ((data.Data?.ExpiresIn || 3600) * 1000);
  return _appTokenCache;
}

// ── Exotel V2 REST helper ─────────────────────────────────────────
async function exotelGet(path) {
  const creds = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
  const url   = `https://api.exotel.com/v1/Accounts/${ACCOUNT_SID}${path}`;
  const res   = await fetch(url, {
    headers: { Authorization: 'Basic ' + creds }
  });
  const raw = await res.text();
  try { return JSON.parse(raw); } catch (_) { return { raw }; }
}

async function exotelPost(path, params) {
  const creds = Buffer.from(`${API_KEY}:${API_TOKEN}`).toString('base64');
  const url   = `https://api.exotel.com/v1/Accounts/${ACCOUNT_SID}${path}`;
  const body  = new URLSearchParams(params).toString();
  const res   = await fetch(url, {
    method:  'POST',
    headers: { Authorization: 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const raw = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(raw) }; }
  catch (_) { return { ok: res.ok, status: res.status, data: { raw } }; }
}

// ── BX24 helpers ──────────────────────────────────────────────────
async function bx24Call(method, params = {}) {
  if (!BX24_WEBHOOK) return null;
  const url = BX24_WEBHOOK.replace(/\/$/, '') + '/' + method + '/';
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params)
  });
  const raw = await res.text();
  try { return JSON.parse(raw); }
  catch (_) { return { raw }; }
}

// ── Agent status tracking ─────────────────────────────────────────
const agentStatus = new Map(); // email → { status: 'free'|'busy', ts }

function setAgentBusy(email, busy) {
  if (!email) return;
  agentStatus.set(email.toLowerCase(), { status: busy ? 'busy' : 'free', ts: Date.now() });
}

// ── BX24 user resolution ──────────────────────────────────────────
// Map email → BX24 user ID (populated from /list-users)
const emailToBx24Id = {};

async function getBx24UserIdByEmail(email) {
  if (!email) return BX24_USER_ID;
  const key = email.toLowerCase();
  if (emailToBx24Id[key]) return emailToBx24Id[key];
  // Try to fetch from BX24
  try {
    const res = await bx24Call('user.get', { filter: { EMAIL: email }, select: ['ID', 'EMAIL'] });
    const users = res?.result || [];
    if (users.length > 0) {
      const id = String(users[0].ID);
      emailToBx24Id[key] = id;
      return id;
    }
  } catch (e) {
    console.warn('[BX24] user.get failed for', email, e.message);
  }
  return BX24_USER_ID;
}

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── SSE endpoint ──────────────────────────────────────────────────
app.get('/events', (req, res) => {
  const email = (req.query.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  sseClients[email] = res;
  console.log(`[SSE] ${email} connected (total: ${Object.keys(sseClients).length})`);

  // Send immediate heartbeat
  res.write('event: connected\ndata: {}\n\n');

  // Keep-alive ping every 25s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    delete sseClients[email];
    console.log(`[SSE] ${email} disconnected`);
  });
});

// ── Agent status endpoint ─────────────────────────────────────────
app.post('/agent-status', (req, res) => {
  const { email, status } = req.body;
  if (!email || !['free','busy'].includes(status)) return res.status(400).json({ error: 'email and status (free|busy) required' });
  setAgentBusy(email, status === 'busy');
  console.log(`[AgentStatus] ${email} → ${status}`);
  res.json({ ok: true });
});

// ── Client-side logger ────────────────────────────────────────────
app.post('/client-log', (req, res) => {
  const { source, message, extra, email, ts } = req.body;
  console.log(`[Client:${source || 'popup'}] <${email || 'unknown'}> ${message}`, extra ? JSON.stringify(extra) : '');
  res.json({ ok: true });
});

// ── Token endpoint ────────────────────────────────────────────────
app.get('/token', async (req, res) => {
  const userId    = req.query.user_id    || req.query.email       || null;
  const bx24Id    = req.query.bx24_user_id                        || null;
  const lookupKey = (userId || bx24Id || '').toLowerCase().trim();

  console.log(`[Token] request user_id=${userId} bx24_user_id=${bx24Id}`);

  if (!lookupKey) return res.status(400).json({ error: 'user_id (email) or bx24_user_id required' });

  try {
    // Step 1: get customer-level token to list app users
    const custData = await getCustomerToken();
    const custToken = custData?.Token;
    if (!custToken) throw new Error('No customer token returned');

    // Step 2: list app users
    const listUrl = `${BASE}/apps/${APP_ID}/users`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: 'Bearer ' + custToken }
    });
    const listRaw  = await listRes.text();
    let listData;
    try { listData = JSON.parse(listRaw); }
    catch (_) {
      console.error('[Token] List users raw:', listRaw.slice(0, 300));
      throw new Error('List users: invalid JSON — HTTP ' + listRes.status);
    }
    if (!listRes.ok) throw new Error('List users failed: ' + JSON.stringify(listData));

    const users = listData.Data || [];
    console.log(`[Token] ${users.length} app users found`);

    // Step 3: match by email or bx24 ID
    let matched = null;
    for (const u of users) {
      const uEmail = (u.Email || u.email || '').toLowerCase().trim();
      const uBx24  = String(u.BX24UserId || u.bx24_user_id || u.ExternalId || u.external_id || '').trim();
      if (userId  && uEmail === lookupKey) { matched = u; break; }
      if (bx24Id  && uBx24  === lookupKey) { matched = u; break; }
    }

    if (!matched) {
      console.error(`[Token] No user matched for key=${lookupKey} among ${users.length} users`);
      return res.status(404).json({ error: `No Exotel app user found for '${lookupKey}'` });
    }

    // Step 4: get an app-scoped token
    const appToken = await getAppToken();
    if (!appToken) throw new Error('No app token returned');

    const sipId     = matched.SipId     || matched.sip_id     || '';
    const sipSecret = matched.SipSecret || matched.sip_secret || '';
    const appUserId = matched.UserId    || matched.user_id    || matched.AppUserId || '';

    console.log(`[Token] Matched: email=${matched.Email} userId=${appUserId} sipId=${sipId} secret=${sipSecret ? '✓' : '✗'}`);

    // Store email → bx24 id mapping for later use
    if (matched.Email && matched.BX24UserId) {
      emailToBx24Id[(matched.Email || '').toLowerCase()] = String(matched.BX24UserId);
    }

    res.json({
      access_token:   appToken,
      app_user_id:    String(appUserId),
      sip_id:         sipId,
      sip_secret:     sipSecret,
      virtual_number: VIRTUAL_NUMBER
    });

  } catch (e) {
    console.error('[Token] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── List users (debug) ────────────────────────────────────────────
app.get('/list-users', async (req, res) => {
  try {
    const custData  = await getCustomerToken();
    const custToken = custData?.Token;
    const listRes   = await fetch(`${BASE}/apps/${APP_ID}/users`, {
      headers: { Authorization: 'Bearer ' + custToken }
    });
    const data = await listRes.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pending call poll ─────────────────────────────────────────────
app.get('/pending-call', (req, res) => {
  const email   = (req.query.email        || '').toLowerCase();
  const bx24Id  =  req.query.bx24_user_id || '';

  // ── Outbound pending ──
  const outKey = email || bx24Id;
  if (outKey && pendingCallMap[outKey]) {
    const c = pendingCallMap[outKey];
    if (Date.now() - c.ts < 30000) {
      return res.json({ pending: true, type: 'outbound', number: c.number, callSid: c.callSid });
    }
    delete pendingCallMap[outKey];
  }

  // ── Inbound pending ──
  for (const sid of Object.keys(pendingInboundMap)) {
    const d = pendingInboundMap[sid];
    if (Date.now() - d.ts > 90000) { delete pendingInboundMap[sid]; continue; }

    // Skip calls claimed by another agent
    const lock = d.phoneKey ? callerLocks.get(d.phoneKey) : null;
    if (lock && lock.claimedBy) {
      // Return "claimed" so the agent's poll can dismiss the incoming panel
      return res.json({ pending: false, type: 'claimed', callSid: sid, claimedBy: lock.claimedBy });
    }
    if (claimedSids.has(sid)) {
      const claimer = inboundClaimMap[sid]?.email || 'unknown';
      return res.json({ pending: false, type: 'claimed', callSid: sid, claimedBy: claimer });
    }

    // Skip calls rejected by this agent
    if (lock && email && lock.rejectedBy.has(email)) continue;

    // Only ring agents that are free
    if (email && agentStatus.get(email)?.status === 'busy') continue;

    return res.json({ pending: true, type: 'inbound', from: d.from, callSid: sid });
  }

  res.json({ pending: false });
});

// ── Reject call ───────────────────────────────────────────────────
app.post('/reject-call', (req, res) => {
  const { callSid, email } = req.body;
  if (!callSid || !email) return res.status(400).json({ error: 'callSid and email required' });

  // Mark this agent as having rejected the call
  for (const [phoneKey, lock] of callerLocks.entries()) {
    if (lock.sid === callSid) {
      lock.rejectedBy.add(email.toLowerCase());
      console.log(`[Reject] ${email} rejected ${callSid}`);
      break;
    }
  }
  res.json({ ok: true });
});

// ── Outbound call ─────────────────────────────────────────────────
app.post('/make-outbound-call', async (req, res) => {
  const { toNumber, agentEmail } = req.body;
  if (!toNumber || !agentEmail) return res.status(400).json({ error: 'toNumber and agentEmail required' });

  console.log(`[OutboundCall] ${agentEmail} → ${toNumber}`);

  try {
    // Get agent's SIP ID
    const custData  = await getCustomerToken();
    const custToken = custData?.Token;
    const listRes   = await fetch(`${BASE}/apps/${APP_ID}/users`, {
      headers: { Authorization: 'Bearer ' + custToken }
    });
    const listData = await listRes.json();
    const users    = listData.Data || [];
    const agent    = users.find(u => (u.Email || '').toLowerCase() === agentEmail.toLowerCase());
    if (!agent) throw new Error(`Agent ${agentEmail} not found in Exotel`);

    const agentUserId = agent.UserId || agent.user_id || agent.AppUserId;
    const sipFallback = SIP_FB;

    // Place call via Exotel V1 API: agent's SIP → customer number
    const callRes = await exotelPost(`/Calls/connect.json`, {
      From:             agentUserId,
      To:               toNumber,
      CallerId:         VIRTUAL_NUMBER,
      StatusCallback:   `${RENDER_URL}/call-callback`,
      Record:           'true',
      TimeLimit:        '3600'
    });

    if (!callRes.ok) throw new Error('Exotel API error: ' + JSON.stringify(callRes.data));

    const sid = callRes.data?.Call?.Sid || callRes.data?.CallSid || null;
    console.log(`[OutboundCall] placed sid=${sid}`);

    // Register in BX24
    let bx24CallId = sid;
    const agentBx24Id = await getBx24UserIdByEmail(agentEmail);
    if (BX24_WEBHOOK && sid) {
      try {
        const regRes = await bx24Call('telephony.externalcall.register', {
          USER_ID:      agentBx24Id,
          PHONE_NUMBER: toNumber,
          TYPE:         2, // outbound
          CALL_START_DATE: new Date().toISOString(),
          CRM_CREATE:   'Y',
          CRM_ENTITY_TYPE: 'CONTACT',
          LINE_NUMBER:  VIRTUAL_NUMBER
        });
        bx24CallId = regRes?.result?.CALL_ID || sid;
        console.log(`[BX24] register outbound → CALL_ID=${bx24CallId}`);
      } catch (e) {
        console.warn('[BX24] register outbound failed:', e.message);
      }
    }

    if (sid) {
      outboundCallMap[sid] = {
        bx24CallId,
        agentBx24UserId: agentBx24Id,
        agentEmail:      agentEmail.toLowerCase(),
        toNumber,
        ts:              Date.now()
      };
    }

    res.json({ ok: true, callSid: sid });

  } catch (e) {
    console.error('[OutboundCall] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Call status callback ──────────────────────────────────────────
app.all('/call-callback', async (req, res) => {
  const p = Object.assign({}, req.query, req.body);
  console.log('[Callback]', JSON.stringify(p));
  res.json({ status: 'ok' });

  const sid         = p.CallSid || p.call_sid || null;
  const callState   = (p.Status       || p.CallStatus || '').toLowerCase();
  const callDetail  = (p.DialCallStatus || '').toLowerCase();
  const from        = p.From || p.CallFrom || '';
  const to          = p.To   || p.DialWhomNumber || '';
  const duration    = parseInt(p.Duration || p.CallDuration || '0', 10) || 0;
  const recordingUrl = p.RecordingUrl || null;

  if (!sid) return;

  // Look up outbound call map
  const outbound = sid ? outboundCallMap[sid] : null;

  // Dedup terminal webhooks — Exotel sometimes sends duplicate callbacks
  const terminalKey = `terminal:${sid}`;
  const isTerminal = callState === 'terminal' || callState === 'terminated' ||
                     callState === 'completed' || callState === 'failed'    ||
                     callDetail === 'terminal' || callDetail === 'completed' ||
                     callDetail === 'failed';
  if (!isTerminal) {
    console.log(`[Callback] Non-terminal state=${callState} for sid=${sid} — skip`);
    return;
  }
  if (global[terminalKey]) {
    console.log(`[Callback] SKIP duplicate terminal webhook for sid=${sid}`);
    return;
  }
  global[terminalKey] = true;
  setTimeout(() => { delete global[terminalKey]; }, 120000);

  // ── Finish BX24 call ──────────────────────────────────────────
  const callData = pendingInboundMap[sid] || null;

  // Inbound: look up bx24CallId from inboundClaimMap
  const inboundClaim = inboundClaimMap[sid];

  let bx24CallId    = null;
  let agentBx24Id   = BX24_USER_ID;
  let phoneNumber   = null;
  let callType      = 1; // 1=inbound, 2=outbound

  if (outbound) {
    bx24CallId  = outbound.bx24CallId;
    agentBx24Id = outbound.agentBx24UserId || BX24_USER_ID;
    phoneNumber = outbound.toNumber;
    callType    = 2;
  } else if (inboundClaim) {
    bx24CallId  = inboundClaim.bx24CallId || sid;
    agentBx24Id = inboundClaim.bx24UserId || BX24_USER_ID;
    phoneNumber = callData?.from || from;
    callType    = 1;
    // Update bx24CallId if we stored it from claim
    if (inboundClaimMap[sid]?.bx24CallId) bx24CallId = inboundClaimMap[sid].bx24CallId;
  } else {
    // Untracked call — skip BX24
    console.log(`[Callback] sid=${sid} not in outboundCallMap or inboundClaimMap — skipping BX24`);
    // Still clean up local state
    if (callData && callData.phoneKey) callerLocks.delete(callData.phoneKey);
    if (pendingInboundMap[sid]) delete pendingInboundMap[sid];
    claimedSids.delete(sid);
    return;
  }

  if (BX24_WEBHOOK && bx24CallId) {
    try {
      const finishParams = {
        CALL_ID:       bx24CallId,
        USER_ID:       agentBx24Id,
        DURATION:      duration,
        STATUS_CODE:   callState === 'completed' ? 200 : 304,
        TYPE:          callType
      };
      if (recordingUrl) finishParams.RECORD_URL = recordingUrl;
      const finishRes = await bx24Call('telephony.externalcall.finish', finishParams);
      console.log(`[BX24] finish → ${JSON.stringify(finishRes?.result || finishRes)}`);
    } catch (e) {
      console.warn('[BX24] finish failed:', e.message);
    }
  }

  // Clean up
  if (callData && callData.phoneKey) callerLocks.delete(callData.phoneKey);
  if (pendingInboundMap[sid]) delete pendingInboundMap[sid];
  claimedSids.delete(sid);

  // Schedule recording sync
  const clientNum  = outbound ? outbound.toNumber : (callData?.from || from);
  const finishEmail = outbound ? outbound.agentEmail : (inboundClaim?.email || null);

  if (clientNum) {
    recordings.scheduleSync({
      clientNum:  clientNum,
      agentEmail: finishEmail,
      callSid:    sid,
      bx24CallId: bx24CallId,
      agentBx24Id: agentBx24Id
    });
  }

  // Notify agents to dismiss any incoming UI for this sid
  Object.keys(sseClients).forEach(e =>
    ssePush(e, 'call_dismissed', { callSid: sid, reason: 'call_ended' })
  );
});

// ── Inbound claim ─────────────────────────────────────────────────
const claimedSids = new Set();

const callerLocks = new Map();
const LOCK_TTL_MS  = 90 * 1000;
const recentHangups = new Map(); // phoneKey → timestamp of last terminal event
const HANGUP_COOLDOWN_MS = 10000; // suppress new inbounds for 10s after hangup

function normalizePhone(n) {
  if (!n) return '';
  return String(n).replace(/\D/g, '').replace(/^0+/, '').slice(-10);
}

// ── Incoming call (Exotel webhook) ────────────────────────────────
app.all('/incoming-call', async (req, res) => {
  const p  = Object.assign({}, req.query, req.body);
  console.log('[Incoming]', JSON.stringify(p));
  const et = (p.EventType || p.Status || '').toLowerCase();
  if (['free','terminal','completed','busy','noanswer','terminated','failed'].includes(et)) {
    // Cooldown: record hangup timestamp to suppress phantom re-rings within 10s
    const fromNum = p.From || p.CallFrom || p.caller_id || p.CallerId || p.callerid || null;
    if (fromNum) {
      const phoneKey = normalizePhone(fromNum);
      recentHangups.set(phoneKey, Date.now());
      const lock = callerLocks.get(phoneKey);
      if (lock && !lock.claimedBy) {
        callerLocks.delete(phoneKey);
        if (pendingInboundMap[lock.sid]) delete pendingInboundMap[lock.sid];
        console.log(`[Incoming] Terminal status — cleaned up lock for ${phoneKey}`);
        Object.keys(sseClients).forEach(e =>
          ssePush(e, 'call_dismissed', { callSid: lock.sid, reason: 'caller_hung_up' })
        );
      }
    }
    return res.json({ status: 'ignored' });
  }
  try {
    const from   = p.From || p.CallFrom || p.caller_id || p.CallerId || p.callerid || 'Unknown';
    const toNum  = p.To || p.DialWhomNumber || p.CallTo || VIRTUAL_NUMBER || 'Unknown';
    const rawSid = p.CallSid || p.call_sid || p.ParentCallSid || p.DialCallSid || null;
    const phoneKey = normalizePhone(from);

    let lock  = callerLocks.get(phoneKey);
    const stale = lock && (Date.now() - lock.ts > LOCK_TTL_MS) && !lock.claimedBy;
    if (!lock || stale) {
      lock = {
        sid:        rawSid || ('in_' + Date.now() + '_' + phoneKey),
        claimedBy:  null,
        rejectedBy: new Set(),
        ts:         Date.now()
      };
      callerLocks.set(phoneKey, lock);
    }
    const sid = lock.sid;

    const hangupTs = recentHangups.get(phoneKey);
    if (hangupTs && (Date.now() - hangupTs) < HANGUP_COOLDOWN_MS) {
      console.log(`[Incoming] SUPPRESSED — ${phoneKey} had terminal event ${Date.now() - hangupTs}ms ago (phantom re-ring)`);
      return res.json({ status: 'suppressed_phantom' });
    }
    if (lock.claimedBy || claimedSids.has(sid)) {
      console.log(`[Incoming] SKIP broadcast — ${sid} (from ${from}) already claimed by ${lock.claimedBy}`);
      return res.json({ status: 'already_claimed' });
    }

    pendingInboundMap[sid] = { from, to: toNum, ts: Date.now(), phoneKey };

    const allAgents = Object.keys(sseClients);
    let targets = allAgents.filter(e =>
      (agentStatus.get(e)?.status !== 'busy') && !lock.rejectedBy.has(e)
    );
    if (targets.length === 0) targets = allAgents.filter(e => !lock.rejectedBy.has(e));
    if (targets.length === 0) targets = allAgents;

    const pushed = targets.reduce((n, agentEmail) =>
      n + (ssePush(agentEmail, 'inbound_call', { from, callSid: sid }) ? 1 : 0), 0);
    console.log(`[Incoming] sid=${sid} from=${from} → broadcast to ${pushed}/${allAgents.length} agent(s)`);

    res.json({ status: 'received' });
  } catch (e) { console.error('[Incoming]', e.message); res.json({ status: 'error', message: e.message }); }
});

// ── Inbound call claim ────────────────────────────────────────────
app.post('/claim-call', async (req, res) => {
  const { callSid, email, bx24UserId } = req.body;
  if (!callSid || !email) return res.status(400).json({ error: 'callSid and email required' });

  if (inboundClaimMap[callSid]) {
    const c = inboundClaimMap[callSid];
    console.log(`[Claim] REJECTED — ${callSid} already claimed by ${c.email}`);
    return res.json({ claimed: false, reason: 'already_claimed', claimedBy: c.email });
  }

  inboundClaimMap[callSid] = { email, bx24UserId: bx24UserId || null, bx24CallId: null, ts: Date.now() };
  claimedSids.add(callSid);
  console.log(`[Claim] ${email} claimed ${callSid}`);

  const callData = pendingInboundMap[callSid];
  if (callData && callData.phoneKey) {
    const lock = callerLocks.get(callData.phoneKey);
    if (lock) lock.claimedBy = email.toLowerCase();
  }

  setAgentBusy(email, true);

  let bx24CallId = callSid;
  if (BX24_WEBHOOK && callData) {
    try {
      const agentBx24Id = bx24UserId || BX24_USER_ID;
      const regRes = await bx24Call('telephony.externalcall.register', {
        USER_ID:      agentBx24Id,
        PHONE_NUMBER: callData.from,
        TYPE:         1, // inbound
        CALL_START_DATE: new Date().toISOString(),
        CRM_CREATE:   'Y',
        CRM_ENTITY_TYPE: 'CONTACT',
        LINE_NUMBER:  VIRTUAL_NUMBER
      });
      bx24CallId = regRes?.result?.CALL_ID || callSid;
      inboundClaimMap[callSid].bx24CallId = bx24CallId;
      console.log(`[BX24] register inbound → CALL_ID=${bx24CallId}`);
    } catch (e) {
      console.warn('[BX24] register inbound failed:', e.message);
    }
  }

  // Notify all other agents to dismiss incoming panel
  Object.keys(sseClients).forEach(agentEmail => {
    if (agentEmail !== email.toLowerCase()) {
      ssePush(agentEmail, 'call_dismissed', { callSid, reason: 'claimed_by_other' });
    }
  });

  res.json({ claimed: true, bx24CallId });
});

// ── Sync recordings ───────────────────────────────────────────────
app.post('/sync-recordings', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });
  try {
    await recordings.syncRecordings({ clientNum: phoneNumber });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Startup sync ──────────────────────────────────────────────────
async function startupSync() {
  try {
    const result = await recordings.refreshCallMap();
    console.log('[Startup] Sync:', JSON.stringify(result));
  } catch (e) {
    console.warn('[Startup] Sync failed:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`==> Available at your primary URL https://exotel-websdk.onrender.com`);
  startupSync();
});
