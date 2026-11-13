# dsh-ncm2mp3

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**DeepSeek Harness 插件：把网易云音乐 `.ncm` 加密文件解密还原为原始 MP3/FLAC。**

> ⚠️ 先说明一件事：NCM 容器里存的是**原始音频**（MP3 或 FLAC），不是加密过的 MP3。
> 本插件只做「解密 / 还原」，**不做转码**；原文件是 FLAC，输出就还是 FLAC，音质与源文件完全一致。

---

## 功能

- **纯 JavaScript 实现** NCM 解密（AES-128-ECB + RC4 变体），零运行时依赖，不调用外部 exe、ffmpeg 或网络。
- **单文件 / 目录批量** 转换，目录可递归。
- **保留原始音频字节**，不重新编码，输出音质与源文件相同。
- 自动命名：`歌手 - 歌名.mp3`；输出名重复时自动追加 ` (2)`、` (3)`。
- 可选导出**封面图**（JPEG / PNG / WebP）与**歌词**（`.lrc`，仅当元数据内嵌歌词时）。
- 默认**跳过已存在的输出文件**（`overwrite` 可强制覆盖），重复运行安全。
- `dryRun` 预览：只解析并列出将要写出的文件，不写盘。
- 单个坏文件不会中断批处理，结果里按文件记录 `failed` 与错误码。
- 注册为 DSH 对话工具，直接用自然语言让 Agent 帮你转换。

## 安装

本插件是一个标准的 DSH **bundle 插件**，需要 DeepSeek Harness（在 `0.2.2-rc.1` 上测试通过）。

1. 把本仓库克隆或下载到本地任意目录（路径不要删，插件按路径安装）。
2. 在 DSH 中安装：
   - 打开 **设置 → 插件**，选择「安装本地插件 / 从路径安装」，指向本仓库根目录；或
   - 让 DSH Agent 调用 `plugin_manager` 工具的 `install_bundle`，`target` 填本仓库的**绝对路径**。
3. 安装成功后，新会话的工具列表里会出现 **`ncm2mp3`**，插件列表中显示为「NCM 转 MP3 / NCM to MP3」。

> 卸载：在「设置 → 插件」里移除 `dsh-ncm2mp3` 即可。

## 使用

### 对话中使用

直接用自然语言吩咐 Agent，例如：

- 「把 `C:\Users\me\Music\VipSongsDownload` 里的 ncm 全部转成 mp3」
- 「先预览一下这个目录里有哪些 ncm 会输出到哪里，不要写文件」
- 「转换 `D:\a.ncm`，顺便把封面一起导出来」

### 工具参数

工具名：`ncm2mp3`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `input` | string，**必填** | — | 一个 `.ncm` 文件，或包含 `.ncm` 文件的目录 |
| `outputDir` | string | 源文件所在目录 | 输出目录（不存在会自动创建） |
| `recursive` | boolean | `false` | `input` 为目录时，是否递归扫描子目录 |
| `overwrite` | boolean | `false` | 覆盖已存在的输出文件 |
| `exportCover` | boolean | `false` | 同时导出封面图（`歌手 - 歌名.jpg/png/webp`） |
| `exportLyrics` | boolean | `false` | 同时导出歌词 `歌手 - 歌名.lrc`（内嵌歌词存在时） |
| `dryRun` | boolean | `false` | 只解析、不写文件 |

返回内容包含汇总与每个文件的状态：

```text
Converted: 3 converted, 0 planned, 0 skipped, 0 failed (of 3 .ncm files)
✓ 周杰伦 — 晴天  [mp3 · 4:29 · 9.6 MB]
   → D:\Music\周杰伦 - 晴天.mp3
✓ Blitz Kids — On My Own  [flac · 3:14 · 27.8 MB]
   → D:\Music\Blitz Kids - On My Own.flac
```

> 每次调用最多处理 500 个 `.ncm` 文件，超出请分批。

## 项目结构

