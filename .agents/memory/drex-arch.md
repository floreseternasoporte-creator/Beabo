---
name: Drex app architecture
description: Stack, key files, and where things live in the 27k-line index.html
---

- Single `index.html` (~27 200 lines). All HTML, CSS (inside `<style>`), and JS (inline `<script>`) in one file.
- Node.js `server.js` serves on port 5000 (static file server + any API routes).
- Firebase auth/realtime DB/storage, Tailwind CDN, Cloudinary for images, Stripe for payments, hCaptcha.
- Key JS sections by approx line: live discovery ~26 900; onboarding ~27 168; moderation ~27 240+.
- Key HTML sections: splash/auth ~1–2400; registration steps ~2400–2670; onboarding overlay ~2670–2770; main-app ~2780+; live-discovery-view ~4893.
- `read` tool shows max 20 974 lines — use `sed -n 'START,ENDp'` via bash for lines > 20 974.

**Why:** File is too large for standard read offsets; bash sed is required for JS edits past line ~20 974.
**How to apply:** Always use bash `sed -n` to read/verify JS sections above line 20 974 before editing.
