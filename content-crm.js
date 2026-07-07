// content-crm.js — THE ENGINE. Runs on the CRM lead page and owns the whole
// session state machine (state lives here so it survives MV3 service-worker
// suspension). Receives commands from the side panel / hotkeys (relayed by the
// background worker) and broadcasts status to the side panel.
//
// HARD SAFETY RULES (do not remove):
//   - Call decisions use softphone state text + toasts ONLY — never the manual
//     "Did you connect?" toggle.
//   - Logging touches ONLY: Not Connected toggle, Reason dropdown, Save Outcome.
//     RSVP / warmth / interested / PreferredDeveloper chips are never touched.
//   - After a Live or Pre-stage signal the engine FREEZES until an explicit Resume.
//   - Every DOM action is wrapped; on selector failure the engine pauses and
//     surfaces the intended action instead of continuing.

(() => {
  const C = globalThis.RAYNA;
  if (!C) return;

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------
  const S = {
    running: false,
    stopRequested: false,
    phase: 'idle',        // idle | reading | dialing | ringing | connected |
                          // logging | advancing | prestaging |
                          // frozen_live | frozen_prestage | paused_error
    phaseDetail: '',
    lead: null,
    settings: { ...C.DEFAULT_SETTINGS },
    callStartedAt: null,
    connectedAt: null,
    dialedCount: 0,
    tally: newTally(),
    logs: [],             // [{t, level, text}] capped ring buffer for the panel
    decisionNeeded: false,
    frozen: false,
    freezeReason: null,   // 'live' | 'prestage' | 'error'
    errorMessage: null,
  };

  function newTally() {
    return {
      dialed: 0, noAnswer: 0, busy: 0, voicemail: 0, dropped: 0,
      techFailure: 0, invalid: 0, live: 0, prestaged: 0, skipped: 0, errors: 0,
    };
  }

  let pendingDecision = null; // {resolve} while a connected call awaits v/l/p/s
  let pendingResume = null;   // {resolve} while frozen (live/prestage/error)
  let statusTicker = null;    // interval that keeps the panel timer moving

  class ActionError extends Error {
    constructor(intended, cause) {
      super(intended);
      this.intended = intended;
      this.cause = cause;
    }
  }

  // ---------------------------------------------------------------------------
  // Small DOM utilities
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    return !!el && el.getClientRects().length > 0;
  }

  function textOf(el) {
    return ((el && (el.innerText != null ? el.innerText : el.textContent)) || '').trim();
  }

  async function waitFor(fn, timeoutMs, pollMs = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let v = null;
      try { v = fn(); } catch (e) { /* keep polling */ }
      if (v) return v;
      await sleep(pollMs);
    }
    return null;
  }

  function findButton(re, root = document) {
    for (const el of root.querySelectorAll('button, [role="button"]')) {
      if (isVisible(el) && re.test(textOf(el))) return el;
    }
    return null;
  }

  // Smallest visible element whose exact (trimmed) text matches `re`.
  function findByExactText(re, root = document) {
    let best = null;
    for (const el of root.querySelectorAll('body *')) {
      if (el.childElementCount > 2) continue;
      if (!re.test(textOf(el))) continue;
      if (!isVisible(el)) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  // Wrap a DOM action so a selector failure pauses the session with the
  // intended action surfaced, instead of silently continuing.
  async function act(intended, fn) {
    try {
      return await fn();
    } catch (e) {
      throw new ActionError(intended, e);
    }
  }

  // ---------------------------------------------------------------------------
  // Lead extraction
  // ---------------------------------------------------------------------------
  function labeledValue(labelRe) {
    const label = findByExactText(labelRe);
    if (!label) return null;
    // Try the next sibling, then the parent's text minus the label.
    const sib = label.nextElementSibling;
    if (sib && textOf(sib)) return textOf(sib);
    const parent = label.parentElement;
    if (parent) {
      const rest = textOf(parent).replace(textOf(label), '').trim();
      if (rest) return rest;
    }
    return null;
  }

  function extractLead() {
    const bodyText = document.body.innerText || '';

    let name = labeledValue(C.CRM.LEAD_FIELD_LABELS.name);
    if (!name) {
      const h = document.querySelector('h1, h2');
      name = h ? textOf(h) : '';
    }

    let email = labeledValue(C.CRM.LEAD_FIELD_LABELS.email);
    if (!email || !C.CRM.EMAIL_RE.test(email)) {
      const m = bodyText.match(C.CRM.EMAIL_RE);
      email = m ? m[0] : (email || '');
    } else {
      email = (email.match(C.CRM.EMAIL_RE) || [email])[0];
    }

    let phone = labeledValue(C.CRM.LEAD_FIELD_LABELS.phone);
    if (phone) phone = (phone.match(C.CRM.PHONE_RE) || [phone])[0];
    if (!phone || isIgnoredPhone(phone)) {
      phone = '';
      for (const m of bodyText.matchAll(new RegExp(C.CRM.PHONE_RE.source, 'g'))) {
        if (!isIgnoredPhone(m[0])) { phone = m[0].trim(); break; }
      }
    }

    const counterM = bodyText.match(C.CRM.COUNTER_RE);
    const tagM = bodyText.match(C.CRM.CAMPAIGN_TAG_RE);

    return {
      name: name || '',
      firstName: (name || '').split(/\s+/)[0] || '',
      phone: phone || '',
      email: email || '',
      campaignTag: tagM ? tagM[1] : '',
      counter: counterM ? `${counterM[1]} of ${counterM[2]}` : '',
    };
  }

  function isIgnoredPhone(p) {
    const digits = String(p).replace(/\D/g, '');
    return C.CRM.IGNORE_PHONES.some((ig) => ig.replace(/\D/g, '') === digits);
  }

  function leadFingerprint() {
    const l = extractLead();
    return `${l.name}|${l.counter}`;
  }

  // ---------------------------------------------------------------------------
  // Softphone state reading (state text + timer ONLY — never the toggle)
  // ---------------------------------------------------------------------------
  let statePanelCache = null; // parent of the last state-token element we found

  function findStateToken() {
    // Fast path: re-read from the cached panel.
    if (statePanelCache && statePanelCache.isConnected) {
      const hit = scanForToken(statePanelCache);
      if (hit) return hit;
    }
    const hit = scanForToken(document.body);
    if (hit) statePanelCache = hit.el.parentElement || document.body;
    return hit;
  }

  function scanForToken(root) {
    for (const el of root.querySelectorAll('*')) {
      if (el.childElementCount > 1) continue;
      const t = textOf(el);
      if (t.length === 0 || t.length > 20) continue;
      if (C.CRM.STATE_TOKEN_RE.test(t) && isVisible(el)) {
        return { el, token: t.replace(/\.+$/, '') };
      }
    }
    return null;
  }

  function findTimer() {
    const root = statePanelCache && statePanelCache.isConnected ? statePanelCache : null;
    for (const scope of [root, document.body]) {
      if (!scope) continue;
      for (const el of scope.querySelectorAll('*')) {
        if (el.childElementCount > 0) continue;
        const t = textOf(el);
        if (C.CRM.TIMER_RE.test(t) && isVisible(el)) return t;
      }
      if (root && scope === root) continue;
      break;
    }
    return null;
  }

  // -> { state: 'idle'|'ringing'|'connected'|'in_call'|'unknown', timer }
  function readCallState() {
    const btn = findButton(C.CRM.CALL_BUTTON_TEXT);
    const btnText = btn ? textOf(btn) : '';
    const inCall = C.CRM.IN_CALL_TEXT.test(btnText);
    const tokenHit = findStateToken();
    const token = tokenHit ? tokenHit.token : null;

    if (token && C.CRM.STATE_CONNECTED_RE.test(token)) {
      return { state: 'connected', timer: findTimer() };
    }
    if (inCall) {
      // Timer running without a "Connected" token still means connected.
      const timer = findTimer();
      if (timer) return { state: 'connected', timer };
      if (token) return { state: 'ringing', timer: null };
      return { state: 'in_call', timer: null };
    }
    if (token) return { state: 'ringing', timer: null };
    if (C.CRM.CALL_NOW_TEXT.test(btnText)) return { state: 'idle', timer: null };
    return { state: 'unknown', timer: null };
  }

  function scanFailureToast() {
    for (const el of document.querySelectorAll(C.CRM.TOAST_SELECTOR)) {
      if (!isVisible(el)) continue;
      const t = textOf(el);
      if (!t) continue;
      for (const m of C.TOAST_REASON_MAP) {
        if (m.re.test(t)) return { reason: m.reason, text: t };
      }
    }
    return null;
  }

  function saveConfirmSeen() {
    for (const el of document.querySelectorAll(C.CRM.TOAST_SELECTOR)) {
      if (isVisible(el) && C.CRM.SAVE_CONFIRM_RE.test(textOf(el))) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Status push to the side panel
  // ---------------------------------------------------------------------------
  function fullStatus() {
    return {
      running: S.running,
      phase: S.phase,
      phaseDetail: S.phaseDetail,
      lead: S.lead,
      tally: S.tally,
      decisionNeeded: S.decisionNeeded,
      frozen: S.frozen,
      freezeReason: S.freezeReason,
      errorMessage: S.errorMessage,
      callElapsedMs: S.connectedAt ? Date.now() - S.connectedAt
        : S.callStartedAt ? Date.now() - S.callStartedAt : 0,
      callScript: C.TEMPLATES.CALL_SCRIPT,
      logs: S.logs.slice(-60),
      settings: S.settings,
    };
  }

  function pushStatus() {
    try {
      chrome.runtime.sendMessage({ type: C.MSG.STATUS, payload: fullStatus() })
        .catch(() => {});
    } catch (e) { /* extension context gone (reload) — nothing to do */ }
  }

  function pushLog(level, text) {
    S.logs.push({ t: Date.now(), level, text });
    if (S.logs.length > 120) S.logs.splice(0, S.logs.length - 120);
    pushStatus();
  }

  function setPhase(phase, detail = '') {
    S.phase = phase;
    S.phaseDetail = detail;
    pushStatus();
  }

  function startTicker() {
    stopTicker();
    statusTicker = setInterval(pushStatus, 1000);
  }
  function stopTicker() {
    if (statusTicker) { clearInterval(statusTicker); statusTicker = null; }
  }

  // ---------------------------------------------------------------------------
  // User-signal plumbing (decision + resume)
  // ---------------------------------------------------------------------------
  function awaitDecision() {
    S.decisionNeeded = true;
    pushStatus();
    return new Promise((resolve) => { pendingDecision = { resolve }; })
      .finally(() => { S.decisionNeeded = false; pendingDecision = null; pushStatus(); });
  }

  function awaitResume() {
    return new Promise((resolve) => { pendingResume = { resolve }; })
      .finally(() => { pendingResume = null; });
  }

  async function freeze(reason, message) {
    S.frozen = true;
    S.freezeReason = reason;
    S.errorMessage = reason === 'error' ? message : null;
    setPhase(reason === 'error' ? 'paused_error' : `frozen_${reason}`, message || '');
    pushLog(reason === 'error' ? 'error' : 'info',
      reason === 'error' ? message : `Frozen (${reason}) — press Resume when done`);
    await awaitResume();
    S.frozen = false;
    S.freezeReason = null;
    S.errorMessage = null;
    pushLog('info', 'Resumed');
  }

  // ---------------------------------------------------------------------------
  // CRM actions
  // ---------------------------------------------------------------------------
  async function clickCallNow() {
    await act('click the "Call Now" button', async () => {
      const btn = await waitFor(() => {
        const b = findButton(C.CRM.CALL_BUTTON_TEXT);
        return b && C.CRM.CALL_NOW_TEXT.test(textOf(b)) ? b : null;
      }, 5000);
      if (!btn) throw new Error('Call Now button not found (or a call is already active)');
      btn.click();
    });
  }

  async function endCall() {
    const btn = findButton(C.CRM.CALL_BUTTON_TEXT);
    if (!btn || !C.CRM.IN_CALL_TEXT.test(textOf(btn))) return; // already idle
    await act('click "End Call"', async () => {
      btn.click();
      await waitFor(() => {
        const b = findButton(C.CRM.CALL_BUTTON_TEXT);
        return b && C.CRM.CALL_NOW_TEXT.test(textOf(b));
      }, 8000);
    });
  }

  // Watch the softphone after dialing.
  // -> {kind:'connected'} | {kind:'no_answer'} | {kind:'toast', reason, text}
  //  | {kind:'ended_early', reason}
  async function watchCall() {
    const t0 = Date.now();
    let sawActivity = false;
    setPhase('ringing');
    while (true) {
      const toast = scanFailureToast();
      if (toast) return { kind: 'toast', reason: toast.reason, text: toast.text };

      const cs = readCallState();
      if (cs.state === 'connected') return { kind: 'connected' };
      if (cs.state === 'ringing' || cs.state === 'in_call') sawActivity = true;

      if (cs.state === 'idle') {
        if (sawActivity) {
          // Call ended while ringing with no toast (declined / remote hangup).
          await sleep(S.settings.POLL_MS); // give a late toast one more chance
          const late = scanFailureToast();
          if (late) return { kind: 'toast', reason: late.reason, text: late.text };
          return { kind: 'ended_early', reason: C.CRM.RING_ENDED_EARLY_REASON };
        }
        if (Date.now() - t0 > C.CRM.DIAL_START_TIMEOUT_MS) {
          throw new ActionError('start the call (softphone never left idle after Call Now)');
        }
      }

      if (Date.now() - t0 > S.settings.RING_TIMEOUT_MS) return { kind: 'no_answer' };
      await sleep(S.settings.POLL_MS);
    }
  }

  // Log a non-connected outcome. Touches ONLY: Not Connected, Reason, Save Outcome.
  async function logOutcome(reason) {
    setPhase('logging', reason);

    // 1. Ensure the "Did you connect?" toggle is on Not Connected.
    await act('set the "Did you connect?" toggle to Not Connected', async () => {
      const el = await waitFor(() => findByExactText(C.CRM.NOT_CONNECTED_TEXT), 4000);
      if (!el) throw new Error('"Not Connected" option not found');
      if (!looksSelected(el)) clickable(el).click();
    });

    // 2. Reason dropdown.
    // *** BRITTLE #1: this is a custom React dropdown whose options only render
    // while it is open. We click the "Select reason..." trigger, wait for the
    // options to appear, then click the option whose text EXACTLY equals the
    // target reason. If the CRM relabels anything, fix it in config.js. ***
    await act(`select Reason "${reason}"`, async () => {
      const trigger = await waitFor(() => findByExactText(C.CRM.REASON_TRIGGER_TEXT), 4000);
      if (!trigger) throw new Error('Reason dropdown trigger ("Select reason...") not found');
      clickable(trigger).click();
      const exactRe = new RegExp(`^${escapeRe(reason)}$`, 'i');
      const option = await waitFor(() => findOption(exactRe), 4000, 100);
      if (!option) {
        document.body.click(); // close the dropdown so we do not leave it hanging
        throw new Error(`Reason option "${reason}" did not render`);
      }
      option.click();
    });

    // 3. Save Outcome (RSVP / PreferredDeveloper chips are never touched).
    await act('click "Save Outcome"', async () => {
      const btn = await waitFor(() => findButton(C.CRM.SAVE_OUTCOME_TEXT), 4000);
      if (!btn) throw new Error('Save Outcome button not found');
      btn.click();
    });

    // 4. Wait for a save confirmation. If the CRM shows none, warn and continue
    // (pausing every lead would make the tool unusable on a silent CRM).
    const confirmed = await waitFor(saveConfirmSeen, C.CRM.SAVE_CONFIRM_TIMEOUT_MS, 250);
    if (!confirmed) pushLog('warn', 'No save confirmation toast seen — continuing');

    pushLog('ok', `Logged: ${reason}`);
  }

  function looksSelected(el) {
    for (const node of [el, el.parentElement]) {
      if (!node) continue;
      if (node.getAttribute('aria-pressed') === 'true') return true;
      if (node.getAttribute('aria-checked') === 'true') return true;
      if (node.getAttribute('aria-selected') === 'true') return true;
      if (/(^|\s)(active|selected|checked)(\s|$)/i.test(node.className || '')) return true;
    }
    return false;
  }

  function clickable(el) {
    return el.closest('button, [role="button"], [role="option"], [role="radio"], label') || el;
  }

  function findOption(exactRe) {
    // Options render into a portal/listbox only while the dropdown is open.
    const roots = document.querySelectorAll(
      '[role="listbox"], [role="menu"], ul, [class*="menu" i], [class*="option" i], [class*="dropdown" i]'
    );
    for (const root of roots) {
      for (const el of root.querySelectorAll('[role="option"], li, div, span')) {
        if (el.childElementCount > 1) continue;
        if (exactRe.test(textOf(el)) && isVisible(el)) return clickable(el);
      }
    }
    return null;
  }

  async function advance() {
    setPhase('advancing');
    const before = leadFingerprint();
    await act('click "Next" to advance to the next lead', async () => {
      const btn = await waitFor(() => findButton(C.CRM.NEXT_BUTTON_TEXT), 4000);
      if (!btn) throw new Error('Next button not found');
      btn.click();
    });
    const changed = await waitFor(
      () => leadFingerprint() !== before, C.CRM.ADVANCE_TIMEOUT_MS, 400);
    if (!changed) {
      throw new ActionError('advance to the next lead (the page never showed a new lead)');
    }
  }

  // ---------------------------------------------------------------------------
  // Pre-staging (via the background worker; NOTHING here ever sends)
  // ---------------------------------------------------------------------------
  async function doPrestage(lead) {
    setPhase('prestaging');
    pushLog('info', 'Pre-staging WhatsApp + Gmail drafts (nothing will be sent)…');
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({
        type: C.MSG.PRESTAGE,
        channels: ['wa', 'gmail'],
        lead,
        waText: C.fillTemplate(C.TEMPLATES.IF_INTERESTED, lead.firstName),
        settings: S.settings,
      });
    } catch (e) {
      res = { wa: { ok: false, detail: String(e) }, gmail: { ok: false, detail: String(e) } };
    }
    for (const [ch, name] of [['wa', 'WhatsApp'], ['gmail', 'Gmail']]) {
      const r = res && res[ch];
      if (r && r.ok) pushLog('ok', `${name}: ${r.detail || 'staged'}`);
      else pushLog('warn', `${name}: ${(r && r.detail) || 'pre-stage failed'}`);
    }
  }

  // Optional "If Not Answered" WhatsApp pre-fill on voicemail / no-answer.
  // Fire-and-forget so it never blocks the dialing loop.
  function prestageMissWhatsApp(lead) {
    if (!S.settings.PREFILL_WHATSAPP_ON_MISS) return;
    try {
      chrome.runtime.sendMessage({
        type: C.MSG.PRESTAGE,
        channels: ['wa'],
        lead,
        waText: C.fillTemplate(C.TEMPLATES.IF_NOT_ANSWERED, lead.firstName),
        settings: S.settings,
      }).then((res) => {
        const r = res && res.wa;
        if (r && r.ok) pushLog('ok', `WhatsApp (missed-call): ${r.detail || 'staged'}`);
        else pushLog('warn', `WhatsApp (missed-call): ${(r && r.detail) || 'failed'}`);
      }).catch(() => {});
    } catch (e) { /* context gone */ }
  }

  // ---------------------------------------------------------------------------
  // Per-lead flow
  // ---------------------------------------------------------------------------
  async function runLead() {
    setPhase('reading');
    S.callStartedAt = null;
    S.connectedAt = null;
    const lead = extractLead();
    S.lead = lead;
    if (!lead.name && !lead.phone) {
      throw new ActionError('read the lead from the page (no name/phone found — is a lead page open?)');
    }
    pushLog('info',
      `Lead ${lead.counter || '?'}: ${lead.name || '(no name)'} ${lead.phone || ''} — ${lead.campaignTag || 'no campaign tag'}`);

    await clickCallNow();
    S.dialedCount += 1;
    S.tally.dialed += 1;
    S.callStartedAt = Date.now();
    startTicker();
    setPhase('dialing');

    let outcome;
    try {
      outcome = await watchCall();
    } finally {
      stopTicker();
    }

    if (outcome.kind === 'connected') {
      S.connectedAt = Date.now();
      startTicker();
      setPhase('connected', 'Voicemail / Live / Pre-stage / Skip?');
      pushLog('info', 'CONNECTED — listen: Voicemail, Live, Pre-stage or Skip?');
      let decision;
      try {
        decision = await awaitDecision(); // 'voicemail' | 'live' | 'prestage' | 'skip'
      } finally {
        stopTicker();
      }

      if (decision === 'voicemail') {
        await endCall();
        prestageMissWhatsApp(lead);
        await logOutcome(C.REASONS.VOICEMAIL);
        S.tally.voicemail += 1;
        await advance();
      } else if (decision === 'live') {
        S.tally.live += 1;
        // Freeze with the call still up — the human runs the interested branch
        // (warmth, RSVP, sends, calendar, Save Outcome, Next) entirely by hand.
        await freeze('live',
          'LIVE call — handle it manually. When done (Save Outcome + Next), press Resume.');
      } else if (decision === 'prestage') {
        await doPrestage(lead);
        S.tally.prestaged += 1;
        await freeze('prestage',
          'Drafts staged (nothing sent). Finish the lead manually (Save Outcome + Next), then press Resume.');
      } else { // skip
        await endCall();
        S.tally.skipped += 1;
        pushLog('info', 'Skipped (no outcome logged)');
        await advance();
      }
      return;
    }

    // Not connected.
    await endCall();
    let reason;
    if (outcome.kind === 'no_answer') {
      reason = C.REASONS.NO_ANSWER;
      pushLog('info', `Ring timeout (${Math.round(S.settings.RING_TIMEOUT_MS / 1000)}s) — No Answer`);
    } else if (outcome.kind === 'toast') {
      reason = outcome.reason;
      pushLog('info', `Failure toast: "${outcome.text}" -> ${reason}`);
    } else { // ended_early
      reason = outcome.reason;
      pushLog('info', `Call ended while ringing (no toast) -> ${reason}`);
    }

    if (reason === C.REASONS.NO_ANSWER) prestageMissWhatsApp(lead);
    await logOutcome(reason);
    bumpReasonTally(reason);
    await advance();
  }

  function bumpReasonTally(reason) {
    const map = {
      [C.REASONS.NO_ANSWER]: 'noAnswer',
      [C.REASONS.BUSY]: 'busy',
      [C.REASONS.VOICEMAIL]: 'voicemail',
      [C.REASONS.DROPPED]: 'dropped',
      [C.REASONS.TECH_FAILURE]: 'techFailure',
      [C.REASONS.INVALID]: 'invalid',
    };
    const key = map[reason];
    if (key) S.tally[key] += 1;
  }

  // ---------------------------------------------------------------------------
  // Session loop
  // ---------------------------------------------------------------------------
  async function sessionLoop() {
    if (S.running) return;
    S.running = true;
    S.stopRequested = false;
    S.dialedCount = 0;
    S.tally = newTally();
    pushLog('info', 'Session started');

    while (S.running && !S.stopRequested) {
      S.settings = await C.getSettings();
      if (S.settings.MAX_LEADS > 0 && S.dialedCount >= S.settings.MAX_LEADS) {
        pushLog('info', `MAX_LEADS (${S.settings.MAX_LEADS}) reached — stopping`);
        break;
      }
      try {
        await runLead();
      } catch (e) {
        stopTicker();
        if (e instanceof ActionError) {
          S.tally.errors += 1;
          // Safety rule: never continue past a failed selector — pause and
          // surface the intended action; the human fixes/does it, then Resumes.
          await freeze('error',
            `Selector failed — intended action: ${e.intended}. ` +
            `Do it manually or fix config.js, then press Resume.`);
        } else {
          S.tally.errors += 1;
          await freeze('error', `Unexpected error: ${e && e.message}. Press Resume to continue.`);
        }
      }
    }

    S.running = false;
    S.stopRequested = false;
    stopTicker();
    setPhase('idle');
    const t = S.tally;
    pushLog('info',
      `Session ended — dialed ${t.dialed}: ${t.noAnswer} no-answer, ${t.voicemail} voicemail, ` +
      `${t.busy} busy, ${t.dropped} dropped, ${t.techFailure} tech-failure, ${t.invalid} invalid, ` +
      `${t.live} live, ${t.prestaged} pre-staged, ${t.skipped} skipped, ${t.errors} errors`);
  }

  function requestStop() {
    if (!S.running) return;
    S.stopRequested = true;
    pushLog('info', 'Stop requested — finishing the current lead first');
  }

  function handleDecision(action) {
    if (pendingDecision) {
      pendingDecision.resolve(action);
    } else {
      pushLog('warn', `Ignored "${action}" — no connected call is awaiting a decision`);
    }
  }

  function handleResume() {
    if (pendingResume) pendingResume.resolve();
    else pushLog('warn', 'Ignored Resume — nothing is frozen');
  }

  // ---------------------------------------------------------------------------
  // Command intake (from panel / hotkeys, relayed by the background worker)
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== C.MSG.CRM_CMD) return false;
    const cmd = msg.cmd;
    switch (cmd) {
      case C.CMD.START:
        sessionLoop();
        break;
      case C.CMD.STOP:
      case C.CMD.QUIT:
        requestStop();
        break;
      case C.CMD.RESUME:
        handleResume();
        break;
      case C.CMD.GET_STATUS:
        sendResponse({ ok: true, status: fullStatus() });
        return false;
      default:
        if (typeof cmd === 'string' && cmd.startsWith('action:')) {
          handleDecision(cmd.slice('action:'.length));
        }
    }
    sendResponse({ ok: true });
    return false;
  });

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Announce ourselves so an already-open panel picks up the current state.
  ;(async () => {
    S.settings = await C.getSettings();
    S.lead = extractLead();
    pushStatus();
  })();
})();
