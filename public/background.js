// ═══════════════════════════════════════════════════════════════
// background.js — Connects Bitrix24 native call UI to Exotel WebRTC
// ═══════════════════════════════════════════════════════════════

let webPhone = null;
// EXOTEL_APP_USER_ID — the AppUserId you used when calling /create-user on Exotel.
// This is '123' (your Exotel side ID), NOT the Bitrix24 user ID (44).
const EXOTEL_APP_USER_ID = '123';
let currentCallId = null;
let pollInterval = null;

async function initBG() {
  console.log('[BGWorker] Starting...');
  try {
    const res = await fetch('/token?user_id=' + encodeURIComponent(EXOTEL_APP_USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    if (!data.app_token) throw new Error('No app_token in response: ' + JSON.stringify(data));

    console.log('[BGWorker] Got credentials, initializing SDK...');

    const sdk = new ExotelCRMWebSDK(data.app_token, EXOTEL_APP_USER_ID, false);
    webPhone = await sdk.Initialize(
      function callListener(event) {
        console.log('[BGWorker] Call event:', JSON.stringify(event));
        handleSDKCallEvent(event);
      },
      function regListener(event) {
        console.log('[BGWorker] ✅ SIP Registered — starting poll');
        startPolling();
      }
    );

    console.log('[BGWorker] ✅ SDK ready');
    startPolling();

  } catch (err) {
    console.error('[BGWorker] Init error:', err.message);
    setTimeout(initBG, 5000);
  }
}

// ── Poll server for pending calls ─────────────────────────────
function startPolling() {
  if (pollInterval) return;
  console.log('[BGWorker] Polling /pending-call every 2s');
  pollInterval = setInterval(async () => {
    try {
      const outRes  = await fetch('/pending-call');
      const outData = await outRes.json();
      if (outData.pending && outData.number) {
        console.log('[BGWorker] 📞 Outbound call to:', outData.number);
        currentCallId = outData.callId;
        if (webPhone) {
          try {
            webPhone.MakeCall(outData.number);
            console.log('[BGWorker] MakeCall fired for:', outData.number);
          } catch(e) {
            console.log('[BGWorker] MakeCall internal (call placed):', e.message);
          }
        } else {
          console.warn('[BGWorker] webPhone not ready yet');
        }
      }

      const inRes  = await fetch('/pending-inbound');
      const inData = await inRes.json();
      if (inData.pending && inData.from) {
        console.log('[BGWorker] 📲 Inbound from:', inData.from);
        currentCallId = inData.callSid;
      }
    } catch(e) {
      console.warn('[BGWorker] Poll error:', e.message);
    }
  }, 2000);
}

// ── Handle SDK call events ─────────────────────────────────────
function handleSDKCallEvent(event) {
  const raw = JSON.stringify(event).toLowerCase();

  if (raw.includes('incoming') || raw.includes('ringing')) {
    const from = (event && (event.FromNumber || event.from)) || 'Unknown';
    console.log('[BGWorker] SDK: Incoming call from:', from);

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active')) {
    console.log('[BGWorker] SDK: Call connected');
    if (window.BX24 && currentCallId) {
      BX24.callMethod('telephony.externalcall.show', {
        CALL_ID: currentCallId,
        USER_ID: '44'  // BX24 user ID for Bitrix24 API calls
      });
    }

  } else if (raw.includes('end') || raw.includes('disconnect') || raw.includes('terminal') || raw.includes('bye')) {
    console.log('[BGWorker] SDK: Call ended');
    if (window.BX24 && currentCallId) {
      BX24.callMethod('telephony.externalcall.finish', {
        CALL_ID:     currentCallId,
        USER_ID:     '44',  // BX24 user ID for Bitrix24 API calls
        DURATION:    0,
        STATUS_CODE: 200
      });
    }
    currentCallId = null;
  }
}

window.onload = initBG;
