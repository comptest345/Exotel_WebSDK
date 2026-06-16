// ═══════════════════════════════════════════════════════════════
// popup.js — Visible dialer widget inside Bitrix24
// ═══════════════════════════════════════════════════════════════

let webPhone = null;
let timerInterval = null;
let timerSec = 0;
const EXOTEL_APP_USER_ID = '123'; // Exotel AppUserId (NOT Bitrix24 user ID)
const BX24_USER_ID = '44';        // Bitrix24 user ID

// callDirection: 'inbound' | 'outbound' | null
let callDirection = null;

function log(msg) { console.log('[Dialer]', msg); }
function setStatus(msg) { document.getElementById('status').textContent = msg; log(msg); }

function setReg(state) {
  const dot = document.getElementById('regDot');
  const txt = document.getElementById('regText');
  const map = {
    connecting: { cls: 'yellow', label: 'Connecting...' },
    registered:  { cls: 'green',  label: '🟢 Ready' },
    failed:      { cls: 'red',    label: '🔴 Registration failed' }
  };
  const s = map[state] || { cls: '', label: state };
  dot.className = 'dot ' + s.cls;
  txt.textContent = s.label;
}

// ── UI state helpers ───────────────────────────────────────────

// INBOUND ONLY: show Accept + Reject buttons, hide everything else
function showIncoming(from) {
  callDirection = 'inbound';
  document.getElementById('callerNum').textContent = from || 'Unknown';
  document.getElementById('incomingPanel').style.display = 'block';
  document.getElementById('activePanel').style.display   = 'none';
  document.getElementById('dialerPanel').style.display   = 'none'; // hide dialer while ringing
  document.getElementById('hangupBtn').style.display     = 'none';
  document.getElementById('callBtn').style.display       = 'none';
  log('Showing incoming panel for: ' + from);
}

// Active call (both directions): show active panel + Hangup only
function showActive(num) {
  document.getElementById('activeNum').textContent       = num || '';
  document.getElementById('incomingPanel').style.display = 'none';
  document.getElementById('activePanel').style.display   = 'block';
  document.getElementById('dialerPanel').style.display   = 'none'; // hide dialer during call
  document.getElementById('hangupBtn').style.display     = 'block';
  document.getElementById('callBtn').style.display       = 'none';
  startTimer();
}

// Idle: show dialer + Call button only — NO accept/reject, NO hangup
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
    document.getElementById('timerEl').textContent = m + ':' + s;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  setReg('connecting');
  setStatus('Fetching credentials...');

  try {
    let prefilledNumber = null;
    let incomingFrom    = null;

    if (window.BX24) {
      try {
        const info = BX24.placement.info();
        if (info && info.options) {
          if (info.options.number)       prefilledNumber = info.options.number;
          if (info.options.incomingFrom) incomingFrom    = info.options.incomingFrom;
        }
      } catch (e) { log('placement.info failed: ' + e.message); }
    }

    const res = await fetch('/token?user_id=' + encodeURIComponent(EXOTEL_APP_USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    if (!data.sip_id || !data.app_token) throw new Error('Missing credentials: ' + JSON.stringify(data));

    log('Got credentials — sip_id: ' + data.sip_id);
    setStatus('Initializing SDK...');

    const sdk = new ExotelCRMWebSDK(data.app_token, EXOTEL_APP_USER_ID, false);
    webPhone = await sdk.Initialize(
      function callListener(event) {
        log('Call event: ' + JSON.stringify(event));
        handleCallEvent(event);
      },
      function regListener(event) {
        log('Reg event: ' + JSON.stringify(event));
        setReg('registered');
        setStatus('✅ Ready');
      }
    );

    setReg('registered');
    setStatus('✅ Ready');

    // Outbound: auto-dial (click-to-call from BX24 CRM)
    if (prefilledNumber) {
      log('Auto-dialing (outbound): ' + prefilledNumber);
      callDirection = 'outbound';
      document.getElementById('phone').value = prefilledNumber;
      setTimeout(makeCall, 600);
    }

    // Inbound: show incoming panel (triggered by background worker)
    if (incomingFrom) {
      log('Auto-showing incoming panel: ' + incomingFrom);
      showIncoming(incomingFrom);
      setStatus('');
    }

  } catch (err) {
    setReg('failed');
    setStatus('Error: ' + err.message);
    console.error('[Dialer] Init error:', err);
  }
}

// ── Call event handler ─────────────────────────────────────────
function handleCallEvent(event) {
  log('Raw: ' + JSON.stringify(event));
  const raw = JSON.stringify(event).toLowerCase();

  if (raw.includes('incoming') || raw.includes('ringing')) {
    // Only show incoming UI if this is NOT an outbound call ringing on the remote side
    if (callDirection !== 'outbound') {
      const from = (event && (event.FromNumber || event.from || event.callerNumber)) || 'Unknown';
      showIncoming(from);
      setStatus('');
    }

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active')) {
    // Call is live — show active panel for both inbound and outbound
    const num = callDirection === 'inbound'
      ? (document.getElementById('callerNum').textContent || '')
      : (document.getElementById('phone').value || document.getElementById('callerNum').textContent || '');
    showActive(num);
    setStatus('');

  } else if (
    raw.includes('end') || raw.includes('disconnect') || raw.includes('bye') ||
    raw.includes('terminal') || raw.includes('hangup')
  ) {
    showDialer();
    setStatus('Call ended');
  }
}

// ── Outbound call (typed number in Exotel dialer) ──────────────
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number) { setStatus('Enter a number'); return; }
  if (!webPhone) { setStatus('SDK not ready'); return; }
  try {
    callDirection = 'outbound';
    setStatus('Calling ' + number + '...');
    document.getElementById('callBtn').disabled = true;
    try {
      await webPhone.MakeCall(number);
    } catch (e) {
      log('MakeCall internal (call placed OK): ' + e.message);
    }
    // Outbound: go directly to active (no accept step needed)
    showActive(number);
    document.getElementById('callBtn').disabled = false;
  } catch (err) {
    setStatus('Call failed: ' + err.message);
    document.getElementById('callBtn').disabled = false;
    callDirection = null;
  }
}

// ── Accept incoming (INBOUND ONLY) ─────────────────────────────
async function acceptCall() {
  if (!webPhone) { setStatus('SDK not ready'); return; }
  try {
    await webPhone.AcceptCall();
    showActive(document.getElementById('callerNum').textContent);
    setStatus('');
  } catch (err) {
    setStatus('Accept failed: ' + err.message);
  }
}

// ── Reject incoming (INBOUND ONLY) ────────────────────────────
async function rejectCall() {
  if (!webPhone) return;
  try { await webPhone.HangupCall(); } catch(e) { log('Reject: ' + e.message); }
  showDialer();
  setStatus('Call rejected');
}

// ── Hang up (active call) ──────────────────────────────────────
async function hangUp() {
  if (!webPhone) return;
  try { await webPhone.HangupCall(); } catch(e) { log('Hangup: ' + e.message); }
  showDialer();
  setStatus('Call ended');
}

window.onload = init;
