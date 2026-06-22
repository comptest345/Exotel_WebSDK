// ═══════════════════════════════════════════════════════════════
// popup.js — Dynamic multi-agent version
// Resolves the logged-in BX24 user's email → fetches their
// SIP credentials from /token → initializes ExotelCRMWebSDK
// NO hardcoded user IDs anywhere.
// ═══════════════════════════════════════════════════════════════

let webPhone      = null;
let sdkReady      = false;
let timerInterval = null;
let timerSec      = 0;
let callDirection = null;
let micGranted    = false;
let micStream     = null;
let initRetries   = 0;
const MAX_RETRIES = 4;

let currentUserEmail  = null;
let currentBx24UserId = null;
let currentInboundCallSid = null;  // set when an inbound call arrives; used for claiming
// Guard: track ALL callSids that were dismissed (claimed by another agent, or
// rejected by this agent). A Set instead of a single var handles cases where
// duplicate Exotel webhooks fire and multiple calls arrive in quick succession.
const dismissedCallSids = new Set();
let dismissedAt      = 0;   // timestamp of last dismiss; used for native-SIP cooldown
// Tracks the callSid WE just claimed+accepted. Prevents the poll fallback from
// seeing "claimed" and calling showDialer() on our own screen while we're live.
let acceptingCallSid = null;

function log(msg) { console.log('[Dialer]', msg); }
function clog(msg, extra) {
  fetch('/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'popup.js', message: msg, extra: extra || null, email: currentUserEmail, ts: Date.now() })
  }).catch(() => {});
}

// ── Round robin: report busy/free status to server ────────────
// Called whenever this agent's call state changes so the server
// knows whether to ring them for new incoming calls.
function reportStatus(status) {
  if (!currentUserEmail) return;
  fetch('/agent-status', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: currentUserEmail, status })
  }).catch(() => {}); // best-effort — never block call flow on this
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
    failed:     { cls: 'red',    label: '🔴 Disconnected' }
  };
  const s = map[state] || { cls: '', label: state };
  if (dot) dot.className = 'dot ' + s.cls;
  if (txt) txt.textContent = s.label;
}

// ── BX24 identity resolution ──────────────────────────────────
function getBx24CurrentUser() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const MAX_ATTEMPTS = 50;
    function tryInit() {
      attempts++;
      if (typeof window.BX24 === 'undefined') {
        if (attempts < MAX_ATTEMPTS) return setTimeout(tryInit, 600);
        return reject(new Error('BX24 JS bridge not loaded after ' + (MAX_ATTEMPTS * 0.6) + 's'));
      }
      try {
        BX24.init(function () {
          BX24.callMethod('user.current', {}, function (result) {
            if (result.error()) return reject(new Error(String(result.error())));
            const d = result.data();
            resolve({
              email: (d.EMAIL || '').trim() || null,
              id:    String(d.ID || ''),
              name:  ((d.NAME || '') + ' ' + (d.LAST_NAME || '')).trim()
            });
          });
        });
      } catch (e) {
        if (attempts < MAX_ATTEMPTS) return setTimeout(tryInit, 600);
        reject(e);
      }
    }
    tryInit();
  });
}

function getBx24UserIdFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const po = params.get('PLACEMENT_OPTIONS');
    if (po) {
      const opts = JSON.parse(decodeURIComponent(po));
      if (opts.USER_ID) return String(opts.USER_ID);
    }
    return params.get('USER_ID') || params.get('user_id') || params.get('bx24_user_id') || null;
  } catch (_) { return null; }
}

function getBx24UserIdFromAuth() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('auth[user_id]') || params.get('AUTH[USER_ID]') || null;
  } catch (_) { return null; }
}

