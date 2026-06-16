// ═══════════════════════════════════════════════════════════════
// background.js — Single SDK instance. Owns all SIP/WebRTC audio.
// Popup is a dumb UI — it polls /call-state and sends /call-action.
//
// This page is hidden inside Bitrix24's PAGE_BACKGROUND_WORKER
// placement, so its console is normally invisible to us. Every
// significant step is reported to the server via /client-log so
// it shows up in Render logs.
// ═══════════════════════════════════════════════════════════════

function clientLog(message, extra) {
  console.log('[BGWorker]', message, extra || '');
  try {
    fetch('/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'background.js', message, extra: extra || null, ts: Date.now() })
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}

// Report uncaught errors — this is the only way we can see a crash
// in a hidden iframe we can't open devtools on.
window.onerror = function (msg, url, line, col, err) {
  clientLog('UNCAUGHT ERROR: ' + msg, { url, line, col, stack: err && err.stack });
};
window.addEventListener('unhandledrejection', function (e) {
  clientLog('UNHANDLED PROMISE REJECTION: ' + (e.reason && e.reason.message || e.reason));
});

// First thing that runs — proves the page itself loaded at all.
clientLog('background.html loaded, script executing');

let webPhone      = null;
let sdkReady      = false;          // true only after SIP registers
let queuedCall    = null;           // call that arrived before SDK was ready
let currentCallId = null;
let pollInterval  = null;

const EXOTEL_APP_USER_ID = '123';

// ── Heartbeat: lets server logs prove background.js is alive ───
function startHeartbeat() {
  clientLog('Heartbeat loop starting');
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
  }).catch(e => clientLog('postState error: ' + e.message));
}

// ── Execute a MakeCall — retries once if SDK not ready yet ─────
function executeMakeCall(number, callId) {
  currentCallId = callId || ('ext_' + Date.now());

  if (sdkReady && webPhone) {
    clientLog('MakeCall firing for ' + number);
    try {
      webPhone.MakeCall(number);
      clientLog('MakeCall returned without throwing for ' + number);
    } catch (e) {
      clientLog('MakeCall THREW: ' + e.message, { stack: e.stack });
    }
    postState({ state: 'active', number });
    queuedCall = null;
  } else {
    clientLog('SDK not ready — queuing call to ' + number, { sdkReady, webPhoneExists: !!webPhone });
    queuedCall = { number, callId: currentCallId };
    postState({ state: 'active', number }); // optimistically update popup
  }
}

// ── Poll server for pending calls and actions ──────────────────
// Polling starts IMMEDIATELY at page load — before SDK init —
// so we never miss a call that arrives while the SDK is initialising.
function startPolling() {
  if (pollInterval) return;
  clientLog('Polling loop starting (1s interval)');

  pollInterval = setInterval(async () => {
    try {
      // ── 1. Outbound call queued by BX24 CRM click ─────────────
      const outRes  = await fetch('/pending-call');
      const outData = await outRes.json();
      if (outData.pending && outData.number) {
        clientLog('BX24 outbound pending: ' + outData.number);
        executeMakeCall(outData.number, outData.callId);
      }

      // ── 2. Flush any queued call now that SDK is ready ─────────
      if (sdkReady && webPhone && queuedCall) {
        const q = queuedCall;
        queuedCall = null;
        clientLog('Flushing queued call: ' + q.number);
        try { webPhone.MakeCall(q.number); } catch (e) { clientLog('Queued MakeCall threw: ' + e.message); }
      }

      // ── 3. Actions from popup UI (answer / hangup / makecall) ──
      const actionRes  = await fetch('/pending-action');
      const actionData = await actionRes.json();
      if (actionData && actionData.action) {
        clientLog('Action received: ' + actionData.action + ' ' + (actionData.number || ''));

        if (actionData.action === 'answer') {
          if (sdkReady && webPhone) {
            try { webPhone.AcceptCall(); clientLog('AcceptCall fired'); }
            catch (e) { clientLog('AcceptCall threw: ' + e.message); }
          } else {
            clientLog('AcceptCall skipped — SDK not ready', { sdkReady, webPhoneExists: !!webPhone });
          }

        } else if (actionData.action === 'hangup') {
          if (webPhone) {
            try { webPhone.HangupCall(); clientLog('HangupCall fired'); }
            catch (e) { clientLog('HangupCall threw: ' + e.message); }
          }
          postState({ state: 'idle', from: '', number: '' });
          queuedCall = null;

        } else if (actionData.action === 'makecall') {
          executeMakeCall(actionData.number);
        }
      }

    } catch (e) {
      clientLog('Poll loop error: ' + e.message, { stack: e.stack });
    }
  }, 1000);
}

// ── Handle SDK call events ─────────────────────────────────────
function handleSDKCallEvent(event) {
  const raw = JSON.stringify(event).toLowerCase();
  clientLog('SDK event: ' + raw.slice(0, 200));

  if (raw.includes('incoming') || raw.includes('ringing') || raw.includes('i_new_call')) {
    const from = (event && (event.callFromNumber || event.FromNumber || event.from)) || 'Unknown';
    postState({ state: 'incoming', from });

  } else if (raw.includes('accept') || raw.includes('connect') || raw.includes('active') || raw.includes('connected')) {
    postState({ state: 'active' });

  } else if (raw.includes('end') || raw.includes('disconnect') || raw.includes('terminal') || raw.includes('bye') || raw.includes('terminated')) {
    postState({ state: 'idle', from: '', number: '' });
    currentCallId = null;
    queuedCall = null;
  }
}

// ── Init ───────────────────────────────────────────────────────
async function initBG() {
  clientLog('initBG starting');

  // Start polling and heartbeat immediately — don't wait for SDK
  startPolling();
  startHeartbeat();

  if (typeof ExotelCRMWebSDK === 'undefined') {
    clientLog('FATAL: ExotelCRMWebSDK is undefined — crmBundle.js failed to load or did not execute before background.js');
    return; // polling still runs so calls get queued, but SDK can never init
  }

  // Retry loop: keep trying SDK init until it succeeds
  while (true) {
    try {
      const res = await fetch('/token?user_id=' + encodeURIComponent(EXOTEL_APP_USER_ID));
      if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
      const data = await res.json();
      if (!data.app_token) throw new Error('No app_token: ' + JSON.stringify(data));

      clientLog('Token fetched, initialising SDK...');

      const sdk = new ExotelCRMWebSDK(data.app_token, EXOTEL_APP_USER_ID, false);
      webPhone = await sdk.Initialize(
        function callListener(event) {
          handleSDKCallEvent(event);
        },
        function regListener(event) {
          clientLog('SIP REGISTERED — SDK is now ready');
          sdkReady = true;
          if (queuedCall) {
            const q = queuedCall;
            queuedCall = null;
            clientLog('Executing queued call now that SDK is ready: ' + q.number);
            try { webPhone.MakeCall(q.number); } catch (e) { clientLog('Queued MakeCall (on reg) threw: ' + e.message); }
          }
        }
      );

      clientLog('SDK object created (waiting for SIP registration callback)');
      break; // success — exit retry loop

    } catch (err) {
      clientLog('Init error: ' + err.message + ' — retrying in 5s', { stack: err.stack });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

window.onload = initBG;

// Safety net: in case window.onload never fires (e.g. page already loaded
// by the time this script runs inside the iframe), kick off init directly too.
if (document.readyState === 'complete') {
  clientLog('document already complete — calling initBG directly');
  initBG();
}
