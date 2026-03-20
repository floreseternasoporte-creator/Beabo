import {
  publishPost,
  loadPostsFeed,
  loadUserPosts,
  loadPostsByLocation,
  votePost,
  getUserVoteOnPost,
  deletePost,
  hidePostForUser,
  unhidePost,
  getHiddenPostIds,
  reportPost,
  createComment,
  loadPostComments,
  deleteComment,
  createReply,
  loadCommentReplies,
  voteComment,
  getUserVoteOnComment,
  searchPosts,
  searchComments,
  moderarContenidoNota,
  contienePalabrasOfensivas,
  hidePostByModeration
} from './supabase-posts.js';

import { supabase, getCurrentUserId } from './supabase-client.js';

// Estado global para manejar el feed
let currentFeed = [];
let currentOffset = 0;
const FEED_LIMIT = 20;
let hiddenPostIds = [];

// ===== INICIALIZACIÓN =====

export async function initializeSupabaseIntegration() {
  try {
    // Cargar posts ocultos al inicio
    hiddenPostIds = await getHiddenPostIds();

    // Configurar listener para cambios en auth
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN') {
        loadNotes();
      } else if (event === 'SIGNED_OUT') {
        currentFeed = [];
        currentOffset = 0;
      }
    });

    // Cargar feed inicial
    loadNotes();
  } catch (error) {
    console.error('Error initializing Supabase integration:', error);
  }
}

// ===== FUNCIONES DE PUBLICACIÓN =====

export async function publishNoteFromForm() {
  try {
    const content = document.getElementById('note-content').value.trim();
    const imageInput = document.getElementById('note-image');

    if (!content && !imageInput?.files.length) {
      alert('Por favor escribe algo o agrega una imagen');
      return;
    }

    const publishButton = document.querySelector('button[onclick="publishNote()"]');
    if (publishButton) {
      publishButton.disabled = true;
      publishButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Publicando...';
    }

    const imageFiles = imageInput?.files ? Array.from(imageInput.files) : [];

    await publishPost(content, imageFiles);

    // Limpiar formulario
    document.getElementById('note-content').value = '';
    if (imageInput) imageInput.value = '';
    const preview = document.getElementById('image-preview');
    if (preview) preview.classList.add('hidden');

    // Recargar feed
    await loadNotes();

    if (publishButton) {
      publishButton.disabled = false;
      publishButton.innerHTML = 'Publicar';
    }

    alert('¡Publicación creada exitosamente!');
  } catch (error) {
    console.error('Error publishing note:', error);
    alert('Error al publicar: ' + error.message);

    const publishButton = document.querySelector('button[onclick="publishNote()"]');
    if (publishButton) {
      publishButton.disabled = false;
      publishButton.innerHTML = 'Publicar';
    }
  }
}

export async function publishNoteFromFullscreen() {
  try {
    const content = document.getElementById('note-content-fullscreen').value.trim();
    const imageInput = document.getElementById('note-image-fullscreen');
    const pollQuestion = document.getElementById('poll-question-main').value.trim();

    if (!content && !imageInput?.files.length) {
      alert('Por favor escribe algo o agrega una imagen');
      return;
    }

    const publishBtn = document.getElementById('publish-btn-fullscreen');
    if (publishBtn) {
      publishBtn.disabled = true;
      publishBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Publicando...';
    }

    const imageFiles = imageInput?.files ? Array.from(imageInput.files) : [];
    const pollData = pollQuestion ? {
      question: pollQuestion,
      options: getPollOptions()
    } : null;

    await publishPost(content, imageFiles, pollData);

    // Limpiar formularios
    document.getElementById('note-content-fullscreen').value = '';
    if (imageInput) imageInput.value = '';
    const preview = document.getElementById('image-preview-fullscreen');
    if (preview) preview.classList.add('hidden');
    clearPollOptions();

    closeNoteCreationFullscreen();
    await loadNotes();

    if (publishBtn) {
      publishBtn.disabled = false;
      publishBtn.innerHTML = 'Publicar';
    }

    alert('¡Publicación creada exitosamente!');
  } catch (error) {
    console.error('Error publishing note from fullscreen:', error);
    alert('Error al publicar: ' + error.message);

    const publishBtn = document.getElementById('publish-btn-fullscreen');
    if (publishBtn) {
      publishBtn.disabled = false;
      publishBtn.innerHTML = 'Publicar';
    }
  }
}

