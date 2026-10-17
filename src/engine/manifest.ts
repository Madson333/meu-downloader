/**
 * Parsers for HLS playlists and static MPEG-DASH manifests, plus quality
 * selection. Pure functions: no network access, so they are easy to test.
 *
 * Protected content (Widevine, PlayReady, FairPlay, CENC, SAMPLE-AES) is
 * rejected with code 'DRM'. Only AES-128 with the standard "identity" key
 * format is accepted: its key is served by the site to every player that is
 * allowed to watch, so it is ordinary transport encryption, not DRM.
 */

export type ManifestErrorCode = 'MANIFEST' | 'DRM' | 'LIVE' | 'UNSUPPORTED' | 'NOT_A_STREAM';

export class ManifestError extends Error {
  readonly code: ManifestErrorCode;

  /** code: MANIFEST (malformed), DRM, LIVE, UNSUPPORTED or NOT_A_STREAM. */
  constructor(message: string, code: ManifestErrorCode = 'MANIFEST') {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}

/** A byte range: `length` bytes starting at `offset`. */
export interface ByteRange {
  offset: number;
  length: number;
}

export interface SegmentKey {
  uri: string;
  /** 32 hex digits. */
  iv: string;
}

export interface MediaSegment {
  url: string;
  duration: number | null;
  range: ByteRange | null;
  key?: SegmentKey | null;
}

export interface InitSegment {
  url: string;
  range: ByteRange | null;
}

/** Fields selectVideo uses; HLS variants and DASH representations both have them. */
export interface VideoCandidate {
  width?: number | null;
  height?: number | null;
  bandwidth?: number | null;
  codecs?: string | null;
}

export interface HlsVariant extends VideoCandidate {
  uri: string;
  bandwidth: number;
  averageBandwidth: number | null;
  width: number | null;
  height: number | null;
  codecs: string | null;
  frameRate: number | null;
  audio: string | null;
  subtitles: string | null;
  hasVideo: boolean;
}

export interface HlsRendition {
  type: 'audio' | 'subtitles';
  groupId: string | null;
  name: string | null;
  language: string | null;
  uri: string | null;
  isDefault: boolean;
  autoselect: boolean;
  channels: string | null;
}

export interface HlsMaster {
  protocol: 'hls';
  kind: 'master';
  variants: HlsVariant[];
  renditions: HlsRendition[];
}

export interface HlsMedia {
  protocol: 'hls';
  kind: 'media';
  live: boolean;
  playlistType: string | null;
  targetDuration: number;
  mediaSequence: number;
  discontinuities: number;
  map: InitSegment | null;
  segments: MediaSegment[];
  totalDuration: number;
}

export interface DashRepresentation extends VideoCandidate {
  id: string | null;
  bandwidth: number;
  width: number | null;
  height: number | null;
  codecs: string | null;
  mimeType: string | null;
  language: string | null;
  label: string | null;
  role: string | null;
  adaptationIndex: number;
  init: InitSegment | null;
  segments: MediaSegment[];
}

export interface DashManifest {
  protocol: 'dash';
  live: false;
  duration: number | null;
  video: DashRepresentation[];
  audio: DashRepresentation[];
  subtitles: DashRepresentation[];
}

export type Manifest = HlsMaster | HlsMedia | DashManifest;

const MAX_SEGMENTS = 200_000;
const MANIFEST_MIME = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/(x-)?mpegurl)\b/i;
const VIDEO_CODEC = /^(avc[13]|hvc1|hev1|dvh[1e]|av01|vp0?9|vp8|mp4v)/i;

