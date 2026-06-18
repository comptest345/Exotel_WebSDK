// ═══════════════════════════════════════════════════════════════
// popup.js — Multi-agent version
// FIX: Robust BX24 identity resolution (postMessage + BX24.init +
//      URL param fallbacks). Proper /token lookup by email.
//      SDK reconnect/retry logic for "Failed, retrying".
// ═══════════════════════════════════════════════════════════════

let webPhone      = null;
let sdkReady      = false;
let timerInterval = null;
let timerSec      = 0;
let callDirection = null;
let micGranted    = false;
let initRetries   = 0;
const MAX_RETRIES = 3;

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
    registered: { cls: 'green',  label: '\uD83D\uDFE2 Ready' },
    failed:     { cls: 'red',    label: '\uD83D\uDD34 Disconnected — retrying...' }
  };
  const s = map[state] || { cls: '', label: state };
  if (dot) dot.className = 'dot ' + s.cls;
  if (txt) txt.textContent = s.label;
}

// ── Method 1: postMessage-based BX24 identity (most reliable in sidebar iframes) ──
function getBx24UserViaPostMessage() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('postMessage timeout')), 4000);
    function handler(e) {
      try {
        const d = (typeof e.data === 'string') ? JSON.parse(e.data) : e.data;
        if (d && d.BX24_AUTH && d.BX24_AUTH.user_id) {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve({ id: String(d.BX24_AUTH.user_id), email: null, name: '' });
        }
      } catch(err) {}
    }
    window.addEventListener('message', handler);
    // Ask parent for auth
    try { window.parent.postMessage({ cmd: 'getAuth' }, '*'); } catch(e) {}
  });
}

// ── Method 2: BX24.init() API call ────────────────────────────────────────────
function getBx24CurrentUser() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const MAX    = 8;   // more attempts, longer wait
    function tryInit() {
      attempts++;
      if (!window.BX24) {
        if (attempts < MAX) { setTimeout(tryInit, 800); }
        else { reject(new Error('BX24 not available after ' + MAX + ' attempts')); }
        return;
      }
      try {
        BX24.init(function () {
          BX24.callMethod('user.current', {}, function (result) {
            if (result.error()) { reject(new Error(String(result.error()))); return; }
            const data = result.data();
            resolve({
              email: (data.EMAIL || '').trim() || null,
              id:    String(data.ID || ''),
              name:  ((data.NAME || '') + ' ' + (data.LAST_NAME || '')).trim()
            });
          });
        });
      } catch(e) {
        if (attempts < MAX) { setTimeout(tryInit, 800); }
        else { reject(e); }
      }
    }
    tryInit();
  });
}

// ── Method 3: Parse bx24_user_id / USER_ID from iframe URL ───────────────────
function getBx24UserIdFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    // PLACEMENT_OPTIONS is set by BX24 when opening a sidebar placement
    const placementOptions = params.get('PLACEMENT_OPTIONS');
    if (placementOptions) {
      const opts = JSON.parse(decodeURIComponent(placementOptions));
      if (opts.USER_ID) return String(opts.USER_ID);
    }
    // Direct query param fallbacks
    return params.get('USER_ID') || params.get('user_id') || params.get('bx24_user_id') || null;
  } catch(e) { return null; }
}

// ── Resolve BX24 user: tries all three methods ────────────────────────────────
async function resolveBx24Identity() {
  // Try BX24.init() first (direct API, most info)
  try {
    const u = await getBx24CurrentUser();
    if (u.email || u.id) {
      clog('Identity via BX24.init(): ' + u.name + ' <' + u.email + '> id=' + u.id);
      return u;
    }
  } catch(e) {
    clog('BX24.init() failed: ' + e.message);
  }

  // Try postMessage
  try {
    const u = await getBx24UserViaPostMessage();
    if (u.id) {
      clog('Identity via postMessage: id=' + u.id);
      return u;
    }
  } catch(e) {
    clog('postMessage failed: ' + e.message);
  }

  // Try URL params
  const urlId = getBx24UserIdFromUrl();
  if (urlId) {
    clog('Identity via URL param: id=' + urlId);
    return { id: urlId, email: null, name: '' };
  }

  throw new Error('Cannot identify BX24 user — all three methods failed.');
}

let micStream = null;

async function requestMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micGranted = true;
    clog('Mic permission granted');
  } catch (e) {
    micGranted = false;
    clog('Mic DENIED: ' + e.message);
    setStatus('\u26A0\uFE0F Allow microphone and reload.');
    const w = document.getElementById('micWarning');
    if (w) w.style.display = 'block';
  }
}

