"""ADR-039 spike — does a click land under the transparent overlay?

計器の注意: `enumWindowsInZOrder` はメニュー（`#32768`）を数えられない
（Alt+F で開いても 0 のまま。生の `EnumWindows` なら 1）。**生で数える。**
"""
import ctypes, subprocess, sys, tempfile, time, os
from ctypes import wintypes

u32 = ctypes.WinDLL("user32", use_last_error=True)
k32 = ctypes.WinDLL("kernel32")
SB = r"D:\git\temp\desktop-touch-mcp-0908-131720"
PS_COUNT = r"C:\Users\harus\AppData\Local\Temp\claude\D--git-pictkura\1247b2d8-e2ba-4c4e-bfe2-af02c06c6c79\scratchpad\count-menus.ps1"


class KI(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("ex", ctypes.POINTER(ctypes.c_ulong))]


class MI(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("ex", ctypes.POINTER(ctypes.c_ulong))]


class U(ctypes.Union):
    _fields_ = [("ki", KI), ("mi", MI), ("pad", ctypes.c_byte * 32)]


class INP(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", U)]


def mouse(flags):
    i = INP(type=0)
    i.mi = MI(0, 0, 0, flags, 0, None)
    return i


def send(xs, wait=0.9):
    a = (INP * len(xs))(*xs)
    u32.SendInput(len(xs), a, ctypes.sizeof(INP))
    time.sleep(wait)


def menus():
    r = subprocess.run(["pwsh", "-NoProfile", "-File", PS_COUNT], capture_output=True, text=True, timeout=60)
    return r.stdout.strip()


def click(x, y):
    u32.SetCursorPos(x, y)
    time.sleep(0.15)
    send([mouse(0x0002)], 0.06)   # LEFTDOWN
    send([mouse(0x0004)], 0.9)    # LEFTUP


TITLE = "無題 - メモ帳"
h = u32.FindWindowW(None, TITLE)
if not h:
    print("!! target not found"); sys.exit(2)


class R(ctypes.Structure):
    _fields_ = [("l", ctypes.c_long), ("t", ctypes.c_long), ("r", ctypes.c_long), ("b", ctypes.c_long)]


rc = R(); u32.GetWindowRect(h, ctypes.byref(rc))
MX, MY = rc.l + 39, rc.t + 41          # UIA-measured File-menu offset
print('target  : "%s" hwnd=%d  rect=(%d,%d)' % (TITLE, h, rc.l, rc.t))
print("menu pt : (%d,%d)" % (MX, MY))

mine = k32.GetCurrentThreadId()
fgw = u32.GetForegroundWindow()
fgt = u32.GetWindowThreadProcessId(fgw, None)
tid = u32.GetWindowThreadProcessId(h, None)
u32.AttachThreadInput(mine, fgt, True)
u32.AttachThreadInput(mine, tid, True)
u32.ShowWindow(h, 9); u32.BringWindowToTop(h); u32.SetForegroundWindow(h)
time.sleep(0.8)
print("前面    :", u32.GetForegroundWindow() == h)

d = tempfile.mkdtemp(prefix="adr039-")
stop = os.path.join(d, "stop")
ov = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                       os.path.join(SB, "tools", "adr039-overlay.ps1"), "-StopFile", stop],
                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
time.sleep(4.0)
print("overlay :", (ov.stdout.readline() or "").strip())

print()
print("=== overlay が出ている状態でクリック ===")
print("  before  #32768 =", menus())
click(MX, MY)
after = menus()
print("  click   #32768 =", after)
if after != "0":
    send([], 0)  # noop
    u32.SetCursorPos(MX, MY)
    click(MX, MY)   # 閉じる
    print("  closed  #32768 =", menus())

open(stop, "w").write("stop")
time.sleep(1.5)
u32.AttachThreadInput(mine, tid, False)
u32.AttachThreadInput(mine, fgt, False)
print()
print("=== overlay を下ろした ===")
print("  #32768 =", menus())