async function resolveBx24Identity() {
  clog('popup URL: ' + window.location.href.slice(0, 200));

  try {
    const u = await getBx24CurrentUser();
    if (u.email || u.id) {
      clog('Identity via BX24.init: ' + u.name + ' <' + u.email + '> id=' + u.id);
      return u;
    }
  } catch (e) { clog('BX24.init failed: ' + e.message); }

  const urlId = getBx24UserIdFromUrl();
  if (urlId) {
    clog('Identity via URL PLACEMENT_OPTIONS: id=' + urlId);
    return { id: urlId, email: null, name: '' };
  }

  const authId = getBx24UserIdFromAuth();
  if (authId) {
    clog('Identity via auth[user_id]: id=' + authId);
    return { id: authId, email: null, name: '' };
  }

  throw new Error('Cannot identify BX24 user — all methods failed. URL: ' + window.location.href.slice(0, 150));
}

// ── Microphone ────────────────────────────────────────────────
async function requestMic() {
  try {
    micStream  = await navigator.mediaDevices.getUserMedia({ audio: true });
    micGranted = true;
    clog('Mic granted');
  } catch (e) {
    micGranted = false;
    clog('Mic DENIED: ' + e.message);
    setStatus('⚠️ Allow microphone and reload.');
    const w = document.getElementById('micWarning');
    if (w) w.style.display = 'block';
  }
}

function releaseMic() {
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
    clog('Mic stream released');
  }
}

// ── UI helpers ────────────────────────────────────────────────
function showIncoming(from, callSid) {
  callDirection = 'inbound';
  // Only overwrite currentInboundCallSid when a real callSid is supplied.
  // The native SDK event fires showIncoming(from) with NO callSid — if we
  // let that clobber the sid set by the SSE push, call_dismissed matching
  // breaks and other agents' Accept/Reject panels never get dismissed.
  if (callSid) currentInboundCallSid = callSid;
  const el = document.getElementById('callerNum');
  if (el) el.textContent = from || 'Unknown';
  document.getElementById('incomingPanel').style.display = 'block';
  document.getElementById('activePanel').style.display   = 'none';
  document.getElementById('dialerPanel').style.display   = 'none';
  document.getElementById('hangupBtn').style.display     = 'none';
  document.getElementById('callBtn').style.display       = 'none';
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
  // Round robin: tell server this agent is now busy on a call (inbound or outbound).
  // New incoming calls will skip this agent and ring others who are free.
  reportStatus('busy');
}

// Shows a "ringing" state for outbound calls: the SIP leg to Exotel is up,
// but the customer hasn't answered yet. Active panel is visible (agent can
// hang up) but the timer does NOT start until customer actually answers.
function showOutboundRinging(num) {
  const el = document.getElementById('activeNum');
  if (el) el.textContent = '🔔 ' + (num || 'Calling...');
  document.getElementById('incomingPanel').style.display = 'none';
  document.getElementById('activePanel').style.display   = 'block';
  document.getElementById('dialerPanel').style.display   = 'none';
  document.getElementById('hangupBtn').style.display     = 'block';
  document.getElementById('callBtn').style.display       = 'none';
  stopTimer();
  const timerEl = document.getElementById('timerEl');
  if (timerEl) timerEl.textContent = 'Ringing...';
  // Round robin: mark busy while ringing outbound — don't also ring inbound.
  reportStatus('busy');
}

function showDialer() {
  callDirection = null;
  currentInboundCallSid = null;
  acceptingCallSid = null; // clear guard — we're back to idle
  document.getElementById('incomingPanel').style.display = 'none';
  document.getElementById('activePanel').style.display   = 'none';
  document.getElementById('dialerPanel').style.display   = 'block';
  document.getElementById('hangupBtn').style.display     = 'none';
  document.getElementById('callBtn').style.display       = 'block';
  stopTimer();
  // Round robin: agent is back to idle — allow new incoming calls to ring them.
  reportStatus('free');
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
function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }

