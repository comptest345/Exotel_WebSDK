let webPhone = null;
let currentUserId = '123';

async function initBG() {
  console.log('[BGWorker] Starting...');
  try {
    if (window.BX24) {
      try {
        const profile = await new Promise(r => BX24.callMethod('profile', {}, r));
        const d = profile.data();
        if (d && d.EMAIL) currentUserId = d.EMAIL;
        else if (d && d.ID) currentUserId = String(d.ID);
      } catch (e) { console.warn('[BGWorker] profile failed:', e); }
    }

    const res = await fetch('/token?user_id=' + encodeURIComponent(currentUserId));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    if (!data.app_token) throw new Error('No app_token in response');

    console.log('[BGWorker] Got credentials, initializing SDK...');

    const sdk = new ExotelCRMWebSDK(data.app_token, currentUserId, false);

    webPhone = await sdk.Initialize(
      function callListener(event) {
        console.log('[BGWorker] Call event:', JSON.stringify(event));
        handleCall(event);
      },
      function regListener(event) {
        console.log('[BGWorker] ✅ SIP Registered');
      }
    );

    console.log('[BGWorker] ✅ SDK ready — binding click-to-call');

    // ── Intercept CRM phone number clicks ─────────────────────
    if (window.BX24) {
      BX24.placement.bind('CRM_PHONE_NUMBER_CLICK', function(event) {
        console.log('[BGWorker] Phone click:', JSON.stringify(event));
        const number = (event && event.data) &&
                       (event.data.PHONE_NUMBER || event.data.phone);
        if (number) {
          // Open the visible dialer popup with number pre-filled
          BX24.openApplication({ number: number });
        }
      });
    }

  } catch (err) {
    console.error('[BGWorker] Init failed:', err.message);
    // Retry after 30 seconds
    setTimeout(initBG, 30000);
  }
}

function handleCall(event) {
  const raw = JSON.stringify(event).toLowerCase();
  if (raw.includes('incoming') || raw.includes('ringing')) {
    const from = (event && (event.FromNumber || event.from || event.callerNumber)) || 'Unknown';
    console.log('[BGWorker] Incoming call from:', from);
    // Open the dialer popup so agent can accept/reject
    if (window.BX24) {
      BX24.openApplication({ incomingFrom: from, callSid: event.callSid || '' });
    }
  }
}

window.onload = initBG;
