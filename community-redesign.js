// ============================================
// COMMUNITY REDESIGN - REDDIT STYLE
// ============================================

// State Management
let communityState = {
  currentSort: 'hot',
  notes: [],
  userVotes: {}, // Track user votes: { noteId: 'upvote' | 'downvote' | null }
  isLoading: false
};

// ============================================
// INITIALIZATION
// ============================================

function initializeCommunity() {
  loadCommunityInfo();
  loadNotes();
  setupEventListeners();
}

function setupEventListeners() {
  // Character counter for post content
  const postContent = document.getElementById('post-content');
  if (postContent) {
    postContent.addEventListener('input', function() {
      const remaining = 200 - this.value.length;
      const counter = document.getElementById('char-counter');
      counter.textContent = remaining + ' characters remaining';
      
      if (remaining <= 20) {
        counter.classList.add('text-[#FE2C55]');
      } else {
        counter.classList.remove('text-[#FE2C55]');
      }
    });
  }

  // Sort buttons
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.sort-btn').forEach(b => {
        b.classList.remove('bg-[#FE2C55]', 'text-white');
        b.classList.add('bg-gray-200', 'text-black');
      });
      this.classList.add('bg-[#FE2C55]', 'text-white');
      this.classList.remove('bg-gray-200', 'text-black');
    });
  });
}

// ============================================
// COMMUNITY INFO
// ============================================

async function loadCommunityInfo() {
  try {
    // This would typically come from Firebase
    // For now, we'll set placeholder values
    document.getElementById('community-members').textContent = '1,234';
    document.getElementById('community-active').textContent = '42';
    document.getElementById('community-description').textContent = 
      'A community for sharing thoughts, stories, and connecting with other readers and writers.';
  } catch (error) {
    console.error('Error loading community info:', error);
  }
}

// ============================================
// NOTES/POSTS LOADING
// ============================================

async function loadNotes() {
  communityState.isLoading = true;
  showFeedLoading(true);

  try {
    const response = await fetch('/.netlify/functions/get-notes?limit=50');
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Error loading posts');
    }

    communityState.notes = result.notes || [];
    
    // Sort notes based on current sort type
    sortNotesInMemory();
    
    // Render notes
    renderNotes();
  } catch (error) {
    console.error('Error loading notes:', error);
    showFeedError();
  } finally {
    communityState.isLoading = false;
    showFeedLoading(false);
  }
}

function sortNotesInMemory() {
  const notes = communityState.notes;
  const now = Date.now();

  switch (communityState.currentSort) {
    case 'hot':
      // Hot: combination of recent + popular
      notes.sort((a, b) => {
        const scoreA = (a.likes || 0) + (a.comments?.length || 0) * 2;
        const scoreB = (b.likes || 0) + (b.comments?.length || 0) * 2;
        return scoreB - scoreA;
      });
      break;

    case 'new':
      // New: most recent first
      notes.sort((a, b) => b.timestamp - a.timestamp);
      break;

    case 'top':
      // Top: most liked
      notes.sort((a, b) => (b.likes || 0) - (a.likes || 0));
      break;

    case 'rising':
      // Rising: gaining popularity recently
      notes.sort((a, b) => {
        const ageA = (now - a.timestamp) / (1000 * 60 * 60); // hours
        const ageB = (now - b.timestamp) / (1000 * 60 * 60);
        
        const velocityA = (a.likes || 0) / Math.max(ageA, 1);
        const velocityB = (b.likes || 0) / Math.max(ageB, 1);
        
        return velocityB - velocityA;
      });
      break;

    default:
      break;
  }
}

function sortCommunityNotes(sortType) {
  communityState.currentSort = sortType;
  sortNotesInMemory();
  renderNotes();
}

function renderNotes() {
  const feedContainer = document.getElementById('notes-feed');
  
  if (communityState.notes.length === 0) {
    feedContainer.innerHTML = '';
    document.getElementById('feed-empty').classList.remove('hidden');
    return;
  }

  document.getElementById('feed-empty').classList.add('hidden');
  feedContainer.innerHTML = '';

  communityState.notes.forEach(note => {
    const postElement = createPostElement(note);
    feedContainer.appendChild(postElement);
  });
}

