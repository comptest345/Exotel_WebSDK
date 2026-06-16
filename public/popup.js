// ═══════════════════════════════════════════════════════════════
// popup.js — Owns the ONLY SDK instance (single SIP registration).
//
// This loads inside CRM_ACTIVITY_SIDEBAR — a VISIBLE iframe open
// while the agent works a lead/contact/deal — so getUserMedia()
// (microphone) actually has a normal permission context, unlike a
// hidden PAGE_BACKGROUND_WORKER page.
//
// Outbound calls from typing a number in this UI, or from clicking
// a phone number elsewhere in BX24 (which fires OnExternalCallStart
// -> our server webhook -> /pending-call), both result in a direct
// local webPhone.MakeCall() call — no relay through another page.
// ═══════════════════════════════════════════════════════════════

let webPhone      = null;
let sdkReady      = false;
let queuedCall    = null;       // a call that arrived before the SDK was ready
let currentUIState = 'idle';    // tracks last rendered state to avoid flicker
let timerInterval = null;
let timerSec      = 0;
let pollInterval  = null;

// FIX: Track whether we've already started SDK initialization so we never
// call new ExotelCRMWebSDK() more than once per page session. A second call
// with the same SIP user hits the SDK's internal dedup map and is silently
// rejected — sdkReady never becomes true and the queued call hangs forever.
let sdkInitStarted = false;
let regHeartbeat   = null;  // setInterval handle for "still waiting" log

const EXOTEL_APP_USER_ID = '123';

// ── Logging — also mirrored to the server so Render logs show what's happening ──
function log(msg, extra) {
  console.log('[Dialer]', msg, extra || '');
  fetch('/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'popup.js', message: msg, extra: extra || null, ts: Date.now() })
  }).catch(() => {});
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }

function setReg(state) {
  const dot = document.getElementById('regDot');
  const txt = document.getElementById('regText');
  const map = {
    connecting: { cls: 'yellow', label: 'Connecting...' },
    registered: { cls: 'green',  label: '🟢 Ready' },
    failed:     { cls: 'red',    label: '🔴 Registration failed — please refresh' }
  };
  const s = map[state] || { cls: '', label: state };
  dot.className = 'dot ' + s.cls;
  txt.textContent = s.label;
}

function showIncoming(from) {
  document.getElementById('callerNum').textContent       = from || 'Unknown';
  document.getElementById('incomingPanel').style.display = 'block';
  document.getElementById('activePanel').style.display   = 'none';
  document.getElementById('dialerPanel').style.display   = 'block';
  document.getElementById('hangupBtn').style.display     = 'none';
  document.getElementById('callBtn').style.display       = 'block';
  try { new Audio('/target/ringtone.wav').play(); } catch (e) {}
}

function showActive(num) {
  document.getElementById('activeNum').textContent       = num || '';
  document.getElementById('incomingPanel').style.display = 'none';
  document.getElementById('activePanel').style.display   = 'block';
  document.getElementById('dialerPanel').style.display   = 'block';
  document.getElementById('hangupBtn').style.display     = 'block';
  document.getElementById('callBtn').style.display       = 'none';
  startTimer();
}

function showDialer() {
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
    const m = String(Math.floor(timerSec / 60)).padStart(2, '0');
    const s = String(timerSec % 60).padStart(2, '0');
    document.getElementById('timerEl').textContent = m + ':' + s;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Mirror state to server (for logging / so /call-state stays accurate) ──
function postState(state) {
  fetch('/update-call-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  }).catch(() => {});
}

// ── Place an outbound call — directly via the local SDK instance ──
function executeMakeCall(number) {
  if (sdkReady && webPhone) {
    log('MakeCall firing for ' + number);
    try {
      webPhone.MakeCall(number);
      log('MakeCall returned without throwing for ' + number);
    } catch (e) {
      log('MakeCall THREW: ' + e.message, { stack: e.stack });
    }
    showActive(number);
    currentUIState = 'active';
    postState({ state: 'active', number });
  } else {
    log('SDK not ready yet — queuing call to ' + number, { sdkReady, webPhoneExists: !!webPhone });
    queuedCall = number;
    setStatus('Connecting... will call ' + number + ' once ready');
  }
}

// ── Outbound call from the dialer's own input box ──
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number) { setStatus('Enter a number'); return; }
  setStatus('Calling ' + number + '...');
  executeMakeCall(number);
}

// ── Accept incoming call — direct local SDK call ──
async function acceptCall() {
  if (sdkReady && webPhone) {
    try { webPhone.AcceptCall(); log('AcceptCall fired'); }
    catch (e) { log('AcceptCall threw: ' + e.message); }
  } else {
    log('AcceptCall skipped — SDK not ready', { sdkReady, webPhoneExists: !!webPhone });
  }
  showActive(document.getElementById('callerNum').textContent);
  currentUIState = 'active';
  postState({ state: 'active' });
  setStatus('');
}

// ── Reject incoming call ──
async function rejectCall() {
  if (webPhone) {
    try { webPhone.HangupCall(); log('HangupCall (reject) fired'); }
    catch (e) { log('HangupCall (reject) threw: ' + e.message); }
  }
  showDialer();
  currentUIState = 'idle';
  setStatus('Call rejected');
  postState({ state: 'idle', from: '', number: '' });
}

