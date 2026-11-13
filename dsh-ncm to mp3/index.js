/**
 * Host half of the dsh-ncm2mp3 plugin.
 *
 * Registers the `ncm2mp3` tool, which decrypts NetEase Cloud Music `.ncm`
 * files back to their original MP3/FLAC audio. The decoder itself lives in
 * `lib/ncm.js` and has no third-party dependencies.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isNcm, parseNcm, suggestFileName, NcmError, NCM_ERROR_CODES } from './lib/ncm.js';

export const name = 'dsh-ncm2mp3';

/** The tool service must be present before we register into it. */
export const inject = ['tools'];

const MAX_FILES_PER_CALL = 500;

const DEFAULTS = Object.freeze({
  defaultOutputDir: '',
  overwrite: false,
  recursive: false,
  exportCover: false,
  exportLyrics: false,
});

function normalizeConfig(config) {
  const input = config && typeof config === 'object' ? config : {};
  return {
    defaultOutputDir:
      typeof input.defaultOutputDir === 'string' ? input.defaultOutputDir : DEFAULTS.defaultOutputDir,
    overwrite: input.overwrite === true,
    recursive: input.recursive === true,
    exportCover: input.exportCover === true,
    exportLyrics: input.exportLyrics === true,
  };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function oneLine(text, limit = 200) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function describeCover(cover) {
  if (!cover) return null;
  return `${cover.format} (${cover.data.length} bytes)`;
}

async function collectNcmFiles(inputPath, recursive) {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved);
  if (stat.isFile()) {
    if (!resolved.toLowerCase().endsWith('.ncm')) {
      throw new Error(`Input file is not a .ncm file: ${inputPath}`);
    }
    return { root: resolved, kind: 'file', files: [resolved] };
  }
  if (!stat.isDirectory()) {
    throw new Error(`Input is neither a file nor a directory: ${inputPath}`);
  }
  const files = [];
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.ncm')) files.push(full);
    }
  };
  await walk(resolved);
  files.sort((a, b) => a.localeCompare(b));
  return { root: resolved, kind: 'dir', files };
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function planOutputs(sourceFile, options, settings) {
  const buffer = await fs.readFile(sourceFile);
  if (!isNcm(buffer)) {
    throw new NcmError(
      NCM_ERROR_CODES.INVALID_HEADER,
      `Not an NCM file (bad magic header): ${path.basename(sourceFile)}`,
    );
  }
  const { info, audio, cover } = parseNcm(buffer, { fileName: path.basename(sourceFile) });
  const sourceBase = path.basename(sourceFile, path.extname(sourceFile));
  // Prefer "Artist - Title.ext" when the NCM actually carries metadata; otherwise
  // keep the source stem so the output name stays predictable for untagged files.
  const metaAvailable = info.raw && typeof info.raw === 'object' && !('error' in info.raw);
  const chosenBase = metaAvailable ? suggestFileName(info, info.format) : `${sourceBase}.${info.format}`;
  const ext = path.extname(chosenBase) || `.${info.format}`;
  const stem = chosenBase.slice(0, chosenBase.length - ext.length);

  const outputDir = options.outputDir || settings.defaultOutputDir || path.dirname(sourceFile);
  return {
    info,
    audio,
    cover,
    outputDir: path.resolve(outputDir),
    audioPath: path.join(path.resolve(outputDir), `${stem}${ext}`),
    coverPath: cover ? path.join(path.resolve(outputDir), `${stem}.${cover.format}`) : null,
    lyricsPath: info.lyrics ? path.join(path.resolve(outputDir), `${stem}.lrc`) : null,
    duration: info.duration || 0,
    format: info.format,
  };
}