// ── Main init ─────────────────────────────────────────────────
async function init() {
  sdkReady      = false;
  webPhone      = null;
  setReg('connecting');
  setStatus('Identifying user...');

  let identity;
  try {
    identity = await resolveBx24Identity();
  } catch (e) {
    setReg('failed');
    setStatus('⚠️ Open from a CRM sidebar. (' + e.message + ')');
    scheduleRetry();
    return;
  }
  currentBx24UserId = identity.id    || null;
  currentUserEmail  = identity.email || null;

  setStatus('Requesting mic...');
  await requestMic();
  if (!micGranted) { scheduleRetry(); return; }

  setStatus('Fetching credentials...');
  let tokenData;
  try {
    const url = currentUserEmail
      ? '/token?user_id=' + encodeURIComponent(currentUserEmail)
      : '/token?bx24_user_id=' + encodeURIComponent(currentBx24UserId);
    clog('Fetching: ' + url);
    const res  = await fetch(url);
    const body = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + body.slice(0, 200));
    tokenData = JSON.parse(body);
    if (tokenData.error) throw new Error(tokenData.error);
    clog('Token OK → AppUserId=' + tokenData.app_user_id + ' SipId=' + tokenData.sip_id);
  } catch (e) {
    setReg('failed');
    setStatus('Credentials error: ' + e.message);
    clog('Token error: ' + e.message);
    scheduleRetry();
    return;
  }

  const accessToken = tokenData.access_token || tokenData.app_token;

  const credentials = tokenData.multiCredentials || [
    {
      app_user_id:  String(tokenData.app_user_id || tokenData.user_id || tokenData.sip_username || ''),
      sip_id:       tokenData.sip_id       || '',
      sip_secret:   tokenData.sip_secret   || '',
      virtual_number: tokenData.virtual_number || ''
    }
  ];

  if (!accessToken || credentials.length === 0 || !credentials[0].app_user_id) {
    setReg('failed');
    setStatus('Missing token fields — check /list-users');
    clog('Bad token response: ' + JSON.stringify(tokenData));
    scheduleRetry();
    return;
  }

  clog('Credentials ready: ' + credentials.map(c =>
    'user=' + c.app_user_id + ' sip=' + c.sip_id + ' secret=' + (c.sip_secret ? '✓' : '✗')
  ).join(' | '));

  setStatus('Connecting softphone...');
  await tryInitWithCredentials(accessToken, credentials, 0);
}

// ── Multi-credential SDK init ─────────────────────────────────
async function tryInitWithCredentials(accessToken, creds, i) {
  if (i >= creds.length) {
    clog('All ' + creds.length + ' credential(s) exhausted — scheduling retry');
    setReg('failed');
    setStatus('SIP register failed — retrying');
    scheduleRetry();
    return;
  }

  const cred        = creds[i];
  const appUserId   = String(cred.app_user_id || '');
  const sipSecret   = cred.sip_secret   || '';
  const sipId       = cred.sip_id       || '';
  if (!appUserId) {
    clog('Credential #' + i + ' has no app_user_id — skipping');
    return tryInitWithCredentials(accessToken, creds, i + 1);
  }

  try {
    if (typeof ExotelCRMWebSDK === 'undefined') {
      throw new Error('ExotelCRMWebSDK not loaded — crmBundle.js missing');
    }

    clog('SDK init attempt ' + (i+1) + '/' + creds.length +
         ' — userId=' + appUserId +
         ' sipId=' + sipId +
         ' secret=' + (sipSecret ? '✓' : '✗ MISSING'));

    const sdkOptions = sipSecret
      ? { sip_username: appUserId, sip_password: sipSecret }
      : undefined;

    const crmWebSDK = sdkOptions
      ? new ExotelCRMWebSDK(accessToken, appUserId, true, sdkOptions)
      : new ExotelCRMWebSDK(accessToken, appUserId, true);

    let regFired = false;
    const regTimeout = setTimeout(() => {
      if (!sdkReady && !regFired) {
        clog('regEvent not fired in 30 s for userId=' + appUserId +
             ' — trying next credential (' + (i+1) + '/' + creds.length + ')');
        setStatus('Trying next credential...');
        tryInitWithCredentials(accessToken, creds, i + 1);
      }
    }, 30000);

    function registrationEventHandler(state, phone) {
      if (regFired) return;
      regFired = true;
      clearTimeout(regTimeout);
      clog('regEvent state=' + state + ' phone=' + phone + ' userId=' + appUserId);

      if (state === 'registered') {
        sdkReady    = true;
        initRetries = 0;
        if (!webPhone) {
          webPhone = {
            // SDK signature: MakeCall(toNumber, callback(status, data))
            // Passing null as callback causes "t is not a function" — use no-op instead.
            MakeCall:   (n) => crmWebSDK.MakeCall   ? crmWebSDK.MakeCall(n, () => {}) : Promise.resolve(),
            AcceptCall: ()  => crmWebSDK.AcceptCall  ? crmWebSDK.AcceptCall()           : Promise.resolve(),
            HangupCall: ()  => crmWebSDK.HangupCall  ? crmWebSDK.HangupCall()           : Promise.resolve()
          };
        }
        setReg('registered');
        setStatus('✅ Ready — ' + (phone || appUserId));
        // Report free so server knows this agent is available for incoming calls
        reportStatus('free');
        startPoll();
      } else if (state === 'terminated' || state === 'unregistered') {
        clog('regEvent ' + state + ' for userId=' + appUserId + ' — trying next');
        tryInitWithCredentials(accessToken, creds, i + 1);
      }
    }

    webPhone = await crmWebSDK.Initialize(handleCallEvent, registrationEventHandler);
    releaseMic();

    clog('Initialize() resolved. webPhone=' + (webPhone ? typeof webPhone : 'null/void') +
         ' userId=' + appUserId);

  } catch (err) {
    releaseMic();
    clog('SDK FAILED userId=' + appUserId + ': ' + err.message);
    tryInitWithCredentials(accessToken, creds, i + 1);
  }
}