function createPostElement(note) {
  const template = document.getElementById('post-template');
  const postClone = template.content.cloneNode(true);

  // Get current user
  const currentUser = firebase.auth().currentUser;
  const isOwnPost = currentUser && note.authorId === currentUser.uid;

  // Set data attributes
  const postCard = postClone.querySelector('.post-card');
  postCard.dataset.noteId = note.noteId;

  // Header
  postClone.querySelector('.post-avatar').src = note.authorImage || 'https://via.placeholder.com/40';
  postClone.querySelector('.post-author').textContent = note.authorName || 'Anonymous';
  postClone.querySelector('.post-time').textContent = '• ' + formatTimeAgo(note.timestamp);

  // Content
  postClone.querySelector('.post-content').textContent = note.content;
  
  if (note.imageUrl) {
    const img = postClone.querySelector('.post-image');
    img.src = note.imageUrl;
    img.classList.remove('hidden');
  }

  // Stats
  postClone.querySelector('.post-upvotes').textContent = (note.likes || 0) + ' upvotes';
  postClone.querySelector('.post-comments').textContent = (note.comments?.length || 0) + ' comments';
  postClone.querySelector('.post-shares').textContent = (note.shares || 0) + ' shares';

  // Actions
  const upvoteBtn = postClone.querySelector('.post-upvote');
  const downvoteBtn = postClone.querySelector('.post-downvote');
  const commentBtn = postClone.querySelector('.post-comment');
  const shareBtn = postClone.querySelector('.post-share');

  // Upvote handler
  upvoteBtn.addEventListener('click', () => {
    if (!currentUser) {
      alert('Please sign in to vote');
      return;
    }
    toggleUpvote(note.noteId, upvoteBtn, downvoteBtn);
  });

  // Downvote handler
  downvoteBtn.addEventListener('click', () => {
    if (!currentUser) {
      alert('Please sign in to vote');
      return;
    }
    toggleDownvote(note.noteId, upvoteBtn, downvoteBtn);
  });

  // Comment handler
  commentBtn.addEventListener('click', () => {
    openCommentsModal(note);
  });

  // Share handler
  shareBtn.addEventListener('click', () => {
    sharePost(note);
  });

  // Menu handler
  const menuBtn = postClone.querySelector('.post-menu');
  if (isOwnPost) {
    menuBtn.addEventListener('click', () => {
      showPostMenu(note.noteId);
    });
  } else {
    menuBtn.addEventListener('click', () => {
      showReportMenu(note.noteId);
    });
  }

  return postClone;
}

// ============================================
// VOTING SYSTEM
// ============================================

function toggleUpvote(noteId, upvoteBtn, downvoteBtn) {
  const currentVote = communityState.userVotes[noteId];

  if (currentVote === 'upvote') {
    // Remove upvote
    removeVote(noteId);
    upvoteBtn.classList.remove('text-[#FE2C55]');
  } else {
    // Add upvote (and remove downvote if exists)
    if (currentVote === 'downvote') {
      downvoteBtn.classList.remove('text-gray-800');
    }
    
    communityState.userVotes[noteId] = 'upvote';
    upvoteBtn.classList.add('text-[#FE2C55]');
    downvoteBtn.classList.remove('text-gray-800');

    // Update in Firebase
    updateVote(noteId, 'upvote');
  }
}

function toggleDownvote(noteId, upvoteBtn, downvoteBtn) {
  const currentVote = communityState.userVotes[noteId];

  if (currentVote === 'downvote') {
    // Remove downvote
    removeVote(noteId);
    downvoteBtn.classList.remove('text-gray-800');
  } else {
    // Add downvote (and remove upvote if exists)
    if (currentVote === 'upvote') {
      upvoteBtn.classList.remove('text-[#FE2C55]');
    }
    
    communityState.userVotes[noteId] = 'downvote';
    downvoteBtn.classList.add('text-gray-800');
    upvoteBtn.classList.remove('text-[#FE2C55]');

    // Update in Firebase
    updateVote(noteId, 'downvote');
  }
}

async function updateVote(noteId, voteType) {
  try {
    const response = await fetch('/.netlify/functions/vote-on-note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noteId, voteType })
    });

    if (!response.ok) {
      throw new Error('Failed to vote');
    }

    // Update local state
    const note = communityState.notes.find(n => n.noteId === noteId);
    if (note) {
      if (voteType === 'upvote') {
        note.likes = (note.likes || 0) + 1;
      } else if (voteType === 'downvote') {
        note.downvotes = (note.downvotes || 0) + 1;
      }
    }
  } catch (error) {
    console.error('Error voting:', error);
  }
}

function removeVote(noteId) {
  communityState.userVotes[noteId] = null;
  // TODO: Call API to remove vote
}

// ============================================
// POST CREATION
// ============================================

