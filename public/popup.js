// ═══════════════════════════════════════════════════════════════
// popup.js — Dynamic multi-agent version
// Resolves the logged-in BX24 user's email → fetches their
// SIP credentials from /token → initializes ExotelCRMWebSDK
// NO hardcoded user IDs anywhere.
// ═══════════════════════════════════════════════════════════════

let webPhone      = null;
let sdkReady      = false;
let timerInterval = null;
let timerSec      = 0;
let callDirection = null;
let micGranted    = false;
let micStream     = null;
let initRetries   = 0;
const MAX_RETRIES = 4;

let currentUserEmail  = null;
let currentBx24UserId = null;
let currentInboundCallSid = null;  // set when an inbound call arrives; used for claiming

function log(msg) { console.log('[Dialer]', msg); }
function clog(msg, extra) {
  fetch('/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'popup.js', message: msg, extra: extra || null, email: currentUserEmail, ts: Date.now() })
  }).catch(() => {});
}
function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
  log(msg);
}
function setReg(state) {
  const dot = document.getElementById('regDot');
  const txt = document.getElementById('regText');
  const map = {
    connecting: { cls: 'yellow', label: 'Connecting...' },
    registered: { cls: 'green',  label: '🟢 Ready' },
    failed:     { cls: 'red',    label: '🔴 Disconnected' }
  };
  const s = map[state] || { cls: '', label: state };
  if (dot) dot.className = 'dot ' + s.cls;
  if (txt) txt.textContent = s.label;
}

// ── BX24 identity resolution ──────────────────────────────────
function getBx24CurrentUser() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    // Retry for up to 30 seconds (50 × 600ms) — BX24 iframe bridge can be slow to init
    const MAX_ATTEMPTS = 50;
    function tryInit() {
      attempts++;
      if (typeof window.BX24 === 'undefined') {
        if (attempts < MAX_ATTEMPTS) return setTimeout(tryInit, 600);
        return reject(new Error('BX24 JS bridge not loaded after ' + (MAX_ATTEMPTS * 0.6) + 's'));
      }
      try {
        BX24.init(function () {
          BX24.callMethod('user.current', {}, function (result) {
            if (result.error()) return reject(new Error(String(result.error())));
            const d = result.data();
            resolve({
              email: (d.EMAIL || '').trim() || null,
              id:    String(d.ID || ''),
              name:  ((d.NAME || '') + ' ' + (d.LAST_NAME || '')).trim()
            });
          });
        });
      } catch (e) {
        if (attempts < MAX_ATTEMPTS) return setTimeout(tryInit, 600);
        reject(e);
      }
    }
    tryInit();
  });
}

function getBx24UserIdFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    // PLACEMENT_OPTIONS carries USER_ID in CRM_ACTIVITY_SIDEBAR context
    const po = params.get('PLACEMENT_OPTIONS');
    if (po) {
      const opts = JSON.parse(decodeURIComponent(po));
      if (opts.USER_ID) return String(opts.USER_ID);
    }
    // Direct params (some placements pass it flat)
    return params.get('USER_ID') || params.get('user_id') || params.get('bx24_user_id') || null;
  } catch (_) { return null; }
}

function getBx24UserIdFromAuth() {
  // BX24 injects an auth object into the iframe URL as a ?auth[user_id]=N param
  try {
    const params = new URLSearchParams(window.location.search);
    // BX24 uses bracket notation: auth[user_id]
    return params.get('auth[user_id]') || params.get('AUTH[USER_ID]') || null;
  } catch (_) { return null; }
}

async function resolveBx24Identity() {
  // Log the full URL to help debug iframe context issues
  clog('popup URL: ' + window.location.href.slice(0, 200));

  // Method 1: BX24.init API (most reliable — works in sidebar iframe)
  try {
    const u = await getBx24CurrentUser();
    if (u.email || u.id) {
      clog('Identity via BX24.init: ' + u.name + ' <' + u.email + '> id=' + u.id);
      return u;
    }
  } catch (e) { clog('BX24.init failed: ' + e.message); }

  // Method 2: PLACEMENT_OPTIONS or direct URL params
  const urlId = getBx24UserIdFromUrl();
  if (urlId) {
    clog('Identity via URL PLACEMENT_OPTIONS: id=' + urlId);
    return { id: urlId, email: null, name: '' };
  }

  // Method 3: BX24 auth params injected into iframe URL
  const authId = getBx24UserIdFromAuth();
  if (authId) {
    clog('Identity via auth[user_id]: id=' + authId);
    return { id: authId, email: null, name: '' };
  }

  throw new Error('Cannot identify BX24 user — all methods failed. URL: ' + window.location.href.slice(0, 150));
}