// ── Retry ─────────────────────────────────────────────────────
let retryTimer = null;
function scheduleRetry() {
  if (retryTimer) return;
  initRetries++;
  if (initRetries > MAX_RETRIES) {
    setReg('failed');
    setStatus('❌ Connection failed. Reload the page.');
    return;
  }
  const delay = Math.min(5000 * Math.pow(2, initRetries - 1), 30000);
  clog('Retry in ' + (delay/1000) + 's (attempt ' + initRetries + '/' + MAX_RETRIES + ')');
  setStatus('Reconnecting in ' + Math.round(delay/1000) + 's...');
  retryTimer = setTimeout(() => { retryTimer = null; init(); }, delay);
}

// ── SSE subscription + poll fallback ─────────────────────────
let sseSource  = null;
let pollTimer  = null;
let pollCount  = 0;

function startPoll() {
  startSSE();
  startPollFallback();
}

function startSSE() {
  if (sseSource) return;
  if (!currentUserEmail) return;
  const url = '/events?email=' + encodeURIComponent(currentUserEmail);
  clog('SSE connecting: ' + url);
  sseSource = new EventSource(url);

  sseSource.addEventListener('outbound_call', async (e) => {
    const d = JSON.parse(e.data);
    clog('SSE outbound_call: ' + d.number);
    // Guard: if a call is already active/ringing, ignore duplicate SSE push
    // that arrives after SSE reconnects while a call placed by the first event
    // is already in progress. Without this, SSE reconnect → second /make-outbound-call
    // fires while agent's SIP device is busy → Exotel 404 "User device is currently busy".
    if (callDirection) {
      clog('SSE outbound_call ignored — callDirection=' + callDirection + ' (call already in progress)');
      return;
    }
    const phoneEl = document.getElementById('phone');
    if (phoneEl) phoneEl.value = d.number;
    callDirection = 'outbound';
    await triggerOutboundCall(d.number);
  });

  sseSource.addEventListener('inbound_call', async (e) => {
    const d = JSON.parse(e.data);
    clog('SSE inbound_call from: ' + d.from + ' sid: ' + d.callSid);
    // If already on a call (outbound or inbound), ignore — server marks us busy
    // but SSE events can still arrive during a race. Don't clobber active UI.
    if (callDirection) {
      clog('SSE inbound_call ignored — callDirection=' + callDirection + ' (already on a call)');
      return;
    }
    // Already dismissed (claimed by us, claimed by another, or rejected) — skip.
    if (d.callSid && dismissedCallSids.has(d.callSid)) {
      clog('SSE inbound_call ignored — already dismissed sid=' + d.callSid);
      return;
    }
    // A genuinely new call — reset the native-SIP cooldown for this callSid.
    if (d.callSid) {
      dismissedAt = 0;
    }
    showIncoming(d.from, d.callSid);
  });

  // Another agent claimed the call, or caller hung up — dismiss our incoming UI.
  sseSource.addEventListener('call_dismissed', (e) => {
    const d = JSON.parse(e.data);
    const sidMatch = (currentInboundCallSid === d.callSid) || (currentInboundCallSid === null);
    if (callDirection === 'inbound' && sidMatch) {
      const reason = d.reason || '';
      clog('call_dismissed reason=' + reason + ' sid=' + d.callSid);
      if (d.callSid) dismissedCallSids.add(d.callSid);
      dismissedAt = Date.now();
      showDialer();
      setStatus(reason === 'caller_hung_up' ? '📵 Caller hung up' : '📞 Answered by another agent');
    }
  });

  sseSource.onopen  = () => clog('SSE connected');
  sseSource.onerror = () => {
    clog('SSE error — reconnecting in 3s');
    // Close and null out so startSSE() can create a fresh connection.
    // Without this, the guard `if (sseSource) return` permanently blocks
    // reconnection after the first drop, leaving agents with no SSE channel
    // and inbound calls being broadcast to zero clients.
    try { sseSource.close(); } catch (_) {}
    sseSource = null;
    setTimeout(() => {
      if (!sseSource) startSSE();
    }, 3000);
  };
}

