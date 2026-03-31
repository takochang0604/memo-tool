/* ============================================================
   MEMO SPACE — app.js
   Firebase Auth + Firestore + Storage + SortableJS
   ============================================================ */

// ── Firebase 初始化 ──────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyBAc8rrFgqOSmrImCZU8vPzJeKIaTTftj4",
  authDomain:        "memorandum-3abaa.firebaseapp.com",
  projectId:         "memorandum-3abaa",
  storageBucket:     "memorandum-3abaa.firebasestorage.app",
  messagingSenderId: "339882662542",
  appId:             "1:339882662542:web:a01cd406296720318c07df",
  measurementId:     "G-MW4W68Y6KT"
};

firebase.initializeApp(firebaseConfig);
const auth    = firebase.auth();
const db      = firebase.firestore();
const storage = firebase.storage();

// ── 狀態變數 ─────────────────────────────────────────────────
let currentUser   = null;
let allNotes      = [];
let currentNoteId = null;   // 編輯或查看的筆記 ID
let pendingImages = [];     // 待上傳的圖片 File 陣列（新增模式）
let keepImages    = [];     // 編輯時保留的已有圖片 URL
let _sortable     = null;
let _swapMounted  = false;
let unsubscribeNotes = null;
let currentFilter = 'all';
let currentSort   = 'manual';
let searchQuery   = '';

// ── 帳號格式 ─────────────────────────────────────────────────
const EMAIL_SUFFIX = '@splitool.app';

function toEmail(username) {
  return username.trim().toLowerCase() + EMAIL_SUFFIX;
}

// ============================================================
// AUTH
// ============================================================

/** 頁籤切換 */
function switchTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('form-login').classList.toggle('active', tab === 'login');
  document.getElementById('form-register').classList.toggle('active', tab === 'register');
  clearAuthMessage();
}

function clearAuthMessage() {
  const el = document.getElementById('auth-message');
  el.textContent = '';
  el.className = 'auth-message';
}

function showAuthMessage(msg, type = 'error') {
  const el = document.getElementById('auth-message');
  el.textContent = msg;
  el.className = 'auth-message ' + type;
}

function togglePassword(inputId) {
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
}

/** 登入 */
async function handleLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  if (!username || !password) {
    showAuthMessage('請輸入帳號與密碼');
    return;
  }

  const btn = document.getElementById('btn-login');
  setButtonLoading(btn, true);
  clearAuthMessage();

  try {
    await auth.signInWithEmailAndPassword(toEmail(username), password);
    // onAuthStateChanged 會處理後續
  } catch (err) {
    let msg = '登入失敗，請確認帳號密碼';
    if (err.code === 'auth/user-not-found') msg = '帳號不存在，請先註冊';
    if (err.code === 'auth/wrong-password')  msg = '密碼錯誤';
    if (err.code === 'auth/too-many-requests') msg = '多次失敗，請稍後再試';
    showAuthMessage(msg);
    setButtonLoading(btn, false);
  }
}

/** 註冊 */
async function handleRegister() {
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm  = document.getElementById('reg-confirm').value;

  if (!username || !password || !confirm) {
    showAuthMessage('請填寫所有欄位');
    return;
  }

  if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
    showAuthMessage('帳號僅允許英數字與底線，長度 4-20 字元');
    return;
  }

  if (password.length < 6) {
    showAuthMessage('密碼至少需要 6 個字元');
    return;
  }

  if (password !== confirm) {
    showAuthMessage('兩次密碼不相符');
    return;
  }

  const btn = document.getElementById('btn-register');
  setButtonLoading(btn, true);
  clearAuthMessage();

  try {
    await auth.createUserWithEmailAndPassword(toEmail(username), password);
    showAuthMessage('帳號建立成功！歡迎使用 MEMO SPACE 🎉', 'success');
    // onAuthStateChanged 會自動跳轉
  } catch (err) {
    let msg = '註冊失敗，請再試一次';
    if (err.code === 'auth/email-already-in-use') msg = '這個帳號名稱已被使用';
    showAuthMessage(msg);
    setButtonLoading(btn, false);
  }
}

/** 登出 */
async function handleLogout() {
  if (!confirm('確定要登出嗎？')) return;
  await auth.signOut();
}

// ── Auth 狀態監聽 ───────────────────────────────────────────
auth.onAuthStateChanged(user => {
  if (user) {
    currentUser = user;
    showPage('main-page');
    const username = user.email.replace(EMAIL_SUFFIX, '');
    document.getElementById('user-badge').textContent = '👤 ' + username;
    startListenNotes();
  } else {
    currentUser = null;
    showPage('auth-page');
    if (unsubscribeNotes) { unsubscribeNotes(); unsubscribeNotes = null; }
    allNotes = [];
  }
});