function reserveOutputPath(plan, usedOutputs) {
  const ext = path.extname(plan.audioPath);
  const stem = plan.audioPath.slice(0, plan.audioPath.length - ext.length);
  let candidate = plan.audioPath;
  for (let index = 2; usedOutputs.has(candidate.toLowerCase()); index += 1) {
    candidate = `${stem} (${index})${ext}`;
  }
  usedOutputs.add(candidate.toLowerCase());
  if (candidate !== plan.audioPath) {
    // Keep sidecar files next to the (possibly de-duplicated) audio file.
    const candidateStem = candidate.slice(0, candidate.length - ext.length);
    plan.audioPath = candidate;
    if (plan.cover) plan.coverPath = `${candidateStem}.${plan.cover.format}`;
    if (plan.info.lyrics) plan.lyricsPath = `${candidateStem}.lrc`;
  }
  return plan;
}

async function convertOne(sourceFile, options, settings, exec, usedOutputs) {
  if (exec.signal && exec.signal.aborted) throw new Error('Conversion aborted');

  const plan = reserveOutputPath(await planOutputs(sourceFile, options, settings), usedOutputs);
  const result = {
    source: sourceFile,
    output: plan.audioPath,
    format: plan.format,
    title: plan.info.musicName || path.basename(sourceFile, path.extname(sourceFile)),
    artist: Array.isArray(plan.info.artist) ? plan.info.artist.join(', ') : String(plan.info.artist || ''),
    album: plan.info.album || '',
    bitrate: plan.info.bitrate || 0,
    duration: plan.duration,
    size: plan.audio.length,
    lyrics: Boolean(plan.info.lyrics),
    status: 'converted',
  };
  if (plan.cover) result.cover = describeCover(plan.cover);

  if (options.dryRun) {
    result.status = 'planned';
    result.output = plan.audioPath;
    return result;
  }

  await fs.mkdir(plan.outputDir, { recursive: true });
  if ((await pathExists(plan.audioPath)) && !options.overwrite) {
    result.status = 'skipped';
    result.error = 'output file already exists (pass overwrite: true to replace it)';
    return result;
  }

  await fs.writeFile(plan.audioPath, plan.audio);

  if (options.exportCover && plan.cover && plan.coverPath) {
    await fs.writeFile(plan.coverPath, plan.cover.data);
    result.coverPath = plan.coverPath;
  }
  if (options.exportLyrics && plan.info.lyrics && plan.lyricsPath) {
    await fs.writeFile(plan.lyricsPath, plan.info.lyrics, 'utf8');
    result.lyricsPath = plan.lyricsPath;
  }

  result.output = plan.audioPath;
  return result;
}

function buildResult(files, plan) {
  const converted = files.filter((f) => f.status === 'converted').length;
  const planned = files.filter((f) => f.status === 'planned').length;
  const skipped = files.filter((f) => f.status === 'skipped').length;
  const failed = files.filter((f) => f.status === 'failed').length;
  return {
    ok: failed === 0,
    dryRun: plan.dryRun,
    total: files.length,
    converted,
    planned,
    skipped,
    failed,
    files,
  };
}

function renderSummary(args, value) {
  const lines = [];
  const mode = value && value.dryRun ? 'Dry run' : 'Converted';
  const head = `${mode}: ${value && value.converted ? value.converted : 0} converted, ${
    (value && value.planned) || 0
  } planned, ${(value && value.skipped) || 0} skipped, ${(value && value.failed) || 0} failed (of ${
    (value && value.total) || 0
  } .ncm files)`;
  lines.push(head);
  for (const file of (value && value.files) || []) {
    if (file.status === 'failed') {
      lines.push(`✗ ${path.basename(file.source)} — ${file.error || 'unknown error'}`);
      continue;
    }
    const artist = file.artist ? `${file.artist} — ` : '';
    const duration = formatDuration(file.duration);
    const meta = [file.format, duration, file.size ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : null]
      .filter(Boolean)
      .join(' · ');
    const label = file.status === 'skipped' ? '↷' : file.status === 'planned' ? '·' : '✓';
    lines.push(`${label} ${artist}${file.title}  [${meta}]`);
    lines.push(`   → ${file.output}`);
    if (file.error) lines.push(`   ! ${oneLine(file.error, 160)}`);
  }
  if (value && value.total === 0) lines.push('No .ncm files found for the given input.');
  return [{ type: 'text', text: lines.join('\n') }];
}

