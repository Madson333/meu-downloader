import type { CookieSource, DownloadStatus, DownloadView, Quality, StreamSelection } from '../shared/api';

const api = window.downloader;

/** Looks up an element that index.html is known to contain. */
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado`);
  return el as T;
}
const input = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
const select = (id: string): HTMLSelectElement => $<HTMLSelectElement>(id);
const button = (id: string): HTMLButtonElement => $<HTMLButtonElement>(id);
const dialog = (id: string): HTMLDialogElement => $<HTMLDialogElement>(id);

const STATUS_LABEL: Record<DownloadStatus, string> = {
  downloading: 'Baixando',
  queued: 'Na fila',
  paused: 'Pausado',
  completed: 'Concluído',
  error: 'Erro',
};

const QUALITY_LABEL: Record<Quality, string> = {
  best: 'melhor qualidade', 2160: 'até 4K', 1440: 'até 1440p', 1080: 'até 1080p',
  720: 'até 720p', 480: 'até 480p', 360: 'até 360p', audio: 'só áudio (MP3)',
};

type Filter = 'all' | 'active' | 'queued' | 'paused' | 'completed' | 'error';

const FILTERS: Record<Filter, (d: DownloadView) => boolean> = {
  all: () => true,
  active: (d) => d.status === 'downloading',
  queued: (d) => d.status === 'queued',
  paused: (d) => d.status === 'paused',
  completed: (d) => d.status === 'completed',
  error: (d) => d.status === 'error',
};

const isFilter = (value: string | undefined): value is Filter => value !== undefined && value in FILTERS;

let downloads: DownloadView[] = [];
let filter: Filter = 'all';
let query = '';
let selected = new Set<string>();
let anchorId: string | null = null;
const rowById = new Map<string, HTMLTableRowElement>();

function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 || n >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function extensionOf(name: string | null | undefined): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name ?? '');
  return match?.[1] ?? '?';
}

function qualityLabel(quality: Quality | null): string {
  return quality ? QUALITY_LABEL[quality] ?? quality : '';
}

function visible(): DownloadView[] {
  const q = query.toLowerCase();
  return downloads
    .filter(FILTERS[filter])
    .filter((d) => !q || (d.fileName ?? '').toLowerCase().includes(q) || d.url.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Looks up a cell that createRow put in the row. */
function cell(tr: HTMLTableRowElement, selector: string): HTMLElement {
  const el = tr.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Célula ${selector} não encontrada`);
  return el;
}