// ── Microphone ────────────────────────────────────────────────
async function requestMic() {
  try {
    micStream  = await navigator.mediaDevices.getUserMedia({ audio: true });
    micGranted = true;
    clog('Mic granted');
  } catch (e) {
    micGranted = false;
    clog('Mic DENIED: ' + e.message);
    setStatus('⚠️ Allow microphone and reload.');
    const w = document.getElementById('micWarning');
    if (w) w.style.display = 'block';
  }
}

function releaseMic() {
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
    clog('Mic stream released');
  }
}

// ── UI helpers ────────────────────────────────────────────────
function showIncoming(from, callSid) {
  callDirection = 'inbound';
  currentInboundCallSid = callSid || null;
  const el = document.getElementById('callerNum');
  if (el) el.textContent = from || 'Unknown';
  document.getElementById('incomingPanel').style.display = 'block';
  document.getElementById('activePanel').style.display   = 'none';
  document.getElementById('dialerPanel').style.display   = 'none';
  document.getElementById('hangupBtn').style.display     = 'none';
  document.getElementById('callBtn').style.display       = 'none';
}
function showActive(num) {
  const el = document.getElementById('activeNum');
  if (el) el.textContent = num || '';
  document.getElementById('incomingPanel').style.display = 'none';
  document.getElementById('activePanel').style.display   = 'block';
  document.getElementById('dialerPanel').style.display   = 'none';
  document.getElementById('hangupBtn').style.display     = 'block';
  document.getElementById('callBtn').style.display       = 'none';
  startTimer();
}
// Shows a "ringing" state for outbound calls: the SIP leg to Exotel is up,
// but the customer hasn't answered yet. Active panel is visible (agent can
// hang up) but the timer does NOT start until customer actually answers.
function showOutboundRinging(num) {
  const el = document.getElementById('activeNum');
  if (el) el.textContent = '🔔 ' + (num || 'Calling...');
  document.getElementById('incomingPanel').style.display = 'none';
  document.getElementById('activePanel').style.display   = 'block';
  document.getElementById('dialerPanel').style.display   = 'none';
  document.getElementById('hangupBtn').style.display     = 'block';
  document.getElementById('callBtn').style.display       = 'none';
  stopTimer();
  const timerEl = document.getElementById('timerEl');
  if (timerEl) timerEl.textContent = 'Ringing...';
}

function showDialer() {
  callDirection = null;
  currentInboundCallSid = null;
  document.getElementById('incomingPanel').style.display = 'none';
  document.getElementById('activePanel').style.display   = 'none';
  document.getElementById('dialerPanel').style.display   = 'block';
  document.getElementById('hangupBtn').style.display     = 'none';
  document.getElementById('callBtn').style.display       = 'block';
  stopTimer();
}
function startTimer() {
  timerSec = 0; stopTimer();
  timerInterval = setInterval(() => {
    timerSec++;
    const m = String(Math.floor(timerSec / 60)).padStart(2,'0');
    const s = String(timerSec % 60).padStart(2,'0');
    const el = document.getElementById('timerEl');
    if (el) el.textContent = m + ':' + s;
  }, 1000);
}
function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }

// ── Main init ─────────────────────────────────────────────────
async function init() {
  sdkReady      = false;
  webPhone      = null;
  setReg('connecting');
  setStatus('Identifying user...');

  // Step 1: Identify BX24 user
  let identity;
  try {
    identity = await resolveBx24Identity();
  } catch (e) {
    setReg('failed');
    setStatus('⚠️ Open from a CRM sidebar. (' + e.message + ')');
    scheduleRetry();
    return;
  }
  currentBx24UserId = identity.id    || null;
  currentUserEmail  = identity.email || null;

  setStatus('Requesting mic...');
  await requestMic();
  if (!micGranted) { scheduleRetry(); return; }

  // Step 2: Fetch credentials from /token
  // Pass email if we have it (most reliable lookup key)
  // Fall back to bx24_user_id so server can cache-resolve
  setStatus('Fetching credentials...');
  let tokenData;
  try {
    const url = currentUserEmail
      ? '/token?user_id=' + encodeURIComponent(currentUserEmail)
      : '/token?bx24_user_id=' + encodeURIComponent(currentBx24UserId);
    clog('Fetching: ' + url);
    const res  = await fetch(url);
    const body = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + body.slice(0, 200));
    tokenData = JSON.parse(body);
    if (tokenData.error) throw new Error(tokenData.error);
    clog('Token OK → AppUserId=' + tokenData.app_user_id + ' SipId=' + tokenData.sip_id);
  } catch (e) {
    setReg('failed');
    setStatus('Credentials error: ' + e.message);
    clog('Token error: ' + e.message);
    scheduleRetry();
    return;
  }

  const accessToken = tokenData.access_token || tokenData.app_token;
  const credentials = tokenData.multiCredentials || [
    { app_user_id: String(tokenData.app_user_id || tokenData.user_id || '') }
  ];

  if (!accessToken || credentials.length === 0) {
    setReg('failed');
    setStatus('Missing token fields — check /list-users');
    clog('Bad token response: ' + JSON.stringify(tokenData));
    scheduleRetry();
    return;
  }

  // Step 3: Init ExotelCRMWebSDK — try each credential set until one registers.
  // For single-entry agents this runs once. For Khushil (two entries) it tries
  // the highest AppUserId first, then falls back to the second if that times out.
  setStatus('Connecting softphone...');
  await tryInitWithCredentials(accessToken, credentials, 0);
}

