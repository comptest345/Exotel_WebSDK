// ═══════════════════════════════════════════════════════════════
// background.js — Multi-agent version
// Registers Bitrix24 telephony + handles BX24 events.
// BX24 user is resolved dynamically — no hardcoded IDs.
//
// NOTE: BX24.openApplication() is intentionally NOT called here.
// The popup.html is a CRM_ACTIVITY_SIDEBAR — it is already open
// on the CRM page. The server pushes an SSE outbound_call event
// to the sidebar via /bx24-call-start. Calling openApplication()
// from the background page triggers BX24's own native call card
// UI instead of the Exotel sidebar, which is the wrong behaviour.
// ═══════════════════════════════════════════════════════════════

let currentCallId  = null;
let currentCallNum = null;
let callStartTime  = 0;

function bgLog(msg) { console.log('[BGWorker]', msg); }

function initBG() {
  bgLog('Starting...');
  if (!window.BX24) { bgLog('BX24 not available'); return; }

  BX24.init(function () {
    bgLog('BX24 ready');

    // ── Outbound click-to-call from CRM card / phone number ──
    // Bitrix24 fires this when the agent clicks a phone number.
    // We POST to /bx24-call-start which pushes outbound_call SSE
    // to the agent's Exotel sidebar (popup.html), which then calls
    // triggerOutboundCall() to hit the Exotel API.
    BX24.addEvent('onExternalCallStart', function (data) {
      bgLog('onExternalCallStart: ' + JSON.stringify(data));
      const num    = (data.PHONE_NUMBER_INTERNATIONAL || data.PHONE_NUMBER || '').trim();
      const callId = data.CALL_ID || '';
      const userId = String(data.USER_ID || '');

      if (!num) { bgLog('onExternalCallStart: no number, ignoring'); return; }

      currentCallId  = callId;
      currentCallNum = num;
      callStartTime  = Date.now();

      // Tell server to queue the outbound call for this agent.
      // Server resolves userId → email, then pushes outbound_call SSE
      // to the agent's open sidebar popup, which places the Exotel call.
      fetch('/bx24-call-start', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ PHONE_NUMBER: num, CALL_ID: callId, USER_ID: userId })
      }).then(r => r.json()).then(d => {
        bgLog('bx24-call-start OK: ' + JSON.stringify(d));
      }).catch(e => bgLog('bx24-call-start error: ' + e.message));
    });

    // ── Call finished ─────────────────────────────────────────
    BX24.addEvent('onExternalCallFinish', function (data) {
      bgLog('onExternalCallFinish: ' + JSON.stringify(data));
      const finishCallId = data.CALL_ID || currentCallId;
      const userId       = String(data.USER_ID || '');
      const duration     = data.DURATION || Math.round((Date.now() - callStartTime) / 1000) || 0;
      if (finishCallId) {
        BX24.callMethod('telephony.externalcall.finish', {
          CALL_ID:     finishCallId,
          USER_ID:     userId,
          DURATION:    duration,
          STATUS_CODE: 200
        }, function(r) {
          bgLog('externalcall.finish: ' + JSON.stringify(r && r.data ? r.data() : null));
        });
      }
      currentCallId  = null;
      currentCallNum = null;
      callStartTime  = 0;
    });

    bgLog('BX24 events registered');
  });
}

window.onload = initBG;
