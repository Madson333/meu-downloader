import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHls, parseDash, parseManifest, parseXml, parseAttributes, parseIsoDuration, expandTemplate,
  selectVideo, selectDashAudio, pickDefault, isManifestUrl, isManifestMime, isProtectedMp4,
  type HlsMaster, type HlsMedia,
} from '../src/engine/manifest';
import { isPrivateAddress } from '../src/engine/http-client';
import { streamBaseName } from '../src/engine/stream-download';

const BASE = 'https://cdn.example.com/show/ep1/master.m3u8';

/** assert.throws validator: the thrown error carries this code. */
const hasCode = (code: string) => (err: unknown): boolean => (err as { code?: unknown }).code === code;

/** The value, failing the test when it is missing. */
function must<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, 'expected a value');
  return value;
}

function master(text: string, base = BASE): HlsMaster {
  const m = parseHls(text, base);
  assert.ok(m.kind === 'master');
  return m;
}

function media(text: string, base = BASE): HlsMedia {
  const m = parseHls(text, base);
  assert.ok(m.kind === 'media');
  return m;
}

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Português",LANGUAGE="pt",DEFAULT=YES,URI="audio/pt.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Português",LANGUAGE="pt",URI="subs/pt.m3u8"
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC",INSTREAM-ID="CC1"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aac",SUBTITLES="subs"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac",SUBTITLES="subs"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=29.970,AUDIO="aac",SUBTITLES="subs"
https://other.example.com/1080p/index.m3u8?token=abc
#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"
audio-only.m3u8
`;

test('HLS master playlist: variants, renditions and URL resolution', () => {
  const m = master(MASTER);
  assert.equal(m.kind, 'master');
  assert.equal(m.variants.length, 4);
  const [v360, v720, v1080, audioOnly] = m.variants;
  assert.equal(v360.uri, 'https://cdn.example.com/show/ep1/360p/index.m3u8');
  assert.deepEqual([v720.width, v720.height, v720.bandwidth], [1280, 720, 2500000]);
  assert.equal(v1080.uri, 'https://other.example.com/1080p/index.m3u8?token=abc');
  assert.equal(v1080.averageBandwidth, 4500000);
  assert.equal(v1080.frameRate, 29.97);
  assert.equal(v1080.codecs, 'avc1.640028,mp4a.40.2');
  assert.equal(v1080.audio, 'aac');
  assert.equal(audioOnly.hasVideo, false);
  assert.equal(v360.hasVideo, true);

  const audio = m.renditions.filter((r) => r.type === 'audio');
  assert.equal(audio.length, 2);
  assert.equal(audio[1].uri, 'https://cdn.example.com/show/ep1/audio/pt.m3u8');
  assert.equal(must(pickDefault(audio)).language, 'pt');
  const subs = m.renditions.filter((r) => r.type === 'subtitles');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].groupId, 'subs');
  // Closed captions live inside the video and are not separate renditions.
  assert.ok(!m.renditions.some((r) => r.name === 'CC'));
});

test('HLS media playlist: segments, durations, byte ranges and init map', () => {
  const text = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:6.006,
#EXT-X-BYTERANGE:1000@720
media.mp4
#EXTINF:5.5,
#EXT-X-BYTERANGE:2000
media.mp4
#EXTINF:3,
../other/seg3.m4s
#EXT-X-ENDLIST
`;
  const m = media(text, 'https://cdn.example.com/a/b/index.m3u8');
  assert.equal(m.kind, 'media');
  assert.equal(m.live, false);
  assert.equal(m.mediaSequence, 10);
  assert.deepEqual(m.map, { url: 'https://cdn.example.com/a/b/init.mp4', range: { offset: 0, length: 720 } });
  assert.equal(m.segments.length, 3);
  assert.deepEqual(m.segments[0].range, { offset: 720, length: 1000 });
  // Without @offset the range continues after the previous one.
  assert.deepEqual(m.segments[1].range, { offset: 1720, length: 2000 });
  assert.equal(m.segments[2].url, 'https://cdn.example.com/a/other/seg3.m4s');
  assert.equal(m.segments[2].range, null);
  assert.equal(m.segments[0].duration, 6.006);
  assert.ok(Math.abs(m.totalDuration - 14.506) < 1e-9);
});

test('HLS live playlists are flagged and plain M3U lists are not streams', () => {
  const live = media('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n', BASE);
  assert.equal(live.live, true);
  const event = media('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\na.ts\n', BASE);
  assert.equal(event.live, false);
  assert.throws(
    () => parseHls('#EXTM3U\n#EXTINF:-1,Canal 1\nhttp://iptv.example/1\n', BASE),
    hasCode('NOT_A_STREAM'),
  );
  assert.throws(() => parseManifest('<html></html>', BASE), hasCode('NOT_A_STREAM'));
});

