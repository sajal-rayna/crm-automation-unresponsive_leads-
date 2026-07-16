// background.js — MV3 service worker. Deliberately thin: the session state
// machine lives in content-crm.js (it survives worker suspension). This worker
// only (1) relays panel commands and hotkeys to the CRM tab, and (2) fans a
// pre-stage request out to the WhatsApp / Gmail tabs. It never clicks Send,
// never touches a calendar.

importScripts('config.js');
const C = globalThis.RAYNA;

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------------------------------------------------------------------------
// Content-script self-healing. Tabs opened BEFORE the extension was installed
// or reloaded never get manifest content scripts — the classic "Receiving end
// does not exist" (users refresh the CRM tab but never their Gmail/WhatsApp
// tabs). Inject into existing matching tabs on install/update, and again
// on-demand when a message bounces.
// ---------------------------------------------------------------------------
const CONTENT_SCRIPT_SETS = [
  { pattern: () => C.CRM.TAB_URL_PATTERN, files: ['config.js', 'learning.js', 'content-crm.js'] },
  { pattern: () => C.WA.TAB_URL_PATTERN, files: ['config.js', 'content-whatsapp.js'] },
  { pattern: () => C.GMAIL.TAB_URL_PATTERN, files: ['config.js', 'content-gmail.js'] },
];

chrome.runtime.onInstalled.addListener(async () => {
  for (const set of CONTENT_SCRIPT_SETS) {
    try {
      const tabs = await chrome.tabs.query({ url: set.pattern() });
      for (const tab of tabs) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: set.files })
          .catch(() => { /* chrome:// or discarded tab — ignore */ });
      }
    } catch (e) { /* pattern query failed — ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Tab lookup helpers
// ---------------------------------------------------------------------------
async function findCrmTab() {
  const tabs = await chrome.tabs.query({ url: C.CRM.TAB_URL_PATTERN });
  if (!tabs.length) return null;
  return tabs.find((t) => (t.url || '').includes(C.CRM.LEAD_PATH)) || tabs[0];
}

async function findTab(pattern) {
  const tabs = await chrome.tabs.query({ url: pattern });
  return tabs[0] || null;
}

// Send a message to a tab, retrying while its content script loads. If the
// tab has no listener at all (opened before the extension loaded), inject the
// given content-script files once and keep retrying.
async function sendToTab(tabId, msg, { retries = 6, delayMs = 1000, files = null } = {}) {
  let lastErr = null;
  let injected = false;
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      lastErr = e;
      if (!injected && files && /Receiving end does not exist/i.test(String(e))) {
        injected = true;
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files });
        } catch (e2) { /* tab not injectable — keep retrying anyway */ }
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr || new Error('tab did not respond');
}

async function sendToCrm(cmd) {
  const tab = await findCrmTab();
  if (!tab) {
    return { ok: false, error: 'CRM tab / lead not found — open a ' +
      `${C.CRM.HOST}${C.CRM.LEAD_PATH}… page and reload it.` };
  }
  try {
    const res = await sendToTab(tab.id, { type: C.MSG.CRM_CMD, cmd },
      { retries: 2, delayMs: 500, files: ['config.js', 'learning.js', 'content-crm.js'] });
    return res || { ok: true };
  } catch (e) {
    return { ok: false, error: 'CRM page is not responding — reload the CRM tab.' };
  }
}

// ---------------------------------------------------------------------------
// Pre-stage orchestration (never sends; content scripts enforce the same rule)
// ---------------------------------------------------------------------------
// NOTE: racing does not cancel the underlying work — the content script may
// still finish after the deadline, so the timeout message must not claim
// outright failure.
const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(
      `${what} timed out — it may still finish; check that tab before staging manually`)), ms)),
  ]);

