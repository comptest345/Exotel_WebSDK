// ═══════════════════════════════════════════════════════════════
// popup.js — Multi-agent version
// FIX: Uses BX24 auth token passed via iframe URL (?bx24_user_id=)
//      as fallback when BX24.init() is unavailable (Marketplace page).
//      Also supports legacy email lookup via /token?user_id=email
// ═══════════════════════════════════════════════════════════════

let webPhone      = null;
let sdkReady      = false;
let timerInterval = null;
let timerSec      = 0;
let callDirection = null;
let micGranted    = false;

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
    failed:     { cls: 'red',    label: '\uD83D\uDD34 Registration failed' }
  };
  const s = map[state] || { cls: '', label: state };
  if (dot) dot.className = 'dot ' + s.cls;
  if (txt) txt.textContent = s.label;
}

// ── Get logged-in Bitrix24 user email ───────────────────────────────────────────
function getBx24CurrentUser() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const MAX    = 5;
    function tryInit() {
      attempts++;
      if (!window.BX24) {
        if (attempts < MAX) { setTimeout(tryInit, 1000); }
        else { reject(new Error('BX24 not available')); }
        return;
      }
      BX24.init(function () {
        BX24.callMethod('user.current', {}, function (result) {
          if (result.error()) { reject(new Error(String(result.error()))); return; }
          const data = result.data();
          resolve({
            email: data.EMAIL || null,
            id:    data.ID    || null,
            name:  (data.NAME + ' ' + (data.LAST_NAME || '')).trim()
          });
        });
      });
    }
    tryInit();
  });
}

// ── FIX: Parse bx24_user_id from iframe URL query params ─────────────────────────────
function getBx24UserIdFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const placementOptions = params.get('PLACEMENT_OPTIONS');
    if (placementOptions) {
      const opts = JSON.parse(decodeURIComponent(placementOptions));
      if (opts.USER_ID) return String(opts.USER_ID);
    }
    const userId = params.get('USER_ID') || params.get('user_id');
    if (userId) return String(userId);
  } catch(e) {}
  return null;
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

async function init() {
  setReg('connecting');
  setStatus('Identifying user...');

  let tokenLookupId = null;

  try {
    const bxUser = await getBx24CurrentUser();
    currentUserEmail  = bxUser.email;
    currentBx24UserId = bxUser.id;
    clog('BX24 user: ' + bxUser.name + ' <' + currentUserEmail + '> id=' + currentBx24UserId);
    if (!currentUserEmail) throw new Error('BX24 returned no email for this user');
    tokenLookupId = currentUserEmail;
    setStatus('Hello ' + bxUser.name.split(' ')[0] + '! Requesting microphone...');
  } catch (e) {
    clog('BX24 user detection failed: ' + e.message);
    const urlBx24Id = getBx24UserIdFromUrl();
    if (urlBx24Id) {
      clog('Using bx24_user_id from URL params: ' + urlBx24Id);
      currentBx24UserId = urlBx24Id;
      tokenLookupId = null;
      setStatus('User ' + urlBx24Id + ': Requesting microphone...');
    } else {
      setReg('failed');
      setStatus('\u26A0\uFE0F Please open the dialer from a CRM contact, not the Marketplace page.');
      console.error('[Dialer] BX24 user detection failed:', e.message);
      return;
    }
  }

  await requestMic();
  if (!micGranted) return;

  setStatus('Fetching credentials...');
  try {
    let tokenUrl;
    if (tokenLookupId) {
      tokenUrl = '/token?user_id=' + encodeURIComponent(tokenLookupId);
    } else if (currentBx24UserId) {
      tokenUrl = '/token?bx24_user_id=' + encodeURIComponent(currentBx24UserId);
    } else {
      throw new Error('Cannot identify user — no email or bx24_user_id');
    }

    const res  = await fetch(tokenUrl);
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (!currentUserEmail && data.email) currentUserEmail = data.email;

    clog('Token OK, app_user_id=' + data.app_user_id);

    const accessToken = data.access_token || data.app_token;
    const appUserId   = data.app_user_id  || data.user_id;
    if (!accessToken) throw new Error('No access_token in response');

    setStatus('Initializing SDK...');
    if (typeof ExotelCRMWebSDK === 'undefined') throw new Error('ExotelCRMWebSDK not loaded — check /target/crmBundle.js path');

    const crmWebSDK = new ExotelCRMWebSDK(accessToken, appUserId, true);

    webPhone = await crmWebSDK.Initialize(
      handleCallEvent,
      function(event) {
        clog('regEvent: ' + JSON.stringify(event));
        if (!sdkReady) {
          sdkReady = true;
          setReg('registered');
          setStatus('\u2705 Ready');
          clog('SIP registered \u2705 as ' + appUserId);
          startPoll();
        }
      }
    );

    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }

    clog('Initialize resolved. webPhone=' + (webPhone ? typeof webPhone : 'null/void'));

    if (webPhone && !sdkReady) {
      sdkReady = true;
      setReg('registered');
      setStatus('\u2705 Ready');
      startPoll();
    }

  } catch (err) {
    setReg('failed');
    setStatus('Error: ' + err.message);
    clog('Init FAILED: ' + err.message);
    console.error('[Dialer] Init error:', err);
  }
}

let pollCount = 0;
let pollTimer = null;
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
  const evtStr = JSON.stringify(event).toLowerCase();
  clog('evtType=' + evtType + ' direction=' + callDirection);

  if (evtType.includes('incoming') || evtType.includes('ringing') || evtStr.includes('incoming') || evtStr.includes('ringing')) {
    if (callDirection === 'outbound') { clog('Outbound SIP leg incoming \u2192 silent AcceptCall'); silentAcceptOutbound(); }
    else { const from = (event && (event.from || event.FromNumber || event.callerNumber || event.CallFrom)) || 'Unknown'; showIncoming(from); setStatus(''); }
  } else if (evtType.includes('connect') || evtType.includes('answer') || evtType.includes('accept') || evtType.includes('active') || evtStr.includes('call_answered') || evtStr.includes('connected')) {
    const num = callDirection === 'inbound' ? (document.getElementById('callerNum')?.textContent || '') : (document.getElementById('phone')?.value || '');
    showActive(num); setStatus('');
  } else if (evtType.includes('end') || evtType.includes('complet') || evtType.includes('bye') || evtType.includes('terminal') || evtStr.includes('callended') || evtStr.includes('call_completed') || evtStr.includes('disconnect')) {
    showDialer(); setStatus('Call ended');
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
  try { await webPhone.AcceptCall(); showActive(document.getElementById('callerNum')?.textContent || ''); setStatus(''); }
  catch (err) { clog('AcceptCall error: ' + err.message); setStatus('Accept failed: ' + err.message); }
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
