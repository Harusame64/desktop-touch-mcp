#!/usr/bin/env node
// Parse every PowerShell `run:` block in .github/workflows with PowerShell's own parser, so a syntax
// error in a step that runs only on a release tag is found on the PR, not on the tag. PR codex on #940
// found one: `"$LASTEXITCODE: …"` reads the colon as a scope and the whole step fails to parse.
//
// A block is PowerShell when its step says `shell: pwsh` / `shell: powershell`, or when it has no
// `shell:` and its job runs on Windows (where `run:` defaults to pwsh) and no `defaults.run.shell`
// says otherwise. GitHub expressions (`${{ … }}`) are replaced by a plain word before parsing: they are
// substituted before PowerShell sees the script.
//
// Needs pwsh on PATH (windows-latest has it). Usage: node scripts/check-workflow-pwsh.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, ".github", "workflows");
const isPwsh = (s) => s === "pwsh" || s === "powershell";

const blocks = [];
for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const wf = yaml.load(readFileSync(join(DIR, file), "utf8"));
  const wfShell = wf?.defaults?.run?.shell;
  for (const [jobId, job] of Object.entries(wf?.jobs ?? {})) {
    const runsOn = JSON.stringify(job["runs-on"] ?? "");
    const jobShell = job?.defaults?.run?.shell ?? wfShell;
    (job.steps ?? []).forEach((step, i) => {
      if (typeof step.run !== "string") return;
      const shell = step.shell ?? jobShell ?? (/windows/i.test(runsOn) ? "pwsh" : "bash");
      if (!isPwsh(shell)) return;
      blocks.push({ where: `${file} › ${jobId} › ${step.name ?? `step ${i + 1}`}`, script: step.run.replace(/\$\{\{[\s\S]*?\}\}/g, "GHEXPR") });
    });
  }
}
if (blocks.length === 0) {
  console.error("[check-workflow-pwsh] FAIL — no PowerShell blocks found; the extraction is broken");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "dtmcp-wf-pwsh-"));
try {
  const files = blocks.map((b, i) => {
    const p = join(work, `block-${i}.ps1`);
    writeFileSync(p, b.script);
    return p;
  });
  writeFileSync(join(work, "files.json"), JSON.stringify(files));
  const checker = `
    $files = Get-Content -Raw -LiteralPath '${join(work, "files.json").replace(/'/g, "''")}' | ConvertFrom-Json
    $bad = 0
    for ($i = 0; $i -lt $files.Count; $i++) {
      $tokens = $null; $errs = $null
      [void][System.Management.Automation.Language.Parser]::ParseFile($files[$i], [ref]$tokens, [ref]$errs)
      foreach ($e in $errs) { $bad++; Write-Output ("{0}\t{1}:{2}\t{3}" -f $i, $e.Extent.StartLineNumber, $e.Extent.StartColumnNumber, $e.Message) }
    }
    exit $bad
  `;
  let out = "";
  let failed = false;
  try {
    out = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", checker], { encoding: "utf8" });
  } catch (e) {
    if (e.code === "ENOENT") {
      console.error("[check-workflow-pwsh] FAIL — pwsh is not on PATH");
      process.exit(1);
    }
    out = e.stdout ?? "";
    failed = true;
  }
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [idx, pos, msg] = line.split("\t");
    console.error(`[check-workflow-pwsh] ${blocks[Number(idx)]?.where} (line:col ${pos} of the run block): ${msg}`);
  }
  if (failed) process.exit(1);
  console.log(`[check-workflow-pwsh] OK — ${blocks.length} PowerShell blocks parse`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
