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

### Publish

```powershell
.\mcp-publisher.exe publish
# Expected:
# ✓ Successfully published
# ✓ Server io.github.Harusame64/desktop-touch-mcp version X.Y.Z
```

Verify at: `https://registry.modelcontextprotocol.io/servers/io.github.Harusame64/desktop-touch-mcp`

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
