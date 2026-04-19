# Release Process

This project uses a hybrid distribution model:

- npm publishes a lightweight launcher package: `@harusame64/desktop-touch-mcp`
- GitHub Releases publish the real Windows runtime zip: `desktop-touch-mcp-windows.zip`

Users run:

```bash
npx -y @harusame64/desktop-touch-mcp
```

On first run, the npm launcher resolves the runtime by npm package version.
For package `X.Y.Z`, it fetches GitHub Release tag `vX.Y.Z`, verifies
`desktop-touch-mcp-windows.zip` with SHA256, then extracts it under
`%USERPROFILE%\.desktop-touch-mcp` and starts `dist/index.js`.

## Safety Rules

- Do not commit npm tokens, OTPs, recovery codes, or `.npmrc`.
- Keep release documentation in git. It should describe commands and flow only, not secrets.
- Publish GitHub Release assets before publishing the matching npm version.
- Never move an existing release tag. If a tag already exists, publish a new patch version.
- Prefer `npm deprecate` over `npm unpublish` for bad published versions.

## Version Checklist

Update both:

- `package.json` / `package-lock.json`
- `src/version.ts`

They should all match the release version, for example `0.11.4`.

Use:

```bash
npm version 0.11.4 --no-git-tag-version
```

`src/version.ts` and `bin/launcher.js` `PACKAGE_VERSION` are **automatically updated** by the `version` lifecycle hook
(`scripts/sync-version.mjs`). No manual edit needed.

`bin/launcher.js` `RELEASE_MANIFEST.tagName` / `sha256` are **not** auto-generated.
They must be updated for each release and are validated by `npm run check:launcher-manifest`.

To sync manually without bumping:

```bash
npm run sync-version
```

## Preflight

Run:

```bash
node --check bin/launcher.js
npm run check:launcher-manifest
npm run build
npm publish --dry-run
```

### HTTP Transport Verification (Required)

Before publishing, verify HTTP mode works correctly by running the built server locally:

```powershell
# Start HTTP server in background
$proc = Start-Process node -ArgumentList "dist/index.js --http --port 23847" -PassThru -WindowStyle Hidden
Start-Sleep 3

# Run all HTTP tests (6 checks: health, initialize, notification, tools/list, error handling, CORS)
pwsh -File scripts/test-http-mcp.ps1 -UseExisting

# Stop the server
Stop-Process -Id $proc.Id -Force
```

Expected: **ALL TESTS PASSED** (6/6).

If tests fail, do NOT proceed to `git tag` or `npm publish`.

Expected npm dry-run characteristics:

- package name: `@harusame64/desktop-touch-mcp`
- public access
- tarball contains only the lightweight npm package files:
  - `LICENSE`
  - `README.md`
  - `README.ja.md`
  - `bin/launcher.js`
  - `package.json`

The npm package should not install native runtime dependencies. Those belong in the GitHub Release zip.

## HTTP Connection Test (Optional)

Verify HTTP mode works correctly before release:

```powershell
# Build first
npm run build

# Run HTTP connection test
.\scripts\test-http-mcp.ps1
```

Expected output:

```text
[PASS] Server started (version: X.Y.Z, PID: XXXX)
[PASS] Health endpoint OK
[PASS] Initialize response OK
[PASS] initialized notification accepted
[PASS] Tools list retrieved: 56 tools
[PASS] Invalid method correctly rejected
[PASS] CORS headers present
=== ALL TESTS PASSED ===
```

If connecting to an already-running server:

```powershell
.\scripts\test-http-mcp.ps1 -UseExisting
```

## Commit And Push

Commit the release changes:

```bash
git add package.json package-lock.json src/version.ts .github/workflows/release.yml bin/launcher.js scripts/check-launcher-manifest.mjs README.md README.ja.md docs/release-process.md
git commit -m "Prepare release 0.11.4"
git push origin HEAD:main
```

If there are no changes in some listed files, `git add` simply ignores them.

## GitHub Release Zip

Check that the tag does not already exist:

```bash
git tag --list v0.11.4
git ls-remote --tags origin v0.11.4
```

Create and push the tag:

