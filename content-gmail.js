// content-gmail.js — pre-stage ONLY. Finds the RSVP draft by subject, opens it,
// sets To = lead email, personalizes the salutation token. It NEVER sends:
//   - guardedClick() refuses to click anything whose label looks like Send
//   - no keyboard events are synthesized anywhere (recipient chips commit on
//     blur, not Enter)
//
// Wrong-draft protection: a result row is only clicked if its own text contains
// the draft subject, and To/body edits are scoped to the compose window whose
// Subject field matches GMAIL_DRAFT_SUBJECT — a pre-existing unrelated compose
// window is never touched.
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

  function allVisible(candidates, root = document) {
    const out = [];
    for (const sel of candidates) {
      for (const el of root.querySelectorAll(sel)) {
        if (isVisible(el)) out.push(el);
      }
      if (out.length) break;
    }
    return out;
  }

  // HARD SAFETY RULE: refuse to click anything that could send/submit.
  // Button-like elements are checked on label + text; rows on aria-label/title
  // only (a draft snippet containing the word "send" must not block the click —
  // clicking a list row cannot send anything).
  function guardedClick(el, why) {
    const attrs = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
    const buttonish = el.matches(
      'button, [role="button"], input[type="submit"], input[type="button"], a');
    const label = buttonish ? `${attrs} ${textOf(el)}` : attrs;
    if (C.FORBIDDEN_CLICK_RE.test(label.trim())) {
      throw new Error(`SAFETY: refused to click "${label.trim()}" while ${why}`);
    }
    el.click();
  }

  function openDraftsFallback() {
    try { location.hash = C.GMAIL.DRAFTS_HASH; } catch (e) { /* best effort */ }
  }

  // The compose window that belongs to OUR draft: its Subject field must match.
  function findVerifiedCompose(subject) {
    const want = subject.trim().toLowerCase();
    for (const field of allVisible(C.GMAIL.SUBJECT_FIELD)) {
      const have = (field.value || '').trim().toLowerCase();
      const match = have === want ||
        (have.length >= 12 && (have.includes(want) || want.includes(have)));
      if (!match) continue;
      const dialog = field.closest('div[role="dialog"]');
      if (dialog) return dialog;
      // Full-screen/inline compose: scope to an ancestor of the verified
      // subject field — NEVER the whole document, or the To/body edits could
      // land in some other open compose window.
      let node = field;
      for (let i = 0; i < 8 && node.parentElement && node.parentElement !== document.body; i++) {
        node = node.parentElement;
      }
      return node;
    }
    return null;
  }

  async function waitForVerifiedCompose(subject, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const dialog = findVerifiedCompose(subject);
      if (dialog) return dialog;
      await sleep(300);
    }
    return null;
  }

  // A search-result row for OUR draft: its text must contain the subject.
  async function findSubjectRow(subject, timeoutMs) {
    const snippet = subject.slice(0, 40).toLowerCase();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (const row of allVisible(C.GMAIL.RESULT_ROW)) {
        if (textOf(row).toLowerCase().includes(snippet)) return row;
      }
      await sleep(300);
    }
    return null;
  }

  function chippedRecipients(dialog) {
    const out = [];
    for (const sel of C.GMAIL.RECIPIENT_CHIP) {
      for (const el of dialog.querySelectorAll(sel)) {
        const v = (el.getAttribute('email') || el.getAttribute('data-hovercard-id') || '')
          .trim().toLowerCase();
        if (v.includes('@') && !out.includes(v)) out.push(v);
      }
    }
    return out;
  }

  async function setToField(dialog, email) {
    const to = allVisible(C.GMAIL.TO_FIELD, dialog)[0];
    if (!to) return { ok: false, note: `To field not found — add ${email} manually` };
    // A reused compose window may still carry the PREVIOUS lead's chip; adding
    // ours next to it would address the email to both. Never type alongside an
    // existing recipient — surface it for manual cleanup instead.
    const chips = chippedRecipients(dialog);
    if (chips.includes(email.toLowerCase())) return { ok: true, note: `To already set to ${email}` };
    if (chips.length) {
      return {
        ok: false,
        note: `another recipient is already in To (${chips.join(', ')}) — clear it and add ${email} manually`,
      };
    }
    if (textOf(dialog).includes(email)) return { ok: true, note: `To already set to ${email}` };
    to.focus();
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
    return { ok: true, note: `To set to ${email}` };
  }

  function personalizeBody(dialog, firstName) {
    const body = allVisible(C.GMAIL.BODY_FIELD, dialog)[0];
    if (!body || !firstName) return false;
    // Fresh regex per call: the config one is /g and .test()/replace would
    // otherwise share lastIndex state across text nodes and skip matches.
    const tokenRe = new RegExp(C.GMAIL.NAME_TOKEN_RE.source, 'gi');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let replaced = false;
    let node;
    while ((node = walker.nextNode())) {
      const next = node.textContent.replace(tokenRe, firstName);
      if (next !== node.textContent) {
        node.textContent = next;
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
      // 0. If our draft's compose window is already open, use it directly.
      let dialog = findVerifiedCompose(subject);

      if (!dialog) {
        // 1. Search the drafts for the RSVP template by subject.
        location.hash = C.GMAIL.searchHash(subject);
        const row = await findSubjectRow(subject, C.GMAIL.STEP_TIMEOUT_MS);
        if (!row) {
          openDraftsFallback();
          return {
            ok: false,
            detail: `draft "${subject}" not found by search — Drafts opened, stage manually`,
          };
        }

        // 2. Open the draft (a draft row opens straight into compose) and wait
        // for a compose window whose SUBJECT matches — never edit any other.
        guardedClick(row, 'opening the draft');
        dialog = await waitForVerifiedCompose(subject, C.GMAIL.STEP_TIMEOUT_MS);
        if (!dialog) {
          openDraftsFallback();
          return {
            ok: false,
            detail: 'no compose window with the expected subject appeared — Drafts opened, stage manually',
          };
        }
        await sleep(800); // let compose finish wiring up
      }

      // 3. To = lead email; 4. personalize "Dear [FirstName]," — both scoped
      // to the verified dialog, both best-effort.
      const toRes = await setToField(dialog, email);
      const nameOk = personalizeBody(dialog, firstName);

      const parts = [];
      parts.push(toRes.note);
      parts.push(nameOk ? 'salutation personalized' : 'no [FirstName] token found — check salutation');
      return { ok: toRes.ok, detail: `draft opened; ${parts.join('; ')}. Review and press Send yourself` };
    } catch (e) {
      // Isolation per spec: any failure -> just open the Drafts view.
      openDraftsFallback();
      return { ok: false, detail: `Gmail pre-stage failed (${String(e && e.message || e)}) — Drafts opened` };
    }
  }

  // Serialized so overlapping pre-stage requests can't edit the same compose.
  let queue = Promise.resolve();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== C.MSG.GMAIL_PRESTAGE) return false;
    queue = queue
      .then(() => prestage(msg.email, msg.firstName, msg.subject))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, detail: String(e && e.message || e) }));
    return true; // async response
  });
})();
