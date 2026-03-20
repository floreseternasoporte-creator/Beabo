/*
  # Sistema Completo de Posts, Comentarios y Votación

  1. New Tables
    - `community_posts` - Almacena las publicaciones del usuario
      - `id` (uuid, primary key)
      - `user_id` (uuid, ref auth.users)
      - `content` (text) - Contenido de la publicación
      - `image_urls` (json array) - URLs de imágenes (máximo 3)
      - `image_url` (text) - Primera imagen (para compatibilidad)
      - `poll_question` (text) - Pregunta de encuesta (opcional)
      - `poll_options` (json array) - Opciones de encuesta
      - `location` (text) - Ubicación del post
      - `latitude` (float) - Latitud
      - `longitude` (float) - Longitud
      - `upvotes_count` (int) - Contador de upvotes
      - `downvotes_count` (int) - Contador de downvotes
      - `comments_count` (int) - Contador de comentarios
      - `is_hidden` (bool) - Si fue ocultado por moderación
      - `moderation_reason` (text) - Razón del ocultamiento
      - `created_at` (timestamp) - Fecha de creación
      - `updated_at` (timestamp) - Fecha de actualización

    - `post_comments` - Comentarios de primer nivel en posts
      - `id` (uuid, primary key)
      - `post_id` (uuid, ref community_posts)
      - `user_id` (uuid, ref auth.users)
      - `content` (text) - Contenido del comentario
      - `image_urls` (json array) - Imágenes del comentario
      - `upvotes_count` (int) - Contador de upvotes
      - `downvotes_count` (int) - Contador de downvotes
      - `replies_count` (int) - Contador de respuestas
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

    - `comment_replies` - Respuestas anidadas a comentarios
      - `id` (uuid, primary key)
      - `post_id` (uuid, ref community_posts) - Para facilitar búsquedas
      - `parent_comment_id` (uuid, ref post_comments)
      - `user_id` (uuid, ref auth.users)
      - `content` (text)
      - `image_urls` (json array)
      - `upvotes_count` (int)
      - `downvotes_count` (int)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

    - `post_votes` - Registro de votos en posts
      - `id` (uuid, primary key)
      - `post_id` (uuid, ref community_posts)
      - `user_id` (uuid, ref auth.users)
      - `vote_type` (text) - 'upvote' o 'downvote'
      - `created_at` (timestamp)

    - `comment_votes` - Registro de votos en comentarios
      - `id` (uuid, primary key)
      - `comment_id` (uuid) - Puede ser comentario o respuesta
      - `user_id` (uuid, ref auth.users)
      - `vote_type` (text) - 'upvote' o 'downvote'
      - `created_at` (timestamp)

    - `post_reports` - Reportes de contenido inapropiado
      - `id` (uuid, primary key)
      - `post_id` (uuid, ref community_posts)
      - `reported_by_user_id` (uuid, ref auth.users)
      - `reason` (text) - Razón del reporte
      - `description` (text) - Descripción adicional
      - `status` (text) - 'pending', 'reviewed', 'action_taken'
      - `admin_notes` (text) - Notas del administrador
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

    - `hidden_posts_by_user` - Posts ocultos por usuario
      - `id` (uuid, primary key)
      - `user_id` (uuid, ref auth.users)
      - `post_id` (uuid, ref community_posts)
      - `created_at` (timestamp)

  2. Security
    - Enable RLS on all tables
    - Usuarios pueden ver posts de otros
    - Usuarios solo pueden crear/editar/eliminar sus propios posts y comentarios
    - Usuarios no pueden ver posts ocultos (excepto admin)
    - Votos protegidos: un usuario solo puede votar una vez por post/comentario

  3. Indexes
    - user_id en community_posts para consultas rápidas
    - post_id en post_comments y comment_replies
    - created_at para ordenar por fecha
    - post_id, user_id en post_votes para prevenir duplicados
*/

-- Crear tabla de posts
CREATE TABLE IF NOT EXISTS community_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  content text NOT NULL,
  image_urls jsonb DEFAULT '[]'::jsonb,
  image_url text,
  poll_question text,
  poll_options jsonb DEFAULT '[]'::jsonb,
  location text,
  latitude float,
  longitude float,
  upvotes_count int DEFAULT 0,
  downvotes_count int DEFAULT 0,
  comments_count int DEFAULT 0,
  is_hidden boolean DEFAULT false,
  moderation_reason text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Crear tabla de comentarios
CREATE TABLE IF NOT EXISTS post_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  content text NOT NULL,
  image_urls jsonb DEFAULT '[]'::jsonb,
  upvotes_count int DEFAULT 0,
  downvotes_count int DEFAULT 0,
  replies_count int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Crear tabla de respuestas