// ── Multi-credential SDK init ─────────────────────────────────
// Tries each credential set in `creds` (index i) until one registers.
// If a set times out (30 s) without a regEvent, moves to the next.
// Only falls back to scheduleRetry() after all sets are exhausted.
async function tryInitWithCredentials(accessToken, creds, i) {
  if (i >= creds.length) {
    clog('All ' + creds.length + ' credential(s) exhausted — scheduling retry');
    setReg('failed');
    setStatus('SIP register failed — retrying');
    scheduleRetry();
    return;
  }

  const cred      = creds[i];
  const appUserId = String(cred.app_user_id || '');
  if (!appUserId) {
    clog('Credential #' + i + ' has no app_user_id — skipping');
    return tryInitWithCredentials(accessToken, creds, i + 1);
  }

  try {
    if (typeof ExotelCRMWebSDK === 'undefined') {
      throw new Error('ExotelCRMWebSDK not loaded — crmBundle.js missing');
    }

    clog('SDK init attempt ' + (i+1) + '/' + creds.length +
         ' — token[0..20]=' + accessToken.slice(0,20) +
         '... userId=' + appUserId);
    const crmWebSDK = new ExotelCRMWebSDK(accessToken, appUserId, true);

    let regFired = false;
    const regTimeout = setTimeout(() => {
      if (!sdkReady && !regFired) {
        clog('regEvent not fired in 30 s for userId=' + appUserId +
             ' — trying next credential (' + (i+1) + '/' + creds.length + ')');
        setStatus('Trying next credential...');
        tryInitWithCredentials(accessToken, creds, i + 1);
      }
    }, 30000);

    function registrationEventHandler(state, phone) {
      if (regFired) return;   // guard: ignore late events from a previous attempt
      regFired = true;
      clearTimeout(regTimeout);
      clog('regEvent state=' + state + ' phone=' + phone + ' userId=' + appUserId);

      if (state === 'registered') {
        sdkReady    = true;
        initRetries = 0;
        if (!webPhone) {
          webPhone = {
            MakeCall:   (n, a, b) => crmWebSDK.MakeCall   ? crmWebSDK.MakeCall(n, a, b)   : Promise.resolve(),
            AcceptCall: ()        => crmWebSDK.AcceptCall  ? crmWebSDK.AcceptCall()         : Promise.resolve(),
            HangupCall: ()        => crmWebSDK.HangupCall  ? crmWebSDK.HangupCall()         : Promise.resolve()
          };
        }
        setReg('registered');
        setStatus('✅ Ready — ' + (phone || appUserId));
        startPoll();
      } else if (state === 'terminated' || state === 'unregistered') {
        // Hard failure on this credential — move on immediately
        clog('regEvent ' + state + ' for userId=' + appUserId + ' — trying next');
        tryInitWithCredentials(accessToken, creds, i + 1);
      }
      // 'sent request' / other transient states: wait for regTimeout
    }

    webPhone = await crmWebSDK.Initialize(handleCallEvent, registrationEventHandler);
    releaseMic();

    clog('Initialize() resolved. webPhone=' + (webPhone ? typeof webPhone : 'null/void') +
         ' userId=' + appUserId);

  } catch (err) {
    releaseMic();
    clog('SDK FAILED userId=' + appUserId + ': ' + err.message);
    // Hard JS error — try next credential immediately
    tryInitWithCredentials(accessToken, creds, i + 1);
  }
}

