/*
  # Triggers para Mantener Contadores Actualizados

  Crea triggers que actualizan automáticamente los contadores de upvotes,
  downvotes y comentarios cuando se agregan o eliminan votos/comentarios.
*/

-- Trigger para actualizar contadores de votos en posts
CREATE OR REPLACE FUNCTION update_post_vote_counts()
RETURNS TRIGGER AS $$
BEGIN
  -- Actualizar upvotes_count cuando se inserta un upvote
  IF NEW.vote_type = 'upvote' THEN
    UPDATE community_posts 
    SET upvotes_count = upvotes_count + 1
    WHERE id = NEW.post_id;
  -- Actualizar downvotes_count cuando se inserta un downvote
  ELSIF NEW.vote_type = 'downvote' THEN
    UPDATE community_posts 
    SET downvotes_count = downvotes_count + 1
    WHERE id = NEW.post_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para restar votos cuando se eliminan
CREATE OR REPLACE FUNCTION update_post_vote_counts_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.vote_type = 'upvote' THEN
    UPDATE community_posts 
    SET upvotes_count = GREATEST(0, upvotes_count - 1)
    WHERE id = OLD.post_id;
  ELSIF OLD.vote_type = 'downvote' THEN
    UPDATE community_posts 
    SET downvotes_count = GREATEST(0, downvotes_count - 1)
    WHERE id = OLD.post_id;
  END IF;
  
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Trigger para actualizar votos en comentarios
CREATE OR REPLACE FUNCTION update_comment_vote_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.vote_type = 'upvote' THEN
    -- Intentar actualizar comentario
    UPDATE post_comments 
    SET upvotes_count = upvotes_count + 1
    WHERE id = NEW.comment_id;
    
    -- Si no se actualizó un comentario, intenta actualizar una respuesta
    IF NOT FOUND THEN
      UPDATE comment_replies
      SET upvotes_count = upvotes_count + 1
      WHERE id = NEW.comment_id;
    END IF;
  ELSIF NEW.vote_type = 'downvote' THEN
    UPDATE post_comments 
    SET downvotes_count = downvotes_count + 1
    WHERE id = NEW.comment_id;
    
    IF NOT FOUND THEN
      UPDATE comment_replies
      SET downvotes_count = downvotes_count + 1
      WHERE id = NEW.comment_id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para restar votos en comentarios
CREATE OR REPLACE FUNCTION update_comment_vote_counts_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.vote_type = 'upvote' THEN
    UPDATE post_comments 
    SET upvotes_count = GREATEST(0, upvotes_count - 1)
    WHERE id = OLD.comment_id;
    
    IF NOT FOUND THEN
      UPDATE comment_replies
      SET upvotes_count = GREATEST(0, upvotes_count - 1)
      WHERE id = OLD.comment_id;
    END IF;
  ELSIF OLD.vote_type = 'downvote' THEN
    UPDATE post_comments 
    SET downvotes_count = GREATEST(0, downvotes_count - 1)
    WHERE id = OLD.comment_id;
    
    IF NOT FOUND THEN
      UPDATE comment_replies
      SET downvotes_count = GREATEST(0, downvotes_count - 1)
      WHERE id = OLD.comment_id;
    END IF;
  END IF;
  
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Trigger para actualizar contador de comentarios en posts
CREATE OR REPLACE FUNCTION update_post_comments_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE community_posts 
  SET comments_count = comments_count + 1
  WHERE id = NEW.post_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para restar contador de comentarios
CREATE OR REPLACE FUNCTION update_post_comments_count_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE community_posts 
  SET comments_count = GREATEST(0, comments_count - 1)
  WHERE id = OLD.post_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Trigger para actualizar contador de respuestas en comentarios
CREATE OR REPLACE FUNCTION update_comment_replies_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE post_comments 
  SET replies_count = replies_count + 1
  WHERE id = NEW.parent_comment_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para restar contador de respuestas
CREATE OR REPLACE FUNCTION update_comment_replies_count_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE post_comments 
  SET replies_count = GREATEST(0, replies_count - 1)
  WHERE id = OLD.parent_comment_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Crear triggers
DROP TRIGGER IF EXISTS trg_post_vote_insert ON post_votes;
CREATE TRIGGER trg_post_vote_insert
AFTER INSERT ON post_votes
FOR EACH ROW
EXECUTE FUNCTION update_post_vote_counts();

DROP TRIGGER IF EXISTS trg_post_vote_delete ON post_votes;
CREATE TRIGGER trg_post_vote_delete
AFTER DELETE ON post_votes
FOR EACH ROW
EXECUTE FUNCTION update_post_vote_counts_delete();

DROP TRIGGER IF EXISTS trg_comment_vote_insert ON comment_votes;
CREATE TRIGGER trg_comment_vote_insert
AFTER INSERT ON comment_votes
FOR EACH ROW
EXECUTE FUNCTION update_comment_vote_counts();

DROP TRIGGER IF EXISTS trg_comment_vote_delete ON comment_votes;
CREATE TRIGGER trg_comment_vote_delete
AFTER DELETE ON comment_votes
FOR EACH ROW
EXECUTE FUNCTION update_comment_vote_counts_delete();

DROP TRIGGER IF EXISTS trg_post_comment_insert ON post_comments;
CREATE TRIGGER trg_post_comment_insert
AFTER INSERT ON post_comments
FOR EACH ROW
EXECUTE FUNCTION update_post_comments_count();

DROP TRIGGER IF EXISTS trg_post_comment_delete ON post_comments;
CREATE TRIGGER trg_post_comment_delete
AFTER DELETE ON post_comments
FOR EACH ROW
EXECUTE FUNCTION update_post_comments_count_delete();

DROP TRIGGER IF EXISTS trg_comment_reply_insert ON comment_replies;
CREATE TRIGGER trg_comment_reply_insert
AFTER INSERT ON comment_replies
FOR EACH ROW
EXECUTE FUNCTION update_comment_replies_count();

DROP TRIGGER IF EXISTS trg_comment_reply_delete ON comment_replies;
CREATE TRIGGER trg_comment_reply_delete
AFTER DELETE ON comment_replies
FOR EACH ROW
EXECUTE FUNCTION update_comment_replies_count_delete();