// ===== CARGA DE FEED Y POSTS =====

export async function loadNotes() {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      console.warn('User not authenticated, cannot load notes');
      return;
    }

    currentOffset = 0;
    const posts = await loadPostsFeed(FEED_LIMIT, currentOffset);

    currentFeed = posts.filter(post => !hiddenPostIds.includes(post.id));

    await renderPostsFeed();
  } catch (error) {
    console.error('Error loading notes:', error);
  }
}

export async function loadMoreNotes() {
  try {
    currentOffset += FEED_LIMIT;
    const posts = await loadPostsFeed(FEED_LIMIT, currentOffset);

    const newPosts = posts.filter(post => !hiddenPostIds.includes(post.id));
    currentFeed.push(...newPosts);

    await renderPostsFeed();
  } catch (error) {
    console.error('Error loading more notes:', error);
  }
}

export async function loadUserPostsForProfile(userId) {
  try {
    const posts = await loadUserPosts(userId, 100, 0);
    return posts.filter(post => !hiddenPostIds.includes(post.id));
  } catch (error) {
    console.error('Error loading user posts:', error);
    return [];
  }
}

export async function loadLocationPosts(location) {
  try {
    const posts = await loadPostsByLocation(location, 50, 0);
    return posts.filter(post => !hiddenPostIds.includes(post.id));
  } catch (error) {
    console.error('Error loading location posts:', error);
    return [];
  }
}

// ===== RENDERIZADO DE POSTS =====

export async function renderPostsFeed() {
  try {
    const feedContainer = document.getElementById('notes-feed');
    if (!feedContainer) return;

    feedContainer.innerHTML = '';

    for (const post of currentFeed) {
      const postElement = await createPostElement(post);
      feedContainer.appendChild(postElement);
    }
  } catch (error) {
    console.error('Error rendering posts feed:', error);
  }
}

async function createPostElement(post) {
  try {
    const userVote = await getUserVoteOnPost(post.id);

    const div = document.createElement('div');
    div.className = 'border-b border-gray-200 p-4 hover:bg-gray-50 transition cursor-pointer';
    div.id = `post-${post.id}`;

    // Aquí va el HTML del post - compatible con las funciones existentes
    div.innerHTML = `
      <div class="flex gap-3">
        <img src="${post.author_image || 'https://via.placeholder.com/40'}"
             alt="Avatar"
             class="w-10 h-10 rounded-full object-cover">
        <div class="flex-1">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="font-bold">${post.author_name || 'Usuario'}</span>
              <span class="text-gray-500 text-sm">@${post.author_id}</span>
            </div>
            <button onclick="openPostOptionsSheet('${post.id}')" class="text-gray-500 hover:text-[#FE2C55]">
              <i class="fas fa-ellipsis-h"></i>
            </button>
          </div>

          <p class="text-gray-900 mt-2 break-words">${escapeHtml(post.content)}</p>

          ${post.image_urls && post.image_urls.length > 0 ? `
            <div class="mt-3 rounded-lg overflow-hidden">
              ${post.image_urls.map(url => `<img src="${url}" alt="Post image" class="max-w-full">`).join('')}
            </div>
          ` : ''}

          ${post.poll_question ? `
            <div class="mt-3 p-3 bg-gray-100 rounded-lg">
              <p class="font-semibold mb-2">${escapeHtml(post.poll_question)}</p>
              ${post.poll_options?.map(opt => `
                <button class="w-full text-left p-2 mb-1 bg-white rounded border border-gray-300 hover:border-[#FE2C55]">
                  ${escapeHtml(opt)}
                </button>
              `).join('') || ''}
            </div>
          ` : ''}

          <div class="flex gap-4 mt-3 text-gray-500 text-sm flex-wrap">
            <button onclick="openPostComments('${post.id}')" class="flex items-center gap-1 hover:text-[#FE2C55]">
              <i class="fas fa-comment"></i> ${post.comments_count || 0}
            </button>
            <button onclick="votePost('${post.id}', 'upvote')" class="flex items-center gap-1 ${userVote === 'upvote' ? 'text-[#FE2C55]' : 'hover:text-[#FE2C55]'}">
              <i class="fas fa-fire"></i> ${post.upvotes_count || 0}
            </button>
            <button onclick="votePost('${post.id}', 'downvote')" class="flex items-center gap-1 ${userVote === 'downvote' ? 'text-blue-500' : 'hover:text-blue-500'}">
              <i class="fas fa-snowflake"></i> ${post.downvotes_count || 0}
            </button>
          </div>
        </div>
      </div>
    `;

    return div;
  } catch (error) {
    console.error('Error creating post element:', error);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'p-4 text-red-500';
    errorDiv.textContent = 'Error cargando post';
    return errorDiv;
  }
}