function showIncoming(from) {
  callDirection = 'inbound';
  const el = document.getElementById('callerNum');
  if (el) el.textContent = from || 'Unknown';
  document.getElementById('incomingPanel').style.display = 'block';
  document.getElementById('activePanel').style.display   = 'none';
  document.getElementById('dialerPanel').style.display   = 'none';
  document.getElementById('hangupBtn').style.display     = 'none';
  document.getElementById('callBtn').style.display       = 'none';
  clog('showIncoming: ' + from);
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
  clog('showActive: ' + num);
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
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Build the correct /token URL ──────────────────────────────────────────────
// Priority: email > bx24_user_id
function buildTokenUrl(email, bx24UserId) {
  if (email) return '/token?user_id=' + encodeURIComponent(email);
  if (bx24UserId) return '/token?bx24_user_id=' + encodeURIComponent(bx24UserId);
  throw new Error('No email or bx24_user_id to build token URL');
}

// ── Main init ─────────────────────────────────────────────────────────────────
async function init() {
  sdkReady  = false;
  webPhone  = null;
  setReg('connecting');
  setStatus('Identifying user...');

  // ── Step 1: Identify user ──────────────────────────────────────────────────
  let identity;
  try {
    identity = await resolveBx24Identity();
  } catch(e) {
    setReg('failed');
    setStatus('\u26A0\uFE0F Could not identify user. Open from a CRM contact.');
    clog('Identity resolution failed: ' + e.message);
    scheduleRetry();
    return;
  }

  currentBx24UserId = identity.id   || null;
  currentUserEmail  = identity.email || null;

  const greet = identity.name ? ('Hello ' + identity.name.split(' ')[0] + '! ') : '';
  setStatus(greet + 'Requesting microphone...');

  // ── Step 2: Microphone ────────────────────────────────────────────────────
  await requestMic();
  if (!micGranted) { scheduleRetry(); return; }

  // ── Step 3: Fetch token / credentials ────────────────────────────────────
  setStatus('Fetching credentials...');
  let tokenData;
  try {
    const tokenUrl = buildTokenUrl(currentUserEmail, currentBx24UserId);
    clog('Fetching token: ' + tokenUrl);
    const res = await fetch(tokenUrl);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('Token HTTP ' + res.status + ': ' + errText.slice(0, 200));
    }
    tokenData = await res.json();
    if (tokenData.error) throw new Error(tokenData.error);
    // Back-fill email from token response if we only had a BX24 user ID
    if (!currentUserEmail && tokenData.email) currentUserEmail = tokenData.email;
    clog('Token OK — app_user_id=' + tokenData.app_user_id + ' sip_id=' + tokenData.sip_id);
  } catch(e) {
    setReg('failed');
    setStatus('Credentials failed: ' + e.message);
    clog('Token error: ' + e.message);
    scheduleRetry();
    return;
  }

  const accessToken = tokenData.access_token || tokenData.app_token;
  const appUserId   = tokenData.app_user_id  || tokenData.user_id;
  if (!accessToken || !appUserId) {
    setReg('failed');
    setStatus('Invalid token response — missing access_token or app_user_id');
    clog('Bad token response: ' + JSON.stringify(tokenData));
    scheduleRetry();
    return;
  }

  // ── Step 4: Initialize ExotelCRMWebSDK ────────────────────────────────────
  setStatus('Connecting softphone...');
  try {
    if (typeof ExotelCRMWebSDK === 'undefined') {
      throw new Error('ExotelCRMWebSDK not loaded — check /target/crmBundle.js');
    }

    const crmWebSDK = new ExotelCRMWebSDK(accessToken, appUserId, true);

    // Safety timeout: if regEvent never fires in 15s, consider it registered anyway
    const regTimeout = setTimeout(() => {
      if (!sdkReady) {
        clog('regEvent timeout — assuming registered (SDK may be silent)');
        sdkReady = true;
        setReg('registered');
        setStatus('\u2705 Ready');
        startPoll();
      }
    }, 15000);

    webPhone = await crmWebSDK.Initialize(
      handleCallEvent,
      function(event) {
        clog('regEvent: ' + JSON.stringify(event));
        clearTimeout(regTimeout);
        if (!sdkReady) {
          sdkReady = true;
          setReg('registered');
          setStatus('\u2705 Ready');
          clog('SIP registered \u2705 as ' + appUserId);
          startPoll();
        }
      }
    );

    // Release the mic stream we used for permission — SDK manages its own
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }

    clog('Initialize resolved. webPhone type=' + (webPhone ? typeof webPhone : 'null'));

    // Some SDK versions resolve the promise without firing regEvent
    if (webPhone && !sdkReady) {
      clearTimeout(regTimeout);
      sdkReady = true;
      setReg('registered');
      setStatus('\u2705 Ready');
      startPoll();
    }

    // Reset retry counter on success
    initRetries = 0;

  } catch (err) {
    setReg('failed');
    setStatus('Softphone error: ' + err.message);
    clog('SDK init FAILED: ' + err.message);
    scheduleRetry();
  }
}

// ── Retry logic: exponential backoff (5s, 10s, 20s, then 30s cap) ────────────
let retryTimer = null;
function scheduleRetry() {
  if (retryTimer) return;
  initRetries++;
  if (initRetries > MAX_RETRIES) {
    setReg('failed');
    setStatus('\u274C Connection failed after ' + MAX_RETRIES + ' retries. Reload the page.');
    clog('Max retries reached (' + MAX_RETRIES + ')');
    return;
  }
  const delay = Math.min(5000 * Math.pow(2, initRetries - 1), 30000);
  clog('Retrying in ' + (delay/1000) + 's (attempt ' + initRetries + '/' + MAX_RETRIES + ')');
  setStatus('Reconnecting in ' + Math.round(delay/1000) + 's... (attempt ' + initRetries + '/' + MAX_RETRIES + ')');
  retryTimer = setTimeout(() => { retryTimer = null; init(); }, delay);
}

