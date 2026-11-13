/**
 * dsh-ncm2mp3 — 纯 JS NCM 解码模块（零依赖，仅使用 node:crypto）
 *
 * NCM 是网易云音乐客户端的加密音频容器。解密后得到原始音频（MP3 / FLAC），
 * 不做任何转码。本模块只负责解析与解密，不触碰文件系统。
 *
 * 用法：
 *
 *   import { parseNcm, isNcm, NcmError, suggestFileName } from './lib/ncm.js';
 *
 *   const buf = readFileSync('song.ncm');           // Buffer
 *   const { info, audio, cover } = parseNcm(buf);  // audio 是输入 Buffer 的视图
 *   writeFileSync(suggestFileName(info), audio);
 *
 * 注意：parseNcm() 为了性能会**原地解密**传入 Buffer 中音频区的字节，
 * 返回的 audio / cover.data 都是同一个输入 Buffer 的 subarray 视图，不额外拷贝。
 * 如果调用方还需要原始密文，请先自行备份。
 *
 * @module dsh-ncm2mp3/lib/ncm
 */

import { createDecipheriv } from 'node:crypto';

/** NCM 文件头魔数 */
export const NCM_MAGIC = 'CTENFDAM';

/**
 * NcmError 的错误码（供调用方 switch / 映射本地化文案）
 * @readonly
 * @enum {string}
 */
export const NCM_ERROR_CODES = Object.freeze({
  /** 不是 NCM 文件（文件头不是 CTENFDAM，或输入不是 Buffer） */
  INVALID_HEADER: 'NCM_INVALID_HEADER',
  /** 结构不可识别 / 音频格式既无法从元数据也无法从魔数判定 */
  UNSUPPORTED: 'NCM_UNSUPPORTED',
  /** 文件被截断，读取越界 */
  TRUNCATED: 'NCM_TRUNCATED',
  /** 密钥区 / 元数据区 AES 解密失败（文件损坏） */
  BAD_CRYPT: 'NCM_BAD_CRYPT',
});

// ==== NCM 内部常量（见 docs/ncm-spec.md） ==================================

/** 密钥区 AES-128-ECB 密钥 */
const KEY_AREA_AES_KEY = Buffer.from([
  0x68, 0x7a, 0x48, 0x52, 0x41, 0x6d, 0x73, 0x6f, 0x35, 0x6b, 0x49, 0x6e, 0x62, 0x61, 0x78, 0x57,
]);

/** 元数据区 AES-128-ECB 密钥 */
const META_AREA_AES_KEY = Buffer.from([
  0x23, 0x31, 0x34, 0x6c, 0x6a, 0x6b, 0x5f, 0x21, 0x5c, 0x5d, 0x26, 0x30, 0x55, 0x3c, 0x27, 0x28,
]);

/** 密钥区解密结果的前缀（17 字节），其后是 RC4 密钥 */
const KEY_AREA_PREFIX = Buffer.from('neteasecloudmusic', 'latin1');
const KEY_AREA_PREFIX_LEN = KEY_AREA_PREFIX.length;

/** Windows 文件名非法字符（含控制字符） */
const WINDOWS_ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// ==== 错误类型 =============================================================

/**
 * NCM 解码错误。`code` 取值见 {@link NCM_ERROR_CODES}。
 */