async function prestageWhatsApp(lead, waText, settings) {
  if (!lead.phone) return { ok: false, detail: 'lead has no phone — WhatsApp skipped' };
  const digits = lead.phone.replace(/\D/g, '');
  if (digits.length < C.WA.MIN_PHONE_DIGITS) {
    return { ok: false, detail: `lead phone "${lead.phone}" looks invalid — WhatsApp skipped` };
  }

  if (settings.WHATSAPP_MODE === 'wa_link') {
    // wa_link mode: let WhatsApp itself pre-fill the composer via a /send link.
    const url = C.WA.SEND_LINK(digits, waText);
    const existing = await findTab(C.WA.TAB_URL_PATTERN);
    if (existing) await chrome.tabs.update(existing.id, { url });
    else await chrome.tabs.create({ url, active: false });
    return { ok: true, detail: 'wa.me link opened — review and press Send yourself' };
  }

  // existing_tab mode: fill the composer in the already-open WhatsApp Web tab.
  const tab = await findTab(C.WA.TAB_URL_PATTERN);
  if (!tab) return { ok: false, detail: 'WhatsApp Web tab not open — open web.whatsapp.com' };
  // Budget > worst-case legitimate latency: ~32s per fill (3 waits + sleeps)
  // plus one queued fill ahead of us (fills are serialized in the tab).
  const res = await withTimeout(
    sendToTab(tab.id, {
      type: C.MSG.WA_FILL,
      phone: digits,
      text: waText,
      leadName: lead.name || '',
    }, { files: ['config.js', 'content-whatsapp.js'] }),
    75000, 'WhatsApp pre-stage');
  return res || { ok: false, detail: 'no response from WhatsApp tab' };
}

async function prestageGmail(lead, settings) {
  if (!lead.email) return { ok: false, detail: 'lead has no email — Gmail skipped' };
  let tab = await findTab(C.GMAIL.TAB_URL_PATTERN);
  if (!tab) {
    tab = await chrome.tabs.create({ url: C.GMAIL.URL, active: false });
    await new Promise((r) => setTimeout(r, 4000)); // let Gmail boot
  }
  // Budget > worst-case legitimate latency: ~32s per pre-stage (2 waits +
  // sleeps) plus delivery retries while a just-created Gmail tab boots.
  const res = await withTimeout(
    sendToTab(tab.id, {
      type: C.MSG.GMAIL_PRESTAGE,
      email: lead.email,
      firstName: lead.firstName,
      subject: settings.GMAIL_DRAFT_SUBJECT,
    }, { retries: 10, delayMs: 1500, files: ['config.js', 'content-gmail.js'] }),
    90000, 'Gmail pre-stage');
  return res || { ok: false, detail: 'no response from Gmail tab' };
}

// MV3 kills an idle service worker after ~30s, and merely awaiting a content
// script's sendResponse does NOT reset that clock. While a pre-stage is in
// flight (up to ~90s), ping a trivial extension API to stay alive — otherwise
// a hotkey-driven session with the side panel closed loses the orchestration
// mid-flight and the CRM sees "message port closed".
function keepAlive() {
  const id = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* dying anyway */ }
  }, 20000);
  return () => clearInterval(id);
}

async function handlePrestage(msg) {
  const { lead, waText, channels } = msg;
  const stopKeepAlive = keepAlive();
  try {
    const settings = msg.settings || (await C.getSettings());
    const out = {};
    if (channels.includes('wa')) {
      try { out.wa = await prestageWhatsApp(lead, waText, settings); }
      catch (e) { out.wa = { ok: false, detail: String(e && e.message || e) }; }
    }
    if (channels.includes('gmail')) {
      try { out.gmail = await prestageGmail(lead, settings); }
      catch (e) { out.gmail = { ok: false, detail: String(e && e.message || e) }; }
    }
    return out;
  } finally {
    stopKeepAlive();
  }
}

// ---------------------------------------------------------------------------
// Call-listening STT relay: POST a mic chunk to a LOCAL Whisper-compatible
// server (Voicebox / OmniVoice Studio / whisper.cpp). Locked to localhost so
// call audio can never be routed off this machine, whatever the settings say.
// ---------------------------------------------------------------------------
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

