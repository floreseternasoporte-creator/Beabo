import { supabase, getCurrentUserId, uploadImage } from './supabase-client.js';

// ===== CREAR Y PUBLICAR POSTS =====

export async function publishPost(content, imageFiles = [], pollData = null, location = null, coordinates = null) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('User not authenticated');

    const contentCheck = moderarContenidoNota(content);
    if (contentCheck) {
      throw new Error('Content contains inappropriate language');
    }

    let imageUrls = [];

    if (imageFiles && imageFiles.length > 0) {
      const uploadPromises = imageFiles.slice(0, 3).map(file => uploadImage(file));
      imageUrls = await Promise.all(uploadPromises);
    }

    const postData = {
      user_id: userId,
      content,
      image_urls: imageUrls,
      image_url: imageUrls[0] || null,
      poll_question: pollData?.question || null,
      poll_options: pollData?.options || [],
      location: location || null,
      latitude: coordinates?.latitude || null,
      longitude: coordinates?.longitude || null,
      upvotes_count: 0,
      downvotes_count: 0,
      comments_count: 0,
      is_hidden: false
    };

    const { data, error } = await supabase
      .from('community_posts')
      .insert([postData])
      .select();

    if (error) throw error;

    return data[0];
  } catch (error) {
    console.error('Error publishing post:', error);
    throw error;
  }
}

// ===== CARGAR POSTS =====

export async function loadPostsFeed(limit = 20, offset = 0) {
  try {
    const { data, error } = await supabase
      .from('community_posts')
      .select('*')
      .eq('is_hidden', false)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error loading feed:', error);
    throw error;
  }
}

export async function loadUserPosts(userId, limit = 20, offset = 0) {
  try {
    const { data, error } = await supabase
      .from('community_posts')
      .select('*')
      .eq('user_id', userId)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error loading user posts:', error);
    throw error;
  }
}

export async function loadPostsByLocation(location, limit = 20, offset = 0) {
  try {
    const { data, error } = await supabase
      .from('community_posts')
      .select('*')
      .eq('location', location)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error loading location posts:', error);
    throw error;
  }
}

// ===== VOTOS EN POSTS =====

export async function votePost(postId, voteType) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('User not authenticated');

    if (!['upvote', 'downvote'].includes(voteType)) {
      throw new Error('Invalid vote type');
    }

    // Verificar si ya existe un voto
    const { data: existingVote, error: checkError } = await supabase
      .from('post_votes')
      .select('*')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .maybeSingle();

    if (checkError) throw checkError;

    if (existingVote) {
      // Si es el mismo voto, eliminarlo (toggle)
      if (existingVote.vote_type === voteType) {
        const { error: deleteError } = await supabase
          .from('post_votes')
          .delete()
          .eq('id', existingVote.id);

        if (deleteError) throw deleteError;
        return { removed: true };
      } else {
        // Si es diferente, actualizar
        const { error: updateError } = await supabase
          .from('post_votes')
          .update({ vote_type: voteType })
          .eq('id', existingVote.id);

        if (updateError) throw updateError;
        return { updated: true };
      }
    } else {
      // Crear nuevo voto
      const { error: insertError } = await supabase
        .from('post_votes')
        .insert([{ post_id: postId, user_id: userId, vote_type: voteType }]);

      if (insertError) throw insertError;
      return { created: true };
    }
  } catch (error) {
    console.error('Error voting on post:', error);
    throw error;
  }
}

export async function getUserVoteOnPost(postId) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from('post_votes')
      .select('vote_type')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    return data?.vote_type || null;
  } catch (error) {
    console.error('Error getting user vote:', error);
    return null;
  }
}

// ===== GESTIÓN DE POSTS =====

export async function deletePost(postId) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('User not authenticated');

    const { error } = await supabase
      .from('community_posts')
      .delete()
      .eq('id', postId)
      .eq('user_id', userId);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error deleting post:', error);
    throw error;
  }
}

export async function hidePostForUser(postId) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('User not authenticated');

    const { error } = await supabase
      .from('hidden_posts_by_user')
      .insert([{ user_id: userId, post_id: postId }]);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error hiding post:', error);
    throw error;
  }
}

export async function unhidePost(postId) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('User not authenticated');

    const { error } = await supabase
      .from('hidden_posts_by_user')
      .delete()
      .eq('post_id', postId)
      .eq('user_id', userId);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error unhiding post:', error);
    throw error;
  }
}

export async function getHiddenPostIds() {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('hidden_posts_by_user')
      .select('post_id')
      .eq('user_id', userId);

    if (error) throw error;
    return data.map(record => record.post_id);
  } catch (error) {
    console.error('Error getting hidden posts:', error);
    return [];
  }
}

// ===== REPORTES DE POSTS =====

export async function reportPost(postId, reason, description = null) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('User not authenticated');

    const { error } = await supabase
      .from('post_reports')
      .insert([{
        post_id: postId,
        reported_by_user_id: userId,
        reason,
        description,
        status: 'pending'
      }]);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error reporting post:', error);
    throw error;
  }
}

export async function hidePostByModeration(postId, reason) {
  try {
    const { error } = await supabase
      .from('community_posts')
      .update({ is_hidden: true, moderation_reason: reason })
      .eq('id', postId);

    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error hiding post by moderation:', error);
    throw error;
  }
}

// ===== COMENTARIOS =====

export async function createComment(postId, content, imageFiles = []) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('User not authenticated');

    let imageUrls = [];
    if (imageFiles && imageFiles.length > 0) {
      const uploadPromises = imageFiles.slice(0, 3).map(file => uploadImage(file));
      imageUrls = await Promise.all(uploadPromises);
    }

    const { data, error } = await supabase
      .from('post_comments')
      .insert([{
        post_id: postId,
        user_id: userId,
        content,
        image_urls: imageUrls
      }])
      .select();

    if (error) throw error;
    return data[0];
  } catch (error) {
    console.error('Error creating comment:', error);
    throw error;
  }
}

