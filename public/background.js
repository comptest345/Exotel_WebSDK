// ═══════════════════════════════════════════════════════════════
// background.js — DEPRECATED.
//
// The SDK instance now lives in popup.js (loaded into the
// CRM_ACTIVITY_SIDEBAR placement) instead of here. Reasons:
//
// 1. This page runs in a hidden PAGE_BACKGROUND_WORKER iframe with
//    no console access from outside and, in every test, never sent
//    a single heartbeat or poll request to the server — meaning it
//    was never reliably loading/running in the first place.
// 2. Hidden iframes commonly cannot obtain microphone permission
//    (getUserMedia), which WebRTC calling requires. Even if the SDK
//    did initialize here, MakeCall() could fail silently.
// 3. Moving the SDK into the visible CRM sidebar (where the agent
//    is actually working) removes both problems and removes the
//    "pending call" relay hop entirely — popup.js now calls
//    MakeCall()/AcceptCall()/HangupCall() directly.
//
// This file is intentionally a no-op. It is kept only so that any
// pre-existing PAGE_BACKGROUND_WORKER placement binding from a prior
// install doesn't throw a 404. If you see this log, no action is
// needed — the dialer logic lives entirely in popup.js now.
// ═══════════════════════════════════════════════════════════════
console.log('[BGWorker] background.js is deprecated and intentionally inactive. SDK now lives in popup.js.');