function startPollFallback() {
  if (pollTimer) return;
  pollTimer = setInterval(doPoll, 5000);
}

async function doPoll() {
  if (!currentUserEmail && !currentBx24UserId) return;
  try {
    const url = currentUserEmail
      ? '/pending-call?email=' + encodeURIComponent(currentUserEmail)
      : '/pending-call?bx24_user_id=' + encodeURIComponent(currentBx24UserId);
    const res  = await fetch(url);
    const data = await res.json();
    pollCount++;
    if (pollCount % 12 === 1) clog('poll#' + pollCount + ' email=' + currentUserEmail);
    if (data.pending && data.type === 'inbound' && !callDirection) {
      if (data.callSid && dismissedCallSids.has(data.callSid)) {
        clog('Poll inbound ignored — already dismissed sid=' + data.callSid);
        return;
      }
      clog('Poll fallback: inbound from ' + data.from + ' sid=' + data.callSid);
      showIncoming(data.from, data.callSid);
    } else if (!data.pending && data.type === 'claimed') {
      // Another agent claimed this call — dismiss OUR incoming panel.
      // CRITICAL: skip if WE are the one who claimed it (acceptingCallSid guard).
      // Without this check, the poll sees "claimed" and calls showDialer() on
      // the accepting agent's screen, wiping out their active call UI.
      if (callDirection === 'inbound' && data.callSid !== acceptingCallSid) {
        clog('Poll: call ' + data.callSid + ' already claimed by ' + data.claimedBy + ' — dismissing');
        if (data.callSid) dismissedCallSids.add(data.callSid);
        dismissedAt = Date.now();
        showDialer();
        setStatus('📞 Answered by another agent');
      }
    } else if (data.pending && data.type === 'outbound' && data.number) {
      if (callDirection) {
        clog('Poll outbound ignored — callDirection=' + callDirection + ' (already on a call)');
        return;
      }
      clog('Poll fallback caught outbound call: ' + data.number);
      callDirection = 'outbound';
      const phoneEl = document.getElementById('phone');
      if (phoneEl) phoneEl.value = data.number;
      await triggerOutboundCall(data.number);
    } else if (data.pending && data.number) {
      if (callDirection) {
        clog('Poll legacy outbound ignored — callDirection=' + callDirection + ' (already on a call)');
        return;
      }
      clog('Poll fallback (legacy) caught call: ' + data.number);
      callDirection = 'outbound';
      const phoneEl = document.getElementById('phone');
      if (phoneEl) phoneEl.value = data.number;
      await triggerOutboundCall(data.number);
    }
  } catch (_) {}
}

