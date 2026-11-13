# NCM 文件格式与解码规格

本文档是 `lib/ncm.js` 的实现依据。NCM 是网易云音乐客户端的加密音频容器，解密后得到原始音频（MP3 或 FLAC），**不做转码**（所以"NCM TO MP3"实际是"解密回原始格式"，原文件是 FLAC 时输出 FLAC）。

所有整数均为小端序（LE）。

## 1. 文件整体布局

```
偏移(相对当前)  内容
0             magic "CTENFDAM"（8 字节）
8             2 字节固定间隔（0x01 0x70，实现里直接跳过 2 字节）
10            uint32  keyLen
14            keyData[keyLen]：每个字节先 XOR 0x64
...           【密钥区】AES-128-ECB 解密，PKCS#7 去填充，再跳过前 17 字节 → RC4 密钥流 key
...           uint32  metaLen
...           metaData[metaLen]：每个字节 XOR 0x63
...           metaData 做 base64 解码 → 得到字符串（形如 "163 key(Don't modify):" 前缀 + 密文）
...           去掉前缀（22 字节）后 AES-128-ECB 解密，PKCS#7 去填充，再跳过前 6 字节 → JSON 元数据
              JSON 字段：{ format, musicName, artist, album, bitrate, duration, cover, lyric, ... }
...           5 字节间隔（直接跳过；其中可能包含 CRC/版本字段，解码用不到）
...           uint32  imageSpace（封面区总长度）
...           uint32  imageSize（封面图实际字节数）
...           imageData[imageSize]（封面图，通常是 JPEG；imageSize 可能为 0，表示无封面）
...           imageSpace - imageSize 字节填充（若 imageSpace > imageSize）
...           audioData（剩余全部字节，加密的音频流）
```

> 布局依据：PyPI `ncmdump` 0.1.1 的 `core.py` 实现为 `f.seek(5)` → 读 `image_space` → 读 `image_size` → 读封面 → `f.seek(image_space - image_size)`。
> 实测样本（11 个来自不同目录的真实 .ncm，含 71–96MB 大文件）全部满足 `imageSpace == imageSize`（填充为 0），所以音频起点为 `metaEnd + 13 + imageSize` 也能正确解码；实现里仍建议按 `imageSpace` 推进偏移以兼容将来带填充的文件。

### AES 常量

| 用途 | AES-128-ECB key（16 字节） |
| --- | --- |
| 密钥区 | `68 7A 48 52 41 6D 73 6F 35 6B 49 6E 62 61 78 57`（即 ASCII `hzHRAmso5kInbaxW`） |
| 元数据区 | `23 31 34 6C 6A 6B 5F 21 5C 5D 26 30 55 3C 27 28`（即 ASCII `#14ljk_!\]&0U<'(`） |

用 `node:crypto` 的 `createDecipheriv('aes-128-ecb', key, null)`，建议 `setAutoPadding(false)` 再手动去掉 PKCS#7 填充（末尾 n 个字节、每个值均为 n），因为有的文件数据会带 padding 异常，手动处理更稳。

### 元数据 base64 前缀

实际前缀字符串是 `"163 key(Don't modify):"`（长度 22）。保险做法：base64 解码后先找到最后一个 `':'`，跳过 `':'` 及其之前的全部字节，再 AES 解密；不要写死 22。解密结果再跳过前 6 字节后 `JSON.parse`。

## 2. 音频流解密（key box）

拿到 RC4 风格的 key（密钥区解密结果）后，构造 256 字节置换盒：

```js
const keyBox = new Uint8Array(256);
for (let i = 0; i < 256; i++) keyBox[i] = i;
let c = 0, last = 0, off = 0;
for (let i = 0; i < 256; i++) {
  const swap = keyBox[i];
  c = (swap + last + key[off]) & 0xff;
  off = (off + 1) % key.length;
  keyBox[i] = keyBox[c];
  keyBox[c] = swap;
  last = c;
}
```

然后对音频流逐字节解密（原地 XOR）：

```js
for (let i = 0; i < audio.length; i++) {
  const j = (i + 1) & 0xff;
  audio[i] ^= keyBox[(keyBox[j] + keyBox[(keyBox[j] + j) & 0xff]) & 0xff];
}
```

（等价于 ncmdump 里 `build_key_box` + `xor` 的实现。）

## 3. 输出格式判定

以 JSON 元数据里的 `format` 字段为准（`"mp3"` / `"flac"`），同时用音频首字节兜底/校验：

- `ID3` 或 MPEG 帧同步（首字节 `0xFF`，第二字节高 4 位为 `0xE`/`0xF`）→ mp3
- `fLaC` → flac
- 其他 → 按 `format` 字段，未知则报 `NCM_UNSUPPORTED`

## 4. 容错要求

- 文件头不是 `CTENFDAM` → 抛 `NcmError('NCM_INVALID_HEADER')`。
- 任何越界读取 → `NCM_TRUNCATED`。
- 元数据缺失/JSON 解析失败：不要直接失败，用空元数据 + 源文件名兜底，并在 `info.raw` 里保留原始结果；音频仍可解密。
- 封面魔数：JPEG `FF D8 FF`、PNG `89 50 4E 47`、WebP `RIFF....WEBP`；其他则丢弃封面。
- 大文件（~100MB）要能处理，单文件耗时应 < 10s；避免多余拷贝（音频 Buffer 原地解密后 `subarray` 返回即可）。

## 5. 对外 API 约定

```js
export const NCM_MAGIC = 'CTENFDAM';
export function isNcm(buf)                      // → boolean
export function parseNcm(buf)                   // → { info, audio, cover? }
export class NcmError extends Error { code }    // codes: NCM_INVALID_HEADER | NCM_UNSUPPORTED | NCM_TRUNCATED
export function suggestFileName(info, format)   // → "artist - musicName.ext"，清洗 Windows 非法字符
```

`info` 形状：

```js
{
  format: 'mp3' | 'flac' | string,
  musicName: string,
  artist: string[],          // 数组；元数据里可能是字符串，统一成数组
  album: string,
  bitrate: number,
  duration: number,          // 毫秒
  lyrics: string | null,
  raw: object                // 原始 JSON
}
```

## 6. 参考

- PyPI `ncmdump` 0.1.1（原 exe 内置的参考实现）。
- 算法在社区文档中有公开描述；本仓库为独立 JS 重写，不包含原项目代码。
