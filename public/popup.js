// ═══════════════════════════════════════════════════════════════
// popup.js — Fixed per official Exotel CRM WebSDK docs
// ═══════════════════════════════════════════════════════════════

let webPhone      = null;
let sdkReady      = false;
let timerInterval = null;
let timerSec      = 0;
let callDirection = null; // 'inbound' | 'outbound' | null
let micGranted    = false;

const EXOTEL_APP_USER_ID = '123';
const BX24_USER_ID       = '44';

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

// ── Mic permission ────────────────────────────────────────────
let micStream = null; // global

async function requestMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // DO NOT stop tracks here — let SDK reuse or release it
    micGranted = true;
    clog('Mic permission granted');
  } catch (e) {
    micGranted = false;
    clog('Mic DENIED: ' + e.message);
    setStatus('⚠️ Allow microphone and reload.');
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
    const m = String(Math.floor(timerSec / 60)).padStart(2,'0');
    const s = String(timerSec % 60).padStart(2,'0');
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
  await requestMic();
  if (!micGranted) return;

  setStatus('Fetching credentials...');
  try {
    const res = await fetch('/token?user_id=' + encodeURIComponent(EXOTEL_APP_USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    clog('Token OK, app_user_id=' + (data.app_user_id || data.user_id));

    const accessToken = data.access_token || data.app_token;
    const appUserId   = data.app_user_id  || data.user_id || EXOTEL_APP_USER_ID;
    if (!accessToken) throw new Error('No access_token in response');

    setStatus('Initializing SDK...');
    if (typeof ExotelCRMWebSDK === 'undefined') throw new Error('ExotelCRMWebSDK not loaded — check /target/crmBundle.js path');

    // ✅ FIX 1: autoConnectVOIP = true (was false — caused silent registration failure)
    const crmWebSDK = new ExotelCRMWebSDK(accessToken, appUserId, true);

    // ✅ FIX 2: await Initialize() — it RETURNS ExotelWebPhoneSDK (the actual phone object)
    webPhone = await crmWebSDK.Initialize(
      handleCallEvent,   // sofPhoneListenerCallback
      function(event) {  // softPhoneRegisterEventCallBack
        clog('regEvent: ' + JSON.stringify(event));
        if (!sdkReady) {
          sdkReady = true;
          setReg('registered');
          setStatus('✅ Ready');
          clog('SIP registered ✅');
          startPoll();
        }
      }
    );
    // After webPhone = await crmWebSDK.Initialize(...)
if (micStream) {
  micStream.getTracks().forEach(t => t.stop());
  micStream = null;
}

    clog('Initialize resolved. webPhone=' + (webPhone ? typeof webPhone : 'null/void'));

    // Some SDK versions resolve with webPhone, others fire regCallback first
    if (webPhone && !sdkReady) {
      sdkReady = true;
      setReg('registered');
      setStatus('✅ Ready');
      startPoll();
    }

  } catch (err) {
    setReg('failed');
    setStatus('Error: ' + err.message);
    clog('Init FAILED: ' + err.message);
    console.error('[Dialer] Init error:', err);
  }
}

// ── Poll for BX24 click-to-call outbound ─────────────────────
let pollCount = 0;
let pollTimer = null;
function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(doPoll, 2000);
}
async function doPoll() {
  try {
    const res  = await fetch('/pending-call');
    const data = await res.json();
    pollCount++;
    if (pollCount % 30 === 1) clog('poll #' + pollCount);
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

// ── Outbound call ─────────────────────────────────────────────
async function triggerOutboundCall(number) {
  if (!webPhone) { setStatus('SDK not ready'); clog('webPhone is null!'); return; }
  callDirection = 'outbound';
  clog('MakeCall → ' + number);
  try {
    await webPhone.MakeCall(number, null, null);
  } catch (e) {
    clog('MakeCall error: ' + e.message);
  }
  // Do NOT show active UI here.
  // SDK will fire callListener with incoming/ringing → we silently AcceptCall()
  // SDK then fires connected/answered → we show active UI
}

// ── Call event handler (per official SDK event structure) ─────
function handleCallEvent(event) {
  clog('callEvent: ' + JSON.stringify(event));

  // ✅ FIX 3: Read event.event or event.type directly — don't stringify-match
  const evtType = (
    (event && event.event) ||
    (event && event.type)  ||
    (event && event.EventType) ||
    ''
  ).toLowerCase();

  const evtStr = JSON.stringify(event).toLowerCase(); // fallback for unknown shapes

  clog('evtType=' + evtType + ' direction=' + callDirection);

  // ── Incoming / Ringing ────────────────────────────────────
  if (evtType.includes('incoming') || evtType.includes('ringing') ||
      evtStr.includes('incoming')  || evtStr.includes('ringing')) {

    if (callDirection === 'outbound') {
      // Outbound SIP leg rings browser — silently accept to open mic
      clog('Outbound SIP leg incoming → silent AcceptCall');
      silentAcceptOutbound();
    } else {
      // Genuine inbound call from customer
      const from = (event && (event.from || event.FromNumber || event.callerNumber || event.CallFrom)) || 'Unknown';
      showIncoming(from);
      setStatus('');
    }

  // ── Connected / Answered ──────────────────────────────────
  } else if (evtType.includes('connect') || evtType.includes('answer') ||
             evtType.includes('accept')  || evtType.includes('active') ||
             evtStr.includes('call_answered') || evtStr.includes('connected')) {

    const num = callDirection === 'inbound'
      ? (document.getElementById('callerNum')?.textContent || '')
      : (document.getElementById('phone')?.value || '');
    showActive(num);
    setStatus('');

  // ── Ended ─────────────────────────────────────────────────
  } else if (evtType.includes('end')   || evtType.includes('complet') ||
             evtType.includes('bye')   || evtType.includes('terminal') ||
             evtStr.includes('callended') || evtStr.includes('call_completed') ||
             evtStr.includes('disconnect')) {
    showDialer();
    setStatus('Call ended');
  }
}

// Silently open mic for outbound SIP leg
async function silentAcceptOutbound() {
  if (!webPhone) return;
  try {
    await webPhone.AcceptCall();
    clog('silentAccept OK');
    const num = document.getElementById('phone')?.value || '';
    showActive(num);
  } catch (e) {
    clog('silentAccept error: ' + e.message);
    const num = document.getElementById('phone')?.value || '';
    showActive(num); // show active anyway — call may still connect
  }
}

// ── Manual call button ────────────────────────────────────────
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number)    { setStatus('Enter a number'); return; }
  if (!webPhone)  { setStatus('SDK not ready'); return; }
  if (!micGranted){ setStatus('⚠️ Allow microphone first!'); return; }
  document.getElementById('callBtn').disabled = true;
  await triggerOutboundCall(number);
  document.getElementById('callBtn').disabled = false;
}

// ── Accept inbound ────────────────────────────────────────────
async function acceptCall() {
  if (!webPhone) { setStatus('SDK not ready'); return; }
  if (!micGranted) {
    await requestMic();
    if (!micGranted) { setStatus('⚠️ Mic required'); return; }
  }
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

// ── Reject inbound ────────────────────────────────────────────
async function rejectCall() {
  if (!webPhone) return;
  clog('RejectCall');
  try { await webPhone.HangupCall(); } catch (e) { clog('Reject err: ' + e.message); }
  showDialer();
  setStatus('Call rejected');
}

// ── Hang up ───────────────────────────────────────────────────
async function hangUp() {
  if (!webPhone) return;
  clog('HangupCall');
  try { await webPhone.HangupCall(); } catch (e) { clog('Hangup err: ' + e.message); }
  showDialer();
  setStatus('Call ended');
}

window.onload = init;