// ── Retry ─────────────────────────────────────────────────────
let retryTimer = null;
function scheduleRetry() {
  if (retryTimer) return;
  initRetries++;
  if (initRetries > MAX_RETRIES) {
    setReg('failed');
    setStatus('❌ Connection failed. Reload the page.');
    return;
  }
  const delay = Math.min(5000 * Math.pow(2, initRetries - 1), 30000);
  clog('Retry in ' + (delay/1000) + 's (attempt ' + initRetries + '/' + MAX_RETRIES + ')');
  setStatus('Reconnecting in ' + Math.round(delay/1000) + 's...');
  retryTimer = setTimeout(() => { retryTimer = null; init(); }, delay);
}

// ── SSE subscription + poll fallback ─────────────────────────
// Primary: subscribe to /events so the server pushes calls instantly.
// Fallback: 5 s poll on /pending-call covers the window before SSE connects
//           and the edge case where the SSE connection drops silently.
let sseSource  = null;
let pollTimer  = null;
let pollCount  = 0;

function startPoll() {
  startSSE();          // SSE is the primary channel
  startPollFallback(); // poll runs alongside as safety net
}

function startSSE() {
  if (sseSource) return; // already connected
  if (!currentUserEmail) return;
  const url = '/events?email=' + encodeURIComponent(currentUserEmail);
  clog('SSE connecting: ' + url);
  sseSource = new EventSource(url);

  sseSource.addEventListener('outbound_call', async (e) => {
    const d = JSON.parse(e.data);
    clog('SSE outbound_call: ' + d.number);
    const phoneEl = document.getElementById('phone');
    if (phoneEl) phoneEl.value = d.number;
    callDirection = 'outbound';
    await triggerOutboundCall(d.number);
  });

  sseSource.addEventListener('inbound_call', async (e) => {
    const d = JSON.parse(e.data);
    clog('SSE inbound_call from: ' + d.from + ' sid: ' + d.callSid);
    showIncoming(d.from, d.callSid);
  });

  // Another agent claimed the call — dismiss our incoming UI.
  sseSource.addEventListener('call_dismissed', (e) => {
    const d = JSON.parse(e.data);
    if (callDirection === 'inbound' && currentInboundCallSid === d.callSid) {
      clog('call_dismissed — claimed by ' + d.claimedBy);
      showDialer();
      setStatus('📞 Answered by another agent');
    }
  });

  sseSource.onopen  = () => clog('SSE connected');
  sseSource.onerror = (err) => {
    clog('SSE error — will rely on poll fallback');
    // EventSource auto-reconnects; no need to do anything
  };
}

function startPollFallback() {
  if (pollTimer) return;
  pollTimer = setInterval(doPoll, 5000); // reduced frequency — SSE handles real-time
}

async function doPoll() {
  if (!currentUserEmail && !currentBx24UserId) return;
  try {
    const url = currentUserEmail
      ? '/pending-call?email=' + encodeURIComponent(currentUserEmail)
      : '/pending-call?bx24_user_id=' + encodeURIComponent(currentBx24UserId);
    const res  = await fetch(url);
    const data = await res.json();
    pollCount++;
    if (pollCount % 12 === 1) clog('poll#' + pollCount + ' email=' + currentUserEmail);
    if (data.pending && data.type === 'inbound' && callDirection !== 'inbound') {
      // Poll caught an inbound call we missed via SSE
      clog('Poll fallback: inbound from ' + data.from + ' sid=' + data.callSid);
      showIncoming(data.from, data.callSid);
    } else if (data.pending && data.type === 'outbound' && data.number) {
      clog('Poll fallback caught outbound call: ' + data.number);
      callDirection = 'outbound';
      const phoneEl = document.getElementById('phone');
      if (phoneEl) phoneEl.value = data.number;
      await triggerOutboundCall(data.number);
    } else if (data.pending && data.number) {
      // Legacy shape (no type field) — treat as outbound
      clog('Poll fallback (legacy) caught call: ' + data.number);
      callDirection = 'outbound';
      const phoneEl = document.getElementById('phone');
      if (phoneEl) phoneEl.value = data.number;
      await triggerOutboundCall(data.number);
    }
  } catch (_) {}
}

async function triggerOutboundCall(number) {
  if (!webPhone)  { clog('MakeCall: webPhone null'); setStatus('SDK not ready'); return; }
  if (!sdkReady)  { clog('MakeCall: not registered'); setStatus('Not registered yet'); return; }
  callDirection = 'outbound';
  clog('MakeCall → ' + number);
  try { await webPhone.MakeCall(number, null, null); }
  catch (e) { clog('MakeCall error: ' + e.message); setStatus('Call failed: ' + e.message); }
}

