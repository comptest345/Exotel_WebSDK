let webPhone   = null;
let activeCall = null;
let callTimerInterval = null;
let callSeconds = 0;
let currentUserId = '123';

// ── UI helpers ─────────────────────────────────────────────────
function setStatus(msg) {
  document.getElementById('status').textContent = msg;
  console.log('[Dialer]', msg);
}

function setReg(state) {
  const dot  = document.getElementById('regDot');
  const text = document.getElementById('regText');
  const map  = {
    connecting:   { cls: 'yellow', label: 'Connecting...' },
    registered:   { cls: 'green',  label: '🟢 Ready' },
    failed:       { cls: 'red',    label: '🔴 Registration failed' },
    unregistered: { cls: 'red',    label: '🔴 Not registered' }
  };
  const s = map[state] || { cls: '', label: state };
  dot.className    = 'dot ' + s.cls;
  text.textContent = s.label;
}

function showIncoming(callerNumber) {
  document.getElementById('callerNumber').textContent = callerNumber || 'Unknown';
  document.getElementById('incomingPanel').style.display = 'block';
  document.getElementById('dialerPanel').style.display   = 'none';
  document.getElementById('activeCallPanel').style.display = 'none';
  // Play ringtone if browser allows
  try { new Audio('/target/ringtone.wav').play(); } catch(e) {}
}

function showActiveCall(number) {
  document.getElementById('activeNumber').textContent  = number || '';
  document.getElementById('incomingPanel').style.display   = 'none';
  document.getElementById('activeCallPanel').style.display = 'block';
  document.getElementById('dialerPanel').style.display     = 'block';
  document.getElementById('hangupBtn').style.display       = 'block';
  document.getElementById('callBtn').style.display         = 'none';
  startTimer();
}

function showDialer() {
  document.getElementById('incomingPanel').style.display   = 'none';
  document.getElementById('activeCallPanel').style.display = 'none';
  document.getElementById('dialerPanel').style.display     = 'block';
  document.getElementById('hangupBtn').style.display       = 'none';
  document.getElementById('callBtn').style.display         = 'block';
  stopTimer();
}

function startTimer() {
  callSeconds = 0;
  stopTimer();
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    document.getElementById('callTimer').textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
}
// Read number pre-filled by background worker (click-to-call)
if (window.BX24) {
  const placement = BX24.placement.info();
  const options = placement?.options;

  if (options?.number) {
    // Pre-fill dialer and auto-call
    document.getElementById('phone').value = options.number;
    // makeCall() will fire after SDK is ready (end of init)
  }

  if (options?.incomingFrom) {
    // Background worker detected inbound call — show incoming panel
    document.getElementById('callerNumber').textContent = options.incomingFrom;
    document.getElementById('incomingPanel').style.display = 'block';
  }
}
// ── Init ───────────────────────────────────────────────────────
async function init() {
  setReg('connecting');
  setStatus('Fetching credentials...');

  try {
    // Try to get Bitrix24 user email as userId
    if (window.BX24) {
      try {
        const profile = await new Promise(r => BX24.callMethod('profile', {}, r));
        const d = profile.data();
        if (d && d.EMAIL) currentUserId = d.EMAIL;
        else if (d && d.ID) currentUserId = String(d.ID);
      } catch(e) {
        console.log('BX24 profile failed, using default userId:', currentUserId);
      }
    }

    const res = await fetch(`/token?user_id=${encodeURIComponent(currentUserId)}`);
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();

    if (!data.sip_id || !data.sip_secret || !data.app_token) {
      throw new Error('Missing SIP credentials: ' + JSON.stringify(data));
    }

    console.log('[Dialer] Got credentials — sip_id:', data.sip_id);
    setStatus('Initializing SDK...');

    // Auto-dial if number was passed from background worker
if (window.BX24) {
  const options = BX24.placement.info()?.options;
  if (options?.number) makeCall();
}

    // ✅ Fix — pass sip_id and sip_secret
    const sdk = new ExotelCRMWebSDK(data.app_token, currentUserId, false, {
      sipId: data.sip_id,
      sipSecret: data.sip_secret
    });

    webPhone = await sdk.Initialize(
      function callListener(event) {
        console.log('[Dialer] Call event:', JSON.stringify(event));
        handleCallEvent(event);
      },
      function registrationListener(event) {
        console.log('[Dialer] Registration event:', JSON.stringify(event));
        handleRegistration(event);
      }
    );

    // SDK initialized successfully
    setReg('registered');
    setStatus('✅ Ready to make/receive calls');

    // ── Bitrix24 Click-to-Call (Outbound Type 1) ───────────────
    // When agent clicks phone icon next to a number in CRM
    if (window.BX24) {
      BX24.placement.bind('CRM_PHONE_NUMBER_CLICK', function(event) {
        console.log('[Dialer] CRM phone click:', JSON.stringify(event));
        const number = event?.data?.PHONE_NUMBER || event?.data?.phone;
        if (number) {
          document.getElementById('phone').value = number;
          makeCall();
        }
      });

      // Also bind to telephony external call event
      BX24.addCustomEvent('onExternalCallStart', function(data) {
        console.log('[Dialer] External call start:', JSON.stringify(data));
        const number = data?.PHONE_NUMBER;
        if (number) {
          document.getElementById('phone').value = number;
          makeCall();
        }
      });
    }

  } catch (err) {
    setReg('failed');
    setStatus('Error: ' + err.message);
    console.error('[Dialer] Init error:', err);
  }
}