export async function loadPostComments(postId) {
  try {
    const { data, error } = await supabase
      .from('post_comments')
      .select('*')
      .eq('post_id', postId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Cargar respuestas para cada comentario
    for (let comment of data) {
      const replies = await loadCommentReplies(comment.id);
      comment.replies = replies;
    }

    return data;
  } catch (error) {
    console.error('Error loading comments:', error);
    throw error;
  }
}

export async function deleteComment(commentId, parentId = null) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('User not authenticated');

    if (parentId) {
      // Es una respuesta
      const { error } = await supabase
        .from('comment_replies')
        .delete()
        .eq('id', commentId)
        .eq('user_id', userId);

      if (error) throw error;
    } else {
      // Es un comentario
      const { error } = await supabase
        .from('post_comments')
        .delete()
        .eq('id', commentId)
        .eq('user_id', userId);

      if (error) throw error;
    }

    return true;
  } catch (error) {
    console.error('Error deleting comment:', error);
    throw error;
  }
}

// ===== RESPUESTAS A COMENTARIOS =====

export async function createReply(postId, parentCommentId, content, imageFiles = []) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('User not authenticated');

    let imageUrls = [];
    if (imageFiles && imageFiles.length > 0) {
      const uploadPromises = imageFiles.slice(0, 3).map(file => uploadImage(file));
      imageUrls = await Promise.all(uploadPromises);
    }

    const { data, error } = await supabase
      .from('comment_replies')
      .insert([{
        post_id: postId,
        parent_comment_id: parentCommentId,
        user_id: userId,
        content,
        image_urls: imageUrls
      }])
      .select();

    if (error) throw error;
    return data[0];
  } catch (error) {
    console.error('Error creating reply:', error);
    throw error;
  }
}

export async function loadCommentReplies(commentId) {
  try {
    const { data, error } = await supabase
      .from('comment_replies')
      .select('*')
      .eq('parent_comment_id', commentId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error loading replies:', error);
    return [];
  }
}

// ===== VOTOS EN COMENTARIOS =====

export async function voteComment(commentId, voteType) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error('User not authenticated');

    if (!['upvote', 'downvote'].includes(voteType)) {
      throw new Error('Invalid vote type');
    }

    const { data: existingVote, error: checkError } = await supabase
      .from('comment_votes')
      .select('*')
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (checkError) throw checkError;

    if (existingVote) {
      if (existingVote.vote_type === voteType) {
        const { error: deleteError } = await supabase
          .from('comment_votes')
          .delete()
          .eq('id', existingVote.id);

        if (deleteError) throw deleteError;
        return { removed: true };
      } else {
        const { error: updateError } = await supabase
          .from('comment_votes')
          .update({ vote_type: voteType })
          .eq('id', existingVote.id);

        if (updateError) throw updateError;
        return { updated: true };
      }
    } else {
      const { error: insertError } = await supabase
        .from('comment_votes')
        .insert([{ comment_id: commentId, user_id: userId, vote_type: voteType }]);

      if (insertError) throw insertError;
      return { created: true };
    }
  } catch (error) {
    console.error('Error voting on comment:', error);
    throw error;
  }
}

export async function getUserVoteOnComment(commentId) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from('comment_votes')
      .select('vote_type')
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    return data?.vote_type || null;
  } catch (error) {
    console.error('Error getting user vote on comment:', error);
    return null;
  }
}

// ===== FUNCIONES DE MODERACIÓN =====

export function moderarContenidoNota(texto) {
  if (!texto) return false;

  const palabrasProhibidasNotas = [
    "idiota", "estúpido", "imbécil", "tonto", "pendejo",
    "maldito", "puta", "mierda", "carajo", "joder",
    "perra", "zorra", "maricón", "puto", "cabrón",
    "negro", "sudaca", "indio", "gitano", "judio",
    "xxx", "porn", "sex", "desnudo",
    "matar", "muerte", "suicidio", "sangre",
    "ganar dinero", "hazte rico", "click aquí"
  ];

  const textoNormalizado = texto.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, '');

  const palabras = textoNormalizado.split(/\s+/);
  return palabras.some(palabra =>
    palabrasProhibidasNotas.includes(palabra) ||
    palabrasProhibidasNotas.some(palabraOfensiva =>
      palabra.includes(palabraOfensiva) && palabra.length < palabraOfensiva.length + 3
    )
  );
}

export function contienePalabrasOfensivas(texto) {
  const listaOfensiva = [
    "imbécil", "idiota", "estúpido", "tarado", "pendejo",
    "capullo", "gilipollas", "subnormal", "malparido", "bobo",
    "tonto", "inútil", "cretino", "estúpida", "pendeja",
    "zorra", "perra", "mierda", "cabrón", "merda"
  ];

  const textoNormalizado = texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return listaOfensiva.some(palabra => {
    const regex = new RegExp("\\b" + palabra + "\\b", "i");
    return regex.test(textoNormalizado);
  });
}

// ===== FUNCIONES HELPER PARA BÚSQUEDA Y FILTRADO =====

export async function searchPosts(query, limit = 20) {
  try {
    const { data, error } = await supabase
      .from('community_posts')
      .select('*')
      .ilike('content', `%${query}%`)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error searching posts:', error);
    throw error;
  }
}

export async function searchComments(query, limit = 20) {
  try {
    const { data, error } = await supabase
      .from('post_comments')
      .select('*')
      .ilike('content', `%${query}%`)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error searching comments:', error);
    throw error;
  }
}