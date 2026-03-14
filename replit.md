# Drex

A Reddit-like social platform implemented as a single static `index.html` file.

## Architecture

- **Single file**: Everything lives in `index.html` (~10,280 lines)
- **Firebase**: Auth, Realtime Database, Storage (CDN-loaded)
- **Tailwind CSS**: CDN-loaded
- **Font Awesome**: CDN-loaded (v6.4.0)
- **Chart.js**: CDN-loaded (used in analytics)
- **No build system**: Pure HTML/CSS/JavaScript, no bundler

## Workflow

- **Start application**: `npx --yes serve . -l 5000 --cors` (port 5000, webview)

## Features (Active)

- **Authentication**: Email/username/phone login via Firebase Auth
- **Community Posts (Notes)**: Create, like, comment on community posts
- **Chat (Messaging)**: Real-time DMs with typing indicators, voice messages, file attachments, stickers
- **Live Streaming**: Broadcast via webcam or pre-recorded video, viewer mode with gifts/comments
- **User Profiles**: Follow/unfollow, profile image, bio, frames, effects
- **Search**: Search users by username
- **Notifications**: Real-time push notifications in-app
- **Coins System**: Earn/spend coins; buy effects and profile frames
- **Effects & Frames**: Profile frame cosmetics, post effects
- **Creator Hub / Beaboo Studio**: Posts management and account analytics

## Features Removed

All story/fiction features have been fully removed:
- Story creation, editing, publishing
- Chapter creation and reading
- Story carousels and home feed sections (New Releases, Top 10, Popular, Terror, Suggested, Featured Authors)
- Story detail modal and chapter read modal
- Story statistics in user profiles (Historias publicadas, Total de lecturas)
- Story analytics in Beaboo Studio
- Story-specific search (books carousel)
- Author stories grid in profile and author modals
- All story-related Firebase queries (`loadStories`, `loadUserStories`, etc.)

## Firebase Structure (Relevant Nodes)

- `users/` — user profiles
- `posts/` or `notes/` — community posts
- `conversations/` — chat conversations
- `messages/` — chat messages
- `notifications/` — user notifications
- `followers/`, `following/` — social graph
- `liveStreams/` — live streaming data
- `coins/`, `effects/`, `frames/` — virtual economy