export function isManifestUrl(url: string): boolean {
  try {
    return /\.(m3u8|mpd)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function isManifestMime(contentType: string | null | undefined): boolean {
  return MANIFEST_MIME.test(String(contentType ?? '').trim());
}

function resolveUrl(ref: string, base: string): string {
  let url: URL;
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
function parseResolution(value: string | undefined): { width: number | null; height: number | null } {
  const match = /^(\d+)x(\d+)$/i.exec(value ?? '');
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: null, height: null };
}

export function hasVideoCodec(codecs: string | null | undefined): boolean {
  return String(codecs ?? '').split(',').some((c) => VIDEO_CODEC.test(c.trim()));
}

// ---------------------------------------------------------------- HLS

type Attributes = Record<string, string>;

/** Parses an HLS attribute list: KEY=VALUE,KEY="quoted, value" */
export function parseAttributes(text: string): Attributes {
  const attrs: Attributes = {};
  const re = /\s*([A-Z0-9-]+)=("[^"]*"|[^,]*)\s*(,|$)/gy;
  let match: RegExpExecArray | null;
  while (re.lastIndex < text.length && (match = re.exec(text))) {
    const [, key = '', raw = ''] = match;
    attrs[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw.trim();
  }
  return attrs;
}

/** "n[@o]" → { length, offset|null } */
function parseByteRange(value: string): { length: number; offset: number | null } {
  const match = /^(\d+)(?:@(\d+))?$/.exec(String(value ?? '').trim());
  if (!match) throw new ManifestError(`Intervalo de bytes inválido: ${value}`);
  return { length: Number(match[1]), offset: match[2] === undefined ? null : Number(match[2]) };
}

interface HlsKey {
  method: 'AES-128';
  uri: string;
  iv: string | null;
}

/** Returns the AES-128 key info, null for no encryption, or throws for DRM. */
function checkHlsKey(attrs: Attributes, baseUrl: string): HlsKey | null {
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
    let iv: string | null = null;
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

function parseHlsMaster(lines: string[], baseUrl: string): HlsMaster {
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice(18));
      let j = i + 1;
      while (j < lines.length && lines[j]?.startsWith('#')) j++;
      const uri = lines[j];
      if (uri === undefined) throw new ManifestError('Variante HLS sem URI');
      const { width, height } = parseResolution(a.RESOLUTION);
      variants.push({
        uri: resolveUrl(uri, baseUrl),
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

function parseHlsMedia(lines: string[], baseUrl: string): HlsMedia {
  const segments: MediaSegment[] = [];
  let mediaSequence = 0;
  let targetDuration: number | null = null;
  let playlistType: string | null = null;
  let endList = false;
  let duration: number | null = null;
  let byteRange: { length: number; offset: number | null } | null = null;
  let key: HlsKey | null = null;
  let map: InitSegment | null = null;
  let discontinuities = 0;
  const mapKeys = new Set<string>();
  const nextOffset = new Map<string, number>();

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
      const parsed = a.BYTERANGE ? parseByteRange(a.BYTERANGE) : null;
      const range = parsed ? { length: parsed.length, offset: parsed.offset ?? 0 } : null;
      map = { url: resolveUrl(a.URI, baseUrl), range };
      mapKeys.add(`${map.url}|${range?.offset}|${range?.length}`);
    } else if (!line.startsWith('#')) {
      const url = resolveUrl(line, baseUrl);
      let range: ByteRange | null = null;
      if (byteRange) {
        const offset = byteRange.offset ?? nextOffset.get(url) ?? 0;
        range = { offset, length: byteRange.length };
        nextOffset.set(url, offset + byteRange.length);
      }
      const sequence = mediaSequence + segments.length;
      segments.push({
        url,
        duration: duration !== null && Number.isFinite(duration) ? duration : null,
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
export function parseHls(text: string, baseUrl: string): HlsMaster | HlsMedia {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new ManifestError('Playlist HLS inválida: falta #EXTM3U', 'NOT_A_STREAM');
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'))) return parseHlsMaster(lines, baseUrl);
  if (lines.some((l) => l.startsWith('#EXT-X-TARGETDURATION:'))) return parseHlsMedia(lines, baseUrl);
  // Plain M3U lists (e.g. IPTV channel lists) carry #EXTINF but none of the HLS tags.
  throw new ManifestError('O arquivo é uma lista M3U comum, não uma playlist HLS', 'NOT_A_STREAM');
}

// ---------------------------------------------------------------- XML

export interface XmlNode {
  name: string;
  /** Name without the namespace prefix. */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[name] ?? match;
  });
}

/**
 * Minimal XML parser for manifests: elements, attributes, text, comments and
 * CDATA. DOCTYPE is refused, so entity expansion attacks cannot happen.
 */
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const src = String(text).replace(/^﻿/, '');
  const fail = (what: string): never => {
    throw new ManifestError(`XML malformado: ${what}`);
  };
  const tagName = /[^\s/>=]+/y;
  const attr = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  const tagEnd = /\s*(\/?)>/y;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1] ?? root;
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
      const name = tagName.exec(src)?.[0] ?? fail('nome de elemento ausente');
      const node: XmlNode = { name, local: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name, attrs: {}, children: [], text: '' };
      let pos = tagName.lastIndex;
      for (;;) {
        attr.lastIndex = pos;
        const a = attr.exec(src);
        if (!a?.[1]) break;
        node.attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
        pos = attr.lastIndex;
      }
      tagEnd.lastIndex = pos;
      const end = tagEnd.exec(src) ?? fail(`atributos inválidos em <${name}>`);
      top.children.push(node);
      if (!end[1]) stack.push(node);
      i = tagEnd.lastIndex;
    }
  }
  if (stack.length !== 1) fail(`<${stack[stack.length - 1]?.name}> não foi fechado`);
  const element = root.children[0];
  if (!element || root.children.length > 1) fail('o documento deve ter um único elemento raiz');
  return element as XmlNode;
}

const childrenOf = (node: XmlNode | null, local: string): XmlNode[] => (node ? node.children.filter((c) => c.local === local) : []);
const childOf = (node: XmlNode | null, local: string): XmlNode | null => childrenOf(node, local)[0] ?? null;

function hasDescendant(node: XmlNode, local: string): boolean {
  return node.children.some((c) => c.local === local || hasDescendant(c, local));
}

// ---------------------------------------------------------------- DASH

/** ISO 8601 duration ("PT1H2M3.5S") in seconds; null if absent or invalid. */
export function parseIsoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const n = '(\\d+(?:\\.\\d+)?)';
  const match = new RegExp(`^P(?:${n}Y)?(?:${n}M)?(?:${n}D)?(?:T(?:${n}H)?(?:${n}M)?(?:${n}S)?)?$`).exec(value.trim());
  if (!match) return null;
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = match.slice(1).map((v) => Number(v ?? 0));
  return y * 31_536_000 + mo * 2_592_000 + d * 86_400 + h * 3600 + mi * 60 + s;
}

/** "start-end" (inclusive) → { offset, length } */
function parseDashRange(value: string | undefined): ByteRange | null {
  if (!value) return null;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match || Number(match[2]) < Number(match[1])) throw new ManifestError(`Intervalo de bytes inválido: ${value}`);
  return { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 };
}

function applyBaseUrl(base: string, node: XmlNode): string {
  const el = childOf(node, 'BaseURL');
  return el && el.text.trim() ? resolveUrl(el.text.trim(), base) : base;
}

type TemplateValues = Partial<Record<'RepresentationID' | 'Number' | 'Time' | 'Bandwidth', string | number | null>>;

export function expandTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)d)?\$/g, (_match, name: string, width?: string) => {
    if (name === '') return '$';
    const value = values[name as keyof TemplateValues];
    if (value === undefined || value === null) throw new ManifestError(`Modelo de URL usa $${name}$ sem valor`);
    const text = String(value);
    return width ? text.padStart(Number(width), '0') : text;
  });
}