async function handleTranscribe(msg) {
  let host;
  try { host = new URL(msg.url).hostname; } catch (e) { return { ok: false, error: 'bad STT URL' }; }
  if (!LOCAL_HOSTS.has(host)) {
    return { ok: false, error: 'STT URL must be localhost — audio is never sent off this machine' };
  }
  const bin = atob(msg.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: msg.mime || 'audio/webm' }), 'chunk.webm');
  form.append('model', 'whisper-1'); // OpenAI-compatible servers expect it; others ignore it
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(msg.url, { method: 'POST', body: form, signal: ctrl.signal });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    return { ok: true, text: data.text || data.transcription || '' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Campaign probe: runs in the PAGE's JS world (world: MAIN) and walks the
// React fiber props/state around the Raw Source Data header for CampaignTag
// values the UI hasn't rendered — works even when the card never expands.
// Personal-use read of the user's own CRM page state; touches nothing.
// ---------------------------------------------------------------------------
function CAMPAIGN_PROBE_FN() {
  try {
    // Values found under a literal CampaignTag/Campaignname key are exact —
    // report them ahead of values regex-extracted out of string blobs.
    const direct = new Set();
    const found = new Set();
    const seen = new Set();
    const record = (v, isDirect) => {
      if (typeof v === 'string' && v.trim().length >= 3 && v.length <= 120) {
        (isDirect ? direct : found).add(v.trim());
      }
    };
    const extract = (s) => {
      // Terminator-aware first so apostrophes inside the value (November'25)
      // survive; loose fallback for strings with no clean terminator.
      let m = s.match(/Campaign(?:Tag|name)\\?["'‘’“”]?\s*[:=]\s*\\?["'‘’“”]\s*(.+?)\\?["'‘’“”]\s*[,}\]]/);
      if (!m) m = s.match(/Campaign(?:Tag|name)\\?["'‘’“”]?\s*[:=]\s*\\?["'‘’“”]\s*([^"'‘’“”\\]{3,80})/);
      if (m) record(m[1]);
    };
    const visit = (obj, depth) => {
      if (obj == null || seen.size > 30000) return;
      const t = typeof obj;
      if (t === 'string') { if (obj.indexOf('Campaign') !== -1) extract(obj); return; }
      if (t !== 'object') return;
      if (seen.has(obj) || depth > 6) return;
      seen.add(obj);
      if (obj.nodeType) return; // never wander into DOM nodes
      let keys;
      try { keys = Object.keys(obj); } catch (e) { return; }
      for (const k of keys) {
        let v;
        try { v = obj[k]; } catch (e) { continue; }
        const nk = k.replace(/[\s_]/g, '').toLowerCase();
        if (nk === 'campaigntag' || nk === 'campaignname') { record(v, true); continue; }
        visit(v, depth + 1);
      }
    };
    const headers = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.childElementCount <= 2 && /^Raw Source Data$/i.test((el.innerText || '').trim())) {
        headers.push(el);
      }
    }
    for (const header of headers.slice(0, 2)) {
      let node = header;
      for (let up = 0; node && up < 10; up++) {
        for (const key of Object.keys(node)) {
          if (key.indexOf('__reactProps$') === 0) { visit(node[key], 0); continue; }
          if (key.indexOf('__reactFiber$') === 0) {
            let fiber = node[key];
            for (let i = 0; fiber && i < 40; i++) {
              visit(fiber.memoizedProps, 0);
              visit(fiber.memoizedState, 0);
              visit(fiber.pendingProps, 0);
              fiber = fiber.return;
            }
          }
        }
        node = node.parentElement;
      }
    }
    return [...direct, ...[...found].filter((v) => !direct.has(v))];
  } catch (e) {
    return [];
  }
}

async function handleCampaignProbe(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (!tabId) return { ok: false, error: 'no tab' };
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: CAMPAIGN_PROBE_FN,
  });
  return { ok: true, tags: (results && results[0] && results[0].result) || [] };
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === C.MSG.PANEL_CMD) {
    sendToCrm(msg.cmd).then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }

  if (msg.type === C.MSG.PRESTAGE) {
    handlePrestage(msg).then(sendResponse)
      .catch((e) => sendResponse({
        wa: { ok: false, detail: String(e) },
        gmail: { ok: false, detail: String(e) },
      }));
    return true; // async response
  }

  if (msg.type === C.MSG.STT_TRANSCRIBE) {
    handleTranscribe(msg).then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }

  if (msg.type === C.MSG.CAMPAIGN_PROBE) {
    handleCampaignProbe(_sender).then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }

  // C.MSG.STATUS broadcasts go straight from the CRM content script to the
  // side panel; the worker does not need to handle them.
  return false;
});

// ---------------------------------------------------------------------------
// Hotkeys (chrome://extensions/shortcuts) -> CRM engine commands
// ---------------------------------------------------------------------------
const COMMAND_MAP = {
  'mark-voicemail': C.CMD.VOICEMAIL,
  'mark-live': C.CMD.LIVE,
  'prestage': C.CMD.PRESTAGE,
  'skip-lead': C.CMD.SKIP,
  'mark-not-interested': C.CMD.NOT_INTERESTED,
  'resume-session': C.CMD.RESUME,
  'quit-session': C.CMD.QUIT,
};

chrome.commands.onCommand.addListener((command) => {
  const cmd = COMMAND_MAP[command];
  if (cmd) sendToCrm(cmd).catch(() => {});
});
