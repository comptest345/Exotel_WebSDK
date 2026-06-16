// ═══════════════════════════════════════════════════════════════
// background.js — Connects Bitrix24 native call UI to Exotel WebRTC
// ═══════════════════════════════════════════════════════════════

let webPhone = null;
const EXOTEL_APP_USER_ID = '123'; // Exotel AppUserId
let currentCallId = null;
let callType      = null; // 'inbound' | 'outbound'
let pollInterval  = null;
let callStartTime = 0;

async function initBG() {
  console.log('[BGWorker] Starting...');
  try {
    const res = await fetch('/token?user_id=' + encodeURIComponent(EXOTEL_APP_USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    if (!data.app_token) throw new Error('No app_token: ' + JSON.stringify(data));

    console.log('[BGWorker] Got credentials, initializing SDK...');
    const sdk = new ExotelCRMWebSDK(data.app_token, EXOTEL_APP_USER_ID, false);
    webPhone = await sdk.Initialize(
      function callListener(event) {
        console.log('[BGWorker] Call event:', JSON.stringify(event));
        handleSDKCallEvent(event);
      },
      function regListener(event) {
        console.log('[BGWorker] ✅ SIP Registered');
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

// ── Poll for pending calls from server ─────────────────────────
function startPolling() {
  if (pollInterval) return;
  console.log('[BGWorker] Polling /pending-call every 2s');
  pollInterval = setInterval(async () => {
    try {
      // Outbound triggered from BX24 CRM click-to-call
      const outRes  = await fetch('/pending-call');
      const outData = await outRes.json();
      if (outData.pending && outData.number) {
        console.log('[BGWorker] 📞 Outbound click-to-call:', outData.number);
        callType      = 'outbound';
        currentCallId = outData.callId;
        if (webPhone) {
          try {
            webPhone.MakeCall(outData.number);
            console.log('[BGWorker] MakeCall fired for:', outData.number);
          } catch(e) {
            console.log('[BGWorker] MakeCall internal (call placed):', e.message);
          }
          // Notify BX24 native call UI: outbound — no answer required on our side
          if (window.BX24 && currentCallId) {
            BX24.callMethod('telephony.externalcall.show', {
              CALL_ID: currentCallId,
              USER_ID: '44'
            });
          }
        } else {
          console.warn('[BGWorker] webPhone not ready yet');
        }
        return; // skip inbound check this tick
      }

      // Inbound call notified by server webhook
      const inRes  = await fetch('/pending-inbound');
      const inData = await inRes.json();
      if (inData.pending && inData.from) {
        console.log('[BGWorker] 📲 Inbound from:', inData.from);
        callType      = 'inbound';
        currentCallId = inData.callSid;
        // NOTE: actual ringing + accept/reject UI is handled by popup.js via SDK event.
        // We do NOT show BX24 native call card here — that would add a second accept button.
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
    callType = 'inbound';
    // Inbound: do NOT call telephony.externalcall.register here —
    // that opens BX24 native card with its own Accept button.
    // The Exotel dialer popup handles accept/reject exclusively.

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active')) {
    console.log('[BGWorker] SDK: Call connected — type:', callType);
    callStartTime = Date.now();
    // For OUTBOUND: show BX24 native card (click-to-call context)
    // For INBOUND: card already open in popup — no BX24 card needed
    if (callType === 'outbound' && window.BX24 && currentCallId) {
      BX24.callMethod('telephony.externalcall.show', {
        CALL_ID: currentCallId,
        USER_ID: '44'
      });
    }

  } else if (
    raw.includes('end') || raw.includes('disconnect') ||
    raw.includes('terminal') || raw.includes('bye')
  ) {
    console.log('[BGWorker] SDK: Call ended — type:', callType);
    const duration = callStartTime ? Math.round((Date.now() - callStartTime) / 1000) : 0;
    if (window.BX24 && currentCallId) {
      BX24.callMethod('telephony.externalcall.finish', {
        CALL_ID:     currentCallId,
        USER_ID:     '44',
        DURATION:    duration,
        STATUS_CODE: 200
      });
    }
    currentCallId = null;
    callType      = null;
    callStartTime = 0;
  }
}

window.onload = initBG;
