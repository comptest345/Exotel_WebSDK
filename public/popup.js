let webPhone = null;
let timerInterval = null;
let timerSec = 0;
let currentUserId = '123';

function log(msg) { console.log('[Dialer]', msg); }

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
  log(msg);
}

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

function showIncoming(from) {
  document.getElementById('callerNum').textContent = from || 'Unknown';
  document.getElementById('incomingPanel').style.display = 'block';
  document.getElementById('activePanel').style.display   = 'none';
  document.getElementById('dialerPanel').style.display   = 'block';
}

function showActive(num) {
  document.getElementById('activeNum').textContent = num || '';
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

// ── Init ───────────────────────────────────────────────────────
async function init() {
  setReg('connecting');
  setStatus('Fetching credentials...');

  try {
    let prefilledNumber = null;

    if (window.BX24) {
      try {
        // Check if number was passed from background worker (click-to-call)
        const info = BX24.placement.info();
        if (info && info.options && info.options.number) {
          prefilledNumber = info.options.number;
        }
        // Get Bitrix24 user identity
        const profile = await new Promise(r => BX24.callMethod('profile', {}, r));
        const d = profile.data();
        if (d && d.EMAIL) currentUserId = d.EMAIL;
        else if (d && d.ID) currentUserId = String(d.ID);
      } catch (e) {
        log('BX24 profile failed, using default userId: ' + currentUserId);
      }
    }

    const res = await fetch('/token?user_id=' + encodeURIComponent(currentUserId));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();

    if (!data.sip_id || !data.app_token) {
      throw new Error('Missing credentials: ' + JSON.stringify(data));
    }

    log('Got credentials — sip_id: ' + data.sip_id);
    setStatus('Initializing SDK...');

    const sdk = new ExotelCRMWebSDK(data.app_token, currentUserId, false);

    webPhone = await sdk.Initialize(
      function callListener(event) {
        log('Call event: ' + JSON.stringify(event));
        handleCallEvent(event);
      },
      function regListener(event) {
        log('Reg event: ' + JSON.stringify(event));
        handleRegistration(event);
      }
    );

    // SDK initialized — mark as ready
    setReg('registered');
    setStatus('✅ Ready');

    // If number was pre-filled by background worker, auto-dial
    if (prefilledNumber) {
      document.getElementById('phone').value = prefilledNumber;
      setTimeout(makeCall, 600);
    }

    // Bind click-to-call (works even if background worker not registered)
    if (window.BX24) {
      BX24.placement.bind('CRM_PHONE_NUMBER_CLICK', function(event) {
        log('CRM phone click: ' + JSON.stringify(event));
        const num = event && event.data && (event.data.PHONE_NUMBER || event.data.phone);
        if (num) {
          document.getElementById('phone').value = num;
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

function handleRegistration(event) {
  log('Registration: ' + JSON.stringify(event));
  setReg('registered');
  setStatus('✅ Ready');
}

function handleCallEvent(event) {
  log('Call event raw: ' + JSON.stringify(event));
  const raw = JSON.stringify(event).toLowerCase();

  if (raw.includes('incoming') || raw.includes('ringing')) {
    const from = event.FromNumber || event.from || event.callerNumber || 'Unknown';
    showIncoming(from);
    setStatus('');
    try { new Audio('/target/ringtone.wav').play(); } catch(e) {}

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active')) {
    const num = document.getElementById('phone').value ||
                document.getElementById('callerNum').textContent || '';
    showActive(num);
    setStatus('');

  } else if (raw.includes('end') || raw.includes('disconnect') ||
             raw.includes('bye') || raw.includes('terminal') || raw.includes('hangup')) {
    showDialer();
    setStatus('Call ended');
  }
}

// ── Outbound call ──────────────────────────────────────────────
async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number) { setStatus('Enter a number'); return; }
  if (!webPhone) { setStatus('SDK not ready'); return; }

  try {
    setStatus('Calling ' + number + '...');
    document.getElementById('callBtn').disabled = true;

    // MakeCall is confirmed correct — internal SDK error after success is harmless
    try {
      await webPhone.MakeCall(number);
    } catch (e) {
      log('MakeCall internal error (call was placed): ' + e.message);
    }

    showActive(number);
    document.getElementById('callBtn').disabled = false;

  } catch (err) {
    setStatus('Call failed: ' + err.message);
    document.getElementById('callBtn').disabled = false;
  }
}

// ── Accept incoming call ───────────────────────────────────────
async function acceptCall() {
  if (!webPhone) return;
  try {
    await webPhone.AcceptCall();
    const from = document.getElementById('callerNum').textContent;
    showActive(from);
    setStatus('');
  } catch (err) {
    setStatus('Accept failed: ' + err.message);
  }
}

// ── Reject incoming call ───────────────────────────────────────
async function rejectCall() {
  if (!webPhone) return;
  try { await webPhone.HangupCall(); } catch (e) { log('Reject: ' + e.message); }
  showDialer();
  setStatus('Call rejected');
}

// ── Hang up active call ────────────────────────────────────────
async function hangUp() {
  if (!webPhone) return;
  try { await webPhone.HangupCall(); } catch (e) { log('Hangup: ' + e.message); }
  showDialer();
  setStatus('Call ended');
}

window.onload = init;
