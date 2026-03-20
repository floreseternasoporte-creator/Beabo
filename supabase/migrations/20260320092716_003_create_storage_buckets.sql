/*
  # Crear buckets de Storage para Supabase

  Storage para guardar imágenes de posts, comentarios y avatares de usuario.
  Las imágenes se organizan por userid/timestamp para evitar colisiones de nombres.
*/

-- Este script se ejecutaría normalmente a través de la UI de Supabase
-- Las políticas de seguridad se configurarían en Storage settings

-- Los buckets se crearían con:
-- 1. posts-images: Para imágenes de posts y comentarios
-- 2. user-avatars: Para imágenes de perfil de usuario
-- 3. Ambos buckets serían públicos (authenticated users can upload their own files)

-- Nota: Los buckets deben crearse manualmente en el dashboard de Supabase
-- o a través de la API REST de Supabase.