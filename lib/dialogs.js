/* 윈도우 기본 대화상자 · 탐색기 연동 (PowerShell 경유).
 *
 * 브라우저는 파일의 실제 경로를 알려주지 않으므로, 경로가 필요한 일은 여기서 한다.
 * C:\vibe 의 다른 도구들과 같은 코드다 — 대화상자가 "안 뜬 것처럼" 보이던 두 문제
 * (브라우저 뒤로 숨음 · 엉뚱한 모니터에 뜸)를 막는 준비 코드가 함께 들어 있다.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const TMP = path.join(os.tmpdir(), 'roster-merge');
fs.mkdirSync(TMP, { recursive: true });

let seq = 0;
function tmpFile(ext) {
  seq += 1;
  return path.join(TMP, `dlg-${process.pid}-${seq}${ext}`);
}

/* 대화상자를 제자리에 앉히는 별도 스크립트.
 * 대화상자를 띄운 프로세스는 ShowDialog 안에 갇혀 스스로 창을 못 옮긴다.
 * 그래서 잠깐 뒤에 다른 프로세스가 대신 해 준다. */
const NUDGE_PS = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Nudge {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static IntPtr Find(uint want) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != want || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(64); GetClassName(h, sb, 64);
      if (sb.ToString() != "#32770") return true;
      RECT r; GetWindowRect(h, out r);
      if (r.R - r.L < 200) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr Owner(IntPtr h) { return GetWindow(h, 4); }

  public static string Place(IntPtr h, int wl, int wt, int ww, int wh) {
    RECT r;
    if (!GetWindowRect(h, out r)) return "fail";
    int w = Math.Min(r.R - r.L, ww);
    int ht = Math.Min(r.B - r.T, wh);
    int x = wl + (ww - w) / 2, y = wt + (wh - ht) / 2;
    MoveWindow(h, x, y, w, ht, true);
    uint me = GetCurrentThreadId();
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    if (fg != 0 && fg != me) AttachThreadInput(fg, me, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (fg != 0 && fg != me) AttachThreadInput(fg, me, false);
    return x + "," + y;
  }
}
"@
[void][Nudge]::SetProcessDPIAware()
$target = [uint32]$args[0]
foreach ($wait in 0, 250, 400, 600, 900) {
  if ($wait) { Start-Sleep -Milliseconds $wait }
  $dlg = [Nudge]::Find($target)
  if ($dlg -ne [IntPtr]::Zero) {
    $anchor = [Nudge]::Owner($dlg)
    if ($anchor -eq [IntPtr]::Zero) { $anchor = $dlg }
    $wa = [System.Windows.Forms.Screen]::FromHandle($anchor).WorkingArea
    [void][Nudge]::Place($dlg, $wa.Left, $wa.Top, $wa.Width, $wa.Height)
    break
  }
}
`;

let nudgePs1 = null;
function nudgeDialog(pid) {
  try {
    if (!nudgePs1) {
      nudgePs1 = path.join(TMP, 'nudge.ps1');
      fs.writeFileSync(nudgePs1, '﻿' + NUDGE_PS, 'utf8');
    }
    const cp = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nudgePs1, String(pid)],
      { windowsHide: true, stdio: 'ignore' });
    cp.on('error', () => {});
  } catch (_) { /* 보정은 실패해도 대화상자 자체는 쓸 수 있다 */ }
}

/** PowerShell 스크립트를 UTF-8(BOM) 로 저장해 실행하고, 결과 파일 내용을 돌려준다 */
function runPs(body, { dialog = false } = {}) {
  return new Promise((resolve) => {
    const ps1 = tmpFile('.ps1');
    const outFile = tmpFile('.txt');
    const script = '﻿' + body.replace(/__OUT__/g, outFile.replace(/'/g, "''"));
    try { fs.writeFileSync(ps1, script, 'utf8'); } catch (_) { return resolve([]); }

    const cp = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { windowsHide: true, stdio: 'ignore' });
    if (dialog && cp.pid) nudgeDialog(cp.pid);

    const finish = () => {
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch (_) {}
      try { fs.unlinkSync(ps1); } catch (_) {}
      try { fs.unlinkSync(outFile); } catch (_) {}
      resolve(text.replace(/^﻿/, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    };
    cp.on('close', finish);
    cp.on('error', finish);
  });
}

/* 대화상자가 브라우저 뒤로 숨거나 엉뚱한 모니터에 뜨는 것을 막는 준비 코드 */
const OWNER_SETUP = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static Rectangle ForegroundArea() {
    IntPtr h = GetForegroundWindow();
    RECT r;
    if (h == IntPtr.Zero || !GetWindowRect(h, out r)) return Rectangle.Empty;
    return new Rectangle(r.L, r.T, r.R - r.L, r.B - r.T);
  }

  public static void Grab(IntPtr h) {
    uint me = GetCurrentThreadId();
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    if (fg != 0 && fg != me) AttachThreadInput(fg, me, true);
    ShowWindow(h, 5);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (fg != 0 && fg != me) AttachThreadInput(fg, me, false);
  }
}
"@
[void][Fg]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

$area = [Fg]::ForegroundArea()
if ($area.Width -gt 0) { $screen = [System.Windows.Forms.Screen]::FromRectangle($area) }
else                   { $screen = [System.Windows.Forms.Screen]::PrimaryScreen }
$wa = $screen.WorkingArea

$owner = New-Object System.Windows.Forms.Form
$owner.FormBorderStyle = 'None'
$owner.MinimumSize     = New-Object System.Drawing.Size(0,0)
$owner.StartPosition   = 'Manual'
$owner.Location        = New-Object System.Drawing.Point(([int]($wa.Left + $wa.Width / 2)), ([int]($wa.Top + $wa.Height / 2)))
$owner.Size            = New-Object System.Drawing.Size(1,1)
$owner.Opacity         = 0
$owner.ShowInTaskbar   = $false
$owner.TopMost         = $true
$owner.Show()
$owner.Activate()
[Fg]::Grab($owner.Handle)
[System.Windows.Forms.Application]::DoEvents()
`;

const OWNER_CLEANUP = `
$owner.Close()
$owner.Dispose()
`;

/** 폴더 하나 고르기 */
async function pickFolder(title, initialDir) {
  const init = initialDir && fs.existsSync(initialDir) ? initialDir : '';
  const lines = await runPs(`${OWNER_SETUP}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${String(title || '폴더 선택').replace(/'/g, "''")}'
$d.ShowNewFolderButton = $true
${init ? `$d.SelectedPath = '${init.replace(/'/g, "''")}'` : ''}
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  $d.SelectedPath | Out-File -FilePath '__OUT__' -Encoding utf8
}
$d.Dispose()
${OWNER_CLEANUP}`, { dialog: true });
  return lines[0] || null;
}

/** 파일 하나 고르기 (명단 파일용) */
async function pickFile(title, filter, initialDir) {
  const init = initialDir && fs.existsSync(initialDir) ? initialDir : '';
  const lines = await runPs(`${OWNER_SETUP}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '${String(title || '파일 선택').replace(/'/g, "''")}'
