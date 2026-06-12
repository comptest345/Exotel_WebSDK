// ═══════════════════════════════════════════════════════════════
// background.js — Always-on silent worker (PAGE_BACKGROUND_WORKER)
// Handles: SIP registration, click-to-call, inbound detection
// ═══════════════════════════════════════════════════════════════

let webPhone = null;
const USER_ID = '123';
let pollInterval = null;

async function initBG() {
  console.log('[BGWorker] Starting...');
  try {
    const res = await fetch('/token?user_id=' + encodeURIComponent(USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    if (!data.app_token) throw new Error('No app_token');

    console.log('[BGWorker] Got credentials, initializing SDK...');

    const sdk = new ExotelCRMWebSDK(data.app_token, USER_ID, false);
    webPhone = await sdk.Initialize(
      function callListener(event) {
        console.log('[BGWorker] Call event:', JSON.stringify(event));
        handleCall(event);
      },
      function regListener(event) {
        console.log('[BGWorker] ✅ SIP Registered');
      }
    );

    console.log('[BGWorker] ✅ SDK ready');

    // Start polling for pending calls from server
    startPolling();

    // Bind CRM phone click — fallback if telephony line routing doesn't work
    if (window.BX24) {
      BX24.placement.bind('CRM_PHONE_NUMBER_CLICK', function(event) {
        console.log('[BGWorker] CRM phone click:', JSON.stringify(event));
        const number = event && event.data && (event.data.PHONE_NUMBER || event.data.phone);
        if (number) {
          console.log('[BGWorker] Dialing from CRM click:', number);
          makeOutboundCall(number);
        }
      });

      // Listen for OnExternalCallStart (registered telephony line)
      BX24.addCustomEvent('onExternalCallStart', function(data) {
        console.log('[BGWorker] OnExternalCallStart:', JSON.stringify(data));
        const number = data && (data.PHONE_NUMBER || data.phone_number);
        if (number) makeOutboundCall(number);
      });
    }

  } catch (err) {
    console.error('[BGWorker] Init failed:', err.message);
    setTimeout(initBG, 30000);
  }
}

// ── Poll server for pending outbound calls ─────────────────────
function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      // Check for outbound call triggered by Bitrix24 CRM click
      const outRes = await fetch('/pending-call');
      const outData = await outRes.json();
      if (outData.pending && outData.number) {
        console.log('[BGWorker] Pending outbound call:', outData.number);
        makeOutboundCall(outData.number);
      }

      // Check for inbound call notification from server
      const inRes = await fetch('/pending-inbound');
      const inData = await inRes.json();
      if (inData.pending && inData.from) {
        console.log('[BGWorker] Pending inbound call from:', inData.from);
        // Open popup so agent can accept
        if (window.BX24) {
          BX24.openApplication({ incomingFrom: inData.from, callSid: inData.callSid || '' });
        }
      }
    } catch (e) {
      // Silent fail — polling continues
    }
  }, 2000); // Poll every 2 seconds
}

// ── Make outbound call ─────────────────────────────────────────
function makeOutboundCall(number) {
  if (!webPhone) {
    console.warn('[BGWorker] webPhone not ready, opening popup for manual dial');
    if (window.BX24) BX24.openApplication({ number: number });
    return;
  }
  // Open popup with number pre-filled so agent sees the call UI
  if (window.BX24) {
    BX24.openApplication({ number: number });
  }
}

// ── Handle inbound call from SDK ───────────────────────────────
function handleCall(event) {
  const raw = JSON.stringify(event).toLowerCase();
  if (raw.includes('incoming') || raw.includes('ringing')) {
    const from = (event && (event.FromNumber || event.from || event.callerNumber)) || 'Unknown';
    console.log('[BGWorker] 📲 Incoming call from:', from);
    if (window.BX24) {
      BX24.openApplication({ incomingFrom: from, callSid: (event && event.callSid) || '' });
    }
  }
}

window.onload = initBG;
