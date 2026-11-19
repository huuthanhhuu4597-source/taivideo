document.addEventListener('DOMContentLoaded', () => {
const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:4000' : '';

  const input = document.getElementById('videoUrlInput');
  const btnDownload = document.getElementById('btnDownload');
  const btnPaste = document.getElementById('btnPaste');
  const btnClear = document.getElementById('btnClear');
  const inputStatus = document.getElementById('inputStatus');
  const loadingState = document.getElementById('loadingState');
  const resultSection = document.getElementById('resultSection');

  // Preview elements
  const videoThumb = document.getElementById('videoThumb');
  const platformTag = document.getElementById('platformTag');
  const videoTitle = document.getElementById('videoTitle');
  const videoAuthor = document.getElementById('videoAuthor');
  const videoDuration = document.getElementById('videoDuration');
  const downloadOptionsGrid = document.getElementById('downloadOptionsGrid');
  const videoPreviewBox = document.getElementById('videoPreviewBox');
  const inlineVideoPlayer = document.getElementById('inlineVideoPlayer');

  // Nút xóa link
  input.addEventListener('input', () => {
    btnClear.style.display = input.value ? 'block' : 'none';
  });

  btnClear.addEventListener('click', () => {
    input.value = '';
    btnClear.style.display = 'none';
    input.focus();
    showStatus('');
  });

  // Nút Dán Clipboard tiện lợi
  btnPaste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        input.value = text.trim();
        btnClear.style.display = 'block';
        input.focus();
        showStatus('');
      }
    } catch (err) {
      input.focus();
    }
  });

  // Nhấn Enter để tải
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleDownload();
    }
  });

  btnDownload.addEventListener('click', handleDownload);

  async function handleDownload() {
    const url = input.value.trim();
    if (!url) {
      showStatus('Vui lòng dán link video vào ô trước khi bấm tải!', 'error');
      input.focus();
      return;
    }

    showStatus('');
    resultSection.style.display = 'none';
    loadingState.style.display = 'block';
    btnDownload.disabled = true;

    try {
      const res = await fetch(`${API_BASE}/api/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      const json = await res.json();

      if (!json.success) {
        throw new Error(json.message || 'Không thể bóc tách video');
      }

      renderResult(json.data);
    } catch (err) {
      let errMsg = err.message || 'Có lỗi xảy ra khi phân tích video.';
      if (errMsg === 'Failed to fetch' || errMsg.includes('NetworkError') || errMsg.includes('fetch')) {
        errMsg = '⚠️ Không thể kết nối tới máy chủ! Hãy kiểm tra file CHAY_WEB.bat đã được bật chưa (vui lòng giữ cửa sổ lệnh mở trong khi dùng web).';
      }
      showStatus(errMsg, 'error');
    } finally {
      loadingState.style.display = 'none';
      btnDownload.disabled = false;
    }
  }

  function renderResult(data) {
    platformTag.textContent = `${data.platformIcon || '⚡'} ${data.platform || 'Video'}`;
    videoTitle.textContent = data.title || 'Video tải về HD';
    videoAuthor.textContent = `👤 ${data.author || 'Tác giả'}`;
    
    if (data.duration) {
      videoDuration.textContent = `⏱️ ${data.duration}`;
      videoDuration.style.display = 'inline-block';
    } else {
      videoDuration.style.display = 'none';
    }

    if (data.thumbnail) {
      videoThumb.src = data.thumbnail;
      videoThumb.style.display = 'block';
    } else {
      videoThumb.style.display = 'none';
    }

    // Xem trước video trực tiếp nếu có link MP4 và thời lượng không quá lớn (<15 phút) để tránh lag
    const firstMp4 = Array.isArray(data.downloads) ? data.downloads.find(d => d.type === 'mp4' && d.url) : null;
    const isVeryLong = data.duration && (data.duration.includes('Giờ') || data.duration.includes('h'));
    
    if (firstMp4 && inlineVideoPlayer && !isVeryLong) {
      inlineVideoPlayer.src = `${API_BASE}/api/stream-download?url=${encodeURIComponent(firstMp4.url)}`;
      videoPreviewBox.style.display = 'block';
    } else if (videoPreviewBox) {
      videoPreviewBox.style.display = 'none';
      if (inlineVideoPlayer) {
        inlineVideoPlayer.removeAttribute('src');
        inlineVideoPlayer.pause();
      }
    }

    // Render danh sách chất lượng tải
    downloadOptionsGrid.innerHTML = '';

    if (Array.isArray(data.downloads) && data.downloads.length > 0) {
      data.downloads.forEach((item) => {
        const isAudio = item.type === 'mp3' || (item.badge && (item.badge.includes('MP3') || item.badge.includes('Audio') || item.badge.includes('Nhạc')));

        const a = document.createElement('a');
        a.className = isAudio ? 'download-item-btn audio-only-btn' : 'download-item-btn';
        
        // Link tải trực tiếp qua stream tốc độ cao, 1 click là tải thẳng về máy
        const safeTitle = sanitizeFilename(data.title || 'video');
        const filename = `${safeTitle}_${item.quality.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}.${item.type || 'mp4'}`;
        let finalDownloadUrl = '';
        if (item.isDirectAppRoute || (item.url && item.url.startsWith('/api/'))) {
          finalDownloadUrl = `${API_BASE}${item.url}`;
        } else {
          finalDownloadUrl = `${API_BASE}/api/stream-download?url=${encodeURIComponent(item.url)}&filename=${encodeURIComponent(filename)}`;
        }
        a.href = finalDownloadUrl;
        a.target = '_blank';

        const badgeClass = isAudio ? 'item-badge audio' : 'item-badge';
        const videoAudioTag = isAudio 
          ? `<span class="av-tag audio-tag">🎵 Chỉ âm thanh</span>`
          : `<span class="av-tag video-tag">🎬 Video + Tiếng</span>`;

        a.innerHTML = `
          <div class="btn-quality-info">
            ${videoAudioTag}
            <span>${item.quality}</span>
            ${item.badge ? `<span class="${badgeClass}">${item.badge}</span>` : ''}
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            ${item.size ? `<span class="item-size">${item.size}</span>` : ''}
            <span class="download-icon">⬇️</span>
          </div>
        `;

        downloadOptionsGrid.appendChild(a);
      });
    } else {
      downloadOptionsGrid.innerHTML = '<p style="color:#f87171;font-weight:600;">Không tìm thấy độ phân giải tải về phù hợp.</p>';
    }

    resultSection.style.display = 'block';
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showStatus(msg, type = 'info') {
    if (!msg) {
      inputStatus.style.display = 'none';
      return;
    }
    inputStatus.textContent = msg;
    inputStatus.className = `input-status ${type}`;
    inputStatus.style.display = 'block';
  }

  function sanitizeFilename(name) {
    return name.slice(0, 40).replace(/[^a-zA-Z0-9_ -]/g, '').trim() || 'video_hd';
  }

  // =========================================================================
  // XỬ LÝ POPUP ĐIỀU KHOẢN, DMCA & MIỄN TRỪ TRÁCH NHIỆM (LEGAL MODAL)
  // =========================================================================
  const legalModal = document.getElementById('legalModal');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const btnAgreeModal = document.getElementById('btnAgreeModal');
  const modalTabs = document.querySelectorAll('.modal-tab');
  const footerLinkBtns = document.querySelectorAll('.footer-link-btn');

  function openLegalModal(tabKey = 'disclaimer') {
    switchTab(tabKey);
    legalModal.style.display = 'flex';
  }

  function closeLegalModal() {
    legalModal.style.display = 'none';
  }

  function switchTab(tabKey) {
    modalTabs.forEach(t => {
      if (t.dataset.tab === tabKey) {
        t.classList.add('active');
      } else {
        t.classList.remove('active');
      }
    });

    const panes = ['disclaimer', 'terms', 'dmca', 'privacy'];
    panes.forEach(p => {
      const el = document.getElementById(`pane-${p}`);
      if (el) {
        el.style.display = p === tabKey ? 'block' : 'none';
      }
    });
  }

  // Sự kiện bấm vào các link chân trang
  footerLinkBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.legal || 'disclaimer';
      openLegalModal(tab);
    });
  });

  // Sự kiện chuyển tab trong modal
  modalTabs.forEach(t => {
    t.addEventListener('click', () => {
      switchTab(t.dataset.tab);
    });
  });

  // Đóng modal
  if (btnCloseModal) btnCloseModal.addEventListener('click', closeLegalModal);
  if (btnAgreeModal) btnAgreeModal.addEventListener('click', closeLegalModal);

  // Đóng khi click ngoài nền đen
  if (legalModal) {
    legalModal.addEventListener('click', (e) => {
      if (e.target === legalModal) closeLegalModal();
    });
  }

  // =========================================================================
  // XỬ LÝ ACCORDION CÂU HỎI THƯỜNG GẶP (FAQ)
  // =========================================================================
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const questionBtn = item.querySelector('.faq-question');
    if (questionBtn) {
      questionBtn.addEventListener('click', () => {
        const isActive = item.classList.contains('active');
        faqItems.forEach(i => i.classList.remove('active'));
        if (!isActive) {
          item.classList.add('active');
        }
      });
    }
  });

  // Đóng bằng phím ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && legalModal && legalModal.style.display === 'flex') {
      closeLegalModal();
    }
  });
});
