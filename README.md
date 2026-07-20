# Q4 Playbook — Mobius Digital

BFCM / Q4 season planning hub: per-brand client plans, auto-computed season timeline, checklist, BFCM Command Center, and calculators. Frontend is one HTML file on GitHub Pages; data lives in a Google Sheet behind a Google Apps Script API (the same architecture as the Lucky Cup tracker).

## Deploy — about 10 minutes total

### 1. Backend (Google Apps Script + Sheet) — ~5 min

1. Go to **script.google.com** → **New project**.
2. Delete the placeholder code, paste in everything from `apps-script/Code.gs`, save (name it "Q4 Playbook API").
3. In the function dropdown pick **setup**, press **Run** ▶, approve the permissions (it only touches its own spreadsheet).
4. Open **View → Logs** (Executions). It prints:
   - the **Sheet URL** (your database — "Q4 Playbook DB" is now in your Drive)
   - your **TEAM PASSCODE** (change it any time under Project Settings → Script properties → `ADMIN_PASS`)
5. **Deploy → New deployment** → gear icon → **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the **Web app URL** (ends in `/exec`).

### 2. Frontend

1. Open `index.html`, find near the top of the `<script>`:
   ```js
   const API_URL='';
   ```
   Paste your Web app URL between the quotes. Commit.

### 3. GitHub Pages — ~3 min

1. Create a repo (e.g. `q4-playbook`) on github.com — private is fine, Pages still works on paid plans; use public if on free.
2. Upload `index.html` (drag-and-drop in the GitHub web UI is fine, or `git push`).
3. Repo **Settings → Pages** → Source: *Deploy from a branch* → `main` / root → Save.
4. Your app is live at `https://<username>.github.io/q4-playbook/`.
   - Optional: to serve it under `tools.go-mobius-digital.com`, add the file to whatever repo/host already serves that domain instead — nothing about the app cares where it's hosted.

### 4. First run

1. Open the site → enter the **team passcode** from step 1.4.
2. The brand list starts empty on the backend — open **✎ Manage brands…** in the brand dropdown and add your brands. Each one gets a random client-link token generated server-side.
3. Set each brand's Command Center cheat sheet (AOV, breakeven, targets, budgets).
4. **Copy client link** on any brand → that URL is safe to email: it loads locked to that brand, client view only, no passcode needed.

## How syncing works

- Autosaves every ~2.5 s whenever something changed (the pill in the header shows `saving… / synced / offline`).
- Team edits save the full brand plan. Client links can only write **questionnaire answers** and **checklist comments** — statuses, owners, dates, KPIs, and logs are team-only, enforced server-side, not just hidden in the UI.
- Removing a brand is a **soft delete**: the row is archived in the Sheet, never erased. Re-adding the same name restores its full history and the same client link.
- Multiple team members can work at once; each brand saves as its own row. Avoid two people editing the *same brand* simultaneously (last save wins). Refresh to pull others' latest changes.

## Files

| Path | What it is |
|---|---|
| `index.html` | The entire app (UI + logic + embedded logo) |
| `apps-script/Code.gs` | The backend API — paste into script.google.com |

## Local demo mode

With `API_URL` left empty, the app runs fully in-browser with seeded demo data (no passcode, no persistence). Handy for testing UI changes before deploying.
