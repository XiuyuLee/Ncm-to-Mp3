#!/usr/bin/env node
/**
 * dsh-ncm2mp3 — 零依赖测试套件
 *
 * 运行：
 *   node test/run-tests.mjs            # 全量测试（含真实文件）
 *   node test/run-tests.mjs --quick    # 只跑合成夹具与错误路径，跳过真实文件
 *
 * 覆盖：
 *   1. 合成 NCM 夹具（端到端构造 → 解析，验证字节级正确性）
 *   2. 元数据归一化 / 文件名建议 / format 判定
 *   3. 错误路径：NCM_INVALID_HEADER、NCM_TRUNCATED、NCM_BAD_CRYPT、NCM_UNSUPPORTED
 *   4. 真实 .ncm 文件：元数据非空、音频魔数、封面魔数、耗时
 *   5. 真实文件批量冒烟（含 98MB / 74MB 大文件）
 *
 * 真实文件只读，绝不修改。产物写入 test/out/（已 gitignore）。
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createCipheriv } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseNcm,
  isNcm,
  NcmError,
  NCM_MAGIC,
  NCM_ERROR_CODES,
  suggestFileName,
} from '../lib/ncm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const DECODED_DIR = join(OUT_DIR, 'decoded');
const QUICK = process.argv.includes('--quick');

// ==== 微型测试框架 ==========================================================

let passed = 0;
let failed = 0;
/** @type {{name: string, message: string}[]} */
const failures = [];
let currentSection = '';

function section(title) {
  currentSection = title;
  console.log(`\n=== ${title} ===`);
}

/**
 * 运行一个测试用例；抛错即失败。
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name: `${currentSection} / ${name}`, message });
    console.log(`  FAIL  ${name}\n        ${message.split('\n').join('\n        ')}`);
  }
}

/**
 * @param {unknown} condition
 * @param {string} message
 */
function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} label
 */
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/**
 * 断言 fn 抛出指定 code 的 NcmError。
 * @param {() => unknown} fn
 * @param {string} code
 * @param {string} label
 */
function assertNcmError(fn, code, label) {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof NcmError)) {
      throw new Error(`${label}: 期望抛出 NcmError，实际是 ${error?.constructor?.name}: ${error?.message}`);
    }
    if (error.code !== code) {
      throw new Error(`${label}: 期望错误码 ${code}，实际 ${error.code}（${error.message}）`);
    }
    assert(typeof error.message === 'string' && error.message.length > 0, `${label}: NcmError 缺少 message`);
    return error;
  }
  throw new Error(`${label}: 期望抛出 ${code}，但没有抛错`);
}

// ==== 合成 NCM 夹具（独立于 lib/ncm.js 重写构造逻辑） ========================

/** 与 lib/ncm.js 内部一致的 aes key（测试里复述，若不一致测试会立刻失败） */
const TEST_KEY_AREA_AES_KEY = Buffer.from('hzHRAmso5kInbaxW', 'latin1');
const TEST_META_AREA_AES_KEY = Buffer.from([
  0x23, 0x31, 0x34, 0x6c, 0x6a, 0x6b, 0x5f, 0x21, 0x5c, 0x5d, 0x26, 0x30, 0x55, 0x3c, 0x27, 0x28,
]);
const TEST_KEY_AREA_PREFIX = 'neteasecloudmusic';
const TEST_META_PREFIX = "163 key(Don't modify):";

/**
 * @param {Buffer} buf
 * @param {number} byte
 */
function xor(buf, byte) {
  for (let i = 0; i < buf.length; i++) buf[i] ^= byte;
  return buf;
}

/**
 * AES-128-ECB 加密（带 PKCS#7 填充）。
 * @param {Buffer} plain
 * @param {Buffer} key
 * @returns {Buffer}
 */
function aesEncrypt(plain, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/**
 * 按 NCM 算法构造 key box（与 lib/ncm.js 内部实现互相独立地复述）。
 * @param {Buffer} key
 * @returns {Uint8Array}
 */
function buildKeyBox(key) {
  const keyBox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) keyBox[i] = i;
  let c = 0;
  let last = 0;
  for (let i = 0; i < 256; i++) {
    const swap = keyBox[i];
    c = (swap + last + key[i % key.length]) & 0xff;
    keyBox[i] = keyBox[c];
    keyBox[c] = swap;
    last = c;
  }
  return keyBox;
}

/**
 * 由 key box 构造 256 字节循环密钥流。
 * @param {Uint8Array} keyBox
 * @returns {Uint8Array}
 */
function buildKeyStream(keyBox) {
  const ks = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const j = (i + 1) & 0xff;
    ks[i] = keyBox[(keyBox[j] + keyBox[(keyBox[j] + j) & 0xff]) & 0xff];
  }
  return ks;
}

/**
 * 用密钥流原地 XOR（加解密同函数）。
 * @param {Buffer} data
 * @param {Buffer} rc4Key
 */
