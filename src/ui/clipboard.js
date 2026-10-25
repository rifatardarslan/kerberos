import { spawn } from 'node:child_process';
import readline from 'node:readline';

// Selecting text is the terminal's job (copy on select), so Kerberos never sees the
// copy itself. On Windows a hidden message-only window subscribes to clipboard
// updates (WM_CLIPBOARDUPDATE, no polling) and reports copies made by the terminal
// the moment they happen; elsewhere this is a no-op.

/** Processes whose clipboard writes count as "copied from the terminal". */
export const TERMINAL_OWNERS = /^(WindowsTerminal|OpenConsole|conhost)$/i;

const WATCHER = String.raw`
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class KerberosClip : NativeWindow {
  [DllImport("user32.dll")] static extern bool AddClipboardFormatListener(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  const int WM_CLIPBOARDUPDATE = 0x031D;
  readonly Timer parentCheck = new Timer();

  public KerberosClip(int parent) {
    CreateParams cp = new CreateParams();
    cp.Parent = new IntPtr(-3); // HWND_MESSAGE: invisible, receives messages only
    CreateHandle(cp);
    AddClipboardFormatListener(Handle);
    parentCheck.Interval = 2000;
    parentCheck.Tick += delegate {
      try { Process.GetProcessById(parent); } catch { Application.Exit(); }
    };
    parentCheck.Start();
  }

  static string ProcessOf(IntPtr hwnd) {
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    if (pid == 0) return "";
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  static string ReadText() {
    for (int i = 0; i < 5; i++) {
      try { return Clipboard.ContainsText() ? Clipboard.GetText() : ""; }
      catch { System.Threading.Thread.Sleep(10); } // still held by the writer
    }
    return "";
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_CLIPBOARDUPDATE) {
      string text = ReadText();
      int lines = text.Length == 0 ? 0 : text.TrimEnd('\r', '\n').Split('\n').Length;
      Console.Out.WriteLine("{\"owner\":\"" + ProcessOf(GetClipboardOwner()) + "\",\"fg\":\"" + ProcessOf(GetForegroundWindow()) + "\",\"chars\":" + text.Length + ",\"lines\":" + lines + "}");
      Console.Out.Flush();
    }
    base.WndProc(ref m);
  }
}
`;

const SCRIPT = (parentPid) => `
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
${WATCHER}
'@
$watcher = New-Object KerberosClip ${parentPid}
[System.Windows.Forms.Application]::Run()
`;

/** Footer text for one copy. */
export function copyNotice({ chars, lines }) {
  return `✓ ${chars.toLocaleString('tr-TR')} karakter kopyalandı${lines > 1 ? ` · ${lines} satır` : ''}`;
}

/**
 * Call `onCopy({ chars, lines, owner })` whenever the terminal puts text on the
 * clipboard. Returns a function that stops watching.
 */
export function watchCopies(onCopy, { owners = TERMINAL_OWNERS, platform = process.platform } = {}) {
  if (platform !== 'win32') return () => {};
  let child;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT(process.pid), 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return () => {};
  }
  child.on('error', () => {}); // no PowerShell: no notices, nothing else changes
  let last = { at: 0, chars: -1 };
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const copy = JSON.parse(line);
      // Some writers leave no owner window; then the copy counts if the terminal is in front.
      const fromTerminal = owners.test(copy.owner) || ((!copy.owner || copy.owner === 'Idle') && owners.test(copy.fg));
      if (!(copy.chars > 0 && fromTerminal)) return;
      // One copy can fire twice (several clipboard formats).
      const now = Date.now();
      if (copy.chars === last.chars && now - last.at < 400) return;
      last = { at: now, chars: copy.chars };
      onCopy(copy);
    } catch {
      // not ours
    }
  });
  const stop = () => {
    process.off('exit', stop);
    child.kill();
  };
  process.on('exit', stop);
  return stop;
}
