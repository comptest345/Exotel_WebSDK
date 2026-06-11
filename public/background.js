// ═══════════════════════════════════════════════════════════════
// background.js — Always-on silent worker
// Runs in PAGE_BACKGROUND_WORKER placement (invisible iframe)
// Handles: SIP registration, inbound call detection, click-to-call
// ═══════════════════════════════════════════════════════════════

let webPhone = null;
const USER_ID = '123'; // Fixed — matches AppUserId in Exotel

async function initBG() {
  console.log('[BGWorker] Starting initialization...');
  try {
    // Fetch SIP credentials from server
    const res = await fetch('/token?user_id=' + encodeURIComponent(USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    if (!data.app_token) throw new Error('No app_token in response');

    console.log('[BGWorker] Credentials received, initializing SDK...');

    // Initialize WebRTC SDK
    const sdk = new ExotelCRMWebSDK(data.app_token, USER_ID, false);

    webPhone = await sdk.Initialize(
      function callListener(event) {
        console.log('[BGWorker] Call event:', JSON.stringify(event));
        handleInboundCall(event);
      },
      function regListener(event) {
        console.log('[BGWorker] ✅ SIP Registered successfully');
      }
    );

    console.log('[BGWorker] ✅ SDK ready');

    // Bind CRM phone number click-to-call
    if (window.BX24) {
      BX24.placement.bind('CRM_PHONE_NUMBER_CLICK', function(event) {
        console.log('[BGWorker] CRM phone click:', JSON.stringify(event));
        const number = event && event.data &&
                       (event.data.PHONE_NUMBER || event.data.phone);
        if (number) {
          console.log('[BGWorker] Opening dialer with number:', number);
          // Open the dialer popup with number pre-filled
          BX24.openApplication({ number: number });
        }
      });
      console.log('[BGWorker] CRM_PHONE_NUMBER_CLICK bound');
    }

  } catch (err) {
    console.error('[BGWorker] Init failed:', err.message);
    // Retry after 30 seconds on failure
    setTimeout(initBG, 30000);
  }
}

function handleInboundCall(event) {
  const raw = JSON.stringify(event).toLowerCase();

  if (raw.includes('incoming') || raw.includes('ringing')) {
    const from = (event && (event.FromNumber || event.from || event.callerNumber)) || 'Unknown';
    console.log('[BGWorker] 📲 Incoming call from:', from);

    // Open popup with incoming call info
    if (window.BX24) {
      BX24.openApplication({
        incomingFrom: from,
        callSid: (event && event.callSid) || ''
      });
    }
  }
}

window.onload = initBG;
