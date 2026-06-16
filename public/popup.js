// ═══════════════════════════════════════════════════════════════
// popup.js — Exotel Dialer inside Bitrix24
// ═══════════════════════════════════════════════════════════════

let webPhone   = null;
let sdkReady   = false;
let timerInterval = null;
let timerSec   = 0;
let callDirection = null; // 'inbound' | 'outbound' | null
let micGranted = false;

const EXOTEL_APP_USER_ID = '123';
const BX24_USER_ID = '44';

function log(msg) { console.log('[Dialer]', msg); }
function clog(msg, extra) {
  fetch('/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'popup.js', message: msg, extra: extra || null, ts: Date.now() })
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
    failed:     { cls: 'red',    label: '🔴 Registration failed' }
  };
  const s = map[state] || { cls: '', label: state };
  if (dot) dot.className = 'dot ' + s.cls;
  if (txt) txt.textContent = s.label;
}

// ── Request mic permission EARLY ─────────────────────────────
async function requestMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop()); // release — just checking permission
    micGranted = true;
    clog('Mic permission granted');
    log('✅ Mic granted');
  } catch (e) {
    micGranted = false;
    clog('Mic permission DENIED: ' + e.message);
    setStatus('⚠️ Microphone access denied! Allow mic and reload.');
    log('❌ Mic denied: ' + e.message);
  }
}

