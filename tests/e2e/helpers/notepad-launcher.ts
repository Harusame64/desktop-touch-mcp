/**
 * notepad-launcher.ts — spawn Notepad with a unique-tagged title.
 *
 * Uses a temp .txt file whose basename contains the tag; Notepad puts that
 * basename in its window title, giving us a collision-free findWindow key.
 */

import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { enumTopLevelWindowHandles, enumWindowsInZOrder, getWindowProcessId } from "../../../src/engine/win32.js";
import { clearWindowTopmost } from "../../../src/engine/win32.js";
import { classifyTaggedWindows } from "./powershell-launcher.js";
import { sleep } from "./wait.js";

export interface NpInstance {
  proc: ChildProcess;
  tag: string;
  title: string;
  hwnd: bigint;
  tempFile: string;
  kill(): void;
}

const isNotepadTitle = (title: string): boolean => title.includes("メモ帳") || title.includes("Notepad");

function listNotepadWindows(): { hwnd: bigint; title: string; region: { x: number; y: number; width: number; height: number } }[] {
  return enumWindowsInZOrder()
    .filter((w) => isNotepadTitle(w.title))
    .map((w) => ({ hwnd: w.hwnd, title: w.title, region: w.region }));
}

export async function launchNotepad(): Promise<NpInstance> {
  const tag = `np-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // mkdtempSync allocates a fresh, kernel-randomised directory under tmpdir()
  // (the suffix is process-private and unpredictable to other users on the
  // box), so writing `<tag>.txt` inside it cannot race with a pre-existing
  // file at a guessable path. The dir + its file are both removed in kill()
  // below. Using a fixed `tmpdir()/<tag>.txt` would trip the
  // `js/insecure-temporary-file` CodeQL rule (alert #119, same pattern as
  // PR #192 powershell-launcher fix).
  const tempDir = mkdtempSync(join(tmpdir(), "dtm-np-"));
  const tempFile = join(tempDir, `${tag}.txt`);
  writeFileSync(tempFile, "", "utf8");
  // **Only a window this launch opened** — the invariant `classifyTaggedWindows` states. Windows
  // 11's Notepad has tabs, and whether `notepad.exe <file>` joins an open Notepad as a tab is a
  // setting, not measured here; if it does, that window's title carries the tag and `kill()` below
  // force-closes by title. That would be the user's window, with whatever they had not saved.
  const before = new Set(enumTopLevelWindowHandles());
  // `kill()` below ends a PROCESS (taskkill by window title), not a window. If Windows 11's Notepad
  // puts the new window into a process that already had windows — the way Windows Terminal holds
  // every window in one process — that kill takes the user's other Notepad windows with it, unsaved
  // work included. Whether it does is not measured (gate 2 on #683), so a window whose process owned
  // a window before the launch is refused like a pre-existing window is.
  const processesBefore = new Set([...before].map((h) => getWindowProcessId(h)).filter((pid) => pid > 0));
  const proc = spawn("notepad.exe", [tempFile], { detached: true, stdio: "ignore" });

  // From here a window may be open: every throw ends the Notepad this launch started and removes its
  // file (the PowerShell launcher's leak, internal #129: a throw after the spawn skipped the cleanup
  // and the launch never returned, so no `kill()` could run).
  let found: { hwnd: bigint; title: string } | null = null;
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const tagged = classifyTaggedWindows(listNotepadWindows(), before, tag);
      if (tagged.preexisting !== null) {
        // Nothing is sent to that window and nothing is killed by title: the tab is the user's to close.
        throw new Error(
          `Notepad opened "${tag}" as a tab in a window that existed before the launch (hwnd ${tagged.preexisting.hwnd}) — ` +
            `refusing to use or close a window this fixture did not open. Close that Notepad, or set it ` +
            `to open files in a new window, and run again.`,
        );
      }
      found = tagged.opened;
      if (found && processesBefore.has(getWindowProcessId(found.hwnd))) {
        throw new Error(
          `Notepad opened "${tag}" in a new window of a process that already had windows (pid ${getWindowProcessId(found.hwnd)}) — ` +
            `ending it by title would end the user's other Notepad windows too. Refusing; close Notepad and run again.`,
        );
      }
      if (found) break;
      await sleep(100);
    }
    if (!found) throw new Error(`Notepad window with tag "${tag}" did not appear within 20s`);
  } catch (err) {
    try { proc.kill(); } catch { /* ignore */ }
    try { unlinkSync(tempFile); } catch { /* ignore */ }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }

  const captured = found;
  return {
    proc,
    tag,
    title: captured.title,
    hwnd: captured.hwnd,
    tempFile,
    kill() {
      try { clearWindowTopmost(captured.hwnd); } catch { /* ignore */ }
      // Notepad on Win11 ignores SIGTERM (it's a GUI app and may also pop a
      // "Save changes?" dialog). Use taskkill /F by window title to force-close.
      // taskkill ends the PROCESS that owns the window, so this is safe only because
      // the launch above refused both a window it did not open and a window in a
      // process that already had windows. No `/T`: a descendant-tree kill is what
      // took down a user's terminal on 2026-05-08.
      try {
        const { execSync } = require("child_process");
        execSync(`taskkill /F /FI "WINDOWTITLE eq ${tag}*"`, { stdio: "ignore" });
      } catch { /* best-effort */ }
      if (!proc.killed) {
        try { proc.kill(); } catch { /* ignore */ }
      }
      // Remove the file first, then the now-empty per-launch directory.
      // Best-effort so a leftover never blocks a future test run.
      try { unlinkSync(tempFile); } catch { /* ignore */ }
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
