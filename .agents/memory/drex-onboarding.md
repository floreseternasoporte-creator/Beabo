---
name: Drex onboarding flow
description: 3-step post-registration onboarding overlay — how it works and what to keep consistent
---

- Triggered by `startOnboarding()` called from `onclick` on `#regGoToHome` button in `#reg-success-step`.
- The old `addEventListener('click', ...)` on `#regGoToHome` was removed — only the `onclick` attribute remains.
- Auth form container ID is `#auth-form` (not `authFormContainer` or similar).
- Overlay ID: `#onboarding-overlay`. Steps: `#onb-step-1`, `#onb-step-2`, `#onb-step-3`.
- localStorage key: `drex_onboarding_done` — if set, `startOnboarding()` skips to `_finishOnboardingAndLaunchApp()` immediately.
- Interests saved to Firebase: `users/{uid}/interests` (array of emoji+label strings).
- Bio saved to Firebase: `users/{uid}/bio`.
- Step 2 bio textarea has `oninput` wired dynamically in `onbGoStep(2)` to update `#onb-bio-count`.

**Why:** The original regGoToHome listener directly showed main-app; now onboarding intercepts it. Keeping both would cause double-fire.
**How to apply:** If adding more registration completion logic, hook into `_finishOnboardingAndLaunchApp()`, not the button listener.