```bash
git tag v0.11.4
git push origin v0.11.4
```

This triggers `.github/workflows/release.yml`.

Confirm the release asset exists:

```bash
gh release view v0.11.4 --json tagName,assets,url
```

The release must include:

```text
desktop-touch-mcp-windows.zip
```

After the zip is available, compute SHA256 and update `bin/launcher.js` `RELEASE_MANIFEST.sha256`:

```powershell
$v = "0.11.4"
$url = "https://github.com/Harusame64/desktop-touch-mcp/releases/download/v$v/desktop-touch-mcp-windows.zip"
$out = "desktop-touch-mcp-windows-v$v.zip"
Invoke-WebRequest -Uri $url -OutFile $out
Get-FileHash -Algorithm SHA256 $out | Select-Object -ExpandProperty Hash
Remove-Item $out -Force
```

Then set:

- `RELEASE_MANIFEST.tagName = "v0.11.4"`
- `RELEASE_MANIFEST.sha256 = "<hash>"`

Re-run preflight:

```bash
npm run check:launcher-manifest
node --check bin/launcher.js
npm run build
npm publish --dry-run
```

If GitHub API rate limits interfere, open:

```text
https://github.com/Harusame64/desktop-touch-mcp/releases/tag/v0.11.4
```

and confirm the asset appears on the page.

## npm Publish

Make sure the CLI is logged in:

```bash
npm whoami
```

Expected:

```text
harusame64
```

Publish:

```bash
npm publish
```

The package has `publishConfig.access = "public"`, so `--access public` is not required.

If npm asks for 2FA, complete the browser or OTP authentication. Do not paste OTPs into logs or docs.

### 2FA / Browser Auth Notes

When publishing from an agent-run shell, npm may mask the browser auth URL as `***`.
If that happens, run `npm publish` in the visible PowerShell window instead. The terminal UI
shows the full `https://www.npmjs.com/auth/cli/...` URL and can complete the browser flow.

Useful checks:

- `npm whoami` only proves the account is logged in; `npm publish` can still require one-time auth.
- Wait for `+ @harusame64/desktop-touch-mcp@X.Y.Z` before assuming publish succeeded.
- After publish, verify `npm view @harusame64/desktop-touch-mcp version dist-tags.latest dependencies`.
- `dependencies` should not be printed for the npm launcher package.

Verify:

```bash
npm view @harusame64/desktop-touch-mcp version dist-tags.latest dependencies
```

Expected:

```text
version = '0.11.4'
dist-tags.latest = '0.11.4'
```

No `dependencies` should be printed for the npm package.

## Smoke Test

Use a clean npm cache and a clean launcher cache so the test proves first-run download works.

PowerShell setup:

```powershell
$root = (Resolve-Path .).Path
foreach ($name in "_smoke-run", "_smoke-npm-cache", "_smoke-npx-cache") {
  $p = Join-Path $root $name
  if (Test-Path -LiteralPath $p) {
    Remove-Item -LiteralPath $p -Recurse -Force
  }
}
$tmp = Join-Path $root "_smoke-run"
$cache = Join-Path $root "_smoke-npm-cache"
$mcpHome = Join-Path $root "_smoke-npx-cache"
New-Item -ItemType Directory -Path $tmp, $cache, $mcpHome -Force | Out-Null
Push-Location $tmp
npm --cache $cache init -y | Out-Null
Pop-Location
```

Run the controlled MCP initialize test:

```powershell
@'
const { spawn, execFileSync } = require("node:child_process");
const path = require("node:path");

const root = process.cwd();
const cache = path.join(root, "_smoke-npm-cache");
const home = path.join(root, "_smoke-npx-cache");
const cmd = `npx --cache ${cache} -y @harusame64/desktop-touch-mcp`;

const child = spawn("cmd.exe", ["/d", "/s", "/c", cmd], {
  cwd: path.join(root, "_smoke-run"),
  env: { ...process.env, DESKTOP_TOUCH_MCP_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let finished = false;

function killTree() {
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}

function done(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  killTree();
  console.log("DONE=" + code);
  console.log("STDERR_START");
  console.log(stderr.slice(0, 2000));
  console.log("STDERR_END");
  console.log("STDOUT_START");
  console.log(stdout.slice(0, 1200));
  console.log("STDOUT_END");
}

const timer = setTimeout(() => done("timeout"), 180000);
child.stderr.on("data", d => { stderr += d.toString(); });
child.stdout.on("data", d => {
  stdout += d.toString();
  if (stdout.includes('"id":1')) done("response");
});
child.on("error", e => done("error:" + e.message));
child.on("exit", code => done("exit:" + code));

const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  },
});

child.stdin.write(body + "\n");
child.stdin.end();
'@ | node -
```

