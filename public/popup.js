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

let currentUserEmail      = null;
let currentBx24UserId     = null;
let currentInboundCallSid = null;
const dismissedCallSids   = new Set();
let dismissedAt           = 0;
let acceptingCallSid      = null;
let outboundInFlight      = false;

function log(msg) { console.log('[Dialer]', msg); }
function clog(msg, extra) {
  fetch('/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'popup.js', message: msg, extra: extra || null, email: currentUserEmail, ts: Date.now() })
  }).catch(() => {});
}

function reportStatus(status) {
  if (!currentUserEmail) return;
  fetch('/agent-status', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: currentUserEmail, status })
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
    const po = params.get('PLACEMENT_OPTIONS');
    if (po) {
      const opts = JSON.parse(decodeURIComponent(po));
      if (opts.USER_ID) return String(opts.USER_ID);
    }
    return params.get('USER_ID') || params.get('user_id') || params.get('bx24_user_id') || null;
  } catch (_) { return null; }
}

function getBx24UserIdFromAuth() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('auth[user_id]') || params.get('AUTH[USER_ID]') || null;
  } catch (_) { return null; }
}

async function resolveBx24Identity() {
  clog('popup URL: ' + window.location.href.slice(0, 200));
  try {
    const u = await getBx24CurrentUser();
    if (u.email || u.id) {
      clog('Identity via BX24.init: ' + u.name + ' <' + u.email + '> id=' + u.id);
      return u;
    }
  } catch (e) { clog('BX24.init failed: ' + e.message); }

  const urlId = getBx24UserIdFromUrl();
  if (urlId) { clog('Identity via URL: id=' + urlId); return { id: urlId, email: null, name: '' }; }

  const authId = getBx24UserIdFromAuth();
  if (authId) { clog('Identity via auth: id=' + authId); return { id: authId, email: null, name: '' }; }

  throw new Error('Cannot identify BX24 user. URL: ' + window.location.href.slice(0, 150));
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
  if (callSid) currentInboundCallSid = callSid;
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
  reportStatus('busy');
}

function showDialer() {
  callDirection         = null;
  outboundInFlight      = false;
  currentInboundCallSid = null;
  acceptingCallSid      = null;
  document.getElementById('incomingPanel').style.display = 'none';
  document.getElementById('activePanel').style.display   = 'none';
  document.getElementById('dialerPanel').style.display   = 'block';
  document.getElementById('hangupBtn').style.display     = 'none';
  document.getElementById('callBtn').style.display       = 'block';
  stopTimer();
  reportStatus('free');
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
  sdkReady = false;
  webPhone = null;
  setReg('connecting');
  setStatus('Identifying user...');

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
    {
      app_user_id:    String(tokenData.app_user_id || tokenData.user_id || tokenData.sip_username || ''),
      sip_id:         tokenData.sip_id         || '',
      sip_secret:     tokenData.sip_secret     || '',
      virtual_number: tokenData.virtual_number || ''
    }
  ];

  if (!accessToken || credentials.length === 0 || !credentials[0].app_user_id) {
    setReg('failed');
    setStatus('Missing token fields — check /list-users');
    clog('Bad token response: ' + JSON.stringify(tokenData));
    scheduleRetry();
    return;
  }

  setStatus('Connecting softphone...');
  await tryInitWithCredentials(accessToken, credentials, 0);
}