// ── Call event handler ────────────────────────────────────────
function handleCallEvent(event) {
  clog('callEvent: ' + JSON.stringify(event));
  const raw  = JSON.stringify(event || {}).toLowerCase();
  const type = ((event && (event.event || event.EventType || event.type || event.state)) || '').toLowerCase();

  const isIncoming  = type.includes('incoming') || type.includes('ringing') || raw.includes('incoming') || raw.includes('ringing');
  const isEnded     = type.includes('end')      || type.includes('terminat')|| type.includes('bye')     || type.includes('complet') || raw.includes('callended') || raw.includes('call_completed');

  // BUG FIX: For outbound calls, 'accept'/'accepted' fires when AcceptCall()
  // resolves on the agent's own SIP leg — the customer's phone is still ringing
  // at this point. Only 'connect', 'answer', or 'active' mean the customer answered.
  // For inbound calls, 'accept' correctly means the agent accepted and the call is live.
  const isAcceptEvent = type.includes('accept') || raw.includes('accepted');
  const isConnected   =
    type.includes('connect') || type.includes('answer') || type.includes('active') || raw.includes('connected')
    || (isAcceptEvent && callDirection !== 'outbound');

  if (isIncoming) {
    if (callDirection === 'outbound') {
      clog('Outbound SIP ring → silent AcceptCall, showing ringing UI');
      if (webPhone) webPhone.AcceptCall().catch(e => clog('silentAccept err: ' + e.message));
      // BUG FIX: Show "Ringing..." so the agent has feedback and can hang up.
      // Timer does NOT start here — customer hasn't answered yet.
      showOutboundRinging(document.getElementById('phone')?.value || '');
    } else {
      const from = (event && (event.from || event.FromNumber || event.callerNumber || event.CallFrom)) || 'Unknown';
      showIncoming(from);
    }
  } else if (isConnected) {
    const num = callDirection === 'inbound'
      ? (document.getElementById('callerNum')?.textContent || '')
      : (document.getElementById('phone')?.value || '');
    showActive(num);  // Customer answered — now start the timer
    setStatus('');
  } else if (isEnded) {
    showDialer();
    setStatus('Call ended');
  }
}

// ── Button handlers ───────────────────────────────────────────
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number)    { setStatus('Enter a number'); return; }
  if (!webPhone)  { setStatus('SDK not ready');  return; }
  if (!micGranted){ setStatus('⚠️ Allow microphone first!'); return; }
  document.getElementById('callBtn').disabled = true;
  await triggerOutboundCall(number);
  document.getElementById('callBtn').disabled = false;
}

async function acceptCall() {
  if (!webPhone) { setStatus('SDK not ready'); return; }
  if (!micGranted) { await requestMic(); if (!micGranted) { setStatus('⚠️ Mic required'); return; } }

  // Multi-agent: atomically claim the call on the server before accepting
  // the SIP leg. If another agent got there first we get { claimed: false }
  // and just dismiss — no SIP AcceptCall is sent.
  if (currentInboundCallSid) {
    try {
      const claimRes = await fetch('/claim-call', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          callSid:    currentInboundCallSid,
          email:      currentUserEmail,
          bx24UserId: currentBx24UserId
        })
      });
      const claimData = await claimRes.json();
      if (!claimData.claimed) {
        clog('Claim failed — already taken by ' + (claimData.claimedBy || 'another agent'));
        showDialer();
        setStatus('📞 Already answered by another agent');
        return;
      }
      clog('Claimed callSid=' + currentInboundCallSid + ' bx24CallId=' + claimData.bx24CallId);
    } catch (e) {
      clog('Claim request failed (proceeding anyway): ' + e.message);
      // Network error on claim — proceed with AcceptCall so the agent isn't stuck.
    }
  }

  clog('AcceptCall');
  try {
    await webPhone.AcceptCall();
    showActive(document.getElementById('callerNum')?.textContent || '');
    setStatus('');
  } catch (e) { clog('AcceptCall error: ' + e.message); setStatus('Accept failed: ' + e.message); }
}

async function rejectCall() {
  // For inbound multi-agent: just dismiss this agent's UI locally.
  // Do NOT call HangupCall — that would send a SIP decline for our leg and
  // could interfere with other agents still ringing.
  // The customer continues to hear ringback; Exotel's platform handles no-answer timeout.
  clog('rejectCall — dismissing locally, other agents unaffected');
  showDialer();
  setStatus('Call declined');
}

async function hangUp() {
  if (!webPhone) return;
  try { await webPhone.HangupCall(); } catch (e) { clog('Hangup err: ' + e.message); }
  showDialer(); setStatus('Call ended');
}

window.onload = init;