interface Template {
  attrs: Record<string, string>;
  timeline: XmlNode | null;
}

/** Merges SegmentTemplate attributes from outer to inner levels; the innermost timeline wins. */
function mergedTemplate(...levels: XmlNode[]): Template | null {
  const nodes = levels.map((n) => childOf(n, 'SegmentTemplate')).filter((n): n is XmlNode => n !== null);
  if (!nodes.length) return null;
  const attrs: Record<string, string> = Object.assign({}, ...nodes.map((n) => n.attrs));
  const timeline = nodes.map((n) => childOf(n, 'SegmentTimeline')).filter(Boolean).pop() ?? null;
  return { attrs, timeline };
}

interface Parts {
  init: InitSegment | null;
  segments: MediaSegment[];
}

function templateSegments(template: Template, rep: { id: string | null; bandwidth: number }, base: string, periodDuration: number | null): Parts {
  const a = template.attrs;
  const timescale = Number(a.timescale) || 1;
  const startNumber = a.startNumber !== undefined ? Number(a.startNumber) : 1;
  const ids = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const init = a.initialization ? { url: resolveUrl(expandTemplate(a.initialization, ids), base), range: null } : null;
  const media = a.media;
  if (!media) throw new ManifestError('SegmentTemplate sem atributo media');
  const segments: MediaSegment[] = [];
  const push = (number: number, time: number, duration: number): void => {
    segments.push({
      url: resolveUrl(expandTemplate(media, { ...ids, Number: number, Time: time }), base),
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

function listSegments(list: XmlNode, base: string): Parts {
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

function contentTypeOf(as: XmlNode, rep: XmlNode): 'video' | 'audio' | 'subtitles' | null {
  const mime = rep.attrs.mimeType ?? as.attrs.mimeType ?? '';
  const codecs = rep.attrs.codecs ?? as.attrs.codecs ?? '';
  const declared = as.attrs.contentType ?? rep.attrs.contentType ?? mime.split('/')[0];
  if (declared === 'text' || /^(text\/vtt|application\/ttml)/.test(mime) || /^(stpp|wvtt)/.test(codecs)) return 'subtitles';
  if (declared === 'video' || declared === 'audio') return declared;
  return null;
}

/** Parses a static MPEG-DASH manifest. */
export function parseDash(text: string, baseUrl: string): DashManifest {
  const mpd = parseXml(text);
  if (mpd.local !== 'MPD') throw new ManifestError('Manifesto DASH inválido: elemento MPD ausente', 'NOT_A_STREAM');
  if ((mpd.attrs.type ?? 'static') === 'dynamic') {
    throw new ManifestError('Transmissões ao vivo (DASH dinâmico) não são suportadas', 'LIVE');
  }
  if (hasDescendant(mpd, 'ContentProtection')) {
    throw new ManifestError('Conteúdo protegido por DRM (ContentProtection). O Meu Downloader não baixa mídia com DRM.', 'DRM');
  }
  const periods = childrenOf(mpd, 'Period');
  const period = periods[0];
  if (!period) throw new ManifestError('Manifesto DASH sem Period');
  if (periods.length > 1) {
    throw new ManifestError('Manifestos DASH com vários períodos (por exemplo, com anúncios) não são suportados', 'UNSUPPORTED');
  }
  const total = parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const periodDuration = parseIsoDuration(period.attrs.duration)
    ?? (total !== null ? total - (parseIsoDuration(period.attrs.start) ?? 0) : null);
  const periodBase = applyBaseUrl(applyBaseUrl(baseUrl, mpd), period);

  const result: DashManifest = { protocol: 'dash', live: false, duration: periodDuration, video: [], audio: [], subtitles: [] };
  childrenOf(period, 'AdaptationSet').forEach((as, adaptationIndex) => {
    const asBase = applyBaseUrl(periodBase, as);
    const role = childOf(as, 'Role')?.attrs.value ?? null;
    const label = childOf(as, 'Label')?.text.trim() || as.attrs.label || null;
    for (const repEl of childrenOf(as, 'Representation')) {
      const type = contentTypeOf(as, repEl);
      if (!type) continue;
      const pick = (name: string): string | undefined => repEl.attrs[name] ?? as.attrs[name];
      const id = repEl.attrs.id ?? null;
      const bandwidth = Number(repEl.attrs.bandwidth) || 0;
      const base = applyBaseUrl(asBase, repEl);
      const template = mergedTemplate(period, as, repEl);
      const list = childOf(repEl, 'SegmentList') ?? childOf(as, 'SegmentList');
      let parts: Parts;
      if (template) parts = templateSegments(template, { id, bandwidth }, base, periodDuration);
      else if (list) parts = listSegments(list, base);
      else {
        // SegmentBase or a bare BaseURL: the whole representation is one
        // self-contained file (its init data is inside), downloaded in one piece.
        if (base === baseUrl) throw new ManifestError(`Representação ${id ?? ''} sem endereço de mídia`);
        parts = { init: null, segments: [{ url: base, range: null, duration: periodDuration }] };
      }
      if (!parts.segments.length) throw new ManifestError(`Representação ${id ?? ''} sem segmentos`);
      result[type].push({
        id,
        bandwidth,
        width: Number(pick('width')) || null,
        height: Number(pick('height')) || null,
        codecs: pick('codecs') ?? null,
        mimeType: pick('mimeType') ?? null,
        language: as.attrs.lang ?? repEl.attrs.lang ?? null,
        label,
        role,
        adaptationIndex,
        init: parts.init,
        segments: parts.segments,
      });
    }
  });
  if (!result.video.length && !result.audio.length) throw new ManifestError('O manifesto DASH não tem faixas de vídeo nem de áudio');
  return result;
}

// ---------------------------------------------------------------- detection

/** Detects HLS or DASH by content, then parses it. */
export function parseManifest(text: string, baseUrl: string): Manifest {
  const head = String(text).replace(/^﻿/, '').trimStart().slice(0, 4096);
  if (head.startsWith('#EXTM3U')) return parseHls(text, baseUrl);
  if (/<(?:[a-z0-9]+:)?MPD[\s/>]/i.test(head)) return parseDash(text, baseUrl);
  throw new ManifestError('O endereço não é uma playlist HLS nem um manifesto DASH', 'NOT_A_STREAM');
}

// ---------------------------------------------------------------- selection

export const shortSide = (v: VideoCandidate): number | null => (v.width && v.height ? Math.min(v.width, v.height) : null);
const isH264 = (v: VideoCandidate): number => (/^avc/i.test(String(v.codecs ?? '')) ? 1 : 0);

export function describeVideo(v: VideoCandidate): string {
  const parts: string[] = [];
  if (v.width && v.height) parts.push(`${shortSide(v)}p (${v.width}×${v.height})`);
  if (v.bandwidth) parts.push(`${(v.bandwidth / 1e6).toFixed(1)} Mbps`);
  if (v.codecs) parts.push(String(v.codecs).split(',')[0] ?? '');
  return parts.join(' · ') || 'qualidade única';
}

export interface Selection<T> {
  variant: T;
  notice: string | null;
}

/**
 * Picks a video variant for "best" or a height limit ("1080", applied to the
 * smaller side, like the yt-dlp path). Among equal resolutions H.264 wins,
 * then the higher bitrate. When nothing fits under the limit, the smallest
 * variant is used and `notice` explains the substitution.
 */
export function selectVideo<T extends VideoCandidate>(variants: readonly T[], quality: string): Selection<T> {
  const sorted = [...variants].sort((a, b) => (shortSide(b) ?? 0) - (shortSide(a) ?? 0)
    || isH264(b) - isH264(a)
    || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  const [best] = sorted;
  if (!best) throw new ManifestError('O manifesto não tem variantes de vídeo');
  if (!/^\d+$/.test(String(quality))) return { variant: best, notice: null };
  const limit = Number(quality);
  const known = sorted.filter((v) => shortSide(v) !== null);
  const smallest = known[known.length - 1];
  if (!smallest) {
    return { variant: best, notice: `O manifesto não informa resoluções; usada a maior taxa de bits em vez de ${limit}p` };
  }
  const fit = known.find((v) => (shortSide(v) ?? 0) <= limit);
  if (fit) {
    const got = shortSide(fit) ?? 0;
    return { variant: fit, notice: got < limit ? `${limit}p não está disponível; usado ${got}p, a maior resolução abaixo` : null };
  }
  return { variant: smallest, notice: `${limit}p não está disponível; usado ${shortSide(smallest)}p, a menor resolução oferecida` };
}

/** Default audio rendition: DEFAULT=YES, then AUTOSELECT, then the first. */
export function pickDefault<T extends { isDefault: boolean; autoselect: boolean }>(renditions: readonly T[]): T | null {
  return renditions.find((r) => r.isDefault) ?? renditions.find((r) => r.autoselect) ?? renditions[0] ?? null;
}

/** DASH audio: the "main" adaptation set (or the first), at its highest bitrate. */
export function selectDashAudio(reps: readonly DashRepresentation[]): DashRepresentation | null {
  return [...reps].sort((a, b) => Number(b.role === 'main') - Number(a.role === 'main')
    || a.adaptationIndex - b.adaptationIndex
    || b.bandwidth - a.bandwidth)[0] ?? null;
}

// ---------------------------------------------------------------- MP4 inspection

/**
 * True when an MP4 init segment declares encryption (encv/enca sample entries,
 * or pssh boxes), even if the manifest did not say so. Only the moov box is
 * searched, which holds metadata and no media payload.
 */
export function isProtectedMp4(buf: Buffer): boolean {
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
