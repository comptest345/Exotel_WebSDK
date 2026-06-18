// ═══════════════════════════════════════════════════════════════
// popup.js — Exotel WebSDK + Bitrix24 Softphone
// ROOT CAUSE FIX:
//   1. ExotelCRMWebSDK constructor takes (accessToken, appUserId)
//      where accessToken = APP token (not customer token)
//      and appUserId = AppUserId string from /usermapping
//   2. The SDK's Initialize() internally calls DoRegister()
//      when autoConnect=true — no manual DoRegister needed.
//   3. BX24 identity: try BX24.init() → postMessage → URL fallback
//   4. /token endpoint must return { access_token, app_user_id }
//      BOTH fields are required for ExotelCRMWebSDK constructor.
//   5. regEvent fires 'registered'/'terminated' — match exactly.
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

// ── BX24 identity: Method 1 — BX24.init() API ────────────────────────────────
function getBx24CurrentUser() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const MAX    = 10;
    function tryInit() {
      attempts++;
      if (typeof window.BX24 === 'undefined') {
        if (attempts < MAX) return setTimeout(tryInit, 600);
        return reject(new Error('BX24 JS bridge not loaded after ' + (MAX * 600) + 'ms'));
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
        if (attempts < MAX) return setTimeout(tryInit, 600);
        reject(e);
      }
    }
    tryInit();
  });
}

// ── BX24 identity: Method 2 — postMessage ─────────────────────────────────────
function getBx24UserViaPostMessage() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('postMessage timeout')), 5000);
    function handler(e) {
      try {
        const d = (typeof e.data === 'string') ? JSON.parse(e.data) : e.data;
        if (d && d.BX24_AUTH && d.BX24_AUTH.user_id) {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve({ id: String(d.BX24_AUTH.user_id), email: null, name: '' });
        }
      } catch (_) {}
    }
    window.addEventListener('message', handler);
    try { window.parent.postMessage({ cmd: 'getAuth' }, '*'); } catch (_) {}
  });
}

// ── BX24 identity: Method 3 — URL params ──────────────────────────────────────
function getBx24UserIdFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const po     = params.get('PLACEMENT_OPTIONS');
    if (po) {
      const opts = JSON.parse(decodeURIComponent(po));
      if (opts.USER_ID) return String(opts.USER_ID);
    }
    return params.get('USER_ID') || params.get('user_id') || params.get('bx24_user_id') || null;
  } catch (_) { return null; }
}

// ── Resolve BX24 identity (tries all methods) ─────────────────────────────────
async function resolveBx24Identity() {
  try {
    const u = await getBx24CurrentUser();
    if (u.email || u.id) { clog('Identity via BX24.init: ' + u.name + ' <' + u.email + '> id=' + u.id); return u; }
  } catch (e) { clog('BX24.init failed: ' + e.message); }

  try {
    const u = await getBx24UserViaPostMessage();
    if (u.id) { clog('Identity via postMessage: id=' + u.id); return u; }
  } catch (e) { clog('postMessage failed: ' + e.message); }

  const urlId = getBx24UserIdFromUrl();
  if (urlId) { clog('Identity via URL: id=' + urlId); return { id: urlId, email: null, name: '' }; }

  throw new Error('Cannot identify BX24 user — all methods failed.');
}

// ── Microphone ────────────────────────────────────────────────────────────────
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