async function triggerOutboundCall(number) {
  if (!sdkReady)        { clog('OutboundCall: not registered'); setStatus('Not registered yet'); return; }
  if (!currentUserEmail){ clog('OutboundCall: email not resolved'); setStatus('⚠️ Email not resolved — reload'); return; }
  // Guard: prevent double-fire (SSE reconnect, poll race, etc.)
  if (callDirection && callDirection !== 'outbound') {
    clog('OutboundCall blocked — already on ' + callDirection + ' call');
    return;
  }
  callDirection = 'outbound';
  // Mark busy immediately — no incoming calls should ring this agent while dialling.
  reportStatus('busy');
  clog('OutboundCall → ' + number);
  try {
    // POST to our server which calls the Exotel API with record:true.
    // This is the fix for outbound calls not being recorded — the SDK's own
    // MakeCall hardcodes record:false, so we bypass it entirely and call
    // the Exotel V3 API directly from the server side with recording enabled.
    // The agent's SIP device will still ring via the normal incoming event
    // and AcceptCall() will connect the audio as usual.
    const res  = await fetch('/make-outbound-call', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ toNumber: number, agentEmail: currentUserEmail })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Server error');
    clog('OutboundCall placed via server: ' + JSON.stringify(data));
  } catch (e) {
    // Failed to place — revert to free so round robin doesn't permanently
    // exclude this agent from future incoming calls.
    reportStatus('free');
    callDirection = null;
    clog('OutboundCall error: ' + e.message);
    setStatus('Call failed: ' + e.message);
  }
}

// ── Call event handler ────────────────────────────────────────
function handleCallEvent(event) {
  clog('callEvent: ' + JSON.stringify(event));
  const raw  = JSON.stringify(event || {}).toLowerCase();
  const type = ((event && (event.event || event.EventType || event.type || event.state)) || '').toLowerCase();

  const isIncoming  = type.includes('incoming') || type.includes('ringing') || raw.includes('incoming') || raw.includes('ringing');
  const isEnded     = type.includes('end')      || type.includes('terminat') || type.includes('bye')      ||
                      type.includes('complet')   || type.includes('cancel')   || type.includes('failed')   ||
                      type.includes('reject')    ||
                      raw.includes('callended')  || raw.includes('call_completed') || raw.includes('call_failed');

  const isAcceptEvent = type.includes('accept') || raw.includes('accepted');
  const isConnected   =
    type.includes('connect') || type.includes('answer') || type.includes('active') || raw.includes('connected')
    || (isAcceptEvent && callDirection !== 'outbound');

  if (isIncoming) {
    if (callDirection === 'outbound') {
      clog('Outbound SIP ring → silent AcceptCall, showing ringing UI');
      if (webPhone) webPhone.AcceptCall().catch(e => clog('silentAccept err: ' + e.message));
      showOutboundRinging(document.getElementById('phone')?.value || '');
    } else {
      // Native SIP incoming/ringing event — carries no callSid.
      // CRITICAL: if we already accepted this call (acceptingCallSid is set),
      // Exotel fires a NEW Dial-leg webhook which causes another incoming/ringing
      // event. We must NOT let it re-show the incoming panel and wipe the
      // "Connecting..." status we set right after AcceptCall().
      if (acceptingCallSid) {
        clog('Native incoming event ignored — already accepted sid=' + acceptingCallSid);
        return;
      }
      if (currentInboundCallSid && dismissedCallSids.has(currentInboundCallSid)) {
        clog('Native incoming event ignored — callSid already dismissed: ' + currentInboundCallSid);
        return;
      }
      if (Date.now() - dismissedAt < 8000) {
        clog('Native incoming event ignored — within dismiss cooldown');
        return;
      }
      const from = (event && (event.from || event.FromNumber || event.callerNumber || event.CallFrom)) || 'Unknown';
      showIncoming(from);
    }
  } else if (isConnected) {
    const num = callDirection === 'inbound'
      ? (document.getElementById('callerNum')?.textContent || '')
      : (document.getElementById('phone')?.value || '');
    acceptingCallSid = null; // clear guard — we're now fully live
    showActive(num);
    setStatus('');
  } else if (isEnded) {
    clog('Call ended event — resetting UI');
    callDirection    = null;
    acceptingCallSid = null;
    reportStatus('free');
    showDialer();
    setStatus('Call ended');
  }
}

