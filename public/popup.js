// ═══════════════════════════════════════════════════════════════
// popup.js — Exotel WebRTC Dialer inside Bitrix24 CRM_ACTIVITY_SIDEBAR
//
// The SDK (ExotelCRMWebSDK) registers SIP directly from this visible
// iframe so microphone permission works. No background worker needed.
// MakeCall() fires directly here for outbound. Inbound calls come via
// Exotel webhook → /incoming-call → server stores → we poll /pending-inbound.
// ═══════════════════════════════════════════════════════════════

let webPhone      = null;
let sdkReady      = false;
let sdkInitDone   = false;   // guard: only init once per page load
let queuedCall    = null;    // outbound queued before SDK was ready
let timerInterval = null;
let timerSec      = 0;
let pollInterval  = null;

const EXOTEL_APP_USER_ID = '123';  // Exotel AppUserId — NOT Bitrix24 user ID
const BX24_USER_ID       = '44';   // Bitrix24 user ID (Khushil)

// ── Logging (mirrored to Render via /client-log) ───────────────
function log(msg, extra) {
  console.log('[Dialer]', msg, extra !== undefined ? extra : '');
  fetch('/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'popup.js', message: String(msg), extra: extra || null, ts: Date.now() })
  }).catch(() => {});
}

function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function setReg(state) {
  const dot = document.getElementById('regDot');
  const txt = document.getElementById('regText');
  const map = {
    connecting: { cls: 'yellow', label: 'Connecting...' },
    registered: { cls: 'green',  label: '🟢 Ready' },
    failed:     { cls: 'red',    label: '🔴 Registration failed — refresh to retry' }
  };
  const s = map[state] || { cls: '', label: state };
  if (dot) dot.className = 'dot ' + s.cls;
  if (txt) txt.textContent = s.label;
}

// ── UI state helpers ───────────────────────────────────────────
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
    const el = document.getElementById('timerEl');
    if (el) el.textContent = m + ':' + s;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── SDK call event handler ─────────────────────────────────────
function handleCallEvent(event) {
  const raw = JSON.stringify(event).toLowerCase();
  log('Call event: ' + raw.slice(0, 150));

  if (raw.includes('i_new_call') || raw.includes('incoming') || raw.includes('ringing')) {
    const from = (event && (event.callFromNumber || event.FromNumber || event.from)) || 'Unknown';
    showIncoming(from);
    setStatus('');

  } else if (raw.includes('accept') || raw.includes('connected') || raw.includes('active')) {
    const num = document.getElementById('callerNum').textContent ||
                document.getElementById('phone').value || '';
    showActive(num);
    setStatus('');

  } else if (raw.includes('terminated') || raw.includes('disconnect') ||
             raw.includes('end') || raw.includes('bye') || raw.includes('hangup')) {
    showDialer();
    setStatus('Call ended');
  }
}

// ── Make outbound call ─────────────────────────────────────────
function executeMakeCall(number) {
  if (!sdkReady || !webPhone) {
    log('SDK not ready — queuing call to ' + number);
    queuedCall = number;
    setStatus('Connecting... will call ' + number + ' once ready');
    return;
  }
  log('MakeCall → ' + number);
  try {
    webPhone.MakeCall(number);
  } catch (e) {
    // SDK throws internally but call still goes through
    log('MakeCall internal (expected): ' + e.message);
  }
  showActive(number);
}

async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number) { setStatus('Enter a number'); return; }
  setStatus('Calling ' + number + '...');
  executeMakeCall(number);
}

// ── Accept / Reject / Hang up ──────────────────────────────────
async function acceptCall() {
  if (!webPhone) { setStatus('SDK not ready'); return; }
  try {
    webPhone.AcceptCall();
    log('AcceptCall fired');
  } catch (e) { log('AcceptCall error: ' + e.message); }
  showActive(document.getElementById('callerNum').textContent);
  setStatus('');
}

async function rejectCall() {
  if (webPhone) {
    try { webPhone.HangupCall(); } catch (e) { log('Reject: ' + e.message); }
  }
  showDialer();
  setStatus('Call rejected');
}

async function hangUp() {
  if (webPhone) {
    try { webPhone.HangupCall(); } catch (e) { log('Hangup: ' + e.message); }
  }
  showDialer();
  setStatus('Call ended');
}