// ===== VOTOS =====

export async function handlePostVote(postId, voteType) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      alert('Debes iniciar sesión para votar');
      return;
    }

    await votePost(postId, voteType);

    // Actualizar feed
    await loadNotes();
  } catch (error) {
    console.error('Error voting:', error);
    alert('Error al votar');
  }
}

export async function handleCommentVote(commentId, voteType) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      alert('Debes iniciar sesión para votar');
      return;
    }

    await voteComment(commentId, voteType);
  } catch (error) {
    console.error('Error voting on comment:', error);
    alert('Error al votar');
  }
}

// ===== GESTIÓN DE POSTS =====

export async function handleDeletePost(postId) {
  try {
    if (!confirm('¿Estás seguro de que deseas eliminar esta publicación?')) {
      return;
    }

    await deletePost(postId);
    await loadNotes();
  } catch (error) {
    console.error('Error deleting post:', error);
    alert('Error al eliminar: ' + error.message);
  }
}

export async function handleHidePost(postId) {
  try {
    await hidePostForUser(postId);
    hiddenPostIds.push(postId);
    currentFeed = currentFeed.filter(p => p.id !== postId);
    await renderPostsFeed();
  } catch (error) {
    console.error('Error hiding post:', error);
    alert('Error al ocultar post');
  }
}

export async function handleUnhidePost(postId) {
  try {
    await unhidePost(postId);
    hiddenPostIds = hiddenPostIds.filter(id => id !== postId);
  } catch (error) {
    console.error('Error unhiding post:', error);
    alert('Error al mostrar post');
  }
}

export async function handleReportPost(postId, reason, description) {
  try {
    await reportPost(postId, reason, description);
    alert('Gracias por reportar. Revisaremos el contenido.');
  } catch (error) {
    console.error('Error reporting post:', error);
    alert('Error al reportar: ' + error.message);
  }
}

// ===== COMENTARIOS =====

export async function handleCreateComment(postId, content, imageFiles = []) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      alert('Debes iniciar sesión para comentar');
      return;
    }

    await createComment(postId, content, imageFiles);

    // Recargar comentarios
    await loadPostCommentsList(postId);
  } catch (error) {
    console.error('Error creating comment:', error);
    alert('Error al comentar: ' + error.message);
  }
}

export async function loadPostCommentsList(postId) {
  try {
    const comments = await loadPostComments(postId);
    await renderComments(postId, comments);
  } catch (error) {
    console.error('Error loading comments:', error);
  }
}

async function renderComments(postId, comments) {
  try {
    const container = document.getElementById(`comments-${postId}`);
    if (!container) return;

    container.innerHTML = '';

    for (const comment of comments) {
      const commentEl = await createCommentElement(postId, comment);
      container.appendChild(commentEl);

      if (comment.replies && comment.replies.length > 0) {
        const repliesContainer = document.createElement('div');
        repliesContainer.className = 'ml-8 space-y-2';
        for (const reply of comment.replies) {
          const replyEl = await createCommentElement(postId, reply, comment.id);
          repliesContainer.appendChild(replyEl);
        }
        container.appendChild(repliesContainer);
      }
    }
  } catch (error) {
    console.error('Error rendering comments:', error);
  }
}

