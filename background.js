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

// Send a message to a tab, retrying while its content script loads.
async function sendToTab(tabId, msg, { retries = 6, delayMs = 1000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      lastErr = e;
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
    const res = await chrome.tabs.sendMessage(tab.id, { type: C.MSG.CRM_CMD, cmd });
    return res || { ok: true };
  } catch (e) {
    return { ok: false, error: 'CRM page is not responding — reload the CRM tab.' };
  }
}

// ---------------------------------------------------------------------------
// Pre-stage orchestration (never sends; content scripts enforce the same rule)
// ---------------------------------------------------------------------------
const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms)),
  ]);

async function prestageWhatsApp(lead, waText, settings) {
  if (!lead.phone) return { ok: false, detail: 'lead has no phone — WhatsApp skipped' };
  const digits = lead.phone.replace(/\D/g, '');

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
  const res = await withTimeout(
    sendToTab(tab.id, {
      type: C.MSG.WA_FILL,
      phone: digits,
      text: waText,
      leadName: lead.name || '',
    }),
    25000, 'WhatsApp pre-stage');
  return res || { ok: false, detail: 'no response from WhatsApp tab' };
}

async function prestageGmail(lead, settings) {
  if (!lead.email) return { ok: false, detail: 'lead has no email — Gmail skipped' };
  let tab = await findTab(C.GMAIL.TAB_URL_PATTERN);
  if (!tab) {
    tab = await chrome.tabs.create({ url: C.GMAIL.URL, active: false });
    await new Promise((r) => setTimeout(r, 4000)); // let Gmail boot
  }
  const res = await withTimeout(
    sendToTab(tab.id, {
      type: C.MSG.GMAIL_PRESTAGE,
      email: lead.email,
      firstName: lead.firstName,
      subject: settings.GMAIL_DRAFT_SUBJECT,
    }),
    35000, 'Gmail pre-stage');
  return res || { ok: false, detail: 'no response from Gmail tab' };
}

async function handlePrestage(msg) {
  const { lead, waText, channels } = msg;
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
  'resume-session': C.CMD.RESUME,
  'quit-session': C.CMD.QUIT,
};

chrome.commands.onCommand.addListener((command) => {
  const cmd = COMMAND_MAP[command];
  if (cmd) sendToCrm(cmd).catch(() => {});
});