// ============================================================
// PAGE NAVIGATION
// ============================================================
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
}

// ============================================================
// PAGE COUNTER
// ============================================================
(function initPageCounter() {
  const TOOL_ID = 'memo-space';
  const counterRef = db.collection('counters').doc(TOOL_ID);

  counterRef.update({ views: firebase.firestore.FieldValue.increment(1) })
    .catch(() => counterRef.set({ views: 1 }))
    .then(() => counterRef.get())
    .then(doc => {
      if (doc && doc.exists) {
        const count = doc.data().views;
        const formatted = count.toLocaleString();
        const authNum = document.getElementById('counter-num-auth');
        const mainNum = document.getElementById('counter-num-main');
        if (authNum) authNum.textContent = formatted;
        if (mainNum) mainNum.textContent = formatted;
      }
    })
    .catch(err => console.error('Counter error:', err));
})();

// ============================================================
// NOTES — FIRESTORE
// ============================================================
function notesCol(uid) {
  return db.collection('users').doc(uid).collection('notes');
}

/** 監聽筆記列表 */
function startListenNotes() {
  if (!currentUser) return;

  // 先嘗試以 order 排序
  const q = notesCol(currentUser.uid).orderBy('order', 'asc');

  unsubscribeNotes = q.onSnapshot(
    snap => {
      allNotes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderNotes();
      updateFilterTags();
    },
    () => {
      // Fallback：尚未建立 order，改用 createdAt
      const q2 = notesCol(currentUser.uid).orderBy('createdAt', 'desc');
      unsubscribeNotes = q2.onSnapshot(snap => {
        allNotes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderNotes();
        updateFilterTags();
      });
    }
  );
}