// ── UI states ─────────────────────────────────────────────────

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
    const m = String(Math.floor(timerSec / 60)).padStart(2, '0');
    const s = String(timerSec % 60).padStart(2, '0');
    const el = document.getElementById('timerEl');
    if (el) el.textContent = m + ':' + s;
  }, 1000);
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  setReg('connecting');
  setStatus('Requesting microphone...');

  // STEP 1: Request mic first — before anything else
  await requestMic();

  if (!micGranted) return; // stop here if mic denied

  setStatus('Fetching credentials...');

  try {
    const res = await fetch('/token?user_id=' + encodeURIComponent(EXOTEL_APP_USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    clog('Token response', JSON.stringify(data));

    const accessToken = data.access_token || data.app_token;
    const appUserId   = data.app_user_id  || data.user_id || EXOTEL_APP_USER_ID;
    if (!accessToken) throw new Error('No access_token in /token response: ' + JSON.stringify(data));

    clog('Credentials: access_token=<hidden> app_user_id=' + appUserId);
    setStatus('Initializing SDK...');

    if (typeof ExotelCRMWebSDK === 'undefined') throw new Error('ExotelCRMWebSDK not loaded');
    clog('ExotelCRMWebSDK class loaded');

    const sdk = new ExotelCRMWebSDK(accessToken, appUserId, false);
    const result = await sdk.Initialize(
      function callListener(event) {
        clog('Call event: ' + JSON.stringify(event));
        handleCallEvent(event);
      },
      function regListener(event) {
        clog('regListener fired: ' + JSON.stringify(event));
        if (!sdkReady) {
          sdkReady = true;
          setReg('registered');
          setStatus('✅ Ready');
          clog('SIP registration SUCCESS');
          startPoll();
        }
      }
    );

    // SDK may return webPhone directly (some versions don't use the return value)
    if (result && typeof result === 'object') {
      webPhone = result;
      clog('Initialize returned webPhone directly — marking sdkReady=true');
      sdkReady = true;
      setReg('registered');
      setStatus('✅ Ready');
      clog('SDK.Initialize() resolved — webPhone=object');
      startPoll();
    }

  } catch (err) {
    setReg('failed');
    setStatus('Error: ' + err.message);
    clog('SDK init FAILED: ' + err.message);
    console.error('[Dialer] Init error:', err);
  }
}

// ── Poll for pending outbound calls from BX24 click-to-call ───
let pollCount = 0;
let pollTimer = null;

function startPoll() {
  if (pollTimer) return;
  clog('Starting poll for pending calls');
  pollTimer = setInterval(doPoll, 2000);
}

async function doPoll() {
  try {
    const res  = await fetch('/pending-call');
    const data = await res.json();
    pollCount++;
    if (pollCount % 20 === 1) clog('/pending-call hit #' + pollCount);

    if (data.pending && data.number) {
      clog('BX24 outbound pending: ' + data.number);
      callDirection = 'outbound';
      const phoneEl = document.getElementById('phone');
      if (phoneEl) phoneEl.value = data.number;
      setStatus('Calling ' + data.number + '...');
      await triggerOutboundCall(data.number);
    }
  } catch (e) {
    // silent
  }
}

// ── Trigger outbound call (both manual + click-to-call) ───────
async function triggerOutboundCall(number) {
  if (!webPhone) { setStatus('SDK not ready'); clog('triggerOutboundCall: webPhone null'); return; }
  callDirection = 'outbound';
  clog('MakeCall → ' + number);
  try {
    webPhone.MakeCall(number);
  } catch (e) {
    clog('MakeCall threw (likely OK): ' + e.message);
  }
  // NOTE: Do NOT call showActive() here.
  // Wait for SDK "incoming" event — then silently AcceptCall() to open mic.
  // showActive() is called after AcceptCall resolves.
}

// ── Call event handler ────────────────────────────────────────
function handleCallEvent(event) {
  const raw = JSON.stringify(event).toLowerCase();
  clog('handleCallEvent raw=' + raw);

  if (raw.includes('incoming') || raw.includes('ringing')) {
    if (callDirection === 'outbound') {
      // Outbound: SDK fires "incoming" on our own SIP leg — silently accept to open mic
      clog('Outbound SIP leg — auto-accepting to open mic');
      silentAcceptOutbound();
    } else {
      // Genuine inbound call
      const from = (event && (event.FromNumber || event.from || event.callerNumber)) || 'Unknown';
      showIncoming(from);
      setStatus('');
    }

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active')) {
    const num = callDirection === 'inbound'
      ? (document.getElementById('callerNum').textContent || '')
      : (document.getElementById('phone').value || '');
    showActive(num);
    setStatus('');

  } else if (
    raw.includes('end') || raw.includes('disconnect') || raw.includes('bye') ||
    raw.includes('terminal') || raw.includes('callended')
  ) {
    showDialer();
    setStatus('Call ended');
  }
}

// Silently accept the outbound SIP leg (opens mic without showing Accept UI)
async function silentAcceptOutbound() {
  if (!webPhone) return;
  try {
    clog('silentAcceptOutbound: calling AcceptCall');
    await webPhone.AcceptCall();
    clog('silentAcceptOutbound: AcceptCall OK → showActive');
    const num = document.getElementById('phone').value || '';
    showActive(num);
  } catch (e) {
    clog('silentAcceptOutbound error: ' + e.message);
    // Still show active — call may have connected
    const num = document.getElementById('phone').value || '';
    showActive(num);
  }
}

// ── Manual Call button (typed number) ─────────────────────────
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number) { setStatus('Enter a number'); return; }
  if (!webPhone) { setStatus('SDK not ready'); return; }
  if (!micGranted) { setStatus('⚠️ Allow microphone first!'); return; }
  document.getElementById('callBtn').disabled = true;
  await triggerOutboundCall(number);
  document.getElementById('callBtn').disabled = false;
}

// ── Accept inbound call ───────────────────────────────────────
async function acceptCall() {
  if (!webPhone) { setStatus('SDK not ready'); return; }
  if (!micGranted) {
    // Try requesting mic again before accepting
    await requestMic();
    if (!micGranted) { setStatus('⚠️ Mic required to accept call'); return; }
  }
  clog('AcceptCall fired');
  try {
    await webPhone.AcceptCall();
    showActive(document.getElementById('callerNum').textContent);
    setStatus('');
  } catch (err) {
    clog('AcceptCall error: ' + err.message);
    setStatus('Accept failed: ' + err.message);
  }
}

// ── Reject inbound call ───────────────────────────────────────
async function rejectCall() {
  if (!webPhone) return;
  clog('RejectCall fired');
  try { await webPhone.HangupCall(); } catch (e) { clog('Reject err: ' + e.message); }
  showDialer();
  setStatus('Call rejected');
}

// ── Hang up active call ───────────────────────────────────────
async function hangUp() {
  if (!webPhone) return;
  clog('HangUp fired');
  try { await webPhone.HangupCall(); } catch (e) { clog('Hangup err: ' + e.message); }
  showDialer();
  setStatus('Call ended');
}

window.onload = init;