// ── Multi-credential SDK init ─────────────────────────────────
async function tryInitWithCredentials(accessToken, creds, i) {
  if (i >= creds.length) {
    clog('All credentials exhausted — scheduling retry');
    setReg('failed');
    setStatus('SIP register failed — retrying');
    scheduleRetry();
    return;
  }

  const cred      = creds[i];
  const appUserId = String(cred.app_user_id || '');
  const sipSecret = cred.sip_secret || '';
  const sipId     = cred.sip_id     || '';

  if (!appUserId) {
    clog('Credential #' + i + ' has no app_user_id — skipping');
    return tryInitWithCredentials(accessToken, creds, i + 1);
  }

  try {
    if (typeof ExotelCRMWebSDK === 'undefined') throw new Error('ExotelCRMWebSDK not loaded');

    clog('SDK init ' + (i+1) + '/' + creds.length + ' userId=' + appUserId);

    const sdkOptions = sipSecret ? { sip_username: appUserId, sip_password: sipSecret } : undefined;
    const crmWebSDK  = sdkOptions
      ? new ExotelCRMWebSDK(accessToken, appUserId, true, sdkOptions)
      : new ExotelCRMWebSDK(accessToken, appUserId, true);

    let regFired = false;
    const regTimeout = setTimeout(() => {
      if (!sdkReady && !regFired) {
        clog('regEvent timeout for userId=' + appUserId + ' — trying next');
        tryInitWithCredentials(accessToken, creds, i + 1);
      }
    }, 30000);

    function registrationEventHandler(state, phone) {
      if (regFired) return;
      regFired = true;
      clearTimeout(regTimeout);
      clog('regEvent state=' + state + ' phone=' + phone + ' userId=' + appUserId);

      if (state === 'registered') {
        sdkReady    = true;
        initRetries = 0;
        if (!webPhone) {
          webPhone = {
            MakeCall:   (n) => crmWebSDK.MakeCall   ? crmWebSDK.MakeCall(n, () => {}) : Promise.resolve(),
            AcceptCall: ()  => crmWebSDK.AcceptCall  ? crmWebSDK.AcceptCall()           : Promise.resolve(),
            HangupCall: ()  => crmWebSDK.HangupCall  ? crmWebSDK.HangupCall()           : Promise.resolve()
          };
        }
        setReg('registered');
        setStatus('✅ Ready — ' + (phone || appUserId));
        reportStatus('free');
        startPoll();
      } else if (state === 'terminated' || state === 'unregistered') {
        clog('regEvent ' + state + ' — trying next');
        tryInitWithCredentials(accessToken, creds, i + 1);
      }
    }

    webPhone = await crmWebSDK.Initialize(handleCallEvent, registrationEventHandler);
    releaseMic();
    clog('Initialize() resolved. webPhone=' + (webPhone ? typeof webPhone : 'null'));

  } catch (err) {
    releaseMic();
    clog('SDK FAILED userId=' + appUserId + ': ' + err.message);
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
  setStatus('Reconnecting in ' + Math.round(delay/1000) + 's...');
  retryTimer = setTimeout(() => { retryTimer = null; init(); }, delay);
}

// ── SSE + poll ────────────────────────────────────────────────
let sseSource = null;
let pollTimer = null;
let pollCount = 0;

function startPoll() {
  startSSE();
  startPollFallback();
}

function startSSE() {
  if (sseSource) return;
  if (!currentUserEmail) return;
  const p = new URLSearchParams({ email: currentUserEmail });
  if (currentBx24UserId) p.set('bx24_user_id', currentBx24UserId);
  const url = '/events?' + p.toString();
  clog('SSE connecting: ' + url);
  sseSource = new EventSource(url);

  // ── Outbound call triggered from BX24 click-to-call ──────
  // Server receives OnExternalCallStart webhook → resolves agent email
  // → pushes this SSE event → we call Exotel API to place the call.
  sseSource.addEventListener('outbound_call', async (e) => {
    const d = JSON.parse(e.data);
    clog('SSE outbound_call: ' + d.number);
    if (callDirection || outboundInFlight) {
      clog('SSE outbound_call ignored — already in progress');
      return;
    }
    const phoneEl = document.getElementById('phone');
    if (phoneEl) phoneEl.value = d.number;
    await triggerOutboundCall(d.number);
  });

  sseSource.addEventListener('inbound_call', async (e) => {
    const d = JSON.parse(e.data);
    clog('SSE inbound_call from: ' + d.from + ' sid: ' + d.callSid);
    if (callDirection) { clog('SSE inbound ignored — already on call'); return; }
    if (d.callSid && dismissedCallSids.has(d.callSid)) { clog('SSE inbound ignored — dismissed'); return; }
    if (d.callSid) dismissedAt = 0;
    showIncoming(d.from, d.callSid);
  });

  sseSource.addEventListener('call_dismissed', (e) => {
    const d = JSON.parse(e.data);
    const sidMatch = (currentInboundCallSid === d.callSid) || (currentInboundCallSid === null);
    if (callDirection === 'inbound' && sidMatch) {
      const reason = d.reason || '';
      clog('call_dismissed: ' + reason + ' sid=' + d.callSid);
      if (d.callSid) dismissedCallSids.add(d.callSid);
      dismissedAt = Date.now();
      showDialer();
      setStatus(reason === 'caller_hung_up' ? '📵 Caller hung up' : '📞 Answered by another agent');
    }
  });

  sseSource.addEventListener('call_ended', (e) => {
    const d = JSON.parse(e.data);
    clog('SSE call_ended sid=' + d.callSid);
    if (!callDirection) return;
    showDialer();
    setStatus('Call ended');
  });

  sseSource.onopen  = () => clog('SSE connected');
  sseSource.onerror = () => {
    clog('SSE error — reconnecting in 3s');
    try { sseSource.close(); } catch (_) {}
    sseSource = null;
    setTimeout(() => { if (!sseSource) startSSE(); }, 3000);
  };
}

function startPollFallback() {
  if (pollTimer) return;
  pollTimer = setInterval(doPoll, 5000);
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

    if (data.pending && data.type === 'inbound' && !callDirection) {
      if (data.callSid && dismissedCallSids.has(data.callSid)) return;
      clog('Poll: inbound from ' + data.from);
      showIncoming(data.from, data.callSid);

    } else if (!data.pending && data.type === 'claimed') {
      const weClaimedIt   = (data.callSid === acceptingCallSid);
      const activePanelEl = document.getElementById('activePanel');
      const isLive        = activePanelEl && activePanelEl.style.display === 'block';
      if (callDirection === 'inbound' && !weClaimedIt && !isLive) {
        clog('Poll: claimed by ' + data.claimedBy);
        if (data.callSid) dismissedCallSids.add(data.callSid);
        dismissedAt = Date.now();
        showDialer();
        setStatus('📞 Answered by another agent');
      }

    } else if (data.pending && (data.type === 'outbound' || data.number) && !callDirection && !outboundInFlight) {
      clog('Poll fallback: outbound to ' + data.number);
      const phoneEl = document.getElementById('phone');
      if (phoneEl) phoneEl.value = data.number;
      await triggerOutboundCall(data.number);
    }
  } catch (_) {}
}