function xorStream(data, rc4Key) {
  const ks = buildKeyStream(buildKeyBox(rc4Key));
  for (let i = 0; i < data.length; i++) data[i] ^= ks[i & 0xff];
}

/**
 * 写小端 uint32。
 * @param {number} value
 * @returns {Buffer}
 */
function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

/**
 * 构造一个合法的 NCM 文件。
 *
 * @param {object} opts
 * @param {object | null} [opts.meta] 元数据 JSON（null 表示不写入元数据区内容）
 * @param {Buffer} [opts.audio] 明文音频
 * @param {{format?: string, data?: Buffer} | null} [opts.cover] 封面（data 为明文图片）
 * @param {Buffer} [opts.rc4Key] 自定义 RC4 密钥
 * @param {Buffer | null} [opts.rawMetadataArea] 直接指定元数据区原始字节（用于构造损坏元数据）
 * @param {number} [opts.crc] crc32 字段值
 * @param {number} [opts.coverPadding] image_space 比 image_size 多出的填充字节数
 * @returns {{ file: Buffer, audio: Buffer, cover: Buffer | null, rc4Key: Buffer }}
 */
function buildFixture(opts = {}) {
  const rc4Key = opts.rc4Key || Buffer.from('fixture-rc4-key-0123456789', 'latin1');
  const meta = opts.meta === undefined ? { musicName: '夹具歌曲', artist: [['夹具歌手', 1]], album: '夹具专辑', bitrate: 320000, duration: 1000, format: 'mp3' } : opts.meta;
  const audio = opts.audio || Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'latin1'), patternBuffer(8192, 7)]);
  const cover = opts.cover === undefined ? { format: 'jpg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), patternBuffer(1024, 3)]) } : opts.cover;
  const coverData = cover ? cover.data : Buffer.alloc(0);

  // 密钥区明文 = "neteasecloudmusic" + RC4 key
  const keyPlain = Buffer.from(TEST_KEY_AREA_PREFIX + rc4Key.toString('latin1'), 'latin1');
  const keyCipher = xor(aesEncrypt(keyPlain, TEST_KEY_AREA_AES_KEY), 0x64);

  // 元数据区 = XOR(0x63, "163 key(Don't modify):" + base64(AES("music:" + JSON)))
  let metaArea;
  if (opts.rawMetadataArea) {
    metaArea = opts.rawMetadataArea;
  } else if (meta === null) {
    metaArea = Buffer.alloc(0);
  } else {
    const metaPlain = Buffer.from('music:' + JSON.stringify(meta), 'utf8');
    const metaText = TEST_META_PREFIX + aesEncrypt(metaPlain, TEST_META_AREA_AES_KEY).toString('base64');
    metaArea = xor(Buffer.from(metaText, 'latin1'), 0x63);
  }

  // 音频区 = XOR(音频明文, keystream)
  const audioCipher = Buffer.from(audio);
  xorStream(audioCipher, rc4Key);

  // 真实布局（经 ncmdump core.py 与 14 个实测样本确认）：
  //   crc32(4) + 间隔字节 0x01 + image_space(4) + image_size(4) + 封面 + 填充 + 音频
  // 实测样本全部 image_space === image_size（padding 为 0），这里可按需构造 padding。
  const imageSize = coverData.length;
  const imagePadding = opts.coverPadding || 0;
  const imageSpace = imageSize + imagePadding;
  const crc = opts.crc === undefined ? 0 : opts.crc;

  const parts = [
    Buffer.from(NCM_MAGIC, 'latin1'),
    Buffer.from([0x01, 0x70]),
    u32(keyCipher.length),
    keyCipher,
    u32(metaArea.length),
    metaArea,
    u32(crc),
    Buffer.from([0x01]), // 间隔字节
    u32(imageSpace),
    u32(imageSize),
    coverData,
    Buffer.alloc(imagePadding), // 封面区对齐填充
    audioCipher,
  ];
  return { file: Buffer.concat(parts), audio, cover: cover ? coverData : null, rc4Key };
}

/**
 * 生成确定性伪随机字节（不依赖随机数，便于复现）。
 * @param {number} length
 * @param {number} seed
 * @returns {Buffer}
 */
function patternBuffer(length, seed) {
  const buf = Buffer.alloc(length);
  let value = seed & 0xff || 1;
  for (let i = 0; i < length; i++) {
    value = (value * 131 + 89) & 0xff;
    buf[i] = value;
  }
  return buf;
}

// ==== 真实文件发现 ==========================================================

const CANDIDATE_DIRS = [
  'C:\\Users\\16192\\Music\\VipSongsDownload',
  'C:\\Users\\16192\\Desktop\\文件\\音乐',
  'E:\\CloudMusic\\VipSongsDownload',
  'E:\\Music',
];

/**
 * 发现本机真实 .ncm 文件（按 basename 去重，只读）。
 * @returns {{ path: string, name: string, size: number, dir: string }[]}
 */