// ── UI helpers ────────────────────────────────────────────────────────────────
function showIncoming(from) {
  callDirection = 'inbound';
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
function showDialer() {
  callDirection = null;
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

// ── Main init ─────────────────────────────────────────────────────────────────
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
    setStatus('⚠️ Open this from a CRM contact sidebar. (' + e.message + ')');
    clog('Identity failed: ' + e.message);
    scheduleRetry();
    return;
  }
  currentBx24UserId = identity.id    || null;
  currentUserEmail  = identity.email || null;
  setStatus((identity.name ? 'Hello ' + identity.name.split(' ')[0] + '! ' : '') + 'Requesting mic...');

  // Step 2: Microphone
  await requestMic();
  if (!micGranted) { scheduleRetry(); return; }

  // Step 3: Fetch credentials from /token
  setStatus('Fetching credentials...');
  let tokenData;
  try {
    const url = currentUserEmail
      ? '/token?user_id=' + encodeURIComponent(currentUserEmail)
      : '/token?bx24_user_id=' + encodeURIComponent(currentBx24UserId);
    clog('Fetching: ' + url);
    const res = await fetch(url);
    const body = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + body.slice(0, 200));
    tokenData = JSON.parse(body);
    if (tokenData.error) throw new Error(tokenData.error);
    // Back-fill email
    if (!currentUserEmail && tokenData.email)        currentUserEmail = tokenData.email;
    if (!currentUserEmail && tokenData.sip_id)       currentUserEmail = tokenData.sip_id;
    clog('Token OK → app_user_id=' + tokenData.app_user_id + ' sip_id=' + tokenData.sip_id);
  } catch (e) {
    setReg('failed');
    setStatus('Credentials error: ' + e.message);
    clog('Token error: ' + e.message);
    scheduleRetry();
    return;
  }

  // CRITICAL: ExotelCRMWebSDK needs EXACTLY these two fields
  const accessToken = tokenData.access_token || tokenData.app_token;
  const appUserId   = String(tokenData.app_user_id || tokenData.user_id || '');

  if (!accessToken) {
    setReg('failed');
    setStatus('No access_token in /token response');
    clog('Missing access_token in: ' + JSON.stringify(tokenData));
    scheduleRetry();
    return;
  }
  if (!appUserId) {
    setReg('failed');
    setStatus('No app_user_id in /token response');
    clog('Missing app_user_id in: ' + JSON.stringify(tokenData));
    scheduleRetry();
    return;
  }

  // Step 4: Init ExotelCRMWebSDK
  // Constructor: new ExotelCRMWebSDK(accessToken, userId, autoConnectVOIP)
  // - accessToken = APP token (JWT from /v2/integrations/token entity=app)
  // - userId = AppUserId from usermapping (numeric string)
  // - autoConnectVOIP = true → SDK auto-calls DoRegister after Initialize
  setStatus('Connecting softphone...');
  try {
    if (typeof ExotelCRMWebSDK === 'undefined') {
      throw new Error('ExotelCRMWebSDK not loaded — /target/crmBundle.js missing');
    }

    clog('new ExotelCRMWebSDK(token[0..20]=' + accessToken.slice(0,20) + '... userId=' + appUserId + ' autoConnect=true)');
    const crmWebSDK = new ExotelCRMWebSDK(accessToken, appUserId, true);

    // regEvent fires with string state: 'registered' | 'terminated' | 'unregistered' | 'sent request'
    // Per Exotel docs: RegisterationEvent(state, phone)
    let regFired = false;
    const regTimeoutHandle = setTimeout(() => {
      if (!sdkReady) {
        clog('regEvent not fired in 20s — SDK may be registered silently or wrong token');
        // Do NOT assume registered here — show error so user knows
        setReg('failed');
        setStatus('SIP register timeout — check credentials & network');
        scheduleRetry();
      }
    }, 20000);

    function registrationEventHandler(state, phone) {
      regFired = true;
      clearTimeout(regTimeoutHandle);
      clog('regEvent state=' + state + ' phone=' + phone);

      if (state === 'registered') {
        sdkReady = true;
        initRetries = 0;
        setReg('registered');
        setStatus('✅ Ready — ' + (phone || appUserId));
        startPoll();
      } else if (state === 'terminated' || state === 'unregistered') {
        sdkReady = false;
        setReg('failed');
        setStatus('SIP ' + state + ' — retrying...');
        clog('SIP ' + state + ' for ' + phone);
        scheduleRetry();
      } else {
        // 'sent request' or other transient states
        clog('SIP state: ' + state);
      }
    }

    webPhone = await crmWebSDK.Initialize(
      handleCallEvent,
      registrationEventHandler
    );

    // Release mic stream after SDK takes over
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }

    clog('Initialize() resolved. webPhone=' + (webPhone ? typeof webPhone : 'null'));

    // Some SDK versions resolve promise before firing regEvent
    // If webPhone returned and regEvent hasn't fired yet, wait for it via timeout above
    // If webPhone is null/void, SDK may have failed internally
    if (!webPhone) {
      clearTimeout(regTimeoutHandle);
      if (!sdkReady) {
        setReg('failed');
        setStatus('SDK Initialize() returned null — check app_user_id and token');
        clog('webPhone is null after Initialize — possible wrong AppUserId or token mismatch');
        scheduleRetry();
      }
    }

  } catch (err) {
    setReg('failed');
    setStatus('SDK error: ' + err.message);
    clog('SDK FAILED: ' + err.message);
    scheduleRetry();
  }
}

