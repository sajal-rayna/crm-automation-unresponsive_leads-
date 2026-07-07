// content-gmail.js — pre-stage ONLY. Finds the RSVP draft by subject, opens it,
// sets To = lead email, personalizes the salutation token. It NEVER sends:
//   - guardedClick() refuses to click anything whose text/label looks like Send
//   - no keyboard events are synthesized anywhere (recipient chips commit on
//     blur, not Enter)
//
// *** BRITTLE #2 (see handoff doc): Gmail's DOM is obfuscated and shifts.
// Every selector lives in config.js (GMAIL.*) as a candidate list, and on ANY
// failure this script falls back to just opening the Drafts view so the human
// can take over — it never blocks the flow. ***

(() => {
  const C = globalThis.RAYNA;
  if (!C) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  const textOf = (el) =>
    ((el && (el.innerText != null ? el.innerText : el.textContent)) || '').trim();

  function firstVisible(candidates, root = document) {
    for (const sel of candidates) {
      for (const el of root.querySelectorAll(sel)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  async function waitForAny(candidates, timeoutMs, pollMs = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const el = firstVisible(candidates);
      if (el) return el;
      await sleep(pollMs);
    }
    return null;
  }

  // HARD SAFETY RULE: refuse to click anything that could send/submit.
  function guardedClick(el, why) {
    const label = `${el.getAttribute('aria-label') || ''} ${textOf(el)}`.trim();
    if (C.FORBIDDEN_CLICK_RE.test(label)) {
      throw new Error(`SAFETY: refused to click "${label}" while ${why}`);
    }
    el.click();
  }

  function openDraftsFallback() {
    try { location.hash = C.GMAIL.DRAFTS_HASH; } catch (e) { /* best effort */ }
  }

  async function setToField(email) {
    const to = firstVisible(C.GMAIL.TO_FIELD);
    if (!to) return false;
    to.focus();
    // If a recipient is already chipped in, leave it alone.
    const dialog = to.closest('div[role="dialog"]') || document;
    if (textOf(dialog).includes(email)) return true;
    if ('value' in to) {
      const proto = Object.getPrototypeOf(to);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(to, email);
      else to.value = email;
      to.dispatchEvent(new InputEvent('input', { bubbles: true, data: email }));
    } else {
      document.execCommand('insertText', false, email);
    }
    // Blur commits the chip — no Enter keystroke needed (or wanted).
    to.blur();
    await sleep(400);
    return true;
  }

  function personalizeBody(firstName) {
    const body = firstVisible(C.GMAIL.BODY_FIELD);
    if (!body || !firstName) return false;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let replaced = false;
    let node;
    while ((node = walker.nextNode())) {
      if (C.GMAIL.NAME_TOKEN_RE.test(node.textContent)) {
        node.textContent = node.textContent.replace(C.GMAIL.NAME_TOKEN_RE, firstName);
        replaced = true;
      }
    }
    if (replaced) {
      body.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return replaced;
  }

  async function prestage(email, firstName, subject) {
    try {
      // 1. Search the drafts for the RSVP template by subject.
      location.hash = C.GMAIL.searchHash(subject);
      const row = await waitForAny(C.GMAIL.RESULT_ROW, C.GMAIL.STEP_TIMEOUT_MS);
      if (!row) {
        openDraftsFallback();
        return {
          ok: false,
          detail: `draft "${subject}" not found by search — Drafts opened, stage manually`,
        };
      }

      // 2. Open the draft (a draft row opens straight into compose).
      guardedClick(row, 'opening the draft');
      const dialog = await waitForAny(C.GMAIL.COMPOSE_DIALOG, C.GMAIL.STEP_TIMEOUT_MS);
      if (!dialog) {
        openDraftsFallback();
        return { ok: false, detail: 'draft did not open into compose — Drafts opened, stage manually' };
      }
      await sleep(800); // let compose finish wiring up

      // 3. To = lead email; 4. personalize "Dear [FirstName]," — both best-effort.
      const toOk = await setToField(email);
      const nameOk = personalizeBody(firstName);

      const parts = [];
      parts.push(toOk ? `To set to ${email}` : `could NOT set To (add ${email} manually)`);
      parts.push(nameOk ? 'salutation personalized' : 'no [FirstName] token found — check salutation');
      return { ok: toOk, detail: `draft opened; ${parts.join('; ')}. Review and press Send yourself` };
    } catch (e) {
      // Isolation per spec: any failure -> just open the Drafts view.
      openDraftsFallback();
      return { ok: false, detail: `Gmail pre-stage failed (${String(e && e.message || e)}) — Drafts opened` };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== C.MSG.GMAIL_PRESTAGE) return false;
    prestage(msg.email, msg.firstName, msg.subject)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, detail: String(e && e.message || e) }));
    return true; // async response
  });
})();
