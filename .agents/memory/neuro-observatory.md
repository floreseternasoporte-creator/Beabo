---
name: Neuro observatory telemetry
description: Durable guidance for the standalone futuristic observatory and its telemetry boundary.
---

The observatory should distinguish server runtime telemetry from browser-local demo animation, require an authenticated Drex session before Firebase listeners, and keep camera/hand tracking opt-in with pointer/touch fallback.

**Why:** The imported project is a no-build static site, while the requested futuristic surface is an independent operator view; transparent data provenance and auth gating prevent animated visuals or guest reads from being mistaken for platform-wide production metrics.

**How to apply:** Preserve the relative telemetry endpoint contract and clearly identify any future Firebase or external-service readings by source. Mount Firebase listeners only after auth resolves to a user, and keep camera permissions gated behind an explicit user action.