function discoverRealFiles() {
  /** @type {{ path: string, name: string, size: number, dir: string }[]} */
  const files = [];
  const seenNames = new Set();
  for (const dir of CANDIDATE_DIRS) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/\.ncm$/i.test(name)) continue;
      const fullPath = join(dir, name);
      let size;
      try {
        const stat = statSync(fullPath);
        if (!stat.isFile()) continue;
        size = stat.size;
      } catch {
        continue;
      }
      const key = name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      files.push({ path: fullPath, name, size, dir });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return files;
}

// ==== 断言工具：音频 / 封面魔数 =============================================

/**
 * @param {Buffer} buf
 * @returns {'mp3' | 'flac' | 'unknown'}
 */
function sniffAudioLib(buf) {
  if (buf.length >= 4 && buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return 'flac';
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  return 'unknown';
}

/**
 * @param {Buffer} buf
 * @returns {'jpg' | 'png' | 'webp' | 'unknown'}
 */
function sniffImageLib(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return 'unknown';
}

/**
 * 计算 NCM 音频起始偏移（与 lib/ncm.js 的布局解析保持一致）。
 * 布局：magic(8) + interval(2) + keyLen(4) + key + metaLen(4) + meta
 *       + crc32(4) + 间隔字节(1) + image_space(4) + image_size(4) + 封面区(image_space) + 音频
 * @param {Buffer} buf
 * @returns {number}
 */
function audioStartOffset(buf) {
  const keyLength = buf.readUInt32LE(10);
  const metaLength = buf.readUInt32LE(14 + keyLength);
  const crcOffset = 18 + keyLength + metaLength;
  const imageSpace = buf.readUInt32LE(crcOffset + 4 + 1);
  return crcOffset + 4 + 1 + 4 + 4 + imageSpace;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function mb(bytes) {
  return (bytes / 1048576).toFixed(2);
}

// ==== 报告收集 ==============================================================

/** @type {{name: string, size: number, format: string, audioSize: number, ms: number, cover: string, musicName: string, artist: string, ok: boolean, error?: string}[]} */
const smokeRows = [];

// ==== 主流程 ================================================================

async function main() {
  console.log('dsh-ncm2mp3 测试套件');
  console.log(`Node ${process.version} | ${QUICK ? 'quick 模式（跳过真实文件）' : '全量模式'}`);
  console.log(`工作目录: ${__dirname}`);
  mkdirSync(OUT_DIR, { recursive: true });

  // -------- 1. 合成夹具 --------
  section('合成夹具（端到端）');

  const fixture = buildFixture();
  await test('parseNcm 解析合成 NCM，元数据字段正确', () => {
    const { info, audio } = parseNcm(Buffer.from(fixture.file), { fileName: 'fixture.ncm' });
    assertEqual(info.format, 'mp3', 'format');
    assertEqual(info.musicName, '夹具歌曲', 'musicName');
    assertEqual(info.artist.length, 1, 'artist 长度');
    assertEqual(info.artist[0], '夹具歌手', 'artist[0]');
    assertEqual(info.album, '夹具专辑', 'album');
    assertEqual(info.bitrate, 320000, 'bitrate');
    assertEqual(info.duration, 1000, 'duration');
    assertEqual(audio.length, fixture.audio.length, '音频长度');
  });

  await test('解密后的音频与构造时的明文逐字节相同', () => {
    const { audio } = parseNcm(Buffer.from(fixture.file));
    assert(audio.equals(fixture.audio), '音频字节不一致');
  });

  await test('封面正确解出且魔数与图片格式一致', () => {
    const { cover } = parseNcm(Buffer.from(fixture.file));
    assert(cover, '封面缺失');
    assertEqual(cover.format, 'jpg', '封面格式');
    assert(cover.data.equals(fixture.cover), '封面字节不一致');
    assertEqual(cover.data[0], 0xff, 'JPEG 魔数');
  });

  await test('无封面（imageSize=0）时 cover 为 undefined', () => {
    const noCover = buildFixture({ cover: null });
    const { cover } = parseNcm(Buffer.from(noCover.file));
    assertEqual(cover, undefined, 'cover');
  });

  await test('PNG 封面识别', () => {
    const png = buildFixture({
      cover: { format: 'png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), patternBuffer(256, 9)]) },
    });
    const { cover } = parseNcm(Buffer.from(png.file));
    assert(cover, 'PNG 封面缺失');
    assertEqual(cover.format, 'png', '封面格式');
  });

  await test('无法识别的封面被丢弃（返回 undefined 而不是抛错）', () => {
    const bad = buildFixture({ cover: { format: 'png', data: patternBuffer(100, 5) } });
    const { cover, audio } = parseNcm(Buffer.from(bad.file));
    assertEqual(cover, undefined, 'cover');
    assert(audio.length > 0, '音频仍然解出');
  });

  await test('封面区带对齐填充（image_space > image_size）时音频偏移正确', () => {
    const padded = buildFixture({ coverPadding: 1024 });
    const { info, audio, cover } = parseNcm(Buffer.from(padded.file));
    assertEqual(info.format, 'mp3', 'format');
    assert(audio.equals(padded.audio), '带填充时音频字节不一致');
    assert(cover, '封面缺失');
    assert(cover.data.equals(padded.cover), '带填充时封面字节不一致');
  });

  await test('image_space < image_size 的畸形文件退化按 image_space 处理', () => {
    const malformed = Buffer.from(buildFixture().file);
    // 把 image_size 改成比 image_space 大（故意构造畸形数据）
    const keyLength = malformed.readUInt32LE(10);
    const metaLength = malformed.readUInt32LE(10 + 4 + keyLength);
    const imageSizeOffset = 10 + 4 + keyLength + 4 + metaLength + 4 + 5 + 4;
    malformed.writeUInt32LE(malformed.readUInt32LE(imageSizeOffset) + 64, imageSizeOffset);
    const { info, audio } = parseNcm(malformed);
    assertEqual(info.format, 'mp3', 'format');
    assert(audio.length > 0, '音频仍可解出');
  });

  await test('接受 Uint8Array / 非零 byteOffset 的视图', () => {
    const padded = Buffer.concat([Buffer.from([0xaa, 0xbb, 0xcc]), fixture.file]);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 3, fixture.file.length);
    const { audio } = parseNcm(view);
    assert(audio.equals(fixture.audio), 'Uint8Array 解析结果不一致');
  });

  await test('原地解密（文档化行为）：返回的 audio 是输入 Buffer 的视图', () => {
    const inplace = buildFixture();
    const before = Buffer.from(inplace.file);
    const { audio } = parseNcm(inplace.file);
    assertEqual(audio.buffer, inplace.file.buffer, 'audio 应共享输入 Buffer 的底层内存');
    assert(audio.length > 0, '音频为空');
    assert(!inplace.file.subarray(inplace.file.length - audio.length).equals(before.subarray(before.length - audio.length)), '输入 Buffer 的音频区应已被原地解密');
  });

  await test('元数据损坏不影响音频解密（走文件名兜底）', () => {
    const broken = buildFixture({ rawMetadataArea: xor(Buffer.from(TEST_META_PREFIX, 'latin1'), 0x63) });
    const { info, audio } = parseNcm(Buffer.from(broken.file), { fileName: '断桥残雪 - 许嵩.ncm' });
    assertEqual(info.musicName, '断桥残雪 - 许嵩', '文件名兜底标题');
    assertEqual(info.format, 'mp3', '从音频魔数推断格式');
    assert(audio.equals(broken.audio), '音频仍然正确');
    assert(info.raw && typeof info.raw === 'object', 'raw 存在');
    assert(typeof info.raw.error === 'string', 'raw.error 记录了元数据失败原因');
  });

  await test('元数据声明 flac 但音频是 fLaC（优先采信魔数）', () => {
    const flacAudio = Buffer.concat([Buffer.from('fLaC', 'latin1'), patternBuffer(4096, 11)]);
    const flac = buildFixture({ audio: flacAudio, meta: { musicName: 'FLAC', format: 'mp3', duration: 500 } });
    const { info } = parseNcm(Buffer.from(flac.file));
    assertEqual(info.format, 'flac', 'format');
  });

  await test('元数据声明格式用于非 mp3/flac 魔数（如 m4a/aac）', () => {
    const adts = buildFixture({
      audio: Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), patternBuffer(512, 13)]),
      meta: { musicName: 'AAC', format: 'aac' },
    });
    const { info } = parseNcm(Buffer.from(adts.file));
    assertEqual(info.format, 'aac', 'format 来自元数据');
  });

  // -------- 2. isNcm / 错误路径 --------
  section('isNcm 与错误路径');

  await test('isNcm: 合法 NCM 为 true', () => {
    assertEqual(isNcm(fixture.file), true, 'isNcm(fixture)');
  });
  await test('isNcm: 非 NCM 为 false', () => {
    assertEqual(isNcm(Buffer.from('hello world, not a ncm file', 'latin1')), false, 'isNcm(text)');
    assertEqual(isNcm(Buffer.alloc(0)), false, 'isNcm(empty)');
    assertEqual(isNcm(Buffer.from('CTENFDA', 'latin1')), false, 'isNcm(7字节)');
    assertEqual(isNcm(null), false, 'isNcm(null)');
    assertEqual(isNcm(undefined), false, 'isNcm(undefined)');
    assertEqual(isNcm({}), false, 'isNcm({})');
  });

  await test('非 NCM 文件 → NCM_INVALID_HEADER', () => {
    const error = assertNcmError(() => parseNcm(Buffer.from('this is definitely not a ncm file')), 'NCM_INVALID_HEADER', '文本文件');
    assert(error instanceof NcmError, '应是 NcmError 实例');
  });

  await test('空 Buffer → NCM_INVALID_HEADER', () => {
    assertNcmError(() => parseNcm(Buffer.alloc(0)), 'NCM_INVALID_HEADER', '空文件');
  });

  await test('非 Buffer 输入 → NCM_INVALID_HEADER', () => {
    assertNcmError(() => parseNcm('CTENFDAM'), 'NCM_INVALID_HEADER', '字符串输入');
    assertNcmError(() => parseNcm({}), 'NCM_INVALID_HEADER', '对象输入');
  });

  await test('只有魔数（8 字节）→ NCM_TRUNCATED', () => {
    assertNcmError(() => parseNcm(Buffer.from(NCM_MAGIC, 'latin1')), 'NCM_TRUNCATED', '仅魔数');
  });

  await test('截断在 keyLen 之后 → NCM_TRUNCATED', () => {
    assertNcmError(() => parseNcm(fixture.file.subarray(0, 12)), 'NCM_TRUNCATED', 'keyLen 后');
  });

  await test('截断在密钥区中间 → NCM_TRUNCATED', () => {
    assertNcmError(() => parseNcm(fixture.file.subarray(0, 100)), 'NCM_TRUNCATED', '密钥区中');
  });

  await test('截断在元数据区中间 → NCM_TRUNCATED', () => {
    const keyLength = fixture.file.readUInt32LE(10);
    const metaStart = 10 + 4 + keyLength + 4;
    const metaLength = fixture.file.readUInt32LE(metaStart - 4);
    assert(metaLength > 40, '夹具元数据区应足够大');
    const cut = metaStart + Math.floor(metaLength / 2);
    assertNcmError(() => parseNcm(fixture.file.subarray(0, cut)), 'NCM_TRUNCATED', '元数据区中');
  });

  await test('image_space 声称大于文件实际长度 → NCM_TRUNCATED', () => {
    // 布局：magic(8) + interval(2) + keyLen(4) + key + metaLen(4) + meta
    //       + crc(4) + 间隔字节(1) + image_space(4) + image_size(4) + 封面 + 音频
    const copy = Buffer.from(fixture.file);
    const keyLength = copy.readUInt32LE(10);
    const metaLength = copy.readUInt32LE(10 + 4 + keyLength);
    const imageSpaceOffset = 10 + 4 + keyLength + 4 + metaLength + 4 + 1;
    copy.writeUInt32LE(copy.length, imageSpaceOffset); // 声称封面区比整个文件还大
    assertNcmError(() => parseNcm(copy), 'NCM_TRUNCATED', '封面越界');
  });

  await test('密钥区损坏 → NCM_BAD_CRYPT', () => {
    const copy = Buffer.from(fixture.file);
    copy[14 + 3] ^= 0xff; // 破坏密钥区密文
    assertNcmError(() => parseNcm(copy), 'NCM_BAD_CRYPT', '密钥区损坏');
  });

  await test('密钥区长度非法（非 16 倍数）→ NCM_BAD_CRYPT', () => {
    const copy = Buffer.from(fixture.file);
    copy.writeUInt32LE(15, 10); // keyLen=15
    assertNcmError(() => parseNcm(copy), 'NCM_BAD_CRYPT', 'keyLen=15');
  });

  await test('元数据损坏 + 音频无魔数 → NCM_UNSUPPORTED', () => {
    const noMetaNoMagic = buildFixture({
      meta: null,
      audio: patternBuffer(2048, 17), // 无 ID3 / fLaC / 帧同步
    });
    assertNcmError(() => parseNcm(Buffer.from(noMetaNoMagic.file)), 'NCM_UNSUPPORTED', '格式不可判定');
  });

  await test('没有音频数据 → NCM_TRUNCATED', () => {
    const empty = buildFixture({ meta: { musicName: 'x' }, audio: Buffer.alloc(0), cover: null });
    assertNcmError(() => parseNcm(Buffer.from(empty.file)), 'NCM_TRUNCATED', '空音频');
  });

  // -------- 3. suggestFileName --------
  section('suggestFileName');

  await test('歌手数组 + 歌名 → "歌手 - 歌名.扩展名"', () => {
    assertEqual(suggestFileName({ musicName: '夜曲', artist: ['周杰伦'], format: 'mp3' }), '周杰伦 - 夜曲.mp3', '文件名');
  });
  await test('多位歌手按 ", " 连接', () => {
    assertEqual(
      suggestFileName({ musicName: '雨停时分', artist: ['The 1999', 'Tim Condor'], format: 'flac' }),
      'The 1999, Tim Condor - 雨停时分.flac',
      '多歌手',
    );
  });
  await test('显式 format 优先于 info.format', () => {
    assertEqual(suggestFileName({ musicName: 'x', artist: ['a'], format: 'mp3' }, 'flac'), 'a - x.flac', '显式格式');
  });
  await test('清洗 Windows 非法字符', () => {
    const name = suggestFileName({ musicName: 'a<b>:c"d/e\\f|g?h*', artist: ['i'], format: 'mp3' });
    assert(!/[<>:"/\\|?*]/.test(name), `文件名仍含非法字符: ${name}`);
    assertEqual(name, 'i - a_b__c_d_e_f_g_h_.mp3', '清洗结果');
  });
  await test('无歌手时只用歌名', () => {
    assertEqual(suggestFileName({ musicName: '纯音乐' }), '纯音乐.mp3', '默认扩展名 mp3');
  });
  await test('空元数据 → unknown.mp3', () => {
    assertEqual(suggestFileName({}), 'unknown.mp3', '空信息');
  });
  await test('Windows 保留名加前缀', () => {
    assertEqual(suggestFileName({ musicName: 'CON' }), '_CON.mp3', '保留名');
  });
  await test('超长标题截断到 200 字符以内', () => {
    const name = suggestFileName({ musicName: '长'.repeat(500), artist: ['歌手'] });
    assert(name.length <= 204, `文件名过长: ${name.length}`);
    assert(name.endsWith('.mp3'), '扩展名应保留');
  });
  await test('结尾点 / 空格被去掉', () => {
    const name = suggestFileName({ musicName: '歌名. ', artist: [] });
    assertEqual(name, '歌名.mp3', '结尾点空格');
  });

  // -------- 4. 真实文件测试 --------
  if (QUICK) {
    console.log('\n(quick 模式：跳过真实文件测试)');
  } else {
    section('真实文件发现');
    const realFiles = discoverRealFiles();
    console.log(`  发现 ${realFiles.length} 个真实 .ncm 文件：`);
    for (const file of realFiles) console.log(`    - ${file.name} (${mb(file.size)} MB) ← ${file.dir}`);
    await test('至少发现 3 个真实 .ncm 文件', () => {
      assert(realFiles.length >= 3, `只发现 ${realFiles.length} 个真实 .ncm 文件`);
    });

    // 选代表性文件：小 mp3、PNG 封面 mp3、大 flac
    const mp3File = realFiles.find((f) => /エガクミライ/.test(f.name)) || realFiles.find((f) => f.size < 12 * 1048576);
    const pngCoverFile = realFiles.find((f) => /睡眠音乐催眠曲/.test(f.name)) || mp3File;
    const flacFile = realFiles.find((f) => /On My Own/.test(f.name)) || realFiles.find((f) => f.size > 50 * 1048576);

    // -------- 真实文件的错误路径（验收要求 4：非 NCM / 截断） --------
    section('真实文件错误路径');
    await test(`真实文件截断 → NCM_TRUNCATED（${mp3File?.name}）`, () => {
      assert(mp3File, '找不到真实的 mp3 样本');
      const buf = readFileSync(mp3File.path);
      // 1) 截在 NCM 头部/密钥区中间：真实文件前 64 字节
      assertNcmError(() => parseNcm(buf.subarray(0, 64), { fileName: mp3File.name }), 'NCM_TRUNCATED', '真实文件截断到 64 字节');
      // 2) 截在音频起始处（封面之后）：此时音频为 0 字节
      const audioStart = audioStartOffset(buf);
      assert(audioStart > 0 && audioStart <= buf.length, `无法定位音频起始偏移: ${audioStart}`);
      assertNcmError(() => parseNcm(buf.subarray(0, audioStart), { fileName: mp3File.name }), 'NCM_TRUNCATED', '真实文件截到音频前');
    });

    await test('真实非 NCM 文件 → NCM_INVALID_HEADER', () => {
      // 真实目录里与 .ncm 同名的原始 .mp3，是天然的非 NCM 真实文件
      const siblingMp3 = realFiles
        .map((file) => join(file.dir, file.name.replace(/\.ncm$/i, '.mp3')))
        .find((candidate) => existsSync(candidate));
      assert(siblingMp3, '找不到用于对照的真实非 NCM 文件（同名 .mp3）');
      const buf = readFileSync(siblingMp3);
      assertEqual(isNcm(buf), false, 'isNcm(真实 mp3)');
      const error = assertNcmError(() => parseNcm(buf.subarray(0, Math.min(buf.length, 65536)), { fileName: siblingMp3 }), 'NCM_INVALID_HEADER', '真实 mp3 文件');
      assert(error instanceof NcmError, '应是 NcmError 实例');
    });

    section('真实文件断言（mp3 / flac / 封面）');
    await test(`真实 mp3 文件：元数据非空且字段完整（${mp3File?.name}）`, () => {
      assert(mp3File, '找不到 mp3 样本');
      const buf = readFileSync(mp3File.path);
      const t0 = performance.now();
      const { info, audio, cover } = parseNcm(buf, { fileName: mp3File.name });
      const elapsed = performance.now() - t0;
      assert(info.musicName.trim().length > 0, 'musicName 为空');
      assert(info.artist.length > 0, 'artist 为空');
      assert(info.album.trim().length > 0, 'album 为空');
      assert(info.duration > 0, 'duration 为空');
      assert(info.bitrate > 0, 'bitrate 为空');
      assertEqual(info.format, 'mp3', 'format');
      assertEqual(sniffAudioLib(audio), 'mp3', '音频魔数');
      assert(audio.length > 1048576, '音频过小');
      assert(cover, '封面缺失');
      assert(cover.format === 'jpg' || cover.format === 'png', `封面格式异常: ${cover.format}`);
      assertEqual(sniffImageLib(cover.data), cover.format, '封面魔数');
      assert(elapsed < 5000, `解析耗时异常: ${elapsed.toFixed(0)}ms`);
      smokeRows.push({ name: mp3File.name, size: mp3File.size, format: info.format, audioSize: audio.length, ms: elapsed, cover: cover?.format || '-', musicName: info.musicName, artist: info.artist.join(','), ok: true });
      console.log(`        解析 ${mb(mp3File.size)}MB 用时 ${elapsed.toFixed(0)}ms，音频 ${mb(audio.length)}MB`);
    });

    await test(`真实 PNG 封面文件：封面格式与魔数正确（${pngCoverFile?.name}）`, () => {
      assert(pngCoverFile, '找不到 PNG 封面样本');
      const buf = readFileSync(pngCoverFile.path);
      const { info, cover } = parseNcm(buf, { fileName: pngCoverFile.name });
      assert(cover, '封面缺失');
      assertEqual(sniffImageLib(cover.data), cover.format, '封面魔数');
      assert(cover.data.length > 1000, '封面尺寸过小');
      assertEqual(info.format, 'mp3', 'format');
    });

    await test(`真实 flac 文件：fLaC 魔数 + 元数据非空（${flacFile?.name}）`, () => {
      assert(flacFile, '找不到 flac 样本');
      const buf = readFileSync(flacFile.path);
      const t0 = performance.now();
      const { info, audio, cover } = parseNcm(buf, { fileName: flacFile.name });
      const elapsed = performance.now() - t0;
      assertEqual(info.format, 'flac', 'format');
      assertEqual(sniffAudioLib(audio), 'flac', '音频魔数');
      assert(info.musicName.trim().length > 0, 'musicName 为空');
      assert(info.artist.length > 0, 'artist 为空');
      assert(info.duration > 0, 'duration 为空');
      assert(info.bitrate > 0, 'bitrate 为空');
      assert(audio.length > 10 * 1048576, 'flac 音频过小');
      assert(cover, '封面缺失');
      assert(elapsed < 5000, `解析耗时异常: ${elapsed.toFixed(0)}ms`);
      smokeRows.push({ name: flacFile.name, size: flacFile.size, format: info.format, audioSize: audio.length, ms: elapsed, cover: cover?.format || '-', musicName: info.musicName, artist: info.artist.join(','), ok: true });
      console.log(`        解析 ${mb(flacFile.size)}MB 用时 ${elapsed.toFixed(0)}ms，音频 ${mb(audio.length)}MB`);
    });

    // 解码产物落盘 + 再次校验（证明可以正常写出文件）
    section('解码产物落盘');
    mkdirSync(DECODED_DIR, { recursive: true });
    const toSave = [mp3File, pngCoverFile, flacFile].filter(Boolean);
    /** @type {Map<string, {path: string, size: number}>} */
    const savedFiles = new Map();
    for (const sample of toSave) {
      await test(`保存解码输出：${sample.name} → ${suggestFileName(parseNcm(readFileSync(sample.path), { fileName: sample.name }).info)}`, () => {
        const buf = readFileSync(sample.path);
        const { info, audio } = parseNcm(buf, { fileName: sample.name });
        const fileName = suggestFileName(info);
        const outPath = join(DECODED_DIR, fileName);
        writeFileSync(outPath, audio);
        const written = statSync(outPath);
        assertEqual(written.size, audio.length, '写盘字节数');
        savedFiles.set(sample.path, { path: outPath, size: written.size });
        console.log(`        ${outPath} (${mb(written.size)}MB)`);
      });
    }
    writeFileSync(join(OUT_DIR, 'saved-files.json'), JSON.stringify([...savedFiles.values()], null, 2), 'utf8');

    // -------- 5. 批量冒烟 --------
    section('真实文件批量冒烟');
    const rows = [];
    for (const file of realFiles) {
      let row;
      try {
        const t0 = performance.now();
        const buf = readFileSync(file.path);
        const parsed = parseNcm(buf, { fileName: file.name });
        const elapsed = performance.now() - t0;
        row = {
          name: file.name,
          path: file.path,
          size: file.size,
          format: parsed.info.format,
          audioSize: parsed.audio.length,
          ms: elapsed,
          cover: parsed.cover ? parsed.cover.format : '-',
          musicName: parsed.info.musicName,
          artist: parsed.info.artist.join(','),
          ok: true,
        };
        console.log(`  ${elapsed.toFixed(0).padStart(5)}ms  ${mb(file.size).padStart(7)}MB  ${parsed.info.format.padEnd(4)}  ${(parsed.cover ? parsed.cover.format : '-').padEnd(4)}  ${file.name}`);
      } catch (error) {
        row = { name: file.name, path: file.path, size: file.size, format: '-', audioSize: 0, ms: 0, cover: '-', musicName: '', artist: '', ok: false, error: error instanceof Error ? error.message : String(error) };
        console.log(`  FAIL  ${file.name}: ${row.error}`);
      }
      rows.push(row);
      smokeRows.push(row);
    }
    writeFileSync(join(OUT_DIR, 'smoke-rows.json'), JSON.stringify(smokeRows, null, 2), 'utf8');

    await test(`全部 ${rows.length} 个真实 .ncm 批量冒烟成功`, () => {
      const bad = rows.filter((row) => !row.ok);
      assertEqual(bad.length, 0, `失败文件: ${bad.map((row) => row.name).join(', ')}`);
    });

    await test('每个真实文件都能解出 mp3/flac 音频且魔数正确', () => {
      for (const row of rows) {
        assert(row.audioSize > 0, `${row.name}: 音频为空`);
        assert(['mp3', 'flac'].includes(row.format), `${row.name}: format=${row.format}`);
        // 解出后回读一次音频头，确保与 format 一致
        const parsed = parseNcm(readFileSync(row.path), { fileName: row.name });
        const sniffed = sniffAudioLib(parsed.audio);
        assertEqual(sniffed, row.format, `${row.name}: 音频魔数与 format 不一致`);
      }
    });

    const largeFiles = rows.filter((row) => row.size >= 70 * 1048576);
    await test(`大文件（≥70MB）单文件耗时 < 10s`, () => {
      assert(largeFiles.length >= 2, `大文件样本不足: ${largeFiles.length}`);
      for (const row of largeFiles) {
        assert(row.ok, `${row.name}: 解析失败`);
        assert(row.ms < 10000, `${row.name}: ${row.ms.toFixed(0)}ms ≥ 10000ms`);
        console.log(`        ${row.name} (${mb(row.size)}MB) ${row.ms.toFixed(0)}ms`);
      }
    });
  }

  // -------- 报告 --------
  section('汇总');
  writeFileSync(join(OUT_DIR, 'smoke-rows.json'), JSON.stringify(smokeRows, null, 2), 'utf8');
  writeFileSync(
    join(OUT_DIR, 'report.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.version,
        passed,
        failed,
        failures,
        files: smokeRows,
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(OUT_DIR, 'report.md'), buildMarkdownReport(), 'utf8');

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.log('\n失败用例：');
    for (const failure of failures) console.log(`  - ${failure.name}\n    ${failure.message}`);
    process.exit(1);
  }
  console.log('全部测试通过 ✔');
  process.exit(0);
}

/**
 * 生成 Markdown 报告（供 Lead 汇总 / 交付物展示）。
 * @returns {string}
 */
function buildMarkdownReport() {
  const ok = smokeRows.filter((row) => row.ok);
  const lines = [
    '# dsh-ncm2mp3 真实文件测试报告',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- Node：${process.version}`,
    '- 测试命令：`node test/run-tests.mjs`',
    '',
    '| 文件 | 大小(MB) | format | 音频(MB) | 耗时(ms) | 封面 | 歌曲名 | 结果 |',
    '| --- | ---: | --- | ---: | ---: | --- | --- | --- |',
  ];
  for (const row of smokeRows) {
    const size = (row.size / 1048576).toFixed(2);
    const audioSize = (row.audioSize / 1048576).toFixed(2);
    lines.push(
      `| ${row.name} | ${size} | ${row.format} | ${audioSize} | ${row.ms.toFixed(0)} | ${row.cover} | ${row.musicName.replace(/\|/g, '\\|')} | ${row.ok ? 'PASS' : 'FAIL: ' + (row.error || '')} |`,
    );
  }
  lines.push('', `- 批量冒烟：${ok.length}/${smokeRows.length} 通过`);
  const large = smokeRows.filter((row) => row.size >= 70 * 1048576);
  if (large.length > 0) {
    lines.push(`- 大文件：${large.map((row) => `${row.name} ${(row.size / 1048576).toFixed(1)}MB → ${row.ms.toFixed(0)}ms`).join('；')}`);
  }
  lines.push('', `- 断言统计：通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length > 0) {
    lines.push('', '## 失败用例');
    for (const failure of failures) lines.push(`- ${failure.name}: ${failure.message}`);
  }
  lines.push('');
  return lines.join('\n');
}

main().catch((error) => {
  console.error('测试套件自身崩溃：', error);
  process.exit(2);
});