$d.Multiselect = $false
$d.Filter = '${String(filter || '모든 파일|*.*').replace(/'/g, "''")}'
${init ? `$d.InitialDirectory = '${init.replace(/'/g, "''")}'` : ''}
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  $d.FileName | Out-File -FilePath '__OUT__' -Encoding utf8
}
$d.Dispose()
${OWNER_CLEANUP}`, { dialog: true });
  return lines[0] || null;
}

/** 파일 저장 자리 고르기 (현황 CSV 내보내기용) */
async function saveFileAs(title, suggestName, filter, initialDir) {
  const init = initialDir && fs.existsSync(initialDir) ? initialDir : '';
  const lines = await runPs(`${OWNER_SETUP}
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Title = '${String(title || '저장').replace(/'/g, "''")}'
$d.FileName = '${String(suggestName || '현황.csv').replace(/'/g, "''")}'
$d.Filter = '${String(filter || '모든 파일|*.*').replace(/'/g, "''")}'
$d.OverwritePrompt = $true
${init ? `$d.InitialDirectory = '${init.replace(/'/g, "''")}'` : ''}
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  $d.FileName | Out-File -FilePath '__OUT__' -Encoding utf8
}
$d.Dispose()
${OWNER_CLEANUP}`, { dialog: true });
  return lines[0] || null;
}

/** 탐색기에서 열기 (파일이면 그 파일을 고른 채로) */
function reveal(target) {
  return new Promise((resolve) => {
    let st = null;
    try { st = fs.statSync(target); } catch (_) { return resolve(false); }
    const args = st.isDirectory() ? [path.resolve(target)] : ['/select,', path.resolve(target)];
    execFile('explorer.exe', args, { windowsHide: true }, () => resolve(true));
    setTimeout(() => resolve(true), 800);       // explorer 는 종종 비정상 종료코드를 낸다
  });
}

module.exports = { pickFolder, pickFile, saveFileAs, reveal, TMP };
