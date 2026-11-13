# 把本仓库上传到 GitHub

本仓库已经在本地初始化好 Git（`main` 分支、初始提交、`.gitignore` 已排除 node_modules 与测试产物），
你只需要在 GitHub 上建一个空仓库，再把本地提交推上去。

下面命令都在 **PowerShell** 里执行。仓库路径按你的实际位置调整；本机自带一个便携版 Git，
没有装过 Git 也可以用它（路径：`E:\DeepSeek Study\.tools\git\cmd\git.exe`，下文用 `$git` 表示）。

```powershell
$git = "E:\DeepSeek Study\.tools\git\cmd\git.exe"
Set-Location "E:\DeepSeek Study\dsh-ncm2mp3"
```

## 第 1 步：在 GitHub 上创建空仓库

1. 打开 <https://github.com/new>。
2. **Repository name** 填 `dsh-ncm2mp3`。
3. 可见性选 **Public**（也可先 Private，之后再改）。
4. **不要**勾选 “Add a README file / Add .gitignore / Choose a license”——本地已有这些文件，勾选会造成冲突。
5. 点 **Create repository**，复制页面上显示的仓库地址，形如：
   `https://github.com/<你的用户名>/dsh-ncm2mp3.git`

## 第 2 步：关联远程仓库并推送

```powershell
Set-Location "E:\DeepSeek Study\dsh-ncm2mp3"

# 把 <你的用户名> 换成你的 GitHub 用户名
& $git remote add origin https://github.com/<你的用户名>/dsh-ncm2mp3.git

# 推送 main 分支
& $git push -u origin main
```

推送时会要求登录。GitHub 已经**不支持账号密码**，请任选一种方式：

- **浏览器登录（推荐）**：新版本 Git 会弹出浏览器窗口，登录 GitHub 授权即可（Git Credential Manager）。
  当前便携版 Git 不含 GCM，若没有弹窗，请看下一条。
- **Personal Access Token（PAT）**：在 <https://github.com/settings/tokens> 生成 token（classic，勾选 `repo`），
  推送提示 `Username` 时填 GitHub 用户名，`Password` 时**粘贴 token**（不是账号密码）。
  注意 token 只显示一次，别提交到仓库里。
- **GitHub Desktop**：装好后 `File → Add local repository` 选本目录，再 `Publish repository`。

## 第 3 步：检查

推送成功后打开仓库页面，应当能看到：

- `README.md`（中文说明 + English 部分）
- `LICENSE`、`icon.svg`、`package.json`、`index.js`、`lib/ncm.js`
- `.github/workflows/ci.yml` 自动跑测试（第一次推送后几分钟内出现绿色勾）

可选：在仓库 **About** 里填描述（可直接用 package.json 里的 description），
在 **Settings → Topics** 添加 `dsh`、`deepseek-harness`、`ncm`、`netease`、`mp3`、`flac`。

## 备选方案：全自动脚本

本机还带了一个可选的 PowerShell 脚本 `scripts/publish-github.ps1`，可以自动建仓库并推送：

```powershell
.\scripts\publish-github.ps1 -Token "<你的PAT>" -Owner "<你的用户名>" -Repo "dsh-ncm2mp3"
```

- `-DryRun` 只打印计划、不真正执行，可先跑一遍看步骤。
- 该脚本需要 **classic PAT**（勾选 `repo`）；fine-grained PAT 通常无权调用 `POST /user/repos` 建仓库。
- 若你已按上面第 2 步手动推过，就**不需要**再跑脚本，否则会遇到 remote 已存在 / 非快进错误。

## 以后更新仓库

```powershell
& $git add -A
& $git commit -m "docs: update README"
& $git push
```

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `remote origin already exists` | `& $git remote set-url origin <仓库地址>` |
| `Authentication failed` / 403 | PAT 过期或权限不足；重新生成 token（classic 勾 `repo`） |
| `Updates were rejected`（非快进） | 先 `& $git pull --rebase origin main` 再 push；或确认远程是空仓库 |
| 推上去的文件里出现 `node_modules` / `.ncm` | 不要用网页拖拽整个文件夹上传；用本页的 git 命令，`.gitignore` 已排除这些内容 |
