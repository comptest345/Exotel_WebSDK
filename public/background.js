// ═══════════════════════════════════════════════════════════════
// background.js — Registers Bitrix24 telephony + handles BX24 events
// ═══════════════════════════════════════════════════════════════

const BX24_USER_ID = '44';
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
      currentCallId = callId;
      callStartTime = Date.now();

      // Send number to server so popup.js poll picks it up
      fetch('/outbound-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: num, callId: callId, userId: BX24_USER_ID })
      }).then(r => r.json()).then(d => {
        bgLog('Queued outbound call: ' + JSON.stringify(d));
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