Expected stderr:

```text
[desktop-touch-mcp] Downloading desktop-touch-mcp-windows.zip from vX.Y.Z
[desktop-touch-mcp] Installed vX.Y.Z ...
[desktop-touch] MCP server running (stdio)
```

Expected stdout includes:

```json
"serverInfo":{"name":"desktop-touch","version":"X.Y.Z"}
```

## npx Download & HTTP Smoke Test

After `npm publish`, verify that the full npx → GitHub Release → extract → launch pipeline works
and the HTTP transport responds correctly. This catches zip packaging bugs (missing node_modules,
wrong version, etc.) that the stdio smoke test above cannot detect.

```bash
# 1. Clear release cache for this version
rm -rf "$USERPROFILE/.desktop-touch-mcp/releases/vX.Y.Z"
npm cache clean --force

# 2. Download via npx and verify --help
npx -y @harusame64/desktop-touch-mcp@X.Y.Z --help
# Expected: "desktop-touch-mcp vX.Y.Z" and usage text

# 3. Verify installed files
RELEASE_DIR="$USERPROFILE/.desktop-touch-mcp/releases/vX.Y.Z"
cat "$RELEASE_DIR/dist/version.js"
# Expected: export const SERVER_VERSION = "X.Y.Z";

# Verify runtime dependencies are present
for pkg in "@modelcontextprotocol/sdk" "@nut-tree-fork/nut-js" "koffi" "sharp" "ws" "zod"; do
  test -d "$RELEASE_DIR/node_modules/$pkg" && echo "OK: $pkg" || echo "MISSING: $pkg"
done

# 4. Start HTTP server and test endpoints (run in separate PowerShell window)
cd "$RELEASE_DIR" && node dist/index.js --http

# From another terminal:
# Health check
curl -s http://127.0.0.1:23847/health
# Expected: {"status":"ok","name":"desktop-touch-mcp","version":"X.Y.Z"}

# MCP initialize
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST http://127.0.0.1:23847/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# Expected: HTTP_STATUS: 200, body contains "serverInfo":{"name":"desktop-touch","version":"X.Y.Z"}

# MCP tools/list
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST http://127.0.0.1:23847/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
# Expected: HTTP_STATUS: 200, 56 tools listed

# 5. Stop test server (from PowerShell)
# Get-NetTCPConnection -LocalPort 23847 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

**Important**: Run the HTTP server in a **separate PowerShell window**, not in the Claude terminal.
Killing node.exe from the Claude terminal may terminate the parent process.

## MCP Registry Publish

After `npm publish` and smoke test pass, publish to `registry.modelcontextprotocol.io`.

### Prerequisites

Download the `mcp-publisher` binary once (Go binary, not npm):

```powershell
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_amd64.tar.gz" -OutFile "mcp-publisher.tar.gz" -UseBasicParsing
tar xf mcp-publisher.tar.gz mcp-publisher.exe
Remove-Item mcp-publisher.tar.gz
.\mcp-publisher.exe --version
```

Binary can be kept in the project root (it is gitignored via `.gitignore` unless added explicitly).

### Update `server.json`

Before publishing, update the version numbers in `server.json`:

```json
{
  "version": "X.Y.Z",
  "packages": [{ "version": "X.Y.Z", ... }]
}
```

Key format rules (learned from v0.13.1):
- `"version"` must be at **top level** (not nested in `version_detail`)
- `"environmentVariables"` is **camelCase** (not `environment_variables`)
- Each env var needs: `name`, `description`, `isRequired`, `format`, `isSecret`
- `description` must be **≤ 100 characters**
- Package needs `"transport": { "type": "stdio" }`

### Validate

```powershell
.\mcp-publisher.exe validate
# Expected: ✅ server.json is valid
```

### Login (GitHub OAuth device flow — first time or token expired)

```powershell
.\mcp-publisher.exe login github
# Opens device flow: go to https://github.com/login/device and enter the code shown
```

If `publish` returns `401` with an expired Registry JWT, rerun the login command above.
When working through the visible PowerShell window, read the device URL and code from the
terminal output, authorize in the browser, and wait for:

```text
Successfully authenticated!
✓ Successfully logged in
```

### Publish

```powershell
.\mcp-publisher.exe publish
# Expected:
# ✓ Successfully published
# ✓ Server io.github.Harusame64/desktop-touch-mcp version X.Y.Z
```

Verify at: `https://registry.modelcontextprotocol.io/servers/io.github.Harusame64/desktop-touch-mcp`