// ── Core outbound call trigger ────────────────────────────────
async function triggerOutboundCall(number) {
  if (!sdkReady)         { clog('OutboundCall: SDK not ready'); setStatus('Not registered yet'); return; }
  if (!currentUserEmail) { clog('OutboundCall: no email');      setStatus('⚠️ Email not resolved — reload'); return; }
  if (outboundInFlight || callDirection) {
    clog('OutboundCall blocked — inFlight=' + outboundInFlight + ' dir=' + callDirection);
    return;
  }

  outboundInFlight = true;
  callDirection    = 'outbound';
  reportStatus('busy');
  // Show active panel + start timer immediately so agent sees call is in progress.
  // Timer starts now (from agent's perspective the call is placed).
  showActive('📞 ' + number);
  clog('OutboundCall → ' + number);

  try {
    const res  = await fetch('/make-outbound-call', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ toNumber: number, agentEmail: currentUserEmail })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Server error');
    clog('OutboundCall placed: ' + JSON.stringify(data));
    outboundInFlight = false;
    // Update display to show number cleanly (remove the 📞 prefix)
    const el = document.getElementById('activeNum');
    if (el) el.textContent = number;
  } catch (e) {
    clog('OutboundCall error: ' + e.message);
    showDialer();
    setStatus('Call failed: ' + e.message);
  }
}