export class NcmError extends Error {
  /**
   * @param {string} code 错误码（NCM_INVALID_HEADER | NCM_UNSUPPORTED | NCM_TRUNCATED | NCM_BAD_CRYPT）
   * @param {string} [message] 人类可读说明
   * @param {unknown} [cause] 底层异常
   */
  constructor(code, message, cause) {
    super(message || code);
    this.name = 'NcmError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

// ==== 基础工具 =============================================================

/**
 * 接受 Buffer / Uint8Array，返回零拷贝的 Buffer 视图。
 * @param {Buffer | Uint8Array} input
 * @returns {Buffer}
 */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new NcmError(NCM_ERROR_CODES.INVALID_HEADER, 'parseNcm() 需要 Buffer 或 Uint8Array');
}

/**
 * 断言 buf 在 [offset, offset+length) 范围内可读，否则抛 NCM_TRUNCATED。
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} length
 * @param {string} what 读取内容描述（用于错误信息）
 */
function need(buf, offset, length, what) {
  if (offset < 0 || length < 0 || offset + length > buf.length) {
    throw new NcmError(
      NCM_ERROR_CODES.TRUNCATED,
      `文件不完整：读取 ${what} 需要 ${length} 字节（偏移 ${offset}），但文件只有 ${buf.length} 字节`,
    );
  }
}

/**
 * 读取小端 uint32。
 * @param {Buffer} buf
 * @param {number} offset
 * @param {string} what
 * @returns {number}
 */
function readUInt32(buf, offset, what) {
  need(buf, offset, 4, what);
  return buf.readUInt32LE(offset);
}

/**
 * 逐字节 XOR（原地）。
 * @param {Buffer} buf
 * @param {number} byte
 */
function xorInPlace(buf, byte) {
  for (let i = 0; i < buf.length; i++) buf[i] ^= byte;
}

/**
 * 手动去除 PKCS#7 填充（比 setAutoPadding(true) 更宽容）。
 * 如果尾部不是合法填充则原样返回。
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function stripPkcs7(buf) {
  if (buf.length === 0) return buf;
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 16 || pad > buf.length) return buf;
  for (let i = buf.length - pad; i < buf.length; i++) {
    if (buf[i] !== pad) return buf;
  }
  return buf.subarray(0, buf.length - pad);
}

/**
 * AES-128-ECB 解密（不自动去填充，由调用方手动处理）。
 * @param {Buffer} cipher 密文，长度必须是 16 的倍数
 * @param {Buffer} key 16 字节密钥
 * @returns {Buffer}
 */
function aesEcbDecrypt(cipher, key) {
  if (cipher.length === 0 || cipher.length % 16 !== 0) {
    throw new NcmError(
      NCM_ERROR_CODES.BAD_CRYPT,
      `AES-128-ECB 密文长度非法：${cipher.length}（必须是 16 的正整数倍）`,
    );
  }
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(cipher), decipher.final()]);
  } catch (error) {
    throw new NcmError(
      NCM_ERROR_CODES.BAD_CRYPT,
      `AES-128-ECB 解密失败：${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

// ==== 魔数识别 =============================================================

/**
 * 判断 Buffer 是否以 NCM 魔数开头。
 * @param {Buffer | Uint8Array | null | undefined} input
 * @returns {boolean}
 */
export function isNcm(input) {
  if (!input || typeof input.length !== 'number') return false;
  if (input.length < NCM_MAGIC.length) return false;
  for (let i = 0; i < NCM_MAGIC.length; i++) {
    if (input[i] !== NCM_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 根据解密后的音频首字节判断格式。
 * @param {Buffer} audio
 * @returns {'mp3' | 'flac' | 'ogg' | null}
 */
function sniffAudioFormat(audio) {
  if (!audio || audio.length < 4) return null;
  if (audio[0] === 0x66 && audio[1] === 0x4c && audio[2] === 0x61 && audio[3] === 0x43) {
    return 'flac'; // 'fLaC'
  }
  if (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) {
    return 'mp3'; // 'ID3' 标签（MP3 / 少数带 ID3 的 FLAC 都可能）
  }
  if (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) {
    return 'mp3'; // MPEG 帧同步 0xFF 0xEx / 0xFx
  }
  if (audio[0] === 0x4f && audio[1] === 0x67 && audio[2] === 0x67 && audio[3] === 0x53) {
    return 'ogg'; // 'OggS'（NCM 极少出现，仅作兜底）
  }
  return null;
}

/**
 * 识别封面图格式。
 * @param {Buffer} data
 * @returns {'jpg' | 'png' | 'webp' | null}
 */
function sniffImageFormat(data) {
  if (!data || data.length < 4) return null;
  if (data.length >= 3 && data[0] === JPEG_MAGIC[0] && data[1] === JPEG_MAGIC[1] && data[2] === JPEG_MAGIC[2]) {
    return 'jpg';
  }
  if (data[0] === PNG_MAGIC[0] && data[1] === PNG_MAGIC[1] && data[2] === PNG_MAGIC[2] && data[3] === PNG_MAGIC[3]) {
    return 'png';
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && // 'RIFF'
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50 // 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

// ==== 密钥区 / 元数据区解密 =================================================

/**
 * 解密密钥区，得到 RC4 密钥（key box 种子）。
 * @param {Buffer} keyData 原始密钥区字节（未 XOR）
 * @returns {Buffer} RC4 密钥
 */
function decryptKeyArea(keyData) {
  if (keyData.length === 0) {
    throw new NcmError(NCM_ERROR_CODES.BAD_CRYPT, '密钥区长度为 0');
  }
  const cipher = Buffer.from(keyData); // 小对象，拷贝后原地 XOR，不动输入
  xorInPlace(cipher, 0x64);

  const plain = stripPkcs7(aesEcbDecrypt(cipher, KEY_AREA_AES_KEY));
  const prefixIndex = plain.indexOf(KEY_AREA_PREFIX);
  if (prefixIndex < 0) {
    throw new NcmError(
      NCM_ERROR_CODES.BAD_CRYPT,
      '密钥区解密结果缺少 "neteasecloudmusic" 前缀，文件可能已损坏',
    );
  }
  const key = plain.subarray(prefixIndex + KEY_AREA_PREFIX_LEN);
  if (key.length === 0) {
    throw new NcmError(NCM_ERROR_CODES.BAD_CRYPT, '密钥区解密后 RC4 密钥为空');
  }
  return key;
}

/**
 * 在解密文本中提取 JSON 对象。
 * @param {string} text
 * @returns {object | null}
 */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * 解密元数据区。任何失败都**不抛异常**，返回 { json: null, error }，
 * 让 parseNcm 可以用空元数据 + 文件名兜底继续解音频。
 * @param {Buffer} metaData 原始元数据区字节（未 XOR）
 * @returns {{ json: object | null, error: string | null }}
 */
function decryptMetadata(metaData) {
  try {
    if (!metaData || metaData.length === 0) {
      return { json: null, error: '元数据区为空' };
    }
    const data = Buffer.from(metaData);
    xorInPlace(data, 0x63);
    const text = data.toString('latin1');

    // 变体 A：少数文件元数据直接是明文 JSON / "music:{...}"（已被二次处理）
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('music:')) {
      return { json: extractJson(trimmed), error: null };
    }

    // 标准格式：明文 "163 key(Don't modify):" + base64(AES 密文)。
    // base64 字母表不含 ':'，因此按最后一个 ':' 切分即可（不写死 22 字节）。
    const colon = text.lastIndexOf(':');
    const rawPayload = (colon >= 0 ? text.slice(colon + 1) : text).replace(/[\s\u0000]+/g, '');
    if (rawPayload.length === 0) {
      return { json: null, error: '元数据区没有找到密文' };
    }

    let cipher = null;
    if (rawPayload.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(rawPayload)) {
      cipher = Buffer.from(rawPayload, 'base64');
    } else {
      // 变体 B：payload 是裸密文字节（非 base64 包装）
      const raw = Buffer.from(rawPayload, 'latin1');
      if (raw.length >= 16 && raw.length % 16 === 0) cipher = raw;
    }
    if (!cipher || cipher.length === 0 || cipher.length % 16 !== 0) {
      return { json: null, error: '元数据密文不是合法的 base64 / AES 数据' };
    }

    const plain = stripPkcs7(aesEcbDecrypt(cipher, META_AREA_AES_KEY));
    const json = extractJson(plain.toString('utf8'));
    if (!json) return { json: null, error: '元数据解密后不含 JSON 对象' };
    return { json, error: null };
  } catch (error) {
    return {
      json: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ==== 音频流解密（key box XOR） =============================================

/**
 * 用 RC4 密钥构造 256 字节置换盒。
 * @param {Buffer} key RC4 密钥
 * @returns {Uint8Array} 置换盒
 */
function buildKeyBox(key) {
  const keyBox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) keyBox[i] = i;
  let c = 0;
  let last = 0;
  let keyOffset = 0;
  for (let i = 0; i < 256; i++) {
    const swap = keyBox[i];
    c = (swap + last + key[keyOffset]) & 0xff;
    keyOffset = (keyOffset + 1) % key.length;
    keyBox[i] = keyBox[c];
    keyBox[c] = swap;
    last = c;
  }
  return keyBox;
}

/**
 * 由置换盒推导出 256 字节循环密钥流。
 * 原公式中 i 字节的密钥流只依赖 j = (i + 1) & 0xff，
 * 因此密钥流周期为 256，可以预计算后直接复用。
 * @param {Uint8Array} keyBox
 * @returns {Uint8Array} 长度 256 的密钥流，用 ks[i & 0xff] 与第 i 字节 XOR
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
 * 原地解密音频流（XOR 可逆，加解密同一函数）。
 * 使用 8 路展开 + 预计算密钥流，100MB 级文件也在亚秒级完成。
 * @param {Buffer} audio 待解密音频（会被原地修改）
 * @param {Buffer} rc4Key 密钥区解出的 RC4 密钥
 */
function decryptAudioInPlace(audio, rc4Key) {
  const ks = buildKeyStream(buildKeyBox(rc4Key));
  const length = audio.length;
  const bulkEnd = length - (length % 8);
  let i = 0;
  for (; i < bulkEnd; i += 8) {
    audio[i] ^= ks[i & 0xff];
    audio[i + 1] ^= ks[(i + 1) & 0xff];
    audio[i + 2] ^= ks[(i + 2) & 0xff];
    audio[i + 3] ^= ks[(i + 3) & 0xff];
    audio[i + 4] ^= ks[(i + 4) & 0xff];
    audio[i + 5] ^= ks[(i + 5) & 0xff];
    audio[i + 6] ^= ks[(i + 6) & 0xff];
    audio[i + 7] ^= ks[(i + 7) & 0xff];
  }
  for (; i < length; i++) audio[i] ^= ks[i & 0xff];
}

// ==== 元数据归一化 =========================================================

/**
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * 把元数据里的 artist 统一成字符串数组。
 * NCM 常见形式：["歌手"]、["歌手", 123]、[["歌手", id], ...]。
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeArtist(value) {
  /** @type {string[]} */
  const names = [];
  /** @param {unknown} item */
  const push = (item) => {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) names.push(name);
      return;
    }
    if (Array.isArray(item) && typeof item[0] === 'string') {
      const name = item[0].trim();
      if (name) names.push(name);
      return;
    }
    if (item && typeof item === 'object' && typeof item.name === 'string') {
      const name = item.name.trim();
      if (name) names.push(name);
    }
  };
  if (Array.isArray(value)) {
    for (const item of value) push(item);
  } else if (typeof value === 'string') {
    push(value);
  }
  return names;
}

/**
 * 从原始 JSON 中提取歌词（NCM 元数据通常不带歌词，ncmdump 类工具会联网补；
 * 这里只做本地提取，取不到就是 null）。
 * @param {Record<string, unknown>} raw
 * @returns {string | null}
 */
function extractLyrics(raw) {
  const candidates = [raw.lyric, raw.lyrics, raw.lyricText];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() && candidate.trim() !== '无歌词') {
      return candidate;
    }
  }
  return null;
}

/**
 * 把元数据 JSON 归一化为对外 NcmInfo。
 * @param {{ json: object | null, error: string | null }} metaResult
 * @param {{ fileName?: string }} options
 * @param {Buffer} audio 已解密的音频
 * @returns {object}
 */
function buildInfo(metaResult, options, audio) {
  const raw = metaResult.json && typeof metaResult.json === 'object' ? metaResult.json : {};
  const declaredFormat = normalizeFormat(raw.format);
  const sniffedFormat = sniffAudioFormat(audio);

  /** @type {string | null} */
  let format = null;
  if (sniffedFormat === 'flac') {
    // 'fLaC' 魔数具有排他性，优先采信
    format = 'flac';
  } else if (declaredFormat) {
    format = declaredFormat;
  } else if (sniffedFormat) {
    format = sniffedFormat;
  }
  if (!format) {
    throw new NcmError(
      NCM_ERROR_CODES.UNSUPPORTED,
      '无法识别音频格式：元数据缺失/无 format 字段，且音频首字节不是 mp3/flac 魔数',
    );
  }

  const fallbackName = deriveNameFromFileName(options.fileName);
  const musicName = str(raw.musicName) || str(raw.songName) || fallbackName || '';

  return {
    format,
    musicName,
    artist: normalizeArtist(raw.artist),
    album: str(raw.album) || str(raw.albumName) || '',
    bitrate: num(raw.bitrate),
    duration: num(raw.duration),
    lyrics: extractLyrics(raw),
    raw: metaResult.json && typeof metaResult.json === 'object' ? metaResult.json : { error: metaResult.error || 'metadata_unavailable' },
  };
}

/**
 * 规范化格式名：小写、去前导点。
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeFormat(value) {
  if (typeof value !== 'string') return null;
  const format = value.trim().toLowerCase().replace(/^\./, '');
  return format || null;
}

/**
 * 从源文件名（如 "歌手 - 歌名.ncm"）推导兜底标题。
 * @param {unknown} fileName
 * @returns {string}
 */
function deriveNameFromFileName(fileName) {
  if (typeof fileName !== 'string' || !fileName) return '';
  const base = fileName.split(/[\\/]/).pop() || '';
  return base.replace(/\.ncm$/i, '').trim();
}

// ==== 对外主 API ===========================================================

/**
 * 解析 NCM Buffer，返回元数据 + 解密后的音频（+ 可选封面）。
 *
 * 性能提示：音频区是**原地解密**的，返回的 audio / cover.data 是传入 Buffer 的
 * 视图（subarray），不会额外拷贝。100MB 级文件实测 < 1s（不含磁盘 IO）。
 *
 * @param {Buffer | Uint8Array} input 整个 .ncm 文件内容
 * @param {{ fileName?: string }} [options] 仅用于元数据损坏时用文件名兜底
 * @returns {{
 *   info: {
 *     format: string,
 *     musicName: string,
 *     artist: string[],
 *     album: string,
 *     bitrate: number,
 *     duration: number,
 *     lyrics: string | null,
 *     raw: object,
 *   },
 *   audio: Buffer,
 *   cover?: { format: 'jpg' | 'png' | 'webp', data: Buffer },
 * }}
 * @throws {NcmError} NCM_INVALID_HEADER | NCM_UNSUPPORTED | NCM_TRUNCATED | NCM_BAD_CRYPT
 */
export function parseNcm(input, options = {}) {
  const buf = toBuffer(input);
  if (!isNcm(buf)) {
    throw new NcmError(
      NCM_ERROR_CODES.INVALID_HEADER,
      `不是有效的 NCM 文件：前 8 字节应为 "${NCM_MAGIC}"`,
    );
  }

  // [0, 8) magic
  // [8, 10) 固定间隔（0x01 0x70），直接跳过
  need(buf, 8, 2, '文件头间隔');
  let offset = 10;

  // 密钥区
  const keyLength = readUInt32(buf, offset, 'keyLen');
  offset += 4;
  need(buf, offset, keyLength, '密钥区数据');
  const keyData = buf.subarray(offset, offset + keyLength);
  offset += keyLength;
  const rc4Key = decryptKeyArea(keyData);

  // 元数据区
  const metaLength = readUInt32(buf, offset, 'metaLen');
  offset += 4;
  need(buf, offset, metaLength, '元数据区');
  const metaData = buf.subarray(offset, offset + metaLength);
  offset += metaLength;
  const metaResult = decryptMetadata(metaData);

  // crc32(4) 之后是 5 字节间隔区：第 1 字节固定 0x01，后 4 字节是 image_space
  // （封面区实际占用长度）；随后才是 image_size（封面图片真实字节数）。
  // 实测样本（14 个）image_space === image_size（无对齐填充），但仍按 image_space
  // 定位音频，这样遇到带填充的文件也不会错位；若个别文件 image_space < image_size，
  // 退化以 image_space 为准，避免读到音频区。
  need(buf, offset, 13, 'crc32/封面长度字段');
  offset += 4; // crc32
  offset += 1; // 间隔字节 0x01
  const imageSpace = readUInt32(buf, offset, 'imageSpace');
  offset += 4;
  let imageSize = readUInt32(buf, offset, 'imageSize');
  offset += 4;
  if (imageSpace < imageSize) imageSize = imageSpace;
  need(buf, offset, imageSpace, '封面图片数据');

  /** @type {{ format: 'jpg' | 'png' | 'webp', data: Buffer } | undefined} */
  let cover;
  if (imageSize > 0) {
    const imageData = buf.subarray(offset, offset + imageSize);
    const imageFormat = sniffImageFormat(imageData);
    if (imageFormat) {
      cover = { format: imageFormat, data: imageData };
    }
  }
  // 无法识别的封面直接丢弃，但偏移照常按 image_space 前进（兼容填充字节）
  offset += imageSpace;

  // 剩余全部是音频流
  if (offset > buf.length) {
    throw new NcmError(NCM_ERROR_CODES.TRUNCATED, `音频区偏移 ${offset} 越界（文件 ${buf.length} 字节）`);
  }
  const audio = buf.subarray(offset);
  if (audio.length === 0) {
    throw new NcmError(NCM_ERROR_CODES.TRUNCATED, 'NCM 文件没有音频数据');
  }

  decryptAudioInPlace(audio, rc4Key);

  const info = buildInfo(metaResult, options, audio);
  return cover ? { info, audio, cover } : { info, audio };
}

// ==== 文件名建议 ===========================================================

/**
 * 生成用于保存音频的文件名："歌手 - 歌名.扩展名"。
 * 会清洗 Windows 非法字符、控制字符、结尾的点/空格，并规避 CON/NUL 等保留名。
 *
 * @param {{ musicName?: string, artist?: string[] | string, format?: string }} info
 * @param {string} [format] 显式指定扩展名（优先于 info.format）
 * @returns {string}
 */
export function suggestFileName(info, format) {
  const infoObject = info && typeof info === 'object' ? info : {};
  const ext = normalizeFormat(format) || normalizeFormat(infoObject.format) || 'mp3';
  const safeExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'mp3';

  const artists = normalizeArtist(infoObject.artist);
  const title = String(infoObject.musicName || '').trim();
  let stem = artists.length > 0 ? `${artists.join(', ')} - ${title}` : title;
  stem = stem.replace(WINDOWS_ILLEGAL_CHARS, '_').replace(/\s+/g, ' ').trim();
  stem = stem.replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  if (!stem) stem = 'unknown';
  if (RESERVED_WINDOWS_NAMES.test(stem)) stem = `_${stem}`;

  // 单个文件名（UTF-16 码元）尽量不超过 200，避免 Windows 路径超限
  const maxStemLength = 200;
  if (stem.length > maxStemLength) {
    stem = stem.slice(0, maxStemLength).replace(/[. ]+$/, '');
    if (!stem) stem = 'unknown';
  }
  return `${stem}.${safeExt}`;
}