// ── Hang up an active call ──
async function hangUp() {
  if (webPhone) {
    try { webPhone.HangupCall(); log('HangupCall fired'); }
    catch (e) { log('HangupCall threw: ' + e.message); }
  }
  showDialer();
  currentUIState = 'idle';
  setStatus('Call ended');
  postState({ state: 'idle', from: '', number: '' });
}

// ── Handle SDK call events (i_new_call, accept_reject, connected, terminated) ──
function handleSDKCallEvent(event) {
  const raw = JSON.stringify(event).toLowerCase();
  log('SDK event: ' + raw.slice(0, 200));

  if (raw.includes('incoming') || raw.includes('ringing') || raw.includes('i_new_call')) {
    const from = (event && (event.callFromNumber || event.FromNumber || event.from)) || 'Unknown';
    if (currentUIState !== 'incoming') { showIncoming(from); currentUIState = 'incoming'; }
    postState({ state: 'incoming', from });

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active') || raw.includes('connected')) {
    if (currentUIState !== 'active') {
      showActive(document.getElementById('callerNum').textContent || '');
      currentUIState = 'active';
    }
    postState({ state: 'active' });

  } else if (raw.includes('end') || raw.includes('disconnect') || raw.includes('terminal') || raw.includes('bye') || raw.includes('terminated')) {
    showDialer();
    currentUIState = 'idle';
    postState({ state: 'idle', from: '', number: '' });
  }
}

// ── Poll for BX24-initiated outbound calls (agent clicked a phone number in CRM) ──
// This is the one thing that genuinely has to go through the server, since the
// OnExternalCallStart event fires to a server webhook, not to this page directly.
function startPollingPendingCall() {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    try {
      const res = await fetch('/pending-call');
      const data = await res.json();
      if (data.pending && data.number) {
        log('BX24 outbound pending: ' + data.number);
        executeMakeCall(data.number);
      }
    } catch (e) { /* network hiccup, ignore and retry next tick */ }
  }, 1000);
}

// ── SDK init — ONE attempt per page session. No retry with a fresh instance.
// Retrying with new ExotelCRMWebSDK() poisons the SDK's internal dedup map:
// the second call for the same SIP user is silently rejected ([Dup-Reg]) and
// regListener never fires. If init fails, show a clear error and let the user
// refresh the page (which gives a genuinely clean JS context).
async function initSDK() {
  // FIX: Guard — never run more than once per page load.
  if (sdkInitStarted) {
    log('initSDK called again — ignoring (already started)');
    return;
  }
  sdkInitStarted = true;

  setReg('connecting');
  setStatus('Connecting...');

  try {
    // Wait for crmBundle.js to define ExotelCRMWebSDK (it's a script tag load,
    // not a module import, so it may not be ready at DOMContentLoaded time).
    // We poll briefly here rather than looping and creating fresh SDK instances.
    let attempts = 0;
    while (typeof ExotelCRMWebSDK === 'undefined') {
      if (attempts++ > 20) throw new Error('ExotelCRMWebSDK not defined after 10s — crmBundle.js failed to load');
      await new Promise(r => setTimeout(r, 500));
    }

    const res = await fetch('/token?user_id=' + encodeURIComponent(EXOTEL_APP_USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    if (!data.app_token) throw new Error('No app_token in response: ' + JSON.stringify(data));

    log('Token fetched, initializing SDK — single attempt...');

    // FIX: Start a heartbeat so Render logs show "still waiting" every 5s
    // instead of silence, making a stuck registration immediately visible.
    let regWaitSec = 0;
    regHeartbeat = setInterval(() => {
      regWaitSec += 5;
      log('Still waiting for SIP registration... ' + regWaitSec + 's elapsed');
    }, 5000);

    const sdk = new ExotelCRMWebSDK(data.app_token, EXOTEL_APP_USER_ID, false);
    webPhone = await sdk.Initialize(
      function callListener(event) {
        handleSDKCallEvent(event);
      },
      function regListener(event) {
        // FIX: Stop the "still waiting" heartbeat the moment registration lands.
        if (regHeartbeat) { clearInterval(regHeartbeat); regHeartbeat = null; }
        log('SIP REGISTERED — SDK is now ready');
        sdkReady = true;
        setReg('registered');
        setStatus('✅ Ready');
        if (queuedCall) {
          const n = queuedCall;
          queuedCall = null;
          log('Executing queued call now that SDK is ready: ' + n);
          executeMakeCall(n);
        }
      }
    );

    log('SDK object created (waiting for SIP registration callback)');
    // Do NOT loop or retry here. If regListener never fires, the heartbeat
    // above will make that visible in Render logs. The user should refresh.

  } catch (err) {
    // FIX: Stop heartbeat on hard error too.
    if (regHeartbeat) { clearInterval(regHeartbeat); regHeartbeat = null; }
    log('SDK init FAILED (will not retry — please refresh): ' + err.message, { stack: err.stack });
    setReg('failed');
    setStatus('❌ Registration failed — please refresh this page');
  }
}

function init() {
  startPollingPendingCall();
  initSDK();
}

window.onload = init;
