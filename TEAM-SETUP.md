# Rayna Auto-Dialer — Team Member Setup (5 minutes)

The dialer runs inside YOUR Chrome, on YOUR already-logged-in accounts. It never
logs in anywhere, never presses Send, and stores everything (settings, learned
fixes, stats) only in your own browser.

## 1. Get the extension folder

Either unzip the `rayna-autodialer-vX.Y.Z.zip` you were sent, or clone the repo
and check out the release branch. Keep the folder somewhere permanent — Chrome
loads it from disk (don't delete it later).

## 2. Load it into Chrome

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** → select the extension folder
4. Pin **Rayna Auto-Dialer** from the puzzle-piece menu

## 3. Log into your three tabs

In the same Chrome profile, log into:

- the CRM: `crm.rayna-properties.com`
- WhatsApp Web: `web.whatsapp.com`
- Gmail: `mail.google.com` — **and make sure the RSVP draft exists in YOUR
  Drafts** with the exact subject configured in options (ask the team lead to
  share the draft template; copy it into your own Gmail as a draft).

## 4. Personalize your options (right-click the icon → Options)

| Setting | What to do |
|---|---|
| Ring timeout | Leave the team default; the tool will suggest a tuned value after ~20 answered calls |
| Max leads per session | **5 for your first run**, then 0 (unlimited) |
| WhatsApp mode | `wa_link` (works for cold numbers with no chat history) |
| Gmail draft subject | Must match the RSVP draft in YOUR Gmail exactly |
| **Scripts & templates** | **Put YOUR name in the WhatsApp "If Interested" intro** ("This is <your name>, from Rayna Properties…"). Adjust the call script if you have your own flow. `[Client Name]` is auto-replaced with the lead's first name. |

Hotkeys (Voicemail / Live / Pre-stage / Skip / Not interested / Resume / Quit)
are set at `chrome://extensions/shortcuts`.

## 5. First run

1. Open **My Queue** in the CRM and click into a lead
2. Click the extension icon → side panel opens → check it shows the lead
3. Put an earphone in, press **Start**

What happens by itself: dialing, ring-timeout → "No Answer" logged → next lead,
failure toasts (busy/invalid/disconnected) logged and advanced.

What needs you: when a call **connects**, listen ~2 seconds and press one:

- **Voicemail** → logs No Answer, moves on
- **Live** → freezes; the conversation is yours. During the freeze you can still
  press **Pre-stage** (stages WhatsApp + Gmail drafts) or **Not interested**
  (logs Connected + Not Interested and continues dialing)
- **Pre-stage** → stages both drafts, freezes for you to finish
- **Not interested** → logs it, saves, moves on
- **Skip** → moves on, logs nothing

If a red **"Selector failed"** box appears: do the failed action manually on the
CRM page (your click teaches the tool the fix), make sure the outcome saved,
click Next if the lead is done, then press **Resume**.

**Stop** finishes the current lead first; press it twice to abort the current
call immediately. The tool never presses Send anywhere — WhatsApp/Gmail sends
are always your click.