test('HLS AES-128 keys use the explicit IV or the media sequence number', () => {
  const m = media(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4,
a.ts
#EXT-X-KEY:METHOD=AES-128,URI="key2.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:4,
b.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:4,
c.ts
#EXT-X-ENDLIST
`, BASE);
  assert.deepEqual(m.segments[0].key, { uri: 'https://cdn.example.com/show/ep1/key.bin', iv: '00000000000000000000000000000005' });
  assert.equal(m.segments[1]?.key?.iv, '000102030405060708090a0b0c0d0e0f');
  assert.equal(m.segments[2].key, null);
});

test('DRM-protected HLS is rejected', () => {
  const variants = [
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"',
    '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"',
  ];
  for (const key of variants) {
    assert.throws(
      () => parseHls(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n${key}\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n`, BASE),
      hasCode('DRM'),
      key,
    );
  }
  assert.throws(
    () => parseHls(`#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n`, BASE),
    hasCode('DRM'),
  );
});

test('HLS rejects unsafe URLs and unsupported structures', () => {
  assert.throws(
    () => parseHls('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nfile:///C:/Windows/win.ini\n#EXT-X-ENDLIST\n', BASE),
    hasCode('UNSUPPORTED'),
  );
  assert.throws(
    () => parseHls('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="a.mp4"\n#EXTINF:4,\n1.m4s\n#EXT-X-MAP:URI="b.mp4"\n#EXTINF:4,\n2.m4s\n#EXT-X-ENDLIST\n', BASE),
    hasCode('UNSUPPORTED'),
  );
  assert.throws(() => parseHls('not a playlist', BASE), hasCode('NOT_A_STREAM'));
});

test('attribute lists keep commas inside quotes', () => {
  assert.deepEqual(parseAttributes('BANDWIDTH=1,CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=640x360'), {
    BANDWIDTH: '1', CODECS: 'avc1.4d401e,mp4a.40.2', RESOLUTION: '640x360',
  });
});

test('quality selection uses real variants and explains substitutions', () => {
  const variants = master(MASTER).variants.filter((v) => v.hasVideo);
  const best = selectVideo(variants, 'best');
  assert.equal(best.variant.height, 1080);
  assert.equal(best.notice, null);

  const exact = selectVideo(variants, '720');
  assert.equal(exact.variant.height, 720);
  assert.equal(exact.notice, null);

  const below = selectVideo(variants, '1440');
  assert.equal(below.variant.height, 1080);
  assert.match(below.notice ?? '', /1440p não está disponível; usado 1080p/);

  const tooSmall = selectVideo(variants, '240');
  assert.equal(tooSmall.variant.height, 360);
  assert.match(tooSmall.notice ?? '', /menor resolução/);

  // Vertical video: the limit applies to the smaller side, as in the yt-dlp path.
  const vertical = selectVideo([{ width: 1080, height: 1920, bandwidth: 1 }, { width: 720, height: 1280, bandwidth: 1 }], '1080');
  assert.equal(vertical.variant.width, 1080);

  // Among equal resolutions H.264 wins, then the higher bitrate.
  const tie = selectVideo([
    { width: 1920, height: 1080, bandwidth: 9e6, codecs: 'hvc1.1.6.L120' },
    { width: 1920, height: 1080, bandwidth: 5e6, codecs: 'avc1.640028' },
  ], 'best');
  assert.equal(tie.variant.codecs, 'avc1.640028');

  const unknown = selectVideo([{ bandwidth: 1e6 }, { bandwidth: 3e6 }], '720');
  assert.equal(unknown.variant.bandwidth, 3e6);
  assert.match(unknown.notice ?? '', /não informa resoluções/);
});

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<!-- comentário -->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10.5S" minBufferTime="PT2S">
  <BaseURL>https://media.example.com/v/</BaseURL>
  <Period id="0">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
        initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%05d$.m4s"/>
      <Representation id="v720" bandwidth="2500000" width="1280" height="720" codecs="avc1.4d401f"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="alternate"/>
      <Representation id="a-en" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentTemplate timescale="48000" initialization="a-en/init.mp4" media="a-en/$Time$.m4s">
          <SegmentTimeline><S t="0" d="192000" r="1"/><S d="96000"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="pt">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
      <Representation id="a-pt-lo" bandwidth="64000" codecs="mp4a.40.2">
        <BaseURL>audio/pt-64k.mp4</BaseURL>
        <SegmentBase indexRange="800-1000"><Initialization range="0-799"/></SegmentBase>
      </Representation>
      <Representation id="a-pt-hi" bandwidth="192000" codecs="mp4a.40.2">
        <BaseURL>audio/pt-192k.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="pt">
      <Representation id="sub-pt" bandwidth="1000"><BaseURL>subs/pt.vtt</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentList timescale="1" duration="5">
        <Initialization sourceURL="list/init.mp4"/>
        <SegmentURL media="list/a.m4s"/>
        <SegmentURL media="list/whole.mp4" mediaRange="100-199"/>
      </SegmentList>
      <Representation id="list" bandwidth="100000" width="320" height="180"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test('DASH static manifest: templates, timelines, lists, base URLs and tracks', () => {
  const d = parseDash(MPD, 'https://cdn.example.com/x/manifest.mpd');
  assert.equal(d.protocol, 'dash');
  assert.equal(d.duration, 10.5);
  assert.equal(d.video.length, 3);
  const v1080 = must(d.video.find((r) => r.id === 'v1080'));
  assert.equal(must(v1080.init).url, 'https://media.example.com/v/v1080/init.mp4');
  assert.equal(v1080.segments.length, 3, 'ceil(10.5 / 4)');
  assert.equal(v1080.segments[2].url, 'https://media.example.com/v/v1080/seg-00003.m4s');

  const en = must(d.audio.find((r) => r.id === 'a-en'));
  assert.deepEqual(en.segments.map((s) => s.url.split('/').pop()), ['0.m4s', '192000.m4s', '384000.m4s']);
  assert.equal(en.language, 'en');
  assert.equal(en.segments[2].duration, 2);

  const hi = must(d.audio.find((r) => r.id === 'a-pt-hi'));
  assert.equal(hi.segments.length, 1);
  assert.equal(hi.segments[0].url, 'https://media.example.com/v/audio/pt-192k.mp4');
  // The main-role adaptation set wins, at its highest bitrate.
  assert.equal(must(selectDashAudio(d.audio)).id, 'a-pt-hi');

  const list = must(d.video.find((r) => r.id === 'list'));
  assert.equal(must(list.init).url, 'https://media.example.com/v/list/init.mp4');
  assert.deepEqual(list.segments[1].range, { offset: 100, length: 100 });

  assert.equal(d.subtitles.length, 1);
  assert.equal(d.subtitles[0].segments[0].url, 'https://media.example.com/v/subs/pt.vtt');
  assert.equal(selectVideo(d.video, '720').variant.id, 'v720');
});

