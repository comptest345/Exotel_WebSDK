// ═══════════════════════════════════════════════════════════════
// background.js — Single SDK instance. Owns all SIP/WebRTC audio.
// Popup is a dumb UI — it polls /call-state and sends /call-action.
// ═══════════════════════════════════════════════════════════════

let webPhone     = null;
let sdkReady     = false;          // true only after SIP registers
let queuedCall   = null;           // call that arrived before SDK was ready
let currentCallId = null;
let pollInterval  = null;

const EXOTEL_APP_USER_ID = '123';

// ── Heartbeat: lets server logs prove background.js is alive ───
function startHeartbeat() {
  setInterval(() => {
    fetch('/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdkReady, ts: Date.now() })
    }).catch(() => {});
  }, 10000);
}

// ── Post state update to server ───────────────────────────────
function postState(state) {
  fetch('/update-call-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  }).catch(e => console.warn('[BGWorker] postState error:', e.message));
}

// ── Execute a MakeCall — retries once if SDK not ready yet ─────
function executeMakeCall(number, callId) {
  currentCallId = callId || ('ext_' + Date.now());

  if (sdkReady && webPhone) {
    console.log('[BGWorker] 📞 MakeCall →', number);
    try { webPhone.MakeCall(number); } catch(e) { console.log('[BGWorker] MakeCall threw (normal):', e.message); }
    postState({ state: 'active', number });
    queuedCall = null;
  } else {
    // SDK not ready — queue and retry when regListener fires
    console.warn('[BGWorker] SDK not ready — queuing call to', number);
    queuedCall = { number, callId: currentCallId };
    postState({ state: 'active', number }); // optimistically update popup
  }
}

// ── Poll server for pending calls and actions ──────────────────
// IMPORTANT: polling starts IMMEDIATELY at page load — before SDK init —
// so we never miss a call that arrives while the SDK is initialising.
function startPolling() {
  if (pollInterval) return;
  console.log('[BGWorker] Polling every 1s');

  pollInterval = setInterval(async () => {
    try {
      // ── 1. Outbound call queued by BX24 CRM click ─────────────
      const outRes  = await fetch('/pending-call');
      const outData = await outRes.json();
      if (outData.pending && outData.number) {
        console.log('[BGWorker] BX24 outbound pending:', outData.number);
        executeMakeCall(outData.number, outData.callId);
      }

      // ── 2. Flush any queued call now that SDK is ready ─────────
      if (sdkReady && webPhone && queuedCall) {
        const q = queuedCall;
        queuedCall = null;
        console.log('[BGWorker] Flushing queued call:', q.number);
        try { webPhone.MakeCall(q.number); } catch(e) { console.log('[BGWorker] Queued MakeCall threw:', e.message); }
      }

      // ── 3. Actions from popup UI (answer / hangup / makecall) ──
      const actionRes  = await fetch('/pending-action');
      const actionData = await actionRes.json();
      if (actionData && actionData.action) {
        console.log('[BGWorker] ⚡ Action:', actionData.action, actionData.number || '');

        if (actionData.action === 'answer') {
          if (sdkReady && webPhone) {
            try { webPhone.AcceptCall(); } catch(e) { console.log('[BGWorker] AcceptCall:', e.message); }
          }

        } else if (actionData.action === 'hangup') {
          if (webPhone) {
            try { webPhone.HangupCall(); } catch(e) { console.log('[BGWorker] HangupCall:', e.message); }
          }
          postState({ state: 'idle', from: '', number: '' });
          queuedCall = null;

        } else if (actionData.action === 'makecall') {
          executeMakeCall(actionData.number);
        }
      }

    } catch(e) {
      console.warn('[BGWorker] Poll error:', e.message);
    }
  }, 1000); // poll every 1 second (was 2s — tighter window for pending calls)
}

// ── Handle SDK call events ─────────────────────────────────────
function handleSDKCallEvent(event) {
  const raw = JSON.stringify(event).toLowerCase();
  console.log('[BGWorker] SDK event raw:', raw.slice(0, 120));

  if (raw.includes('incoming') || raw.includes('ringing') || raw.includes('i_new_call')) {
    const from = (event && (event.callFromNumber || event.FromNumber || event.from)) || 'Unknown';
    console.log('[BGWorker] SDK: Incoming call from:', from);
    postState({ state: 'incoming', from });

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active') || raw.includes('connected')) {
    console.log('[BGWorker] SDK: Call connected');
    postState({ state: 'active' });

  } else if (raw.includes('end') || raw.includes('disconnect') || raw.includes('terminal') || raw.includes('bye') || raw.includes('terminated')) {
    console.log('[BGWorker] SDK: Call ended');
    postState({ state: 'idle', from: '', number: '' });
    currentCallId = null;
    queuedCall = null;
  }
}

// ── Init ───────────────────────────────────────────────────────
async function initBG() {
  console.log('[BGWorker] Starting...');

  // Start polling and heartbeat immediately — don't wait for SDK
  startPolling();
  startHeartbeat();

  // Retry loop: keep trying SDK init until it succeeds
  while (true) {
    try {
      const res = await fetch('/token?user_id=' + encodeURIComponent(EXOTEL_APP_USER_ID));
      if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
      const data = await res.json();
      if (!data.app_token) throw new Error('No app_token: ' + JSON.stringify(data));

      console.log('[BGWorker] Got token, initialising SDK...');

      const sdk = new ExotelCRMWebSDK(data.app_token, EXOTEL_APP_USER_ID, false);
      webPhone = await sdk.Initialize(
        function callListener(event) {
          console.log('[BGWorker] Call event:', JSON.stringify(event));
          handleSDKCallEvent(event);
        },
        function regListener(event) {
          console.log('[BGWorker] ✅ SIP Registered');
          sdkReady = true;
          // Flush any call that arrived during SDK init
          if (queuedCall) {
            console.log('[BGWorker] SDK now ready — executing queued call:', queuedCall.number);
            const q = queuedCall;
            queuedCall = null;
            try { webPhone.MakeCall(q.number); } catch(e) { console.log('[BGWorker] Queued MakeCall (reg):', e.message); }
          }
        }
      );

      console.log('[BGWorker] ✅ SDK object ready (SIP registration in progress)');
      break; // success — exit retry loop

    } catch (err) {
      console.error('[BGWorker] Init error:', err.message, '— retrying in 5s');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

window.onload = initBG;