// ── Poll for BX24-originated outbound + inbound calls ──────────
// Outbound: agent clicks phone number in CRM → BX24 fires OnExternalCallStart
//           → our server stores it → we pick it up here and MakeCall()
// Inbound:  Exotel hits /incoming-call → server stores → we show ringing UI
function startPolling() {
  if (pollInterval) return;
  log('Starting poll for pending calls');
  pollInterval = setInterval(async () => {
    try {
      // Check for BX24-originated outbound call
      const outRes  = await fetch('/pending-call');
      const outData = await outRes.json();
      if (outData.pending && outData.number) {
        log('BX24 outbound pending: ' + outData.number);
        executeMakeCall(outData.number);
      }

      // Check for inbound call from Exotel
      const inRes  = await fetch('/pending-inbound');
      const inData = await inRes.json();
      if (inData.pending && inData.from) {
        log('Inbound call from: ' + inData.from);
        showIncoming(inData.from);
      }
    } catch (e) { /* network hiccup, ignore */ }
  }, 1500);
}

// ── SDK Initialization ─────────────────────────────────────────
async function initSDK() {
  if (sdkInitDone) return;
  sdkInitDone = true;
  setReg('connecting');
  setStatus('Connecting...');

  try {
    // 1. Wait for crmBundle.js
    let wait = 0;
    while (typeof ExotelCRMWebSDK === 'undefined') {
      if (wait++ > 20) throw new Error('crmBundle.js did not load after 10s');
      await new Promise(r => setTimeout(r, 500));
    }
    log('ExotelCRMWebSDK class loaded');

    // 2. Fetch credentials
    const res = await fetch('/token?user_id=' + encodeURIComponent(EXOTEL_APP_USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();

    if (!data.app_token) throw new Error('No app_token: ' + JSON.stringify(data));
    if (!data.sip_id)    throw new Error('No sip_id: '    + JSON.stringify(data));
    if (!data.sip_secret) throw new Error('No sip_secret: ' + JSON.stringify(data));

    log('Credentials: sip_id=' + data.sip_id);

    // 3. Build sipAccountInfo — THIS IS THE FIX
    // sipdomain must match exactly what Exotel API returns (voip.in1.exotel.com)
    const sipAccountInfo = {
      userName:   data.sip_id,        // e.g. "exo_usr_xxxx"
      password:   data.sip_secret,    // SIP secret from usermapping
      sipdomain:  'voip.in1.exotel.com', // your MUM1 cluster domain
      port:       '5061',             // TLS SIP port (use '5060' if TCP)
      displayName: data.sip_id,
      // If the SDK requires app_token separately, add:
      appToken:   data.app_token
    };

    log('sipAccountInfo built — sipdomain: ' + sipAccountInfo.sipdomain);

    // 4. Instantiate with NO arguments (constructor ignores them)
    const sdk = new ExotelCRMWebSDK();

    // 5. Initialize with the ACTUAL sipAccountInfo + all 3 callbacks
    webPhone = await sdk.Initialize(
      sipAccountInfo,

      // callListener
      function callListener(event) {
        handleCallEvent(event);
      },

      // regListener — SIP registration result
      function regListener(event) {
        log('regListener fired: ' + JSON.stringify(event).slice(0, 120));
        const evStr = JSON.stringify(event).toLowerCase();
        if (evStr.includes('fail') || evStr.includes('error') || evStr.includes('403') || evStr.includes('401')) {
          log('SIP registration FAILED: ' + JSON.stringify(event));
          setReg('failed');
          setStatus('❌ SIP registration failed — check credentials');
          return;
        }
        sdkReady = true;
        setReg('registered');
        setStatus('✅ Ready');

        // Drain queued call
        if (queuedCall) {
          const n = queuedCall;
          queuedCall = null;
          log('Draining queued call: ' + n);
          setTimeout(() => executeMakeCall(n), 300);
        }
      },

      // sessionListener (optional but required by SDK signature)
      function sessionListener(event) {
        log('Session event: ' + JSON.stringify(event).slice(0, 80));
      }
    );

    log('SDK.Initialize() awaited — waiting for regListener...');
    // Timeout guard — if regListener doesn't fire in 15s, surface the failure
setTimeout(() => {
  if (!sdkReady) {
    log('⚠️ regListener never fired after 15s — SIP registration hung');
    setReg('failed');
    setStatus('❌ SIP registration timed out — check sipdomain/port/credentials');
  }
}, 15000);
    startPolling();
  } catch (err) {
    log('SDK init FAILED: ' + err.message);
    setReg('failed');
    setStatus('❌ ' + err.message);
  }
}

window.onload = initSDK;
