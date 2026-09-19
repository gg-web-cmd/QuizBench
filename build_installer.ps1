# 문제풀이도구 — 설치 파일 만들기
#
#   .\build_installer.ps1          exe 가 없으면 먼저 만들고, 설치 파일까지 만든다
#   .\build_installer.ps1 -Open    끝나고 탐색기로 결과 폴더를 연다
#
# 결과: dist\installer\문제풀이도구_설치_1.0.0.exe

param(
    [switch]$Open
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

# --- Inno Setup 컴파일러 찾기 -------------------------------------------------
# 이 PC 는 사용자 폴더에 설치되어 있어서 Program Files 만 보면 못 찾는다.
$iscc = $null
foreach ($c in @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 7\ISCC.exe")) {
    if (Test-Path $c) { $iscc = $c; break }
}
if (-not $iscc) {
    Write-Host "Inno Setup 을 찾지 못했습니다." -ForegroundColor Red
    Write-Host "  winget install JRSoftware.InnoSetup"
    exit 1
}

# --- exe 가 없으면 먼저 만든다 -------------------------------------------------
$exe = Join-Path $Root "dist\QuizBench.exe"
if (-not (Test-Path $exe)) {
    Write-Host "exe 가 없어서 먼저 빌드합니다..." -ForegroundColor Cyan
    & node (Join-Path $Root "build.js")
    if ($LASTEXITCODE -ne 0) { Write-Host "exe 빌드 실패" -ForegroundColor Red; exit 1 }
}

# --- 설치 파일 컴파일 ----------------------------------------------------------
& $iscc (Join-Path $Root "installer\QuizBench.iss")
if ($LASTEXITCODE -ne 0) { Write-Host "Inno Setup 컴파일 오류" -ForegroundColor Red; exit 1 }

$setup = Join-Path $Root "dist\installer\문제풀이도구_설치_1.0.0.exe"
if (Test-Path $setup) {
    $mb = [math]::Round((Get-Item $setup).Length / 1MB, 1)
    Write-Host ""
    Write-Host ("완료 - {0} ({1} MB)" -f (Split-Path $setup -Leaf), $mb) -ForegroundColor Green
    Write-Host ("       {0}" -f $setup)

    # 다른 도구들과 함께 _배포 폴더에도 모아 둔다 (있을 때만)
    $share = Join-Path (Split-Path -Parent $Root) "_배포"
    if (Test-Path $share) {
        Copy-Item $setup $share -Force
        Write-Host ("       {0} 에도 복사했습니다" -f $share) -ForegroundColor DarkGray
    }
    if ($Open) { explorer (Split-Path $setup -Parent) }
} else {
    Write-Host "설치 파일이 만들어지지 않았습니다." -ForegroundColor Red
    exit 1
}
