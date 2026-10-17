'use strict';

const api = window.downloader;
const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  downloading: 'Baixando',
  queued: 'Na fila',
  paused: 'Pausado',
  completed: 'Concluído',
  error: 'Erro',
};

const QUALITY_LABEL = {
  best: 'melhor qualidade', 2160: 'até 4K', 1440: 'até 1440p', 1080: 'até 1080p',
  720: 'até 720p', 480: 'até 480p', 360: 'até 360p', audio: 'só áudio (MP3)',
};

const FILTERS = {
  all: () => true,
  active: (d) => d.status === 'downloading',
  queued: (d) => d.status === 'queued',
  paused: (d) => d.status === 'paused',
  completed: (d) => d.status === 'completed',
  error: (d) => d.status === 'error',
};

let downloads = [];
let filter = 'all';
let query = '';
let selected = new Set();
let anchorId = null;
const rowById = new Map();

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 || n >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name ?? '');
  return match ? match[1] : '?';
}

function visible() {
  const q = query.toLowerCase();
  return downloads
    .filter(FILTERS[filter])
    .filter((d) => !q || d.fileName.toLowerCase().includes(q) || d.url.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function createRow(d) {
  const tr = document.createElement('tr');
  tr.dataset.id = d.id;
  tr.innerHTML = `
    <td><div class="file"><span class="ext"></span><span class="file-name"></span></div></td>
    <td class="size"></td>
    <td><div class="bar"><div class="track"><div class="fill"></div></div><span class="pct"></span></div></td>
    <td class="speed"></td>
    <td class="eta"></td>
    <td><span class="status"></span></td>`;
  tr.addEventListener('click', (event) => onRowClick(event, d.id));
  tr.addEventListener('dblclick', () => onRowActivate(d.id));
  return tr;
}

function updateRow(tr, d) {
  const pct = d.totalSize ? Math.min(100, (d.downloaded / d.totalSize) * 100) : null;
  const ext = tr.querySelector('.ext');
  const fileExt = extensionOf(d.fileName);
  ext.textContent = d.kind === 'video' && (fileExt === '?' || d.status !== 'completed') ? 'vídeo' : fileExt;
  ext.classList.toggle('video', d.kind === 'video');
  tr.querySelector('.file-name').textContent = d.fileName;
  tr.title = d.url;
  tr.querySelector('.size').textContent = d.totalSize ? formatBytes(d.totalSize) : formatBytes(d.downloaded);
  const fill = tr.querySelector('.fill');
  fill.className = 'fill' + (d.status === 'completed' ? ' done' : d.status === 'paused' || d.status === 'queued'
    ? ' paused' : d.status === 'error' ? ' error' : '');
  if (pct === null && d.status === 'downloading') fill.classList.add('indeterminate');
  fill.style.width = `${d.status === 'completed' ? 100 : pct ?? 0}%`;
  tr.querySelector('.pct').textContent = d.status === 'completed' ? '100%' : pct === null ? '' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  tr.querySelector('.speed').textContent = d.status === 'downloading' ? `${formatBytes(d.speed)}/s` : '';
  tr.querySelector('.eta').textContent = d.status === 'downloading' ? formatDuration(d.eta) : '';
  const status = tr.querySelector('.status');
  status.className = `status ${d.status}`;
  status.textContent = d.phase ?? STATUS_LABEL[d.status] ?? d.status;
  status.title = d.error ?? '';
  tr.classList.toggle('selected', selected.has(d.id));
}

function render() {
  const rows = $('rows');
  const list = visible();
  const keep = new Set(list.map((d) => d.id));
  for (const [id, tr] of rowById) {
    if (!keep.has(id)) {
      tr.remove();
      rowById.delete(id);
    }
  }
  list.forEach((d, index) => {
    let tr = rowById.get(d.id);
    if (!tr) {
      tr = createRow(d);
      rowById.set(d.id, tr);
    }
    updateRow(tr, d);
    if (rows.children[index] !== tr) rows.insertBefore(tr, rows.children[index] ?? null);
  });

  $('empty').style.display = downloads.length ? 'none' : '';
  for (const key of Object.keys(FILTERS)) {
    const n = downloads.filter(FILTERS[key]).length;
    document.querySelector(`[data-count="${key}"]`).textContent = n || '';
  }
  const totalSpeed = downloads.reduce((sum, d) => sum + (d.status === 'downloading' ? d.speed : 0), 0);
  $('total-speed').textContent = `${formatBytes(totalSpeed)}/s`;
  updateButtons();
  renderDetails();
}

function selectedDownloads() {
  return downloads.filter((d) => selected.has(d.id));
}

function updateButtons() {
  const sel = selectedDownloads();
  $('btn-resume').disabled = !sel.some((d) => d.status === 'paused' || d.status === 'error');
  $('btn-pause').disabled = !sel.some((d) => d.status === 'downloading' || d.status === 'queued');
  $('btn-remove').disabled = sel.length === 0;
}

function renderDetails() {
  const sel = selectedDownloads();
  const panel = $('details');
  if (sel.length !== 1) {
    panel.classList.add('hidden');
    return;
  }
  const d = sel[0];
  panel.classList.remove('hidden');
  $('d-name').textContent = d.fileName;
  $('d-url').textContent = d.url;
  $('d-done').textContent = d.totalSize
    ? `${formatBytes(d.downloaded)} de ${formatBytes(d.totalSize)}`
    : formatBytes(d.downloaded);
  $('d-conns').textContent = d.status === 'downloading' ? String(d.connections) : '—';
  $('d-segs').textContent = String(d.segments.length || '—');
  if (d.kind === 'video') {
    $('d-kind-label').textContent = 'Tipo';
    $('d-resumable').textContent = `Vídeo (yt-dlp) · ${QUALITY_LABEL[d.quality] ?? d.quality}`;
  } else {
    $('d-kind-label').textContent = 'Retomável';
    $('d-resumable').textContent = d.status === 'queued' && !d.segments.length ? '—' : d.resumable ? 'Sim' : 'Não';
  }
  $('d-path').textContent = d.filePath ?? d.dir;
  $('d-error').textContent = d.error ? `Erro: ${d.error}` : '';
  $('d-open').disabled = d.status !== 'completed';
  drawSegmentMap(d);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Draws each segment: downloaded part solid, active connections highlighted. */
function drawSegmentMap(d) {
  const canvas = $('d-map');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.fillStyle = cssVar('--track');
  ctx.fillRect(0, 0, width, height);

  const total = d.totalSize;
  if (d.status === 'completed') {
    ctx.fillStyle = cssVar('--ok');
    ctx.fillRect(0, 0, width, height);
    return;
  }
  if (!total) return;
  const x = (byte) => (byte / total) * width;
  for (const s of d.segments) {
    ctx.fillStyle = cssVar('--seg-done');
    ctx.fillRect(x(s.start), 0, Math.max(0, x(s.pos) - x(s.start)), height);
    if (s.active) {
      ctx.fillStyle = cssVar('--seg-active');
      ctx.fillRect(Math.max(0, x(s.pos) - 2), 0, 3, height);
    }
    ctx.fillStyle = cssVar('--panel');
    if (s.start > 0) ctx.fillRect(x(s.start), 0, 1, height);
  }
}

function onRowClick(event, id) {
  const ids = visible().map((d) => d.id);
  if (event.shiftKey && anchorId && ids.includes(anchorId)) {
    const [a, b] = [ids.indexOf(anchorId), ids.indexOf(id)].sort((m, n) => m - n);
    selected = new Set(ids.slice(a, b + 1));
  } else if (event.ctrlKey || event.metaKey) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchorId = id;
  } else {
    selected = new Set([id]);
    anchorId = id;
  }
  render();
}

function onRowActivate(id) {
  const d = downloads.find((x) => x.id === id);
  if (!d) return;
  if (d.status === 'completed') api.openFile(id);
  else if (d.status === 'downloading' || d.status === 'queued') api.pause([id]);
  else api.resume([id]);
}

async function openAddDialog(url = '') {
  const dialog = $('dlg-add');
  if (dialog.open) return;
  // Open first; the clipboard and settings only pre-fill fields and must never block the dialog.
  $('add-url').value = url;
  $('add-dir').value = '';
  $('add-name').value = '';
  $('add-paused').checked = false;
  dialog.showModal();
  $('add-url').focus();
  const [settings, clip] = await Promise.allSettled([api.getSettings(), url ? null : api.clipboardUrl()]);
  if (settings.status === 'fulfilled') {
    if (!$('add-dir').value) $('add-dir').value = settings.value.downloadDir;
    $('add-quality').value = settings.value.videoQuality;
    $('add-quality-row').hidden = !settings.value.videoAvailable;
  }
  if (clip.status === 'fulfilled' && clip.value && !$('add-url').value) {
    $('add-url').value = clip.value;
    $('add-url').select();
  }
}

async function openSettings() {
  const s = await api.getSettings();
  $('set-dir').value = s.downloadDir;
  $('set-conns').value = s.maxConnections;
  $('set-concurrent').value = s.maxConcurrent;
  $('set-speed').value = s.speedLimitKBps;
  $('set-minsize').value = s.minCaptureSizeKB;
  $('set-capture').checked = s.captureEnabled;
  $('set-exts').value = s.captureExtensions.join(' ');
  $('set-quality').value = s.videoQuality;
  $('set-quality-row').hidden = !s.videoAvailable;
  $('set-update-status').textContent = '';
  $('dlg-settings').showModal();
}

function confirmRemove() {
  const sel = selectedDownloads();
  if (!sel.length) return;
  $('remove-text').textContent = sel.length === 1
    ? `Remover "${sel[0].fileName}" da lista?`
    : `Remover ${sel.length} downloads da lista?`;
  $('remove-file').checked = false;
  $('dlg-remove').showModal();
}

function bindEvents() {
  $('btn-add').addEventListener('click', () => openAddDialog());
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-resume').addEventListener('click', () => api.resume([...selected]));
  $('btn-pause').addEventListener('click', () => api.pause([...selected]));
  $('btn-remove').addEventListener('click', confirmRemove);
  $('btn-resume-all').addEventListener('click', () => api.resumeAll());
  $('btn-pause-all').addEventListener('click', () => api.pauseAll());
  $('d-open').addEventListener('click', () => api.openFile([...selected][0]));
  $('d-folder').addEventListener('click', () => api.showInFolder([...selected][0]));
  $('d-copy').addEventListener('click', () => api.copyUrl([...selected][0]));

  $('search').addEventListener('input', (event) => {
    query = event.target.value.trim();
    render();
  });
  for (const button of document.querySelectorAll('.filter')) {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      document.querySelectorAll('.filter').forEach((b) => b.classList.toggle('active', b === button));
      render();
    });
  }

  $('add-dir-btn').addEventListener('click', async () => {
    const dir = await api.chooseFolder($('add-dir').value);
    if (dir) $('add-dir').value = dir;
  });
  $('set-dir-btn').addEventListener('click', async () => {
    const dir = await api.chooseFolder($('set-dir').value);
    if (dir) $('set-dir').value = dir;
  });

  $('set-update-ytdlp').addEventListener('click', async () => {
    const button = $('set-update-ytdlp');
    button.disabled = true;
    $('set-update-status').textContent = 'Atualizando…';
    try {
      const output = await api.updateVideoTool();
      $('set-update-status').textContent = output.split(/\r?\n/).filter(Boolean).pop() ?? '';
    } finally {
      button.disabled = false;
    }
  });

  $('dlg-add').addEventListener('close', async () => {
    if ($('dlg-add').returnValue !== 'ok') return;
    try {
      const id = await api.add({
        url: $('add-url').value.trim(),
        fileName: $('add-name').value.trim() || null,
        dir: $('add-dir').value,
        startPaused: $('add-paused').checked,
        quality: $('add-quality').value,
      });
      selected = new Set([id]);
      anchorId = id;
    } catch (err) {
      alert(`Não foi possível adicionar: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    }
  });

  $('dlg-settings').addEventListener('close', () => {
    if ($('dlg-settings').returnValue !== 'ok') return;
    api.updateSettings({
      downloadDir: $('set-dir').value,
      maxConnections: Number($('set-conns').value),
      maxConcurrent: Number($('set-concurrent').value),
      speedLimitKBps: Number($('set-speed').value),
      minCaptureSizeKB: Number($('set-minsize').value),
      captureEnabled: $('set-capture').checked,
      captureExtensions: $('set-exts').value.split(/[\s,;]+/),
      videoQuality: $('set-quality').value,
    });
  });

  $('dlg-remove').addEventListener('close', async () => {
    if ($('dlg-remove').returnValue !== 'ok') return;
    const ids = [...selected];
    selected.clear();
    await api.remove(ids, $('remove-file').checked);
  });

  document.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]')) return;
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'Delete') confirmRemove();
    else if (event.ctrlKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openAddDialog();
    } else if (event.ctrlKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selected = new Set(visible().map((d) => d.id));
      render();
    } else if (event.key === 'Enter' && selected.size === 1) {
      onRowActivate([...selected][0]);
    }
  });

  // Dropping a link from the browser opens the add dialog with it.
  document.addEventListener('dragover', (event) => {
    event.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    document.body.classList.remove('dragging');
    const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
    const url = text.split(/\r?\n/).find((line) => /^https?:\/\//i.test(line.trim()));
    if (url) openAddDialog(url.trim());
  });

  window.addEventListener('resize', renderDetails);
}

window.addEventListener('unhandledrejection', (event) => {
  console.error('Erro não tratado:', event.reason?.message ?? event.reason);
});

async function init() {
  bindEvents();
  api.onUpdate((list) => {
    downloads = list;
    const ids = new Set(list.map((d) => d.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    render();
  });
  api.onFocusDownload((id) => {
    selected = new Set([id]);
    anchorId = id;
    render();
  });
  downloads = await api.list();
  render();
}

init();
