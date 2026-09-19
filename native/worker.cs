/* 이미지 매크로 — 도우미 프로그램(worker.exe) 소스 한 벌
 *
 * 이 프로그램은 혼자 실행하는 것이 아니라, 노드 서버(server.js)가 뒤에서 몰래 띄워 놓고
 * 글자 한 줄씩 주고받으며 부려 쓰는 "손발" 이다. 하는 일은 다섯 가지다.
 *
 *   1) 화면을 사진으로 찍는다                (capture)
 *   2) 찍은 화면에서 등록한 그림을 찾는다      (find — 이 도구의 심장)
 *   3) 마우스를 옮기고 누르고 글자를 넣는다     (click · move · drag · scroll · type · keys)
 *   4) 영역을 고르는 파란 막을 띄우고, 찾은 곳에 빨간 테두리를 잠깐 보여 준다 (pick · highlight)
 *   5) 창 하나만 상대한다 — 사람의 마우스를 빼앗지 않고 그 창에 쪽지만 보낸다
 *      (windows · findwindow · activate · postclick · postscroll · postkeys · posttext,
 *       그리고 capture·find 에 hwnd 를 얹으면 화면이 아니라 그 창 안을 본다)
 *
 * 주고받는 방식(JSON Lines)
 *   들어옴 : {"id":12,"cmd":"find","args":{ ... }}          ← 한 줄
 *   나감   : {"id":12,"ok":true,"data":{ ... },"env":{ ... }} ← 한 줄
 *   나감   : {"id":12,"ok":false,"error":"한글 설명","env":{ ... }}
 *   맨 처음 한 번 : {"id":0,"ok":true,"data":{"ready":true, ...},"env":{ ... }}
 *
 * 만들 때(윈도우 기본 컴파일러, C# 5 만 쓴다)
 *   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe -nologo -unsafe -optimize+ -target:winexe
 *     -out:worker.exe -r:System.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll -r:System.Core.dll
 *     native\worker.cs
 *
 * 스스로 점검  :  worker.exe --selftest   (화면·마우스는 건드리지 않고 가짜 그림으로만 검사)
 * 이 파일은 UTF-8 BOM 으로 저장해야 한글이 깨지지 않는다.
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace ImageMacro
{
  /* 사용자에게 그대로 보여 줄 한글 오류. 이 예외만 error 문구로 나간다. */
  internal class WorkerError : Exception
  {
    public WorkerError(string message) : base(message) { }
  }

  /* ────────────────────────────────────────────────────────────────────
   * JSON — 라이브러리 없이 직접 읽고 쓴다.
   *   읽기 : 객체는 Dictionary<string,object>, 배열은 List<object>,
   *          글자는 string, 숫자는 double, 참거짓은 bool, 빈 값은 null
   *   쓰기 : 넣은 순서를 지키는 JObj 를 쓴다. 한글·특수문자는 모두 \uXXXX 로
   *          바꿔 ASCII 만 내보내므로 인코딩 사고가 없다.
   * ──────────────────────────────────────────────────────────────────── */

  /* 넣은 순서대로 나오는 작은 JSON 객체 */
  internal class JObj
  {
    private List<string> keys = new List<string>();
    private List<object> vals = new List<object>();

    public JObj Set(string key, object val)
    {
      keys.Add(key);
      vals.Add(val);
      return this;
    }
    public int Count { get { return keys.Count; } }
    public string KeyAt(int i) { return keys[i]; }
    public object ValAt(int i) { return vals[i]; }
  }

  internal static class Json
  {
    /* ── 쓰기 ───────────────────────────────────────────────────────── */

    public static string Write(object v)
    {
      StringBuilder sb = new StringBuilder(256);
      Put(sb, v);
      return sb.ToString();
    }

    private static void Put(StringBuilder sb, object v)
    {
      if (v == null) { sb.Append("null"); return; }
      if (v is bool) { sb.Append(((bool)v) ? "true" : "false"); return; }
      if (v is string) { PutText(sb, (string)v); return; }
      if (v is int) { sb.Append(((int)v).ToString(CultureInfo.InvariantCulture)); return; }
      if (v is long) { sb.Append(((long)v).ToString(CultureInfo.InvariantCulture)); return; }
      if (v is double) { PutNum(sb, (double)v); return; }
      if (v is float) { PutNum(sb, (double)(float)v); return; }
      if (v is JObj)
      {
        JObj o = (JObj)v;
        sb.Append('{');
        for (int i = 0; i < o.Count; i++)
        {
          if (i > 0) sb.Append(',');
          PutText(sb, o.KeyAt(i));
          sb.Append(':');
          Put(sb, o.ValAt(i));
        }
        sb.Append('}');
        return;
      }
      if (v is Dictionary<string, object>)
      {
        Dictionary<string, object> d = (Dictionary<string, object>)v;
        sb.Append('{');
        bool first = true;
        foreach (KeyValuePair<string, object> kv in d)
        {
          if (!first) sb.Append(',');
          first = false;
          PutText(sb, kv.Key);
          sb.Append(':');
          Put(sb, kv.Value);
        }
        sb.Append('}');
        return;
      }
      if (v is List<object>)
      {
        List<object> a = (List<object>)v;
        sb.Append('[');
        for (int i = 0; i < a.Count; i++)
        {
          if (i > 0) sb.Append(',');
          Put(sb, a[i]);
        }
        sb.Append(']');
        return;
      }
      /* 그 밖의 것은 글자로 */
      PutText(sb, Convert.ToString(v, CultureInfo.InvariantCulture));
    }

    private static void PutNum(StringBuilder sb, double d)
    {
      if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append('0'); return; }
      if (d == Math.Floor(d) && Math.Abs(d) < 1e15)
      {
        sb.Append(((long)d).ToString(CultureInfo.InvariantCulture));
        return;
      }
      sb.Append(d.ToString("0.######", CultureInfo.InvariantCulture));
    }

    /* 글자 넣기 — ASCII 가 아닌 것은 모두 \uXXXX 로 */
    private static void PutText(StringBuilder sb, string s)
    {
      sb.Append('"');
      if (s != null)
      {
        for (int i = 0; i < s.Length; i++)
        {
          char c = s[i];
          if (c == '"') sb.Append("\\\"");
          else if (c == '\\') sb.Append("\\\\");
          else if (c == '\n') sb.Append("\\n");
          else if (c == '\r') sb.Append("\\r");
          else if (c == '\t') sb.Append("\\t");
          else if (c == '\b') sb.Append("\\b");
          else if (c == '\f') sb.Append("\\f");
          else if (c >= 0x20 && c <= 0x7E) sb.Append(c);
          else sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
        }
      }
      sb.Append('"');
    }

    /* ── 읽기 ───────────────────────────────────────────────────────── */

    public static object Parse(string text)
    {
      if (text == null) throw new WorkerError("빈 줄이 들어왔습니다.");
      int i = 0;
      object v = Value(text, ref i);
      Space(text, ref i);
      return v;
    }

    private static void Space(string s, ref int i)
    {
      while (i < s.Length)
      {
        char c = s[i];
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') i++;
        else break;
      }
    }

    private static object Value(string s, ref int i)
    {
      Space(s, ref i);
      if (i >= s.Length) throw new WorkerError("JSON 이 도중에 끊겼습니다.");
      char c = s[i];
      if (c == '{') return Obj(s, ref i);
      if (c == '[') return Arr(s, ref i);
      if (c == '"') return Text(s, ref i);
      if (c == 't')
      {
        Word(s, ref i, "true");
        return true;
      }
      if (c == 'f')
      {
        Word(s, ref i, "false");
        return false;
      }
      if (c == 'n')
      {
        Word(s, ref i, "null");
        return null;
      }
      return Num(s, ref i);
    }

    private static void Word(string s, ref int i, string w)
    {
      if (i + w.Length > s.Length || string.CompareOrdinal(s, i, w, 0, w.Length) != 0)
        throw new WorkerError("JSON 을 읽을 수 없습니다(" + w + " 가 있어야 할 자리).");
      i += w.Length;
    }

    private static Dictionary<string, object> Obj(string s, ref int i)
    {
      Dictionary<string, object> d = new Dictionary<string, object>();
      i++; /* { */
      Space(s, ref i);
      if (i < s.Length && s[i] == '}') { i++; return d; }
      while (true)
      {
        Space(s, ref i);
        if (i >= s.Length || s[i] != '"') throw new WorkerError("JSON 객체의 이름은 따옴표로 감싸야 합니다.");
        string key = Text(s, ref i);
        Space(s, ref i);
        if (i >= s.Length || s[i] != ':') throw new WorkerError("JSON 객체에 콜론(:)이 없습니다.");
        i++;
        d[key] = Value(s, ref i);
        Space(s, ref i);
        if (i >= s.Length) throw new WorkerError("JSON 객체가 닫히지 않았습니다.");
        if (s[i] == ',') { i++; continue; }
        if (s[i] == '}') { i++; return d; }
        throw new WorkerError("JSON 객체에서 쉼표나 닫는 괄호를 찾지 못했습니다.");
      }
    }

    private static List<object> Arr(string s, ref int i)
    {
      List<object> a = new List<object>();
      i++; /* [ */
      Space(s, ref i);
      if (i < s.Length && s[i] == ']') { i++; return a; }
      while (true)
      {
        a.Add(Value(s, ref i));
        Space(s, ref i);
        if (i >= s.Length) throw new WorkerError("JSON 배열이 닫히지 않았습니다.");
        if (s[i] == ',') { i++; continue; }
        if (s[i] == ']') { i++; return a; }
        throw new WorkerError("JSON 배열에서 쉼표나 닫는 괄호를 찾지 못했습니다.");
      }
    }

    private static string Text(string s, ref int i)
    {
      StringBuilder sb = new StringBuilder();
      i++; /* 여는 따옴표 */
      while (true)
      {
        if (i >= s.Length) throw new WorkerError("JSON 글자가 닫히지 않았습니다.");
        char c = s[i++];
        if (c == '"') return sb.ToString();
        if (c != '\\') { sb.Append(c); continue; }
        if (i >= s.Length) throw new WorkerError("JSON 글자의 역슬래시가 혼자 있습니다.");
        char e = s[i++];
        if (e == '"') sb.Append('"');
        else if (e == '\\') sb.Append('\\');
        else if (e == '/') sb.Append('/');
        else if (e == 'b') sb.Append('\b');
        else if (e == 'f') sb.Append('\f');
        else if (e == 'n') sb.Append('\n');
        else if (e == 'r') sb.Append('\r');
        else if (e == 't') sb.Append('\t');
        else if (e == 'u')
        {
          if (i + 4 > s.Length) throw new WorkerError("JSON 의 \\u 뒤 숫자가 모자랍니다.");
          int code = int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
          i += 4;
          sb.Append((char)code);
        }
        else throw new WorkerError("JSON 에서 모르는 역슬래시 표기입니다: \\" + e);
      }
    }

    private static object Num(string s, ref int i)
    {
      int start = i;
      if (i < s.Length && (s[i] == '-' || s[i] == '+')) i++;
      while (i < s.Length)
      {
        char c = s[i];
        if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') i++;
        else break;
      }
      string t = s.Substring(start, i - start);
      double d;
      if (!double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
        throw new WorkerError("JSON 에서 숫자를 읽을 수 없습니다: " + t);
      return d;
    }

    /* ── 읽은 값에서 꺼내 쓰기 ──────────────────────────────────────── */

    public static object At(Dictionary<string, object> d, string key)
    {
      if (d == null) return null;
      object v;
      if (d.TryGetValue(key, out v)) return v;
      return null;
    }
    public static string AsText(object v, string dflt)
    {
      if (v == null) return dflt;
      if (v is string) return (string)v;
      if (v is bool) return ((bool)v) ? "true" : "false";
      if (v is double) return ((double)v).ToString("0.######", CultureInfo.InvariantCulture);
      return Convert.ToString(v, CultureInfo.InvariantCulture);
    }
    public static double AsNum(object v, double dflt)
    {
      if (v is double) return (double)v;
      if (v is bool) return ((bool)v) ? 1 : 0;
      if (v is string)
      {
        double d;
        if (double.TryParse((string)v, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
      }
      return dflt;
    }
    public static int AsInt(object v, int dflt)
    {
      double d = AsNum(v, (double)dflt);
      if (double.IsNaN(d) || double.IsInfinity(d)) return dflt;
      return (int)Math.Round(d);
    }
    public static bool AsBool(object v, bool dflt)
    {
      if (v is bool) return (bool)v;
      if (v is double) return ((double)v) != 0;
      if (v is string)
      {
        string s = ((string)v).Trim().ToLowerInvariant();
        if (s == "true" || s == "1" || s == "yes" || s == "on") return true;
        if (s == "false" || s == "0" || s == "no" || s == "off") return false;
      }
      return dflt;
    }
    public static Dictionary<string, object> AsObj(object v)
    {
      if (v is Dictionary<string, object>) return (Dictionary<string, object>)v;
      return null;
    }
    public static List<object> AsArr(object v)
    {
      if (v is List<object>) return (List<object>)v;
      return null;
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 사각형 — {x,y,w,h}. 좌표는 언제나 "가상 화면 기준 물리 픽셀" 이다.
   * (모니터가 여러 대면 왼쪽 위 모니터보다 더 왼쪽/위에 있는 화면은 음수 좌표가 된다)
   * ──────────────────────────────────────────────────────────────────── */
  internal struct Box
  {
    public int x, y, w, h;

    public static Box Make(int x, int y, int w, int h)
    {
      Box b;
      b.x = x; b.y = y; b.w = w; b.h = h;
      return b;
    }
    public bool Empty { get { return w <= 0 || h <= 0; } }

    /* 두 사각형이 겹치는 부분 */
    public static Box Cross(Box a, Box b)
    {
      int x1 = Math.Max(a.x, b.x);
      int y1 = Math.Max(a.y, b.y);
      int x2 = Math.Min(a.x + a.w, b.x + b.w);
      int y2 = Math.Min(a.y + a.h, b.y + b.h);
      return Make(x1, y1, Math.Max(0, x2 - x1), Math.Max(0, y2 - y1));
    }
    public JObj ToJson()
    {
      JObj o = new JObj();
      o.Set("x", x).Set("y", y).Set("w", w).Set("h", h);
      return o;
    }
    public string Key { get { return x + "," + y + "," + w + "," + h; } }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 윈도우 알맹이 함수들(P/Invoke). 여기 모아 둔다.
   * ──────────────────────────────────────────────────────────────────── */
  internal static class W32
  {
    /* 화면 배율(DPI) 인식 — 이걸 안 켜면 고해상도 화면에서 좌표가 어긋난다 */
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDPIAware();

    /* 키·마우스·잠금·놀고 있던 시간 */
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr desktop);

    /* 입력 넣기 */
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint code, uint mapType);

    /* 절전 막기 */
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);

    /* 소리 */
    [DllImport("kernel32.dll")]
    public static extern bool Beep(uint freq, uint duration);

    /* 화면 배율 알아내기 */
    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")]
    public static extern int GetDeviceCaps(IntPtr dc, int index);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
      public int dx;
      public int dy;
      public uint mouseData;
      public uint dwFlags;
      public uint time;
      public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
      public ushort wVk;
      public ushort wScan;
      public uint dwFlags;
      public uint time;
      public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
      public uint uMsg;
      public ushort wParamL;
      public ushort wParamH;
    }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTBODY
    {
      [FieldOffset(0)] public MOUSEINPUT mi;
      [FieldOffset(0)] public KEYBDINPUT ki;
      [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
      public uint type;
      public INPUTBODY body;
    }

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;
    public const uint ES_DISPLAY_REQUIRED = 0x00000002;

    public const int LOGPIXELSX = 88;
    public const uint DESKTOP_READOBJECTS = 0x0001;

    /* ── 창(윈도) 다루기 — "창 지정 모드" 에 쓴다 ─────────────────── */

    public delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc cb, IntPtr param);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
    public static extern int GetWindowText(IntPtr hwnd, StringBuilder buf, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
    public static extern int GetClassName(IntPtr hwnd, StringBuilder buf, int max);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hwnd, ref POINT p);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")]
    public static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT pt, uint flags);
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "PostMessageW")]
    public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);
    /* 창의 z 순서(앞뒤 차례)만 바꾼다. 되살린 창을 맨 뒤로 보낼 때 쓴다. */
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    /* 창을 맨 앞으로 올린다(포커스는 따로다) */
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);

    /* 어느 실(thread)에서 지금 어느 창이 글자를 받고 있는지 알려 준다.
       앞에 나와 있지 않은 창도 알 수 있어서, 가려진 창에 글자를 넣을 때 쓴다. */
    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
      public int cbSize;
      public uint flags;
      public IntPtr hwndActive;
      public IntPtr hwndFocus;
      public IntPtr hwndCapture;
      public IntPtr hwndMenuOwner;
      public IntPtr hwndMoveSize;
      public IntPtr hwndCaret;
      public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left; public int top; public int right; public int bottom; }

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    /* 사용자가 "항상 위에 보이기" 로 해 둔 창. 이런 창을 맨 뒤로 보내면 그 설정이 벗겨진다. */
    public const int WS_EX_TOPMOST = 0x00000008;
    public const uint CWP_SKIPINVISIBLE = 0x0001;
    public const uint CWP_SKIPDISABLED = 0x0002;
    public const uint CWP_SKIPTRANSPARENT = 0x0004;
    public const int SW_RESTORE = 9;
    public const int SW_SHOWNOACTIVATE = 4;
    public const uint SRCCOPY = 0x00CC0020;

    /* SetWindowPos 에 쓰는 값들 — 자리·크기는 그대로 두고 앞뒤 차례만 바꾼다 */
    public static readonly IntPtr HWND_TOP = IntPtr.Zero;
    public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;

    public const int VK_ESCAPE = 0x1B;

    public const uint PW_CLIENTONLY = 1;
    public const uint PW_RENDERFULLCONTENT = 2;

    public const uint WM_MOUSEMOVE = 0x0200;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public const uint WM_LBUTTONDBLCLK = 0x0203;
    public const uint WM_RBUTTONDOWN = 0x0204;
    public const uint WM_RBUTTONUP = 0x0205;
    public const uint WM_RBUTTONDBLCLK = 0x0206;
    public const uint WM_MBUTTONDOWN = 0x0207;
    public const uint WM_MBUTTONUP = 0x0208;
    public const uint WM_MBUTTONDBLCLK = 0x0209;
    public const uint WM_MOUSEWHEEL = 0x020A;
    public const uint WM_MOUSEHWHEEL = 0x020E;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const uint WM_CHAR = 0x0102;

    public const int MK_LBUTTON = 0x0001;
    public const int MK_RBUTTON = 0x0002;
    public const int MK_MBUTTON = 0x0010;
    /* 휠 쪽지에 "Ctrl 을 누른 채" 를 실으면 대부분의 프로그램이 배율을 바꾼다
       (브라우저·PDF 뷰어·한글·엑셀 모두 같다) */
    public const int MK_CONTROL = 0x0008;
  }


  /* ────────────────────────────────────────────────────────────────────
   * 파수꾼 — 비상 정지 키 감시, 화면 잠김 확인, 사람이 놀고 있던 시간.
   *
   * 비상 정지 키(기본 F12)는 어느 창이 앞에 있어도 들어야 하므로
   * 따로 도는 실 하나가 12ms 마다 키 상태를 살핀다. 한 번이라도 눌리면
   * clearstop 이 오기 전까지 깃발을 내리지 않는다("끈적한 깃발").
   * ──────────────────────────────────────────────────────────────────── */
  internal static class Guard
  {
    private static volatile bool stopFlag = false;
    private static volatile int stopVk = 0x7B;   /* VK_F12 */
    private static volatile bool lockedSeen = false;
    private static int lockedAt = 0;
    private static volatile bool watching = false;

    public static void Start()
    {
      if (watching) return;
      watching = true;
      Thread th = new Thread(new ThreadStart(Loop));
      th.IsBackground = true;
      th.Name = "정지키 감시";
      th.Start();
    }

    private static void Loop()
    {
      while (true)
      {
        try
        {
          int s = W32.GetAsyncKeyState(stopVk);
          /* 0x8000 = 지금 눌려 있음, 0x0001 = 지난 확인 뒤로 한 번 눌렸음 */
          if ((s & 0x8000) != 0 || (s & 0x0001) != 0) stopFlag = true;
        }
        catch (Exception) { }
        Thread.Sleep(12);
      }
    }

    public static bool Stopped { get { return stopFlag; } }

    public static void Clear()
    {
      stopFlag = false;
      try { W32.GetAsyncKeyState(stopVk); } catch (Exception) { }   /* 눌린 기록 비우기 */
    }

    /* 비상 정지 키를 바꿀 수 있게 해 둔다(설정의 stopKey) */
    public static void UseKey(int vk)
    {
      if (vk > 0 && vk < 256) stopVk = vk;
    }
    public static int KeyVk { get { return stopVk; } }

    /* 화면이 잠겨 있으면 캡처가 새카맣게 나온다. 그래서 미리 알려 준다.
       (입력 데스크톱을 열어 볼 수 없으면 잠긴 것이다) */
    public static bool Locked()
    {
      int now = Environment.TickCount;
      if (lockedAt != 0 && (now - lockedAt) < 250) return lockedSeen;
      bool locked = false;
      try
      {
        IntPtr d = W32.OpenInputDesktop(0, false, W32.DESKTOP_READOBJECTS);
        if (d == IntPtr.Zero) locked = true;
        else W32.CloseDesktop(d);
      }
      catch (Exception) { locked = false; }
      lockedSeen = locked;
      lockedAt = now == 0 ? 1 : now;
      return locked;
    }

    /* 사람이 마우스·키보드를 건드리지 않고 지난 시간(ms) */
    public static int IdleMs()
    {
      try
      {
        W32.LASTINPUTINFO li = new W32.LASTINPUTINFO();
        li.cbSize = (uint)Marshal.SizeOf(typeof(W32.LASTINPUTINFO));
        if (!W32.GetLastInputInfo(ref li)) return 0;
        long d = (long)(uint)Environment.TickCount - (long)li.dwTime;
        if (d < 0) d = 0;
        if (d > int.MaxValue) d = int.MaxValue;
        return (int)d;
      }
      catch (Exception) { return 0; }
    }

    public static W32.POINT Cursor()
    {
      W32.POINT p;
      p.x = 0; p.y = 0;
      try { W32.GetCursorPos(out p); } catch (Exception) { }
      return p;
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 화면 정보와 화면 찍기
   * ──────────────────────────────────────────────────────────────────── */
  internal static class Sc
  {
    /* 모니터를 다 합친 큰 사각형 */
    public static Box All()
    {
      Rectangle r = SystemInformation.VirtualScreen;
      if (r.Width <= 0 || r.Height <= 0)
        r = new Rectangle(0, 0, Math.Max(1, Screen.PrimaryScreen.Bounds.Width), Math.Max(1, Screen.PrimaryScreen.Bounds.Height));
      return Box.Make(r.X, r.Y, r.Width, r.Height);
    }

    public static List<object> List()
    {
      List<object> arr = new List<object>();
      Screen[] all = Screen.AllScreens;
      for (int i = 0; i < all.Length; i++)
      {
        Rectangle b = all[i].Bounds;
        JObj o = new JObj();
        o.Set("index", i).Set("x", b.X).Set("y", b.Y).Set("w", b.Width).Set("h", b.Height)
         .Set("primary", all[i].Primary);
        arr.Add(o);
      }
      return arr;
    }

    /* 화면 배율(100% = 1.0). 오버레이 글씨 크기를 맞추는 데만 쓴다. */
    public static double UiScale()
    {
      try
      {
        IntPtr dc = W32.GetDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) return 1.0;
        int dpi = W32.GetDeviceCaps(dc, W32.LOGPIXELSX);
        W32.ReleaseDC(IntPtr.Zero, dc);
        if (dpi <= 0) return 1.0;
        double s = dpi / 96.0;
        if (s < 1.0) s = 1.0;
        if (s > 3.0) s = 3.0;
        return s;
      }
      catch (Exception) { return 1.0; }
    }

    /* 화면의 한 부분을 그림으로 찍는다. 부르는 쪽에서 Dispose 해야 한다. */
    public static Bitmap Grab(Box r)
    {
      Box v = All();
      Box use = Box.Cross(r, v);
      if (use.Empty)
        throw new WorkerError("고른 영역이 화면 밖에 있습니다. 영역을 다시 지정해 주세요.");
      Bitmap bmp = new Bitmap(use.w, use.h, PixelFormat.Format32bppRgb);
      try
      {
        using (Graphics g = Graphics.FromImage(bmp))
        {
          g.CopyFromScreen(use.x, use.y, 0, 0, new Size(use.w, use.h), CopyPixelOperation.SourceCopy);
        }
      }
      catch (Exception e)
      {
        bmp.Dispose();
        throw new WorkerError("화면을 찍지 못했습니다: " + e.Message);
      }
      return bmp;
    }

    /* 찍힌 자리(잘려 나간 뒤의 실제 영역) */
    public static Box GrabBox(Box r)
    {
      return Box.Cross(r, All());
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 그림 한 장을 숫자 배열로. 찾기 계산은 모두 이 배열 위에서 한다.
   *   ch = 1 이면 회색조(밝기만), ch = 3 이면 빨강·초록·파랑 세 겹
   *   값이 놓인 순서 : (y * w + x) * ch + c
   * ──────────────────────────────────────────────────────────────────── */
  internal class Img
  {
    public int w, h, ch;
    public byte[] px;

    public Img(int w, int h, int ch)
    {
      if (w < 1 || h < 1 || (ch != 1 && ch != 3))
        throw new WorkerError("그림 크기가 이상합니다(" + w + "x" + h + ").");
      if ((long)w * h * ch > 400000000L)
        throw new WorkerError("그림이 너무 커서 다룰 수 없습니다(" + w + "x" + h + ").");
      this.w = w; this.h = h; this.ch = ch;
      this.px = new byte[w * h * ch];
    }

    /* Bitmap → 숫자 배열. 회색조는 (r*77 + g*151 + b*28) >> 8 로 만든다. */
    public static unsafe Img FromBitmap(Bitmap bmp, bool gray)
    {
      int w = bmp.Width, h = bmp.Height;
      Img im = new Img(w, h, gray ? 1 : 3);
      BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try
      {
        byte* top = (byte*)bd.Scan0;
        fixed (byte* dst0 = im.px)
        {
          for (int y = 0; y < h; y++)
          {
            byte* s = top + (long)y * bd.Stride;
            byte* d = dst0 + (long)y * w * im.ch;
            if (gray)
            {
              for (int x = 0; x < w; x++)
              {
                int b = s[0], g = s[1], r = s[2];
                d[x] = (byte)((r * 77 + g * 151 + b * 28) >> 8);
                s += 4;
              }
            }
            else
            {
              for (int x = 0; x < w; x++)
              {
                d[0] = s[2];  /* 빨강 */
                d[1] = s[1];  /* 초록 */
                d[2] = s[0];  /* 파랑 */
                d += 3; s += 4;
              }
            }
          }
        }
      }
      finally { bmp.UnlockBits(bd); }
      return im;
    }

    /* 평균과 "평균에서 벗어난 정도의 제곱 합" 을 미리 구해 둔다(ZNCC 에 쓴다) */
    public static void Stats(byte[] px, out double mean, out double dev2)
    {
      long sum = 0, sum2 = 0;
      int n = px.Length;
      for (int i = 0; i < n; i++)
      {
        int v = px[i];
        sum += v;
        sum2 += (long)v * v;
      }
      mean = n > 0 ? (double)sum / n : 0;
      dev2 = (double)sum2 - (double)n * mean * mean;
      if (dev2 < 0) dev2 = 0;
    }

    /* 상자 평균으로 k 배 줄이기(거칠게 훑을 때 쓴다) */
    public static unsafe Img Reduce(Img s, int k)
    {
      if (k <= 1 || s.w < k || s.h < k) return s;
      int rw = s.w / k, rh = s.h / k, ch = s.ch;
      Img r = new Img(rw, rh, ch);
      int div = k * k;
      int srow = s.w * ch;
      fixed (byte* sp = s.px)
      fixed (byte* dp = r.px)
      {
        for (int y = 0; y < rh; y++)
        {
          byte* d = dp + (long)y * rw * ch;
          byte* blockTop = sp + (long)(y * k) * srow;
          for (int x = 0; x < rw; x++)
          {
            byte* cell = blockTop + (long)(x * k) * ch;
            for (int c = 0; c < ch; c++)
            {
              int sum = 0;
              byte* q0 = cell + c;
              for (int dy = 0; dy < k; dy++)
              {
                byte* q = q0 + (long)dy * srow;
                for (int dx = 0; dx < k; dx++) { sum += *q; q += ch; }
              }
              d[x * ch + c] = (byte)(sum / div);
            }
          }
        }
      }
      return r;
    }

    /* 줄인 그림을 1-2-1 로 살짝 흐리게 만든다(가로 한 번, 세로 한 번).
       왜 이걸 하나 — 줄일 때 "칸 경계" 가 화면 왼쪽 위에서부터 k 화소마다 끊긴다.
       그런데 찾는 그림이 화면에 놓인 자리가 k 의 배수가 아니면(예: k=3 인데 y=655),
       화면 쪽 칸은 그림의 칸과 어긋난 채로 평균이 난다. 그러면 똑같은 그림인데도
       줄인 그림끼리는 딴 그림처럼 보인다 — 실제로 원본에서 1.000 인 자리가
       줄인 그림에서는 0.69 밖에 안 나왔다. 그 때문에
         · 2단계가 봉우리를 진짜 자리에서 6화소 옆으로 잡고(3단계의 ±(k+1) 창이 놓친다),
         · 2단계 점수가 "임계값 − 0.15" 아래로 떨어져 3단계에 가기 전에 버려졌다.
       가장자리를 살짝 무디게 하면 칸이 어긋난 만큼의 차이가 대부분 상쇄된다.
       화면과 그림에 똑같이 걸어야 뜻이 있다. (무작위 1000가지 배치에서
       여러 개 세기 실패 25건 → 0건. 없는 그림의 최고 점수는 0.476 → 0.478 로 그대로,
       걸린 시간도 73ms → 70ms 로 그대로다.) */
    public static unsafe void Soften(Img r)
    {
      int w = r.w, h = r.h, ch = r.ch;
      int row = w * ch;
      byte[] tmp = new byte[r.px.Length];
      fixed (byte* p = r.px)
      fixed (byte* t = tmp)
      {
        for (int y = 0; y < h; y++)          /* 가로 방향 */
        {
          byte* s = p + (long)y * row;
          byte* d = t + (long)y * row;
          for (int x = 0; x < w; x++)
          {
            int xm = (x > 0 ? x - 1 : 0) * ch;
            int xp = (x < w - 1 ? x + 1 : w - 1) * ch;
            int xc = x * ch;
            for (int c = 0; c < ch; c++)
              d[xc + c] = (byte)((s[xm + c] + 2 * s[xc + c] + s[xp + c]) >> 2);
          }
        }
        for (int y = 0; y < h; y++)          /* 세로 방향 */
        {
          byte* a = t + (long)(y > 0 ? y - 1 : 0) * row;
          byte* b = t + (long)y * row;
          byte* e = t + (long)(y < h - 1 ? y + 1 : h - 1) * row;
          byte* d = p + (long)y * row;
          for (int i = 0; i < row; i++) d[i] = (byte)((a[i] + 2 * b[i] + e[i]) >> 2);
        }
      }
    }
  }

  /* 줄인 템플릿 + 거친 걸러내기에 쓸 표본 화소 */
  internal class Small
  {
    public int w, h, ch;
    public byte[] px;
    public double mean, dev2;
    public int ns;          /* 표본 개수 */
    public int[] sx;        /* 표본의 x */
    public int[] sy;        /* 표본의 y */
    public byte[] sval;     /* 표본 값 (ns * ch 개) */
  }

  /* 찾을 그림(템플릿) 하나. 무거운 계산은 만들 때 한 번만 한다. */
  internal class Tpl
  {
    public Img img;
    public double mean, dev2;
    public int k;      /* 축소 배율 */
    public Small sm;   /* 축소본 */

    public static Tpl Build(Img img)
    {
      Tpl t = new Tpl();
      t.img = img;
      Img.Stats(img.px, out t.mean, out t.dev2);

      /* 축소 배율 — 작은 그림은 줄이면 특징이 사라지므로 덜 줄인다 */
      int shortSide = Math.Min(img.w, img.h);
      int k = shortSide < 16 ? 1 : (shortSide < 40 ? 2 : (shortSide < 90 ? 3 : 4));
      while (k > 1 && (img.w / k < 4 || img.h / k < 4)) k--;
      t.k = k;

      Img r = (k == 1) ? img : Img.Reduce(img, k);
      /* 줄인 그림은 화면 쪽과 똑같이 살짝 무디게 한다(Img.Soften 의 설명을 보라).
         Reduce 가 (너무 작아서) 원본을 그대로 돌려준 경우에는 건드리면 안 된다 —
         3단계에서 쓸 원본 화소가 흐려져 버린다. 그래서 다른 그림일 때만 한다. */
      if (!object.ReferenceEquals(r, img)) Img.Soften(r);
      Small s = new Small();
      s.w = r.w; s.h = r.h; s.ch = r.ch; s.px = r.px;
      Img.Stats(s.px, out s.mean, out s.dev2);
      PickSamples(s);
      t.sm = s;
      return t;
    }

    /* 표본 화소 고르기 — 격자로 고르게 뽑은 뒤, 평균에서 많이 벗어난 순서로 24개.
       (배경처럼 밋밋한 자리보다 글자·테두리 같은 자리가 훨씬 잘 걸러 낸다)

       한 가지 주의: 그냥 "많이 벗어난 순서" 로만 뽑으면, 예를 들어 파란 단추에
       흰 글자가 적힌 그림에서는 24개가 모두 흰 화소로 채워진다. 그러면 화면의
       하얀 빈 곳이 전부 "닮은 곳" 으로 보여서 1단계가 제구실을 못 한다.
       그래서 평균보다 밝은 쪽과 어두운 쪽에서 번갈아 뽑아 양쪽을 함께 담는다. */
    private static void PickSamples(Small s)
    {
      const int WANT = 24;
      int gw = Math.Min(s.w, 12), gh = Math.Min(s.h, 12);
      if (gw < 1) gw = 1;
      if (gh < 1) gh = 1;
      int n = gw * gh;
      int[] xs = new int[n], ys = new int[n], order = new int[n];
      double[] gv = new double[n];
      int m = 0;
      double gsum = 0;
      for (int iy = 0; iy < gh; iy++)
      {
        int y = (int)(((double)iy + 0.5) * s.h / gh);
        if (y >= s.h) y = s.h - 1;
        for (int ix = 0; ix < gw; ix++)
        {
          int x = (int)(((double)ix + 0.5) * s.w / gw);
          if (x >= s.w) x = s.w - 1;
          int o = (y * s.w + x) * s.ch;
          double g;
          if (s.ch == 1) g = s.px[o];
          else g = (s.px[o] * 77 + s.px[o + 1] * 151 + s.px[o + 2] * 28) / 256.0;
          xs[m] = x; ys[m] = y; gv[m] = g; order[m] = m;
          gsum += g;
          m++;
        }
      }
      double gmean = gsum / m;

      /* 밝은 쪽·어두운 쪽으로 나눠 각각 "많이 벗어난 순서" 로 줄을 세운다 */
      int[] hi = new int[m], lo = new int[m];
      int nh = 0, nl = 0;
      for (int i = 0; i < m; i++)
      {
        if (gv[i] >= gmean) hi[nh++] = i;
        else lo[nl++] = i;
      }
      SortByGap(hi, nh, gv, gmean);
      SortByGap(lo, nl, gv, gmean);

      int want = Math.Min(WANT, m);
      int a = 0, b = 0, put = 0;
      while (put < want)
      {
        if ((put % 2) == 0)
        {
          if (a < nh) { order[put++] = hi[a++]; continue; }
          if (b < nl) { order[put++] = lo[b++]; continue; }
          break;
        }
        else
        {
          if (b < nl) { order[put++] = lo[b++]; continue; }
          if (a < nh) { order[put++] = hi[a++]; continue; }
          break;
        }
      }
      want = put;
      if (want < 1) want = 1;
      s.ns = want;
      s.sx = new int[want];
      s.sy = new int[want];
      s.sval = new byte[want * s.ch];
      for (int i = 0; i < want; i++)
      {
        int j = order[i];
        s.sx[i] = xs[j];
        s.sy[i] = ys[j];
        int o = (ys[j] * s.w + xs[j]) * s.ch;
        for (int c = 0; c < s.ch; c++) s.sval[i * s.ch + c] = s.px[o + c];
      }
    }

    /* 평균에서 많이 벗어난 것부터 오도록 줄 세우기 */
    private static void SortByGap(int[] idx, int n, double[] gv, double gmean)
    {
      if (n < 2) return;
      double[] key = new double[n];
      int[] ids = new int[n];
      for (int i = 0; i < n; i++)
      {
        key[i] = -Math.Abs(gv[idx[i]] - gmean);
        ids[i] = idx[i];
      }
      Array.Sort(key, ids, 0, n);
      for (int i = 0; i < n; i++) idx[i] = ids[i];
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 템플릿 창고 — 폴링 때문에 1초에 두 번씩 불리므로, PNG 를 매번 다시
   * 풀어 보면 안 된다. 경로 + 수정시각 + 파일크기 + 회색조여부로 기억한다.
   * ──────────────────────────────────────────────────────────────────── */
  internal static class TplCache
  {
    private static Dictionary<string, Tpl> box = new Dictionary<string, Tpl>();

    public static Tpl Get(string path, bool gray)
    {
      if (string.IsNullOrEmpty(path)) throw new WorkerError("찾을 그림 파일 경로가 없습니다.");
      FileInfo fi = new FileInfo(path);
      if (!fi.Exists) throw new WorkerError("찾을 그림 파일이 없습니다: " + path);
      string key = fi.FullName.ToLowerInvariant() + "|" + fi.LastWriteTimeUtc.Ticks + "|" + fi.Length + "|" + (gray ? "g" : "c");
      Tpl t;
      if (box.TryGetValue(key, out t)) return t;

      Img im;
      try
      {
        /* 파일을 잠그지 않도록 통째로 읽어서 다룬다 */
        byte[] raw = File.ReadAllBytes(fi.FullName);
        using (MemoryStream ms = new MemoryStream(raw))
        using (Bitmap src = new Bitmap(ms))
        using (Bitmap copy = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppRgb))
        {
          using (Graphics g = Graphics.FromImage(copy))
          {
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(src, new Rectangle(0, 0, src.Width, src.Height),
                        0, 0, src.Width, src.Height, GraphicsUnit.Pixel);
          }
          im = Img.FromBitmap(copy, gray);
        }
      }
      catch (WorkerError) { throw; }
      catch (Exception e)
      {
        throw new WorkerError("그림 파일을 열 수 없습니다: " + fi.Name + " (" + e.Message + ")");
      }

      t = Tpl.Build(im);
      if (box.Count > 64) box.Clear();   /* 너무 쌓이면 비운다 */
      box[key] = t;
      return t;
    }
  }

  /* 가장 좋은(작은) 것 K 개만 남기는 그릇. 큰 값이 뿌리에 오는 힙이라
     "지금까지의 최악 후보" 를 바로 알 수 있고, 그 값으로 계산을 일찍 끊는다. */
  internal class TopK
  {
    private int cap;
    private int n;
    private int[] v, xs, ys;

    public TopK(int cap)
    {
      this.cap = cap;
      v = new int[cap];
      xs = new int[cap];
      ys = new int[cap];
      n = 0;
    }
    public int Count { get { return n; } }
    public int ValAt(int i) { return v[i]; }
    public int XAt(int i) { return xs[i]; }
    public int YAt(int i) { return ys[i]; }

    /* 아직 다 안 찼으면 무조건 받고, 찼으면 뿌리(가장 나쁜 것)보다 좋을 때만 받는다 */
    public int Worst { get { return n < cap ? int.MaxValue : v[0]; } }

    public void Add(int val, int x, int y)
    {
      if (n < cap)
      {
        v[n] = val; xs[n] = x; ys[n] = y;
        Up(n);
        n++;
        return;
      }
      if (val >= v[0]) return;
      v[0] = val; xs[0] = x; ys[0] = y;
      Down(0);
    }

    private void Up(int i)
    {
      while (i > 0)
      {
        int p = (i - 1) / 2;
        if (v[p] >= v[i]) break;
        Swap(p, i);
        i = p;
      }
    }
    private void Down(int i)
    {
      while (true)
      {
        int l = i * 2 + 1, r = l + 1, big = i;
        if (l < n && v[l] > v[big]) big = l;
        if (r < n && v[r] > v[big]) big = r;
        if (big == i) break;
        Swap(big, i);
        i = big;
      }
    }
    private void Swap(int a, int b)
    {
      int t = v[a]; v[a] = v[b]; v[b] = t;
      t = xs[a]; xs[a] = xs[b]; xs[b] = t;
      t = ys[a]; ys[a] = ys[b]; ys[b] = t;
    }
  }

  /* 찾을 그림 한 개에 대한 부탁 내용 */
  internal class FindItem
  {
    public int idx;             /* 부탁받은 순서(응답도 이 순서대로 돌려준다) */
    public string key;
    public string image;
    public double threshold;
    public bool hasRegion;
    public Box region;
    public string mode;         /* best · all */
    public int max;
    public bool grayscale;
    public string hwndText = "";  /* 창 지정 모드에서 볼 창(비어 있으면 화면 전체) */
    public WinInfo win;           /* 그 창에 대해 알아낸 것 */
  }

  /* ────────────────────────────────────────────────────────────────────
   * 이미지 찾기 — 이 도구의 심장.
   *
   * 점수는 "평균 제거 정규화 상호상관(ZNCC)" 이다. 쉽게 말하면
   * 밝기가 조금 달라도(창 색이 살짝 변하거나 화면이 어두워져도) 모양이 같으면
   * 1.0 에 가까운 점수가 나오는 셈법이다. 0.87 이면 87% 비슷하다는 뜻.
   *
   * 화면 전체를 원본 해상도로 다 비교하면 너무 느리므로 세 단계로 좁힌다.
   *   1단계 거칠게 걸러내기 : 화면과 그림을 k배 줄이고, 그림에서 특징이 센 화소 24개만
   *                          견주어(차이의 합) 좋은 후보 300군데를 남긴다.
   *   2단계 거친 전체 비교   : 후보 300군데를 줄인 그림 전체로 ZNCC 계산, 한참 모자란 것은 버린다.
   *   3단계 정밀 비교       : 살아남은 자리 주변 ±(k+1) 화소를 원본 해상도로 ZNCC 계산해
   *                          가장 좋은 자리를 고른다.
   *
   * 줄인 그림은 화면 쪽·그림 쪽 **둘 다** 1-2-1 로 살짝 무디게 만들어 쓴다(Img.Soften).
   * 이게 없으면 그림이 놓인 자리가 k 의 배수가 아닐 때 줄이기 칸이 어긋나서,
   * 화소가 똑 맞는 자리인데도 1·2단계가 그 자리를 떨어뜨린다. 그 자리를 3단계가
   * 아예 못 보게 되므로 "여러 개 세기" 가 몇 개를 빠뜨리고, 심하면 단일 찾기까지
   * 못 찾았다고 답한다(--selftest 16·17번이 바로 이것을 지킨다).
   * ──────────────────────────────────────────────────────────────────── */
  internal static class Finder
  {
    private const int KEEP = 300;      /* 1단계에서 남길 후보 수 */
    private const double SLACK = 0.15; /* 2단계에서 봐 주는 점수 여유 */

    /* 여러 그림을 한 장의 화면에서 찾는다(화면은 이미 찍어 둔 Bitmap).
       화면 캡처와 가짜 그림 검사(--selftest)가 똑같이 이 함수를 쓴다. */
    public static void RunGroup(Bitmap bmp, Box box, List<FindItem> group, JObj[] slot,
                                bool local, int lox, int loy)
    {
      Img gray = null, color = null;
      Dictionary<string, Img> reduced = new Dictionary<string, Img>();

      for (int gi = 0; gi < group.Count; gi++)
      {
        FindItem it = group[gi];
        JObj r;
        try
        {
          Tpl t = TplCache.Get(it.image, it.grayscale);
          Img scr;
          if (it.grayscale)
          {
            if (gray == null) gray = Img.FromBitmap(bmp, true);
            scr = gray;
          }
          else
          {
            if (color == null) color = Img.FromBitmap(bmp, false);
            scr = color;
          }
          Img rscr = scr;
          if (t.k > 1)
          {
            string rk = t.k.ToString(CultureInfo.InvariantCulture) + (it.grayscale ? "g" : "c");
            Img cached;
            if (reduced.TryGetValue(rk, out cached)) rscr = cached;
            else
            {
              rscr = Img.Reduce(scr, t.k);
              /* 템플릿 쪽과 똑같이 무디게 (Img.Soften 설명 참고).
                 Reduce 가 원본을 그대로 돌려준 경우엔 건드리지 않는다 —
                 그 그림은 3단계에서 원본 해상도로 견줄 때 쓰는 것이다. */
              if (!object.ReferenceEquals(rscr, scr)) Img.Soften(rscr);
              reduced[rk] = rscr;
            }
          }
          r = Search(scr, rscr, t.k, box.x, box.y, t, it.threshold, it.mode, it.max, local, lox, loy);
        }
        catch (WorkerError we)
        {
          r = Miss(0, 0, 0, box, we.Message);
        }
        catch (Exception e)
        {
          r = Miss(0, 0, 0, box, "찾는 중 문제가 생겼습니다: " + e.Message);
        }

        /* key 를 맨 앞에 붙여 최종 모양으로 */
        JObj outp = new JObj();
        outp.Set("key", it.key);
        for (int i = 0; i < r.Count; i++) outp.Set(r.KeyAt(i), r.ValAt(i));
        slot[it.idx] = outp;
      }
    }

    /* 찾아보지도 못한 경우(영역이 화면 밖 등) 한 개짜리 응답 만들기 */
    public static JObj Fail(string key, string note)
    {
      JObj r = new JObj();
      r.Set("key", key);
      JObj m = Miss(0, 0, 0, Box.Make(0, 0, 0, 0), note);
      for (int i = 0; i < m.Count; i++) r.Set(m.KeyAt(i), m.ValAt(i));
      return r;
    }

    /* 못 찾았을 때의 응답 한 벌 */
    private static JObj Miss(double score, int w, int h, Box box, string note)
    {
      JObj r = new JObj();
      r.Set("found", false);
      r.Set("score", R4(score));
      r.Set("x", box.x).Set("y", box.y).Set("w", w).Set("h", h);
      r.Set("cx", box.x).Set("cy", box.y);
      r.Set("all", new List<object>());
      if (note != null) r.Set("note", note);
      return r;
    }

    private static double R4(double v)
    {
      if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
      return Math.Round(v, 4);
    }

    /* 그림 한 개 찾기. ox·oy 는 찍은 영역의 왼쪽 위 절대 좌표(응답 좌표에 더한다). */
    public static JObj Search(Img scr, Img rscr, int k, int ox, int oy, Tpl t,
                              double thr, string mode, int max, bool local, int lox, int loy)
    {
      int tw = t.img.w, th = t.img.h, ch = t.img.ch;
      int sw = scr.w, sh = scr.h;

      if (tw > sw || th > sh)
      {
        JObj big = Miss(0, tw, th, Box.Make(ox, oy, sw, sh), "이미지가 검색 영역보다 큽니다");
        if (local) big.Set("lx", lox).Set("ly", loy).Set("lcx", lox).Set("lcy", loy);
        return big;
      }

      bool wantAll = (mode == "all");
      if (max < 1) max = 1;
      if (thr < -1) thr = -1;
      if (thr > 1) thr = 1;
      bool aborted = false;

      int maxXf = sw - tw, maxYf = sh - th;
      List<int> posX = new List<int>();
      List<int> posY = new List<int>();
      HashSet<int> seen = new HashSet<int>();

      /* 축소 배율이 1(아주 작은 그림)이면 rscr 가 원본과 같은 그림이다.
         그래도 1·2단계를 그대로 쓴다 — 화면 전체를 원본 해상도로 다 훑는 것보다 훨씬 빠르다. */
      bool coarseOk = (rscr.w >= t.sm.w && rscr.h >= t.sm.h);
      if (coarseOk)
      {
        /* ── 1단계 ── */
        int cellW = Math.Max(1, t.sm.w / 2), cellH = Math.Max(1, t.sm.h / 2);
        int rMaxX = rscr.w - t.sm.w, rMaxY = rscr.h - t.sm.h;
        TopK keep = Stage1(rscr, t.sm, cellW, cellH, ref aborted);

        /* ── 2단계 : 후보를 줄인 그림 전체로 견주어 점수를 매긴다 ──

           먼저 후보를 **1단계가 매긴 순서(표본 차이 합이 작은 것부터)** 로 줄 세운다.
           여기서 2단계 점수로 줄을 세우면 안 된다. 1단계가 내놓는 자리는 칸마다
           하나뿐인 "대표 자리" 라서 진짜 봉우리에서 몇 화소 비껴 있을 수 있고,
           비껴 있는 자리의 ZNCC 는 터무니없이 낮게 나온다(실제로 0.89 인 자리가
           대표 자리에서는 0.14 로 나왔다). 그 점수로 "다듬을 후보" 를 고르면
           진짜 자리를 스스로 걸러 내 버린다 — 여러 개 찾기가 몇 개를 빠뜨리던 까닭이다.
           반면 차이 합(SAD)은 그 자리를 뽑아낸 잣대 그대로이므로 믿을 수 있다. */
        int cn = keep.Count;
        int[] sad = new int[cn];
        int[] order = new int[cn];
        for (int i = 0; i < cn; i++)
        {
          sad[i] = keep.ValAt(i);
          order[i] = i;
        }
        Array.Sort(sad, order, 0, cn);   /* 오름차순 = 앞쪽이 1단계가 보기에 가장 닮은 자리 */

        double[] candS = new double[cn];
        int[] candX = new int[cn], candY = new int[cn];
        for (int i = 0; i < cn; i++)
        {
          candX[i] = keep.XAt(order[i]);
          candY[i] = keep.YAt(order[i]);
        }

        /* ── 2단계 뒷마무리 : 앞쪽 후보는 줄인 그림에서 주변까지 훑어
           점수가 가장 높은 봉우리로 옮겨 놓고 점수를 매긴다. 뒤쪽 후보는
           대표 자리에서 그냥 점수만 매긴다(어차피 임계값에 한참 못 미친다). */
        int look = Math.Min(cn, wantAll ? Math.Max(48, 4 * max + 16) : 24);
        int hw = cellW, hh = cellH;
        int room = Math.Max(9, 400000 / Math.Max(1, t.sm.w * t.sm.h * ch));
        while ((2 * hw + 1) * (2 * hh + 1) > room && (hw > 1 || hh > 1))
        {
          if (hw >= hh) hw--;
          else hh--;
        }
        for (int i = 0; i < cn; i++)
        {
          if ((i & 15) == 0 && Guard.Stopped) { aborted = true; break; }
          int rx = candX[i], ry = candY[i];
          double bs = Zncc(rscr, rx, ry, t.sm.px, t.sm.w, t.sm.h, ch, t.sm.mean, t.sm.dev2);
          if (i < look)
          {
            int bxr = rx, byr = ry;
            for (int dy = -hh; dy <= hh; dy++)
            {
              int ny = ry + dy;
              if (ny < 0 || ny > rMaxY) continue;
              for (int dx = -hw; dx <= hw; dx++)
              {
                if (dx == 0 && dy == 0) continue;
                int nx = rx + dx;
                if (nx < 0 || nx > rMaxX) continue;
                double sc = Zncc(rscr, nx, ny, t.sm.px, t.sm.w, t.sm.h, ch, t.sm.mean, t.sm.dev2);
                if (sc > bs) { bs = sc; bxr = nx; byr = ny; }
              }
            }
            candX[i] = bxr;
            candY[i] = byr;
          }
          candS[i] = bs;
        }

        /* 이제야 점수로 줄을 세운다(앞쪽은 봉우리로 옮겨 놓은 뒤의 점수다) */
        if (cn > 1)
        {
          double[] neg = new double[cn];
          for (int i = 0; i < cn; i++) neg[i] = -candS[i];
          int[] ord2 = new int[cn];
          for (int i = 0; i < cn; i++) ord2[i] = i;
          Array.Sort(neg, ord2, 0, cn);
          int[] nx2 = new int[cn], ny2 = new int[cn];
          double[] ns2 = new double[cn];
          for (int i = 0; i < cn; i++)
          {
            nx2[i] = candX[ord2[i]];
            ny2[i] = candY[ord2[i]];
            ns2[i] = candS[ord2[i]];
          }
          candX = nx2; candY = ny2; candS = ns2;
        }

        /* ── 3단계에서 살펴볼 자리 모으기 ──
           임계값에 한참 못 미치는 후보는 버리되, 못 찾았을 때 "가장 높았던 점수" 를
           제대로 알려 주려고 적어도 8군데는 원본 해상도로 확인한다.

           한 곳이 걸리면 그 주변 후보들도 함께 높은 점수를 받는다. 그것들을 하나하나
           따로 세면 "살펴볼 자리" 를 한 군데가 다 잡아먹어서, 화면에 여러 개 있을 때
           나머지를 놓친다. 그래서 이미 훑기로 한 자리의 이웃은 건너뛴다. */
        int spots = wantAll ? Math.Max(32, 8 * max + 16) : 40;
        int budget = wantAll ? 6000 : 3000;   /* 원본 해상도로 견줄 자리의 최대 개수 */
        int taken = 0;
        int span = k + 1;
        for (int i = 0; i < cn && taken < spots && posX.Count < budget; i++)
        {
          if (candS[i] < thr - SLACK && taken >= 8) break;
          int bx0 = candX[i] * k, by0 = candY[i] * k;
          int cx0 = bx0 < 0 ? 0 : (bx0 > maxXf ? maxXf : bx0);
          int cy0 = by0 < 0 ? 0 : (by0 > maxYf ? maxYf : by0);
          if (seen.Contains(cy0 * sw + cx0)) continue;   /* 더 좋은 후보가 이미 이 근처를 훑는다 */
          for (int dy = -span; dy <= span; dy++)
          {
            int py = by0 + dy;
            if (py < 0 || py > maxYf) continue;
            for (int dx = -span; dx <= span; dx++)
            {
              int px = bx0 + dx;
              if (px < 0 || px > maxXf) continue;
              if (seen.Add(py * sw + px)) { posX.Add(px); posY.Add(py); }
            }
          }
          taken++;
        }
      }
      else
      {
        /* 그림이 화면과 거의 같은 크기라 줄일 수 없다 — 자리가 몇 군데 안 되니 다 본다 */
        for (int y = 0; y <= maxYf; y++)
          for (int x = 0; x <= maxXf; x++) { posX.Add(x); posY.Add(y); }
      }

      /* ── 3단계 : 원본 해상도 정밀 비교 ── */
      double best = -2.0;
      int bestX = 0, bestY = 0;
      List<double[]> hits = wantAll ? new List<double[]>() : null;
      for (int i = 0; i < posX.Count; i++)
      {
        if ((i & 31) == 0 && Guard.Stopped) { aborted = true; break; }
        double sc = Zncc(scr, posX[i], posY[i], t.img.px, tw, th, ch, t.mean, t.dev2);
        if (sc > best) { best = sc; bestX = posX[i]; bestY = posY[i]; }
        if (wantAll && sc >= thr)
        {
          double[] one = new double[3];
          one[0] = sc; one[1] = posX[i]; one[2] = posY[i];
          hits.Add(one);
        }
      }
      if (best < -1.5) best = 0;

      bool found = best >= thr;
      List<object> arr = new List<object>();
      if (wantAll)
      {
        List<double[]> picked = Nms(hits, tw, th, max);
        for (int i = 0; i < picked.Count; i++)
        {
          JObj o = new JObj();
          o.Set("score", R4(picked[i][0]));
          o.Set("x", (int)picked[i][1] + ox);
          o.Set("y", (int)picked[i][2] + oy);
          arr.Add(o);
        }
        if (picked.Count > 0)
        {
          bestX = (int)picked[0][1];
          bestY = (int)picked[0][2];
          best = picked[0][0];
          found = true;
        }
      }
      else if (found)
      {
        JObj o = new JObj();
        o.Set("score", R4(best)).Set("x", bestX + ox).Set("y", bestY + oy);
        arr.Add(o);
      }

      JObj r = new JObj();
      r.Set("found", found);
      r.Set("score", R4(best));
      r.Set("x", bestX + ox);
      r.Set("y", bestY + oy);
      r.Set("w", tw);
      r.Set("h", th);
      r.Set("cx", bestX + ox + tw / 2);
      r.Set("cy", bestY + oy + th / 2);
      if (local)
      {
        /* 창 지정 모드에서는 창 안쪽 좌표도 함께 준다 — postclick 에 넣을 값이다 */
        r.Set("lx", bestX + lox);
        r.Set("ly", bestY + loy);
        r.Set("lcx", bestX + lox + tw / 2);
        r.Set("lcy", bestY + loy + th / 2);
      }
      r.Set("all", arr);
      if (aborted) r.Set("note", "비상 정지 키가 눌려 찾기를 멈췄습니다");
      return r;
    }

    /* 1단계 — 줄인 화면 위를 훑으며 표본 화소만 견준다(차이 합이 작을수록 좋다).
       계산이 지금까지의 최선보다 나빠지는 순간 끊어 버리므로(early abort) 아주 빠르다.

       "차이 합이 작은 300군데" 를 화면 전체에서 그냥 고르면, 잘 맞는 한 곳 주변의
       자리들이 300개를 다 차지해서 다른 곳에 있는 같은 그림을 놓친다.
       또 줄인 그림끼리 견주는 것이라 같은 그림이라도 3화소 격자와 어긋난 만큼
       차이 합이 커진다(그래도 2단계의 ZNCC 점수는 높게 나온다).
       그래서 화면을 그림 절반 크기의 칸으로 나눠 칸마다 가장 잘 맞는 자리 하나만
       남기고, 그 중에서 좋은 300군데를 2단계로 넘긴다. 이러면 어느 한 곳이
       후보를 독차지하지 못하고, 화면 어디에 있어도 놓치지 않는다. */
    private static unsafe TopK Stage1(Img rscr, Small ts, int cellW, int cellH, ref bool aborted)
    {
      int rw = rscr.w, ch = rscr.ch;
      int maxX = rscr.w - ts.w, maxY = rscr.h - ts.h;
      int ns = ts.ns;
      int[] so = new int[ns];
      for (int i = 0; i < ns; i++) so[i] = (ts.sy[i] * rw + ts.sx[i]) * ch;

      if (cellW < 1) cellW = 1;
      if (cellH < 1) cellH = 1;
      int cols = maxX / cellW + 1, rows = maxY / cellH + 1;
      int[] cellBest = new int[cols * rows];
      int[] cellX = new int[cols * rows];
      int[] cellY = new int[cols * rows];
      for (int i = 0; i < cellBest.Length; i++) cellBest[i] = int.MaxValue;

      int srow = rw * ch;
      fixed (byte* sp0 = rscr.px)
      fixed (byte* sv = ts.sval)
      fixed (int* off = so)
      {
        for (int y = 0; y <= maxY; y++)
        {
          /* 오래 걸리는 반복문 안에서도 비상 정지 키를 살핀다 */
          if ((y & 7) == 0 && Guard.Stopped) { aborted = true; break; }
          byte* row = sp0 + (long)y * srow;
          int cellRow = (y / cellH) * cols;
          for (int x = 0; x <= maxX; x++)
          {
            int ci = cellRow + x / cellW;
            int limit = cellBest[ci];
            byte* b = row + (long)x * ch;
            int sum = 0;
            bool over = false;
            if (ch == 1)
            {
              for (int i = 0; i < ns; i++)
              {
                int d = b[off[i]] - sv[i];
                sum += d < 0 ? -d : d;
                if (sum >= limit) { over = true; break; }
              }
            }
            else
            {
              for (int i = 0; i < ns; i++)
              {
                byte* q = b + off[i];
                int j = i * 3;
                int d = q[0] - sv[j];
                sum += d < 0 ? -d : d;
                d = q[1] - sv[j + 1];
                sum += d < 0 ? -d : d;
                d = q[2] - sv[j + 2];
                sum += d < 0 ? -d : d;
                if (sum >= limit) { over = true; break; }
              }
            }
            if (!over)
            {
              cellBest[ci] = sum;
              cellX[ci] = x;
              cellY[ci] = y;
            }
          }
        }
      }

      TopK keep = new TopK(KEEP);
      for (int i = 0; i < cellBest.Length; i++)
        if (cellBest[i] != int.MaxValue) keep.Add(cellBest[i], cellX[i], cellY[i]);
      return keep;
    }

    /* 한 자리에서의 ZNCC 점수(-1 ~ 1).
         score = Σ(t−μt)(s−μs) / sqrt( Σ(t−μt)² · Σ(s−μs)² )
       분모가 0 에 가까울 때는 나눗셈을 할 수 없으므로 이렇게 갈라 준다.
         · 그림과 화면 둘 다 한 가지 색으로 밋밋하면 → 평균 차이로 점수를 낸다.
         · 한쪽만 밋밋하면(예: 글자가 있는 그림 vs 텅 빈 흰 화면) 서로 다른 그림이므로 0 점.
           (이걸 안 갈라 주면 빈 화면을 아무 그림과 닮았다고 잘못 볼 수 있다) */
    public static unsafe double Zncc(Img s, int sx, int sy, byte[] tpx, int tw, int th, int ch,
                                     double tMean, double tDev2)
    {
      int n = tw * th * ch;
      int rowBytes = tw * ch;
      int srow = s.w * ch;
      long sSum = 0, sSum2 = 0, cross = 0;
      fixed (byte* sp0 = s.px)
      fixed (byte* tp0 = tpx)
      {
        for (int y = 0; y < th; y++)
        {
          byte* sp = sp0 + (long)(sy + y) * srow + (long)sx * ch;
          byte* tp = tp0 + (long)y * rowBytes;
          for (int i = 0; i < rowBytes; i++)
          {
            int sv = sp[i], tv = tp[i];
            sSum += sv;
            sSum2 += (long)sv * sv;
            cross += (long)sv * tv;
          }
        }
      }
      double sMean = (double)sSum / n;
      double sVar = (double)sSum2 - (double)n * sMean * sMean;
      if (sVar < 0) sVar = 0;

      const double FLAT = 2.25;   /* 화소값이 평균에서 1.5 정도도 안 벗어나면 "한 가지 색" 으로 본다 */
      bool flatScreen = (sVar / n) < FLAT;
      bool flatTpl = (tDev2 / n) < FLAT;
      if (flatScreen || flatTpl)
      {
        if (flatScreen && flatTpl) return 1.0 - Math.Abs(tMean - sMean) / 255.0;
        return 0.0;
      }

      double den = Math.Sqrt(sVar * tDev2);
      double v = ((double)cross - (double)n * sMean * tMean) / den;
      if (v > 1.0) v = 1.0;
      if (v < -1.0) v = -1.0;
      return v;
    }

    /* 같은 곳을 여러 번 세지 않게 겹치는 결과를 눌러 준다(NMS).
       그림 넓이의 절반 이상 겹치면 같은 것으로 본다. */
    private static List<double[]> Nms(List<double[]> hits, int tw, int th, int max)
    {
      List<double[]> outp = new List<double[]>();
      if (hits == null || hits.Count == 0) return outp;
      hits.Sort(delegate(double[] a, double[] b) { return b[0].CompareTo(a[0]); });
      double half = 0.5 * tw * th;
      for (int i = 0; i < hits.Count && outp.Count < max; i++)
      {
        int ax = (int)hits[i][1], ay = (int)hits[i][2];
        bool covered = false;
        for (int j = 0; j < outp.Count; j++)
        {
          int bx = (int)outp[j][1], by = (int)outp[j][2];
          int ow = Math.Min(ax + tw, bx + tw) - Math.Max(ax, bx);
          int oh = Math.Min(ay + th, by + th) - Math.Max(ay, by);
          if (ow > 0 && oh > 0 && (double)ow * oh >= half) { covered = true; break; }
        }
        if (!covered) outp.Add(hits[i]);
      }
      return outp;
    }
  }

  /* 창 하나에 대해 알아낸 것 */
  internal class WinInfo
  {
    public IntPtr hwnd;
    public string title = "";
    public string cls = "";
    public int pid;
    public int x, y, w, h;      /* 창 전체(테두리까지)의 화면 좌표 */
    public int cx, cy;          /* 안쪽(클라이언트) 왼쪽 위의 화면 좌표 */
    public int cw, chh;         /* 안쪽 크기 */
    public bool minimized, visible;

    public JObj ToJson()
    {
      JObj o = new JObj();
      o.Set("hwnd", Win.Hex(hwnd)).Set("title", title).Set("cls", cls).Set("pid", pid)
       .Set("x", x).Set("y", y).Set("w", w).Set("h", h)
       .Set("cw", cw).Set("ch", chh)
       .Set("minimized", minimized).Set("visible", visible);
      return o;
    }
    public Box Client { get { return Box.Make(0, 0, Math.Max(1, cw), Math.Max(1, chh)); } }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 창 지정 모드 — 사람의 마우스를 빼앗지 않는 방식.
   *
   * 화면 모드는 "실제 마우스를 그 자리로 옮겨 누른다" 이지만,
   * 창 지정 모드는 "그 창에게 여기가 눌렸다는 쪽지(메시지)를 보낸다" 이다.
   * 그래서 선생님이 그 사이에 다른 일을 해도 서로 방해하지 않는다.
   * 다만 쪽지를 무시하는 프로그램도 있어서 늘 통하지는 않는다.
   *
   * 좌표는 이 모드에서 "창 안쪽(클라이언트) 좌표" 를 쓴다. 창을 옮겨도 그대로 쓸 수 있다.
   * ──────────────────────────────────────────────────────────────────── */
  internal static class Win
  {
    /* 창 번호는 JSON 에서 "0x00021A44" 같은 글자로 주고받는다(숫자로 하면 자릿수 사고가 난다) */
    public static string Hex(IntPtr h)
    {
      return "0x" + ((long)h).ToString("X8", CultureInfo.InvariantCulture);
    }

    public static IntPtr FromText(string s)
    {
      if (s == null) return IntPtr.Zero;
      string t = s.Trim();
      if (t.Length == 0) return IntPtr.Zero;
      try
      {
        if (t.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
          return new IntPtr(long.Parse(t.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
        return new IntPtr(long.Parse(t, CultureInfo.InvariantCulture));
      }
      catch (Exception)
      {
        throw new WorkerError("창 번호를 알아볼 수 없습니다: " + s);
      }
    }

    public static WinInfo Info(IntPtr h)
    {
      if (h == IntPtr.Zero || !W32.IsWindow(h)) return null;
      WinInfo wi = new WinInfo();
      wi.hwnd = h;

      StringBuilder tb = new StringBuilder(512);
      W32.GetWindowText(h, tb, tb.Capacity);
      wi.title = tb.ToString();

      StringBuilder cb = new StringBuilder(256);
      W32.GetClassName(h, cb, cb.Capacity);
      wi.cls = cb.ToString();

      uint pid = 0;
      W32.GetWindowThreadProcessId(h, out pid);
      wi.pid = (int)pid;

      W32.RECT wr;
      if (W32.GetWindowRect(h, out wr))
      {
        wi.x = wr.left; wi.y = wr.top;
        wi.w = wr.right - wr.left; wi.h = wr.bottom - wr.top;
      }
      W32.RECT cr;
      if (W32.GetClientRect(h, out cr))
      {
        wi.cw = cr.right - cr.left;
        wi.chh = cr.bottom - cr.top;
      }
      W32.POINT p;
      p.x = 0; p.y = 0;
      W32.ClientToScreen(h, ref p);
      wi.cx = p.x; wi.cy = p.y;

      wi.minimized = W32.IsIconic(h);
      wi.visible = W32.IsWindowVisible(h);
      return wi;
    }

    /* 바탕 화면·작업 표시줄처럼 사람이 고를 일이 없는 껍데기 창 */
    private static bool Shell(string cls)
    {
      if (cls == null) return false;
      return cls == "Progman" || cls == "Shell_TrayWnd" || cls == "WorkerW" || cls == "Button"
          || cls == "DV2ControlHost" || cls == "Shell_SecondaryTrayWnd"
          || cls == "Windows.UI.Core.CoreWindow" || cls == "MultitaskingViewFrame";
    }

    /* 지금 열려 있는 창 목록. 앞에 있는 창(Z 순서)부터, 최대 200개. */
    public static List<WinInfo> List(string filter)
    {
      string f = (filter == null) ? "" : filter.Trim().ToLowerInvariant();
      List<WinInfo> outp = new List<WinInfo>();
      W32.EnumProc cb = delegate(IntPtr h, IntPtr param)
      {
        if (outp.Count >= 200) return false;
        if (!W32.IsWindowVisible(h)) return true;
        int ex = W32.GetWindowLong(h, W32.GWL_EXSTYLE);
        if ((ex & W32.WS_EX_TOOLWINDOW) != 0) return true;
        WinInfo wi = Info(h);
        if (wi == null) return true;
        if (wi.title.Length == 0) return true;
        if (wi.w <= 0 || wi.h <= 0) return true;
        if (Shell(wi.cls)) return true;
        if (f.Length > 0)
        {
          if (wi.title.ToLowerInvariant().IndexOf(f, StringComparison.Ordinal) < 0
              && wi.cls.ToLowerInvariant().IndexOf(f, StringComparison.Ordinal) < 0) return true;
        }
        outp.Add(wi);
        return true;
      };
      try { W32.EnumWindows(cb, IntPtr.Zero); }
      catch (Exception e) { throw new WorkerError("창 목록을 읽지 못했습니다: " + e.Message); }
      return outp;
    }

    /* 창 번호로, 없으면 제목·종류로 찾는다. 여럿이면 앞에 있는 창. */
    public static WinInfo Find(string hwndText, string title, string cls)
    {
      if (hwndText != null && hwndText.Trim().Length > 0)
        return Info(FromText(hwndText));

      string t = (title == null) ? "" : title.Trim().ToLowerInvariant();
      string c = (cls == null) ? "" : cls.Trim().ToLowerInvariant();
      if (t.Length == 0 && c.Length == 0) return null;

      List<WinInfo> all = List("");
      for (int i = 0; i < all.Count; i++)
      {
        WinInfo wi = all[i];
        if (t.Length > 0 && wi.title.ToLowerInvariant().IndexOf(t, StringComparison.Ordinal) < 0) continue;
        if (c.Length > 0 && wi.cls.ToLowerInvariant().IndexOf(c, StringComparison.Ordinal) < 0) continue;
        return wi;
      }
      return null;
    }

    /* 사용자가 "항상 위에 보이기" 로 해 둔 창인가 (아래 Activate 가 쓴다) */
    private static bool AlwaysOnTop(IntPtr hwnd)
    {
      try { return (W32.GetWindowLong(hwnd, W32.GWL_EXSTYLE) & W32.WS_EX_TOPMOST) != 0; }
      catch (Exception) { return false; }
    }

    /* ── 창 되살리기·앞으로 세우기 ───────────────────────────────────
       윈도우는 작업 표시줄로 내려간(최소화된) 창을 **그리지 않는다.** 그래서 그림을
       받아 오면 빈 그림이 된다(자체 점검 15번이 이 사실을 지킨다). 그림을 보려면
       창을 잠깐 되살려야 하는데, 그러면서 사용자가 쓰고 있는 창을 빼앗으면 안 된다.

       그래서 이렇게 한다.
         · SW_SHOWNOACTIVATE(4) 로 되살린다 — SW_RESTORE(9) 는 포커스를 가져가므로 쓰지 않는다.
         · 되살린 창을 곧바로 z 순서 맨 아래(HWND_BOTTOM)로 보낸다. 자리·크기는 건드리지 않고
           앞뒤 차례만 바꾸므로, 사용자가 보던 창을 가리지 않는다.
           (예외: "항상 위에 보이기" 창은 그대로 둔다 — HWND_BOTTOM 이 그 설정을 벗겨 버린다.)
         · front:true 일 때만 SetForegroundWindow 로 앞에 세운다(화면 모드용. 기본은 하지 않는다).
       돌려주는 값: 실제로 되살렸나(restored) · 지금도 최소화 상태인가(minimized) · 앞에 세웠나(front). */
    public static JObj Activate(WinInfo wi, bool restore, bool front)
    {
      bool wasMin = false;
      try { wasMin = W32.IsIconic(wi.hwnd); }
      catch (Exception) { wasMin = wi.minimized; }

      bool restored = false;
      if (restore && wasMin)
      {
        try { W32.ShowWindow(wi.hwnd, W32.SW_SHOWNOACTIVATE); }
        catch (Exception) { }

        /* 되살아나는 데 조금 걸린다 — 최소화가 풀렸는지 최대 1.2초 지켜본다 */
        for (int i = 0; i < 24; i++)
        {
          bool still = true;
          try { still = W32.IsIconic(wi.hwnd); }
          catch (Exception) { still = false; }
          if (!still) break;
          Thread.Sleep(50);
        }
        try { restored = !W32.IsIconic(wi.hwnd); }
        catch (Exception) { restored = false; }

        /* 앞으로 세울 생각이 없다면, 되살린 창은 맨 뒤로 보내 눈에 띄지 않게 한다.

           단, 사용자가 "항상 위에 보이기" 로 해 둔 창은 건드리지 않는다.
           HWND_BOTTOM 은 맨 뒤로 보내면서 그 창의 "항상 위" 설정을 **벗겨 버린다**
           (윈도우가 그렇게 정해 놓았다). 그림 한 장 보려고 사용자가 켜 둔 설정을
           말없이 끄면 안 되므로, 이런 창은 z 순서를 그대로 둔다. */
        if (restored && !front && !AlwaysOnTop(wi.hwnd))
        {
          try
          {
            W32.SetWindowPos(wi.hwnd, W32.HWND_BOTTOM, 0, 0, 0, 0,
                             W32.SWP_NOACTIVATE | W32.SWP_NOMOVE | W32.SWP_NOSIZE);
          }
          catch (Exception) { }
        }
      }

      bool inFront = false;
      if (front)
      {
        /* 먼저 z 순서를 맨 위로 올리고(이건 거의 늘 된다), 그 다음 포커스를 청한다.
           윈도우는 "지금 앞에 있는 프로그램" 이 아닌 쪽의 포커스 요청을 거절할 수 있다.
           그래서 포커스를 정말로 가져왔는지 확인해서 front 로 솔직하게 알려 준다. */
        try { W32.SetWindowPos(wi.hwnd, W32.HWND_TOP, 0, 0, 0, 0, W32.SWP_NOMOVE | W32.SWP_NOSIZE); }
        catch (Exception) { }
        try { W32.BringWindowToTop(wi.hwnd); }
        catch (Exception) { }
        try { W32.SetForegroundWindow(wi.hwnd); }
        catch (Exception) { }
        Thread.Sleep(60);
        try { inFront = (W32.GetForegroundWindow() == wi.hwnd); }
        catch (Exception) { inFront = false; }
      }

      try { wi.minimized = W32.IsIconic(wi.hwnd); }
      catch (Exception) { }

      JObj o = new JObj();
      o.Set("restored", restored);
      o.Set("minimized", wi.minimized);
      o.Set("front", inFront);
      return o;
    }

    /* ── 창 그림 얻기 ───────────────────────────────────────────────
       PrintWindow 는 가려져 있어도 창이 스스로 다시 그려 주는 방식이라 창 지정 모드의 핵심이다.
       요즘 방식(RENDERFULLCONTENT)이 안 통하는 창도 있어서 세 가지를 차례로 시도한다. */
    public static Bitmap Grab(WinInfo wi, out bool blank)
    {
      int w = Math.Max(1, wi.cw), h = Math.Max(1, wi.chh);
      Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppRgb);
      bool ok = false;
      try
      {
        ok = Print(bmp, wi.hwnd, W32.PW_CLIENTONLY | W32.PW_RENDERFULLCONTENT) && !Flat(bmp);
        if (!ok) ok = Print(bmp, wi.hwnd, W32.PW_CLIENTONLY) && !Flat(bmp);
        if (!ok) ok = PrintWhole(bmp, wi) && !Flat(bmp);
        if (!ok) ok = Blt(bmp, wi.hwnd, w, h) && !Flat(bmp);
      }
      catch (Exception)
      {
        ok = false;
      }
      blank = !ok;
      return bmp;
    }

    private static bool Print(Bitmap bmp, IntPtr hwnd, uint flags)
    {
      using (Graphics g = Graphics.FromImage(bmp))
      {
        g.Clear(Color.Black);
        IntPtr dc = g.GetHdc();
        try { return W32.PrintWindow(hwnd, dc, flags); }
        finally { g.ReleaseHdc(dc); }
      }
    }

    /* 창 전체를 찍고 안쪽만 잘라 낸다(PW_CLIENTONLY 를 무시하는 창을 위해) */
    private static bool PrintWhole(Bitmap dst, WinInfo wi)
    {
      int ww = Math.Max(1, wi.w), wh = Math.Max(1, wi.h);
      using (Bitmap whole = new Bitmap(ww, wh, PixelFormat.Format32bppRgb))
      {
        if (!Print(whole, wi.hwnd, W32.PW_RENDERFULLCONTENT)) return false;
        int offX = wi.cx - wi.x, offY = wi.cy - wi.y;
        if (offX < 0) offX = 0;
        if (offY < 0) offY = 0;
        using (Graphics g = Graphics.FromImage(dst))
        {
          g.InterpolationMode = InterpolationMode.NearestNeighbor;
          g.PixelOffsetMode = PixelOffsetMode.Half;
          g.DrawImage(whole, new Rectangle(0, 0, dst.Width, dst.Height),
                      offX, offY, dst.Width, dst.Height, GraphicsUnit.Pixel);
        }
        return true;
      }
    }

    /* 마지막 방법 — 창 DC 에서 그대로 긁어 온다(가려져 있으면 가린 창이 찍힐 수 있다) */
    private static bool Blt(Bitmap bmp, IntPtr hwnd, int w, int h)
    {
      IntPtr src = W32.GetDC(hwnd);
      if (src == IntPtr.Zero) return false;
      try
      {
        using (Graphics g = Graphics.FromImage(bmp))
        {
          IntPtr dc = g.GetHdc();
          try { return W32.BitBlt(dc, 0, 0, w, h, src, 0, 0, W32.SRCCOPY); }
          finally { g.ReleaseHdc(dc); }
        }
      }
      finally { W32.ReleaseDC(hwnd, src); }
    }

    /* 그림이 온통 한 색인가(창 지정 모드가 안 통하는 프로그램은 이렇게 나온다) */
    private static unsafe bool Flat(Bitmap bmp)
    {
      BitmapData bd = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height),
                                   ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try
      {
        int stepX = Math.Max(1, bmp.Width / 64), stepY = Math.Max(1, bmp.Height / 64);
        int first = -1;
        for (int y = 0; y < bmp.Height; y += stepY)
        {
          byte* row = (byte*)bd.Scan0 + (long)y * bd.Stride;
          for (int x = 0; x < bmp.Width; x += stepX)
          {
            int v = (row[x * 4] << 16) | (row[x * 4 + 1] << 8) | row[x * 4 + 2];
            if (first < 0) first = v;
            else if (v != first) return false;
          }
        }
      }
      finally { bmp.UnlockBits(bd); }
      return true;
    }

    /* ── 창에 쪽지 보내기 ───────────────────────────────────────────── */

    private static IntPtr Pack(int x, int y)
    {
      return new IntPtr(((y & 0xFFFF) << 16) | (x & 0xFFFF));
    }

    /* 눌렀다 떼기. 좌표는 창 안쪽 기준. */
    public static JObj Click(WinInfo wi, int x, int y, string button, int clicks, bool resolveChild)
    {
      if (clicks < 1) clicks = 1;
      if (clicks > 3) clicks = 3;
      string b = (button == null ? "left" : button.Trim().ToLowerInvariant());
      uint dn, up, dbl;
      int mk;
      if (b == "right" || b == "r")
      {
        dn = W32.WM_RBUTTONDOWN; up = W32.WM_RBUTTONUP; dbl = W32.WM_RBUTTONDBLCLK; mk = W32.MK_RBUTTON;
      }
      else if (b == "middle" || b == "m")
      {
        dn = W32.WM_MBUTTONDOWN; up = W32.WM_MBUTTONUP; dbl = W32.WM_MBUTTONDBLCLK; mk = W32.MK_MBUTTON;
      }
      else if (b == "" || b == "left" || b == "l")
      {
        dn = W32.WM_LBUTTONDOWN; up = W32.WM_LBUTTONUP; dbl = W32.WM_LBUTTONDBLCLK; mk = W32.MK_LBUTTON;
      }
      else throw new WorkerError("모르는 마우스 단추입니다: " + button);

      IntPtr cur = wi.hwnd;
      int px = x, py = y;
      if (resolveChild)
      {
        /* 그 자리에 놓인 가장 깊은 자식 창(단추·글자칸)까지 두 단계 파고든다 */
        for (int depth = 0; depth < 2; depth++)
        {
          W32.POINT pt;
          pt.x = px; pt.y = py;
          IntPtr child = W32.ChildWindowFromPointEx(cur, pt, W32.CWP_SKIPINVISIBLE);
          if (child == IntPtr.Zero || child == cur) break;
          W32.POINT s;
          s.x = px; s.y = py;
          W32.ClientToScreen(cur, ref s);
          W32.ScreenToClient(child, ref s);
          cur = child;
          px = s.x; py = s.y;
        }
      }

      IntPtr lp = Pack(px, py);
      W32.PostMessage(cur, W32.WM_MOUSEMOVE, IntPtr.Zero, lp);
      Thread.Sleep(12);
      for (int i = 0; i < clicks; i++)
      {
        W32.PostMessage(cur, (i > 0) ? dbl : dn, new IntPtr(mk), lp);
        Thread.Sleep(20);
        W32.PostMessage(cur, up, IntPtr.Zero, lp);
        if (i + 1 < clicks) Thread.Sleep(40);
      }

      JObj o = new JObj();
      o.Set("hwnd", Hex(wi.hwnd)).Set("child", Hex(cur)).Set("x", px).Set("y", py);
      return o;
    }

    /* 휠 굴리기. 휠 쪽지는 좌표를 "화면 기준" 으로 받는다. */
    public static void Wheel(WinInfo wi, int x, int y, int amount, bool horizontal)
    {
      Wheel(wi, x, y, amount, horizontal, false);
    }

    /** ctrl 을 켜면 "Ctrl 을 누른 채 굴리기" 가 되어 대개 배율이 바뀐다 */
    public static void Wheel(WinInfo wi, int x, int y, int amount, bool horizontal, bool ctrl)
    {
      if (amount == 0) return;

      /* 굴릴 쪽지는 **그 자리에 있는 자식 창**에게 보내야 한다.
         크롬·엣지의 문서 바닥은 자식 창(Chrome_RenderWidgetHostHWND)이라, 맨 위 창에
         보내면 아무도 받지 않고 화면이 그대로다. 누르기(Click)가 하는 것과 같은 방식으로
         두 단계까지 파고들어 진짜 받을 창을 찾는다. */
      IntPtr cur = wi.hwnd;
      int px = x, py = y;
      for (int depth = 0; depth < 2; depth++)
      {
        W32.POINT pt;
        pt.x = px; pt.y = py;
        IntPtr child = W32.ChildWindowFromPointEx(cur, pt, W32.CWP_SKIPINVISIBLE);
        if (child == IntPtr.Zero || child == cur) break;
        W32.POINT c;
        c.x = px; c.y = py;
        W32.ClientToScreen(cur, ref c);
        W32.ScreenToClient(child, ref c);
        cur = child;
        px = c.x; py = c.y;
      }

      /* 휠 쪽지의 좌표는 화면 기준이다(누르기와 달리 클라이언트 기준이 아니다) */
      W32.POINT s;
      s.x = px; s.y = py;
      W32.ClientToScreen(cur, ref s);
      IntPtr lp = Pack(s.x, s.y);

      int notches = Math.Min(40, Math.Abs(amount));
      int delta = amount > 0 ? 120 : -120;
      uint msg = horizontal ? W32.WM_MOUSEHWHEEL : W32.WM_MOUSEWHEEL;
      int keys = ctrl ? W32.MK_CONTROL : 0;
      for (int i = 0; i < notches; i++)
      {
        W32.PostMessage(cur, msg, new IntPtr((delta << 16) | keys), lp);
        Thread.Sleep(ctrl ? 40 : 12);   /* 배율 바꾸기는 다시 그리는 데 시간이 걸린다 */
      }
    }

    /* 글자를 받을 창 — 창 안에서 지금 글자를 받고 있는(포커스를 가진) 자식 창.
       맨 위 창에 그냥 보내면 글자칸(TextBox)에 들어가지 않는다. 창을 앞으로 끌어내지
       않고도 알 수 있는 GetGUIThreadInfo 로 그 자리를 찾아 거기로 보낸다.
       (가려진 창에도 글자를 넣을 수 있어야 창 지정 모드의 뜻이 산다) */
    private static IntPtr TypeTarget(WinInfo wi)
    {
      try
      {
        uint pid = 0;
        uint tid = W32.GetWindowThreadProcessId(wi.hwnd, out pid);
        if (tid == 0) return wi.hwnd;
        W32.GUITHREADINFO gti = new W32.GUITHREADINFO();
        gti.cbSize = Marshal.SizeOf(typeof(W32.GUITHREADINFO));
        if (!W32.GetGUIThreadInfo(tid, ref gti)) return wi.hwnd;
        IntPtr f = gti.hwndFocus;
        if (f == IntPtr.Zero) return wi.hwnd;
        if (f == wi.hwnd || W32.IsChild(wi.hwnd, f)) return f;
      }
      catch (Exception) { }
      return wi.hwnd;
    }

    /* 보낼 수 있는 키인지 먼저 살펴본다(여러 개를 받았을 때 반쯤 보내 놓고 실패하지 않게).
       쪽지로는 조합키를 만들 수 없다 — 누름 상태를 흉내 낼 수 없기 때문이다. */
    public static ushort CheckKey(string combo)
    {
      if (combo == null || combo.Trim().Length == 0) throw new WorkerError("누를 키(combo)가 비어 있습니다.");
      if (combo.IndexOf('+') >= 0)
        throw new WorkerError("창 지정 모드에서는 조합키(" + combo.Trim() + ")를 보낼 수 없습니다. 화면 모드로 바꿔 주세요.");
      return Keyb.VkOf(combo);
    }

    /* 키 하나 누르기. 조합키(ctrl+s)는 쪽지로 보낼 수 없다. */
    public static void Keys(WinInfo wi, string combo, int repeat)
    {
      ushort vk = CheckKey(combo);
      uint scan = W32.MapVirtualKey(vk, 0);
      IntPtr down = new IntPtr(1 | (int)(scan << 16));
      IntPtr up = new IntPtr(unchecked((int)(0xC0000001u | (scan << 16))));
      if (repeat < 1) repeat = 1;
      if (repeat > 500) repeat = 500;
      IntPtr target = TypeTarget(wi);
      for (int i = 0; i < repeat; i++)
      {
        W32.PostMessage(target, W32.WM_KEYDOWN, new IntPtr(vk), down);
        Thread.Sleep(15);
        W32.PostMessage(target, W32.WM_KEYUP, new IntPtr(vk), up);
        if (i + 1 < repeat) Thread.Sleep(30);
      }
    }

    /* 글자 넣기 — 한 글자씩 쪽지로. 줄바꿈은 엔터 키로. */
    public static void Text(WinInfo wi, string text)
    {
      if (string.IsNullOrEmpty(text)) return;
      IntPtr target = TypeTarget(wi);
      for (int i = 0; i < text.Length; i++)
      {
        if (Guard.Stopped) break;
        char c = text[i];
        if (c == '\r') continue;
        if (c == '\n')
        {
          W32.PostMessage(target, W32.WM_KEYDOWN, new IntPtr(0x0D), new IntPtr(1));
          Thread.Sleep(10);
          W32.PostMessage(target, W32.WM_KEYUP, new IntPtr(0x0D), new IntPtr(unchecked((int)0xC0000001u)));
          Thread.Sleep(10);
          continue;
        }
        /* 서로게이트 쌍(이모지 등)은 두 번에 나눠 그대로 보낸다 */
        W32.PostMessage(target, W32.WM_CHAR, new IntPtr((int)c), new IntPtr(1));
        Thread.Sleep(6);
      }
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 마우스 — SendInput 만 쓴다(옛 mouse_event 는 쓰지 않는다).
   *
   * 절대 좌표는 0~65535 로 바꿔서 넣어야 하고, 모니터가 여러 대일 때는
   * "가상 화면" 기준으로 계산하고 VIRTUALDESK 깃발을 함께 줘야 맞는 자리로 간다.
   *   nx = (x − 가상화면.x) × 65535 ÷ (가상화면.너비 − 1)
   * ──────────────────────────────────────────────────────────────────── */
  internal static class Mouse
  {
    private static Random rnd = new Random();

    private static void Send(W32.INPUT[] arr)
    {
      uint sent = W32.SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(W32.INPUT)));
      if (sent == 0)
        throw new WorkerError("윈도우가 마우스 입력을 받아 주지 않았습니다. 관리자 권한으로 뜬 창 위에서는 동작하지 않을 수 있습니다.");
    }

    /* 곧바로 그 자리로 옮기기 */
    public static void Jump(int x, int y)
    {
      Box v = Sc.All();
      int vw = Math.Max(2, v.w), vh = Math.Max(2, v.h);
      long nx = (long)Math.Round((double)(x - v.x) * 65535.0 / (vw - 1));
      long ny = (long)Math.Round((double)(y - v.y) * 65535.0 / (vh - 1));
      if (nx < 0) nx = 0;
      if (ny < 0) ny = 0;
      if (nx > 65535) nx = 65535;
      if (ny > 65535) ny = 65535;

      W32.INPUT[] one = new W32.INPUT[1];
      one[0].type = W32.INPUT_MOUSE;
      one[0].body.mi.dx = (int)nx;
      one[0].body.mi.dy = (int)ny;
      one[0].body.mi.dwFlags = W32.MOUSEEVENTF_MOVE | W32.MOUSEEVENTF_ABSOLUTE | W32.MOUSEEVENTF_VIRTUALDESK;
      Send(one);
    }

    /* 사람이 옮긴 것처럼 몇 단계로 나눠 옮기기
       (마우스가 지나가야 반응하는 단추가 많아서 순간이동만 하면 안 되는 곳이 있다) */
    public static void MoveTo(int x, int y, int moveMs)
    {
      if (moveMs <= 0) { Jump(x, y); return; }
      if (moveMs > 5000) moveMs = 5000;
      W32.POINT from = Guard.Cursor();
      int steps = moveMs / 12;
      if (steps < 2) steps = 2;
      if (steps > 60) steps = 60;
      int nap = Math.Max(1, moveMs / steps);
      for (int i = 1; i <= steps; i++)
      {
        double u = (double)i / steps;
        double e = u * u * (3.0 - 2.0 * u);      /* 처음과 끝은 느리게 */
        Jump((int)Math.Round(from.x + (x - from.x) * e), (int)Math.Round(from.y + (y - from.y) * e));
        Thread.Sleep(nap);
      }
      Jump(x, y);
    }

    private static void Flags(string button, out uint down, out uint up)
    {
      string b = (button == null ? "left" : button.Trim().ToLowerInvariant());
      if (b == "" || b == "left" || b == "l") { down = W32.MOUSEEVENTF_LEFTDOWN; up = W32.MOUSEEVENTF_LEFTUP; return; }
      if (b == "right" || b == "r") { down = W32.MOUSEEVENTF_RIGHTDOWN; up = W32.MOUSEEVENTF_RIGHTUP; return; }
      if (b == "middle" || b == "m") { down = W32.MOUSEEVENTF_MIDDLEDOWN; up = W32.MOUSEEVENTF_MIDDLEUP; return; }
      throw new WorkerError("모르는 마우스 단추입니다: " + button);
    }

    private static void Btn(uint flag)
    {
      W32.INPUT[] one = new W32.INPUT[1];
      one[0].type = W32.INPUT_MOUSE;
      one[0].body.mi.dwFlags = flag;
      Send(one);
    }

    public static void Click(int x, int y, string button, int clicks, int moveMs, bool restore, List<string> mods)
    {
      if (clicks < 1) clicks = 1;
      if (clicks > 3) clicks = 3;
      uint down, up;
      Flags(button, out down, out up);
      W32.POINT before = Guard.Cursor();

      Keyb.HoldDown(mods);
      try
      {
        MoveTo(x, y, moveMs);
        Thread.Sleep(rnd.Next(20, 41));
        for (int i = 0; i < clicks; i++)
        {
          if (i > 0) Thread.Sleep(90);          /* 더블클릭 간격 */
          Btn(down);
          Thread.Sleep(rnd.Next(20, 41));       /* 누르고 떼는 사이 */
          Btn(up);
        }
      }
      finally { Keyb.LetGo(mods); }

      if (restore) MoveTo(before.x, before.y, 0);
    }

    public static void Drag(int x1, int y1, int x2, int y2, int moveMs, string button)
    {
      uint down, up;
      Flags(button, out down, out up);
      if (moveMs < 0) moveMs = 0;
      MoveTo(x1, y1, Math.Min(250, moveMs));
      Thread.Sleep(60);
      Btn(down);
      Thread.Sleep(80);
      MoveTo(x2, y2, moveMs);
      Thread.Sleep(80);
      Btn(up);
      Thread.Sleep(40);
    }

    public static void Wheel(bool hasPos, int x, int y, int amount, bool horizontal, int moveMs)
    {
      if (hasPos) MoveTo(x, y, moveMs);
      if (amount == 0) return;
      int notches = Math.Abs(amount);
      if (notches > 40) notches = 40;
      int sign = amount > 0 ? 1 : -1;
      uint flag = horizontal ? W32.MOUSEEVENTF_HWHEEL : W32.MOUSEEVENTF_WHEEL;
      for (int i = 0; i < notches; i++)
      {
        W32.INPUT[] one = new W32.INPUT[1];
        one[0].type = W32.INPUT_MOUSE;
        one[0].body.mi.mouseData = unchecked((uint)(sign * 120));
        one[0].body.mi.dwFlags = flag;
        Send(one);
        if (i + 1 < notches) Thread.Sleep(12);
      }
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 키보드 — 이름("ctrl+s", "enter", "f5")을 실제 키로 바꿔 넣는다.
   * 글자 입력은 KEYEVENTF_UNICODE 로 문자 그대로 넣으므로 한글도 그대로 들어간다.
   * ──────────────────────────────────────────────────────────────────── */
  internal static class Keyb
  {
    private static Dictionary<string, ushort> vks = new Dictionary<string, ushort>();
    private static Dictionary<int, bool> extended = new Dictionary<int, bool>();

    static Keyb()
    {
      /* 조합키 */
      Put("ctrl", 0x11); Put("control", 0x11); Put("컨트롤", 0x11);
      Put("shift", 0x10); Put("시프트", 0x10);
      Put("alt", 0x12); Put("알트", 0x12);
      Put("win", 0x5B); Put("lwin", 0x5B); Put("rwin", 0x5C); Put("윈도우", 0x5B);
      /* 특수키 */
      Put("enter", 0x0D); Put("return", 0x0D); Put("엔터", 0x0D);
      Put("esc", 0x1B); Put("escape", 0x1B);
      Put("space", 0x20); Put("spacebar", 0x20); Put("스페이스", 0x20);
      Put("tab", 0x09); Put("탭", 0x09);
      Put("backspace", 0x08); Put("back", 0x08); Put("bs", 0x08);
      Put("delete", 0x2E); Put("del", 0x2E);
      Put("insert", 0x2D); Put("ins", 0x2D);
      Put("home", 0x24); Put("end", 0x23);
      Put("pgup", 0x21); Put("pageup", 0x21);
      Put("pgdn", 0x22); Put("pagedown", 0x22);
      Put("up", 0x26); Put("down", 0x28); Put("left", 0x25); Put("right", 0x27);
      Put("capslock", 0x14); Put("numlock", 0x90); Put("scrolllock", 0x91);
      Put("printscreen", 0x2C); Put("prtsc", 0x2C);
      Put("pause", 0x13); Put("apps", 0x5D); Put("menu", 0x5D);
      Put("hangul", 0x15); Put("한영", 0x15); Put("hanja", 0x19); Put("한자", 0x19);
      /* 숫자판 */
      Put("multiply", 0x6A); Put("add", 0x6B); Put("subtract", 0x6D);
      Put("decimal", 0x6E); Put("divide", 0x6F);
      /* 기호 */
      Put("semicolon", 0xBA); Put(";", 0xBA);
      Put("plus", 0xBB); Put("equal", 0xBB); Put("=", 0xBB);
      Put("comma", 0xBC); Put(",", 0xBC);
      Put("minus", 0xBD); Put("-", 0xBD);
      Put("period", 0xBE); Put(".", 0xBE);
      Put("slash", 0xBF); Put("/", 0xBF);
      Put("grave", 0xC0); Put("backtick", 0xC0); Put("`", 0xC0);
      Put("lbracket", 0xDB); Put("[", 0xDB);
      Put("backslash", 0xDC); Put("\\", 0xDC);
      Put("rbracket", 0xDD); Put("]", 0xDD);
      Put("quote", 0xDE); Put("'", 0xDE);

      for (int i = 0; i < 26; i++) Put(((char)('a' + i)).ToString(), (ushort)(0x41 + i));
      for (int i = 0; i <= 9; i++) Put(i.ToString(CultureInfo.InvariantCulture), (ushort)(0x30 + i));
      for (int i = 1; i <= 24; i++) Put("f" + i.ToString(CultureInfo.InvariantCulture), (ushort)(0x70 + i - 1));
      for (int i = 0; i <= 9; i++)
      {
        Put("numpad" + i.ToString(CultureInfo.InvariantCulture), (ushort)(0x60 + i));
        Put("num" + i.ToString(CultureInfo.InvariantCulture), (ushort)(0x60 + i));
      }

      /* 확장 깃발이 필요한 키들(화살표·홈·엔드 같은 것) */
      int[] ex = new int[] { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
                             0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5 };
      for (int i = 0; i < ex.Length; i++) extended[ex[i]] = true;
    }

    private static void Put(string name, ushort vk)
    {
      vks[name] = vk;
    }

    public static ushort VkOf(string name)
    {
      if (name == null) throw new WorkerError("키 이름이 비어 있습니다.");
      string n = name.Trim().ToLowerInvariant();
      if (n.Length == 0) throw new WorkerError("키 이름이 비어 있습니다.");
      ushort vk;
      if (vks.TryGetValue(n, out vk)) return vk;
      throw new WorkerError("모르는 키 이름입니다: " + name);
    }

    private static void Send(W32.INPUT[] arr)
    {
      uint sent = W32.SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(W32.INPUT)));
      if (sent == 0)
        throw new WorkerError("윈도우가 키 입력을 받아 주지 않았습니다. 관리자 권한으로 뜬 창 위에서는 동작하지 않을 수 있습니다.");
    }

    private static W32.INPUT KeyEvent(ushort vk, bool up)
    {
      W32.INPUT k = new W32.INPUT();
      k.type = W32.INPUT_KEYBOARD;
      k.body.ki.wVk = vk;
      k.body.ki.wScan = (ushort)W32.MapVirtualKey(vk, 0);
      uint f = 0;
      if (up) f |= W32.KEYEVENTF_KEYUP;
      if (extended.ContainsKey(vk)) f |= W32.KEYEVENTF_EXTENDEDKEY;
      k.body.ki.dwFlags = f;
      return k;
    }

    public static void Press(ushort vk, bool up)
    {
      W32.INPUT[] one = new W32.INPUT[1];
      one[0] = KeyEvent(vk, up);
      Send(one);
    }

    public static void Tap(ushort vk)
    {
      Press(vk, false);
      Thread.Sleep(12);
      Press(vk, true);
    }

    /* "ctrl+shift+s" 같은 한 덩어리를 눌렀다 떼기.
       '+' 는 구분 기호지만, 앞이 비어 있으면 더하기 키 그 자체로 본다("ctrl++"). */
    public static void Combo(string combo)
    {
      List<string> names = Split(combo);
      if (names.Count == 0) throw new WorkerError("누를 키가 비어 있습니다.");
      List<ushort> list = new List<ushort>();
      for (int i = 0; i < names.Count; i++) list.Add(VkOf(names[i]));
      for (int i = 0; i < list.Count; i++)
      {
        Press(list[i], false);
        Thread.Sleep(12);
      }
      Thread.Sleep(20);
      for (int i = list.Count - 1; i >= 0; i--)
      {
        Press(list[i], true);
        Thread.Sleep(8);
      }
    }

    private static List<string> Split(string combo)
    {
      List<string> outp = new List<string>();
      if (combo == null) return outp;
      StringBuilder cur = new StringBuilder();
      for (int i = 0; i < combo.Length; i++)
      {
        char c = combo[i];
        if (c == '+')
        {
          if (cur.Length == 0) { outp.Add("plus"); continue; }
          outp.Add(cur.ToString().Trim());
          cur.Length = 0;
          continue;
        }
        cur.Append(c);
      }
      if (cur.Length > 0) outp.Add(cur.ToString().Trim());
      for (int i = outp.Count - 1; i >= 0; i--) if (outp[i].Length == 0) outp.RemoveAt(i);
      return outp;
    }

    /* click 의 modifiers 처럼 누른 채로 두었다가 나중에 떼는 경우 */
    public static void HoldDown(List<string> mods)
    {
      if (mods == null) return;
      for (int i = 0; i < mods.Count; i++)
      {
        Press(VkOf(mods[i]), false);
        Thread.Sleep(12);
      }
    }
    public static void LetGo(List<string> mods)
    {
      if (mods == null) return;
      for (int i = mods.Count - 1; i >= 0; i--)
      {
        try { Press(VkOf(mods[i]), true); }
        catch (Exception) { }
        Thread.Sleep(8);
      }
    }

    /* 글자 그대로 넣기(한글·이모지 포함). \n 은 엔터로 바꿔 넣는다. */
    public static void Type(string text, int cps)
    {
      if (string.IsNullOrEmpty(text)) return;
      if (cps <= 0) cps = 40;
      if (cps > 500) cps = 500;
      int gap = (int)Math.Round(1000.0 / cps);
      if (gap > 300) gap = 300;

      int i = 0;
      while (i < text.Length)
      {
        if (Guard.Stopped) break;
        char c = text[i];
        if (c == '\r') { i++; continue; }
        if (c == '\n') { Tap(0x0D); i++; Nap(gap); continue; }
        if (c == '\t') { Tap(0x09); i++; Nap(gap); continue; }
        if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
        {
          Unicode(c, text[i + 1]);
          i += 2;
        }
        else
        {
          Unicode(c, '\0');
          i++;
        }
        Nap(gap);
      }
    }

    private static void Nap(int ms)
    {
      if (ms > 0) Thread.Sleep(ms);
    }

    /* 서로게이트 쌍(이모지 같은 것)은 두 조각을 한 번에 보내야 한 글자로 들어간다 */
    private static void Unicode(char a, char b)
    {
      bool pair = (b != '\0');
      W32.INPUT[] arr = new W32.INPUT[pair ? 4 : 2];
      int n = 0;
      arr[n++] = UniEvent(a, false);
      arr[n++] = UniEvent(a, true);
      if (pair)
      {
        arr[n++] = UniEvent(b, false);
        arr[n++] = UniEvent(b, true);
      }
      Send(arr);
    }

    private static W32.INPUT UniEvent(char c, bool up)
    {
      W32.INPUT k = new W32.INPUT();
      k.type = W32.INPUT_KEYBOARD;
      k.body.ki.wVk = 0;
      k.body.ki.wScan = (ushort)c;
      k.body.ki.dwFlags = W32.KEYEVENTF_UNICODE | (up ? W32.KEYEVENTF_KEYUP : 0);
      return k;
    }
  }

  /* 영역 고르기 결과 */
  internal class PickResult
  {
    public bool cancelled = true;
    public bool isRegion = false;
    public Box region;
    public int px, py;
  }

  /* ────────────────────────────────────────────────────────────────────
   * 화면 위에 띄우는 창 두 가지
   *   PickForm — 모니터 전체를 덮는 반투명 막. 드래그로 영역을 고른다.
   *   HiForm   — 찾은 자리에 빨간 테두리만 잠깐 보여 준다(클릭이 그대로 통과한다).
   * 창은 반드시 STA 로 지정한 전용 실에서 띄운다.
   * ──────────────────────────────────────────────────────────────────── */
  internal static class Overlay
  {
    /* 영역(또는 점) 고르기. 사용자가 고르거나 취소할 때까지 기다린다. */
    public static PickResult Pick(string mode, int delayMs, string prompt)
    {
      if (delayMs > 0) Thread.Sleep(Math.Min(60000, delayMs));

      PickResult res = new PickResult();
      Exception fail = null;
      Thread th = new Thread(delegate()
      {
        try
        {
          using (PickForm f = new PickForm(mode, prompt))
          {
            Application.Run(f);
            res.cancelled = f.Cancelled;
            res.isRegion = f.IsRegion;
            res.region = f.Chosen;
            res.px = f.PointX;
            res.py = f.PointY;
          }
        }
        catch (Exception e) { fail = e; }
      });
      th.SetApartmentState(ApartmentState.STA);
      th.IsBackground = true;
      th.Name = "영역 고르기";
      th.Start();
      th.Join();
      if (fail != null) throw new WorkerError("영역 고르기 창을 띄우지 못했습니다: " + fail.Message);
      return res;
    }

    /* 빨간 테두리 보여 주기. 기다리지 않고 곧바로 돌아온다. */
    public static void Highlight(Box r, int ms, string label)
    {
      if (r.Empty) return;
      int life = ms > 0 ? ms : 1200;
      Box box = r;
      string text = label;
      Thread th = new Thread(delegate()
      {
        try
        {
          using (HiForm f = new HiForm(box, life, text)) Application.Run(f);
        }
        catch (Exception) { /* 테두리는 못 보여 줘도 일은 계속되어야 한다 */ }
      });
      th.SetApartmentState(ApartmentState.STA);
      th.IsBackground = true;
      th.Name = "테두리 표시";
      th.Start();
    }
  }

  /* 모니터 전체를 덮는 반투명 막 */
  internal class PickForm : Form
  {
    private string mode;
    private string prompt;
    private bool dragging = false;
    private Point p0, p1;
    private double ui;
    private Font fBig, fSmall;
    private System.Windows.Forms.Timer bail;
    private System.Windows.Forms.Timer escWatch;   /* ESC 를 놓치지 않게 지켜보는 마지막 안전망 */

    public bool Cancelled = true;
    public bool IsRegion = false;
    public Box Chosen;
    public int PointX = 0;
    public int PointY = 0;

    public PickForm(string mode, string prompt)
    {
      this.mode = (mode == "point") ? "point" : "region";
      this.prompt = prompt == null ? "" : prompt;
      this.ui = Sc.UiScale();

      FormBorderStyle = FormBorderStyle.None;
      StartPosition = FormStartPosition.Manual;
      ShowInTaskbar = false;
      TopMost = true;
      AutoScaleMode = AutoScaleMode.None;
      DoubleBuffered = true;
      BackColor = Color.Black;
      Opacity = (this.mode == "point") ? 0.30 : 0.40;
      Cursor = Cursors.Cross;
      KeyPreview = true;
      Text = "이미지 매크로 — 영역 고르기";

      Box v = Sc.All();
      Bounds = new Rectangle(v.x, v.y, v.w, v.h);

      fBig = MakeFont(13.5f, FontStyle.Bold);
      fSmall = MakeFont(10.5f, FontStyle.Regular);

      /* 사용자가 잊고 자리를 비워도 창이 영원히 남지 않게 2분 뒤 스스로 취소한다 */
      bail = new System.Windows.Forms.Timer();
      bail.Interval = 120000;
      bail.Tick += new EventHandler(OnBail);
      bail.Start();

      /* ── ESC 취소의 마지막 안전망 ──────────────────────────────────
         키보드 포커스를 못 받는 경우(다른 프로그램이 포커스를 붙잡고 있을 때)에도
         ESC 는 들어야 한다. 그래서 50ms 마다 ESC 키가 눌렸는지 직접 물어본다.
         시작하기 전에 한 번 읽어서 "예전에 눌렸던 기록" 을 비운다 —
         안 그러면 창이 뜨자마자 저절로 취소될 수 있다. */
      try { W32.GetAsyncKeyState(W32.VK_ESCAPE); }
      catch (Exception) { }
      escWatch = new System.Windows.Forms.Timer();
      escWatch.Interval = 50;
      escWatch.Tick += new EventHandler(OnEscWatch);
      escWatch.Start();
    }

    private void OnEscWatch(object sender, EventArgs e)
    {
      int s = 0;
      try { s = W32.GetAsyncKeyState(W32.VK_ESCAPE); }
      catch (Exception) { return; }
      /* 0x8000 = 지금 눌려 있음, 0x0001 = 지난 확인 뒤로 한 번 눌렸음(짧게 톡 누른 경우) */
      if ((s & 0x8000) == 0 && (s & 0x0001) == 0) return;
      Cancelled = true;
      Done();
    }

    private Font MakeFont(float pt, FontStyle st)
    {
      float size = (float)(pt * ui);
      try { return new Font("Malgun Gothic", size, st, GraphicsUnit.Point); }
      catch (Exception) { return new Font(FontFamily.GenericSansSerif, size, st, GraphicsUnit.Point); }
    }

    private void OnBail(object sender, EventArgs e)
    {
      Cancelled = true;
      Done();
    }

    /* ── ESC 를 세 겹으로 받는다 ─────────────────────────────────────
       ① 아래 OnShown 에서 창을 앞으로 끌어와 키보드 포커스를 가져온다(TopMost 만으로는 부족하다).
       ② KeyPreview + OnKeyDown, 그리고 ProcessCmdKey — 자식 컨트롤이 키를 먹는 경우까지 잡는다.
       ③ 그래도 포커스를 못 받는 때가 있으니, 위의 50ms 타이머가 ESC 키를 직접 물어본다.
       이 셋 가운데 하나만 통해도 취소된다. */
    protected override void OnShown(EventArgs e)
    {
      base.OnShown(e);
      TopMost = true;
      try
      {
        BringToFront();
        Activate();
        Focus();
        /* WinForms 의 Activate() 만으로는 포커스를 못 받는 경우가 있어 직접 한 번 더 요청한다 */
        W32.SetForegroundWindow(Handle);
        W32.SetFocus(Handle);
      }
      catch (Exception) { }
      /* 창이 뜨기 전에 눌려 있던 ESC 기록을 다시 비운다(뜨자마자 취소되지 않게) */
      try { W32.GetAsyncKeyState(W32.VK_ESCAPE); }
      catch (Exception) { }
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
      if (e.KeyCode == Keys.Escape)
      {
        e.Handled = true;
        e.SuppressKeyPress = true;
        Cancelled = true;
        Done();
        return;
      }
      base.OnKeyDown(e);
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
      if (keyData == Keys.Escape)
      {
        Cancelled = true;
        Done();
        return true;
      }
      return base.ProcessCmdKey(ref msg, keyData);
    }

    private bool closing = false;

    private void Done()
    {
      if (closing) return;      /* 세 겹이 동시에 들어와도 한 번만 닫는다 */
      closing = true;
      try { bail.Stop(); }
      catch (Exception) { }
      try { escWatch.Stop(); }
      catch (Exception) { }
      try { Hide(); }
      catch (Exception) { }
      Close();
    }

    private static Rectangle Span(Point a, Point b)
    {
      int x = Math.Min(a.X, b.X), y = Math.Min(a.Y, b.Y);
      return new Rectangle(x, y, Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
    }

    private Rectangle Grown(Rectangle r)
    {
      int m = (int)Math.Round(70 * ui);
      Rectangle g = r;
      g.Inflate(m, m);
      return g;
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
      base.OnMouseDown(e);
      if (e.Button == MouseButtons.Right || e.Button == MouseButtons.Middle)
      {
        Cancelled = true;
        Done();
        return;
      }
      if (e.Button != MouseButtons.Left) return;
      if (mode == "point")
      {
        Cancelled = false;
        IsRegion = false;
        PointX = e.X + Left;
        PointY = e.Y + Top;
        Done();
        return;
      }
      dragging = true;
      p0 = e.Location;
      p1 = e.Location;
      Invalidate();
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
      base.OnMouseMove(e);
      if (!dragging) return;
      Rectangle before = Grown(Span(p0, p1));
      p1 = e.Location;
      Rectangle after = Grown(Span(p0, p1));
      Invalidate(Rectangle.Union(before, after));
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
      base.OnMouseUp(e);
      if (e.Button != MouseButtons.Left || !dragging) return;
      dragging = false;
      Rectangle r = Span(p0, e.Location);
      if (r.Width < 10 || r.Height < 10)
      {
        /* 너무 작으면 실수로 누른 것으로 본다 */
        Cancelled = true;
      }
      else
      {
        Cancelled = false;
        IsRegion = true;
        Chosen = Box.Make(r.X + Left, r.Y + Top, r.Width, r.Height);
      }
      Done();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
      Graphics g = e.Graphics;
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

      /* 안내 문구 — 주 모니터 위쪽 가운데에 */
      string big = (mode == "point")
        ? "누를 곳을 마우스로 한 번 클릭해 주세요"
        : "찾을 그림을 마우스로 감싸듯 끌어 주세요";
      string small = "ESC 또는 오른쪽 클릭으로 취소";
      if (prompt.Length > 0) small = prompt + "        " + small;

      Rectangle pb = Screen.PrimaryScreen.Bounds;
      SizeF s1 = g.MeasureString(big, fBig);
      SizeF s2 = g.MeasureString(small, fSmall);
      int padX = (int)Math.Round(26 * ui), padY = (int)Math.Round(16 * ui);
      int bw = (int)Math.Ceiling(Math.Max(s1.Width, s2.Width)) + padX * 2;
      int bh = (int)Math.Ceiling(s1.Height + s2.Height) + padY * 2 + (int)Math.Round(6 * ui);
      int bx = pb.X - Left + (pb.Width - bw) / 2;
      int by = pb.Y - Top + (int)Math.Round(64 * ui);

      using (SolidBrush back = new SolidBrush(Color.FromArgb(215, 20, 26, 36)))
        g.FillRectangle(back, bx, by, bw, bh);
      using (Pen edge = new Pen(Color.FromArgb(210, 91, 140, 255), Math.Max(1f, (float)(2 * ui))))
        g.DrawRectangle(edge, bx, by, bw, bh);
      using (SolidBrush w = new SolidBrush(Color.White))
        g.DrawString(big, fBig, w, bx + padX, by + padY);
      using (SolidBrush m = new SolidBrush(Color.FromArgb(235, 190, 205, 225)))
        g.DrawString(small, fSmall, m, bx + padX, by + padY + s1.Height + (float)(6 * ui));

      if (!dragging) return;

      /* 고르고 있는 사각형 */
      Rectangle r = Span(p0, p1);
      using (SolidBrush fill = new SolidBrush(Color.FromArgb(70, 255, 255, 255)))
        g.FillRectangle(fill, r);
      using (Pen line = new Pen(Color.FromArgb(255, 120, 180, 255), Math.Max(1f, (float)(2 * ui))))
        g.DrawRectangle(line, r);

      /* 크기와 좌표를 실시간으로 */
      string info = r.Width + " x " + r.Height + "  (" + (r.X + Left) + ", " + (r.Y + Top) + ")";
      SizeF si = g.MeasureString(info, fSmall);
      int ix = r.X;
      int iy = r.Y - (int)Math.Ceiling(si.Height) - (int)Math.Round(8 * ui);
      if (iy < 0) iy = r.Y + r.Height + (int)Math.Round(8 * ui);
      using (SolidBrush back = new SolidBrush(Color.FromArgb(230, 20, 26, 36)))
        g.FillRectangle(back, ix, iy, si.Width + (float)(14 * ui), si.Height + (float)(6 * ui));
      using (SolidBrush w = new SolidBrush(Color.White))
        g.DrawString(info, fSmall, w, ix + (float)(7 * ui), iy + (float)(3 * ui));
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
      base.OnFormClosed(e);
      try { bail.Dispose(); }
      catch (Exception) { }
      try { escWatch.Dispose(); }
      catch (Exception) { }
      try { fBig.Dispose(); fSmall.Dispose(); }
      catch (Exception) { }
    }
  }

  /* 찾은 자리를 알려 주는 빨간 테두리(클릭이 통과하고 포커스도 빼앗지 않는다) */
  internal class HiForm : Form
  {
    private Box target;
    private string label;
    private double ui;
    private int pad;
    private int labelH;
    private Font font;
    private System.Windows.Forms.Timer life;

    public HiForm(Box r, int ms, string label)
    {
      this.target = r;
      this.label = (label == null) ? "" : label;
      this.ui = Sc.UiScale();
      this.pad = Math.Max(3, (int)Math.Round(3 * ui));
      try { font = new Font("Malgun Gothic", (float)(10.0 * ui), FontStyle.Bold, GraphicsUnit.Point); }
      catch (Exception) { font = new Font(FontFamily.GenericSansSerif, (float)(10.0 * ui), FontStyle.Bold); }
      this.labelH = (this.label.Length > 0) ? (int)Math.Round(26 * ui) : 0;

      FormBorderStyle = FormBorderStyle.None;
      StartPosition = FormStartPosition.Manual;
      ShowInTaskbar = false;
      TopMost = true;
      AutoScaleMode = AutoScaleMode.None;
      DoubleBuffered = true;
      BackColor = Color.Magenta;
      TransparencyKey = Color.Magenta;
      Text = "이미지 매크로 — 찾은 자리";
      Bounds = new Rectangle(r.x - pad, r.y - pad - labelH, r.w + pad * 2, r.h + pad * 2 + labelH);

      life = new System.Windows.Forms.Timer();
      life.Interval = Math.Max(100, Math.Min(20000, ms));
      life.Tick += new EventHandler(OnDone);
      life.Start();
    }

    private void OnDone(object sender, EventArgs e)
    {
      try { life.Stop(); }
      catch (Exception) { }
      Close();
    }

    protected override CreateParams CreateParams
    {
      get
      {
        CreateParams cp = base.CreateParams;
        cp.ExStyle |= 0x00000020;   /* WS_EX_TRANSPARENT — 클릭이 통과한다 */
        cp.ExStyle |= 0x08000000;   /* WS_EX_NOACTIVATE  — 포커스를 빼앗지 않는다 */
        cp.ExStyle |= 0x00000080;   /* WS_EX_TOOLWINDOW  — 작업 표시줄에 안 나온다 */
        cp.ExStyle |= 0x00080000;   /* WS_EX_LAYERED     — 투명 처리 */
        return cp;
      }
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override void OnPaint(PaintEventArgs e)
    {
      Graphics g = e.Graphics;
      g.SmoothingMode = SmoothingMode.None;

      Rectangle rr = new Rectangle(pad, pad + labelH, Math.Max(1, target.w) - 1, Math.Max(1, target.h) - 1);
      Rectangle draw = rr;
      draw.Inflate(pad / 2, pad / 2);
      using (Pen p = new Pen(Color.Red, pad))
        g.DrawRectangle(p, draw);

      if (labelH > 0)
      {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        SizeF s = g.MeasureString(label, font);
        float wbox = s.Width + (float)(14 * ui);
        float hbox = labelH - (float)(4 * ui);
        using (SolidBrush b = new SolidBrush(Color.Red))
          g.FillRectangle(b, pad, 0, wbox, hbox);
        using (SolidBrush w = new SolidBrush(Color.White))
          g.DrawString(label, font, w, pad + (float)(7 * ui), (float)(2 * ui));
      }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
      base.OnFormClosed(e);
      try { life.Dispose(); }
      catch (Exception) { }
      try { font.Dispose(); }
      catch (Exception) { }
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 자체 점검용 시험 창 (--selftest 9~13번에서만 쓴다)
   *
   * 창 지정 모드가 정말 되는지 확인하려면 진짜 창이 하나 있어야 한다. 그래서
   * 스스로 작은 창을 하나 띄운다. 다만 사람이 보고 있는 화면을 건드리면 안 되니
   * 화면 밖(−4000,−4000)에 놓는다. 눈에 보이지 않지만 윈도우가 보기에는 멀쩡히
   * 살아 있는 창이라, PrintWindow 로 그림을 받을 수도 있고 쪽지를 받을 수도 있다.
   *
   * 창 안에는 미리 정한 자리에 그림(무늬)을 하나 두고, 글자칸 하나를 둔다.
   *   · postclick 이 오면 눌린 자리를 적어 둔다(깃발)
   *   · postkeys · posttext 가 오면 글자칸의 내용이 바뀐다
   *
   * 무늬는 창에 직접 그리지 않고 **작은 자식 창(PictureBox)** 에 담는다. 화면 밖에 있는
   * 창은 윈도우가 굳이 다시 그려 주지 않아서, 창이 스스로 그린 그림(OnPaint)은
   * PrintWindow 로 받을 때 있다가 없다가 한다(실제로 열 번에 세 번쯤 빠졌다).
   * 자식 창은 그 자체가 창이라 언제 찍어도 제 그림을 내준다. 덤으로 postclick 의
   * "그 자리에 있는 가장 깊은 자식 창 찾기(resolveChild)" 까지 함께 점검된다.
   * ──────────────────────────────────────────────────────────────────── */
  internal class ProbeForm : Form
  {
    private TextBox box;
    private PictureBox face;

    /* 다른 실에서 읽는 값들 — volatile 로 두어 곧바로 보이게 한다 */
    public volatile bool Clicked = false;
    public volatile int ClickX = -1;
    public volatile int ClickY = -1;
    public volatile int ClickCount = 0;
    public volatile string Typed = "";
    public volatile int Paints = 0;      /* 몇 번 그려졌나(그리기 전에 찍으면 바탕만 나온다) */

    public ProbeForm(string title, Bitmap mark, int markX, int markY, int cw, int ch)
    {
      AutoScaleMode = AutoScaleMode.None;      /* 화면 배율에 따라 크기가 바뀌면 좌표가 어긋난다 */
      Text = title;
      FormBorderStyle = FormBorderStyle.FixedSingle;
      MaximizeBox = false;
      MinimizeBox = false;
      ShowInTaskbar = false;
      StartPosition = FormStartPosition.Manual;
      Location = new Point(-4000, -4000);       /* 사람 화면 밖 */
      ClientSize = new Size(cw, ch);
      BackColor = Color.FromArgb(246, 247, 250);
      DoubleBuffered = false;                  /* PrintWindow 가 그대로 받아 가게 */

      /* 찾을 무늬 — 화소를 그대로 보여 주도록 크기를 그림과 똑같이 맞춘다 */
      face = new PictureBox();
      face.Location = new Point(markX, markY);
      face.Size = new Size(mark.Width, mark.Height);
      face.SizeMode = PictureBoxSizeMode.Normal;
      face.Image = mark;
      face.TabStop = false;
      face.MouseDown += delegate(object s, MouseEventArgs e)
      {
        /* 자식 창 좌표를 창 안쪽 좌표로 되돌려 적어 둔다 */
        ClickX = markX + e.X;
        ClickY = markY + e.Y;
        ClickCount = ClickCount + 1;
        Clicked = true;
      };
      Controls.Add(face);

      box = new TextBox();
      box.Multiline = false;
      box.Location = new Point(16, ch - 40);
      box.Size = new Size(cw - 32, 24);
      box.TabIndex = 0;
      box.TextChanged += delegate(object s, EventArgs e) { Typed = box.Text; };
      Controls.Add(box);
      ActiveControl = box;
    }

    /* 뜰 때 사람이 쓰고 있는 창에서 포커스를 빼앗지 않는다 */
    protected override bool ShowWithoutActivation { get { return true; } }

    protected override void OnShown(EventArgs e)
    {
      base.OnShown(e);
      FocusBox();
    }

    /* 글자칸이 글자를 받도록 해 둔다.
       창을 앞으로 끌어내지 않았으므로(사람 화면을 건드리지 않으려고) WinForms 의
       Focus() 만으로는 안 잡힐 때가 있다. 실 안에서의 포커스는 SetFocus 로 못 박는다 —
       posttext·postkeys 는 "그 창 안에서 지금 글자를 받는 자식 창" 으로 가기 때문이다. */
    public void FocusBox()
    {
      try
      {
        MethodInvoker go = delegate()
        {
          ActiveControl = box;
          box.Focus();
          W32.SetFocus(box.Handle);
        };
        if (InvokeRequired) Invoke(go);
        else go();
      }
      catch (Exception) { }
    }

    /* 최소화·되살리기 — 창 지정 모드가 최소화된 창을 어떻게 다루는지 점검할 때 쓴다 */
    public void SetMinimized(bool on)
    {
      try
      {
        MethodInvoker go = delegate() { WindowState = on ? FormWindowState.Minimized : FormWindowState.Normal; };
        if (InvokeRequired) Invoke(go);
        else go();
      }
      catch (Exception) { }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
      base.OnPaint(e);
      Paints = Paints + 1;
    }

    /* 지금 당장 다시 그리게 한다(그린 뒤에 찍어야 무늬가 그림에 들어 있다) */
    public void ForcePaint()
    {
      try
      {
        if (InvokeRequired) Invoke(new MethodInvoker(delegate() { Invalidate(true); Update(); }));
        else { Invalidate(true); Update(); }
      }
      catch (Exception) { }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
      base.OnMouseDown(e);
      Clicked = true;
      ClickX = e.X;
      ClickY = e.Y;
      ClickCount = ClickCount + 1;
    }

    public void ClearBox()
    {
      try
      {
        if (InvokeRequired) Invoke(new MethodInvoker(delegate() { box.Text = ""; }));
        else box.Text = "";
      }
      catch (Exception) { }
      Typed = "";
    }
  }

  /* 시험 창을 전용 STA 실에서 띄우고 붙잡아 둔다 */
  internal class ProbeWindow
  {
    public ProbeForm Form;
    public string Title;
    private Thread th;
    private Exception fail;

    public bool Open(string title, Bitmap mark, int markX, int markY, int cw, int ch, int waitMs)
    {
      Title = title;
      ProbeForm made = null;
      object gate = new object();
      th = new Thread(delegate()
      {
        try
        {
          ProbeForm f = new ProbeForm(title, mark, markX, markY, cw, ch);
          lock (gate) { made = f; }
          Application.Run(f);
        }
        catch (Exception e) { fail = e; }
      });
      th.SetApartmentState(ApartmentState.STA);
      th.IsBackground = true;
      th.Name = "점검용 시험 창";
      th.Start();

      /* 창이 실제로 만들어질 때까지 기다린다(핸들이 생겨야 찾을 수 있다) */
      int waited = 0;
      while (waited < waitMs)
      {
        ProbeForm f;
        lock (gate) { f = made; }
        if (f != null && f.IsHandleCreated)
        {
          Form = f;
          /* 창이 실제로 한 번 그려질 때까지 기다린다. 그리기 전에 그림을 받으면
             바탕만 찍혀서(윈도우가 아직 그려 준 것이 없다) 점검이 헛돌게 된다. */
          int spin = 0;
          while (f.Paints < 1 && spin < 3000) { Thread.Sleep(20); spin += 20; }
          Repaint();
          return true;
        }
        if (fail != null) return false;
        Thread.Sleep(30);
        waited += 30;
      }
      return false;
    }

    /* 다시 그리게 하고, 그려진 것을 확인한 뒤 화면 합성(DWM)이 받아 갈 틈을 준다 */
    public void Repaint()
    {
      ProbeForm f = Form;
      if (f == null) return;
      int before = f.Paints;
      f.ForcePaint();
      int spin = 0;
      while (f.Paints <= before && spin < 1500) { Thread.Sleep(20); spin += 20; }
      Thread.Sleep(200);
    }

    public string Error { get { return fail == null ? "" : fail.Message; } }

    public void Close()
    {
      try
      {
        ProbeForm f = Form;
        if (f != null && f.IsHandleCreated)
          f.Invoke(new MethodInvoker(delegate() { f.Close(); }));
      }
      catch (Exception) { }
      try { if (th != null) th.Join(1500); }
      catch (Exception) { }
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 본체 — 한 줄씩 부탁을 받아 한 줄씩 답한다.
   * ──────────────────────────────────────────────────────────────────── */
  internal static class Program
  {
    public const string VERSION = "1.0.0";
    private static string dpiMode = "none";

    [STAThread]
    private static int Main(string[] argv)
    {
      dpiMode = SetupDpi();
      SetupStdio();

      bool selftest = false;
      for (int i = 0; i < argv.Length; i++)
        if (string.Equals(argv[i], "--selftest", StringComparison.OrdinalIgnoreCase)) selftest = true;

      if (selftest) return SelfTest.Run(dpiMode);
      return Serve();
    }

    /* 화면 배율 인식 켜기 — 이게 먼저다. 안 켜면 고해상도 화면에서 좌표가 어긋난다. */
    private static string SetupDpi()
    {
      try
      {
        if (W32.SetProcessDpiAwarenessContext(new IntPtr(-4))) return "v2";
      }
      catch (Exception) { }
      try
      {
        if (W32.SetProcessDPIAware()) return "system";
      }
      catch (Exception) { }
      return "none";
    }

    /* 표준 입출력을 UTF-8 로 못 박는다. 줄 끝은 \n 하나만 쓴다. */
    private static void SetupStdio()
    {
      UTF8Encoding utf8 = new UTF8Encoding(false);
      try { Console.OutputEncoding = utf8; }
      catch (Exception) { }
      try { Console.InputEncoding = utf8; }
      catch (Exception) { }
      try
      {
        StreamWriter w = new StreamWriter(Console.OpenStandardOutput(), utf8);
        w.AutoFlush = true;
        w.NewLine = "\n";
        Console.SetOut(w);
      }
      catch (Exception) { }
      try
      {
        StreamWriter e = new StreamWriter(Console.OpenStandardError(), utf8);
        e.AutoFlush = true;
        e.NewLine = "\n";
        Console.SetError(e);
      }
      catch (Exception) { }
      try { Console.SetIn(new StreamReader(Console.OpenStandardInput(), utf8)); }
      catch (Exception) { }
    }

    private static int Serve()
    {
      try { Application.EnableVisualStyles(); }
      catch (Exception) { }
      try { Application.SetCompatibleTextRenderingDefault(false); }
      catch (Exception) { }

      Guard.Start();

      /* 기동을 알리는 첫 줄 */
      JObj ready = new JObj();
      ready.Set("ready", true);
      FillInfo(ready);
      Respond(0, true, ready, null);

      while (true)
      {
        string line;
        try { line = Console.In.ReadLine(); }
        catch (Exception) { break; }
        if (line == null) break;                 /* 서버가 파이프를 닫았다 = 그만 */
        line = line.Trim();
        if (line.Length == 0) continue;

        long id = 0;
        bool bye = false;
        try
        {
          Dictionary<string, object> msg = Json.AsObj(Json.Parse(line));
          if (msg == null) throw new WorkerError("한 줄에 JSON 객체 하나가 와야 합니다.");
          id = (long)Json.AsNum(Json.At(msg, "id"), 0);
          string cmd = Json.AsText(Json.At(msg, "cmd"), "").Trim().ToLowerInvariant();
          Dictionary<string, object> args = Json.AsObj(Json.At(msg, "args"));
          if (args == null) args = new Dictionary<string, object>();
          JObj data = Run(cmd, args, ref bye);
          Respond(id, true, data, null);
        }
        catch (WorkerError we) { Respond(id, false, null, we.Message); }
        catch (Exception e) { Respond(id, false, null, Explain(e)); }

        if (bye) break;
      }

      /* 나가기 전에 절전 막기를 풀어 준다 */
      try { W32.SetThreadExecutionState(W32.ES_CONTINUOUS); }
      catch (Exception) { }
      return 0;
    }

    private static string Explain(Exception e)
    {
      try { Console.Error.WriteLine("[worker] " + e.ToString()); }
      catch (Exception) { }
      string m = (e == null || e.Message == null) ? "" : e.Message;
      if (e is UnauthorizedAccessException) return "파일에 접근할 권한이 없습니다: " + m;
      if (e is DirectoryNotFoundException) return "폴더를 찾을 수 없습니다: " + m;
      if (e is FileNotFoundException) return "파일을 찾을 수 없습니다: " + m;
      if (e is OutOfMemoryException) return "그림이 너무 커서 메모리가 모자랍니다.";
      return "도우미에서 문제가 생겼습니다: " + m;
    }

    /* ── 명령 하나 처리 ─────────────────────────────────────────────── */

    /* 자체 점검(--selftest)이 명령을 진짜 길로 불러 보게 해 준다.
       서버가 부르는 것과 똑같은 곳을 지나므로 규격이 어긋나면 바로 드러난다. */
    public static JObj CallForTest(string cmd, Dictionary<string, object> args)
    {
      bool bye = false;
      return Run(cmd, args, ref bye);
    }

    private static JObj Run(string cmd, Dictionary<string, object> a, ref bool bye)
    {
      JObj empty = new JObj();
      switch (cmd)
      {
        case "info":
          {
            JObj o = new JObj();
            FillInfo(o);
            return o;
          }

        case "state":
          return empty;

        case "clearstop":
          {
            /* 정지 키를 바꿀 수 있게 key 를 받아 준다(없으면 그대로 F12) */
            string k = Json.AsText(Json.At(a, "key"), "");
            if (k.Length > 0) Guard.UseKey(Keyb.VkOf(k));
            Guard.Clear();
            return empty;
          }

        case "capture":
          {
            string path = Json.AsText(Json.At(a, "path"), "");
            if (path.Length == 0) throw new WorkerError("사진을 저장할 경로(path)가 없습니다.");

            /* hwnd 가 맨 위에 오면 화면이 아니라 그 창의 그림을 찍는다 */
            if (Json.AsText(Json.At(a, "hwnd"), "").Trim().Length > 0) return CaptureWindow(a, path);

            Box want = RegionArg(Json.At(a, "region"), Sc.All());
            Box got = Sc.GrabBox(want);
            using (Bitmap bmp = Sc.Grab(want)) SavePng(bmp, path);
            JObj o = new JObj();
            o.Set("path", FullPath(path)).Set("x", got.x).Set("y", got.y).Set("w", got.w).Set("h", got.h);
            return o;
          }

        case "find":
          return Find(a);

        /* ── 창 지정 모드 ─────────────────────────────────────────────
           사람의 마우스를 빼앗지 않고, 고른 창에게 쪽지(메시지)만 보낸다. */

        case "windows":
          {
            List<WinInfo> found = Win.List(Json.AsText(Json.At(a, "filter"), ""));
            List<object> list = new List<object>();
            for (int i = 0; i < found.Count; i++) list.Add(found[i].ToJson());
            JObj o = new JObj();
            o.Set("list", list);
            return o;
          }

        case "findwindow":
          {
            string h = Json.AsText(Json.At(a, "hwnd"), "");
            string title = Json.AsText(Json.At(a, "title"), "");
            string cls = Json.AsText(Json.At(a, "cls"), "");
            if (h.Trim().Length == 0 && title.Trim().Length == 0 && cls.Trim().Length == 0)
              throw new WorkerError("어느 창을 찾을지(hwnd 또는 title)를 알려 주세요.");
            WinInfo wi = Win.Find(h, title, cls);
            JObj o = new JObj();
            if (wi == null)
            {
              o.Set("found", false);
              return o;
            }
            o.Set("found", true);
            JObj j = wi.ToJson();
            for (int i = 0; i < j.Count; i++) o.Set(j.KeyAt(i), j.ValAt(i));
            return o;
          }

        case "activate":
          {
            WinInfo wi = NeedWindow(a);
            /* restore 는 기본 켜짐, front(앞으로 세우기)는 기본 꺼짐 —
               무인 운영에서 사용자가 쓰던 창을 빼앗지 않는 것이 기본이다. */
            return Win.Activate(wi,
                                Json.AsBool(Json.At(a, "restore"), true),
                                Json.AsBool(Json.At(a, "front"), false));
          }

        case "postclick":
          {
            NoPost();
            WinInfo wi = NeedWindow(a);
            int x = NeedInt(a, "x"), y = NeedInt(a, "y");
            return Win.Click(wi, x, y,
                             Json.AsText(Json.At(a, "button"), "left"),
                             Json.AsInt(Json.At(a, "clicks"), 1),
                             Json.AsBool(Json.At(a, "resolveChild"), true));
          }

        case "postscroll":
          {
            NoPost();
            WinInfo wi = NeedWindow(a);
            int amount = Json.AsInt(Json.At(a, "amount"), 0);
            if (amount == 0) throw new WorkerError("굴릴 칸수(amount)가 0 입니다. 음수는 아래, 양수는 위입니다.");
            Win.Wheel(wi, Json.AsInt(Json.At(a, "x"), 0), Json.AsInt(Json.At(a, "y"), 0), amount,
                      Json.AsBool(Json.At(a, "horizontal"), false),
                      Json.AsBool(Json.At(a, "ctrl"), false));
            return empty;
          }

        case "postkeys":
          {
            NoPost();
            WinInfo wi = NeedWindow(a);
            List<string> combos = ComboList(Json.At(a, "combo"));
            int repeat = Json.AsInt(Json.At(a, "repeat"), 1);
            /* 먼저 다 살펴보고(반쯤 보내 놓고 실패하지 않게) 그 다음에 보낸다 */
            for (int i = 0; i < combos.Count; i++) Win.CheckKey(combos[i]);
            for (int i = 0; i < combos.Count; i++) Win.Keys(wi, combos[i], repeat);
            return empty;
          }

        case "posttext":
          {
            NoPost();
            WinInfo wi = NeedWindow(a);
            string text = Json.AsText(Json.At(a, "text"), "");
            if (text.Length == 0) throw new WorkerError("넣을 글자(text)가 비어 있습니다.");
            Win.Text(wi, text);
            return empty;
          }

        case "click":
          {
            NoStop();
            int x = NeedInt(a, "x"), y = NeedInt(a, "y");
            string button = Json.AsText(Json.At(a, "button"), "left");
            int clicks = Json.AsInt(Json.At(a, "clicks"), 1);
            int moveMs = Json.AsInt(Json.At(a, "moveMs"), 120);
            bool restore = Json.AsBool(Json.At(a, "restore"), false);
            Mouse.Click(x, y, button, clicks, moveMs, restore, TextList(Json.At(a, "modifiers")));
            JObj o = new JObj();
            o.Set("x", x).Set("y", y);
            return o;
          }

        case "move":
          {
            NoStop();
            int x = NeedInt(a, "x"), y = NeedInt(a, "y");
            Mouse.MoveTo(x, y, Json.AsInt(Json.At(a, "moveMs"), 120));
            JObj o = new JObj();
            o.Set("x", x).Set("y", y);
            return o;
          }

        case "drag":
          {
            NoStop();
            int x1 = NeedInt(a, "x1"), y1 = NeedInt(a, "y1");
            int x2 = NeedInt(a, "x2"), y2 = NeedInt(a, "y2");
            Mouse.Drag(x1, y1, x2, y2, Json.AsInt(Json.At(a, "moveMs"), 400),
                       Json.AsText(Json.At(a, "button"), "left"));
            return empty;
          }

        case "scroll":
          {
            NoStop();
            object ox = Json.At(a, "x"), oy = Json.At(a, "y");
            bool hasPos = (ox != null && oy != null);
            int amount = Json.AsInt(Json.At(a, "amount"), 0);
            if (amount == 0) throw new WorkerError("굴릴 칸수(amount)가 0 입니다. 음수는 아래, 양수는 위입니다.");
            Mouse.Wheel(hasPos, Json.AsInt(ox, 0), Json.AsInt(oy, 0), amount,
                        Json.AsBool(Json.At(a, "horizontal"), false),
                        Json.AsInt(Json.At(a, "moveMs"), 120));
            return empty;
          }

        case "type":
          {
            NoStop();
            string text = Json.AsText(Json.At(a, "text"), "");
            if (text.Length == 0) throw new WorkerError("넣을 글자(text)가 비어 있습니다.");
            Keyb.Type(text, Json.AsInt(Json.At(a, "cps"), 40));
            return empty;
          }

        case "keys":
          {
            NoStop();
            List<string> combos = new List<string>();
            object c = Json.At(a, "combo");
            List<object> arr = Json.AsArr(c);
            if (arr != null)
            {
              for (int i = 0; i < arr.Count; i++) combos.Add(Json.AsText(arr[i], ""));
            }
            else
            {
              string one = Json.AsText(c, "");
              if (one.Length > 0) combos.Add(one);
            }
            if (combos.Count == 0) throw new WorkerError("누를 키(combo)가 비어 있습니다.");
            int repeat = Json.AsInt(Json.At(a, "repeat"), 1);
            if (repeat < 1) repeat = 1;
            if (repeat > 500) repeat = 500;
            int gap = Json.AsInt(Json.At(a, "gapMs"), 40);
            if (gap < 0) gap = 0;
            if (gap > 3000) gap = 3000;
            for (int r = 0; r < repeat; r++)
            {
              for (int i = 0; i < combos.Count; i++)
              {
                if (Guard.Stopped) throw new WorkerError("비상 정지 키가 눌려 키 입력을 멈췄습니다.");
                Keyb.Combo(combos[i]);
                if (gap > 0) Thread.Sleep(gap);
              }
            }
            return empty;
          }

        case "pick":
          {
            string mode = Json.AsText(Json.At(a, "mode"), "region");
            int delay = Json.AsInt(Json.At(a, "delayMs"), 0);
            string prompt = Json.AsText(Json.At(a, "prompt"), "");
            string save = Json.AsText(Json.At(a, "save"), "");
            PickResult pr = Overlay.Pick(mode, delay, prompt);
            JObj o = new JObj();
            o.Set("cancelled", pr.cancelled);
            if (!pr.cancelled)
            {
              if (pr.isRegion)
              {
                o.Set("region", pr.region.ToJson());
                if (save.Length > 0)
                {
                  /* 어두운 막이 사라진 뒤에 찍어야 그림이 어둡게 나오지 않는다 */
                  Thread.Sleep(240);
                  using (Bitmap bmp = Sc.Grab(pr.region)) SavePng(bmp, save);
                  o.Set("path", FullPath(save));
                }
              }
              else
              {
                JObj p = new JObj();
                p.Set("x", pr.px).Set("y", pr.py);
                o.Set("point", p);
              }
            }
            return o;
          }

        case "highlight":
          {
            Box r = RegionArg(Json.At(a, "region"), Box.Make(0, 0, 0, 0));
            if (r.Empty) throw new WorkerError("테두리를 보여 줄 영역(region)이 없습니다.");
            Overlay.Highlight(r, Json.AsInt(Json.At(a, "ms"), 1200), Json.AsText(Json.At(a, "label"), ""));
            return empty;
          }

        case "awake":
          {
            bool on = Json.AsBool(Json.At(a, "on"), true);
            uint flags = on
              ? (W32.ES_CONTINUOUS | W32.ES_SYSTEM_REQUIRED | W32.ES_DISPLAY_REQUIRED)
              : W32.ES_CONTINUOUS;
            if (W32.SetThreadExecutionState(flags) == 0)
              throw new WorkerError("절전 막기를 설정하지 못했습니다.");
            return empty;
          }

        case "beep":
          {
            int freq = Json.AsInt(Json.At(a, "freq"), 880);
            int ms = Json.AsInt(Json.At(a, "ms"), 150);
            if (freq < 37) freq = 37;
            if (freq > 32767) freq = 32767;
            if (ms < 10) ms = 10;
            if (ms > 5000) ms = 5000;
            W32.Beep((uint)freq, (uint)ms);
            return empty;
          }

        case "bye":
          bye = true;
          return empty;
      }
      throw new WorkerError("모르는 명령입니다: " + cmd);
    }

    /* ── 도우미 함수들 ──────────────────────────────────────────────── */

    private static void NoStop()
    {
      if (Guard.Stopped)
        throw new WorkerError("비상 정지가 걸려 있어 마우스·키보드를 움직이지 않았습니다. 정지를 풀고 다시 시작해 주세요.");
    }

    /* 창 지정 모드도 정지 키를 지킨다 — 쪽지라도 사람이 멈추라고 했으면 보내지 않는다 */
    private static void NoPost()
    {
      if (Guard.Stopped)
        throw new WorkerError("비상 정지가 걸려 있어 창에 아무것도 보내지 않았습니다. 정지를 풀고 다시 시작해 주세요.");
    }

    /* args 에서 대상 창을 집어낸다(hwnd 가 먼저, 없으면 title·cls) */
    private static WinInfo NeedWindow(Dictionary<string, object> a)
    {
      string h = Json.AsText(Json.At(a, "hwnd"), "");
      string title = Json.AsText(Json.At(a, "title"), "");
      string cls = Json.AsText(Json.At(a, "cls"), "");
      if (h.Trim().Length == 0 && title.Trim().Length == 0 && cls.Trim().Length == 0)
        throw new WorkerError("어느 창인지(hwnd 또는 title)를 알려 주세요.");
      WinInfo wi = Win.Find(h, title, cls);
      if (wi == null)
      {
        if (h.Trim().Length > 0)
          throw new WorkerError("그 창(" + h.Trim() + ")이 이미 닫혔습니다. 프로그램이 떠 있는지 확인해 주세요.");
        throw new WorkerError("그 창을 찾지 못했습니다. 프로그램을 먼저 띄워 주세요.");
      }
      return wi;
    }

    /* combo 는 글자 하나 또는 글자 목록으로 온다 */
    private static List<string> ComboList(object c)
    {
      List<string> combos = new List<string>();
      List<object> arr = Json.AsArr(c);
      if (arr != null)
      {
        for (int i = 0; i < arr.Count; i++)
        {
          string s = Json.AsText(arr[i], "");
          if (s.Length > 0) combos.Add(s);
        }
      }
      else
      {
        string one = Json.AsText(c, "");
        if (one.Length > 0) combos.Add(one);
      }
      if (combos.Count == 0) throw new WorkerError("누를 키(combo)가 비어 있습니다.");
      return combos;
    }

    /* 큰 그림에서 한 조각만 떼어 낸다(화소를 그대로 옮긴다) */
    private static Bitmap Crop(Bitmap src, Box r)
    {
      return src.Clone(new Rectangle(r.x, r.y, r.w, r.h), PixelFormat.Format32bppRgb);
    }

    /* 창 하나의 그림을 찍어 PNG 로 저장한다.
       돌려주는 x,y 는 "안쪽(클라이언트) 왼쪽 위의 화면 좌표", w,h 는 찍은 크기.
       blank:true 는 그림이 온통 한 색이라 쓸 수 없다는 뜻이다(창 지정 모드가 안 통하는 프로그램). */
    private static JObj CaptureWindow(Dictionary<string, object> a, string path)
    {
      WinInfo wi = NeedWindow(a);
      JObj o = new JObj();

      if (wi.minimized)
      {
        /* 최소화된 창은 그릴 그림이 없다 — 오류로 만들지 않고 사실만 알려 준다 */
        int mw = Math.Max(1, wi.cw), mh = Math.Max(1, wi.chh);
        using (Bitmap flat = new Bitmap(mw, mh, PixelFormat.Format32bppRgb)) SavePng(flat, path);
        o.Set("path", FullPath(path)).Set("x", wi.cx).Set("y", wi.cy).Set("w", mw).Set("h", mh)
         .Set("blank", true).Set("note", "창이 최소화되어 있습니다");
        return o;
      }

      Box client = wi.Client;
      Box reg = Box.Cross(RegionArg(Json.At(a, "region"), client), client);
      if (reg.Empty) throw new WorkerError("찍을 영역이 창 안쪽을 벗어났습니다.");

      bool blank;
      using (Bitmap bmp = Win.Grab(wi, out blank))
      {
        Box use = Box.Cross(reg, Box.Make(0, 0, bmp.Width, bmp.Height));
        if (use.Empty) throw new WorkerError("찍을 영역이 창 안쪽을 벗어났습니다.");
        if (use.x == 0 && use.y == 0 && use.w == bmp.Width && use.h == bmp.Height) SavePng(bmp, path);
        else using (Bitmap sub = Crop(bmp, use)) SavePng(sub, path);

        o.Set("path", FullPath(path)).Set("x", wi.cx + use.x).Set("y", wi.cy + use.y)
         .Set("w", use.w).Set("h", use.h).Set("blank", blank);
        if (blank) o.Set("note", "이 프로그램은 창 그림을 내주지 않습니다(온통 한 색)");
      }
      return o;
    }

    private static int NeedInt(Dictionary<string, object> a, string key)
    {
      object v = Json.At(a, key);
      if (v == null) throw new WorkerError("값이 빠졌습니다: " + key);
      return Json.AsInt(v, 0);
    }

    private static List<string> TextList(object v)
    {
      List<object> arr = Json.AsArr(v);
      if (arr == null) return null;
      List<string> outp = new List<string>();
      for (int i = 0; i < arr.Count; i++)
      {
        string s = Json.AsText(arr[i], "");
        if (s.Length > 0) outp.Add(s);
      }
      return outp.Count > 0 ? outp : null;
    }

    private static Box RegionArg(object v, Box dflt)
    {
      Dictionary<string, object> o = Json.AsObj(v);
      if (o == null) return dflt;
      int x = Json.AsInt(Json.At(o, "x"), 0);
      int y = Json.AsInt(Json.At(o, "y"), 0);
      int w = Json.AsInt(Json.At(o, "w"), 0);
      int h = Json.AsInt(Json.At(o, "h"), 0);
      if (w <= 0 || h <= 0) return dflt;
      return Box.Make(x, y, w, h);
    }

    private static string FullPath(string p)
    {
      try { return Path.GetFullPath(p); }
      catch (Exception) { return p; }
    }

    private static void SavePng(Bitmap bmp, string path)
    {
      try
      {
        string dir = Path.GetDirectoryName(Path.GetFullPath(path));
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
        bmp.Save(Path.GetFullPath(path), ImageFormat.Png);
      }
      catch (Exception e)
      {
        throw new WorkerError("그림을 저장하지 못했습니다: " + e.Message);
      }
    }

    private static void FillInfo(JObj o)
    {
      o.Set("version", VERSION);
      o.Set("dpi", dpiMode);
      o.Set("screens", Sc.List());
      o.Set("virtual", Sc.All().ToJson());
    }

    /* ── find ───────────────────────────────────────────────────────── */

    private static JObj Find(Dictionary<string, object> a)
    {
      Stopwatch watch = Stopwatch.StartNew();
      object rawRegion = Json.At(a, "region");
      string topHwnd = Json.AsText(Json.At(a, "hwnd"), "");
      List<object> raw = Json.AsArr(Json.At(a, "items"));
      if (raw == null || raw.Count == 0) throw new WorkerError("찾을 그림 목록(items)이 없습니다.");

      /* 같은 창을 여러 번 캐묻지 않도록 한 번 알아낸 것을 기억한다 */
      Dictionary<string, WinInfo> known = new Dictionary<string, WinInfo>();

      List<FindItem> items = new List<FindItem>();
      for (int i = 0; i < raw.Count; i++)
      {
        Dictionary<string, object> o = Json.AsObj(raw[i]);
        if (o == null) throw new WorkerError("items 안에 그림 설명이 아닌 값이 있습니다.");
        FindItem it = new FindItem();
        it.idx = i;
        it.key = Json.AsText(Json.At(o, "key"), "item" + i.ToString(CultureInfo.InvariantCulture));
        it.image = Json.AsText(Json.At(o, "image"), "");
        it.threshold = Json.AsNum(Json.At(o, "threshold"), 0.87);
        it.mode = (Json.AsText(Json.At(o, "mode"), "best") == "all") ? "all" : "best";
        it.max = Json.AsInt(Json.At(o, "max"), 1);
        it.grayscale = Json.AsBool(Json.At(o, "grayscale"), true);

        /* hwnd 는 맨 위에 온 것을 쓰고, items 안에 있으면 그 항목만 그것을 쓴다 */
        it.hwndText = Json.AsText(Json.At(o, "hwnd"), topHwnd).Trim();
        it.hasRegion = true;

        if (it.hwndText.Length > 0)
        {
          it.win = KnownWindow(known, it.hwndText);
          /* 창 지정 모드에서 region 은 "창 안쪽(클라이언트) 좌표" 다 */
          Box client = it.win.Client;
          Box def = Box.Cross(RegionArg(rawRegion, client), client);
          Box want = RegionArg(Json.At(o, "region"), def);
          it.region = Box.Cross(want, client);
        }
        else
        {
          Box def = RegionArg(rawRegion, Sc.All());
          Box want = RegionArg(Json.At(o, "region"), def);
          it.region = Sc.GrabBox(want);        /* 화면 밖으로 나간 부분은 잘라 낸다 */
        }
        items.Add(it);
      }

      /* 같은 창·같은 영역을 보는 그림들은 그림을 한 번만 찍어서 함께 찾는다 */
      Dictionary<string, List<FindItem>> groups = new Dictionary<string, List<FindItem>>();
      List<string> order = new List<string>();
      JObj[] slot = new JObj[items.Count];
      for (int i = 0; i < items.Count; i++)
      {
        FindItem it = items[i];
        if (it.win != null && it.win.minimized)
        {
          /* 최소화된 창은 그림을 볼 수 없다 — 오류가 아니라 "지금은 못 봤다" 다 */
          slot[it.idx] = Finder.Fail(it.key, "창이 최소화되어 있습니다");
          continue;
        }
        if (it.region.Empty)
        {
          slot[it.idx] = Finder.Fail(it.key,
            it.win != null ? "검색 영역이 창 안쪽 밖입니다" : "검색 영역이 화면 밖입니다");
          continue;
        }
        string key = (it.win != null ? Win.Hex(it.win.hwnd) + "|" : "") + it.region.Key;
        List<FindItem> list;
        if (!groups.TryGetValue(key, out list))
        {
          list = new List<FindItem>();
          groups[key] = list;
          order.Add(key);
        }
        list.Add(it);
      }

      for (int gi = 0; gi < order.Count; gi++)
      {
        List<FindItem> list = groups[order[gi]];
        FindItem head = list[0];
        Box reg = head.region;

        if (head.win == null)
        {
          using (Bitmap bmp = Sc.Grab(reg)) Finder.RunGroup(bmp, reg, list, slot, false, 0, 0);
          continue;
        }

        /* ── 창 지정 모드 ── 창 그림을 받아서 그 안에서 찾는다.
           찾은 자리는 두 벌로 돌려준다 —
             x,y,cx,cy     화면 절대 좌표(사람이 보기 위해)
             lx,ly,lcx,lcy 창 안쪽 좌표(postclick 에 넣을 값) */
        WinInfo wi = head.win;
        bool blank;
        using (Bitmap full = Win.Grab(wi, out blank))
        {
          Box use = Box.Cross(reg, Box.Make(0, 0, full.Width, full.Height));
          if (blank || use.Empty)
          {
            string note = blank
              ? "이 프로그램은 창 그림을 내주지 않습니다(온통 한 색). 화면 모드로 바꿔 주세요."
              : "검색 영역이 창 안쪽 밖입니다";
            for (int i = 0; i < list.Count; i++) slot[list[i].idx] = Finder.Fail(list[i].key, note);
            continue;
          }
          /* ox·oy 에는 화면 절대 좌표를, lox·loy 에는 창 안쪽 좌표를 준다 */
          Box abs = Box.Make(wi.cx + use.x, wi.cy + use.y, use.w, use.h);
          if (use.x == 0 && use.y == 0 && use.w == full.Width && use.h == full.Height)
          {
            Finder.RunGroup(full, abs, list, slot, true, use.x, use.y);
          }
          else
          {
            using (Bitmap sub = Crop(full, use))
              Finder.RunGroup(sub, abs, list, slot, true, use.x, use.y);
          }
        }
      }

      List<object> results = new List<object>();
      for (int i = 0; i < slot.Length; i++)
        results.Add(slot[i] != null ? (object)slot[i] : (object)Finder.Fail(items[i].key, "찾지 못했습니다"));

      JObj data = new JObj();
      data.Set("ms", (int)watch.ElapsedMilliseconds);
      data.Set("results", results);
      return data;
    }

    /* 창 번호 글자 하나당 한 번만 창을 알아본다 */
    private static WinInfo KnownWindow(Dictionary<string, WinInfo> known, string hwndText)
    {
      WinInfo wi;
      if (known.TryGetValue(hwndText, out wi)) return wi;
      wi = Win.Info(Win.FromText(hwndText));
      if (wi == null)
        throw new WorkerError("그 창(" + hwndText + ")이 이미 닫혔습니다. 프로그램이 떠 있는지 확인해 주세요.");
      known[hwndText] = wi;
      return wi;
    }

    /* ── 응답 한 줄 내보내기 ────────────────────────────────────────── */

    private static JObj EnvObj()
    {
      W32.POINT c = Guard.Cursor();
      List<object> cur = new List<object>();
      cur.Add(c.x);
      cur.Add(c.y);
      JObj e = new JObj();
      e.Set("stop", Guard.Stopped);
      e.Set("cursor", cur);
      e.Set("locked", Guard.Locked());
      e.Set("idleMs", Guard.IdleMs());
      return e;
    }

    private static void Respond(long id, bool ok, JObj data, string error)
    {
      JObj o = new JObj();
      o.Set("id", id);
      o.Set("ok", ok);
      if (ok) o.Set("data", data == null ? new JObj() : data);
      else o.Set("error", string.IsNullOrEmpty(error) ? "알 수 없는 문제가 생겼습니다." : error);
      o.Set("env", EnvObj());

      string line;
      try { line = Json.Write(o); }
      catch (Exception)
      {
        line = "{\"id\":" + id.ToString(CultureInfo.InvariantCulture)
             + ",\"ok\":false,\"error\":\"\\ub2f5\\uc744 \\ub9cc\\ub4e4\\uc9c0 \\ubabb\\ud588\\uc2b5\\ub2c8\\ub2e4\",\"env\":{}}";
      }
      try
      {
        Console.Out.Write(line);
        Console.Out.Write("\n");
        Console.Out.Flush();
      }
      catch (Exception) { }
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   * 스스로 점검 (worker.exe --selftest)
   *
   * 진짜 화면이나 마우스는 절대 건드리지 않는다. 대신 그림판처럼 가짜 화면을
   * 하나 만들어 놓고, 그 안에 미리 정한 자리에 그림을 붙여 두고
   * "찾기" 가 바로 그 자리를 집어내는지 8가지로 확인한다.
   * ──────────────────────────────────────────────────────────────────── */
  internal static class SelfTest
  {
    private static int fails = 0;
    private static int total = 0;

    public static int Run(string dpiMode)
    {
      string dir = Path.Combine(Path.GetTempPath(), "ImageMacro_selftest");
      Line("이미지 매크로 도우미 스스로 점검 — 버전 " + Program.VERSION);
      Line("");

      try
      {
        if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);

        /* ── 1) 화면 배율 인식과 모니터 목록 ── */
        List<object> screens = Sc.List();
        Box virt = Sc.All();
        bool ok1 = (dpiMode != "none") && screens.Count >= 1 && virt.w >= 100 && virt.h >= 100;
        Judge(ok1, "1. 화면 배율 인식 = " + dpiMode + " · 모니터 " + screens.Count
                 + "대 · 전체 화면 " + virt.w + "x" + virt.h);

        /* ── 그림·가짜 화면 준비 ── */
        string pBlue = Path.Combine(dir, "btn_blue.png");
        string pRed = Path.Combine(dir, "btn_red.png");
        string pGreen = Path.Combine(dir, "circle_green.png");
        string pBig = Path.Combine(dir, "btn_big.png");

        /* 파랑과 빨강은 회색조로 바꾸면 밝기가 똑같다(83). 그래서 색 경로를 제대로 시험할 수 있다. */
        using (Bitmap b = Button(120, 40, Color.FromArgb(40, 80, 220), "Login")) Save(b, pBlue);
        using (Bitmap b = Button(120, 40, Color.FromArgb(184, 40, 40), "Login")) Save(b, pRed);
        using (Bitmap b = Circle(60, 60, Color.FromArgb(30, 160, 90))) Save(b, pGreen);
        using (Bitmap b = Button(300, 300, Color.FromArgb(40, 80, 220), "Big")) Save(b, pBig);

        using (Bitmap blue = Load(pBlue))
        using (Bitmap red = Load(pRed))
        {
          /* ── 2) 있는 자리를 오차 없이 찾나 ── */
          using (Bitmap sA = Screen(1920, 1080, 11))
          {
            Paste(sA, blue, 812, 455, 0, 0, 1);
            Stopwatch w2 = Stopwatch.StartNew();
            JObj r = Look(sA, pBlue, 0.87, "best", 1, true);
            w2.Stop();
            bool ok2 = B(r, "found") && I(r, "x") == 812 && I(r, "y") == 455 && D(r, "score") >= 0.99;
            Judge(ok2, "2. 정해 둔 자리(812,455)를 오차 0px 로 찾기 → " + Spot(r)
                     + " · 점수 " + D(r, "score").ToString("0.000", CultureInfo.InvariantCulture)
                     + " · " + w2.ElapsedMilliseconds + "ms");

            /* ── 4) 없는 그림은 못 찾았다고 해야 한다(오탐 없나) ── */
            JObj r4 = Look(sA, pGreen, 0.87, "best", 1, true);
            bool ok4 = !B(r4, "found");
            Judge(ok4, "4. 화면에 없는 그림은 못 찾았다고 답하기 → found=" + (B(r4, "found") ? "true" : "false")
                     + " · 가장 높았던 점수 " + D(r4, "score").ToString("0.000", CultureInfo.InvariantCulture));

            /* ── 8) 속도 (1920x1080 에서 120x40 찾기) ── */
            Look(sA, pBlue, 0.87, "best", 1, true);              /* 준비 운동(첫 번째는 그림 해석 시간이 섞인다) */
            Stopwatch w8 = Stopwatch.StartNew();
            JObj r8 = Look(sA, pBlue, 0.87, "best", 1, true);
            w8.Stop();
            long ms = w8.ElapsedMilliseconds;
            Judge(B(r8, "found") && ms <= 300, "8. 속도: 1920x1080 화면에서 120x40 그림 찾기 = "
                     + ms + "ms (300ms 이내여야 한다)");
          }

          /* ── 3) 밝기 ±12, 잡티 ±6 을 섞어도 찾나 ── */
          using (Bitmap sB = Screen(1920, 1080, 22))
          {
            Paste(sB, blue, 300, 120, 12, 6, 7);
            Paste(sB, blue, 1500, 700, -12, 6, 9);
            JObj r = Look(sB, pBlue, 0.9, "all", 5, true);
            List<object> all = A(r, "all");
            bool ok3 = B(r, "found") && all.Count == 2;
            if (ok3)
            {
              for (int i = 0; i < all.Count; i++)
              {
                JObj one = (JObj)all[i];
                int x = I(one, "x"), y = I(one, "y");
                bool near = (Math.Abs(x - 300) <= 1 && Math.Abs(y - 120) <= 1)
                         || (Math.Abs(x - 1500) <= 1 && Math.Abs(y - 700) <= 1);
                if (!near || D(one, "score") < 0.9) ok3 = false;
              }
            }
            Judge(ok3, "3. 밝기 ±12 · 잡티 ±6 을 섞어도 점수 0.9 이상으로 찾기 → " + AllSpots(r));
          }

          /* ── 5) 그림이 화면보다 클 때 ── */
          using (Bitmap sSmall = Screen(200, 200, 33))
          {
            JObj r = Look(sSmall, pBig, 0.87, "best", 1, true);
            string note = S(r, "note");
            bool ok5 = !B(r, "found") && note.Length > 0;
            Judge(ok5, "5. 그림(300x300)이 검색 영역(200x200)보다 클 때 오류 없이 못 찾음 → \"" + note + "\"");
          }

          /* ── 6) 여러 개 있을 때 개수를 맞게 세나 ── */
          using (Bitmap sC = Screen(1920, 1080, 44))
          {
            Paste(sC, blue, 100, 100, 0, 0, 2);
            Paste(sC, blue, 700, 300, 0, 0, 3);
            Paste(sC, blue, 1400, 800, 0, 0, 4);
            JObj r = Look(sC, pBlue, 0.87, "all", 5, true);
            List<object> all = A(r, "all");
            bool ok6 = (all.Count == 3);
            if (ok6)
            {
              /* 세 자리가 모두 붙여 둔 자리와 맞는지, 같은 자리를 두 번 세지 않았는지 */
              bool[] hit = new bool[3];
              int[] xs = new int[] { 100, 700, 1400 };
              int[] ys = new int[] { 100, 300, 800 };
              for (int i = 0; i < all.Count; i++)
              {
                JObj one = (JObj)all[i];
                int found = -1;
                for (int j = 0; j < 3; j++)
                  if (Math.Abs(I(one, "x") - xs[j]) <= 1 && Math.Abs(I(one, "y") - ys[j]) <= 1) found = j;
                if (found < 0 || hit[found]) ok6 = false;
                else hit[found] = true;
              }
            }
            Judge(ok6, "6. 같은 그림이 3개일 때 mode:\"all\" 로 3개를 겹치지 않게 세기 → "
                     + all.Count + "개 " + AllSpots(r));
          }

          /* ── 7) 회색조 경로와 컬러 경로 모두 ── */
          using (Bitmap sD = Screen(1920, 1080, 55))
          {
            Paste(sD, blue, 200, 150, 0, 0, 5);
            Paste(sD, red, 900, 600, 0, 0, 6);

            JObj g = Look(sD, pBlue, 0.87, "best", 1, true);      /* 회색조 : 두 단추가 밝기까지 똑같다 */
            JObj c1 = Look(sD, pBlue, 0.87, "best", 1, false);    /* 컬러  : 파랑만 집어야 한다 */
            JObj c2 = Look(sD, pRed, 0.87, "best", 1, false);     /* 컬러  : 빨강만 집어야 한다 */

            bool okGray = B(g, "found") && D(g, "score") >= 0.99
                          && ((I(g, "x") == 200 && I(g, "y") == 150) || (I(g, "x") == 900 && I(g, "y") == 600));
            bool okColor = B(c1, "found") && I(c1, "x") == 200 && I(c1, "y") == 150 && D(c1, "score") >= 0.99
                        && B(c2, "found") && I(c2, "x") == 900 && I(c2, "y") == 600 && D(c2, "score") >= 0.99;
            Judge(okGray && okColor,
              "7. 회색조 경로 " + Spot(g) + " 점수 " + D(g, "score").ToString("0.000", CultureInfo.InvariantCulture)
              + " / 컬러 경로 파랑 " + Spot(c1) + " 빨강 " + Spot(c2)
              + " (회색조로는 밝기가 같아 헷갈리는 두 단추를 색으로 갈라내는지 본다)");
          }

          /* ── 16) 여러 개 세기 — 일부러 짓궂은 조건에서 ──
             6번은 붙이는 자리가 순한 편이라, 예전에 있던 결함을 그냥 지나쳤다.
             여기서는 실제로 사람을 괴롭혔던 두 가지를 함께 넣는다.

               ① 자리의 나머지(x%k, y%k)가 0이 아닌 곳에 붙인다.
                  화면을 k 화소마다 잘라 평균 내는 "줄이기" 는 화면 왼쪽 위부터 칸을 끊는다.
                  그림이 k 의 배수 자리에 놓이지 않으면 화면 쪽 칸과 그림 쪽 칸이 어긋나서,
                  똑같은 그림인데도 줄인 그림끼리는 점수가 크게 떨어진다.
               ② 크고 밋밋한 흰 칸을 화면에 여러 개 둔다.
                  1단계 표본을 한쪽 색(흰색)으로만 뽑으면 이 빈 칸들이 후보 자리를
                  다 차지해 진짜 단추가 1단계에서 떨어진다.

             둘 중 하나라도 어긋나면 여섯 개 가운데 몇 개가 조용히 빠진다.
             "몇 개 찾았나" 만 보지 말고 여섯 자리에 하나씩 정확히 대응하는지까지 본다. */
          using (Bitmap sE = BlankyScreen(1920, 1080, 66))
          {
            int[] xs = new int[] { 137, 611, 1042, 1499, 766, 1301 };
            int[] ys = new int[] { 101, 254, 529, 196, 802, 913 };
            int[] br = new int[] { 0, 9, -9, 5, -6, 11 };
            int[] nz = new int[] { 0, 3, 5, 2, 6, 4 };
            for (int i = 0; i < xs.Length; i++) Paste(sE, blue, xs[i], ys[i], br[i], nz[i], 300 + i);

            JObj r = Look(sE, pBlue, 0.9, "all", 12, true);
            List<object> all = A(r, "all");
            bool ok16 = (all.Count == xs.Length);
            int matched = 0;
            if (ok16)
            {
              bool[] hit = new bool[xs.Length];
              for (int i = 0; i < all.Count; i++)
              {
                JObj one = (JObj)all[i];
                int found = -1;
                for (int j = 0; j < xs.Length; j++)
                  if (Math.Abs(I(one, "x") - xs[j]) <= 1 && Math.Abs(I(one, "y") - ys[j]) <= 1) found = j;
                if (found < 0 || hit[found]) ok16 = false;
                else { hit[found] = true; matched++; }
                if (D(one, "score") < 0.9) ok16 = false;
              }
            }
            Judge(ok16, "16. 짓궂은 조건(줄이기 칸이 어긋나는 자리 + 크고 밋밋한 흰 칸)에서 6개를 다 세기 → "
                     + all.Count + "개 찾음 · 제자리 " + matched + "/6 " + AllSpots(r));
          }

          /* ── 17) 단일 찾기 — 닮은 것이 바로 옆에 붙어 있고 자리도 어긋날 때 ──
             16번은 mode:"all" 을 본다. 그런데 이 결함은 스텝이 늘 쓰는 mode:"best"
             에서도 터진다. 큰 단추 위에 작은 단추가 겹쳐 놓인 자리(진짜 화면에서
             흔하다 — 단추 안의 단추, 목록 칸 안의 아이콘)를 k 의 배수가 아닌 자리에
             두면, 예전 코드는 화소가 딱 맞는 자리(점수 1.000)를 놓치고 엉뚱한 자리를
             0.571 로 집어 "못 찾았다" 고 답했다. 스텝이 조용히 안 눌리는 것이다.
             그러니 "찾았나" 만 보지 말고 화소 단위로 그 자리인지까지 본다. */
          using (Bitmap sF = Screen(1920, 1080, 77))
          {
            string pSmall = Path.Combine(dir, "btn_small.png");
            using (Bitmap b = Button(60, 22, Color.FromArgb(40, 80, 220), "OK")) Save(b, pSmall);
            int px = 967, py = 545;          /* k=2·3·4 어느 쪽으로도 나머지가 0이 아니다 */
            Paste(sF, blue, px, py, 6, 3, 9);
            using (Bitmap small = Load(pSmall)) Paste(sF, small, px, py, 6, 3, 9);

            JObj r = Look(sF, pSmall, 0.87, "best", 1, true);
            bool ok17 = B(r, "found") && I(r, "x") == px && I(r, "y") == py && D(r, "score") >= 0.99;
            Judge(ok17, "17. 큰 단추 위에 작은 단추가 겹친 자리(" + px + "," + py + ")를 단일 찾기로 정확히 → "
                     + Spot(r) + " 점수 " + D(r, "score").ToString("0.000", CultureInfo.InvariantCulture)
                     + " found=" + (B(r, "found") ? "true" : "false"));
          }
        }

        /* ── 9~14) 창 지정 모드 ── */
        WindowChecks(dir);
      }
      catch (Exception e)
      {
        Fail("점검 도중 예상 못한 문제: " + e.Message);
        try { Console.Error.WriteLine(e.ToString()); }
        catch (Exception) { }
      }
      finally
      {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
        catch (Exception) { }
      }

      Line("");
      if (fails > 0)
      {
        Line("SELFTEST FAIL — " + fails + "가지가 어긋납니다. 위의 [실패] 줄을 보세요.");
        return 1;
      }
      Line("SELFTEST OK — " + total + "가지 점검을 모두 통과했습니다.");
      return 0;
    }

    /* ── 9~14) 창 지정 모드 점검 ──────────────────────────────────────
       사람이 보는 화면을 건드리지 않으려고, 화면 밖(−4000,−4000)에 우리가 만든
       시험 창을 하나 띄워 놓고 그 창을 상대로만 확인한다.
       명령은 서버가 부르는 것과 똑같은 길(Program.CallForTest)로 부른다. */
    private static void WindowChecks(string dir)
    {
      /* ── 9) 창 목록을 주나, 창 번호 모양이 규격대로인가 ── */
      JObj wl = Cmd("windows", new JObj());
      List<object> list = A(wl, "list");
      bool ok9 = list.Count >= 1;
      string shape = "";
      for (int i = 0; i < list.Count; i++)
      {
        JObj one = list[i] as JObj;
        if (one == null) { ok9 = false; continue; }
        string h = S(one, "hwnd");
        if (!HexHandle(h)) { ok9 = false; shape = h; }
      }
      Judge(ok9, "9. windows 로 창 목록 받기 → " + list.Count + "개"
               + (shape.Length > 0 ? (" · 창 번호 모양이 어긋납니다: \"" + shape + "\"") : " · 창 번호는 모두 \"0x????????\" 모양"));

      /* ── 시험 창 띄우기 (제목은 겹치지 않게 시각을 붙인다) ── */
      string mark = Path.Combine(dir, "win_mark.png");
      using (Bitmap b = Button(120, 40, Color.FromArgb(40, 80, 220), "Win")) Save(b, mark);

      string title = "이미지매크로 점검창 " + DateTime.Now.Ticks.ToString(CultureInfo.InvariantCulture);
      int cw = 480, ch = 320, mx = 140, my = 90;
      ProbeWindow probe = new ProbeWindow();
      using (Bitmap face = Load(mark))
      {
        if (!probe.Open(title, face, mx, my, cw, ch, 6000))
        {
          Fail("10~14. 점검용 시험 창을 띄우지 못했습니다" + (probe.Error.Length > 0 ? (": " + probe.Error) : ""));
          return;
        }
        try
        {
          /* ── 10) 제목으로 그 창을 찾아내나 ── */
          JObj fw = Cmd("findwindow", new JObj().Set("title", title));
          string hwnd = S(fw, "hwnd");
          bool ok10 = B(fw, "found") && HexHandle(hwnd)
                      && I(fw, "cw") == cw && I(fw, "ch") == ch && !B(fw, "minimized");
          Judge(ok10, "10. findwindow 로 제목으로 시험 창 찾기 → found=" + (B(fw, "found") ? "true" : "false")
                    + " hwnd=" + (hwnd.Length > 0 ? hwnd : "(없음)")
                    + " 안쪽 " + I(fw, "cw") + "x" + I(fw, "ch") + " (원한 것 " + cw + "x" + ch + ")");
          if (!ok10) return;

          /* ── 11) 창 그림을 받아 오나(온통 한 색이 아닌가) ── */
          probe.Repaint();
          string shot = Path.Combine(dir, "win_shot.png");
          JObj cap = Cmd("capture", new JObj().Set("hwnd", hwnd).Set("path", shot));
          long size = 0;
          try { size = new FileInfo(S(cap, "path")).Length; }
          catch (Exception) { }
          bool ok11 = !B(cap, "blank") && I(cap, "w") == cw && I(cap, "h") == ch && size > 500
                      && I(cap, "x") == I(fw, "x") + (I(fw, "w") - cw) / 2;   /* 안쪽 왼쪽 위의 화면 좌표 */
          Judge(ok11, "11. capture{hwnd} 로 창 그림 받기 → " + I(cap, "w") + "x" + I(cap, "h")
                    + " · 안쪽 왼쪽 위 화면 좌표 (" + I(cap, "x") + "," + I(cap, "y") + ")"
                    + " · blank=" + (B(cap, "blank") ? "true" : "false") + " · 파일 " + size + "바이트");

          /* ── 12) 창 안에 그려 둔 무늬를 창 안쪽 좌표로 정확히 찾나 ── */
          probe.Repaint();
          JObj item = new JObj();
          item.Set("key", "mark").Set("image", mark).Set("threshold", 0.87)
              .Set("mode", "best").Set("max", 1).Set("grayscale", true);
          List<object> items = new List<object>();
          items.Add(item);
          JObj fd = Cmd("find", new JObj().Set("hwnd", hwnd).Set("items", items));
          JObj res = FirstResult(fd);
          bool ok12 = B(res, "found")
                      && Math.Abs(I(res, "lx") - mx) <= 1 && Math.Abs(I(res, "ly") - my) <= 1
                      && Math.Abs(I(res, "lcx") - (mx + 60)) <= 1 && Math.Abs(I(res, "lcy") - (my + 20)) <= 1
                      && I(res, "x") == I(cap, "x") + I(res, "lx")     /* 화면 좌표와 창 안쪽 좌표가 앞뒤가 맞나 */
                      && I(res, "y") == I(cap, "y") + I(res, "ly")
                      && D(res, "score") >= 0.95;
          Judge(ok12, "12. find{hwnd} 로 창 안쪽 좌표 찾기 → 창 안쪽 (" + I(res, "lx") + "," + I(res, "ly") + ")"
                    + " 가운데 (" + I(res, "lcx") + "," + I(res, "lcy") + ")"
                    + " · 화면 (" + I(res, "x") + "," + I(res, "y") + ")"
                    + " · 점수 " + D(res, "score").ToString("0.000", CultureInfo.InvariantCulture)
                    + " (그려 둔 자리 " + mx + "," + my + ")");

          /* ── 13) 그 자리에 postclick 을 보내면 창이 눌렸다고 하나 ── */
          int tx = I(res, "lcx"), ty = I(res, "lcy");
          if (!ok12) { tx = mx + 60; ty = my + 20; }
          probe.Form.Clicked = false;
          probe.Form.ClickX = -1;
          probe.Form.ClickY = -1;
          JObj pc = Cmd("postclick", new JObj().Set("hwnd", hwnd).Set("x", tx).Set("y", ty)
                                               .Set("button", "left").Set("clicks", 1).Set("resolveChild", true));
          bool got = WaitFor(delegate() { return probe.Form.Clicked; }, 2500);
          string child = S(pc, "child");
          /* 무늬는 자식 창에 담겨 있으니 resolveChild 가 그 자식을 찾아냈어야 한다 */
          bool intoChild = HexHandle(child) && child != hwnd;
          bool ok13 = got && intoChild
                      && Math.Abs(probe.Form.ClickX - tx) <= 2 && Math.Abs(probe.Form.ClickY - ty) <= 2;
          Judge(ok13, "13. postclick 을 창에 보내기 → 창이 받은 자리 ("
                    + probe.Form.ClickX + "," + probe.Form.ClickY + ") · 보낸 자리 (" + tx + "," + ty + ")"
                    + " · 파고든 자식 창 " + child + (intoChild ? "" : " (자식 창을 찾지 못했습니다)"));

          /* ── 14) postkeys(단일 키)·posttext 가 글자칸에 들어가나, 조합키는 거절하나 ──
             방금 postclick 을 무늬(자식 창)에 보냈으니 포커스를 글자칸으로 되돌려 둔다 */
          probe.Form.FocusBox();
          probe.Form.ClearBox();
          Cmd("postkeys", new JObj().Set("hwnd", hwnd).Set("combo", "a").Set("repeat", 2));
          bool typedKeys = WaitFor(delegate() { return probe.Form.Typed == "aa"; }, 2500);
          string afterKeys = probe.Form.Typed;

          probe.Form.ClearBox();
          string say = "매크로 abc 123";
          Cmd("posttext", new JObj().Set("hwnd", hwnd).Set("text", say));
          bool typedText = WaitFor(delegate() { return probe.Form.Typed == say; }, 4000);
          string afterText = probe.Form.Typed;

          string refused = CmdError("postkeys", new JObj().Set("hwnd", hwnd).Set("combo", "ctrl+s"));
          bool ok14 = typedKeys && typedText
                      && refused.Length > 0 && refused.IndexOf("조합키", StringComparison.Ordinal) >= 0;
          Judge(ok14, "14. postkeys(\"a\" 두 번) → \"" + afterKeys + "\" · posttext → \"" + afterText + "\""
                    + " · 조합키(ctrl+s) 거절 → " + (refused.Length > 0 ? ("\"" + refused + "\"") : "거절하지 않았습니다(문제)"));

          /* ── 15) 최소화된 창은 오류가 아니라 "지금은 못 본다" 로 알려 주나 ── */
          probe.Form.SetMinimized(true);
          WaitFor(delegate()
          {
            JObj w = Cmd("findwindow", new JObj().Set("hwnd", hwnd));
            return B(w, "minimized");
          }, 3000);

          JObj mcap = Cmd("capture", new JObj().Set("hwnd", hwnd)
                                               .Set("path", Path.Combine(dir, "win_min.png")));
          JObj mfd = Cmd("find", new JObj().Set("hwnd", hwnd).Set("items", items));
          JObj mres = FirstResult(mfd);
          bool ok15 = B(mcap, "blank") && S(mcap, "note").IndexOf("최소화", StringComparison.Ordinal) >= 0
                      && !B(mres, "found") && S(mres, "note").IndexOf("최소화", StringComparison.Ordinal) >= 0;
          Judge(ok15, "15. 최소화된 창 → capture blank=" + (B(mcap, "blank") ? "true" : "false")
                    + " \"" + S(mcap, "note") + "\" · find found=" + (B(mres, "found") ? "true" : "false")
                    + " \"" + S(mres, "note") + "\" (오류가 아니라 알림이어야 한다)");
          probe.Form.SetMinimized(false);
        }
        finally
        {
          probe.Close();
        }
      }
    }

    /* 명령을 서버와 똑같은 길로 부른다 — JObj → JSON 글자 → 다시 파싱 → 처리.
       (JSON 쓰기·읽기까지 함께 점검된다) */
    private static JObj Cmd(string cmd, JObj args)
    {
      Dictionary<string, object> a = Json.AsObj(Json.Parse(Json.Write(args)));
      if (a == null) a = new Dictionary<string, object>();
      return Program.CallForTest(cmd, a);
    }

    /* 거절해야 하는 명령을 불러 보고 그 이유를 돌려준다(거절하지 않으면 빈 글자) */
    private static string CmdError(string cmd, JObj args)
    {
      try
      {
        Cmd(cmd, args);
        return "";
      }
      catch (WorkerError we) { return we.Message; }
      catch (Exception e) { return e.Message; }
    }

    private static JObj FirstResult(JObj data)
    {
      List<object> arr = A(data, "results");
      if (arr.Count == 0) return new JObj();
      JObj one = arr[0] as JObj;
      return one == null ? new JObj() : one;
    }

    /* "0x" + 여덟 자리 16진수 인가 */
    private static bool HexHandle(string s)
    {
      if (s == null || s.Length != 10) return false;
      if (s[0] != '0' || (s[1] != 'x' && s[1] != 'X')) return false;
      for (int i = 2; i < s.Length; i++)
      {
        char c = s[i];
        bool hex = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
        if (!hex) return false;
      }
      return true;
    }

    private delegate bool Cond();

    /* 쪽지는 곧바로 처리되지 않는다 — 창이 처리할 틈을 주며 기다린다 */
    private static bool WaitFor(Cond c, int ms)
    {
      int waited = 0;
      while (waited < ms)
      {
        if (c()) return true;
        Thread.Sleep(40);
        waited += 40;
      }
      return c();
    }

    /* ── 점검용 그림 만들기 ─────────────────────────────────────────── */

    /* 흰 바탕에 색 사각형과 글자가 있는 단추 그림 */
    private static Bitmap Button(int w, int h, Color fill, string text)
    {
      Bitmap b = new Bitmap(w, h, PixelFormat.Format32bppRgb);
      using (Graphics g = Graphics.FromImage(b))
      {
        g.Clear(Color.White);
        g.SmoothingMode = SmoothingMode.None;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
        int m = Math.Max(2, w / 30);
        using (SolidBrush br = new SolidBrush(fill))
          g.FillRectangle(br, m, m, w - m * 2, h - m * 2);
        using (Pen p = new Pen(Color.FromArgb(30, 40, 60), 1f))
          g.DrawRectangle(p, m, m, w - m * 2 - 1, h - m * 2 - 1);
        float size = Math.Max(7f, h * 0.36f);
        using (Font f = new Font("Arial", size, FontStyle.Bold, GraphicsUnit.Pixel))
        using (StringFormat sf = new StringFormat())
        {
          sf.Alignment = StringAlignment.Center;
          sf.LineAlignment = StringAlignment.Center;
          g.DrawString(text, f, Brushes.White, new RectangleF(0, 0, w, h), sf);
        }
      }
      return b;
    }

    /* 흰 바탕에 색 동그라미 (화면에 없는 그림 역할) */
    private static Bitmap Circle(int w, int h, Color fill)
    {
      Bitmap b = new Bitmap(w, h, PixelFormat.Format32bppRgb);
      using (Graphics g = Graphics.FromImage(b))
      {
        g.Clear(Color.White);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (SolidBrush br = new SolidBrush(fill))
          g.FillEllipse(br, 4, 4, w - 9, h - 9);
      }
      return b;
    }

    /* 창이 몇 개 떠 있는 것처럼 보이는 "가짜 화면" */
    private static Bitmap Screen(int w, int h, int seed)
    {
      Bitmap b = new Bitmap(w, h, PixelFormat.Format32bppRgb);
      Random rnd = new Random(seed);
      using (Graphics g = Graphics.FromImage(b))
      {
        using (LinearGradientBrush bg = new LinearGradientBrush(new Rectangle(0, 0, w, h),
                 Color.FromArgb(236, 239, 244), Color.FromArgb(206, 213, 224), 40f))
          g.FillRectangle(bg, 0, 0, w, h);

        /* 창처럼 보이는 회색 사각형 몇 개 + 글줄 흉내 */
        for (int i = 0; i < 5; i++)
        {
          int cw = Math.Max(60, w / 4 + rnd.Next(w / 6));
          int chh = Math.Max(50, h / 4 + rnd.Next(h / 6));
          int cx = rnd.Next(Math.Max(1, w - cw));
          int cy = rnd.Next(Math.Max(1, h - chh));
          using (SolidBrush win = new SolidBrush(Color.FromArgb(250, 250, 252)))
            g.FillRectangle(win, cx, cy, cw, chh);
          using (SolidBrush bar = new SolidBrush(Color.FromArgb(226, 231, 240)))
            g.FillRectangle(bar, cx, cy, cw, Math.Max(10, chh / 12));
          using (Pen edge = new Pen(Color.FromArgb(196, 204, 216), 1f))
            g.DrawRectangle(edge, cx, cy, cw - 1, chh - 1);
          using (SolidBrush ink = new SolidBrush(Color.FromArgb(120, 132, 150)))
            for (int y = cy + chh / 6; y < cy + chh - 12; y += 14)
              g.FillRectangle(ink, cx + 12, y, Math.Max(8, cw - 24 - rnd.Next(cw / 3)), 5);
        }
      }
      Grain(b, 3, seed + 100);   /* 옅은 잡티 — 진짜 화면처럼 완전히 밋밋한 곳이 없게 */
      return b;
    }

    /* 가짜 화면 + 크고 밋밋한 흰 칸 몇 개(빈 문서·빈 목록칸 흉내).
       1단계 표본을 한쪽 색으로만 뽑으면 이런 빈 칸이 후보를 다 차지해 버린다. */
    private static Bitmap BlankyScreen(int w, int h, int seed)
    {
      Bitmap b = Screen(w, h, seed);
      Random rnd = new Random(seed + 7);
      using (Graphics g = Graphics.FromImage(b))
      using (SolidBrush white = new SolidBrush(Color.White))
        for (int i = 0; i < 7; i++)
        {
          int pw = w / 6 + rnd.Next(w / 5);
          int ph = h / 8 + rnd.Next(h / 5);
          g.FillRectangle(white, rnd.Next(Math.Max(1, w - pw)), rnd.Next(Math.Max(1, h - ph)), pw, ph);
        }
      Grain(b, 2, seed + 200);   /* 빈 칸도 진짜 화면처럼 아주 옅은 잡티는 있다 */
      return b;
    }

    /* 그림 전체에 아주 옅은 잡티 뿌리기 */
    private static unsafe void Grain(Bitmap bmp, int amount, int seed)
    {
      if (amount <= 0) return;
      Random rnd = new Random(seed);
      BitmapData bd = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height),
                                   ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      try
      {
        for (int y = 0; y < bmp.Height; y++)
        {
          byte* p = (byte*)bd.Scan0 + (long)y * bd.Stride;
          for (int x = 0; x < bmp.Width; x++)
          {
            int n = rnd.Next(-amount, amount + 1);
            for (int c = 0; c < 3; c++)
            {
              int v = p[x * 4 + c] + n;
              if (v < 0) v = 0;
              if (v > 255) v = 255;
              p[x * 4 + c] = (byte)v;
            }
          }
        }
      }
      finally { bmp.UnlockBits(bd); }
    }

    /* 그림을 가짜 화면의 정해진 자리에 화소 그대로 붙인다(밝기·잡티를 섞을 수도 있다).
       GDI+ 로 그리면 아주 미세하게 흐려질 수 있어서 직접 화소를 옮긴다. */
    private static unsafe void Paste(Bitmap dst, Bitmap src, int x, int y, int bright, int noise, int seed)
    {
      Random rnd = new Random(seed);
      BitmapData ds = dst.LockBits(new Rectangle(0, 0, dst.Width, dst.Height),
                                   ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      BitmapData ss = src.LockBits(new Rectangle(0, 0, src.Width, src.Height),
                                   ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try
      {
        for (int j = 0; j < src.Height; j++)
        {
          if (y + j < 0 || y + j >= dst.Height) continue;
          byte* sp = (byte*)ss.Scan0 + (long)j * ss.Stride;
          byte* dp = (byte*)ds.Scan0 + (long)(y + j) * ds.Stride;
          for (int i = 0; i < src.Width; i++)
          {
            if (x + i < 0 || x + i >= dst.Width) continue;
            for (int c = 0; c < 3; c++)
            {
              int v = sp[i * 4 + c] + bright;
              if (noise > 0) v += rnd.Next(-noise, noise + 1);
              if (v < 0) v = 0;
              if (v > 255) v = 255;
              dp[(x + i) * 4 + c] = (byte)v;
            }
            dp[(x + i) * 4 + 3] = 255;
          }
        }
      }
      finally
      {
        dst.UnlockBits(ds);
        src.UnlockBits(ss);
      }
    }

    private static void Save(Bitmap b, string path)
    {
      b.Save(path, ImageFormat.Png);
    }

    private static Bitmap Load(string path)
    {
      byte[] raw = File.ReadAllBytes(path);
      using (MemoryStream ms = new MemoryStream(raw))
      using (Bitmap src = new Bitmap(ms))
      {
        Bitmap copy = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppRgb);
        using (Graphics g = Graphics.FromImage(copy))
        {
          g.InterpolationMode = InterpolationMode.NearestNeighbor;
          g.PixelOffsetMode = PixelOffsetMode.Half;
          g.DrawImage(src, new Rectangle(0, 0, src.Width, src.Height),
                      0, 0, src.Width, src.Height, GraphicsUnit.Pixel);
        }
        return copy;
      }
    }

    /* 가짜 화면에서 그림 하나 찾기 — 진짜 화면 캡처와 똑같은 함수를 쓴다 */
    private static JObj Look(Bitmap screen, string image, double thr, string mode, int max, bool gray)
    {
      FindItem it = new FindItem();
      it.idx = 0;
      it.key = "t";
      it.image = image;
      it.threshold = thr;
      it.mode = mode;
      it.max = max;
      it.grayscale = gray;
      it.region = Box.Make(0, 0, screen.Width, screen.Height);
      it.hasRegion = true;
      List<FindItem> list = new List<FindItem>();
      list.Add(it);
      JObj[] slot = new JObj[1];
      Finder.RunGroup(screen, it.region, list, slot, false, 0, 0);
      return slot[0];
    }

    /* ── 결과 읽기·찍기 ─────────────────────────────────────────────── */

    private static object V(JObj o, string key)
    {
      if (o == null) return null;
      for (int i = 0; i < o.Count; i++) if (o.KeyAt(i) == key) return o.ValAt(i);
      return null;
    }
    private static bool B(JObj o, string key)
    {
      object v = V(o, key);
      return (v is bool) ? (bool)v : false;
    }
    private static int I(JObj o, string key)
    {
      object v = V(o, key);
      if (v is int) return (int)v;
      if (v is double) return (int)Math.Round((double)v);
      return -1;
    }
    private static double D(JObj o, string key)
    {
      object v = V(o, key);
      if (v is double) return (double)v;
      if (v is int) return (int)v;
      return 0;
    }
    private static string S(JObj o, string key)
    {
      object v = V(o, key);
      return (v is string) ? (string)v : "";
    }
    private static List<object> A(JObj o, string key)
    {
      object v = V(o, key);
      return (v is List<object>) ? (List<object>)v : new List<object>();
    }
    private static string Spot(JObj o)
    {
      return "(" + I(o, "x") + "," + I(o, "y") + ")";
    }
    private static string AllSpots(JObj o)
    {
      List<object> all = A(o, "all");
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < all.Count; i++)
      {
        JObj one = all[i] as JObj;
        if (one == null) continue;
        if (sb.Length > 0) sb.Append(" ");
        sb.Append("(").Append(I(one, "x")).Append(",").Append(I(one, "y")).Append(")");
        sb.Append("[").Append(D(one, "score").ToString("0.000", CultureInfo.InvariantCulture)).Append("]");
      }
      return sb.ToString();
    }

    private static void Line(string s)
    {
      try { Console.Out.WriteLine(s); }
      catch (Exception) { }
    }
    private static void Judge(bool ok, string what)
    {
      total++;
      if (ok) Line("  [통과] " + what);
      else
      {
        fails++;
        Line("  [실패] " + what);
      }
    }
    private static void Fail(string what)
    {
      fails++;
      Line("  [실패] " + what);
    }
  }
}
