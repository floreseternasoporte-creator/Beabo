# Drex imported project

## Overview

This repository is a no-build static HTML site served by the small Node server in
`server.js`. The main product surface is `index.html`; the standalone futuristic
runtime observatory is available at `/neuro-control.html`.

## Running on Replit

- Workflow: `Start application`
- Command: `node server.js`
- Preview port: `5000`

The observatory polls `GET /api/neuro/telemetry` for live Node runtime values.
Camera access is optional and is requested only after the operator activates it.
When camera or hand-tracking access is unavailable, pointer and touch selection
remain available.