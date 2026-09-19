; 문제풀이도구 — Inno Setup 설치 스크립트
; 빌드:  ISCC.exe installer\QuizBench.iss   (build_installer.ps1 이 대신 해 준다)
; 사전 조건: dist\QuizBench.exe (node SEA 단일 실행 파일) 가 만들어져 있어야 한다.
;
; 관리자 권한 없이 설치되도록 PrivilegesRequired=lowest 를 쓴다.

#define AppName "문제풀이도구"
#define AppShortName "QuizBench"
#define AppVersion "1.0.0"
#define AppExe "문제풀이도구.exe"

[Setup]
AppId={{6C92F1AB-38E4-4D57-A0B3-5E71D2C48F96}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=학교 업무용
DefaultDirName={autopf}\{#AppShortName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist\installer
OutputBaseFilename=문제풀이도구_설치_{#AppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕 화면에 바로 가기 만들기"; GroupDescription: "추가 아이콘:"

[Files]
Source: "..\dist\QuizBench.exe"; DestDir: "{app}"; DestName: "{#AppExe}"; Flags: ignoreversion
Source: "..\사용법.txt"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\사용법"; Filename: "{app}\사용법.txt"
Name: "{group}\{#AppName} 제거"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{#AppName} 실행"; Flags: nowait postinstall skipifsilent

; 설정(%APPDATA%\QuizBench)은 사용자 것이므로 제거할 때 건드리지 않는다.
