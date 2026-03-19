-- SQLite schema oficial para comentarios y respuestas de la comunidad
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  profile_image TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- post_id referencia el id de la nota/publicación de communityNotes
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  parent_comment_id TEXT,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_image TEXT,
  content TEXT,
  gif_url TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  FOREIGN KEY (parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comment_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  vote_type TEXT NOT NULL CHECK (vote_type IN ('up')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (comment_id, user_id, vote_type),
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comments_post_root_created
  ON comments(post_id, parent_comment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_parent_created
  ON comments(parent_comment_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_comment_votes_comment
  ON comment_votes(comment_id);
