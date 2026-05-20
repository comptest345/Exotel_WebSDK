let webPhone = null;
let activeCall = null;

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function setReg(state) {
  const dot  = document.getElementById('regDot');
  const text = document.getElementById('regText');
  const map = {
    connecting: { cls: 'yellow', label: 'Connecting...' },
    registered: { cls: 'green',  label: 'Ready' },
    failed:     { cls: 'red',    label: 'Registration failed' },
    unregistered: { cls: 'red',  label: 'Not registered' },
  };
  const s = map[state] || { cls: '', label: state };
  dot.className  = 'dot ' + s.cls;
  text.textContent = s.label;
}

async function init() {
  setReg('connecting');

  try {
    // Get agent user ID from Bitrix24 (if available), else fallback
    let userId = 'agent_default';
    if (window.BX24) {
      const profile = await new Promise(r => BX24.callMethod('profile', {}, r));
      userId = 'bx_' + (profile?.data()?.ID || 'unknown');
    }

    const res  = await fetch(`/token?user_id=${encodeURIComponent(userId)}`);
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();

    const accessToken = data.access_token || data.token;
    if (!accessToken) throw new Error('No access_token in response: ' + JSON.stringify(data));

    const sdk = new ExotelCRMWebSDK(accessToken, userId, true);

    webPhone = await sdk.Initialize(
      function callListener(event) {
        console.log('Call event:', event);
        handleCallEvent(event);
      },
      function registrationListener(event) {
        console.log('Registration event:', event);
        handleRegistration(event);
      }
    );

    // ── Click-to-call: intercept Bitrix24 phone number clicks ──
    if (window.BX24) {
      BX24.placement.bind('CRM_PHONE_NUMBER_CLICK', function(event) {
        const number = event?.data?.PHONE_NUMBER;
        if (number) {
          document.getElementById('phone').value = number;
          makeCall();
        }
      });
    }

    setStatus('SDK initialized');

  } catch (err) {
    setReg('failed');
    setStatus('Error: ' + err.message);
    console.error(err);
  }
}

function handleRegistration(event) {
  const state = (event?.status || event?.type || '').toLowerCase();
  if (state.includes('success') || state.includes('register')) {
    setReg('registered');
  } else if (state.includes('fail') || state.includes('error')) {
    setReg('failed');
    setStatus('Registration error: ' + JSON.stringify(event));
  }
}

function handleCallEvent(event) {
  const type = (event?.status || event?.type || '').toLowerCase();
  if (type.includes('incoming')) {
    setStatus('📲 Incoming call...');
    activeCall = event;
    document.getElementById('hangupBtn').style.display = 'block';
  } else if (type.includes('accept') || type.includes('connect')) {
    setStatus('🔴 Call connected');
  } else if (type.includes('end') || type.includes('disconnect') || type.includes('bye')) {
    setStatus('Call ended');
    activeCall = null;
    document.getElementById('hangupBtn').style.display = 'none';
  }
}

async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number) { setStatus('Please enter a number'); return; }
  if (!webPhone) { setStatus('SDK not ready yet'); return; }

  try {
    setStatus('Calling ' + number + '...');
    activeCall = await webPhone.MakeCall(number);
    document.getElementById('hangupBtn').style.display = 'block';
  } catch (err) {
    setStatus('Call failed: ' + err.message);
    console.error(err);
  }
}

async function hangUp() {
  if (!webPhone) return;
  try {
    await webPhone.HangupCall();
    setStatus('Call ended');
    document.getElementById('hangupBtn').style.display = 'none';
    activeCall = null;
  } catch (err) {
    setStatus('Hangup error: ' + err.message);
  }
}

window.onload = init;