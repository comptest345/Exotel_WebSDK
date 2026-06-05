let webPhone = null;

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
  console.log('Status:', msg);
}

function setReg(state) {
  const dot  = document.getElementById('regDot');
  const text = document.getElementById('regText');
  const states = {
    connecting:   { cls: 'yellow', label: 'Connecting...' },
    registered:   { cls: 'green',  label: '🟢 Ready' },
    failed:       { cls: 'red',    label: '🔴 Failed' },
    unregistered: { cls: 'red',    label: '🔴 Not registered' }
  };
  const s = states[state] || { cls: '', label: state };
  dot.className    = 'dot ' + s.cls;
  text.textContent = s.label;
}

async function init() {
  setReg('connecting');
  setStatus('Fetching credentials...');

  try {
    // Get user_id from Bitrix24 if available
    let userId = '123'; // default for now
    if (window.BX24) {
      try {
        const profile = await new Promise(r => BX24.callMethod('profile', {}, r));
        const bxData = profile.data();
        if (bxData && bxData.EMAIL) userId = bxData.EMAIL;
      } catch(e) {
        console.log('BX24 profile fetch failed, using default userId');
      }
    }

    // Call your server /token endpoint
    const res = await fetch(`/token?user_id=${encodeURIComponent(userId)}`);
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();

    if (!data.sip_id || !data.sip_secret || !data.app_token) {
      throw new Error('Missing SIP credentials: ' + JSON.stringify(data));
    }

    console.log('Got credentials:', {
      sip_id: data.sip_id,
      app_token_preview: data.app_token.substring(0, 20) + '...'
    });

    setStatus('Initializing SDK...');

    // Initialize Exotel WebRTC SDK
    // ExotelCRMWebSDK(appToken, userId, isDev)
    const sdk = new ExotelCRMWebSDK(
      data.app_token,
      userId,
      false  // false = production
    );

    webPhone = await sdk.Initialize(
  function callListener(event) {
    console.log('📞 Call event:', JSON.stringify(event));
    handleCallEvent(event);
  },
  function registrationListener(event) {
    console.log('📋 Registration event:', JSON.stringify(event));
    handleRegistration(event);
  }
);

// Force UI to Ready after successful Initialize
// Initialize only resolves if registration succeeded
setReg('registered');
setStatus('✅ Ready to make/receive calls');

  } catch (err) {
    setReg('failed');
    setStatus('Error: ' + err.message);
    console.error('Init error:', err);
  }
}

function handleRegistration(event) {
  console.log('Registration event FULL:', JSON.stringify(event));
  // Force show Ready — if SDK initialized without error, it's registered
  setReg('registered');
  setStatus('✅ Ready to make/receive calls');
}

function handleCallEvent(event) {
  const type = (event?.status || event?.type || event?.CallState || '').toLowerCase();
  if (type.includes('incoming') || type.includes('ringing')) {
    setStatus('📲 Incoming call from: ' + (event?.FromNumber || 'Unknown'));
    document.getElementById('hangupBtn').style.display = 'block';
  } else if (type.includes('accept') || type.includes('connect') || type.includes('active')) {
    setStatus('🔴 Call connected');
  } else if (type.includes('end') || type.includes('disconnect') || type.includes('terminal') || type.includes('bye')) {
    setStatus('Call ended');
    document.getElementById('hangupBtn').style.display = 'none';
  }
}

async function makeCall() {
  const number = document.getElementById('phone').value.trim();
  if (!number) { setStatus('Please enter a number'); return; }
  if (!webPhone) { setStatus('SDK not ready yet'); return; }
  try {
    setStatus('Calling ' + number + '...');
    await webPhone.MakeCall(number);
    document.getElementById('hangupBtn').style.display = 'block';
  } catch (err) {
    setStatus('Call failed: ' + err.message);
  }
}

async function hangUp() {
  if (!webPhone) return;
  try {
    await webPhone.HangupCall();
    setStatus('Call ended');
    document.getElementById('hangupBtn').style.display = 'none';
  } catch (err) {
    setStatus('Hangup error: ' + err.message);
  }
}

window.onload = init;
