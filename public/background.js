// ═══════════════════════════════════════════════════════════════
// background.js — Multi-agent version
// Registers Bitrix24 telephony + handles BX24 events.
// BX24 user is resolved dynamically — no hardcoded IDs.
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
    BX24.addEvent('onExternalCallStart', function (data) {
      bgLog('onExternalCallStart: ' + JSON.stringify(data));
      const num    = (data.PHONE_NUMBER_INTERNATIONAL || data.PHONE_NUMBER || '').trim();
      const callId = data.CALL_ID || '';
      const userId = String(data.USER_ID || '');
      currentCallId  = callId;
      currentCallNum = num;
      callStartTime  = Date.now();

      if (!num) { bgLog('onExternalCallStart: no number, ignoring'); return; }

      // 1. POST to server first — this queues the outbound_call SSE to the agent.
      //    Do this BEFORE openApplication so the SSE arrives right as popup opens.
      fetch('/bx24-call-start', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ PHONE_NUMBER: num, CALL_ID: callId, USER_ID: userId })
      }).then(r => r.json()).then(d => {
        bgLog('bx24-call-start queued for: ' + (d.email || 'unknown') + ' → ' + num);
      }).catch(e => bgLog('bx24-call-start error: ' + e.message));

      // 2. Open the Exotel Dialer popup — passes number so popup can call immediately
      //    even if SSE hasn't arrived yet (checkOpenApplicationParams fallback).
      try {
        BX24.openApplication(
          { bx24_start_call: '1', number: num },
          function() { bgLog('openApplication callback fired'); }
        );
      } catch(e) { bgLog('openApplication failed: ' + e.message); }
    });

    // ── Call finished from BX24 side ──────────────────────────
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
