// ═══════════════════════════════════════════════════════════════
// background.js — Connects Bitrix24 native call UI to Exotel WebRTC
// FIX: Corrected broken function structure + startPolling() now called
// ═══════════════════════════════════════════════════════════════

let webPhone = null;
// USER_ID must match the AppUserId you used in /create-user for Exotel.
// From your Bitrix24 logs, your user ID is 44 — match it here.
const USER_ID = '44';
let currentCallId = null;
let pollInterval = null;

async function initBG() {
  console.log('[BGWorker] Starting...');
  try {
    const res = await fetch('/token?user_id=' + encodeURIComponent(USER_ID));
    if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
    const data = await res.json();
    if (!data.app_token) throw new Error('No app_token in response: ' + JSON.stringify(data));

    console.log('[BGWorker] Got credentials, initializing SDK...');

    const sdk = new ExotelCRMWebSDK(data.app_token, USER_ID, false);
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
    // Start polling immediately too — regListener may fire before this line
    startPolling();

  } catch (err) {
    console.error('[BGWorker] Init error:', err.message);
    // Retry after 5 seconds on failure
    setTimeout(initBG, 5000);
  }
}

// ── Poll server for pending calls ─────────────────────────────
function startPolling() {
  if (pollInterval) return; // already running, don't double-start
  console.log('[BGWorker] Polling /pending-call every 2s');
  pollInterval = setInterval(async () => {
    try {
      // Check for outbound call from CRM click
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
          console.warn('[BGWorker] webPhone not ready yet — call will be retried next poll if still pending');
        }
      }

      // Check for inbound
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

// ── Handle SDK call events — sync state to Bitrix24 native UI ──
function handleSDKCallEvent(event) {
  const raw = JSON.stringify(event).toLowerCase();

  if (raw.includes('incoming') || raw.includes('ringing')) {
    const from = (event && (event.FromNumber || event.from)) || 'Unknown';
    console.log('[BGWorker] SDK: Incoming call from:', from);
    // Native UI is already shown by server — just log here

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active')) {
    console.log('[BGWorker] SDK: Call connected');
    if (window.BX24 && currentCallId) {
      BX24.callMethod('telephony.externalcall.show', {
        CALL_ID: currentCallId,
        USER_ID: USER_ID
      });
    }

  } else if (raw.includes('end') || raw.includes('disconnect') || raw.includes('terminal') || raw.includes('bye')) {
    console.log('[BGWorker] SDK: Call ended');
    if (window.BX24 && currentCallId) {
      BX24.callMethod('telephony.externalcall.finish', {
        CALL_ID:     currentCallId,
        USER_ID:     USER_ID,
        DURATION:    0,
        STATUS_CODE: 200
      });
    }
    currentCallId = null;
  }
}

window.onload = initBG;