```text
index.js             Host 插件入口：注册 ncm2mp3 对话工具
lib/ncm.js           零依赖 NCM 解码器（密钥区、元数据、封面、音频流）
locale/zh.json       插件显示名与描述（中文）
locale/en.json       插件显示名与描述（英文）
cordis.patch.yml     bundle 插入声明
icon.svg             插件图标
test/                48 项测试（合成 fixture + 真实文件 + 错误路径）与交叉验证脚本
dev/                 手工烟测脚本（工具层、布局探测、行为测试）
docs/ncm-spec.md     NCM 文件格式说明
docs/UPLOAD-GITHUB.md 把本仓库上传到 GitHub 的步骤
scripts/             可选的 GitHub 发布脚本
```

## 开发与测试

零依赖，Node.js ≥ 20 即可（DSH 自带 Node 亦可）：

```bash
# quick 模式：只用合成 fixture，不需要真实 NCM 文件（CI 用这个）
node test/run-tests.mjs --quick

# 全量模式：会扫描 test/run-tests.mjs 顶部 REAL_DIRS 中配置的真实 .ncm 目录
node test/run-tests.mjs
```

- 测试结果：quick 模式 36 项全部通过；全量模式 48 项全部通过（含 14 个真实 NCM 文件）。
- 交叉验证 `test/cross-check.mjs`：7 个文件与同名原始音频的 PCM MD5 逐采样一致；3 个文件与 Python `ncmdump==0.1.1` 的输出 SHA-256 逐字节一致。

## 已知限制

- **不转码**：NCM 内是原始音频；FLAC 不会变成 MP3，如需转码请配合 ffmpeg 等工具。
- **不写入标签**：不修改输出音频的 ID3 / FLAC 标签；标题、歌手、专辑体现在工具结果与文件名中。需要标签可用其他工具批量处理。
- **歌词通常为空**：NCM 元数据里一般不含歌词（原客户端歌词多为在线获取），仅在内嵌歌词存在时才导出 `.lrc`。
- 不校验 NCM 的 CRC32。
- 封面识别仅支持 JPEG / PNG / WebP。
- AAC / M4A 类 NCM 未用真实样本验证；未来若加密格式变更，可能报 `NCM_UNSUPPORTED`。
- 单次调用上限 500 个文件。

## 与「NCM TO MP3.exe」的关系

本插件脱胎于桌面上的 `NCM TO MP3.exe` 小工具，但**没有**打包、调用或包含那个 exe：

- 原 exe 是 PyInstaller 打包的 Python GUI，内部使用 PyPI 包 `ncmdump 0.1.1`；
- 本插件用纯 JavaScript 独立重新实现 NCM 解密逻辑（clean-room reimplementation），无任何 Python / exe / ffmpeg 依赖；
- 解码结果已用「同名原始音频」「ncmdump 0.1.1 输出」两条独立链路逐字节交叉验证。

## 免责声明与许可

本插件用于解密你有权访问的本地音乐文件，请遵守网易云音乐服务条款与当地法律法规。请勿用于传播侵权内容。

[MIT](LICENSE) © dsh-ncm2mp3 contributors

---

## English

**A DeepSeek Harness plugin that decrypts NetEase Cloud Music `.ncm` files back to their original MP3/FLAC audio.**

NCM is an encrypted container; it does **not** transcode. A FLAC source stays FLAC.

- Pure JavaScript NCM decoder (AES-128-ECB + RC4 variant), zero runtime dependencies, no exe/ffmpeg/network calls.
- Convert one file or a whole directory (optionally recursive); original audio bytes are preserved.
- Optional cover art and lyrics export; skips existing outputs unless `overwrite`; `dryRun` preview.
- Output names `Artist - Title.ext`, collisions get ` (2)` suffixes; per-file failures never abort a batch.

**Install**: install the repository directory as a DSH bundle (Settings → Plugins → install local plugin, or `plugin_manager.install_bundle` with the absolute path). The `ncm2mp3` tool then appears in new sessions.

**Test**: `node test/run-tests.mjs --quick` (fixtures only) or `node test/run-tests.mjs` (also scans real `.ncm` directories listed in `REAL_DIRS`).

**Limitations**: no transcoding, no audio-tag writing, lyrics usually absent, no CRC check, cover detection limited to JPEG/PNG/WebP.

**License**: MIT. Use only on files you have the right to access; respect the service terms and local law.
