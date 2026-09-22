# release.ps1 — 一条命令出包（2026-09-22 固化）
#
# 它做的事，按顺序：
#   1. 从仓库目录「净化复制」到一个临时 staging（把 .git / release / __pycache__ /
#      .bak-* / 临时文件全排除在外 —— 上一版 zip 就是漏了这一步，把整个 .git 打进安装包，954KB → 457KB）
#   2. Compress-Archive 成 release/app-<id>-<version>.zip
#   3. 算 sha256，生成同名 .entry.json（与宿主安装管线用的 schema 一致）
#   4. 加 -Publish：打 tag、推 tag、用 gh 建 GitHub Release 并把 zip + entry.json 传上去
#
# 用法：
#   ./release.ps1                          # 只出包（版本号读 manifest.json）
#   ./release.ps1 -Version 0.6.35          # 指定版本号（不写回 manifest）
#   ./release.ps1 -Publish -NotesFile .\notes.md
#
# 依赖：pwsh（Compress-Archive）、git、gh（仅 -Publish 需要）
[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$Repo = "",
  [switch]$Publish,
  [string]$NotesFile = "",
  [string]$Remote = "origin"
)

$ErrorActionPreference = "Stop"

if (-not $Repo) { $Repo = $PSScriptRoot }
$Repo = (Resolve-Path -LiteralPath $Repo).Path
Write-Host "仓库: $Repo"

$manifestPath = Join-Path $Repo "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "找不到 manifest.json（$manifestPath）" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = $manifest.version }
if (-not $Version) { throw "拿不到版本号：manifest.json 里没有 version，也没传 -Version" }

$appId = $manifest.id
$zipName = "app-$appId-$Version.zip"
$entryName = "app-$appId-$Version.entry.json"
$releaseDir = Join-Path $Repo "release"
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
$zipPath = Join-Path $releaseDir $zipName
$entryPath = Join-Path $releaseDir $entryName

Write-Host "版本: $Version  →  $zipName"

# ── 1. 净化 staging ────────────────────────────────────────────────
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "rel-stage-$appId-$Version"
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# 这些目录/文件不该进安装包：
#   .git（仓库历史，别塞进用户机器）、release（制品本身）、__pycache__/*.pyc、
#   .runtime（本机 venv，1GB）、test-env/data、.bak-*（改动前备份）、本脚本、临时文件
$xd = @(".git", "release", "__pycache__", ".runtime", "test-env", "data", ".bak-2026-09-22")
$xf = @("*.pyc", "*.log", "release.ps1", ".tmp-*")
& robocopy $Repo $stage /E /XD @xd /XF @xf /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）" }
$fileCount = (Get-ChildItem -LiteralPath $stage -Recurse -File | Measure-Object).Count
Write-Host "staging: $fileCount 个文件"

# ── 2. 压缩 ───────────────────────────────────────────────────────
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force
$zipItem = Get-Item -LiteralPath $zipPath
$sha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
Write-Host ("zip: {0}  {1} KB  sha256 {2}…" -f $zipItem.Name, [int]($zipItem.Length / 1KB), $sha.Substring(0, 16))

# ── 3. entry.json ─────────────────────────────────────────────────
# 与宿主安装管线一致的 schema：kind/id/name/publisher/description/version/
# permissions（= manifest.capabilities）/compatibility/icon(base64)/archive。
# 注意 archive.url 用 {{BASE_URL}} 占位符 —— 由分发方（如 Release 直链或 hub 索引）替换。
$iconPath = Join-Path $Repo "assets\icon.png"
$iconData = ""
if (Test-Path -LiteralPath $iconPath) {
  $iconData = "data:image/png;base64," + [Convert]::ToBase64String([IO.File]::ReadAllBytes($iconPath))
} else {
  Write-Warning "没找到 assets/icon.png —— entry.json 里 icon 留空"
}

$entry = [ordered]@{
  kind          = "app"
  id            = $appId
  name          = $manifest.name
  publisher     = "ophelia"
  description   = $manifest.description
  version       = $Version
  permissions   = @($manifest.capabilities | ForEach-Object { [ordered]@{ capability = $_ } })
  compatibility = [ordered]@{ minAppVersion = $manifest.minAppVersion }
  icon          = $iconData
  archive       = [ordered]@{
    url    = "{{BASE_URL}}/$zipName"
    sha256 = $sha
    size   = $zipItem.Length
    format = "zip"
  }
}
($entry | ConvertTo-Json -Depth 8) + "`n" | Set-Content -LiteralPath $entryPath -Encoding utf8NoBOM
Write-Host "entry: $entryName  ($([int]((Get-Item -LiteralPath $entryPath).Length / 1KB)) KB, $($entry.permissions.Count) 项权限)"

# ── 4. 自检：读回来核对 ────────────────────────────────────────────
$check = Get-Content -LiteralPath $entryPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($check.archive.sha256 -ne $sha -or $check.archive.size -ne $zipItem.Length) {
  throw "entry.json 与 zip 不一致（sha 或 size 对不上）"
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $names = $zip.Entries | ForEach-Object { $_.FullName }
  if ($names | Where-Object { $_ -like ".git/*" }) { throw "zip 里混进了 .git/" }
  foreach ($need in @("manifest.json", "index.js")) {
    if (-not ($names -contains $need)) { throw "zip 里缺 $need" }
  }
  Write-Host "自检通过：$($names.Count) 条目，无 .git，manifest/index 都在"
} finally { $zip.Dispose() }

if (-not $Publish) {
  Write-Host "`n完成（只出包）。要发布加 -Publish。" -ForegroundColor Green
  return
}

# ── 5. tag + GitHub Release ───────────────────────────────────────
$tag = "v$Version"
Push-Location $Repo
try {
  if (-not (git tag --list $tag)) {
    git tag -a $tag -m "$tag" | Out-Null
    git push $Remote $tag
  } else {
    Write-Host "tag $tag 已存在，跳过打 tag（推送仍旧执行）"
    git push $Remote $tag
  }

  if (-not $NotesFile -or -not (Test-Path -LiteralPath $NotesFile)) {
    $NotesFile = Join-Path ([System.IO.Path]::GetTempPath()) "rel-notes-$appId-$Version.md"
    "$tag — $($manifest.name)`n`n（正文未提供；用 -NotesFile 指定详细变更）" | Set-Content -LiteralPath $NotesFile -Encoding utf8NoBOM
    Write-Host "未提供 -NotesFile，用默认正文"
  }

  gh release create $tag --title $tag --notes-file $NotesFile $zipPath $entryPath
  Write-Host "`n已发布：$tag" -ForegroundColor Green
  gh release view $tag --json assets --jq '.assets[] | "\(.name)  \(.size) B"'
} finally { Pop-Location }
