// Lead-owned layout probe: verifies the cover-area field layout against real .ncm files.
// Prints image_space/image_size values, candidate audio offsets, audio magic, and
// what lib/ncm.js parses. Usage: node dev/check-layout.mjs [dir]
import fs from 'node:fs';
import path from 'node:path';
import { parseNcm, suggestFileName } from '../lib/ncm.js';

const dir = process.argv[2] || 'C:\\Users\\16192\\Music\\VipSongsDownload';
const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.ncm'));
if (files.length === 0) throw new Error(`no .ncm files in ${dir}`);

const hex = (buf, offset, length = 4) => buf.subarray(offset, offset + length).toString('hex');

for (const file of files) {
  const full = path.join(dir, file);
  const buf = fs.readFileSync(full);
  try {
    let offset = 10; // magic(8) + 2-byte gap
    offset += 4; // keyLen
    offset += buf.readUInt32LE(10);
    const metaLengthOffset = offset;
    const metaLength = buf.readUInt32LE(metaLengthOffset);
    offset += 4 + metaLength;
    const imageSpace = buf.readUInt32LE(offset + 5);
    const imageSize = buf.readUInt32LE(offset + 9);
    const audioBase = offset + 13;
    const audioWithPad = audioBase + imageSpace;
    const audioWithoutPad = audioBase + imageSize;
    const lib = {};
    try {
      const parsed = parseNcm(buf, { fileName: file });
      lib.format = parsed.info.format;
      lib.title = parsed.info.musicName;
      lib.artist = parsed.info.artist;
      lib.album = parsed.info.album;
      lib.duration = parsed.info.duration;
      lib.lyrics = Boolean(parsed.info.lyrics);
      lib.cover = parsed.cover ? `${parsed.cover.format}:${parsed.cover.data.length}` : null;
      lib.audioLen = parsed.audio.length;
      lib.audioHead = parsed.audio.subarray(0, 4).toString('hex');
      lib.suggested = suggestFileName(parsed.info);
    } catch (error) {
      lib.error = `${error.code || 'ERR'}: ${error.message}`;
    }
    console.log(
      JSON.stringify({
        file,
        size: buf.length,
        metaLength,
        imageSpace,
        imageSize,
        coverPadding: imageSpace - imageSize,
        audioWithPad: `${audioWithPad} ${hex(buf, audioWithPad)}`,
        audioWithoutPad: `${audioWithoutPad} ${hex(buf, audioWithoutPad)}`,
        lib,
      }),
    );
  } catch (error) {
    console.log(JSON.stringify({ file, fatal: String(error) }));
  }
}
