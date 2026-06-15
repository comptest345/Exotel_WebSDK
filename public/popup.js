// ═══════════════════════════════════════════════════════════════
// popup.js — Pure UI. Zero SDK. Zero SIP.
// Polls /call-state every second and sends actions via /call-action.
// background.js owns the single SDK instance and all WebRTC audio.
// ═══════════════════════════════════════════════════════════════

let timerInterval = null;
let timerSec = 0;
let currentUIState = 'idle'; // tracks last rendered state to avoid flicker
let statePoller = null;

function log(msg) { console.log('[Dialer]', msg); }
function setStatus(msg) { document.getElementById('status').textContent = msg; log(msg); }

function setReg(state) {
  const dot = document.getElementById('regDot');
  const txt = document.getElementById('regText');
  const map = {
    connecting: { cls: 'yellow', label: 'Connecting...' },
    registered: { cls: 'green',  label: '🟢 Ready' },
    failed:     { cls: 'red',    label: '🔴 Registration failed' }
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
  try { new Audio('/target/ringtone.wav').play(); } catch(e) {}
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

// ── Call action helpers ────────────────────────────────────────
async function postAction(action, number) {
  try {
    await fetch('/call-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, number })
    });
  } catch(e) { log('postAction error: ' + e.message); }
}

// ── Outbound call ──────────────────────────────────────────────
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number) { setStatus('Enter a number'); return; }
  setStatus('Calling ' + number + '...');
  await postAction('makecall', number);
}

// ── Accept incoming ────────────────────────────────────────────
async function acceptCall() {
  await postAction('answer');
  showActive(document.getElementById('callerNum').textContent);
  currentUIState = 'active';
  setStatus('');
}

// ── Reject incoming ────────────────────────────────────────────
async function rejectCall() {
  await postAction('hangup');
  showDialer();
  currentUIState = 'idle';
  setStatus('Call rejected');
}

// ── Hang up ────────────────────────────────────────────────────
async function hangUp() {
  await postAction('hangup');
  showDialer();
  currentUIState = 'idle';
  setStatus('Call ended');
}

// ── Init — start polling /call-state ──────────────────────────
function init() {
  setReg('connecting');
  setStatus('Connecting...');

  let firstPoll = true;

  statePoller = setInterval(async () => {
    try {
      const res  = await fetch('/call-state');
      const data = await res.json();

      if (firstPoll) {
        firstPoll = false;
        setReg('registered');
        setStatus('✅ Ready');
      }

      // Only update UI when state actually changes to avoid flicker
      if (data.state !== currentUIState) {
        log('State change: ' + currentUIState + ' → ' + data.state);
        currentUIState = data.state;

        if (data.state === 'incoming') {
          showIncoming(data.from);
          setStatus('');
        } else if (data.state === 'active') {
          showActive(data.number || data.from);
          setStatus('');
        } else if (data.state === 'idle') {
          showDialer();
          setStatus('Ready');
        }
      }

    } catch(e) {
      log('Poll error: ' + e.message);
    }
  }, 1000);
}

window.onload = init;