// ── Button handlers ───────────────────────────────────────────
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number)    { setStatus('Enter a number'); return; }
  if (!webPhone)  { setStatus('SDK not ready');  return; }
  if (!micGranted){ setStatus('⚠️ Allow microphone first!'); return; }
  if (!currentUserEmail) { setStatus('⚠️ User identity not resolved. Reload the page.'); return; }
  const btn = document.getElementById('callBtn');
  btn.disabled = true;
  try {
    await triggerOutboundCall(number);
  } finally {
    btn.disabled = false;
  }
}

async function acceptCall() {
  if (!webPhone) { setStatus('SDK not ready'); return; }
  if (!micGranted) { await requestMic(); if (!micGranted) { setStatus('⚠️ Mic required'); return; } }

  // Multi-agent: atomically claim the call on the server before accepting
  // the SIP leg. If another agent got there first we get { claimed: false }
  // and just dismiss — no SIP AcceptCall is sent.
  if (currentInboundCallSid) {
    try {
      const claimRes = await fetch('/claim-call', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          callSid:    currentInboundCallSid,
          email:      currentUserEmail,
          bx24UserId: currentBx24UserId
        })
      });
      const claimData = await claimRes.json();
      if (!claimData.claimed) {
        clog('Claim failed — already taken by ' + (claimData.claimedBy || 'another agent'));
        if (currentInboundCallSid) dismissedCallSids.add(currentInboundCallSid);
        showDialer();
        setStatus('📞 Already answered by another agent');
        return;
      }
      clog('Claimed callSid=' + currentInboundCallSid + ' bx24CallId=' + claimData.bx24CallId);
      // Mark as handled so poll/SSE don't re-show this call on this agent's panel.
      if (currentInboundCallSid) dismissedCallSids.add(currentInboundCallSid);
    } catch (e) {
      clog('Claim request failed (proceeding anyway): ' + e.message);
    }
  }

  // Set the guard BEFORE AcceptCall so the poll fallback can't dismiss us
  // the moment the server responds with "claimed" during the AcceptCall await.
  acceptingCallSid = currentInboundCallSid;

  clog('AcceptCall');
  try {
    await webPhone.AcceptCall();
    // AcceptCall() resolving = SIP leg accepted. The SDK does NOT reliably fire
    // a separate "connected" event for inbound calls — and acceptingCallSid guard
    // in handleCallEvent was swallowing any follow-up SDK events. Fix: show active
    // immediately here so the agent's UI reflects the live call without waiting
    // for a "connected" event that may never arrive.
    const num = document.getElementById('callerNum')?.textContent || '';
    acceptingCallSid = null; // clear guard — we're live
    showActive(num);
    setStatus('');
    clog('AcceptCall resolved — call live with ' + num);
  } catch (e) {
    acceptingCallSid = null;
    callDirection    = null;
    reportStatus('free');
    showDialer();
    clog('AcceptCall error: ' + e.message);
    setStatus('Accept failed: ' + e.message);
  }
}

async function rejectCall() {
  clog('rejectCall — informing server, other free agents continue to ring');

  // Tell the server this agent rejected — the call stays alive for others.
  // The server will NOT re-push this call to this agent on subsequent Exotel pings.
  if (currentInboundCallSid) {
    try {
      await fetch('/reject-call', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ callSid: currentInboundCallSid, email: currentUserEmail })
      });
    } catch (e) {
      clog('reject-call request failed (non-fatal): ' + e.message);
    }
    dismissedCallSids.add(currentInboundCallSid);
  }

  dismissedAt = Date.now();
  showDialer(); // showDialer() calls reportStatus('free') — agent is available again
  setStatus('Call declined');
}

async function hangUp() {
  if (!webPhone) return;
  callDirection = null;
  acceptingCallSid = null;
  try { await webPhone.HangupCall(); } catch (e) { clog('Hangup err: ' + e.message); }
  reportStatus('free');
  showDialer(); setStatus('Call ended');
}

window.onload = init;