function createTool(settings) {
  return {
    name: 'ncm2mp3',
    description:
      'Decrypt NetEase Cloud Music .ncm files back to their original MP3/FLAC audio (NCM is an encrypted container; ' +
      'this does not transcode). Accepts a single file or a directory, returns per-file results, and can also export ' +
      'cover art and lyrics. Use dryRun to preview without writing anything.',
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Absolute or relative path to one .ncm file, or to a directory containing .ncm files.',
        },
        outputDir: {
          type: 'string',
          description:
            'Directory to write converted files into. Defaults to the plugin config value, or the source file directory.',
        },
        recursive: {
          type: 'boolean',
          description: 'When input is a directory, also scan sub-directories. Default: false.',
          default: false,
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace existing output files. Default: false (existing files are skipped).',
          default: false,
        },
        exportCover: {
          type: 'boolean',
          description: 'Also write the embedded cover art next to the audio file. Default: false.',
          default: false,
        },
        exportLyrics: {
          type: 'boolean',
          description: 'Also write embedded lyrics as a .lrc file next to the audio file. Default: false.',
          default: false,
        },
        dryRun: {
          type: 'boolean',
          description: 'Only parse and report what would be written; do not create files. Default: false.',
          default: false,
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          total: { type: 'integer' },
          converted: { type: 'integer' },
          planned: { type: 'integer' },
          skipped: { type: 'integer' },
          failed: { type: 'integer' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                output: { type: 'string' },
                format: { type: 'string' },
                title: { type: 'string' },
                artist: { type: 'string' },
                album: { type: 'string' },
                bitrate: { type: 'number' },
                duration: { type: 'number' },
                size: { type: 'integer' },
                cover: { type: 'string' },
                coverPath: { type: 'string' },
                lyricsPath: { type: 'string' },
                lyrics: { type: 'boolean' },
                status: { type: 'string', enum: ['converted', 'planned', 'skipped', 'failed'] },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderSummary,
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args && args.input;
      if (typeof input !== 'string' || input.trim() === '') {
        throw new Error('The "input" argument is required and must be a non-empty path string.');
      }
      const options = {
        outputDir: typeof args.outputDir === 'string' && args.outputDir.trim() !== '' ? args.outputDir : '',
        recursive: args.recursive === true || (args.recursive === undefined && settings.recursive),
        overwrite: args.overwrite === true || (args.overwrite === undefined && settings.overwrite),
        exportCover: args.exportCover === true || (args.exportCover === undefined && settings.exportCover),
        exportLyrics: args.exportLyrics === true || (args.exportLyrics === undefined && settings.exportLyrics),
        dryRun: args.dryRun === true,
      };

      const { files: sourceFiles } = await collectNcmFiles(input, options.recursive);
      if (sourceFiles.length === 0) {
        return buildResult([], options);
      }
      if (sourceFiles.length > MAX_FILES_PER_CALL) {
        throw new Error(
          `Too many .ncm files (${sourceFiles.length}); this tool handles at most ${MAX_FILES_PER_CALL} per call. ` +
            'Convert in smaller batches.',
        );
      }

      const results = [];
      const usedOutputs = new Set();
      for (const sourceFile of sourceFiles) {
        if (exec.signal && exec.signal.aborted) throw new Error('Conversion aborted');
        try {
          results.push(await convertOne(sourceFile, options, settings, exec, usedOutputs));
        } catch (error) {
          const code = error && error.code ? error.code : 'NCM_CONVERT_FAILED';
          results.push({
            source: sourceFile,
            output: '',
            format: '',
            title: path.basename(sourceFile, path.extname(sourceFile)),
            artist: '',
            album: '',
            bitrate: 0,
            duration: 0,
            size: 0,
            lyrics: false,
            status: 'failed',
            error: `${code}: ${error && error.message ? error.message : String(error)}`,
          });
        }
      }
      return buildResult(results, options);
    },
  };
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  ctx.effect(() => ctx.tools.register(createTool(settings)));
}