/** 新增筆記 */
async function addNote(data) {
  const col = notesCol(currentUser.uid);
  return col.add({
    ...data,
    order: allNotes.length,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

/** 更新筆記 */
async function updateNote(id, data) {
  const ref = notesCol(currentUser.uid).doc(id);
  return ref.update({
    ...data,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

/** 刪除筆記（含 Storage 圖片） */
async function deleteNote(id) {
  const note = allNotes.find(n => n.id === id);
  if (!note) return;

  // 刪除 Storage 圖片
  if (note.images && note.images.length > 0) {
    const delPromises = note.images.map(async url => {
      try {
        const ref = storage.refFromURL(url);
        await ref.delete();
      } catch { /* ignore if already deleted */ }
    });
    await Promise.allSettled(delPromises);
  }

  return notesCol(currentUser.uid).doc(id).delete();
}

/** 批次更新排序 */
async function reorderNotes(newIdOrder) {
  const batch = db.batch();
  newIdOrder.forEach((id, idx) => {
    const ref = notesCol(currentUser.uid).doc(id);
    batch.update(ref, { order: idx });
  });
  return batch.commit();
}

// ============================================================
// RENDER
// ============================================================
function getFilteredSortedNotes() {
  let notes = [...allNotes];

  // 搜尋過濾
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    notes = notes.filter(n =>
      (n.title  || '').toLowerCase().includes(q) ||
      (n.content || '').toLowerCase().includes(q) ||
      (n.tag    || '').toLowerCase().includes(q)
    );
  }

  // 標籤過濾
  if (currentFilter !== 'all') {
    notes = notes.filter(n => n.tag === currentFilter);
  }

  // 排序
  if (currentSort === 'newest') {
    notes.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  } else if (currentSort === 'oldest') {
    notes.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  } else if (currentSort === 'updated') {
    notes.sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
  }
  // 'manual' 保持 allNotes 原始順序（已依 order 排好）

  return notes;
}

function renderNotes() {
  const grid  = document.getElementById('notes-grid');
  const empty = document.getElementById('empty-state');
  if (!grid) return;

  const notes = getFilteredSortedNotes();

  if (!notes.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    if (_sortable) { try { _sortable.destroy(); } catch {} _sortable = null; }
    return;
  }

  empty.classList.add('hidden');
  grid.innerHTML = notes.map(cardHTML).join('');

  // 只有「自訂排序」且沒有搜尋/篩選時啟用拖曳
  if (currentSort === 'manual' && !searchQuery && currentFilter === 'all') {
    initDragSort(grid);
  } else {
    if (_sortable) { try { _sortable.destroy(); } catch {} _sortable = null; }
  }
}

function cardHTML(note) {
  const title   = escapeHtml(note.title || '無標題');
  const content = escapeHtml(note.content || '');
  const tag     = note.tag ? `<span class="card-tag">${escapeHtml(note.tag)}</span>` : '';
  const date    = note.createdAt ? formatDate(note.createdAt.toDate()) : '';

  // 圖片縮圖（最多 4 張 + more）
  let imagesHTML = '';
  if (note.images && note.images.length > 0) {
    const show = note.images.slice(0, 4);
    const more = note.images.length - 4;
    imagesHTML = `<div class="card-images">`;
    show.forEach(url => {
      imagesHTML += `<img class="card-thumb" src="${url}" alt="圖片" loading="lazy" onclick="openDetail('${note.id}')">`;
    });
    if (more > 0) {
      imagesHTML += `<div class="card-more-images" onclick="openDetail('${note.id}')">+${more}</div>`;
    }
    imagesHTML += `</div>`;
  }

  return `
  <div class="note-card" data-id="${note.id}">
    <div class="card-header">
      <span class="card-title" onclick="openDetail('${note.id}')">${title}</span>
      ${tag}
    </div>
    ${content ? `<div class="card-content" onclick="openDetail('${note.id}')">${content}</div>` : ''}
    ${imagesHTML}
    <div class="card-footer">
      <span class="card-date">${date}</span>
      <div class="card-actions">
        <span class="drag-handle" title="拖曳排序">⠿</span>
        <button class="btn-icon-sm edit-btn" data-id="${note.id}" onclick="openEditModal('${note.id}')" title="編輯">✏️</button>
        <button class="btn-icon-sm btn-danger-sm" onclick="askDelete('${note.id}')" title="刪除">🗑</button>
      </div>
    </div>
  </div>`;
}

/** 更新標籤篩選列 */
function updateFilterTags() {
  const tags = [...new Set(allNotes.map(n => n.tag).filter(Boolean))];
  const container = document.getElementById('filter-tags');
  const activeTag = currentFilter;

  let html = `<button class="filter-tag ${activeTag === 'all' ? 'active' : ''}" onclick="filterByTag('all')">全部</button>`;
  tags.forEach(tag => {
    html += `<button class="filter-tag ${activeTag === tag ? 'active' : ''}" onclick="filterByTag('${escapeHtml(tag)}')">${escapeHtml(tag)}</button>`;
  });
  container.innerHTML = html;
}

// ============================================================
// DRAG SORT
// ============================================================
function initDragSort(grid) {
  if (_sortable) { try { _sortable.destroy(); } catch {} _sortable = null; }
  if (!window.Sortable) { console.warn('SortableJS not loaded'); return; }

  if (window.Sortable.Swap && !_swapMounted) {
    window.Sortable.mount(new window.Sortable.Swap());
    _swapMounted = true;
  }

  _sortable = window.Sortable.create(grid, {
    draggable:        '.note-card',
    delay:            150,
    delayOnTouchOnly: false,
    animation:        200,
    ghostClass:       'sortable-ghost',
    chosenClass:      'sortable-chosen',
    dragClass:        'sortable-drag',
    filter:           '.edit-btn',
    preventOnFilter:  false,
    swap:             true,
    swapClass:        'sortable-swap-highlight',

    onEnd() {
      const newOrder = [...grid.querySelectorAll('.note-card')].map(c => c.dataset.id);
      reorderNotes(newOrder).catch(err => {
        console.error('Reorder failed', err);
        showToast('排序儲存失敗', 'error');
      });
    }
  });
}

// ============================================================
// NOTE MODAL（新增 / 編輯）
// ============================================================
function showNewNoteModal() {
  currentNoteId = null;
  pendingImages = [];
  keepImages    = [];
  document.getElementById('modal-title').textContent = '新增筆記';
  document.getElementById('note-title').value   = '';
  document.getElementById('note-tag').value     = '';
  document.getElementById('note-content').value = '';
  document.getElementById('image-preview-grid').innerHTML = '';
  document.getElementById('upload-progress').style.display = 'none';
  updateTagDatalist();  // 填入標籌記憶
  document.getElementById('note-modal').classList.add('active');
}

function openEditModal(noteId) {
  const note = allNotes.find(n => n.id === noteId);
  if (!note) return;

  currentNoteId = noteId;
  pendingImages = [];
  keepImages    = note.images ? [...note.images] : [];

  document.getElementById('modal-title').textContent = '編輯筆記';
  document.getElementById('note-title').value   = note.title  || '';
  document.getElementById('note-tag').value     = note.tag    || '';
  document.getElementById('note-content').value = note.content || '';

  renderPreviewGrid();
  document.getElementById('upload-progress').style.display = 'none';
  updateTagDatalist();  // 填入標籌記憶
  document.getElementById('note-modal').classList.add('active');
}

/** 更新標籌 datalist（從現有筆記取得全部已用標籌） */
function updateTagDatalist() {
  const datalist = document.getElementById('tag-datalist');
  if (!datalist) return;
  const tags = [...new Set(allNotes.map(n => n.tag).filter(Boolean))];
  datalist.innerHTML = tags.map(t => `<option value="${escapeHtml(t)}"></option>`).join('');
}

function closeNoteModal() {
  document.getElementById('note-modal').classList.remove('active');
  pendingImages = [];
  keepImages    = [];
}

function closeModalOutside(event) {
  if (event.target === document.getElementById('note-modal')) closeNoteModal();
}

// ── 圖片上傳 ─────────────────────────────────────────────────
function triggerUpload() {
  document.getElementById('image-input').click();
}

function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('upload-area').classList.add('dragover');
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('upload-area').classList.remove('dragover');
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  addPendingImages(files);
}

function handleImageSelect(e) {
  const files = [...e.target.files];
  addPendingImages(files);
  e.target.value = ''; // reset
}

function addPendingImages(files) {
  const MAX_PER_NOTE = 5;
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  const totalExisting = keepImages.length + pendingImages.length;
  const available = MAX_PER_NOTE - totalExisting;

  if (available <= 0) {
    showToast('每篇筆記最多上傳 5 張圖片', 'error');
    return;
  }

  const toAdd = files.slice(0, available);
  let rejected = 0;

  toAdd.forEach(file => {
    if (file.size > MAX_SIZE) {
      rejected++;
      return;
    }
    pendingImages.push(file);
  });

  if (rejected > 0) showToast(`${rejected} 張圖片超過 10MB 限制已被跳過`, 'error');
  if (files.length > available) showToast(`只能再上傳 ${available} 張圖片`, 'info');

  renderPreviewGrid();
}

function renderPreviewGrid() {
  const grid = document.getElementById('image-preview-grid');
  let html = '';

  // 已存在的圖片（編輯模式）
  keepImages.forEach((url, idx) => {
    html += `
    <div class="preview-item">
      <img src="${url}" alt="圖片">
      <button class="preview-remove" onclick="removeKeepImage(${idx})">✕</button>
    </div>`;
  });

  // 待上傳的圖片（本機預覽）
  pendingImages.forEach((file, idx) => {
    const objUrl = URL.createObjectURL(file);
    html += `
    <div class="preview-item">
      <img src="${objUrl}" alt="預覽">
      <button class="preview-remove" onclick="removePendingImage(${idx})">✕</button>
    </div>`;
  });

  grid.innerHTML = html;

  // 顯示上傳提示
  const placeholder = document.getElementById('upload-placeholder');
  const total = keepImages.length + pendingImages.length;
  placeholder.style.display = total === 0 ? 'flex' : 'none';
}

function removeKeepImage(idx) {
  keepImages.splice(idx, 1);
  renderPreviewGrid();
}

function removePendingImage(idx) {
  pendingImages.splice(idx, 1);
  renderPreviewGrid();
}

/** 儲存筆記（新增或更新） */
async function saveNote() {
  const title   = document.getElementById('note-title').value.trim();
  const tag     = document.getElementById('note-tag').value.trim();
  const content = document.getElementById('note-content').value.trim();

  if (!title) {
    showToast('請輸入標題', 'error');
    document.getElementById('note-title').focus();
    return;
  }

  const btn = document.getElementById('btn-save-note');
  setButtonLoading(btn, true);

  try {
    // 1. 上傳新圖片到 Storage
    let uploadedUrls = [];
    if (pendingImages.length > 0) {
      uploadedUrls = await uploadImages(pendingImages, currentNoteId);
    }

    // 2. 合併圖片列表
    const allImages = [...keepImages, ...uploadedUrls];

    // 3. 儲存到 Firestore
    const data = { title, tag, content, images: allImages };
    if (currentNoteId) {
      await updateNote(currentNoteId, data);
      showToast('筆記已更新 ✓', 'success');
    } else {
      await addNote(data);
      showToast('筆記已儲存 ✓', 'success');
    }

    closeNoteModal();
  } catch (err) {
    console.error('Save note error:', err);
    showToast('儲存失敗：' + err.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

/** 上傳圖片到 Firebase Storage */
async function uploadImages(files, noteId) {
  const progressBar  = document.getElementById('upload-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');

  progressBar.style.display = 'flex';
  progressFill.style.width  = '0%';

  const urls = [];
  const total = files.length;

  for (let i = 0; i < total; i++) {
    const file = files[i];
    const path = `memos/${currentUser.uid}/notes/${Date.now()}_${i}_${file.name}`;
    const ref  = storage.ref(path);

    progressText.textContent = `上傳中 ${i + 1}/${total}...`;

    await new Promise((resolve, reject) => {
      const task = ref.put(file);
      task.on('state_changed',
        snap => {
          const pct = (i / total + (snap.bytesTransferred / snap.totalBytes) / total) * 100;
          progressFill.style.width = pct + '%';
        },
        reject,
        async () => {
          const url = await ref.getDownloadURL();
          urls.push(url);
          progressFill.style.width = ((i + 1) / total * 100) + '%';
          resolve();
        }
      );
    });
  }

  progressText.textContent = '上傳完成！';
  setTimeout(() => { progressBar.style.display = 'none'; }, 1000);

  return urls;
}

// ============================================================
// DETAIL MODAL
// ============================================================
function openDetail(noteId) {
  const note = allNotes.find(n => n.id === noteId);
  if (!note) return;

  currentNoteId = noteId;

  document.getElementById('detail-title').textContent = note.title || '無標題';

  const tagEl = document.getElementById('detail-tag');
  tagEl.textContent = note.tag || '';
  tagEl.style.display = note.tag ? 'inline-block' : 'none';

  document.getElementById('detail-content').textContent = note.content || '（無內容）';

  // 圖片
  const imgsEl = document.getElementById('detail-images');
  if (note.images && note.images.length > 0) {
    imgsEl.innerHTML = note.images.map(url =>
      `<img class="detail-img" src="${url}" alt="圖片" onclick="openImageLightbox('${url}')" loading="lazy">`
    ).join('');
  } else {
    imgsEl.innerHTML = '';
  }

  // Meta
  const created = note.createdAt ? formatDate(note.createdAt.toDate()) : '未知';
  const updated = note.updatedAt ? formatDate(note.updatedAt.toDate()) : '未知';
  document.getElementById('detail-meta').textContent = `建立：${created}　最後更新：${updated}`;

  document.getElementById('detail-modal').classList.add('active');
}

function closeDetailModal() {
  document.getElementById('detail-modal').classList.remove('active');
  currentNoteId = null;
}

function closeDetailOutside(event) {
  if (event.target === document.getElementById('detail-modal')) closeDetailModal();
}

function editCurrentNote() {
  const id = currentNoteId;
  closeDetailModal();
  openEditModal(id);
}

function deleteCurrentNote() {
  askDelete(currentNoteId);
}

// ── 圖片燈箱（簡易） ─────────────────────────────────────────
function openImageLightbox(url) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.9);
    display:flex;align-items:center;justify-content:center;cursor:pointer;`;
  const img = document.createElement('img');
  img.src = url;
  img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:12px;object-fit:contain;';
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// ============================================================
// DELETE
// ============================================================
let pendingDeleteId = null;

function askDelete(noteId) {
  pendingDeleteId = noteId;
  document.getElementById('confirm-modal').classList.add('active');
}

function closeConfirmModal() {
  pendingDeleteId = null;
  document.getElementById('confirm-modal').classList.remove('active');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;

  const btn = document.getElementById('btn-confirm-delete');
  btn.disabled = true;
  btn.textContent = '刪除中...';

  try {
    await deleteNote(pendingDeleteId);
    showToast('筆記已刪除', 'success');
    closeConfirmModal();
    closeDetailModal();
  } catch (err) {
    showToast('刪除失敗：' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '確認刪除';
  }
}

// ============================================================
// SEARCH & FILTER
// ============================================================
function handleSearch() {
  searchQuery = document.getElementById('search-input').value.trim();
  document.getElementById('search-clear').style.display = searchQuery ? 'inline-block' : 'none';
  renderNotes();
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  searchQuery = '';
  document.getElementById('search-clear').style.display = 'none';
  renderNotes();
}

function filterByTag(tag) {
  currentFilter = tag;
  updateFilterTags();
  renderNotes();
}

function handleSort() {
  currentSort = document.getElementById('sort-select').value;
  renderNotes();
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', info: '💡' };
  toast.innerHTML = `<span>${icons[type] || '💡'}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'none';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px) scale(0.95)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============================================================
// BUTTON LOADING STATE
// ============================================================
function setButtonLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  btn.classList.toggle('loading', loading);
}

// ============================================================
// UTILITIES
// ============================================================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(date) {
  if (!(date instanceof Date)) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${d} ${hh}:${mm}`;
}
