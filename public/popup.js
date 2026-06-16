// ═══════════════════════════════════════════════════════════════
// popup.js — Exotel WebRTC Dialer inside Bitrix24 CRM_ACTIVITY_SIDEBAR
//
// Uses ExotelCRMWebSDK(accessToken, userId, autoConnect) — official constructor.
// Inbound calls come via Exotel webhook → /incoming-call → server stores → we poll /pending-inbound.
// ═══════════════════════════════════════════════════════════════

let webPhone      = null;
let sdkReady      = false;
let sdkInitDone   = false;
let queuedCall    = null;
let timerInterval = null;
let timerSec      = 0;
let pollInterval  = null;

const EXOTEL_APP_USER_ID = '123';  // Exotel AppUserId
const BX24_USER_ID       = '44';   // Bitrix24 user ID (Khushil)

// ── Logging ────────────────────────────────────────────────────
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
  setStatus('Calling ' + number + '...');
  try {
    webPhone.MakeCall(number);
    showActive(number);
  } catch (e) {
    log('MakeCall threw: ' + e.message + ' — retrying in 1s');
    setTimeout(() => {
      try {
        webPhone.MakeCall(number);
        showActive(number);
        log('MakeCall retry succeeded for ' + number);
      } catch (e2) {
        log('MakeCall retry also threw: ' + e2.message);
        setStatus('❌ Call failed — ' + e2.message);
      }
    }, 1000);
  }
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
function startPolling() {
  if (pollInterval) return;
  log('Starting poll for pending calls');
  pollInterval = setInterval(async () => {
    try {
      const outRes  = await fetch('/pending-call');
      const outData = await outRes.json();
      if (outData.pending && outData.number) {
        log('BX24 outbound pending: ' + outData.number);
        executeMakeCall(outData.number);
      }

      const inRes  = await fetch('/pending-inbound');
      const inData = await inRes.json();
      if (inData.pending && inData.from) {
        log('Inbound call from: ' + inData.from);
        showIncoming(inData.from);
      }
    } catch (e) { /* network hiccup */ }
  }, 1500);
}

// ── SDK Initialization ─────────────────────────────────────────
// Uses official constructor: new ExotelCRMWebSDK(accessToken, userId, autoConnect)
// Docs: https://github.com/exotel/exotel-voip-websdk-crm-sample-app
async function initSDK() {
  if (sdkInitDone) return;
  sdkInitDone = true;
  setReg('connecting');
  setStatus('Connecting...');

  try {
    // 1. Wait for crmBundle.js to define ExotelCRMWebSDK
    let wait = 0;
    while (typeof ExotelCRMWebSDK === 'undefined') {
      if (wait++ > 20) throw new Error('crmBundle.js did not load after 10s');
      await new Promise(r => setTimeout(r, 500));
    }
    log('ExotelCRMWebSDK class loaded');

    // 2. Fetch credentials from our server
    const res = await fetch('/token?user_id=' + encodeURIComponent(EXOTEL_APP_USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();

    if (!data.access_token) throw new Error('No access_token in /token response: ' + JSON.stringify(data));
    if (!data.app_user_id)  throw new Error('No app_user_id in /token response: '  + JSON.stringify(data));

    log('Credentials: access_token=<hidden> app_user_id=' + data.app_user_id);

    // 3. Instantiate with official constructor signature:
    //    new ExotelCRMWebSDK(accessToken, userId, autoConnectVOIP)
    //    accessToken: JWT from /v2/accounts/{sid}/configuration/basicauth
    //    userId:      Exotel AppUserId (e.g. "123")
    //    autoConnect: true → SDK calls DoRegister automatically
    const sdk = new ExotelCRMWebSDK(data.access_token, data.app_user_id, true);

    // 4. Initialize — returns Promise<ExotelWebPhoneSDK>
    webPhone = await sdk.Initialize(
      // callListener — inbound/outbound call state changes
      function callListener(event) {
        handleCallEvent(event);
      },

      // regListener — SIP registration result
      function regListener(event) {
        const evStr = JSON.stringify(event);
        log('regListener fired: ' + evStr.slice(0, 200));
        const evLow = evStr.toLowerCase();
        if (evLow.includes('fail') || evLow.includes('error') ||
            evLow.includes('403')  || evLow.includes('401')   ||
            evLow.includes('reject')) {
          log('SIP registration FAILED: ' + evStr);
          setReg('failed');
          setStatus('❌ SIP registration failed — check credentials/domain');
          return;
        }
        log('SIP registration SUCCESS');
        sdkReady = true;
        setReg('registered');
        setStatus('✅ Ready');

        if (queuedCall) {
          const n = queuedCall;
          queuedCall = null;
          log('Draining queued call → ' + n);
          setTimeout(() => executeMakeCall(n), 300);
        }
      },

      // sessionListener
      function sessionListener(event) {
        log('Session event: ' + JSON.stringify(event).slice(0, 80));
      }
    );

    log('SDK.Initialize() resolved — webPhone=' + (webPhone ? 'object' : String(webPhone)));

    if (webPhone && !sdkReady) {
      log('Initialize returned webPhone directly — marking sdkReady=true');
      sdkReady = true;
      setReg('registered');
      setStatus('✅ Ready');
      if (queuedCall) {
        const n = queuedCall;
        queuedCall = null;
        log('Draining queued call (post-init) → ' + n);
        setTimeout(() => executeMakeCall(n), 300);
      }
    }

    // 15s guard — if regListener never fires
    setTimeout(() => {
      if (!sdkReady) {
        log('⚠️ regListener never fired after 15s — check access_token or Exotel app config');
        setReg('failed');
        setStatus('❌ SIP timed out — verify access_token and Exotel app user');
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
