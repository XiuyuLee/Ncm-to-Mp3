# 发布到 GitHub（publish-github.ps1 使用说明）

本目录提供 `publish-github.ps1`：在 Windows PowerShell 5.1 下，把整个插件包
（`E:\DeepSeek Study\dsh-ncm2mp3`）发布到 GitHub —— 自动初始化本地仓库、
提交、必要时创建远端仓库并推送。

> 前置：便携 git 已准备好（见 `E:\DeepSeek Study\.tools\git-notes.md`），
> 默认路径 `E:\DeepSeek Study\.tools\git\cmd\git.exe`；脚本会自动查找该路径，
> 找不到时回退到 PATH 里的 `git`。不需要管理员权限，不需要 SSH key。

---

## 一、申请 GitHub PAT（Personal Access Token）

脚本通过 HTTPS + PAT 推送，不需要配置 SSH。

### 方案 A：classic token（推荐，能自动创建仓库）

1. 登录 GitHub，打开 <https://github.com/settings/tokens>（Settings → Developer settings → Personal access tokens → Tokens (classic)）。
2. 点击 **Generate new token → Generate new token (classic)**。
3. Note 填 `dsh-ncm2mp3-publish`，Expiration 选 7 天或 30 天（短期更安全）。
4. **Scopes 勾选 `repo`**（完整仓库读写；创建公开/私有仓库都需要）。
5. 点击 Generate token，复制生成的 `ghp_...`（页面只显示一次）。
6. 建议发布完成后回到 GitHub 撤销该 token。

### 方案 B：fine-grained token（更细粒度，但不能自动建仓）

1. 打开 <https://github.com/settings/personal-access-tokens/new>。
2. Repository access 选目标仓库（**仓库必须已存在**：先在 GitHub 网页 New repository
   创建，且**不要**勾选 README / .gitignore / license，保持空仓库）。
3. Permissions 至少：
   - **Contents: Read and write**（推送代码）
   - **Metadata: Read**（必需）
4. 生成后复制 `github_pat_...`。

> 注意：fine-grained token 通常无法调用 `POST /user/repos` 创建仓库，所以用它时
> 必须先手工建好空仓库；classic token（repo scope）可全自动。

---

## 二、运行命令

在包根目录 `E:\DeepSeek Study\dsh-ncm2mp3` 下执行：

```powershell
# 1) 先演练：不联网、不写 .git、不需要 token，只打印将执行的操作
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-github.ps1 -DryRun

# 2) 正式发布为公开仓库（默认）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-github.ps1 -Token "ghp_xxxxxxxxxxxxxxxx"

# 3) 发布为私有仓库
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-github.ps1 -Token "ghp_xxxxxxxxxxxxxxxx" -Private

# 4) 指定 owner / 仓库名
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-github.ps1 -Token "ghp_xxxxxxxxxxxxxxxx" -Owner myname -Repo dsh-ncm2mp3
```

参数一览：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `-Token` | 正式运行必填（`-DryRun` 可省略） | GitHub PAT，见第一节 |
| `-Owner` | 否 | 默认取 token 对应用户的 login |
| `-Repo` | 否 | 默认 `dsh-ncm2mp3` |
| `-Private` | 否 | 创建为私有仓库，默认公开 |
| `-DryRun` | 否 | 只打印计划，不执行、不联网、不改 `.git` |

### 关于 token 安全的说明

- 脚本**不会**把 token 写入任何文件：不写 `.git/config`、不写 remote URL、
  不产生临时凭据文件。推送时通过 `git -c http.extraHeader=...` 在内存/进程参数中
  携带 Basic 认证头，推送结束即消失。
- 无论成功还是失败，`remote origin` 最终都保持为不带 token 的
  `https://github.com/<owner>/<repo>.git`。
- **命令行历史仍可能记录 token**。更稳妥的做法：先关闭当前会话历史记录
  （`Set-PSReadlineOption -HistorySaveStyle SaveNothing`），或运行完删除历史
  （`Remove-Item (Get-PSReadlineOption).HistorySavePath`）；最简单的是用完立即在
  GitHub 撤销该 token。

---

## 三、脚本做了什么

