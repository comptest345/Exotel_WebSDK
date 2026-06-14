// ═══════════════════════════════════════════════════════════════
// background.js — Connects Bitrix24 native call UI to Exotel WebRTC
// ═══════════════════════════════════════════════════════════════

let webPhone = null;
const USER_ID = '123';
let currentCallId = null;
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
        handleSDKCallEvent(event);
      },
      function regListener(event) {
        console.log('[BGWorker] ✅ SIP Registered');
      }
    );

    console.log('[BGWorker] ✅ SDK ready — binding Bitrix24 telephony events');

    if (window.BX24) {
      // ── Outbound: fires when agent clicks phone number in CRM ──
      // Bitrix24 already shows native call UI — we just start the call audio
      BX24.addCustomEvent('onExternalCallStart', function(eventData) {
        console.log('[BGWorker] onExternalCallStart:', JSON.stringify(eventData));
        const number = eventData && (eventData.PHONE_NUMBER || eventData.phone_number);
        const callId = eventData && eventData.CALL_ID;
        if (number && webPhone) {
          currentCallId = callId;
          console.log('[BGWorker] Starting outbound call to:', number);
          try {
            webPhone.MakeCall(number);
          } catch(e) {
            console.log('[BGWorker] MakeCall internal (call placed):', e.message);
          }
        }
      });

      // ── Agent clicks Accept on native incoming call UI ─────────
      BX24.addCustomEvent('onExternalCallAnswer', function(eventData) {
        console.log('[BGWorker] onExternalCallAnswer:', JSON.stringify(eventData));
        if (webPhone) {
          try {
            webPhone.AcceptCall();
            console.log('[BGWorker] Call accepted via SDK');
          } catch(e) {
            console.log('[BGWorker] AcceptCall error:', e.message);
          }
        }
      });

      // ── Agent clicks Hang Up on native UI ─────────────────────
      BX24.addCustomEvent('onExternalCallHangup', function(eventData) {
        console.log('[BGWorker] onExternalCallHangup:', JSON.stringify(eventData));
        if (webPhone) {
          try {
            webPhone.HangupCall();
            console.log('[BGWorker] Call hung up via SDK');
          } catch(e) {
            console.log('[BGWorker] HangupCall error:', e.message);
          }
        }
        currentCallId = null;
      });
    }

    // Poll for inbound calls from server (Exotel → server → background)
    startPolling();

  } catch (err) {
    console.error('[BGWorker] Init failed:', err.message);
    setTimeout(initBG, 30000);
  }
}

// ── Poll server for inbound call notifications ─────────────────
function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      const res  = await fetch('/pending-inbound');
      const data = await res.json();
      if (data.pending && data.from) {
        console.log('[BGWorker] Inbound call detected from:', data.from);
        currentCallId = data.callSid;
        // Bitrix24 native UI already shown by server via telephony.externalcall.show
        // SDK is already receiving the call via SIP — no action needed here
        // Agent will click Accept on native UI which fires onExternalCallAnswer
      }
    } catch(e) { /* silent */ }
  }, 2000);
}

// ── Handle SDK call events — sync state to Bitrix24 native UI ──
function handleSDKCallEvent(event) {
  const raw = JSON.stringify(event).toLowerCase();

  if (raw.includes('incoming') || raw.includes('ringing')) {
    const from = (event && (event.FromNumber || event.from)) || 'Unknown';
    console.log('[BGWorker] SDK: Incoming call from:', from);
    // Native UI is already shown by server — just log here

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active')) {
    console.log('[BGWorker] SDK: Call connected');
    // Notify Bitrix24 the call is now active
    if (window.BX24 && currentCallId) {
      BX24.callMethod('telephony.externalcall.show', {
        CALL_ID: currentCallId,
        USER_ID: '44'
      });
    }

  } else if (raw.includes('end') || raw.includes('disconnect') || raw.includes('terminal') || raw.includes('bye')) {
    console.log('[BGWorker] SDK: Call ended');
    // Finish the call in Bitrix24 CRM
    if (window.BX24 && currentCallId) {
      BX24.callMethod('telephony.externalcall.finish', {
        CALL_ID:     currentCallId,
        USER_ID:     '44',
        DURATION:    0,
        STATUS_CODE: 200
      });
    }
    currentCallId = null;
  }
}

window.onload = initBG;