// ── Retry: exponential backoff ────────────────────────────────────────────────
let retryTimer = null;
function scheduleRetry() {
  if (retryTimer) return;
  initRetries++;
  if (initRetries > MAX_RETRIES) {
    setReg('failed');
    setStatus('❌ Connection failed. Reload the page.');
    clog('Max retries reached');
    return;
  }
  const delay = Math.min(5000 * Math.pow(2, initRetries - 1), 30000);
  clog('Retry in ' + (delay/1000) + 's (attempt ' + initRetries + '/' + MAX_RETRIES + ')');
  setStatus('Reconnecting in ' + Math.round(delay/1000) + 's...');
  retryTimer = setTimeout(() => { retryTimer = null; init(); }, delay);
}

// ── Click-to-call polling ─────────────────────────────────────────────────────
let pollTimer = null;
let pollCount = 0;
function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(doPoll, 2000);
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
    if (pollCount % 30 === 1) clog('poll#' + pollCount + ' email=' + currentUserEmail);
    if (data.pending && data.number) {
      clog('Click-to-call: ' + data.number);
      callDirection = 'outbound';
      const phoneEl = document.getElementById('phone');
      if (phoneEl) phoneEl.value = data.number;
      await triggerOutboundCall(data.number);
    }
  } catch (_) {}
}

async function triggerOutboundCall(number) {
  if (!webPhone)   { clog('MakeCall: webPhone null'); setStatus('SDK not ready'); return; }
  if (!sdkReady)   { clog('MakeCall: SDK not registered'); setStatus('SDK not registered yet'); return; }
  callDirection = 'outbound';
  clog('MakeCall → ' + number);
  try { await webPhone.MakeCall(number, null, null); }
  catch (e) { clog('MakeCall error: ' + e.message); setStatus('Call failed: ' + e.message); }
}

// ── Call event handler ────────────────────────────────────────────────────────
// Exotel SDK fires events like: { event: 'incoming' | 'accepted' | 'terminated' | ... }
// Per docs: sofPhoneListenerCallback(event)
function handleCallEvent(event) {
  clog('callEvent: ' + JSON.stringify(event));
  const raw  = JSON.stringify(event || {}).toLowerCase();
  const type = ((event && (event.event || event.EventType || event.type || event.state)) || '').toLowerCase();

  const isIncoming   = type.includes('incoming') || type.includes('ringing') || raw.includes('incoming') || raw.includes('ringing');
  const isConnected  = type.includes('connect') || type.includes('answer') || type.includes('accept') || type.includes('active') || raw.includes('accepted') || raw.includes('connected');
  const isEnded      = type.includes('end') || type.includes('terminat') || type.includes('bye') || type.includes('complet') || type.includes('disconnect') || raw.includes('callended') || raw.includes('call_completed');

  if (isIncoming) {
    if (callDirection === 'outbound') {
      // Outbound SIP leg rings locally — auto-accept silently
      clog('Outbound SIP ring → silent AcceptCall');
      if (webPhone) webPhone.AcceptCall().catch(e => clog('silentAccept err: ' + e.message));
    } else {
      const from = (event && (event.from || event.FromNumber || event.callerNumber || event.CallFrom)) || 'Unknown';
      showIncoming(from);
    }
  } else if (isConnected) {
    const num = callDirection === 'inbound'
      ? (document.getElementById('callerNum')?.textContent || '')
      : (document.getElementById('phone')?.value || '');
    showActive(num);
    setStatus('');
  } else if (isEnded) {
    showDialer();
    setStatus('Call ended');
  }
}

// ── Button handlers ───────────────────────────────────────────────────────────
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number)     { setStatus('Enter a number'); return; }
  if (!webPhone)   { setStatus('SDK not ready');  return; }
  if (!micGranted) { setStatus('⚠️ Allow microphone first!'); return; }
  document.getElementById('callBtn').disabled = true;
  await triggerOutboundCall(number);
  document.getElementById('callBtn').disabled = false;
}

async function acceptCall() {
  if (!webPhone) { setStatus('SDK not ready'); return; }
  if (!micGranted) { await requestMic(); if (!micGranted) { setStatus('⚠️ Mic required'); return; } }
  clog('AcceptCall');
  try {
    await webPhone.AcceptCall();
    showActive(document.getElementById('callerNum')?.textContent || '');
    setStatus('');
  } catch (e) { clog('AcceptCall error: ' + e.message); setStatus('Accept failed: ' + e.message); }
}

async function rejectCall() {
  if (!webPhone) return;
  clog('RejectCall');
  try { await webPhone.HangupCall(); } catch (e) { clog('Reject err: ' + e.message); }
  showDialer(); setStatus('Call rejected');
}

async function hangUp() {
  if (!webPhone) return;
  clog('HangupCall');
  try { await webPhone.HangupCall(); } catch (e) { clog('Hangup err: ' + e.message); }
  showDialer(); setStatus('Call ended');
}

window.onload = init;
