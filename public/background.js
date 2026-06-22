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

  // Open the Exotel Dialer panel so agent sees the UI immediately
  try {
    BX24.openApplication(
      { bx24_start_call: '1', number: num },
      function() { bgLog('openApplication callback fired'); }
    );
  } catch(e) { bgLog('openApplication failed: ' + e.message); }

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
      const finishCallId = data.CALL_ID || currentCallId;
      const userId       = data.USER_ID || '';
      const duration     = data.DURATION || Math.round((Date.now() - callStartTime) / 1000) || 0;
      if (finishCallId) {
        BX24.callMethod('telephony.externalcall.finish', {
          CALL_ID:     finishCallId,
          USER_ID:     userId,
          DURATION:    duration,
          STATUS_CODE: 200
        }, function(r) {
          bgLog('externalcall.finish result: ' + JSON.stringify(r && r.data ? r.data() : null));
        });
      }
      currentCallId = null;
      callStartTime = 0;
    });

    bgLog('BX24 events registered');
  });
}

window.onload = initBG;