CREATE TABLE IF NOT EXISTS comment_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  parent_comment_id uuid NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  content text NOT NULL,
  image_urls jsonb DEFAULT '[]'::jsonb,
  upvotes_count int DEFAULT 0,
  downvotes_count int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Crear tabla de votos en posts
CREATE TABLE IF NOT EXISTS post_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  vote_type text NOT NULL CHECK (vote_type IN ('upvote', 'downvote')),
  created_at timestamptz DEFAULT now(),
  UNIQUE(post_id, user_id)
);

-- Crear tabla de votos en comentarios
CREATE TABLE IF NOT EXISTS comment_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  vote_type text NOT NULL CHECK (vote_type IN ('upvote', 'downvote')),
  created_at timestamptz DEFAULT now(),
  UNIQUE(comment_id, user_id)
);

-- Crear tabla de reportes
CREATE TABLE IF NOT EXISTS post_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  reported_by_user_id uuid NOT NULL,
  reason text NOT NULL,
  description text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'action_taken')),
  admin_notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Crear tabla de posts ocultos por usuario
CREATE TABLE IF NOT EXISTS hidden_posts_by_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, post_id)
);

-- Crear índices para optimizar consultas
CREATE INDEX IF NOT EXISTS idx_community_posts_user_id ON community_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_community_posts_created_at ON community_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_location ON community_posts(location);
CREATE INDEX IF NOT EXISTS idx_post_comments_post_id ON post_comments(post_id);
CREATE INDEX IF NOT EXISTS idx_post_comments_user_id ON post_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_post_comments_created_at ON post_comments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_replies_parent_comment_id ON comment_replies(parent_comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_replies_post_id ON comment_replies(post_id);
CREATE INDEX IF NOT EXISTS idx_comment_replies_created_at ON comment_replies(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_votes_post_id_user_id ON post_votes(post_id, user_id);
CREATE INDEX IF NOT EXISTS idx_comment_votes_comment_id_user_id ON comment_votes(comment_id, user_id);
CREATE INDEX IF NOT EXISTS idx_post_reports_post_id ON post_reports(post_id);
CREATE INDEX IF NOT EXISTS idx_post_reports_status ON post_reports(status);
CREATE INDEX IF NOT EXISTS idx_hidden_posts_user_id ON hidden_posts_by_user(user_id);

-- Habilitar RLS
ALTER TABLE community_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE hidden_posts_by_user ENABLE ROW LEVEL SECURITY;

-- Políticas de seguridad para community_posts
CREATE POLICY "Usuarios pueden ver posts no ocultos"
  ON community_posts FOR SELECT
  USING (is_hidden = false);

CREATE POLICY "Usuarios autenticados pueden crear posts"
  ON community_posts FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden actualizar sus propios posts"
  ON community_posts FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden eliminar sus propios posts"
  ON community_posts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Políticas de seguridad para post_comments
CREATE POLICY "Todos pueden ver comentarios"
  ON post_comments FOR SELECT
  USING (true);

CREATE POLICY "Usuarios autenticados pueden crear comentarios"
  ON post_comments FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden actualizar sus propios comentarios"
  ON post_comments FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden eliminar sus propios comentarios"
  ON post_comments FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Políticas de seguridad para comment_replies
CREATE POLICY "Todos pueden ver respuestas"
  ON comment_replies FOR SELECT
  USING (true);

CREATE POLICY "Usuarios autenticados pueden crear respuestas"
  ON comment_replies FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden actualizar sus propias respuestas"
  ON comment_replies FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden eliminar sus propias respuestas"
  ON comment_replies FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Políticas de seguridad para post_votes
CREATE POLICY "Usuarios pueden ver votos"
  ON post_votes FOR SELECT
  USING (true);

CREATE POLICY "Usuarios autenticados pueden votar"
  ON post_votes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden actualizar sus votos"
  ON post_votes FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden eliminar sus votos"
  ON post_votes FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Políticas de seguridad para comment_votes
CREATE POLICY "Usuarios pueden ver votos en comentarios"
  ON comment_votes FOR SELECT
  USING (true);

CREATE POLICY "Usuarios autenticados pueden votar en comentarios"
  ON comment_votes FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden actualizar sus votos en comentarios"
  ON comment_votes FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden eliminar sus votos en comentarios"
  ON comment_votes FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Políticas de seguridad para post_reports
CREATE POLICY "Usuarios autenticados pueden reportar posts"
  ON post_reports FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = reported_by_user_id);

CREATE POLICY "Usuarios pueden ver sus propios reportes"
  ON post_reports FOR SELECT
  TO authenticated
  USING (auth.uid() = reported_by_user_id);

-- Políticas de seguridad para hidden_posts_by_user
CREATE POLICY "Usuarios pueden gestionar sus posts ocultos"
  ON hidden_posts_by_user FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden ocultar posts"
  ON hidden_posts_by_user FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios pueden mostrar posts ocultos"
  ON hidden_posts_by_user FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);