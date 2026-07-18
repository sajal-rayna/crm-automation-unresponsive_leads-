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
3. Click **Load unpacked** → select the **`rayna-autodialer`** folder — the one
   that **directly contains `manifest.json`** (open it in your file manager
   first to check). Two common mistakes, especially on Windows:
   - "Extract All" often nests the files one level deeper
     (`...\rayna-autodialer-v1.7.2\rayna-autodialer\`) — pick the inner folder,
     not the outer one, or you get *"Manifest file is missing or unreadable"*.
   - Don't browse *inside the zip* — Windows shows zips like folders, but
     Chrome can't load from one. Fully extract first (right-click → Extract All).
   - **"The folder name is not valid"** means you selected the ZIP itself:
     Windows hides file extensions, so the zip and the extracted folder show
     the *same name* side by side (the zip has a zipper icon). Foolproof way:
     extract to `C:\rayna`, open `C:\rayna\rayna-autodialer` in Explorer until
     you see `manifest.json`, copy the path from the address bar (Ctrl+C), and
     paste it into the Load-unpacked dialog's "Folder:" field (Ctrl+V).
4. Pin **Rayna Auto-Dialer** from the puzzle-piece menu

## 3. Log into your three tabs

In the same Chrome profile, log into:

- the CRM: `crm.rayna-properties.com`
- WhatsApp Web: `web.whatsapp.com`
- Gmail: `mail.google.com`. No draft needed — Pre-stage opens a fresh compose
  with To/subject/body pre-filled and your uploaded schedule image pasted in.

## 4. Personalize your options (right-click the icon → Options)

| Setting | What to do |
|---|---|
| Ring timeout | Leave the team default; the tool will suggest a tuned value after ~20 answered calls |
| Max leads per session | **5 for your first run**, then 0 (unlimited) |
| WhatsApp mode | `wa_link` (works for cold numbers with no chat history) |
| Email subject | Subject line for the pre-staged email (team default is fine) |
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
