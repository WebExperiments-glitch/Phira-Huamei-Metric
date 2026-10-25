#!/usr/bin/env node
/* 守「Phira 解不了这个编码」：容器识别必须按 magic bytes，不能信扩展名。 */
import { sniffAudioKind, encodeWavFromBuffer, ensurePlayableAudio } from '../public/js/audio-analysis.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? '  —— ' + d : '')); } };
const mk = (head, len = 64) => {
  const b = new Uint8Array(len);
  for (let i = 0; i < head.length; i++) b[i] = head.charCodeAt(i);
  return b;
};

ok('WAV (RIFF....WAVE)', sniffAudioKind(mk('RIFF\0\0\0\0WAVE')) === 'wav');
ok('OGG (OggS)', sniffAudioKind(mk('OggS')) === 'ogg');
ok('FLAC (fLaC)', sniffAudioKind(mk('fLaC')) === 'flac');
ok('MP3 (ID3)', sniffAudioKind(mk('ID3')) === 'mp3');
ok('MP4 系 (ftyp 在偏移 4)', (() => {
  const b = new Uint8Array(32); b[4] = 0x66; b[5] = 0x74; b[6] = 0x79; b[7] = 0x70;
  return sniffAudioKind(b) === 'm4a';
})());
ok('MP3 帧同步（无 ID3）', (() => {
  /* 真实帧头：FF FB 90 —— version=3, layer=1, bitrate=9, samplerate=0 */
  const b = new Uint8Array(64); b[0] = 0xFF; b[1] = 0xFB; b[2] = 0x90;
  return sniffAudioKind(b) === 'mp3';
})());
ok('垃圾字节 → unknown', sniffAudioKind(mk('hello world')) === 'unknown');
/* ⚠ 关键：AAC 装成 .mp3 —— 扩展名说 mp3，内容是 ftyp/m4a。必须认成 m4a 才会被转码 */
ok('AAC/M4A 冒名 .mp3 能被识破', (() => {
  const b = new Uint8Array(32);
  b[0] = 0; b[1] = 0; b[2] = 0; b[3] = 0x20;
  b[4] = 0x66; b[5] = 0x74; b[6] = 0x79; b[7] = 0x70;
  return sniffAudioKind(b) === 'm4a';
})());

/* WAV 编码器：头部 44 字节 + 采样，长度与字节序都对 */
const fake = {
  numberOfChannels: 2, length: 4, sampleRate: 44100,
  getChannelData: (c) => Float32Array.from(c === 0 ? [0, 0.5, -0.5, 1] : [1, 0, 0, -1]),
};
const wav = encodeWavFromBuffer(fake);
ok('WAV 总长 = 44 + 采样数×通道×2', wav.length === 44 + 4 * 2 * 2, String(wav.length));
ok('WAV 头是 RIFF/WAVE', String.fromCharCode(...wav.slice(0, 4)) === 'RIFF'
  && String.fromCharCode(...wav.slice(8, 12)) === 'WAVE');
ok('WAV 采样率写在 24 字节处', new DataView(wav.buffer).getUint32(24, true) === 44100);
ok('WAV 通道数写在 22 字节处', new DataView(wav.buffer).getUint16(22, true) === 2);
/* ⚠⚠ 这条是 2026-10-25 实机测出来的真事故，别再犯：
   第一版「先扫 MP3 帧同步、后判 ftyp」，于是一个**真正的 M4A/AAC**被判成 mp3
   —— 因为 AAC 载荷里 `FF Ex` 极常见。误判 → 原样透传不转码 → Phira 仍报
   unsupported codec。判据：容器签名必须优先于帧同步扫描。 */
{
  const b = new Uint8Array(512);
  b[0] = 0; b[1] = 0; b[2] = 0; b[3] = 0x18;
  b[4] = 0x66; b[5] = 0x74; b[6] = 0x79; b[7] = 0x70;   /* ftyp */
  b[8] = 0x4D; b[9] = 0x34; b[10] = 0x41; b[11] = 0x20; /* M4A  */
  /* 模拟 AAC 载荷里的伪帧同步 */
  b[100] = 0xFF; b[101] = 0xFB; b[102] = 0x90;
  ok('★ M4A + 载荷里有 FF FB 仍判 m4a（不是 mp3）', sniffAudioKind(b) === 'm4a', sniffAudioKind(b));
}

/* 严格帧同步：无效头不能被当成 MP3 */
{
  const b = new Uint8Array(64);
  b[0] = 0xFF; b[1] = 0xE0; b[2] = 0x00;   /* version=0, layer=0, br=0 → 全非法 */
  ok('非法 MP3 头不算 mp3', sniffAudioKind(b) !== 'mp3', sniffAudioKind(b));
}

ok('WAV data 长度与内容一致', new DataView(wav.buffer).getUint32(40, true) === 4 * 2 * 2);

/* 透传白名单 = Phira 源码 prpr/Cargo.toml:65 的 symphonia features：
   flac / mp3 / ogg / vorbis / wav / pcm。名单外必须走转码（这里没有 AudioContext，会抛）。 */
{
  const mk2 = (h) => { const b = new Uint8Array(64); for (let i = 0; i < h.length; i++) b[i] = h.charCodeAt(i); return b; };
  const ogg = mk2('OggS');
  const r = await ensurePlayableAudio(ogg, '狐属性.mp3');
  ok('OGG 内容装成 .mp3 → 扩展名改成 .ogg', r.name.endsWith('.ogg'), r.name);
  ok('OGG 透传不改字节', r.bytes === ogg);

  const mp3 = mk2('ID3');
  const r2 = await ensurePlayableAudio(mp3, 'a.mp3');
  ok('MP3 透传且不改名', r2.name === 'a.mp3' && !r2.renamed);

  const flac = mk2('fLaC');
  const r3 = await ensurePlayableAudio(flac, 'x');
  ok('FLAC 透传（源码明确启用 flac）并补后缀', r3.name === 'x.flac', r3.name);

  let threw = null;
  try { await ensurePlayableAudio(mk2('\0\0\0 ftyp'), 'b.mp3'); } catch (e) { threw = e; }
  ok('M4A/AAC 不走透传（会去转码）', threw !== null, threw ? '' : '被误判成可透传');
}

console.log('\n────────');
console.log('音频容器 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
