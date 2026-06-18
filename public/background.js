// ═══════════════════════════════════════════════════════════════
// background.js — Multi-agent version
// Registers Bitrix24 telephony + handles BX24 events.
// BX24 user is resolved dynamically — no hardcoded IDs.
// ═══════════════════════════════════════════════════════════════

let currentCallId = null;
let callStartTime = 0;

function bgLog(msg) { console.log('[BGWorker]', msg); }

function initBG() {
  bgLog('Starting...');
  if (!window.BX24) { bgLog('BX24 not available'); return; }

  BX24.init(function () {
    bgLog('BX24 ready');

    // Register outbound call handler (click-to-call from CRM card)
    BX24.addEvent('onExternalCallStart', function (data) {
      bgLog('onExternalCallStart: ' + JSON.stringify(data));
      const num    = data.PHONE_NUMBER || data.PHONE_NUMBER_INTERNATIONAL || '';
      const callId = data.CALL_ID || '';
      const userId = data.USER_ID || '';
      currentCallId = callId;
      callStartTime = Date.now();

      // Send to server — server resolves BX24 userId → email via BX24 webhook
      fetch('/bx24-call-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ PHONE_NUMBER: num, CALL_ID: callId, USER_ID: userId })
      }).then(r => r.json()).then(d => {
        bgLog('Queued outbound call for: ' + (d.email || 'unknown') + ' → ' + num);
      }).catch(e => bgLog('Queue error: ' + e.message));
    });

    // Handle call end from BX24 side
    BX24.addEvent('onExternalCallFinish', function (data) {
      bgLog('onExternalCallFinish: ' + JSON.stringify(data));
      currentCallId = null;
      callStartTime = 0;
    });

    bgLog('BX24 events registered');
  });
}

window.onload = initBG;
