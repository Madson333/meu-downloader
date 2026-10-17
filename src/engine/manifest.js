'use strict';

/**
 * Parsers for HLS playlists and static MPEG-DASH manifests, plus quality
 * selection. Pure functions: no network access, so they are easy to test.
 *
 * Protected content (Widevine, PlayReady, FairPlay, CENC, SAMPLE-AES) is
 * rejected with code 'DRM'. Only AES-128 with the standard "identity" key
 * format is accepted: its key is served by the site to every player that is
 * allowed to watch, so it is ordinary transport encryption, not DRM.
 */

class ManifestError extends Error {
  /** code: MANIFEST (malformed), DRM, LIVE, UNSUPPORTED or NOT_A_STREAM. */
  constructor(message, code = 'MANIFEST') {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}

const MAX_SEGMENTS = 200_000;
const MANIFEST_MIME = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/(x-)?mpegurl)\b/i;
const VIDEO_CODEC = /^(avc[13]|hvc1|hev1|dvh[1e]|av01|vp0?9|vp8|mp4v)/i;

function isManifestUrl(url) {
  try {
    return /\.(m3u8|mpd)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isManifestMime(contentType) {
  return MANIFEST_MIME.test(String(contentType ?? '').trim());
}

function resolveUrl(ref, base) {
  let url;
  try {
    url = new URL(ref, base);
  } catch {
    throw new ManifestError(`URL inválida no manifesto: ${ref}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ManifestError(`O manifesto aponta para um endereço não suportado (${url.protocol})`, 'UNSUPPORTED');
  }
  return url.href;
}

/** "WxH" → { width, height } */
function parseResolution(value) {
  const match = /^(\d+)x(\d+)$/i.exec(value ?? '');
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: null, height: null };
}

function hasVideoCodec(codecs) {
  return String(codecs ?? '').split(',').some((c) => VIDEO_CODEC.test(c.trim()));
}

// ---------------------------------------------------------------- HLS

/** Parses an HLS attribute list: KEY=VALUE,KEY="quoted, value" */
function parseAttributes(text) {
  const attrs = {};
  const re = /\s*([A-Z0-9-]+)=("[^"]*"|[^,]*)\s*(,|$)/gy;
  let match;
  while (re.lastIndex < text.length && (match = re.exec(text))) {
    const raw = match[2];
    attrs[match[1]] = raw.startsWith('"') ? raw.slice(1, -1) : raw.trim();
  }
  return attrs;
}

/** "n[@o]" → { length, offset|null } */
function parseByteRange(value) {
  const match = /^(\d+)(?:@(\d+))?$/.exec(String(value ?? '').trim());
  if (!match) throw new ManifestError(`Intervalo de bytes inválido: ${value}`);
  return { length: Number(match[1]), offset: match[2] === undefined ? null : Number(match[2]) };
}

/** Returns the AES-128 key info, null for no encryption, or throws for DRM. */
function checkHlsKey(attrs, baseUrl) {
  const method = String(attrs.METHOD ?? 'NONE').toUpperCase();
  const format = String(attrs.KEYFORMAT ?? 'identity').toLowerCase();
  if (method === 'NONE') return null;
  if (format !== 'identity') {
    throw new ManifestError(
      `Conteúdo protegido por DRM (${attrs.KEYFORMAT}). O Meu Downloader não baixa mídia com DRM.`,
      'DRM',
    );
  }
  if (method === 'AES-128') {
    if (!attrs.URI) throw new ManifestError('Chave AES-128 sem URI no manifesto');
    let iv = null;
    if (attrs.IV) {
      const hex = attrs.IV.replace(/^0x/i, '');
      if (!/^[0-9a-f]{1,32}$/i.test(hex)) throw new ManifestError('IV inválido no manifesto');
      iv = hex.padStart(32, '0').toLowerCase();
    }
    return { method, uri: resolveUrl(attrs.URI, baseUrl), iv };
  }
  if (method.startsWith('SAMPLE-AES')) {
    throw new ManifestError(`Criptografia ${method} não é suportada.`, 'DRM');
  }
  throw new ManifestError(`Método de criptografia desconhecido: ${method}`, 'UNSUPPORTED');
}

function parseHlsMaster(lines, baseUrl) {
  const variants = [];
  const renditions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice(18));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j >= lines.length) throw new ManifestError('Variante HLS sem URI');
      const { width, height } = parseResolution(a.RESOLUTION);
      variants.push({
        uri: resolveUrl(lines[j], baseUrl),
        bandwidth: Number(a.BANDWIDTH) || 0,
        averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) || null,
        width,
        height,
        codecs: a.CODECS ?? null,
        frameRate: Number(a['FRAME-RATE']) || null,
        audio: a.AUDIO ?? null,
        subtitles: a.SUBTITLES ?? null,
        // Without RESOLUTION or a video codec in CODECS, a variant with CODECS is audio only.
        hasVideo: width !== null || !a.CODECS || hasVideoCodec(a.CODECS),
      });
      i = j;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice(13));
      const type = String(a.TYPE ?? '').toUpperCase();
      if (type !== 'AUDIO' && type !== 'SUBTITLES') continue;
      renditions.push({
        type: type === 'AUDIO' ? 'audio' : 'subtitles',
        groupId: a['GROUP-ID'] ?? null,
        name: a.NAME ?? null,
        language: a.LANGUAGE ?? null,
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : null,
        isDefault: String(a.DEFAULT).toUpperCase() === 'YES',
        autoselect: String(a.AUTOSELECT).toUpperCase() === 'YES',
        channels: a.CHANNELS ?? null,
      });
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      checkHlsKey(parseAttributes(line.slice(19)), baseUrl);
    }
  }
  if (!variants.length) throw new ManifestError('Playlist HLS principal sem variantes');
  return { protocol: 'hls', kind: 'master', variants, renditions };
}

function parseHlsMedia(lines, baseUrl) {
  const segments = [];
  let mediaSequence = 0;
  let targetDuration = null;
  let playlistType = null;
  let endList = false;
  let duration = null;
  let byteRange = null;
  let key = null;
  let map = null;
  let discontinuities = 0;
  const mapKeys = new Set();
  const nextOffset = new Map();

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(line.slice(22));
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = Number(line.slice(22)) || 0;
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = line.slice(21).trim().toUpperCase();
    else if (line === '#EXT-X-ENDLIST') endList = true;
    else if (line.startsWith('#EXTINF:')) duration = Number.parseFloat(line.slice(8));
    else if (line.startsWith('#EXT-X-BYTERANGE:')) byteRange = parseByteRange(line.slice(17));
    else if (line.startsWith('#EXT-X-KEY:')) key = checkHlsKey(parseAttributes(line.slice(11)), baseUrl);
    else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) discontinuities++;
    else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      if (!a.URI) throw new ManifestError('EXT-X-MAP sem URI');
      const range = a.BYTERANGE ? parseByteRange(a.BYTERANGE) : null;
      if (range && range.offset === null) range.offset = 0;
      map = { url: resolveUrl(a.URI, baseUrl), range };
      mapKeys.add(`${map.url}|${range?.offset}|${range?.length}`);
    } else if (!line.startsWith('#')) {
      const url = resolveUrl(line, baseUrl);
      let range = null;
      if (byteRange) {
        const offset = byteRange.offset ?? nextOffset.get(url) ?? 0;
        range = { offset, length: byteRange.length };
        nextOffset.set(url, offset + byteRange.length);
      }
      const sequence = mediaSequence + segments.length;
      segments.push({
        url,
        duration: Number.isFinite(duration) ? duration : null,
        range,
        // Without an explicit IV, HLS uses the media sequence number.
        key: key ? { uri: key.uri, iv: key.iv ?? sequence.toString(16).padStart(32, '0') } : null,
      });
      if (segments.length > MAX_SEGMENTS) throw new ManifestError('Playlist com segmentos demais', 'UNSUPPORTED');
      duration = null;
      byteRange = null;
    }
  }

  if (targetDuration === null || Number.isNaN(targetDuration)) {
    throw new ManifestError('Playlist HLS de mídia sem EXT-X-TARGETDURATION');
  }
  if (mapKeys.size > 1) {
    throw new ManifestError('Playlists com vários segmentos de inicialização (EXT-X-MAP) não são suportadas', 'UNSUPPORTED');
  }
  const live = !endList && playlistType !== 'VOD';
  return {
    protocol: 'hls',
    kind: 'media',
    live,
    playlistType,
    targetDuration,
    mediaSequence,
    discontinuities,
    map,
    segments,
    totalDuration: segments.reduce((sum, s) => sum + (s.duration ?? 0), 0),
  };
}

/** Parses an HLS playlist (master or media). baseUrl resolves relative URIs. */
function parseHls(text, baseUrl) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new ManifestError('Playlist HLS inválida: falta #EXTM3U', 'NOT_A_STREAM');
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'))) return parseHlsMaster(lines, baseUrl);
  if (lines.some((l) => l.startsWith('#EXT-X-TARGETDURATION:'))) return parseHlsMedia(lines, baseUrl);
  // Plain M3U lists (e.g. IPTV channel lists) carry #EXTINF but none of the HLS tags.
  throw new ManifestError('O arquivo é uma lista M3U comum, não uma playlist HLS', 'NOT_A_STREAM');
}

// ---------------------------------------------------------------- XML

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[name] ?? match;
  });
}

/**
 * Minimal XML parser for manifests: elements, attributes, text, comments and
 * CDATA. DOCTYPE is refused, so entity expansion attacks cannot happen.
 */
function parseXml(text) {
  const root = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const src = String(text).replace(/^﻿/, '');
  const fail = (what) => {
    throw new ManifestError(`XML malformado: ${what}`);
  };
  const tagName = /[^\s/>=]+/y;
  const attr = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  const tagEnd = /\s*(\/?)>/y;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt === -1) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) fail('comentário sem fim');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) fail('CDATA sem fim');
      top.text += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) fail('instrução sem fim');
      i = end + 2;
    } else if (src.startsWith('<!', lt)) {
      fail('DOCTYPE não é permitido em manifestos');
    } else if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt);
      if (gt < 0) fail('tag de fechamento sem fim');
      const name = src.slice(lt + 2, gt).trim();
      if (stack.length === 1 || top.name !== name) fail(`fechamento inesperado </${name}>`);
      stack.pop();
      i = gt + 1;
    } else {
      tagName.lastIndex = lt + 1;
      const nameMatch = tagName.exec(src);
      if (!nameMatch) fail('nome de elemento ausente');
      const name = nameMatch[0];
      const node = { name, local: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name, attrs: {}, children: [], text: '' };
      let pos = tagName.lastIndex;
      for (;;) {
        attr.lastIndex = pos;
        const a = attr.exec(src);
        if (!a) break;
        node.attrs[a[1]] = decodeEntities(a[2] ?? a[3]);
        pos = attr.lastIndex;
      }
      tagEnd.lastIndex = pos;
      const end = tagEnd.exec(src);
      if (!end) fail(`atributos inválidos em <${name}>`);
      top.children.push(node);
      if (!end[1]) stack.push(node);
      i = tagEnd.lastIndex;
    }
  }
  if (stack.length !== 1) fail(`<${stack[stack.length - 1].name}> não foi fechado`);
  const element = root.children[0];
  if (!element || root.children.length > 1) fail('o documento deve ter um único elemento raiz');
  return element;
}

const childrenOf = (node, local) => (node ? node.children.filter((c) => c.local === local) : []);
const childOf = (node, local) => childrenOf(node, local)[0] ?? null;

function hasDescendant(node, local) {
  return node.children.some((c) => c.local === local || hasDescendant(c, local));
}

// ---------------------------------------------------------------- DASH

/** ISO 8601 duration ("PT1H2M3.5S") in seconds; null if absent or invalid. */
function parseIsoDuration(value) {
  if (!value) return null;
  const n = '(\\d+(?:\\.\\d+)?)';
  const match = new RegExp(`^P(?:${n}Y)?(?:${n}M)?(?:${n}D)?(?:T(?:${n}H)?(?:${n}M)?(?:${n}S)?)?$`).exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map((v) => Number(v ?? 0));
  return y * 31_536_000 + mo * 2_592_000 + d * 86_400 + h * 3600 + mi * 60 + s;
}

/** "start-end" (inclusive) → { offset, length } */
function parseDashRange(value) {
  if (!value) return null;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match || Number(match[2]) < Number(match[1])) throw new ManifestError(`Intervalo de bytes inválido: ${value}`);
  return { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 };
}

function applyBaseUrl(base, node) {
  const el = childOf(node, 'BaseURL');
  return el && el.text.trim() ? resolveUrl(el.text.trim(), base) : base;
}

function expandTemplate(template, values) {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)d)?\$/g, (match, name, width) => {
    if (name === '') return '$';
    const value = values[name];
    if (value === undefined || value === null) throw new ManifestError(`Modelo de URL usa $${name}$ sem valor`);
    const text = String(value);
    return width ? text.padStart(Number(width), '0') : text;
  });
}

/** Merges SegmentTemplate attributes from outer to inner levels; the innermost timeline wins. */
function mergedTemplate(...levels) {
  const nodes = levels.map((n) => childOf(n, 'SegmentTemplate')).filter(Boolean);
  if (!nodes.length) return null;
  const attrs = Object.assign({}, ...nodes.map((n) => n.attrs));
  const timeline = nodes.map((n) => childOf(n, 'SegmentTimeline')).filter(Boolean).pop() ?? null;
  return { attrs, timeline };
}

function templateSegments(template, rep, base, periodDuration) {
  const a = template.attrs;
  const timescale = Number(a.timescale) || 1;
  const startNumber = a.startNumber !== undefined ? Number(a.startNumber) : 1;
  const ids = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const init = a.initialization ? { url: resolveUrl(expandTemplate(a.initialization, ids), base), range: null } : null;
  if (!a.media) throw new ManifestError('SegmentTemplate sem atributo media');
  const segments = [];
  const push = (number, time, duration) => {
    segments.push({
      url: resolveUrl(expandTemplate(a.media, { ...ids, Number: number, Time: time }), base),
      range: null,
      duration: duration / timescale,
    });
    if (segments.length > MAX_SEGMENTS) throw new ManifestError('Manifesto com segmentos demais', 'UNSUPPORTED');
  };

  if (template.timeline) {
    const end = periodDuration !== null ? periodDuration * timescale : null;
    let time = 0;
    let number = startNumber;
    for (const s of childrenOf(template.timeline, 'S')) {
      if (s.attrs.t !== undefined) time = Number(s.attrs.t);
      const d = Number(s.attrs.d);
      if (!(d > 0)) throw new ManifestError('SegmentTimeline com duração inválida');
      let repeat = Number(s.attrs.r ?? 0);
      if (repeat < 0) {
        if (end === null) throw new ManifestError('SegmentTimeline com repetição aberta e duração desconhecida', 'UNSUPPORTED');
        repeat = Math.ceil((end - time) / d) - 1;
      }
      for (let k = 0; k <= repeat; k++) {
        if (!Number.isSafeInteger(time)) throw new ManifestError('Marca de tempo grande demais', 'UNSUPPORTED');
        push(number++, time, d);
        time += d;
      }
    }
  } else {
    const d = Number(a.duration);
    if (!(d > 0)) throw new ManifestError('SegmentTemplate sem duração de segmento');
    if (periodDuration === null) throw new ManifestError('Duração da apresentação desconhecida', 'UNSUPPORTED');
    const count = Math.ceil((periodDuration * timescale) / d - 1e-9);
    for (let k = 0; k < count; k++) push(startNumber + k, k * d, d);
  }
  return { init, segments };
}

function listSegments(list, base) {
  const initEl = childOf(list, 'Initialization');
  const init = initEl
    ? { url: initEl.attrs.sourceURL ? resolveUrl(initEl.attrs.sourceURL, base) : base, range: parseDashRange(initEl.attrs.range) }
    : null;
  const timescale = Number(list.attrs.timescale) || 1;
  const duration = list.attrs.duration ? Number(list.attrs.duration) / timescale : null;
  const segments = childrenOf(list, 'SegmentURL').map((s) => ({
    url: s.attrs.media ? resolveUrl(s.attrs.media, base) : base,
    range: parseDashRange(s.attrs.mediaRange),
    duration,
  }));
  return { init, segments };
}

function contentTypeOf(as, rep) {
  const mime = rep.attrs.mimeType ?? as.attrs.mimeType ?? '';
  const codecs = rep.attrs.codecs ?? as.attrs.codecs ?? '';
  const declared = as.attrs.contentType ?? rep.attrs.contentType ?? mime.split('/')[0];
  if (declared === 'text' || /^(text\/vtt|application\/ttml)/.test(mime) || /^(stpp|wvtt)/.test(codecs)) return 'subtitles';
  if (declared === 'video' || declared === 'audio') return declared;
  return null;
}

/** Parses a static MPEG-DASH manifest. */
function parseDash(text, baseUrl) {
  const mpd = parseXml(text);
  if (mpd.local !== 'MPD') throw new ManifestError('Manifesto DASH inválido: elemento MPD ausente', 'NOT_A_STREAM');
  if ((mpd.attrs.type ?? 'static') === 'dynamic') {
    throw new ManifestError('Transmissões ao vivo (DASH dinâmico) não são suportadas', 'LIVE');
  }
  if (hasDescendant(mpd, 'ContentProtection')) {
    throw new ManifestError('Conteúdo protegido por DRM (ContentProtection). O Meu Downloader não baixa mídia com DRM.', 'DRM');
  }
  const periods = childrenOf(mpd, 'Period');
  if (!periods.length) throw new ManifestError('Manifesto DASH sem Period');
  if (periods.length > 1) {
    throw new ManifestError('Manifestos DASH com vários períodos (por exemplo, com anúncios) não são suportados', 'UNSUPPORTED');
  }
  const period = periods[0];
  const total = parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const periodDuration = parseIsoDuration(period.attrs.duration)
    ?? (total !== null ? total - (parseIsoDuration(period.attrs.start) ?? 0) : null);
  const periodBase = applyBaseUrl(applyBaseUrl(baseUrl, mpd), period);

  const result = { protocol: 'dash', live: false, duration: periodDuration, video: [], audio: [], subtitles: [] };
  childrenOf(period, 'AdaptationSet').forEach((as, adaptationIndex) => {
    const asBase = applyBaseUrl(periodBase, as);
    const role = childOf(as, 'Role')?.attrs.value ?? null;
    const label = childOf(as, 'Label')?.text.trim() || as.attrs.label || null;
    for (const repEl of childrenOf(as, 'Representation')) {
      const type = contentTypeOf(as, repEl);
      if (!type) continue;
      const pick = (name) => repEl.attrs[name] ?? as.attrs[name];
      const rep = {
        id: repEl.attrs.id ?? null,
        bandwidth: Number(repEl.attrs.bandwidth) || 0,
        width: Number(pick('width')) || null,
        height: Number(pick('height')) || null,
        codecs: pick('codecs') ?? null,
        mimeType: pick('mimeType') ?? null,
        language: as.attrs.lang ?? repEl.attrs.lang ?? null,
        label,
        role,
        adaptationIndex,
      };
      const base = applyBaseUrl(asBase, repEl);
      const template = mergedTemplate(period, as, repEl);
      const list = childOf(repEl, 'SegmentList') ?? childOf(as, 'SegmentList');
      let parts;
      if (template) parts = templateSegments(template, rep, base, periodDuration);
      else if (list) parts = listSegments(list, base);
      else {
        // SegmentBase or a bare BaseURL: the whole representation is one
        // self-contained file (its init data is inside), downloaded in one piece.
        if (base === baseUrl) throw new ManifestError(`Representação ${rep.id ?? ''} sem endereço de mídia`);
        parts = { init: null, segments: [{ url: base, range: null, duration: periodDuration }] };
      }
      if (!parts.segments.length) throw new ManifestError(`Representação ${rep.id ?? ''} sem segmentos`);
      rep.init = parts.init;
      rep.segments = parts.segments;
      result[type === 'subtitles' ? 'subtitles' : type].push(rep);
    }
  });
  if (!result.video.length && !result.audio.length) throw new ManifestError('O manifesto DASH não tem faixas de vídeo nem de áudio');
  return result;
}

// ---------------------------------------------------------------- detection

/** Detects HLS or DASH by content, then parses it. */
function parseManifest(text, baseUrl) {
  const head = String(text).replace(/^﻿/, '').trimStart().slice(0, 4096);
  if (head.startsWith('#EXTM3U')) return parseHls(text, baseUrl);
  if (/<(?:[a-z0-9]+:)?MPD[\s/>]/i.test(head)) return parseDash(text, baseUrl);
  throw new ManifestError('O endereço não é uma playlist HLS nem um manifesto DASH', 'NOT_A_STREAM');
}

// ---------------------------------------------------------------- selection

const shortSide = (v) => (v.width && v.height ? Math.min(v.width, v.height) : null);
const isH264 = (v) => (/^avc/i.test(String(v.codecs ?? '')) ? 1 : 0);

function describeVideo(v) {
  const parts = [];
  if (v.width && v.height) parts.push(`${shortSide(v)}p (${v.width}×${v.height})`);
  if (v.bandwidth) parts.push(`${(v.bandwidth / 1e6).toFixed(1)} Mbps`);
  if (v.codecs) parts.push(String(v.codecs).split(',')[0]);
  return parts.join(' · ') || 'qualidade única';
}

/**
 * Picks a video variant for "best" or a height limit ("1080", applied to the
 * smaller side, like the yt-dlp path). Among equal resolutions H.264 wins,
 * then the higher bitrate. When nothing fits under the limit, the smallest
 * variant is used and `notice` explains the substitution.
 */
function selectVideo(variants, quality) {
  if (!variants.length) return { variant: null, notice: null };
  const sorted = [...variants].sort((a, b) => (shortSide(b) ?? 0) - (shortSide(a) ?? 0)
    || isH264(b) - isH264(a)
    || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  if (!/^\d+$/.test(String(quality))) return { variant: sorted[0], notice: null };
  const limit = Number(quality);
  const known = sorted.filter((v) => shortSide(v) !== null);
  if (!known.length) {
    return { variant: sorted[0], notice: `O manifesto não informa resoluções; usada a maior taxa de bits em vez de ${limit}p` };
  }
  const fit = known.find((v) => shortSide(v) <= limit);
  if (fit) {
    const got = shortSide(fit);
    return { variant: fit, notice: got < limit ? `${limit}p não está disponível; usado ${got}p, a maior resolução abaixo` : null };
  }
  const smallest = known[known.length - 1];
  return { variant: smallest, notice: `${limit}p não está disponível; usado ${shortSide(smallest)}p, a menor resolução oferecida` };
}

/** Default audio rendition: DEFAULT=YES, then AUTOSELECT, then the first. */
function pickDefault(renditions) {
  return renditions.find((r) => r.isDefault) ?? renditions.find((r) => r.autoselect) ?? renditions[0] ?? null;
}

/** DASH audio: the "main" adaptation set (or the first), at its highest bitrate. */
function selectDashAudio(reps) {
  return [...reps].sort((a, b) => (b.role === 'main') - (a.role === 'main')
    || a.adaptationIndex - b.adaptationIndex
    || b.bandwidth - a.bandwidth)[0] ?? null;
}

// ---------------------------------------------------------------- MP4 inspection

/**
 * True when an MP4 init segment declares encryption (encv/enca sample entries,
 * or pssh boxes), even if the manifest did not say so. Only the moov box is
 * searched, which holds metadata and no media payload.
 */
function isProtectedMp4(buf) {
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size === 1 && pos + 16 <= buf.length) size = Number(buf.readBigUInt64BE(pos + 8));
    else if (size === 0) size = buf.length - pos;
    if (size < 8) break;
    if (type === 'pssh') return true;
    if (type === 'moov') {
      const moov = buf.toString('latin1', pos, Math.min(buf.length, pos + size));
      return /encv|enca|pssh|sinf/.test(moov);
    }
    pos += size;
  }
  return false;
}

module.exports = {
  ManifestError,
  parseHls,
  parseDash,
  parseManifest,
  parseXml,
  parseAttributes,
  parseIsoDuration,
  expandTemplate,
  selectVideo,
  selectDashAudio,
  pickDefault,
  describeVideo,
  shortSide,
  isManifestUrl,
  isManifestMime,
  isProtectedMp4,
  hasVideoCodec,
};
