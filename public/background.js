// ═══════════════════════════════════════════════════════════════
// background.js — Single SDK instance. Owns all SIP/WebRTC audio.
// Popup is a dumb UI — it polls /call-state and sends /call-action.
// ═══════════════════════════════════════════════════════════════

let webPhone = null;
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

// ── Post state update to server ───────────────────────────────
function postState(state) {
  fetch('/update-call-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  }).catch(e => console.warn('[BGWorker] postState error:', e.message));
}

// ── Poll server for pending calls and actions ──────────────────
function startPolling() {
  if (pollInterval) return;
  console.log('[BGWorker] Polling /pending-call and /pending-action every 2s');

  pollInterval = setInterval(async () => {
    try {
      // ── Poll for pending outbound call (from BX24 CRM click) ──
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
          // Outbound via WebRTC auto-connects — Exotel dials the customer directly
          postState({ state: 'active', number: outData.number });
        } else {
          console.warn('[BGWorker] webPhone not ready yet');
        }
      }

      // ── Poll for pending action (from popup UI: answer / hangup / makecall) ──
      const actionRes  = await fetch('/pending-action');
      const actionData = await actionRes.json();
      if (actionData && actionData.action) {
        console.log('[BGWorker] ⚡ Pending action:', actionData.action, actionData.number || '');
        if (actionData.action === 'answer') {
          if (webPhone) {
            try { webPhone.AcceptCall(); } catch(e) { console.log('[BGWorker] AcceptCall:', e.message); }
          }
        } else if (actionData.action === 'hangup') {
          if (webPhone) {
            try { webPhone.HangupCall(); } catch(e) { console.log('[BGWorker] HangupCall:', e.message); }
          }
          postState({ state: 'idle', from: '', number: '' });
        } else if (actionData.action === 'makecall') {
          currentCallId = 'ext_' + Date.now();
          if (webPhone) {
            try { webPhone.MakeCall(actionData.number); } catch(e) { console.log('[BGWorker] MakeCall (action):', e.message); }
            postState({ state: 'active', number: actionData.number });
          }
        }
      }

    } catch(e) {
      console.warn('[BGWorker] Poll error:', e.message);
    }
  }, 2000);
}

// ── Handle SDK call events ─────────────────────────────────────
// background.js is the ONLY SDK instance — it posts all state changes
// to the server so popup can reflect them via /call-state polling.
// background.js does NOT make any BX24.callMethod() calls —
// the server handles all BX24 telephony API calls via webhooks.
function handleSDKCallEvent(event) {
  const raw = JSON.stringify(event).toLowerCase();

  if (raw.includes('incoming') || raw.includes('ringing')) {
    const from = (event && (event.callFromNumber || event.FromNumber || event.from)) || 'Unknown';
    console.log('[BGWorker] SDK: Incoming call from:', from);
    // State is already set by /incoming-call webhook on the server.
    // Just update the from number in case the SDK has more detail.
    postState({ state: 'incoming', from: from });
    // Do NOT auto-answer — agent accepts via popup UI (action: 'answer')

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active')) {
    console.log('[BGWorker] SDK: Call connected/active');
    postState({ state: 'active' });

  } else if (raw.includes('end') || raw.includes('disconnect') || raw.includes('terminal') || raw.includes('bye')) {
    console.log('[BGWorker] SDK: Call ended');
    postState({ state: 'idle', from: '', number: '' });
    currentCallId = null;
    // NOTE: BX24 telephony.externalcall.finish is handled by /call-callback webhook on server.
    // Do NOT call it here to avoid double-finishing.
  }
}

window.onload = initBG;