test('DASH with DRM, live or several periods is rejected', () => {
  const protectedMpd = MPD.replace('<Representation id="v720"',
    '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="v720"');
  assert.throws(() => parseDash(protectedMpd, BASE), hasCode('DRM'));
  assert.throws(() => parseDash(MPD.replace('type="static"', 'type="dynamic"'), BASE), hasCode('LIVE'));
  const twoPeriods = MPD.replace('</Period>', '</Period><Period id="ad"></Period>');
  assert.throws(() => parseDash(twoPeriods, BASE), hasCode('UNSUPPORTED'));
  assert.throws(() => parseManifest('<!DOCTYPE x [<!ENTITY a "b">]><MPD/>', BASE), hasCode('MANIFEST'));
});

test('XML parser handles entities, CDATA, namespaces and malformed input', () => {
  const root = parseXml('<a:root xmlns:a="x" v="1 &amp; 2"><b><![CDATA[<raw>]]></b><c/>&#x41;</a:root>');
  assert.equal(root.local, 'root');
  assert.equal(root.attrs.v, '1 & 2');
  assert.equal(root.children[0].text, '<raw>');
  assert.equal(root.text, 'A');
  assert.throws(() => parseXml('<a><b></a>'), /malformado/);
  assert.throws(() => parseXml('<a>'), /não foi fechado/);
});

test('ISO durations and URL templates', () => {
  assert.equal(parseIsoDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.equal(parseIsoDuration('garbage'), null);
  assert.equal(expandTemplate('$RepresentationID$/$Number%04d$-$Time$$$.m4s', { RepresentationID: 'v', Number: 7, Time: 90 }), 'v/0007-90$.m4s');
});

test('manifest detection by URL and MIME type', () => {
  assert.ok(isManifestUrl('https://a.example/x/master.m3u8?token=1'));
  assert.ok(isManifestUrl('https://a.example/x/manifest.mpd'));
  assert.ok(!isManifestUrl('https://a.example/x/video.mp4'));
  assert.ok(isManifestMime('application/vnd.apple.mpegurl; charset=utf-8'));
  assert.ok(isManifestMime('application/dash+xml'));
  assert.ok(!isManifestMime('video/mp4'));
});

test('encrypted MP4 init segments are detected', () => {
  const box = (type: string, payload: Buffer = Buffer.alloc(0)): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, payload]);
  };
  const clear = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('trak', box('avc1')))]);
  const encrypted = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('trak', box('encv', box('sinf'))))]);
  assert.equal(isProtectedMp4(clear), false);
  assert.equal(isProtectedMp4(encrypted), true);
  assert.equal(isProtectedMp4(Buffer.concat([box('ftyp'), box('pssh')])), true);
});

test('private address detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '[::1]', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111', 'example.com']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('stream file names skip generic manifest names', () => {
  assert.equal(streamBaseName('https://cdn.example.com/show/ep1/master.m3u8'), 'ep1');
  assert.equal(streamBaseName('https://cdn.example.com/hls/index.m3u8'), 'cdn.example.com');
  assert.equal(streamBaseName('https://cdn.example.com/x/master.m3u8', 'Meu vídeo.mp4'), 'Meu vídeo');
  assert.equal(streamBaseName('https://cdn.example.com/a%3Cb/manifest.mpd'), 'a_b');
});
