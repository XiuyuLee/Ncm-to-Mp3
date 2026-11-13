#!/usr/bin/env node
/**
 * dsh-ncm2mp3 — 交叉验证（可选，需要本机 ffmpeg；真实文件只读）
 *
 * 两层独立验证（不参与 `node test/run-tests.mjs` 的必过断言，因为依赖外部程序）：
 *
 *   1. PCM 一致性：本模块解出的音频 vs 目录里同名的原始 .mp3/.flac
 *      —— 用 ffmpeg 分别解码成 PCM 再算 MD5，相等即证明解出的音频与原始音频逐采样一致。
 *   2. 参考实现字节一致性：PyPI `ncmdump==0.1.1`（Python 实现）解出的音频
 *      —— 与本模块输出逐字节比较 SHA-256。
 *
 * 运行：
 *   node test/cross-check.mjs
 *
 * 环境变量（均可选）：
 *   FFMPEG         ffmpeg 可执行文件路径（默认 E:\Programs\ffmpeg\bin\ffmpeg.exe，再退回 PATH）
 *   NCM_PYTHON     捆绑 Python 路径（默认 dsh 运行时路径）
 *   NCM_TEST_DIR   额外扫描的真实 .ncm 目录（多个用 ; 分隔）
 *
 * 依赖（仅参考实现那层需要）：
 *   python -m pip install --target test/out/pylibs ncmdump==0.1.1
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNcm } from '../lib/ncm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const COMPARE_DIR = join(OUT_DIR, 'compare');
const PYLIBS = join(OUT_DIR, 'pylibs');
const REF_SCRIPT = join(__dirname, 'reference-decrypt.py');

const DEFAULT_FFMPEG = 'E:\\Programs\\ffmpeg\\bin\\ffmpeg.exe';
const DEFAULT_PYTHON = 'C:\\Users\\16192\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

const CANDIDATE_DIRS = [
  'C:\\Users\\16192\\Music\\VipSongsDownload',
  'C:\\Users\\16192\\Desktop\\文件\\音乐',
  'E:\\CloudMusic\\VipSongsDownload',
  'E:\\Music',
  ...(process.env.NCM_TEST_DIR ? process.env.NCM_TEST_DIR.split(';') : []),
];

const ffmpeg = existsSync(process.env.FFMPEG || DEFAULT_FFMPEG) ? process.env.FFMPEG || DEFAULT_FFMPEG : 'ffmpeg';
const python = existsSync(process.env.NCM_PYTHON || DEFAULT_PYTHON) ? process.env.NCM_PYTHON || DEFAULT_PYTHON : 'python';

/** @type {{ok: number, fail: number, skip: number}} */
const stats = { ok: 0, fail: 0, skip: 0 };

function checkPassed(label, detail) {
  stats.ok++;
  console.log(`  MATCH  ${label}${detail ? `  (${detail})` : ''}`);
}
function checkFailed(label, detail) {
  stats.fail++;
  console.log(`  DIFF   ${label}  ${detail}`);
}
function checkSkipped(label, reason) {
  stats.skip++;
  console.log(`  SKIP   ${label}${reason ? `  (${reason})` : ''}`);
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * 用 ffmpeg 把文件解码为 PCM 并返回 MD5。
 * @param {string} filePath
 * @returns {string | null}
 */
function pcmMd5(filePath) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-i', filePath, '-map', '0:a', '-f', 'md5', '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const match = /MD5=([0-9a-f]{32})/i.exec(result.stdout || '');
  return match ? match[1].toLowerCase() : null;
}

/**
 * 找出所有「.ncm 旁边有同名原始音频」的配对。
 * @returns {{ ncm: string, original: string, label: string }[]}
 */
function findSiblingPairs() {
  const pairs = [];
  const seen = new Set();
  for (const dir of CANDIDATE_DIRS) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const byStem = new Map();
    for (const name of entries) {
      const fullPath = join(dir, name);
      try {
        if (!statSync(fullPath).isFile()) continue;
      } catch {
        continue;
      }
      const ext = extname(name).toLowerCase();
      if (!['.ncm', '.mp3', '.flac'].includes(ext)) continue;
      const stem = name.slice(0, -ext.length).toLowerCase();
      if (!byStem.has(stem)) byStem.set(stem, { ncm: null, audio: null });
      const slot = byStem.get(stem);
      if (ext === '.ncm') slot.ncm = fullPath;
      else slot.audio = fullPath;
    }
    for (const [stem, slot] of byStem) {
      if (!slot.ncm || !slot.audio) continue;
      if (seen.has(stem)) continue;
      seen.add(stem);
      pairs.push({ ncm: slot.ncm, original: slot.audio, label: basename(slot.ncm).replace(/\.ncm$/i, '') });
    }
  }
  pairs.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  return pairs;
}

