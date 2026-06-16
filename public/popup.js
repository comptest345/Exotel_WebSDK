// ═══════════════════════════════════════════════════════════════
// popup.js — Correct SDK initialization based on actual SDK source.
//
// KEY FIX: ExotelCRMWebSDK constructor takes NO arguments.
// sdk.Initialize() must be called with a full sipAccountInfo object:
//   { userName, authUser, domain, sipdomain, secret, port, ... }
// These come from /token (sip_id → userName/authUser, sip_secret → secret)
// plus server-known SIP domain info returned from /token.
// ═══════════════════════════════════════════════════════════════

let webPhone      = null;
let sdkReady      = false;
let queuedCall    = null;
let currentUIState = 'idle';
let timerInterval = null;
let timerSec      = 0;
let pollInterval  = null;
let sdkInitStarted = false;
let regHeartbeat   = null;

// ── Logging ──────────────────────────────────────────────────────
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

function postState(state) {
  fetch('/update-call-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  }).catch(() => {});
}

// ── Place an outbound call ───────────────────────────────────────
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

async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number) { setStatus('Enter a number'); return; }
  setStatus('Calling ' + number + '...');
  executeMakeCall(number);
}

async function acceptCall() {
  if (sdkReady && webPhone) {
    try { webPhone.AcceptCall(); log('AcceptCall fired'); }
    catch (e) { log('AcceptCall threw: ' + e.message); }
  }
  showActive(document.getElementById('callerNum').textContent);
  currentUIState = 'active';
  postState({ state: 'active' });
  setStatus('');
}

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
    } catch (e) { /* ignore */ }
  }, 1000);
}

// ── SDK init — correct initialization based on SDK source ────────
//
// The ExotelCRMWebSDK (class ce) constructor takes NO arguments.
// sdk.Initialize(callCb, regCb) internally calls initWebrtc() which
// requires sipAccountInfo to have: userName, authUser, sipdomain, domain, port, secret.
//
// The SDK's initWebrtc() checks:
//   if (!sipAccountInfo.userName || !sipAccountInfo.sipdomain || !sipAccountInfo.port) return false;
//
// Our /token endpoint returns sip_id and sip_secret from Exotel usermapping.
// The server also returns the SIP domain config needed to build the WSS URL.
// ────────────────────────────────────────────────────────────────
async function initSDK() {
  if (sdkInitStarted) {
    log('initSDK called again — ignoring (already started)');
    return;
  }
  sdkInitStarted = true;

  setReg('connecting');
  setStatus('Connecting...');

  try {
    // Wait for crmBundle.js to define ExotelCRMWebSDK
    let attempts = 0;
    while (typeof ExotelCRMWebSDK === 'undefined') {
      if (attempts++ > 20) throw new Error('ExotelCRMWebSDK not defined after 10s — crmBundle.js failed to load');
      await new Promise(r => setTimeout(r, 500));
    }
    log('ExotelCRMWebSDK class available');

    // Fetch SIP credentials from server
    // /token now returns: app_token, sip_id, sip_secret, sip_domain, sip_port
    const res = await fetch('/token?user_id=123');
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    log('Token response received', {
      has_sip_id: !!data.sip_id,
      has_sip_secret: !!data.sip_secret,
      sip_domain: data.sip_domain,
      sip_port: data.sip_port
    });

    if (!data.sip_id) throw new Error('No sip_id in token response: ' + JSON.stringify(data));
    if (!data.sip_secret) throw new Error('No sip_secret in token response: ' + JSON.stringify(data));
    if (!data.sip_domain) throw new Error('No sip_domain in token response — server must provide it');

    // Build sipAccountInfo exactly as SDK's initWebrtc() / loadCredentials() expect:
    //   userName    → displayed name & SIP username (sip_id from Exotel)
    //   authUser    → SIP auth username (same as sip_id)
    //   secret      → SIP password (sip_secret from Exotel)
    //   domain      → hostname[:port] used to build WSS URL
    //   sipdomain   → SIP registrar domain (used for sip: URI @domain part)
    //   port        → WSS port (8089 for wss, 8088 for ws)
    //   security    → 'wss'
    //   endpoint    → 'ws' (path appended to WSS URL)
    //   contactHost → public IP (SDK fetches via STUN, but we provide fallback)
    const sipPort = data.sip_port || 8089;
    const sipDomain = data.sip_domain;  // e.g. "singapore.exotel.com"

    const sipAccountInfo = {
      userName:    data.sip_id,
      authUser:    data.sip_id,
      secret:      data.sip_secret,
      domain:      sipDomain + ':' + sipPort,   // txtHostNameWithPort → txtHostName + txtWSPort
      sipdomain:   sipDomain,                    // used for sip: URI
      port:        sipPort,
      security:    'wss',
      endpoint:    'ws',
      displayName: data.sip_id,
      accountName: data.sip_id,
      contactHost: ''                            // SDK fills via STUN
    };

    log('sipAccountInfo built', {
      userName: sipAccountInfo.userName,
      domain: sipAccountInfo.domain,
      sipdomain: sipAccountInfo.sipdomain,
      port: sipAccountInfo.port,
      wssURL: 'wss://' + sipAccountInfo.domain + '/ws'  // what SDK will build
    });

    // Start heartbeat so Render logs show registration progress
    let regWaitSec = 0;
    regHeartbeat = setInterval(() => {
      regWaitSec += 5;
      log('Still waiting for SIP registration... ' + regWaitSec + 's elapsed');
    }, 5000);

    // ExotelCRMWebSDK constructor takes NO args per SDK source
    const sdk = new ExotelCRMWebSDK();

    // Initialize takes: sipAccountInfo, callCallback, registerCallback, sessionCallback
    // Returns a promise that resolves to the webPhone object
    webPhone = await sdk.Initialize(
      sipAccountInfo,
      function callListener(event) {
        handleSDKCallEvent(event);
      },
      function regListener(event) {
        if (regHeartbeat) { clearInterval(regHeartbeat); regHeartbeat = null; }
        const evStr = JSON.stringify(event).toLowerCase();
        log('Registration event received: ' + evStr.slice(0, 200));
        if (evStr.includes('registered') || evStr.includes('ready') || evStr.includes('connected')) {
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
        } else if (evStr.includes('unregistered') || evStr.includes('error') || evStr.includes('failed')) {
          log('SIP registration FAILED: ' + evStr);
          setReg('failed');
          setStatus('❌ Registration failed — please refresh');
        }
      },
      function sessionListener(event) {
        log('Session event: ' + JSON.stringify(event).slice(0, 100));
      }
    );

    log('SDK.Initialize() returned — waiting for regListener callback');

  } catch (err) {
    if (regHeartbeat) { clearInterval(regHeartbeat); regHeartbeat = null; }
    log('SDK init FAILED: ' + err.message, { stack: err.stack });
    setReg('failed');
    setStatus('❌ Init failed — please refresh. Error: ' + err.message);
  }
}

function init() {
  startPollingPendingCall();
  initSDK();
}

window.onload = init;
