let webPhone = null;
let currentUserId = '123';

async function initBackground() {
  console.log('[BGWorker] Starting...');

  try {
    // Get Bitrix24 user identity
    if (window.BX24) {
      try {
        const profile = await new Promise(r => BX24.callMethod('profile', {}, r));
        const d = profile.data();
        if (d?.EMAIL) currentUserId = d.EMAIL;
        else if (d?.ID) currentUserId = String(d.ID);
      } catch (e) {
        console.warn('[BGWorker] BX24 profile failed:', e);
      }
    }

    // Fetch SIP credentials from your server
    const res = await fetch(`/token?user_id=${encodeURIComponent(currentUserId)}`);
    const data = await res.json();

    if (!data.sip_id || !data.sip_secret || !data.app_token) {
      throw new Error('Missing credentials: ' + JSON.stringify(data));
    }

    console.log('[BGWorker] Credentials fetched, initializing SDK...');

    const sdk = new ExotelCRMWebSDK(data.app_token, currentUserId, false);

    webPhone = await sdk.Initialize(
      function callListener(event) {
        console.log('[BGWorker] Call event:', JSON.stringify(event));
        handleInboundCall(event);
      },
      function registrationListener(event) {
        console.log('[BGWorker] Registered:', JSON.stringify(event));
      }
    );

    console.log('[BGWorker] ✅ SDK ready, binding phone click...');

    // ✅ THIS is what was missing before — binding happens immediately
    // because the background worker is already alive when the page loads
    BX24.placement.bind('CRM_PHONE_NUMBER_CLICK', function(event) {
      console.log('[BGWorker] Phone click:', JSON.stringify(event));
      const number = event?.data?.PHONE_NUMBER || event?.data?.phone;
      if (number) {
        // Open the dialer popup with the number pre-filled
        BX24.openApplication({ number: number });
      }
    });

  } catch (err) {
    console.error('[BGWorker] Init failed:', err);
    // Retry after 30 seconds if init fails
    setTimeout(initBackground, 30000);
  }
}

// ── Handle inbound call notification ──────────────────────────
function handleInboundCall(event) {
  const raw = JSON.stringify(event).toLowerCase();

  if (raw.includes('incoming') || raw.includes('ringing')) {
    const from = event?.FromNumber || event?.from || event?.callerNumber || 'Unknown';
    console.log('[BGWorker] Incoming call from:', from);

    // Show Bitrix24 native call popup
    BX24.callMethod('telephony.externalcall.show', {
      USER_PHONE_INNER: currentUserId,
      USER_ID: 1,
      CALL_ID: event?.callSid || Date.now().toString(),
      TYPE: 2  // inbound
    });

    // Open your dialer popup so agent can accept/reject
    BX24.openApplication({ incomingFrom: from, callSid: event?.callSid });
  }
}

window.onload = initBackground;