function main() {
  mkdirSync(COMPARE_DIR, { recursive: true });
  console.log('dsh-ncm2mp3 交叉验证');
  console.log(`ffmpeg: ${ffmpeg}`);
  console.log(`python: ${python}（参考实现层，可缺失）`);
  const resultLines = [];
  const record = (line) => {
    console.log(line);
    resultLines.push(line);
  };

  // ---- 第 1 层：与同名原始音频的 PCM 对比 ----
  record('\n=== 第 1 层：本模块解出的音频 vs 同名原始 .mp3/.flac（PCM MD5）===');
  const pairs = findSiblingPairs();
  if (pairs.length === 0) {
    checkSkipped('PCM 对比', '没有找到 .ncm + 同名原始音频的配对');
  }
  /** @type {{label: string, format: string, pcm: string}[]} */
  const decoded = [];
  for (const pair of pairs) {
    const { info, audio } = parseNcm(readFileSync(pair.ncm), { fileName: pair.ncm });
    const decodedPath = join(COMPARE_DIR, `${pair.label}.decoded.${info.format}`);
    writeFileSync(decodedPath, audio);
    decoded.push({ label: pair.label, format: info.format, decodedPath, audioSize: audio.length });

    const siblingPcm = pcmMd5(pair.original);
    const decodedPcm = pcmMd5(decodedPath);
    if (siblingPcm && decodedPcm && siblingPcm === decodedPcm) {
      checkPassed(`${pair.label} (${info.format}, ${(audio.length / 1048576).toFixed(1)}MB)`, `pcm md5 ${siblingPcm.slice(0, 12)}…`);
    } else {
      checkFailed(`${pair.label} (${info.format})`, `sibling=${siblingPcm} decoded=${decodedPcm}`);
    }
  }

  // ---- 第 2 层：与 Python 参考实现 ncmdump 的字节级对比 ----
  record('\n=== 第 2 层：本模块输出 vs Python ncmdump 参考实现（SHA-256 逐字节）===');
  const pyLibsAvailable = existsSync(PYLIBS) && existsSync(REF_SCRIPT);
  const pyProbe = spawnSync(python, ['-c', 'import Crypto; print(Crypto.__version__)'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: PYLIBS },
  });
  if (!pyLibsAvailable || pyProbe.status !== 0) {
    checkSkipped('ncmdump 参考实现对比', `缺少依赖：先运行 python -m pip install --target "${PYLIBS}" ncmdump==0.1.1`);
  } else {
    // 选小 mp3 + PNG 封面 mp3 + 最大 flac 三个样本，兼顾速度与覆盖
    const small = decoded.filter((item) => item.format === 'mp3').slice(0, 1);
    const png = decoded.find((item) => /睡眠音乐催眠曲/.test(item.label)) || decoded.filter((item) => item.format === 'mp3')[1];
    const big = [...decoded].filter((item) => item.format === 'flac').sort((a, b) => b.audioSize - a.audioSize)[0];
    const probes = [...small, png, big].filter(Boolean);
    for (const item of probes) {
      const pair = pairs.find((candidate) => candidate.label === item.label);
      if (!pair) {
        checkSkipped(item.label, '找不到对应 .ncm');
        continue;
      }
      const refPath = join(COMPARE_DIR, `ref-${item.label}.${item.format}`);
      const run = spawnSync(python, [REF_SCRIPT, pair.ncm, refPath], {
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: PYLIBS },
        maxBuffer: 16 * 1024 * 1024,
      });
      if (run.error || run.status !== 0) {
        checkSkipped(item.label, `Python 参考实现失败: ${(run.stderr || run.error?.message || '').slice(0, 200)}`);
        continue;
      }
      const ours = sha256File(item.decodedPath);
      const refs = sha256File(refPath);
      if (ours === refs) {
        checkPassed(`${item.label} (${item.format}, ${(item.audioSize / 1048576).toFixed(1)}MB)`, `sha256 ${ours.slice(0, 12)}…`);
      } else {
        checkFailed(`${item.label} (${item.format})`, `ours=${ours} ref=${refs}`);
      }
    }
  }

  // ---- 汇总 ----
  record(`\n汇总：MATCH ${stats.ok} / DIFF ${stats.fail} / SKIP ${stats.skip}`);
  writeFileSync(join(OUT_DIR, 'cross-check.md'), ['# dsh-ncm2mp3 交叉验证结果', '', `- 生成时间：${new Date().toISOString()}`, ...resultLines, ''].join('\n'), 'utf8');
  if (stats.fail > 0) {
    console.error('交叉验证存在不一致，请检查！');
    process.exit(1);
  }
  console.log('交叉验证通过（所有可执行的对比均一致）');
  process.exit(0);
}

main();
