/**
 * ssh-wsl-launcher.ts — drive a real bash session over SSH-into-WSL for the
 * issue #386 exit-mode e2e (plan §9 acceptance: "SSH-into-WSL bash で multiline
 * echo 自己マッチが起きない").
 *
 * This is the #383 measurement harness reused for regression proof: a conhost
 * PowerShell window (titled + findable via the existing launchPowerShell safety
 * net) immediately `exec`s the System32 OpenSSH client into WSL Ubuntu's
 * sshd:2222, landing in an interactive `bash --norc`. The foreground process is
 * then bash-over-SSH while the window keeps its [Console]::Title tag, so
 * terminal(action='run') can target it by windowTitle.
 *
 * Why this is the canonical #386 scenario: the WINDOW process is conhost (a host
 * that hides the real shell), so detectShell → low confidence → shell:'auto'
 * loud-fails (ExitModeShellAmbiguous). The session is actually bash, so the
 * caller passes shell:'bash' explicitly — exactly the SSH/WSL-nesting wall the
 * exit-mode design is built around.
 *
 * Availability is probed once (key auth into WSL); on any miss the suite skips
 * cleanly (env condition, not a product bug).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchPowerShell, type PsInstance } from "./powershell-launcher.js";
import { terminalReadHandler } from "../../../src/tools/terminal.js";
import { parsePayload } from "./wait.js";
import { sleep } from "./wait.js";

const execFileAsync = promisify(execFile);

const SSH_EXE = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const SSH_PORT = "2222";
const SSH_USER = "root";
const SSH_HOST = "127.0.0.1";
const KEY_PATH = join(homedir(), ".ssh", "wsl_measure");

/** Common ssh options: key auth only, no host-key prompt, no known_hosts churn. */
function sshOpts(): string[] {
  return [
    "-p", SSH_PORT,
    "-i", KEY_PATH,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=NUL",
    // Generous: WSL auto-sleeps and the first connection has to wake it, which
    // can take several seconds.
    "-o", "ConnectTimeout=25",
  ];
}

/** Wake WSL + ensure sshd is listening — WSL idles aggressively. Best-effort. */
async function wakeWslSshd(): Promise<void> {
  try {
    await execFileAsync(
      "wsl.exe",
      ["--", "bash", "-lc", "sudo service ssh start 2>/dev/null; true"],
      { timeout: 25_000, windowsHide: true },
    );
  } catch {
    /* best-effort — the ssh probe below is the real gate */
  }
}

let cached: boolean | null = null;

/**
 * True when this machine can key-auth into WSL bash over sshd:2222. Cached per
 * process. Wakes WSL first (it idles), then runs a non-interactive
 * `ssh … 'echo DTM_SSH_OK'` (BatchMode so a missing key never hangs on a
 * password prompt) with one retry to absorb a cold WSL start.
 */
export async function isSshWslAvailable(): Promise<boolean> {
  if (cached !== null) return cached;
  if (process.platform !== "win32" || !existsSync(SSH_EXE) || !existsSync(KEY_PATH)) {
    cached = false;
    return false;
  }
  await wakeWslSshd();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout } = await execFileAsync(
        SSH_EXE,
        [...sshOpts(), "-o", "BatchMode=yes", `${SSH_USER}@${SSH_HOST}`, "echo DTM_SSH_OK"],
        { timeout: 30_000, windowsHide: true },
      );
      if (stdout.includes("DTM_SSH_OK")) {
        cached = true;
        return true;
      }
    } catch {
      /* retry once */
    }
  }
  cached = false;
  return false;
}

export interface SshBashInstance extends PsInstance {
  /** Marker the remote shell prints once interactive bash is ready. */
  readyMarker: string;
}

/**
 * Launch a conhost window that SSHes into WSL bash and waits until the remote
 * interactive shell is ready (the readyMarker has rendered into the buffer).
 *
 * `bash --norc` is used so the default Ubuntu prompt cannot emit an xterm title
 * escape that would rename the window out from under findTerminalWindow — the
 * window keeps its [Console]::Title tag. PS1 stays the bash default and PS2 is
 * `> `, which is exactly the multiline-continuation shape #386 exercises.
 */
export async function launchSshWslBash(): Promise<SshBashInstance> {
  const readyMarker = `BASHREADY_${Date.now().toString(36)}`;
  // Single-quoted PS literals: backslashes in KEY_PATH and the remote command
  // are passed verbatim. The remote command runs `echo <marker>` then execs an
  // interactive no-rc bash so the session stays drivable by terminal_send.
  const sshArgs = [
    "-tt", // force a remote pty so bash is interactive over the piped session
    ...sshOpts(),
    `${SSH_USER}@${SSH_HOST}`,
  ]
    .map((a) => `'${a.replace(/'/g, "''")}'`)
    .join(" ");
  const remoteCmd = `'echo ${readyMarker}; exec bash --norc -i'`;
  const postScript = `& '${SSH_EXE}' ${sshArgs} ${remoteCmd}`;

  const ps = await launchPowerShell({
    host: "conhost",
    banner: `psbeforessh-${readyMarker}`,
    postScript,
  });

  // Poll the buffer until the remote readiness marker appears (bash is up).
  const deadline = Date.now() + 25_000;
  let ready = false;
  while (Date.now() < deadline) {
    const r = parsePayload(
      await terminalReadHandler({
        windowTitle: ps.title,
        lines: 200,
        stripAnsi: true,
        source: "auto",
        ocrLanguage: "ja",
      }),
    );
    // The marker also appears in the echoed `echo <marker>` command line, so
    // require it to show up at least twice (command echo + the echo output) OR
    // accompanied by a bash prompt sigil, to be sure bash is actually live.
    if (r.ok && typeof r.text === "string") {
      const hits = r.text.split(readyMarker).length - 1;
      if (hits >= 2) {
        ready = true;
        break;
      }
    }
    await sleep(500);
  }
  if (!ready) {
    ps.kill();
    throw new Error(`SSH-into-WSL bash did not become ready (marker ${readyMarker} not observed)`);
  }
  // Small settle so the prompt after the marker is fully painted.
  await sleep(500);

  return { ...ps, readyMarker, kill: ps.kill };
}
