/**
 * notepad-launcher.ts — spawn Notepad with a unique-tagged title.
 *
 * Uses a temp .txt file whose basename contains the tag; Notepad puts that
 * basename in its window title, giving us a collision-free findWindow key.
 */

import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { enumWindowsInZOrder } from "../../../src/engine/win32.js";
import { clearWindowTopmost } from "../../../src/engine/win32.js";
import { sleep } from "./wait.js";

export interface NpInstance {
  proc: ChildProcess;
  tag: string;
  title: string;
  hwnd: bigint;
  tempFile: string;
  kill(): void;
}

function findNotepadByTag(tag: string): { hwnd: bigint; title: string } | null {
  for (const w of enumWindowsInZOrder()) {
    if (!w.title.includes(tag)) continue;
    if (w.title.includes("メモ帳") || w.title.includes("Notepad")) {
      return { hwnd: w.hwnd, title: w.title };
    }
  }
  return null;
}

export async function launchNotepad(): Promise<NpInstance> {
  const tag = `np-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const tempFile = join(tmpdir(), `${tag}.txt`);
  writeFileSync(tempFile, "", "utf8");
  const proc = spawn("notepad.exe", [tempFile], { detached: true, stdio: "ignore" });

  const deadline = Date.now() + 20_000;
  let found: { hwnd: bigint; title: string } | null = null;
  while (Date.now() < deadline) {
    found = findNotepadByTag(tag);
    if (found) break;
    await sleep(100);
  }
  if (!found) {
    try { proc.kill(); } catch { /* ignore */ }
    try { unlinkSync(tempFile); } catch { /* ignore */ }
    throw new Error(`Notepad window with tag "${tag}" did not appear within 20s`);
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
      try {
        const { execSync } = require("child_process");
        execSync(`taskkill /F /FI "WINDOWTITLE eq ${tag}*" /T`, { stdio: "ignore" });
      } catch { /* best-effort */ }
      if (!proc.killed) {
        try { proc.kill(); } catch { /* ignore */ }
      }
      try { unlinkSync(tempFile); } catch { /* ignore */ }
    },
  };
}