function createRow(d: DownloadView): HTMLTableRowElement {
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

/** Percent done: by bytes, or by segments while a stream's size is still unknown. */
function progressOf(d: DownloadView): number | null {
  if (d.totalSize) return Math.min(100, (d.downloaded / d.totalSize) * 100);
  if (d.chunks?.total) return Math.min(100, (d.chunks.done / d.chunks.total) * 100);
  return null;
}

function kindBadge(d: DownloadView, fileExt: string): string {
  if (d.status === 'completed' && fileExt !== '?') return fileExt;
  if (d.kind === 'video') return 'vídeo';
  if (d.kind === 'stream') return d.protocol ? d.protocol.toUpperCase() : 'stream';
  return fileExt;
}

function updateRow(tr: HTMLTableRowElement, d: DownloadView): void {
  const pct = progressOf(d);
  const ext = cell(tr, '.ext');
  const fileExt = extensionOf(d.fileName);
  ext.textContent = kindBadge(d, fileExt);
  ext.classList.toggle('video', d.kind === 'video' || d.kind === 'stream');
  cell(tr, '.file-name').textContent = d.fileName ?? '';
  tr.title = d.url;
  cell(tr, '.size').textContent = d.totalSize
    ? `${d.sizeEstimated ? '~' : ''}${formatBytes(d.totalSize)}`
    : formatBytes(d.downloaded);
  const fill = cell(tr, '.fill');
  fill.className = 'fill' + (d.status === 'completed' ? ' done' : d.status === 'paused' || d.status === 'queued'
    ? ' paused' : d.status === 'error' ? ' error' : '');
  if (pct === null && d.status === 'downloading') fill.classList.add('indeterminate');
  fill.style.width = `${d.status === 'completed' ? 100 : pct ?? 0}%`;
  cell(tr, '.pct').textContent = d.status === 'completed' ? '100%' : pct === null ? '' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  cell(tr, '.speed').textContent = d.status === 'downloading' ? `${formatBytes(d.speed)}/s` : '';
  cell(tr, '.eta').textContent = d.status === 'downloading' ? formatDuration(d.eta) : '';
  const status = cell(tr, '.status');
  status.className = `status ${d.status}`;
  status.textContent = d.phase ?? STATUS_LABEL[d.status] ?? d.status;
  status.title = d.error ?? '';
  tr.classList.toggle('selected', selected.has(d.id));
}

function render(): void {
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
  for (const key of Object.keys(FILTERS) as Filter[]) {
    const n = downloads.filter(FILTERS[key]).length;
    const counter = document.querySelector(`[data-count="${key}"]`);
    if (counter) counter.textContent = n ? String(n) : '';
  }
  const totalSpeed = downloads.reduce((sum, d) => sum + (d.status === 'downloading' ? d.speed : 0), 0);
  $('total-speed').textContent = `${formatBytes(totalSpeed)}/s`;
  updateButtons();
  renderDetails();
}

function selectedDownloads(): DownloadView[] {
  return downloads.filter((d) => selected.has(d.id));
}

function updateButtons(): void {
  const sel = selectedDownloads();
  button('btn-resume').disabled = !sel.some((d) => d.status === 'paused' || d.status === 'error');
  button('btn-pause').disabled = !sel.some((d) => d.status === 'downloading' || d.status === 'queued');
  button('btn-remove').disabled = sel.length === 0;
}

function renderDetails(): void {
  const sel = selectedDownloads();
  const panel = $('details');
  const [d] = sel;
  if (!d || sel.length !== 1) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  $('d-name').textContent = d.fileName;
  $('d-url').textContent = d.url;
  $('d-done').textContent = d.totalSize
    ? `${formatBytes(d.downloaded)} de ${formatBytes(d.totalSize)}`
    : formatBytes(d.downloaded);
  $('d-conns').textContent = d.status === 'downloading' ? String(d.connections) : '—';
  $('d-segs').textContent = d.chunks?.total ? `${d.chunks.done} de ${d.chunks.total}` : String(d.segments.length || '—');
  $('d-tracks-row').hidden = d.kind !== 'stream' || !d.selection;
  $('d-tracks').textContent = describeTracks(d.selection);
  $('d-notices').textContent = d.notices.join(' · ');
  if (d.kind === 'video') {
    $('d-kind-label').textContent = 'Tipo';
    $('d-resumable').textContent = `Vídeo (yt-dlp) · ${qualityLabel(d.quality)}`;
  } else if (d.kind === 'stream') {
    $('d-kind-label').textContent = 'Tipo';
    $('d-resumable').textContent = `Stream ${d.protocol ? d.protocol.toUpperCase() : 'HLS/DASH'} · ${qualityLabel(d.quality)}`;
  } else {
    $('d-kind-label').textContent = 'Retomável';
    $('d-resumable').textContent = d.status === 'queued' && !d.segments.length ? '—' : d.resumable ? 'Sim' : 'Não';
  }
  $('d-path').textContent = d.filePath ?? d.dir;
  $('d-error').textContent = d.error ? `Erro: ${d.error}` : '';
  button('d-open').disabled = d.status !== 'completed';
  drawSegmentMap(d);
}

function describeTracks(selection: StreamSelection | null): string {
  if (!selection) return '';
  const parts: string[] = [];
  if (selection.video) parts.push(`vídeo ${selection.video}`);
  if (selection.audio) parts.push(`áudio ${selection.audio}`);
  if (selection.subtitles?.length) parts.push(`legendas: ${selection.subtitles.join(', ')}`);
  return parts.join(' — ');
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Draws each segment: downloaded part solid, active connections highlighted. */
function drawSegmentMap(d: DownloadView): void {
  const canvas = $<HTMLCanvasElement>('d-map');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = cssVar('--track');
  ctx.fillRect(0, 0, width, height);

  const total = d.totalSize;
  if (d.status === 'completed') {
    ctx.fillStyle = cssVar('--ok');
    ctx.fillRect(0, 0, width, height);
    return;
  }
  if (d.chunks?.total) {
    // Streams have no byte map: show the share of finished segments.
    ctx.fillStyle = cssVar('--seg-done');
    ctx.fillRect(0, 0, (d.chunks.done / d.chunks.total) * width, height);
    return;
  }
  if (!total) return;
  const x = (byte: number): number => (byte / total) * width;
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

function onRowClick(event: MouseEvent, id: string): void {
  const ids = visible().map((d) => d.id);
  if (event.shiftKey && anchorId && ids.includes(anchorId)) {
    const [a = 0, b = 0] = [ids.indexOf(anchorId), ids.indexOf(id)].sort((m, n) => m - n);
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

function onRowActivate(id: string): void {
  const d = downloads.find((x) => x.id === id);
  if (!d) return;
  if (d.status === 'completed') void api.openFile(id);
  else if (d.status === 'downloading' || d.status === 'queued') void api.pause([id]);
  else void api.resume([id]);
}

async function openAddDialog(url = ''): Promise<void> {
  const dlg = dialog('dlg-add');
  if (dlg.open) return;
  // Open first; the clipboard and settings only pre-fill fields and must never block the dialog.
  input('add-url').value = url;
  input('add-dir').value = '';
  input('add-name').value = '';
  input('add-paused').checked = false;
  dlg.showModal();
  input('add-url').focus();
  const [settings, clip] = await Promise.allSettled([api.getSettings(), url ? null : api.clipboardUrl()]);
  if (settings.status === 'fulfilled') {
    if (!input('add-dir').value) input('add-dir').value = settings.value.downloadDir;
    select('add-quality').value = settings.value.videoQuality;
    $('add-quality-row').hidden = !settings.value.videoAvailable && !settings.value.ffmpegAvailable;
  }
  if (clip.status === 'fulfilled' && clip.value && !input('add-url').value) {
    input('add-url').value = clip.value;
    input('add-url').select();
  }
}

async function openSettings(): Promise<void> {
  const s = await api.getSettings();
  input('set-dir').value = s.downloadDir;
  input('set-conns').value = String(s.maxConnections);
  input('set-concurrent').value = String(s.maxConcurrent);
  input('set-speed').value = String(s.speedLimitKBps);
  input('set-minsize').value = String(s.minCaptureSizeKB);
  input('set-capture').checked = s.captureEnabled;
  $<HTMLTextAreaElement>('set-exts').value = s.captureExtensions.join(' ');
  select('set-quality').value = s.videoQuality;
  $('set-quality-row').hidden = !s.videoAvailable;
  $('set-cookies-row').hidden = !s.videoAvailable;
  select('set-cookies').value = s.videoCookies;
  input('set-cookies-file').value = s.videoCookiesFile;
  updateCookiesRow();
  $('set-update-status').textContent = '';
  dialog('dlg-settings').showModal();
}

function updateCookiesRow(): void {
  const file = select('set-cookies').value === 'file';
  input('set-cookies-file').hidden = !file;
  button('set-cookies-btn').hidden = !file;
}

function confirmRemove(): void {
  const sel = selectedDownloads();
  const [first] = sel;
  if (!first) return;
  $('remove-text').textContent = sel.length === 1
    ? `Remover "${first.fileName}" da lista?`
    : `Remover ${sel.length} downloads da lista?`;
  input('remove-file').checked = false;
  dialog('dlg-remove').showModal();
}

/** The single selected id, for actions that apply to one download. */
const firstSelected = (): string | undefined => [...selected][0];

function bindEvents(): void {
  $('btn-add').addEventListener('click', () => void openAddDialog());
  $('btn-settings').addEventListener('click', () => void openSettings());
  $('btn-resume').addEventListener('click', () => void api.resume([...selected]));
  $('btn-pause').addEventListener('click', () => void api.pause([...selected]));
  $('btn-remove').addEventListener('click', confirmRemove);
  $('btn-resume-all').addEventListener('click', () => void api.resumeAll());
  $('btn-pause-all').addEventListener('click', () => void api.pauseAll());
  $('d-open').addEventListener('click', () => {
    const id = firstSelected();
    if (id) void api.openFile(id);
  });
  $('d-folder').addEventListener('click', () => {
    const id = firstSelected();
    if (id) void api.showInFolder(id);
  });
  $('d-copy').addEventListener('click', () => {
    const id = firstSelected();
    if (id) void api.copyUrl(id);
  });

  input('search').addEventListener('input', () => {
    query = input('search').value.trim();
    render();
  });
  for (const filterButton of document.querySelectorAll<HTMLButtonElement>('.filter')) {
    filterButton.addEventListener('click', () => {
      const next = filterButton.dataset.filter;
      if (!isFilter(next)) return;
      filter = next;
      document.querySelectorAll('.filter').forEach((b) => b.classList.toggle('active', b === filterButton));
      render();
    });
  }

  $('add-dir-btn').addEventListener('click', async () => {
    const dir = await api.chooseFolder(input('add-dir').value);
    if (dir) input('add-dir').value = dir;
  });
  $('set-dir-btn').addEventListener('click', async () => {
    const dir = await api.chooseFolder(input('set-dir').value);
    if (dir) input('set-dir').value = dir;
  });

  select('set-cookies').addEventListener('change', updateCookiesRow);
  $('set-cookies-btn').addEventListener('click', async () => {
    const file = await api.chooseCookiesFile();
    if (file) input('set-cookies-file').value = file;
  });

  $('set-update-ytdlp').addEventListener('click', async () => {
    const updateButton = button('set-update-ytdlp');
    updateButton.disabled = true;
    $('set-update-status').textContent = 'Atualizando…';
    try {
      const output = await api.updateVideoTool();
      $('set-update-status').textContent = output.split(/\r?\n/).filter(Boolean).pop() ?? '';
    } finally {
      updateButton.disabled = false;
    }
  });

  dialog('dlg-add').addEventListener('close', async () => {
    if (dialog('dlg-add').returnValue !== 'ok') return;
    try {
      const id = await api.add({
        url: input('add-url').value.trim(),
        fileName: input('add-name').value.trim() || null,
        dir: input('add-dir').value,
        startPaused: input('add-paused').checked,
        quality: select('add-quality').value,
      });
      selected = new Set([id]);
      anchorId = id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alert(`Não foi possível adicionar: ${message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    }
  });

  dialog('dlg-settings').addEventListener('close', () => {
    if (dialog('dlg-settings').returnValue !== 'ok') return;
    void api.updateSettings({
      downloadDir: input('set-dir').value,
      maxConnections: Number(input('set-conns').value),
      maxConcurrent: Number(input('set-concurrent').value),
      speedLimitKBps: Number(input('set-speed').value),
      minCaptureSizeKB: Number(input('set-minsize').value),
      captureEnabled: input('set-capture').checked,
      captureExtensions: $<HTMLTextAreaElement>('set-exts').value.split(/[\s,;]+/),
      // The main process validates both values.
      videoQuality: select('set-quality').value as Quality,
      videoCookies: select('set-cookies').value as CookieSource,
      videoCookiesFile: input('set-cookies-file').value,
    });
  });

  dialog('dlg-remove').addEventListener('close', async () => {
    if (dialog('dlg-remove').returnValue !== 'ok') return;
    const ids = [...selected];
    selected.clear();
    await api.remove(ids, input('remove-file').checked);
  });

  document.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]')) return;
    if (event.target instanceof Element && event.target.matches('input, textarea')) return;
    if (event.key === 'Delete') confirmRemove();
    else if (event.ctrlKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      void openAddDialog();
    } else if (event.ctrlKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selected = new Set(visible().map((d) => d.id));
      render();
    } else if (event.key === 'Enter' && selected.size === 1) {
      const id = firstSelected();
      if (id) onRowActivate(id);
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
    const data = event.dataTransfer;
    const text = data ? data.getData('text/uri-list') || data.getData('text/plain') : '';
    const url = text.split(/\r?\n/).find((line) => /^https?:\/\//i.test(line.trim()));
    if (url) void openAddDialog(url.trim());
  });

  window.addEventListener('resize', renderDetails);
}

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  console.error('Erro não tratado:', reason instanceof Error ? reason.message : reason);
});

async function init(): Promise<void> {
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

void init();