## Operational Notes From v0.15.5

These are practical release traps observed during the first fixed-tag/SHA256 launcher release.

- `docs/release-process.md` is intentionally local-only and ignored by git in this checkout.
  Keep it useful locally, but do not rely on it being present in a fresh clone unless the ignore policy changes.
- `npm version X.Y.Z --no-git-tag-version` can update `package.json`, `package-lock.json`,
  `src/version.ts`, and `bin/launcher.js` even if the lifecycle `git add` fails with an index permission error.
  Check the file contents after a failed version command before retrying or editing.
- The SHA256 cannot be known until the GitHub Release zip exists. A safe flow is:
  version bump -> set `RELEASE_MANIFEST.tagName` for the new version and a placeholder SHA ->
  commit/tag/push -> wait for release asset -> compute SHA -> update `RELEASE_MANIFEST.sha256` ->
  rerun preflight -> commit/push -> publish npm.
- `npm run check:launcher-manifest` should fail while the SHA placeholder is present. That is expected and
  prevents accidental npm publish before the real release asset is pinned.
- The release tag may point at the pre-SHA commit, while `main` has a later commit that pins the generated
  release asset hash. This is acceptable because the GitHub Release zip must be built from the tagged runtime,
  while the npm launcher must be published from the later commit containing the hash.
- `gh` may be unusable if its stored token is expired, and unauthenticated GitHub API calls can hit rate limits.
  In that case, use CDP/browser on the GitHub Actions or Release pages plus the direct asset URL:
  `https://github.com/Harusame64/desktop-touch-mcp/releases/download/vX.Y.Z/desktop-touch-mcp-windows.zip`.
- A direct asset URL can return `404` while the workflow is still running or before upload completes.
  Re-check the Actions page or Release page. Seeing `Assets 3` on the Release page is a useful hint, but
  GitHub can lazy-load asset names; direct download remains the final proof.
- Always run a clean-cache npx smoke test after npm publish. The important proof is that the public npm
  launcher downloads `vX.Y.Z`, verifies the SHA, extracts the zip, and prints `desktop-touch-mcp vX.Y.Z`.

---

## Deprecating Bad Versions

If a bad npm version was published, keep `latest` on the corrected version and deprecate the bad one:

```bash
npm deprecate @harusame64/desktop-touch-mcp@0.11.2 "Broken npx launcher packaging. Use 0.11.4 or later."
npm deprecate @harusame64/desktop-touch-mcp@0.11.3 "Superseded by 0.11.4 with corrected server version metadata."
```

Verify:

```bash
npm view @harusame64/desktop-touch-mcp@0.11.2 deprecated version
npm view @harusame64/desktop-touch-mcp@0.11.3 deprecated version
npm view @harusame64/desktop-touch-mcp@0.11.4 deprecated version
```

## Cleanup

Remove smoke-test directories:

```powershell
$root = (Resolve-Path .).Path
foreach ($name in "_smoke-run", "_smoke-npm-cache", "_smoke-npx-cache") {
  $p = Join-Path $root $name
  if (Test-Path -LiteralPath $p) {
    Remove-Item -LiteralPath $p -Recurse -Force
  }
}
```

---

## Release Phase Checklist (Opus-reviewed)