1. 定位包根目录（本脚本所在 `scripts/` 的上一级），确认 `package.json` 存在，
   读取 `version` 作为提交信息 `Release vX.Y.Z`。
2. 查找 git：依次尝试 `<包根>\..\.tools\git\cmd\git.exe`、`mingw64\bin\git.exe`、
   `bin\git.exe`，最后回退 PATH。
3. `git init -b main`（已有 `.git` 则跳过）；补齐本地 `user.name` / `user.email`
   （默认 `<owner>` / `<owner>@users.noreply.github.com`）。
4. `git add -A`；没有提交则 `commit -m "Release vX.Y.Z"`；已有提交且有暂存变更时
   提交；没有变更则跳过 commit。
5. 若当前分支不是 `main`，执行 `git branch -M main`。
6. 调 `GET /user` 校验 token 并确定 owner；`GET /repos/{owner}/{repo}` 判断仓库
   是否存在，404 时 `POST /user/repos` 创建（`name`、`description` 取自
   package.json、`private` 由 `-Private` 决定、`auto_init=false`）。
7. 把 `origin` 设为 `https://github.com/{owner}/{repo}.git`（**不含 token**）。
8. `git push -u origin main`，凭据经 `http.extraHeader` 传入。
9. 输出仓库网页地址。

`scripts/` 目录会随仓库一起提交（不影响 npm 发布：`package.json` 的 `files`
白名单里没有 `scripts/`）。

---

## 四、常见错误排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| **HTTP 401** `Bad credentials` | token 无效、已过期、复制时缺字符，或有多余空格 | 重新生成 PAT；确认 `-Token` 用英文双引号包裹且没有换行 |
| **HTTP 403** `Resource not accessible by personal access token` / `Permission denied` | token 权限不足；fine-grained token 没给 Contents 写权限；组织仓库需要 SSO 授权 | classic token 勾 `repo`；fine-grained token 给 Contents: Read and write + Metadata: Read；若是组织仓库，在 token 设置页为组织点 **Configure SSO → Authorize** |
| **HTTP 404**（`GET /repos/...`） | 仓库不存在（正常，会走创建）；或仓库私有而 token 无权看到 | 若自动创建也 404/403：检查 `-Owner` 拼写，或先手工建空仓库 |
| `fatal: could not read Username` / 反复弹认证 | 认证头未生效（极少见） | 确认代理没有剥离 Authorization 头；确认脚本为此版本（内嵌 extraHeader 方式）；不要用 `git config credential.helper manager` |
| `! [rejected] main -> main (non-fast-forward)` | 远端已有与本地无关的提交（网页建仓时勾了 README 等） | 删除远端仓库重建为**空仓库**；或先手动 `git pull --rebase origin main` 后再推 |
| 卡住无输出 / 连接超时 | 网络或代理问题 | 确认能访问 github.com；代理环境设置 `$env:HTTPS_PROXY = 'http://127.0.0.1:端口'` 后重试 |
| `git: command not found` | 便携 git 路径不对 | 检查 `E:\DeepSeek Study\.tools\git\cmd\git.exe` 是否存在，见 `git-notes.md` |

发布成功后，浏览器打开脚本打印的 `https://github.com/<owner>/<repo>` 即可。

---

## 五、验证状态与风险

- 已在本机完成：`-DryRun` 演练（无网络、无 token）、便携 git 的
  `init → add → commit → log` 冒烟测试。
- **未验证**：真实 token 的建仓 + push（当前没有用户 PAT）。首次真实运行时若失败，
  优先按上表 401/403/404 排查；脚本不会打印完整 token。
- 只在 Windows PowerShell 5.1 验证（语法未使用 `??` / 三元运算符）。

## 六、兜底方案：没有 git 时用 API 逐文件上传

若便携 git 最终不可用，可用捆绑 Node
（`C:\Users\16192\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）
直接调 GitHub REST API：
`PUT https://api.github.com/repos/{owner}/{repo}/contents/{path}`（先 `POST /user/repos`
建仓），逐文件 base64 上传，最后 `POST /repos/{owner}/{repo}/git/refs` 建分支。
缺点：需自己遍历文件、处理大文件/二进制、没有提交历史，只适合应急；正常情况仍推荐
用本脚本的 git 流程。
