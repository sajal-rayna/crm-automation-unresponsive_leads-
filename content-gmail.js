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
  if (globalThis.__RAYNA_GMAIL_LOADED__) return; // guard against re-injection
  globalThis.__RAYNA_GMAIL_LOADED__ = true;

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
    // Gmail's rows react to real mouse-down/up sequences, not synthetic
    // .click() — dispatch the full pointer sequence at the element's center.
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        el.dispatchEvent(type.startsWith('pointer')
          ? new PointerEvent(type, opts) : new MouseEvent(type, opts));
      } catch (e) { /* PointerEvent unavailable — mouse events suffice */ }
    }
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
    let to = allVisible(C.GMAIL.TO_FIELD, dialog)[0];
    if (!to) {
      // Recipient-less drafts open with the To row collapsed into a
      // "Recipients" strip — expand it, then look for the input again.
      const activator = allVisible(C.GMAIL.TO_ACTIVATOR, dialog)[0] ||
        [...dialog.querySelectorAll('div, span')].find((el) =>
          isVisible(el) && el.childElementCount <= 2 &&
          /^(Recipients|To)$/i.test(textOf(el)));
      if (activator) {
        guardedClick(activator, 'expanding the recipients row');
        await sleep(700);
        to = allVisible(C.GMAIL.TO_FIELD, dialog)[0];
      }
    }
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

  // --- optional stored image (set on the options page) --------------------
  async function getStoredImage() {
    try {
      const o = await chrome.storage.local.get('RAYNA_IMAGES');
      return (o.RAYNA_IMAGES || {}).gmail || null;
    } catch (e) { return null; }
  }

  function dataUrlToFile(dataUrl, name) {
    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name || 'image.png', { type: mime });
  }

  // Paste the stored image into the compose body (compose mode) — identical
  // to the user pressing Cmd+V; Gmail uploads it inline. Never sends.
  async function attachImage() {
    const img = await getStoredImage();
    if (!img) return { ok: true, detail: 'no Gmail image configured' };
    const t0 = Date.now();
    let body = null;
    while (Date.now() - t0 < 20000 && !body) {
      body = allVisible(C.GMAIL.BODY_FIELD)[0] || null;
      if (!body) await sleep(400);
    }
    if (!body) return { ok: false, detail: 'compose body not found — insert the image manually' };
    const dt = new DataTransfer();
    dt.items.add(dataUrlToFile(img.dataUrl, img.name));
    body.focus();
    body.dispatchEvent(new ClipboardEvent('paste',
      { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(1200);
    return { ok: true, detail: 'image inserted into the compose body' };
  }

  // Serialized so overlapping pre-stage requests can't edit the same compose.
  let queue = Promise.resolve();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === C.MSG.GMAIL_PRESTAGE) {
      queue = queue
        .then(() => prestage(msg.email, msg.firstName, msg.subject))
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, detail: String(e && e.message || e) }));
      return true; // async response
    }
    if (msg.type === C.MSG.GMAIL_ATTACH) {
      queue = queue
        .then(attachImage)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, detail: String(e && e.message || e) }));
      return true; // async response
    }
    return false;
  });
})();