function showCreatePostForm() {
  const modal = document.getElementById('create-post-modal');
  const currentUser = firebase.auth().currentUser;

  if (!currentUser) {
    alert('Please sign in to create a post');
    return;
  }

  // Set user info
  document.getElementById('user-avatar-modal').src = currentUser.photoURL || 'https://via.placeholder.com/40';
  document.getElementById('user-name-modal').textContent = currentUser.displayName || 'Anonymous';

  modal.classList.remove('hidden');
}

function closeCreatePostForm() {
  document.getElementById('create-post-modal').classList.add('hidden');
  document.getElementById('post-content').value = '';
  document.getElementById('post-image').value = '';
  document.getElementById('image-preview-modal').classList.add('hidden');
}

function handlePostImagePreview(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const preview = document.getElementById('image-preview-modal');
    const img = document.getElementById('preview-img-modal');
    img.src = e.target.result;
    preview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function removeImageModal() {
  document.getElementById('post-image').value = '';
  document.getElementById('image-preview-modal').classList.add('hidden');
}

async function publishPost() {
  const content = document.getElementById('post-content').value.trim();
  const imageInput = document.getElementById('post-image');
  const currentUser = firebase.auth().currentUser;

  if (!content && !imageInput.files.length) {
    alert('Please write something or add an image');
    return;
  }

  if (!currentUser) {
    alert('Please sign in to post');
    return;
  }

  const publishBtn = document.querySelector('#create-post-modal button[onclick="publishPost()"]');
  publishBtn.disabled = true;
  publishBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Posting...';

  try {
    // Upload image if exists
    let imageUrl = null;
    if (imageInput.files.length > 0) {
      imageUrl = await uploadPostImage(imageInput.files[0], currentUser.uid);
    }

    // Create post
    const response = await fetch('/.netlify/functions/upload-note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        imageUrl,
        authorId: currentUser.uid,
        authorName: currentUser.displayName || 'Anonymous',
        authorImage: currentUser.photoURL
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to publish post');
    }

    // Close modal and reload notes
    closeCreatePostForm();
    loadNotes();
  } catch (error) {
    console.error('Error publishing post:', error);
    alert('Error: ' + error.message);
  } finally {
    publishBtn.disabled = false;
    publishBtn.innerHTML = 'Post';
  }
}

async function uploadPostImage(file, userId) {
  // This would use Firebase Storage
  // For now, returning placeholder
  return 'https://via.placeholder.com/400x300';
}

// ============================================
// COMMENTS
// ============================================

function openCommentsModal(note) {
  // TODO: Implement comments modal
  console.log('Open comments for note:', note.noteId);
}

// ============================================
// SHARING
// ============================================

function sharePost(note) {
  if (navigator.share) {
    navigator.share({
      title: 'Check this out on Beaboo',
      text: note.content,
      url: window.location.href
    });
  } else {
    // Fallback: copy to clipboard
    const text = `${note.content} - Shared from Beaboo`;
    navigator.clipboard.writeText(text).then(() => {
      alert('Post copied to clipboard!');
    });
  }
}

// ============================================
// POST MENU
// ============================================

function showPostMenu(noteId) {
  // TODO: Implement post menu (edit, delete)
  console.log('Show menu for post:', noteId);
}

function showReportMenu(noteId) {
  // TODO: Implement report menu
  console.log('Show report menu for post:', noteId);
}

// ============================================
// UI HELPERS
// ============================================

function showFeedLoading(show) {
  const loading = document.getElementById('feed-loading');
  if (show) {
    loading.classList.remove('hidden');
  } else {
    loading.classList.add('hidden');
  }
}

function showFeedError() {
  const feedContainer = document.getElementById('notes-feed');
  feedContainer.innerHTML = `
    <div class="flex flex-col items-center justify-center py-12 text-red-500">
      <i class="fas fa-exclamation-triangle text-4xl mb-3"></i>
      <p class="text-lg font-medium">Error loading posts</p>
      <p class="text-sm">Please try refreshing the page</p>
      <button onclick="loadNotes()" class="mt-4 bg-[#FE2C55] text-white px-4 py-2 rounded-lg">
        Try Again
      </button>
    </div>
  `;
}

function formatTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  
  return new Date(timestamp).toLocaleDateString();
}

// ============================================
// PUBLIC API
// ============================================

function openCommunity() {
  document.getElementById('community-view').classList.remove('hidden');
  initializeCommunity();
}

function closeCommunity() {
  document.getElementById('community-view').classList.add('hidden');
}

// Initialize when community view is opened
document.addEventListener('DOMContentLoaded', () => {
  // Setup will happen when community is opened
});