This checklist summarises the execution order reviewed by Opus for the hybrid distribution model.
Use it as a quick reference when running a release. The full details are in the sections above.

### Why this order is mandatory

The npm launcher downloads the runtime zip from GitHub Releases.
Publishing npm **before** the zip exists causes a 404 on first `npx` run.
The SHA256 of the zip is unknown until GitHub Actions finishes building it,
which means there is always a second commit after the tag that pins the hash.

```
tag → zip generated by GH Actions → SHA256 computed → launcher updated (commit 2) → npm publish
```

### Phase 1 — Version bump + build

- `npm version X.Y.Z --no-git-tag-version` (auto-updates package.json, package-lock.json, src/version.ts, bin/launcher.js PACKAGE_VERSION)
- Set `RELEASE_MANIFEST.tagName = "vX.Y.Z"` in `bin/launcher.js`
- Set `RELEASE_MANIFEST.sha256 = "PENDING"` (placeholder — check:launcher-manifest will fail, that is expected)
- `node --check bin/launcher.js`
- `npm run build`

**Done when**: build passes; `package.json`, `src/version.ts`, and `bin/launcher.js` tagName all show the new version.

### Phase 2 — HTTP transport verification

- Start server: `$proc = Start-Process node -ArgumentList "dist/index.js --http --port 23847" -PassThru -WindowStyle Hidden; Start-Sleep 3`
- Run tests: `pwsh -File scripts/test-http-mcp.ps1 -UseExisting`
- Stop: `Stop-Process -Id $proc.Id -Force`

**Done when**: **ALL TESTS PASSED (6/6)**. Do not proceed if any test fails.

### Phase 3 — Commit, tag, push

- Stage: `git add package.json package-lock.json src/version.ts bin/launcher.js`
- Commit: `git commit -m "Prepare release X.Y.Z"`
- Push: `git push origin HEAD:main`
- Verify no existing tag: `git tag --list vX.Y.Z` and `git ls-remote --tags origin vX.Y.Z`
- Create tag: `git tag vX.Y.Z && git push origin vX.Y.Z`

**Done when**: tag exists on origin; GitHub Actions release.yml starts running.

### Phase 4 — Wait for GH Release zip + compute SHA256

- Wait for Actions to finish (~2–5 min)
- Confirm: `gh release view vX.Y.Z --json tagName,assets,url` shows `desktop-touch-mcp-windows.zip`
- Download and hash:
  ```powershell
  $v = "X.Y.Z"
  $url = "https://github.com/Harusame64/desktop-touch-mcp/releases/download/v$v/desktop-touch-mcp-windows.zip"
  $out = "desktop-touch-mcp-windows-v$v.zip"
  Invoke-WebRequest -Uri $url -OutFile $out
  Get-FileHash -Algorithm SHA256 $out | Select-Object -ExpandProperty Hash
  Remove-Item $out -Force
  ```

**Done when**: 64-character hex SHA256 is in hand. Do not proceed without it.

### Phase 5 — Pin SHA256 + final preflight

- Update `RELEASE_MANIFEST.sha256` in `bin/launcher.js` with the real hash
- `npm run check:launcher-manifest` (must pass now)
- `node --check bin/launcher.js`
- `npm run build`
- `npm publish --dry-run`
- Stage and commit: `git add bin/launcher.js && git commit -m "chore: update SHA256 for vX.Y.Z release asset" && git push origin HEAD:main`

**Done when**: `check:launcher-manifest` passes and dry-run succeeds.

### Phase 6 — npm publish

- `npm whoami` → expect `harusame64`
- `npm publish`
- Complete 2FA browser auth
- Verify: `npm view @harusame64/desktop-touch-mcp version dist-tags.latest`

**Done when**: version shows X.Y.Z on npm registry.

### Phase 7 — Smoke test + MCP Registry

- Clear caches and run npx smoke test (see "Smoke Test" and "npx Download & HTTP Smoke Test" sections above)
- Update `server.json` version to X.Y.Z
- `.\mcp-publisher.exe publish`

**Done when**: MCP Registry shows the new version and npx clean-install downloads + starts the server correctly.