async function createCommentElement(postId, comment, parentCommentId = null) {
  try {
    const userVote = await getUserVoteOnComment(comment.id);

    const div = document.createElement('div');
    div.className = 'p-3 bg-gray-50 rounded-lg';
    div.innerHTML = `
      <div class="flex gap-2">
        <img src="${comment.author_image || 'https://via.placeholder.com/32'}"
             alt="Avatar"
             class="w-8 h-8 rounded-full object-cover">
        <div class="flex-1">
          <div class="flex items-center justify-between">
            <span class="font-bold text-sm">${comment.author_name || 'Usuario'}</span>
            <button onclick="deleteCommentHandler('${comment.id}', '${parentCommentId || ''}')" class="text-gray-400 hover:text-red-500 text-xs">
              <i class="fas fa-trash"></i>
            </button>
          </div>
          <p class="text-sm text-gray-900 mt-1">${escapeHtml(comment.content)}</p>
          <div class="flex gap-2 mt-2 text-xs text-gray-500">
            <button onclick="handleCommentVote('${comment.id}', 'upvote')" class="flex items-center gap-1 ${userVote === 'upvote' ? 'text-[#FE2C55]' : ''}">
              <i class="fas fa-fire"></i> ${comment.upvotes_count || 0}
            </button>
            <button onclick="handleCommentVote('${comment.id}', 'downvote')" class="flex items-center gap-1 ${userVote === 'downvote' ? 'text-blue-500' : ''}">
              <i class="fas fa-snowflake"></i> ${comment.downvotes_count || 0}
            </button>
            <button onclick="toggleReplyForm('${comment.id}')" class="hover:text-[#FE2C55]">
              Responder
            </button>
          </div>
        </div>
      </div>
    `;
    return div;
  } catch (error) {
    console.error('Error creating comment element:', error);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'p-3 text-red-500 text-sm';
    errorDiv.textContent = 'Error cargando comentario';
    return errorDiv;
  }
}

export async function handleCreateReply(postId, parentCommentId, content, imageFiles = []) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      alert('Debes iniciar sesión para responder');
      return;
    }

    await createReply(postId, parentCommentId, content, imageFiles);

    // Recargar comentarios
    await loadPostCommentsList(postId);
  } catch (error) {
    console.error('Error creating reply:', error);
    alert('Error al responder: ' + error.message);
  }
}

export async function deleteCommentHandler(commentId, parentCommentId = null) {
  try {
    if (!confirm('¿Estás seguro de que deseas eliminar este comentario?')) {
      return;
    }

    await deleteComment(commentId, parentCommentId || null);
  } catch (error) {
    console.error('Error deleting comment:', error);
    alert('Error al eliminar comentario');
  }
}

// ===== UTILIDADES =====

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getPollOptions() {
  const options = [];
  document.querySelectorAll('[data-poll-option]').forEach(el => {
    const value = el.value?.trim();
    if (value) options.push(value);
  });
  return options;
}

function clearPollOptions() {
  document.querySelectorAll('[data-poll-option]').forEach(el => {
    el.value = '';
  });
}

// Exportar funciones globales para usar en onclick
// Alias internos para evitar que funciones legacy de index.html sobreescriban la integración nueva.
window.__publishNoteSupabase = publishNoteFromForm;
window.__publishNoteFromFullscreenSupabase = publishNoteFromFullscreen;
window.__loadNotesSupabase = loadNotes;
window.__loadMoreNotesSupabase = loadMoreNotes;

window.publishNote = publishNoteFromForm;
window.publishNoteFromFullscreen = publishNoteFromFullscreen;
window.loadNotes = loadNotes;
window.loadMoreNotes = loadMoreNotes;
window.votePost = handlePostVote;
window.deletePostHandler = handleDeletePost;
window.hidePostHandler = handleHidePost;
window.unhidePostHandler = handleUnhidePost;
window.reportPostHandler = handleReportPost;
window.createCommentHandler = handleCreateComment;
window.voteCommentHandler = handleCommentVote;
window.deleteCommentHandler = deleteCommentHandler;
window.createReplyHandler = handleCreateReply;
window.loadPostComments = loadPostCommentsList;
window.handlePostVote = handlePostVote;
window.handleCommentVote = handleCommentVote;
window.moderarContenidoNota = moderarContenidoNota;
window.contienePalabrasOfensivas = contienePalabrasOfensivas;
window.hidePostByModeration = hidePostByModeration;