// config.js — SINGLE source of truth for every selector, label, template and
// default the Rayna Auto-Dialer uses. If the CRM / WhatsApp / Gmail UI changes,
// edit HERE — nothing else should need to change.
//
// Loaded (in order, before anything else) into:
//   - the CRM / WhatsApp / Gmail content scripts (manifest "js" arrays)
//   - the background service worker (importScripts)
//   - sidepanel.html and options.html (<script> tag)

globalThis.RAYNA = (() => {
  // ---------------------------------------------------------------------------
  // Tunable settings (overridable from the options page, stored in chrome.storage)
  // ---------------------------------------------------------------------------
  const DEFAULT_SETTINGS = {
    RING_TIMEOUT_MS: 28000,        // max wait in Ringing/Calling before auto-hangup as No Answer
    POLL_MS: 500,                  // softphone-state poll interval
    MAX_LEADS: 0,                  // session cap, 0 = unlimited
    PREFILL_WHATSAPP_ON_MISS: false, // pre-fill "If Not Answered" WhatsApp on voicemail/no-answer
    WHATSAPP_MODE: 'existing_tab', // 'existing_tab' | 'wa_link'
    GMAIL_DRAFT_SUBJECT:
      "RSVP Confirmed: First time ever meet the TOP Developers of Dubai Virtually",

    // --- Call listening (beta, opt-in). Listens to YOUR microphone side of a
    // connected call, matches CALL_CUES against what you say, and shows outcome
    // SUGGESTIONS with timestamps. It never hears the lead's audio and never
    // acts on its own. ---
    LISTEN_ENABLED: false,
    LISTEN_MODE: 'webspeech',      // 'webspeech' (built-in, may use the browser
                                   // vendor's servers) | 'local_server' (POST
                                   // audio chunks to a local Whisper endpoint —
                                   // Voicebox / OmniVoice Studio / whisper.cpp)
    LISTEN_STT_URL: 'http://127.0.0.1:8788/v1/audio/transcriptions',
    LISTEN_LANG: 'en-US',
  };

  // ---------------------------------------------------------------------------
  // CRM outcome Reasons — must match the dropdown options EXACTLY (trimmed).
  // ---------------------------------------------------------------------------
  const REASONS = {
    NO_ANSWER: 'No Answer',
    BUSY: 'Busy',
    VOICEMAIL: 'Left Voicemail',
    DROPPED: 'Call Dropped',
    TECH_FAILURE: 'Technical Failure',
    WRONG_NUMBER: 'Wrong Number',
    INVALID: 'Invalid / Not in Service',
  };

  // Failure-toast text -> Reason. First match wins; order the specific ones first.
  const TOAST_REASON_MAP = [
    { re: /not in service|invalid number/i, reason: REASONS.INVALID },
    { re: /\bbusy\b/i, reason: REASONS.BUSY },
    { re: /disconnect|dropped/i, reason: REASONS.DROPPED },
    { re: /could not connect|call failed|technical/i, reason: REASONS.TECH_FAILURE },
  ];

  // ---------------------------------------------------------------------------
  // CRM selectors / matchers
  // ---------------------------------------------------------------------------
  const CRM = {
    HOST: 'crm.rayna-properties.com',
    LEAD_PATH: '/lead/',
    TAB_URL_PATTERN: '*://crm.rayna-properties.com/*',

    // One button cycles Call Now -> On Call... -> End Call for STATE READING.
    // On the live CRM the top toggle only ever shows "Call Now" / "On Call..."
    // (a status indicator) — the actual hang-up control is a SEPARATE "End
    // Call" button inside an "Active Call" panel that appears once connected.
    // So this regex is used to read state, but NEVER to click a hang-up — see
    // END_CALL_TEXT below.
    CALL_BUTTON_TEXT: /^(Call Now|On Call|End Call)/i,
    CALL_NOW_TEXT: /^Call Now/i,
    IN_CALL_TEXT: /^(On Call|End Call)/i,
    // The real hang-up control (exact text). Tried BEFORE the ambiguous top
    // toggle so a status-only "On Call..." can never be clicked as if it hangs up.
    END_CALL_TEXT: /^End Call$/i,

    // Softphone state tokens (exact element text, trimmed)
    STATE_TOKEN_RE: /^(Calling|Ringing\.{0,3}|Connected)$/i,
    STATE_CONNECTED_RE: /^Connected$/i,
    TIMER_RE: /^\d{1,2}:\d{2}$/, // MM:SS call timer

    // State/timer are read ONLY inside the softphone panel — never the whole
    // page (the outcome toggle has its own "Connected" label, and timestamps
    // elsewhere would read as call timers). The panel is located by climbing
    // ancestors of the call button; the climb stops before any container that
    // includes the Log Call Outcome panel (OUTCOME_PANEL_MARKER). If your CRM
    // needs it, pin the panel explicitly with a CSS selector here instead:
    SOFTPHONE_CONTAINER: null,      // e.g. '.softphone-panel' (null = auto-climb)
    SOFTPHONE_MAX_CLIMB: 6,         // max ancestors above the call button
    OUTCOME_PANEL_MARKER: /Did you connect/i,

    // Queue position, e.g. "33 of 156"
    COUNTER_RE: /(\d+)\s+of\s+(\d+)/,

    // CampaignTag out of the Raw Source Data JSON text
    CAMPAIGN_TAG_RE: /CampaignTag"?\s*[:=]\s*"([^"]+)"/,
    // The Raw Source Data card is collapsed by default — the engine clicks its
    // "Show" toggle once per lead (at dial time) so the CampaignTag is readable.
    RAW_SOURCE_RE: /Raw Source Data/i,
    RAW_SOURCE_TOGGLE_RE: /^(Show|View|Expand)$/i,

    // Lead Information card field labels (exact element text, trimmed; the
    // live CRM renders some with a trailing colon and/or uppercase)
    LEAD_FIELD_LABELS: {
      name: /^(Full\s+)?Name:?$/i,
      phone: /^Phone(\s+Number)?:?$/i,
      email: /^Email(\s+Address)?:?$/i,
    },
    // Page-chrome headings that must never be mistaken for the lead's name
    // when falling back to the first h1/h2 (the sidebar logo is an h1).
    NAME_HEADING_SKIP_RE:
      /^(Rayna CRM|Caller Portal|Lead Detail|Lead Information|Activity|Raw Source|Lead Journey|Dashboard|My Queue|Callbacks|Assignments|Settings)/i,
    // Fallback free-text matchers if the labeled lookup fails
    EMAIL_RE: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    PHONE_RE: /\+?\d[\d\s().-]{7,}\d/,
    // A fallback match only counts as a phone if it has enough digits and
    // doesn't look like a date (activity feeds are full of both).
    PHONE_MIN_DIGITS: 9,
    DATE_LIKE_RE: /\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/,
    // Numbers to never mistake for the lead's phone (our own Twilio caller
    // line) — compared on the trailing 10 digits so formatting can't leak it.
    IGNORE_PHONES: ['+19162222975'],

    // Log Call Outcome panel
    NOT_CONNECTED_TEXT: /^Not Connected$/i,   // the toggle option we ensure is set
    REASON_TRIGGER_TEXT: /Select reason/i,    // the dropdown trigger placeholder
    SAVE_OUTCOME_TEXT: /^Save Outcome$/i,
    NEXT_BUTTON_TEXT: /^Next\b/i,

    // Failure / confirmation toasts
    TOAST_SELECTOR:
      '[role="alert"], [role="status"], [class*="toast" i], [class*="Toastify"],' +
      ' [class*="snackbar" i], [class*="notification" i]',
    SAVE_CONFIRM_RE: /saved|success|updated|logged/i,
    SAVE_CONFIRM_TIMEOUT_MS: 8000,
    // Spec: "Save Outcome -> wait for confirm". With true (default) the engine
    // PAUSES if no fresh confirmation toast appears, so a failing save can
    // never silently skip leads. Set false only if your CRM saves without any
    // toast at all (the engine then warns and continues).
    REQUIRE_SAVE_CONFIRM: true,

    // If a ringing call ends with no toast (e.g. declined), log this Reason:
    RING_ENDED_EARLY_REASON: 'No Answer',

    // How long we allow the softphone to leave idle after clicking Call Now
    DIAL_START_TIMEOUT_MS: 6000,
    // How long we wait for the page to show a different lead after clicking Next
    ADVANCE_TIMEOUT_MS: 15000,
  };

  // ---------------------------------------------------------------------------
  // WhatsApp Web selectors (pre-stage only — we NEVER send)
  // Candidate lists: first visible match wins.
  // ---------------------------------------------------------------------------
  const WA = {
    HOST: 'web.whatsapp.com',
    TAB_URL_PATTERN: '*://web.whatsapp.com/*',
    SEND_LINK: (digits, text) =>
      `https://web.whatsapp.com/send?phone=${digits}&text=${encodeURIComponent(text)}`,
    SEARCH_BOX: [
      'div[contenteditable="true"][data-tab="3"]',
      '[aria-label="Search input textbox"]',
      'div[role="textbox"][data-tab="3"]',
      '#side div[contenteditable="true"]',
    ],
    RESULT_ROW: [
      '#pane-side [role="listitem"]',
      '[aria-label*="Search results" i] [role="listitem"]',
      '#pane-side [role="row"]',
    ],
    COMPOSER: [
      'footer div[contenteditable="true"][data-tab="10"]',
      'footer div[contenteditable="true"]',
      'div[contenteditable="true"][aria-placeholder="Type a message"]',
      '[data-testid="conversation-compose-box-input"]',
    ],
    // A search-result row is only clicked if its text matches the lead: either
    // this many trailing phone digits appear in the row, or the lead's name does.
    ROW_MATCH_MIN_DIGITS: 7,
    // Refuse to stage at all for a phone with fewer digits than this (a short
    // fragment would false-match timestamps in chat previews).
    MIN_PHONE_DIGITS: 9,
    STEP_TIMEOUT_MS: 10000,
  };

  // ---------------------------------------------------------------------------
  // Gmail selectors (pre-stage only — we NEVER send).
  // *** BRITTLE #2: the Gmail draft open + field edit. Gmail's DOM is obfuscated
  // and changes; every selector here is a candidate list, and on ANY failure the
  // content script falls back to just opening the Drafts view. ***
  // ---------------------------------------------------------------------------
  const GMAIL = {
    HOST: 'mail.google.com',
    TAB_URL_PATTERN: '*://mail.google.com/*',
    URL: 'https://mail.google.com/mail/u/0/',
    DRAFTS_HASH: '#drafts',
    searchHash: (subject) =>
      '#search/' + encodeURIComponent(`in:draft subject:"${subject}"`),
    RESULT_ROW: ['tr.zA', 'table[role="grid"] tr[role="row"]'],
    COMPOSE_DIALOG: ['div[role="dialog"]'],
    SUBJECT_FIELD: ['input[name="subjectbox"]', 'input[aria-label*="Subject" i]'],
    // Recipient chips already committed in a compose's To line
    RECIPIENT_CHIP: ['[email]', '[data-hovercard-id]'],
    TO_FIELD: [
      'div[role="dialog"] input[aria-label*="To" i]',
      'div[role="dialog"] input[peoplekit-id]',
      'div[role="dialog"] textarea[name="to"]',
      'div[role="dialog"] div[name="to"] input',
      'input[aria-label*="To recipients" i]',
    ],
    BODY_FIELD: [
      'div[role="dialog"] div[aria-label*="Message Body" i][contenteditable="true"]',
      'div[role="dialog"] div[g_editable="true"][contenteditable="true"]',
      'div[aria-label*="Message Body" i][contenteditable="true"]',
    ],
    // Tokens in the draft body we replace with the lead's first name
    NAME_TOKEN_RE: /\[(First\s*Name|FirstName|Client\s*Name)\]/gi,
    STEP_TIMEOUT_MS: 15000,
  };

  // ---------------------------------------------------------------------------
  // HARD SAFETY RULE — enforced by guardedClick() in the WhatsApp/Gmail scripts:
  // no element whose text/aria-label matches this is EVER clicked by the tool.
  // ---------------------------------------------------------------------------
  const FORBIDDEN_CLICK_RE = /\bsend\b|\bsubmit\b|schedule send|create event|save & close/i;

  // ---------------------------------------------------------------------------
  // Message templates (Section 5B of the handoff doc)
  // ---------------------------------------------------------------------------
  const TEMPLATES = {
    IF_INTERESTED:
      "Hi [Client Name], Thank you for taking the time to speak with me just now! " +
      "It was great connecting with you. As discussed, I have reserved your spot for " +
      "our first ever exclusive Multideveloper Virtual Webinar on Dubai Real Estate " +
      "on Saturday, July 25th. As mentioned this session is tailored specifically for " +
      "our US & Canadian investors. Top Dubai developers will be unveiling exclusive " +
      "offers, tax-free incentives, and high-yield investment options. We are sharing " +
      "a formal invitation for the upcoming event and we will block your calendar shortly.",
    IF_NOT_ANSWERED:
      "Hope you're having a great day! I just tried reaching you to share details about " +
      "our upcoming first time ever exclusive Multideveloper Virtual Webinar on Dubai " +
      "Real Estate on Saturday, July 25th. Top Dubai developers will be unveiling " +
      "exclusive offers, tax-free incentives, and high-yield investment options. Since " +
      "I missed you, when would be a better time to connect for a quick 2-minute chat " +
      "— today or tomorrow?",
    CALL_SCRIPT:
      "Hi! Am I speaking with (Client's Name)? Hi (Client's Name), this is (Your Name) " +
      "calling from Rayna Properties. How are you doing today? You had shown interest in " +
      "Dubai real estate opportunities in the past for our roadshow at (As per CRM " +
      "details), so we wanted to personally invite you for an exclusive upcoming " +
      "Multi-Developer Virtual Roadshow on Dubai Real Estate that we are hosting on " +
      "25th July. This webinar is one of its own kind and Rayna properties is bringing " +
      "this exclusively for our existing investors only for the first time ever! This is " +
      "going to be a live online event starting 11am Central time Zone where Dubai's " +
      "leading developers like Emaar, Nakheel, Sobha, Binghatti, Damac, Danube and " +
      "Mantra will be presenting their latest projects, investment opportunities, " +
      "exclusive offers specially curated for our international investors. The best part " +
      "is — it's a completely complimentary invite-only session and one-on-one " +
      "consultation will be scheduled after the webinar. In case you would want to have " +
      "this one on one consultation scheduled right now to avail current ongoing offers " +
      "and not wait for the webinar next month we could have the same scheduled for you. " +
      "(Small Pause) So, (Client's Name), I just wanted to check if I can confirm your " +
      "participation for the webinar on 25th July? If Yes, Any preferred developer.\n\n" +
      "Developer time slots (US Central): Mantra 11:00 AM, Emaar 11:45 AM, Nakheel " +
      "12:45 PM, Damac 1:30 PM, Binghatti 2:15 PM, Sobha 3:00 PM, Danube 3:45 PM.\n\n" +
      "Close: Perfect! I'll have your registration confirmed and share a calendar invite " +
      "with you shortly. Right after this call I'll also be sending you the invite with " +
      "brief details and we will send you reminders before the webinar along with the " +
      "Webinar link. We're looking forward to having you join us on 25th July for this " +
      "exclusive Multideveloper Virtual Webinar on Dubai Real estate. Thank you once " +
      "again, and have a great day!",
  };

  // Fill [Client Name]/[FirstName]-style tokens in a template.
  function fillTemplate(template, firstName) {
    return template.replace(/\[(Client\s*Name|First\s*Name|FirstName)\]/gi, firstName || 'there');
  }

  // ---------------------------------------------------------------------------
  // Call-listening cues — matched against what YOU say on a connected call.
  // Deliberately distinctive phrases only: generic politeness ("have a great
  // day") appears in BOTH the decline wrap-up and the RSVP close script, so it
  // must not be a cue. Edit/extend freely; tags feed the learning stats.
  // ---------------------------------------------------------------------------
  const CALL_CUES = [
    {
      tag: 'interested_rsvp',
      label: 'Qualified — RSVP / next steps',
      re: /confirm (your )?(participation|registration|spot)|calendar invite|preferred developer|(11|eleven)\s*a\.?m\.? central|webinar link|send(ing)? you the invite|see you on the (webinar|25th)/i,
    },
    {
      tag: 'not_interested',
      label: 'Not interested / not qualified',
      re: /not interested|no longer interested|remove (me|my|your) number|don'?t call|do not call|not looking (to|for)|already (bought|invested|purchased)|won'?t be able to (join|attend|make)|can'?t make it|not the right fit/i,
    },
    {
      tag: 'voicemail_left',
      label: 'Leaving a voicemail',
      re: /leav(e|ing) (you )?a (quick |voice|short )?message|after the (beep|tone)|i'?ll try (you )?again|call(ing)? you back later/i,
    },
    {
      tag: 'callback',
      label: 'Callback requested',
      re: /better time to (talk|call|connect)|call (you )?back (later |tomorrow |today )?(at|around|when)?|when (would|is) a (good|better) time/i,
    },
  ];

  // ---------------------------------------------------------------------------
  // Message types used between panel <-> background <-> content scripts
  // ---------------------------------------------------------------------------
  const MSG = {
    PANEL_CMD: 'RAYNA_PANEL_CMD',       // panel -> background (relay a cmd to the CRM tab)
    CRM_CMD: 'RAYNA_CRM_CMD',           // background -> CRM content script
    STATUS: 'RAYNA_STATUS',             // CRM content script -> panel (broadcast)
    PRESTAGE: 'RAYNA_PRESTAGE',         // CRM content script -> background (orchestrate)
    WA_FILL: 'RAYNA_WA_FILL',           // background -> WhatsApp content script
    GMAIL_PRESTAGE: 'RAYNA_GMAIL_PRESTAGE', // background -> Gmail content script
    STT_TRANSCRIBE: 'RAYNA_STT_TRANSCRIBE', // CRM -> background (local Whisper POST)
  };

  // Panel/hotkey commands understood by the CRM engine
  const CMD = {
    START: 'start',
    STOP: 'stop',
    QUIT: 'quit',
    RESUME: 'resume',
    GET_STATUS: 'get-status',
    VOICEMAIL: 'action:voicemail',
    LIVE: 'action:live',
    PRESTAGE: 'action:prestage',
    SKIP: 'action:skip',
  };

  // Merge stored overrides over defaults.
  async function getSettings() {
    try {
      const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
      return { ...DEFAULT_SETTINGS, ...stored };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  return {
    DEFAULT_SETTINGS,
    REASONS,
    TOAST_REASON_MAP,
    CRM,
    WA,
    GMAIL,
    CALL_CUES,
    FORBIDDEN_CLICK_RE,
    TEMPLATES,
    fillTemplate,
    MSG,
    CMD,
    getSettings,
  };
})();
