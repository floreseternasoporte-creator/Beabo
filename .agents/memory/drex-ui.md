---
name: Drex UI conventions
description: Design system constraints confirmed by user across multiple sessions
---

- Brand color: `#2f1a14` (dark brown). Secondary: `#c4a882`. Background: `#f5f4f2`.
- Touch targets: `w-10 h-10` in nav/section headers; `w-11 h-11` in bottom toolbar.
- Headers: frosted glass `bg-[#f5f4f2]/95 backdrop-blur-md`, `border-b border-[#eae4e0]`.
- Pill buttons: `rounded-full`, active state `opacity-75` or `scale-95`.
- NO swipe gestures anywhere.
- Grok/X-style proportions: clean, minimal, white cards on `#f5f4f2` bg, bold font weights (800–900 for titles).
- No FontAwesome icons in redesigned sections — use inline SVG only.
- Live badge: red `#ff3040`, blinking white dot `.dot` with `blinkDot` keyframe animation.
- Filter chips: `border-1.5 border-[#e8e1dc]` inactive, `bg-[#2f1a14] text-white` active.

**Why:** User explicitly confirmed these across profile, search, notifications, and live discovery redesigns.