// ── Call event handler (Exotel SDK events) ────────────────────
function handleCallEvent(event) {
  clog('callEvent: ' + JSON.stringify(event));
  const raw  = JSON.stringify(event || {}).toLowerCase();
  const type = ((event && (event.event || event.EventType || event.type || event.state)) || '').toLowerCase();

  const isIncoming    = type.includes('incoming') || type.includes('ringing') || raw.includes('incoming') || raw.includes('ringing');
  const isEnded       = type.includes('end')      || type.includes('terminat') || type.includes('bye')     ||
                        type.includes('complet')   || type.includes('cancel')   || type.includes('failed')  ||
                        type.includes('reject')    ||
                        raw.includes('callended')  || raw.includes('call_completed') || raw.includes('call_failed');
  const isAcceptEvent = type.includes('accept') || raw.includes('accepted');
  const isConnected   = type.includes('connect') || type.includes('answer') || type.includes('active') ||
                        raw.includes('connected') || isAcceptEvent;

  if (isIncoming) {
    if (callDirection === 'outbound') {
      // Agent SIP leg is ringing — silently accept so audio connects.
      // UI already shows active+timer from triggerOutboundCall, don't reset it.
      clog('Outbound SIP ring → silent AcceptCall (UI already active)');
      if (webPhone) webPhone.AcceptCall().catch(e => clog('silentAccept err: ' + e.message));
    } else {
      // Inbound — guard against duplicates.
      if (acceptingCallSid)         { clog('Native incoming ignored — already accepted'); return; }
      const ap = document.getElementById('activePanel');
      if (ap && ap.style.display === 'block') { clog('Native incoming ignored — already live'); return; }
      if (currentInboundCallSid && dismissedCallSids.has(currentInboundCallSid)) { clog('Native incoming ignored — dismissed'); return; }
      if (Date.now() - dismissedAt < 8000)    { clog('Native incoming ignored — cooldown'); return; }
      const from = (event && (event.from || event.FromNumber || event.callerNumber || event.CallFrom)) || 'Unknown';
      showIncoming(from);
    }

  } else if (isConnected) {
    if (!callDirection) { clog('isConnected ignored — no active call'); return; }
    // For inbound: show active now. For outbound: already showing, just ensure timer is running.
    const num = callDirection === 'inbound'
      ? (document.getElementById('callerNum')?.textContent || '')
      : (document.getElementById('activeNum')?.textContent || document.getElementById('phone')?.value || '');
    acceptingCallSid = null;
    showActive(num);
    setStatus('');

  } else if (isEnded) {
    const ap = document.getElementById('activePanel');
    const isActiveShowing = ap && ap.style.display === 'block';
    if (!callDirection && !isActiveShowing) {
      clog('isEnded ignored — no active call (type=' + type + ')');
      return;
    }
    clog('Call ended (type=' + type + ')');
    showDialer();
    setStatus('Call ended');
  }
}

// ── Button handlers ───────────────────────────────────────────
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number)         { setStatus('Enter a number'); return; }
  if (!webPhone)       { setStatus('SDK not ready');  return; }
  if (!micGranted)     { setStatus('⚠️ Allow microphone first!'); return; }
  if (!currentUserEmail) { setStatus('⚠️ User identity not resolved. Reload.'); return; }
  const btn = document.getElementById('callBtn');
  btn.disabled = true;
  try { await triggerOutboundCall(number); } finally { btn.disabled = false; }
}

async function acceptCall() {
  if (!webPhone)   { setStatus('SDK not ready'); return; }
  if (!micGranted) { await requestMic(); if (!micGranted) { setStatus('⚠️ Mic required'); return; } }

  if (currentInboundCallSid) {
    try {
      const r = await fetch('/claim-call', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ callSid: currentInboundCallSid, email: currentUserEmail, bx24UserId: currentBx24UserId })
      });
      const d = await r.json();
      if (!d.claimed) {
        clog('Claim failed — taken by ' + (d.claimedBy || 'another agent'));
        if (currentInboundCallSid) dismissedCallSids.add(currentInboundCallSid);
        showDialer();
        setStatus('📞 Already answered by another agent');
        return;
      }
      clog('Claimed callSid=' + currentInboundCallSid);
      if (currentInboundCallSid) dismissedCallSids.add(currentInboundCallSid);
    } catch (e) { clog('Claim failed (proceeding anyway): ' + e.message); }
  }

  acceptingCallSid = currentInboundCallSid;
  clog('AcceptCall');
  try {
    await webPhone.AcceptCall();
    const num = document.getElementById('callerNum')?.textContent || '';
    acceptingCallSid = null;
    showActive(num);
    setStatus('');
    clog('AcceptCall resolved — live with ' + num);
  } catch (e) {
    acceptingCallSid = null;
    callDirection    = null;
    reportStatus('free');
    showDialer();
    setStatus('Accept failed: ' + e.message);
  }
}

async function rejectCall() {
  clog('rejectCall');
  if (currentInboundCallSid) {
    try {
      await fetch('/reject-call', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ callSid: currentInboundCallSid, email: currentUserEmail })
      });
    } catch (e) { clog('reject-call failed: ' + e.message); }
    dismissedCallSids.add(currentInboundCallSid);
  }
  dismissedAt = Date.now();
  showDialer();
  setStatus('Call declined');
}

async function hangUp() {
  if (!webPhone) return;
  const wasDirection = callDirection;
  showDialer();
  setStatus('Call ended');
  fetch('/hangup', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: currentUserEmail, direction: wasDirection })
  }).catch(() => {});
  try { await webPhone.HangupCall(); } catch (e) { clog('Hangup err: ' + e.message); }
}

window.onload = init;