// ── Registration handler ───────────────────────────────────────
function handleRegistration(event) {
  console.log('[Dialer] Registration FULL:', JSON.stringify(event));
  setReg('registered');
  setStatus('✅ Ready to make/receive calls');
}

// ── Call event handler ─────────────────────────────────────────
function handleCallEvent(event) {
  console.log('[Dialer] Call event type:', event?.type, event?.status, event?.CallState);

  const raw = JSON.stringify(event).toLowerCase();

  if (raw.includes('incoming') || raw.includes('ringing')) {
    const from = event?.FromNumber || event?.from || event?.callerNumber || 'Unknown';
    activeCall = event;
    showIncoming(from);
    setStatus('');

    // Notify Bitrix24 of incoming call
    if (window.BX24) {
      BX24.callMethod('telephony.externalcall.show', {
        USER_PHONE_INNER: currentUserId,
        USER_ID: BX24.getUser ? BX24.getUser().id : 1,
        CALL_ID: event?.callSid || event?.CallSid || Date.now().toString(),
        TYPE: 2  // inbound
      });
    }

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active')) {
    const num = document.getElementById('phone').value || activeCall?.FromNumber || '';
    showActiveCall(num);
    setStatus('');

  } else if (raw.includes('end') || raw.includes('disconnect') || raw.includes('terminal') || raw.includes('bye') || raw.includes('hangup')) {
    activeCall = null;
    showDialer();
    setStatus('Call ended');

    // Log call in Bitrix24 CRM
    if (window.BX24) {
      BX24.callMethod('telephony.externalcall.finish', {
        CALL_ID: event?.callSid || event?.CallSid || '',
        USER_ID: BX24.getUser ? BX24.getUser().id : 1,
        DURATION: callSeconds,
        STATUS_CODE: 200
      });
    }
  }
}

// ── Outbound call ──────────────────────────────────────────────
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number) { setStatus('Please enter a number'); return; }
  if (!webPhone) { setStatus('SDK not ready yet'); return; }

  try {
    setStatus('Calling ' + number + '...');
    document.getElementById('callBtn').disabled = true;

    await webPhone.MakeCall(number);
    document.getElementById('hangupBtn').style.display = 'block';

    showActiveCall(number);
    document.getElementById('callBtn').disabled = false;

    // Log outbound call start in Bitrix24
    if (window.BX24) {
      BX24.callMethod('telephony.externalcall.show', {
        USER_PHONE_INNER: currentUserId,
        USER_ID: BX24.getUser ? BX24.getUser().id : 1,
        CALL_ID: Date.now().toString(),
        TYPE: 1  // outbound
      });
    }

  } catch (err) {
    setStatus('Call failed: ' + err.message);
    document.getElementById('callBtn').disabled = false;
  }
}

// ── Accept incoming ────────────────────────────────────────────
async function acceptCall() {
  if (!webPhone) return;
  try {
    await webPhone.AcceptCall();
    const from = document.getElementById('callerNumber').textContent;
    showActiveCall(from);
  } catch (err) {
    setStatus('Accept failed: ' + err.message);
  }
}

// ── Reject incoming ────────────────────────────────────────────
async function rejectCall() {
  if (!webPhone) return;
  try {
    await webPhone.HangupCall();
    activeCall = null;
    showDialer();
    setStatus('Call rejected');
  } catch (err) {
    setStatus('Reject failed: ' + err.message);
    showDialer();
  }
}

// ── Hangup active call ─────────────────────────────────────────
async function hangUp() {
  if (!webPhone) return;
  try {
    await webPhone.HangupCall();
    activeCall = null;
    showDialer();
    setStatus('Call ended');
  } catch (err) {
    setStatus('Hangup error: ' + err.message);
    showDialer();
  }
}

window.onload = init;
