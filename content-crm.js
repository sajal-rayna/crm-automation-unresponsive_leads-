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
  const L = globalThis.RAYNA_LEARN;
  if (!C || !L) return;

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
    learned: null,        // cached RAYNA_LEARN data (refreshed on storage change)
    unmappedSeen: new Set(), // unrecognized toast texts already logged this session
    listen: { active: false, suggestion: null, cues: [], unavailable: false },
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
    constructor(intended, cause, learnKey) {
      super(intended);
      this.intended = intended;
      this.cause = cause;
      // Which learnable action failed (null = not teachable, e.g. state reads)
      this.learnKey = learnKey || (cause && cause.learnKey) || null;
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
  // intended action surfaced, instead of silently continuing. learnKey marks
  // the action as teachable: during the pause, the click the user makes to do
  // it manually is captured and learned as a fallback selector.
  async function act(intended, fn, learnKey) {
    try {
      return await fn();
    } catch (e) {
      throw new ActionError(intended, e, learnKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Self-learning: learned-selector fallbacks + teach-on-pause capture
  // ---------------------------------------------------------------------------
  function learningOn() {
    return S.learned && S.learned.enabled !== false;
  }

  // Learned fallback for a failed config selector (never replaces a working one).
  function learnedEl(key) {
    if (!learningOn()) return null;
    const list = S.learned.selectors && S.learned.selectors[key];
    return list && list.length ? L.locate(list) : null;
  }

  let teach = null; // {key, descs[], handler} while paused on a teachable action

  function startTeach(key) {
    stopTeachListener();
    teach = { key, descs: [] };
    teach.handler = (ev) => {
      if (!teach) return;
      const raw = ev.target instanceof Element ? ev.target : null;
      if (!raw) return;
      const el = raw.closest(
        'button, [role="button"], [role="option"], [role="radio"], [role="menuitem"], li, label') || raw;
      // HARD SAFETY RULE: never learn anything that looks like Send/submit.
      const label = `${el.getAttribute('aria-label') || ''} ${textOf(el)}`.trim();
      if (C.FORBIDDEN_CLICK_RE.test(label)) return;
      // Descriptors are built at click time — dropdown options leave the DOM.
      teach.descs.push(L.describeElement(el));
      if (teach.descs.length > 10) teach.descs.shift();
      pushLog('info', `Learning candidate for "${key}": "${(textOf(el) || el.tagName).slice(0, 40)}"`);
    };
    document.addEventListener('click', teach.handler, true);
  }

  function stopTeachListener() {
    if (teach && teach.handler) {
      document.removeEventListener('click', teach.handler, true);
    }
  }

  async function finishTeach(save) {
    if (!teach) return;
    stopTeachListener();
    const { key, descs } = teach;
    teach = null;
    if (!save || !descs.length || !learningOn()) return;
    // Dropdown options: the LAST click before Resume is the option itself
    // (earlier clicks reopened the dropdown). Everything else: the first click.
    const desc = key.startsWith('reason-option:') ? descs[descs.length - 1] : descs[0];
    await L.recordSelector(key, desc);
    S.learned = await L.load();
    pushLog('ok',
      `Learned "${key}" -> "${(desc.text || desc.aria || desc.css).slice(0, 50)}" (used as fallback from now on)`);
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
      // Fallback: the most prominent heading that is NOT page chrome (the
      // sidebar "Rayna CRM" logo is an h1 and comes first in the DOM).
      for (const h of document.querySelectorAll('h1, h2')) {
        const t = textOf(h);
        if (!t || t.length < 2 || t.length > 80 || !isVisible(h)) continue;
        if (C.CRM.NAME_HEADING_SKIP_RE.test(t)) continue;
        name = t;
        break;
      }
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
    if (!phone || isIgnoredPhone(phone) || !plausiblePhone(phone)) {
      phone = '';
      for (const m of bodyText.matchAll(new RegExp(C.CRM.PHONE_RE.source, 'g'))) {
        if (!isIgnoredPhone(m[0]) && plausiblePhone(m[0])) { phone = m[0].trim(); break; }
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
    // Trailing-10-digit comparison so "(916) 222-2975" still matches the
    // configured "+19162222975" caller line.
    const tail = String(p).replace(/\D/g, '').slice(-10);
    if (!tail) return true;
    return C.CRM.IGNORE_PHONES.some(
      (ig) => ig.replace(/\D/g, '').slice(-10) === tail);
  }

  function plausiblePhone(p) {
    const s = String(p);
    if (C.CRM.DATE_LIKE_RE.test(s)) return false; // "2025-07-08 14" is not a phone
    const digits = s.replace(/\D/g, '');
    return digits.length >= C.CRM.PHONE_MIN_DIGITS && digits.length <= 15;
  }

  function leadFingerprint() {
    const l = extractLead();
    return `${l.name}|${l.counter}`;
  }

  // The Raw Source Data card (holding the CampaignTag JSON) is collapsed by
  // default. At dial time, expand it once so the campaign shows on the panel
  // by the time a call connects. Only ever clicks a toggle that currently
  // reads "Show"/"View"/"Expand" inside that card — nothing else.
  async function ensureCampaignVisible() {
    if (C.CRM.CAMPAIGN_TAG_RE.test(document.body.innerText || '')) return;
    let clicked = false;
    // No childElementCount cap here: a real "Show" control commonly wraps a
    // chevron/icon element, which textOf() (innerText-based) still reduces to
    // exactly "Show" — an element-count filter would just skip past it.
    for (const el of document.querySelectorAll('button, [role="button"], a, span, div')) {
      if (!isVisible(el) || !C.CRM.RAW_SOURCE_TOGGLE_RE.test(textOf(el))) continue;
      let node = el.parentElement;
      for (let i = 0; node && node !== document.body && i < 6; i++) {
        if (C.CRM.RAW_SOURCE_RE.test(node.innerText || '')) {
          el.click();
          clicked = true;
          break;
        }
        node = node.parentElement;
      }
      if (clicked) break;
    }
    if (!clicked) {
      pushLog('warn',
        'Could not find the Raw Source Data toggle — campaign tag unavailable this lead (check CRM.RAW_SOURCE_TOGGLE_RE / RAW_SOURCE_RE in config.js)');
      return;
    }
    const found = await waitFor(
      () => C.CRM.CAMPAIGN_TAG_RE.test(document.body.innerText || ''), 2500, 200);
    if (!found) pushLog('warn', 'Expanded Raw Source Data but found no CampaignTag inside it');
  }

  // ---------------------------------------------------------------------------
  // Softphone state reading (state text + timer ONLY — never the toggle)
  //
  // HARD SAFETY RULE: tokens/timers are read ONLY inside the softphone panel.
  // The Log Call Outcome toggle carries its own "Connected"/"Not Connected"
  // labels and the page has other timestamps, so a whole-page scan would let
  // the toggle masquerade as call state. The panel is the call button's
  // ancestry, capped at SOFTPHONE_MAX_CLIMB levels and cut off before any
  // container that includes the outcome panel (OUTCOME_PANEL_MARKER).
  // ---------------------------------------------------------------------------
  function softphoneRoot(btn) {
    if (C.CRM.SOFTPHONE_CONTAINER) {
      const pinned = document.querySelector(C.CRM.SOFTPHONE_CONTAINER);
      if (pinned) return pinned;
    }
    if (!btn) return null;
    let root = btn;
    let node = btn.parentElement;
    for (let i = 0; node && node !== document.body && i < C.CRM.SOFTPHONE_MAX_CLIMB; i++) {
      if (C.CRM.OUTCOME_PANEL_MARKER.test(node.innerText || '')) break;
      root = node;
      node = node.parentElement;
    }
    return root;
  }

  // The lead page can contain PERMANENT text that matches the state tokens —
  // e.g. a "Calling" chip on the phone number that is visible even while idle.
  // So before dialing we baseline every token/timer element already on screen
  // (with its text), and during the call only trust elements that APPEARED or
  // whose text CHANGED after Call Now — the real softphone state always does.
  function isBaselined(baseline, el) {
    return !!baseline && baseline.has(el) && baseline.get(el) === textOf(el);
  }

  function tokenBaseline() {
    const map = new Map();
    const root = softphoneRoot(findButton(C.CRM.CALL_BUTTON_TEXT));
    if (!root) return map;
    for (const el of root.querySelectorAll('*')) {
      const t = textOf(el);
      if (!t || !isVisible(el)) continue;
      if (el.childElementCount <= 1 && t.length <= 20 && C.CRM.STATE_TOKEN_RE.test(t)) {
        map.set(el, t);
      } else if (el.childElementCount === 0 && C.CRM.TIMER_RE.test(t)) {
        map.set(el, t);
      }
    }
    return map;
  }

  function scanForToken(root, baseline) {
    if (!root) return null;
    for (const el of root.querySelectorAll('*')) {
      if (el.childElementCount > 1) continue;
      const t = textOf(el);
      if (t.length === 0 || t.length > 20) continue;
      if (C.CRM.STATE_TOKEN_RE.test(t) && isVisible(el) && !isBaselined(baseline, el)) {
        return { el, token: t.replace(/\.+$/, '') };
      }
    }
    return null;
  }

  function findTimer(root, baseline) {
    if (!root) return null;
    for (const el of root.querySelectorAll('*')) {
      if (el.childElementCount > 0) continue;
      const t = textOf(el);
      if (C.CRM.TIMER_RE.test(t) && isVisible(el) && !isBaselined(baseline, el)) return t;
    }
    return null;
  }

  // -> { state: 'idle'|'ringing'|'connected'|'in_call'|'unknown', timer }
  function readCallState(baseline) {
    const btn = findButton(C.CRM.CALL_BUTTON_TEXT);
    const btnText = btn ? textOf(btn) : '';
    const inCall = C.CRM.IN_CALL_TEXT.test(btnText);
    const root = softphoneRoot(btn);
    const tokenHit = scanForToken(root, baseline);
    const token = tokenHit ? tokenHit.token : null;

    if (token && C.CRM.STATE_CONNECTED_RE.test(token)) {
      return { state: 'connected', timer: findTimer(root, baseline) };
    }
    if (inCall) {
      if (token) return { state: 'ringing', timer: null };
      // Timer running without a state token still means connected.
      const timer = findTimer(root, baseline);
      if (timer) return { state: 'connected', timer };
      return { state: 'in_call', timer: null };
    }
    if (token) return { state: 'ringing', timer: null };
    if (C.CRM.CALL_NOW_TEXT.test(btnText)) return { state: 'idle', timer: null };
    return { state: 'unknown', timer: null };
  }

  // All visible toast texts matching `matcher` (a regex or a predicate).
  function visibleToasts(matcher) {
    const test = typeof matcher === 'function' ? matcher : (t) => matcher.test(t);
    const out = [];
    for (const el of document.querySelectorAll(C.CRM.TOAST_SELECTOR)) {
      if (!isVisible(el)) continue;
      const t = textOf(el);
      if (t && test(t)) out.push(t);
    }
    return out;
  }

  function matchFailureToast(text) {
    for (const m of C.TOAST_REASON_MAP) {
      if (m.re.test(text)) return { reason: m.reason, text };
    }
    // User-approved learned mappings (options page) apply like built-in ones.
    return L.matchLearnedToast(S.learned, text);
  }

  // Detects toasts that appeared AFTER the detector was created. Texts already
  // on screen (stale, from the previous lead) are ignored — but forgiven once
  // they disappear, so an identical NEW toast still counts.
  function makeFreshToastDetector(re) {
    const stale = new Set(visibleToasts(re));
    return () => {
      const current = visibleToasts(re);
      for (const t of [...stale]) if (!current.includes(t)) stale.delete(t);
      return current.find((t) => !stale.has(t)) || null;
    };
  }

  function makeToastWatcher() {
    const fresh = makeFreshToastDetector((t) => !!matchFailureToast(t));
    return () => {
      const t = fresh();
      return t ? matchFailureToast(t) : null;
    };
  }

  // Collect fresh toasts we DON'T recognize so the user can map them to a
  // Reason on the options page (learning mechanism 2). Logged once per text.
  function collectUnmappedToast(text) {
    if (!learningOn() || !text || text.length > 120) return;
    if (matchFailureToast(text) || C.CRM.SAVE_CONFIRM_RE.test(text)) return;
    if (S.unmappedSeen.has(text)) return;
    S.unmappedSeen.add(text);
    L.recordUnmappedToast(text).catch(() => {});
    pushLog('warn',
      `Unrecognized toast during call: "${text.slice(0, 60)}" — map it to a Reason on the options page`);
  }

  // ---------------------------------------------------------------------------
  // Status push to the side panel
  // ---------------------------------------------------------------------------
  function fullStatus() {
    // The CRM is a single-page app: routes change without a reload, so a lead
    // snapshot from page-load goes stale. While no session is running, re-read
    // whatever lead is on screen every time status is requested.
    if (!S.running) {
      try { S.lead = extractLead(); } catch (e) { /* keep the last snapshot */ }
    }
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
      listen: {
        active: S.listen.active,
        suggestion: S.listen.suggestion,
        cues: S.listen.cues.slice(-5),
      },
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

  function callIsIdle() {
    const b = findButton(C.CRM.CALL_BUTTON_TEXT);
    return !b || C.CRM.CALL_NOW_TEXT.test(textOf(b));
  }

  async function endCall() {
    if (callIsIdle()) return; // nothing to hang up
    await act('hang up the call (End Call)', async () => {
      // Prefer the dedicated "End Call" control (seen inside an "Active Call"
      // panel on the live CRM) over the ambiguous top toggle, which can just
      // show status text ("On Call...") without ending anything when clicked.
      const btn = await waitFor(
        () => findButton(C.CRM.END_CALL_TEXT) || learnedEl('end-call') || findButton(C.CRM.CALL_BUTTON_TEXT),
        4000);
      if (!btn) throw new Error('End Call button not found');
      btn.click();
      const backToIdle = await waitFor(callIsIdle, 8000);
      // Never log/advance while the line might still be open — pause instead.
      if (!backToIdle) throw new Error('button never returned to "Call Now"');
    }, 'end-call');
  }

  // Watch the softphone after dialing.
  // -> {kind:'connected'} | {kind:'no_answer'} | {kind:'toast', reason, text}
  //  | {kind:'ended_early', reason}
  async function watchCall(stateBaseline) {
    const t0 = Date.now();
    let sawActivity = false;
    let unknownSince = null;
    // Baseline the toasts already on screen so a leftover from the PREVIOUS
    // lead can never be attributed to this call.
    const freshFailureToast = makeToastWatcher();
    const freshAnyToast = makeFreshToastDetector(() => true);
    setPhase('ringing');
    while (true) {
      const toast = freshFailureToast();
      if (toast) return { kind: 'toast', reason: toast.reason, text: toast.text };
      collectUnmappedToast(freshAnyToast());

      const cs = readCallState(stateBaseline);
      if (cs.state === 'connected') return { kind: 'connected' };
      if (cs.state === 'ringing' || cs.state === 'in_call') sawActivity = true;

      // Persistent 'unknown' (call button missing/relabeled) must pause, not
      // ring out to a bogus No Answer while the line may still be open.
      if (cs.state === 'unknown') {
        if (!unknownSince) unknownSince = Date.now();
        else if (Date.now() - unknownSince > C.CRM.DIAL_START_TIMEOUT_MS) {
          throw new ActionError(
            'read the softphone state (call button missing or relabeled — check CRM.CALL_BUTTON_TEXT in config.js)');
        }
      } else {
        unknownSince = null;
      }

      if (cs.state === 'idle') {
        if (sawActivity) {
          // Call ended while ringing with no toast (declined / remote hangup).
          await sleep(S.settings.POLL_MS); // give a late toast one more chance
          const late = freshFailureToast();
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
      const el = await waitFor(
        () => findByExactText(C.CRM.NOT_CONNECTED_TEXT) || learnedEl('not-connected'), 4000);
      if (!el) throw new Error('"Not Connected" option not found');
      if (!looksSelected(el)) clickable(el).click();
    }, 'not-connected');

    // 2. Reason dropdown.
    // *** BRITTLE #1: this is a custom React dropdown whose options only render
    // while it is open. We click the "Select reason..." trigger, wait for the
    // options to appear, then click the option whose text EXACTLY equals the
    // target reason. If the CRM relabels anything, fix it in config.js. ***
    await act(`select Reason "${reason}"`, async () => {
      const trigger = await waitFor(
        () => findByExactText(C.CRM.REASON_TRIGGER_TEXT) || learnedEl('reason-trigger'), 4000);
      if (!trigger) {
        const err = new Error('Reason dropdown trigger ("Select reason...") not found');
        err.learnKey = 'reason-trigger';
        throw err;
      }
      clickable(trigger).click();
      const exactRe = new RegExp(`^${escapeRe(reason)}$`, 'i');
      const option = await waitFor(
        () => findOption(exactRe) || learnedEl(`reason-option:${reason}`), 4000, 100);
      if (!option) {
        document.body.click(); // close the dropdown so we do not leave it hanging
        const err = new Error(`Reason option "${reason}" did not render`);
        err.learnKey = `reason-option:${reason}`;
        throw err;
      }
      option.click();
    });

    // 3. Save Outcome (RSVP / PreferredDeveloper chips are never touched).
    // Both confirmation detectors are created BEFORE clicking, so anything
    // already on screen (a stale toast, the reason text in the form itself)
    // can't satisfy this lead's confirmation.
    const freshConfirm = makeFreshToastDetector(C.CRM.SAVE_CONFIRM_RE);
    const reasonMarker = makeReasonMarkerDetector(reason);
    await act('click "Save Outcome"', async () => {
      const btn = await waitFor(
        () => findButton(C.CRM.SAVE_OUTCOME_TEXT) || learnedEl('save-outcome'), 4000);
      if (!btn) throw new Error('Save Outcome button not found');
      btn.click();
    }, 'save-outcome');

    // 4. Wait for proof the save landed (spec: "Save Outcome -> wait for
    // confirm"). The live CRM shows no matching toast, but a successful save
    // DOES change the page — a new Activity feed entry appears with the reason
    // text (e.g. "left voicemail") and/or the outcome form resets. Accept a
    // fresh confirm toast OR that reason-text change as confirmation; pause
    // only if NEITHER appears (set CRM.REQUIRE_SAVE_CONFIRM=false to downgrade
    // that pause to a warning).
    const confirmed = await waitFor(
      () => freshConfirm() || reasonMarker(), C.CRM.SAVE_CONFIRM_TIMEOUT_MS, 250);
    if (!confirmed) {
      if (C.CRM.REQUIRE_SAVE_CONFIRM) {
        throw new ActionError(
          `confirm the outcome save (no confirmation toast after "${reason}" — ` +
          'check the outcome saved, or set CRM.REQUIRE_SAVE_CONFIRM=false / fix ' +
          'CRM.SAVE_CONFIRM_RE in config.js)');
      }
      pushLog('warn', 'No save confirmation toast seen — continuing');
    }

    pushLog('ok', `Logged: ${reason}`);
  }

  // Detects the page-level footprint of a successful save: the Activity feed
  // gains an entry containing the reason ("left voicemail" / "no_answer" —
  // underscores and case vary, so counting is done on normalized text), and/or
  // the outcome form resets (removing the selected reason). Either way the
  // number of occurrences of the reason text CHANGES from the pre-save
  // baseline; while nothing happens it stays identical.
  function normalizedBodyCount(needle) {
    const hay = (document.body.innerText || '').toLowerCase().replace(/[_\W]+/g, ' ');
    let n = 0;
    let i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) { n += 1; i += needle.length; }
    return n;
  }

  function makeReasonMarkerDetector(reason) {
    const needle = reason.toLowerCase().replace(/[_\W]+/g, ' ').trim();
    const before = normalizedBodyCount(needle);
    return () => normalizedBodyCount(needle) !== before;
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
      const btn = await waitFor(
        () => findButton(C.CRM.NEXT_BUTTON_TEXT) || learnedEl('next'), 4000);
      if (!btn) throw new Error('Next button not found');
      btn.click();
    }, 'next');
    const changed = await waitFor(
      () => leadFingerprint() !== before, C.CRM.ADVANCE_TIMEOUT_MS, 400);
    if (!changed) {
      throw new ActionError('advance to the next lead (the page never showed a new lead)');
    }
  }

  // ---------------------------------------------------------------------------
  // Call listening (beta, opt-in) — hears YOUR microphone side only, matches
  // CALL_CUES against what you say, and SUGGESTS an outcome with timestamps.
  // It never captures the lead's audio and never acts on a suggestion.
  // ---------------------------------------------------------------------------
  let listener = null; // {mode, stop()} while active

  function listenElapsed() {
    const base = S.connectedAt || S.callStartedAt || Date.now();
    const s = Math.max(0, Math.floor((Date.now() - base) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function handleUtterance(text) {
    if (!text || !S.listen.active) return;
    for (const cue of C.CALL_CUES) {
      if (!cue.re.test(text)) continue;
      const at = listenElapsed();
      S.listen.suggestion = cue.label;
      S.listen.cues.push({ at, tag: cue.tag, label: cue.label });
      if (S.listen.cues.length > 8) S.listen.cues.shift();
      pushLog('info', `🎙 ${at} heard a "${cue.label}" cue in what you said`);
      pushStatus();
      return; // first matching cue wins for this utterance
    }
  }

  async function startListening() {
    if (listener || !S.settings.LISTEN_ENABLED) return;
    S.listen = { active: true, suggestion: null, cues: [], unavailable: false };
    try {
      listener = S.settings.LISTEN_MODE === 'local_server'
        ? await startLocalServerListener()
        : startWebSpeechListener();
      pushLog('info', `🎙 Listening to your mic (${S.settings.LISTEN_MODE}) — suggestions only, nothing is stored`);
    } catch (e) {
      listener = null;
      S.listen = { active: false, suggestion: null, cues: [], unavailable: true };
      pushLog('warn', `Call listening unavailable: ${String(e && e.message || e)}`);
    }
    pushStatus();
  }

  function stopListening() {
    if (!listener) return;
    try { listener.stop(); } catch (e) { /* already dead */ }
    listener = null;
    S.listen.active = false;
    pushStatus();
  }

  // Mode 1: Chrome's built-in Web Speech API. Zero install; depending on the
  // browser/platform the audio may be processed by the browser vendor's
  // servers (documented on the options page).
  function startWebSpeechListener() {
    const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!SR) throw new Error('SpeechRecognition not supported in this browser');
    let stopped = false;
    const rec = new SR();
    rec.lang = S.settings.LISTEN_LANG;
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) handleUtterance(ev.results[i][0].transcript);
      }
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        stopped = true;
        S.listen.unavailable = true;
        pushLog('warn', 'Microphone access denied — call listening off for this session');
      }
    };
    rec.onend = () => { if (!stopped && S.listen.active) { try { rec.start(); } catch (e) { /* busy */ } } };
    rec.start();
    return { mode: 'webspeech', stop: () => { stopped = true; try { rec.stop(); } catch (e) {} } };
  }

  // Mode 2: record 5s mic chunks and have the background worker POST them to a
  // LOCAL Whisper-compatible endpoint (Voicebox / OmniVoice Studio /
  // whisper.cpp server) — audio never leaves your machine.
  async function startLocalServerListener() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = async (ev) => {
      if (!S.listen.active || !ev.data || ev.data.size < 2000) return;
      try {
        const buf = await ev.data.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        const res = await chrome.runtime.sendMessage({
          type: C.MSG.STT_TRANSCRIBE,
          b64: btoa(bin),
          mime: ev.data.type || 'audio/webm',
          url: S.settings.LISTEN_STT_URL,
        });
        if (res && res.ok) handleUtterance(res.text || '');
        else if (res && res.error && !S.listen.unavailable) {
          S.listen.unavailable = true;
          pushLog('warn', `Local STT server error: ${res.error} — is Voicebox/whisper running at ${S.settings.LISTEN_STT_URL}?`);
        }
      } catch (e) { /* extension context gone */ }
    };
    recorder.start(5000); // one chunk every 5s
    return {
      mode: 'local_server',
      stop: () => {
        try { recorder.stop(); } catch (e) {}
        for (const t of stream.getTracks()) t.stop();
      },
    };
  }

  // Learning: associate the cues heard with the decision you then made, so the
  // options page can show which of your phrases predict which outcome and how
  // early in the call your decisions typically happen.
  function recordListenOutcome(decision) {
    if (!S.settings.LISTEN_ENABLED || !learningOn()) return;
    const callSec = S.connectedAt ? Math.round((Date.now() - S.connectedAt) / 1000) : 0;
    const tags = [...new Set(S.listen.cues.map((c) => c.tag))];
    L.recordCueOutcome({ tags, decision, callSec }).catch(() => {});
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
    await ensureCampaignVisible();
    const lead = extractLead();
    S.lead = lead;
    if (!lead.name && !lead.phone) {
      throw new ActionError('read the lead from the page (no name/phone found — is a lead page open?)');
    }
    pushLog('info',
      `Lead ${lead.counter || '?'}: ${lead.name || '(no name)'} ${lead.phone || ''} — ${lead.campaignTag || 'no campaign tag'}`);

    // Snapshot token/timer text already on screen (e.g. a static "Calling"
    // chip on the phone number) BEFORE dialing, so it can't read as call state.
    const stateBaseline = tokenBaseline();
    await clickCallNow();
    S.dialedCount += 1;
    S.tally.dialed += 1;
    S.callStartedAt = Date.now();
    startTicker();
    setPhase('dialing');

    let outcome;
    try {
      outcome = await watchCall(stateBaseline);
    } finally {
      stopTicker();
    }

    if (outcome.kind === 'connected') {
      S.connectedAt = Date.now();
      // Learning mechanism 3: remember how long answered calls actually rang.
      if (learningOn()) {
        L.recordRingSec(Math.round((S.connectedAt - S.callStartedAt) / 1000)).catch(() => {});
      }
      await startListening(); // no-op unless LISTEN_ENABLED
      startTicker();
      setPhase('connected', 'Voicemail / Live / Pre-stage / Skip?');
      pushLog('info', 'CONNECTED — listen: Voicemail, Live, Pre-stage or Skip?');
      let decision;
      try {
        decision = await awaitDecision(); // 'voicemail' | 'live' | 'prestage' | 'skip'
      } finally {
        stopTicker();
      }
      recordListenOutcome(decision);

      if (decision === 'stop') {
        // Operator pressed Stop mid-call: hang up, log nothing (a fabricated
        // outcome would violate the "decisions stay manual" rule), and leave
        // the lead exactly as-is. The session loop exits right after this
        // because stopRequested is already true.
        stopListening();
        await endCall();
        pushLog('info', 'Stopped mid-call — no outcome logged; this lead was left as-is');
        return;
      }

      if (decision === 'voicemail') {
        stopListening();
        await endCall();
        prestageMissWhatsApp(lead);
        await logOutcome(C.REASONS.VOICEMAIL);
        S.tally.voicemail += 1;
        await advance();
      } else if (decision === 'live') {
        S.tally.live += 1;
        // Freeze with the call still up — the human runs the interested branch
        // (warmth, RSVP, sends, calendar, Save Outcome, Next) entirely by hand.
        // Keep listening through the freeze: the RSVP phrases happen here.
        await freeze('live',
          'LIVE call — handle it manually. When done (Save Outcome + Next), press Resume.');
        recordListenOutcome('live_resumed');
        stopListening();
      } else if (decision === 'prestage') {
        await doPrestage(lead);
        S.tally.prestaged += 1;
        await freeze('prestage',
          'Drafts staged (nothing sent). Finish the lead manually (Save Outcome + Next), then press Resume.');
        recordListenOutcome('prestage_resumed');
        stopListening();
      } else { // skip
        stopListening();
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
    S.unmappedSeen = new Set();
    S.learned = await L.load();
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
        stopListening();
        if (e instanceof ActionError) {
          S.tally.errors += 1;
          // Safety rule: never continue past a failed selector — pause and
          // surface the intended action; the human fixes/does it, then Resumes.
          // Resume redials whatever lead is on screen, so the instructions must
          // say to finish this lead (incl. Next) first — otherwise a lead whose
          // outcome was already saved would be dialed and logged twice.
          const teachable = !!(e.learnKey && learningOn());
          if (teachable) startTeach(e.learnKey);
          await freeze('error',
            `Selector failed — intended action: ${e.intended}. ` +
            'Finish this lead by hand (do the action, make sure the outcome is ' +
            'saved, and click Next if this lead is done), then press Resume — ' +
            'dialing continues from the lead on screen.' +
            (teachable
              ? ' TEACH IT: the click you make to perform this action will be learned as a fallback.'
              : ''));
          await finishTeach(teachable);
        } else {
          S.tally.errors += 1;
          await freeze('error', `Unexpected error: ${e && e.message}. Press Resume to continue.`);
        }
      }
    }

    S.running = false;
    S.stopRequested = false;
    stopTicker();
    stopListening();
    setPhase('idle');
    const t = S.tally;
    pushLog('info',
      `Session ended — dialed ${t.dialed}: ${t.noAnswer} no-answer, ${t.voicemail} voicemail, ` +
      `${t.busy} busy, ${t.dropped} dropped, ${t.techFailure} tech-failure, ${t.invalid} invalid, ` +
      `${t.live} live, ${t.prestaged} pre-staged, ${t.skipped} skipped, ${t.errors} errors`);
    if (learningOn()) {
      const tip = L.ringTimeoutTip(S.learned, S.settings.RING_TIMEOUT_MS);
      if (tip) pushLog('info', tip);
    }
  }

  function requestStop() {
    if (!S.running) return;
    S.stopRequested = true;
    if (pendingDecision) {
      // Stop must always be able to end the session — don't leave the
      // operator stuck forever waiting on Voicemail/Live/Pre-stage/Skip (e.g.
      // if they ended the call from the CRM's own controls instead of here).
      pushLog('info', 'Stop requested while a call is connected — hanging up, no outcome logged, ending the session');
      pendingDecision.resolve('stop');
    } else if (pendingResume) {
      // Stopping while frozen ends the session in place — no logging, no
      // advancing happens after a freeze, so nothing is skipped.
      pushLog('info', 'Stop requested while frozen — ending the session');
      pendingResume.resolve();
    } else {
      pushLog('info', 'Stop requested — finishing the current lead first');
    }
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

  // Keep the learned-data cache current with options-page edits (approvals,
  // forgets, the enable toggle) without needing a page reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[L.STORAGE_KEY]) {
        S.learned = L.normalize(changes[L.STORAGE_KEY].newValue);
      }
    });
  } catch (e) { /* context gone */ }

  // Announce ourselves so an already-open panel picks up the current state.
  ;(async () => {
    S.settings = await C.getSettings();
    S.learned = await L.load();
    S.lead = extractLead();
    pushStatus();
  })();
})();