// ── Polling for BX24 click-to-call ───────────────────────────────────────────
let pollTimer = null;
let pollCount = 0;
function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(doPoll, 2000);
}
async function doPoll() {
  if (!currentUserEmail && !currentBx24UserId) return;
  try {
    let pollUrl;
    if (currentUserEmail) {
      pollUrl = '/pending-call?email=' + encodeURIComponent(currentUserEmail);
    } else {
      pollUrl = '/pending-call?bx24_user_id=' + encodeURIComponent(currentBx24UserId);
    }
    const res  = await fetch(pollUrl);
    const data = await res.json();
    pollCount++;
    if (pollCount % 30 === 1) clog('poll #' + pollCount + ' email=' + currentUserEmail + ' bx24Id=' + currentBx24UserId);
    if (data.pending && data.number) {
      clog('BX24 click-to-call: ' + data.number);
      callDirection = 'outbound';
      const phoneEl = document.getElementById('phone');
      if (phoneEl) phoneEl.value = data.number;
      setStatus('Calling ' + data.number + '...');
      await triggerOutboundCall(data.number);
    }
  } catch (e) { /* silent */ }
}

async function triggerOutboundCall(number) {
  if (!webPhone) { setStatus('SDK not ready'); clog('webPhone is null!'); return; }
  callDirection = 'outbound';
  clog('MakeCall \u2192 ' + number);
  try { await webPhone.MakeCall(number, null, null); }
  catch (e) { clog('MakeCall error: ' + e.message); }
}

function handleCallEvent(event) {
  clog('callEvent: ' + JSON.stringify(event));
  const evtType = ((event && event.event) || (event && event.type) || (event && event.EventType) || '').toLowerCase();
  const evtStr  = JSON.stringify(event).toLowerCase();
  clog('evtType=' + evtType + ' direction=' + callDirection);

  if (evtType.includes('incoming') || evtType.includes('ringing') || evtStr.includes('incoming') || evtStr.includes('ringing')) {
    if (callDirection === 'outbound') {
      clog('Outbound SIP leg incoming \u2192 silent AcceptCall');
      silentAcceptOutbound();
    } else {
      const from = (event && (event.from || event.FromNumber || event.callerNumber || event.CallFrom)) || 'Unknown';
      showIncoming(from);
      setStatus('');
    }
  } else if (evtType.includes('connect') || evtType.includes('answer') || evtType.includes('accept') || evtType.includes('active') || evtStr.includes('call_answered') || evtStr.includes('connected')) {
    const num = callDirection === 'inbound'
      ? (document.getElementById('callerNum')?.textContent || '')
      : (document.getElementById('phone')?.value || '');
    showActive(num);
    setStatus('');
  } else if (evtType.includes('end') || evtType.includes('complet') || evtType.includes('bye') || evtType.includes('terminal') || evtStr.includes('callended') || evtStr.includes('call_completed') || evtStr.includes('disconnect')) {
    showDialer();
    setStatus('Call ended');
  }
}

async function silentAcceptOutbound() {
  if (!webPhone) return;
  try { await webPhone.AcceptCall(); clog('silentAccept OK'); }
  catch (e) { clog('silentAccept error: ' + e.message); }
  const num = document.getElementById('phone')?.value || '';
  showActive(num);
}

async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number)    { setStatus('Enter a number'); return; }
  if (!webPhone)  { setStatus('SDK not ready'); return; }
  if (!micGranted){ setStatus('\u26A0\uFE0F Allow microphone first!'); return; }
  document.getElementById('callBtn').disabled = true;
  await triggerOutboundCall(number);
  document.getElementById('callBtn').disabled = false;
}

async function acceptCall() {
  if (!webPhone) { setStatus('SDK not ready'); return; }
  if (!micGranted) { await requestMic(); if (!micGranted) { setStatus('\u26A0\uFE0F Mic required'); return; } }
  clog('AcceptCall (inbound)');
  try {
    await webPhone.AcceptCall();
    showActive(document.getElementById('callerNum')?.textContent || '');
    setStatus('');
  } catch (err) {
    clog('AcceptCall error: ' + err.message);
    setStatus('Accept failed: ' + err.message);
  }
}

async function rejectCall() {
  if (!webPhone) return;
  clog('RejectCall');
  try { await webPhone.HangupCall(); } catch (e) { clog('Reject err: ' + e.message); }
  showDialer();
  setStatus('Call rejected');
}

async function hangUp() {
  if (!webPhone) return;
  clog('HangupCall');
  try { await webPhone.HangupCall(); } catch (e) { clog('Hangup err: ' + e.message); }
  showDialer();
  setStatus('Call ended');
}

window.onload = init;
