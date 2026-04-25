# Phase 4b dogfood 手順書 — artifact 配置 / 実測 / main merge

- 対象 user: 本プロジェクト owner (Windows 11 + RX 9070 XT 前提)
- 前提 commits: `c4a9a7f`〜`876a554` (Phase 4b 全完了済)
- 想定所要時間: **最短 1.5-2 時間** (artifact ダウンロード 30 分 + ビルド 20 分 + 実測 30 分 + PR 30 分)
- 推奨実施タイミング: 集中作業時間が取れる時 (通信帯域と GPU が余裕あるとき)

---

## 0. 事前確認

### 0.1 環境チェック

```powershell
# Node.js v20+ 確認
node --version

# Rust toolchain 確認 (1.75+ 推奨)
rustc --version

# DirectX 12 対応 GPU 確認
dxdiag /t $env:TEMP\dxdiag.txt; Get-Content $env:TEMP\dxdiag.txt | Select-String "Card name|Feature Level"

# AMD Adrenalin Driver version (RX 9070 XT サポート 25.10.x 以降)
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion
```

期待される出力:
- Node.js: `v20.x` 以上
- Rust: `1.75` 以上
- GPU: `AMD Radeon RX 9070 XT`、Feature Level 12_2
- AMD Driver: `25.x` 以上

### 0.2 ディスク容量

artifact は合計 ~3GB:
- Florence-2-base (4 ONNX): ~700MB
- OmniParser-v2 icon_detect: ~32MB
- PaddleOCR-v4-server: ~95MB
- PaddleOCR-v4-mobile: ~11MB
- ONNX Runtime DLL: ~30MB
- DirectML.dll: ~10MB
- 余裕含めて **5GB 以上空き** を確保

```powershell
Get-PSDrive C | Select-Object Free
```

---

## 1. ネイティブ binding ビルド

```powershell
cd D:\git\desktop-touch-mcp-fukuwaraiv2
git checkout desktop-touch-mcp-fukuwaraiv2
git pull origin desktop-touch-mcp-fukuwaraiv2

# Rust 側 (vision-gpu feature 有効、DirectML EP 込み)
npm run build:rs

# TypeScript ビルド
npm run build
```

**確認**:
```powershell
# napi binding (.node ファイル) が生成されたか
Get-ChildItem desktop-touch-engine.*.node
# → desktop-touch-engine.win32-x64-msvc.node が出ていれば OK

# dist/ が出力されたか
Get-ChildItem dist\engine\vision-gpu\bench-runner.js
# → ファイルが存在すれば OK
```

エラーが出る場合:
- `cargo` が無い → `rustup default stable`
- `napi` が無い → `npm ci` で再インストール
- `link.exe` が無い → Visual Studio Build Tools (C++ workload) インストール要

---

## 2. ONNX Runtime + DirectML 配置

```powershell
$runtime = "$env:USERPROFILE\.desktop-touch-mcp\runtime"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

# ONNX Runtime 1.20.x DirectML build をダウンロード
$ortVersion = "1.20.1"
$ortUrl = "https://github.com/microsoft/onnxruntime/releases/download/v$ortVersion/Microsoft.ML.OnnxRuntime.DirectML.$ortVersion.zip"
$ortZip = "$env:TEMP\ort-dml.zip"
Invoke-WebRequest -Uri $ortUrl -OutFile $ortZip

# 展開して DLL を runtime/ にコピー
$ortExtract = "$env:TEMP\ort-dml"
Expand-Archive -Path $ortZip -DestinationPath $ortExtract -Force
Copy-Item "$ortExtract\runtimes\win-x64\native\onnxruntime.dll" $runtime
Copy-Item "$ortExtract\runtimes\win-x64\native\DirectML.dll" $runtime

# 配置確認
Get-ChildItem $runtime
# → onnxruntime.dll と DirectML.dll が並んでいれば OK

# 環境変数を永続化 (現セッションのみ — 再起動後も使うなら setx)
$env:ORT_DYLIB_PATH = "$runtime\onnxruntime.dll"
# 永続化する場合 (新しいシェルから有効):
# setx ORT_DYLIB_PATH "$runtime\onnxruntime.dll"
```

**注意**: `setx` で永続化すると新規プロセスから有効。現セッションは `$env:ORT_DYLIB_PATH = "..."` も併用。

---

## 3. Model artifact 配置

### 3.1 Florence-2-base (Stage 1、~700MB、4 ONNX + tokenizer.json)

```powershell
$flo = "$env:USERPROFILE\.desktop-touch-mcp\models\florence-2-base"
New-Item -ItemType Directory -Force -Path $flo | Out-Null

$base = "https://huggingface.co/microsoft/Florence-2-base/resolve/main/onnx"
$files = @(
  "vision_encoder.onnx",
  "embed_tokens.onnx",
  "encoder_model.onnx",
  "decoder_model_merged.onnx"
)
foreach ($f in $files) {
  Write-Host "Downloading $f..."
  Invoke-WebRequest -Uri "$base/$f" -OutFile "$flo\$f"
}

# tokenizer.json (root レベル)
Invoke-WebRequest `
  -Uri "https://huggingface.co/microsoft/Florence-2-base/resolve/main/tokenizer.json" `
  -OutFile "$flo\tokenizer.json"

# 確認
Get-ChildItem $flo | Format-Table Name, Length
# → 5 ファイル、合計 ~700MB (decoder_model_merged が最大、~470MB)
```

**注意**: HF Hub は時々 rate limit がかかる。403 が出たら少し待って再試行 (5-10 分)。

### 3.2 OmniParser-v2 icon_detect (Stage 2、~32MB)

```powershell
$omni = "$env:USERPROFILE\.desktop-touch-mcp\models\omniparser-v2-icon-detect"
New-Item -ItemType Directory -Force -Path $omni | Out-Null

# OmniParser-v2 icon_detect は YOLO11 ONNX
# Microsoft 公式 HF: microsoft/OmniParser-v2.0
Invoke-WebRequest `
  -Uri "https://huggingface.co/microsoft/OmniParser-v2.0/resolve/main/icon_detect/model.onnx" `
  -OutFile "$omni\dml-fp16.onnx"

Get-ChildItem $omni
```

**注意**: variant 名 `dml-fp16.onnx` は assets/models.json と合わせて命名。
実際の HF artifact が fp16 でない可能性があるが、推論は動作する。後で variant 切替時にリネーム可。

### 3.3 PaddleOCR-v4-server (Stage 3、~95MB + dict)

```powershell
$paddle = "$env:USERPROFILE\.desktop-touch-mcp\models\paddleocr-v4-server"
New-Item -ItemType Directory -Force -Path $paddle | Out-Null

# PaddleOCR-v4 server recognition ONNX (PaddlePaddle 公式)
# 注: PaddlePaddle 公式は .pdmodel/.pdiparams なので、ONNX は変換版を使う
# 推奨ソース: rapidocr_onnxruntime のリリース or PaddleOCR ONNX 変換 community asset

# 一例: rapidocr_onnxruntime v1.4.x のリリース asset から取得
# (URL は時期によって異なるので HF Hub or GitHub Release から確認)
$paddleUrl = "https://huggingface.co/rapidocr-onnxruntime/PP-OCRv4_rec_server/resolve/main/model.onnx"
Invoke-WebRequest -Uri $paddleUrl -OutFile "$paddle\dml-fp16.onnx"

# Dict (multilingual、~6625 chars)
Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt" `
  -OutFile "$paddle\paddleocr_keys.txt"

Get-ChildItem $paddle
```

### 3.4 PaddleOCR-v4-mobile (Stage 3 secondary、cross-check 用、~11MB + dict)

```powershell
$paddleM = "$env:USERPROFILE\.desktop-touch-mcp\models\paddleocr-v4-mobile"
New-Item -ItemType Directory -Force -Path $paddleM | Out-Null

# Mobile 版は server より軽量、cross-check で並列実行する
$paddleMobileUrl = "https://huggingface.co/rapidocr-onnxruntime/PP-OCRv4_rec_mobile/resolve/main/model.onnx"
Invoke-WebRequest -Uri $paddleMobileUrl -OutFile "$paddleM\dml-fp16.onnx"

# Dict は server と同じものを再利用
Copy-Item "$paddle\paddleocr_keys.txt" "$paddleM\paddleocr_keys.txt"

Get-ChildItem $paddleM
```

### 3.5 配置全体確認

```powershell
$models = "$env:USERPROFILE\.desktop-touch-mcp\models"
Get-ChildItem $models -Recurse -File | Group-Object Directory | ForEach-Object {
  $folder = Split-Path $_.Name -Leaf
  $totalMb = ($_.Group | Measure-Object Length -Sum).Sum / 1MB
  Write-Host ("{0,-40} {1,5} files, {2,7:N1} MB" -f $folder, $_.Count, $totalMb)
}
```

期待される出力:
```
florence-2-base                            5 files,  ~700.0 MB
omniparser-v2-icon-detect                  1 files,   ~32.0 MB
paddleocr-v4-server                        2 files,   ~95.5 MB
paddleocr-v4-mobile                        2 files,   ~11.5 MB
```

---

## 4. Smoke test (artifact 認識確認)

### 4.1 capability profile 確認

```powershell
node -e "import('./dist/engine/native-engine.js').then(m => console.log(JSON.stringify(m.nativeVision?.detectCapability?.(), null, 2)))"
```

期待される出力:
```json
{
  "os": "windows",
  "osBuild": 26100,
  "gpuVendor": "AMD",
  "gpuDevice": "Radeon RX 9070 XT",
  "gpuArch": "RDNA4",
  "gpuVramMb": 16384,
  "winml": true,
  "directml": true,
  "rocm": false,
  "cuda": false,
  ...
}
```

`gpuVendor` が `AMD`、`directml` が `true` であれば OK。

### 4.2 OnnxBackend 起動確認

```powershell
$env:DESKTOP_TOUCH_ENABLE_ONNX_BACKEND = "1"
$env:ORT_DYLIB_PATH = "$env:USERPROFILE\.desktop-touch-mcp\runtime\onnxruntime.dll"

node -e @'
import('./dist/engine/vision-gpu/onnx-backend.js').then(async (m) => {
  const b = new m.OnnxBackend();
  const state = await b.ensureWarm({ kind: 'chrome', id: 'smoke' });
  console.log('warm state:', state);
  await b.dispose();
});
'@
```

期待される出力:
- `warm state: warm` → 全 stage の session 初期化成功
- `warm state: evicted` → artifact 不在 or DLL load 失敗、ログ確認

evicted の場合の確認手順:
1. `Test-Path $env:USERPROFILE\.desktop-touch-mcp\models\florence-2-base\vision_encoder.onnx` で各 ONNX の存在確認
2. `Test-Path $env:ORT_DYLIB_PATH` で DLL 存在確認
3. `node --inspect` で stderr に `[onnx-backend] session init failed for ...` のメッセージを探す

---

## 5. Benchmark 実測

### 5.1 RX 9070 XT で warm p99 測定

```powershell
$env:DESKTOP_TOUCH_ENABLE_ONNX_BACKEND = "1"

# Cross-check 無効 (まずは server 単体)
node scripts/run-bench.mjs --target=chrome --frames=20 --output bench-rx9070xt.json
```

期待される出力:
```
[bench] target=chrome frames=20 1920x1080
[bench] wrote bench-rx9070xt.json
[bench] runId=...
[bench] capability=AMD RDNA4
[bench] metrics=22
[bench] warm p99 = 18.5ms (target ≤ 30ms)
```

**L1 達成判定**:
- `warm p99 ≤ 30ms` → ✅ 達成、ADR-005 §2 L1 目標クリア
- `warm p99 > 30ms` → ⚠️ 要 profiling、Stage 別 latency 内訳が必要 (`bench.json` の `notes` を確認)

### 5.2 Cross-check 有効版

```powershell
$env:DESKTOP_TOUCH_VISUAL_CROSS_CHECK = "1"
node scripts/run-bench.mjs --target=chrome --frames=20 --output bench-rx9070xt-crosscheck.json
$env:DESKTOP_TOUCH_VISUAL_CROSS_CHECK = $null
```

cross-check 有効時は server + mobile 並列実行 → warm p99 がやや増える想定 (許容範囲: +5-10ms)。

### 5.3 CPU only ベースライン

```powershell
$env:DESKTOP_TOUCH_DISABLE_VISUAL_GPU = "1"
node scripts/run-bench.mjs --target=chrome --frames=20 --output bench-cpu.json
$env:DESKTOP_TOUCH_DISABLE_VISUAL_GPU = $null
```

CPU only は warm p99 が 100-300ms 程度になる想定 (Florence-2 が encoder-decoder なので CPU では遅い)。
これは L1 を満たさないが、L6 (vendor portability) の baseline として記録する価値あり。

### 5.4 Vendor matrix report 生成

```powershell
node scripts/generate-bench-report.mjs `
  --input bench-rx9070xt.json bench-rx9070xt-crosscheck.json bench-cpu.json `
  --output BENCH.md

# 確認
Get-Content BENCH.md
```

期待される出力例:
```markdown
# Visual GPU Phase 4 — Vendor Matrix

**ADR-005 L1 target**: warm p99 ≤ 30ms (RX 9070 XT dogfood baseline).
...

| Vendor | warm p99 | cold | samples | notes |
|---|---:|---:|---:|---|
| AMD Radeon RX 9070 XT (RDNA4) | 18.5 ms | 240.3 ms | 20 | — |
| AMD Radeon RX 9070 XT (RDNA4) | 24.7 ms | 245.1 ms | 20 | (cross-check) |
| Unknown (bench-cpu.json) | 187.4 ms | 1240.8 ms | 20 | — |
```

---

## 6. main merge

### 6.1 ローカル main 同期

```powershell
git fetch origin
git checkout main
git pull origin main

# 戻る
git checkout desktop-touch-mcp-fukuwaraiv2
```

### 6.2 BENCH.md を commit (任意、L6 portability の発信材料)

```powershell
# 上記 §5 で BENCH.md が生成された場合のみ
git add BENCH.md
git commit -m "docs: Phase 4b vendor matrix bench results (RX 9070 XT)"
git push origin desktop-touch-mcp-fukuwaraiv2
```

### 6.3 PR 作成

```powershell
# GitHub CLI を使用
gh pr create --base main --head desktop-touch-mcp-fukuwaraiv2 --title "Phase 4b: Visual GPU pipeline (Florence-2 + OmniParser + PaddleOCR + Cross-check + Bench)" --body @'
## Summary

ADR-005 Phase 4b 全 batch (4b-1〜4b-8、4b-2 ADR-006 移管除く) 完了。

- Florence-2 Stage 1 (region proposer): preprocess + BART tokenizer + encoder + KV cache decoder + autoregressive loop + `<loc_X>` parse
- OmniParser-v2 Stage 2 (UI element detector): single-pass YOLO + NMS
- PaddleOCR-v4 Stage 3 (text recognition): dynamic-width preprocess + CTC greedy decode + dict
- Cross-check (multi-engine voting) + win-ocr.exe Tier ∞ (sharp crop + stdin)
- BenchmarkRunner + vendor matrix aggregator (`scripts/run-bench.mjs` + `scripts/generate-bench-report.mjs`)
- vitest zombie 対策 (pool=forks + cleanup)

## Test plan

- [x] cargo check 3 features set 全 exit 0
- [x] tsc --noEmit 0
- [x] vitest unit 100+ files / 2000+ tests / regression 0
- [x] dogfood: RX 9070 XT で warm p99 = X ms (target ≤ 30ms)
- [x] dogfood: BENCH.md vendor matrix 生成

## ADR-005 Done criteria

- L1 (warm p99 ≤ 30ms RX 9070 XT): see BENCH.md
- L5 (process isolation): catch_unwind + Tier ∞ multi-layer 達成
- L6 (vendor portability): WebGPU + cascade で構造的達成

🤖 Generated with [Claude Code](https://claude.com/claude-code)
'@
```

### 6.4 PR レビュー後 merge

PR の CI チェックが通ったら main に merge:
```powershell
gh pr merge --squash --delete-branch
```

---

## 7. main merge 後の cleanup

```powershell
git checkout main
git pull origin main

# 古いブランチを削除
git branch -d desktop-touch-mcp-fukuwaraiv2 2>$null

# memory 状態を更新
# C:\Users\harus\.claude\projects\D--git-desktop-touch-mcp-fukuwaraiv2\memory\project_adr005_phase4_status.md
# の Status を「Phase 4b 全完了 + main merge 済」に書き換える (Claude に依頼可)
```

---

## 8. トラブルシューティング

### 8.1 `npm run build:rs` が link.exe で失敗

```
error: linking with `link.exe` failed: exit code 1181
```

→ Visual Studio Build Tools の C++ workload が不足。
解決: VS Installer から「Desktop development with C++」をインストール

### 8.2 `ensureWarm` が常に `evicted` 返す

確認手順:
1. `Test-Path $env:ORT_DYLIB_PATH` → True か
2. `Test-Path "$env:USERPROFILE\.desktop-touch-mcp\models\florence-2-base\vision_encoder.onnx"` → True か
3. ファイル size 確認 (各 ONNX が数百 MB あるか、part だけだと load 失敗)
4. `dxdiag` で DirectX 12 対応確認

### 8.3 Florence-2 token decode で空 string

→ tokenizer.json と ONNX のバージョン不一致の可能性。
HF microsoft/Florence-2-base の **同じ commit** から両方ダウンロード。

### 8.4 PaddleOCR で dict mismatch warning

```
[paddleocr] dict num_classes (6624) != model output dim (6625)
```

→ dict の version が合っていない。`ppocr_keys_v1.txt` か `ppocr_keys_v2.txt` か確認。
PP-OCRv4 は v1 を使う想定だが、export 元によっては v2 のことも。

### 8.5 win-ocr.exe Tier ∞ が無効

```
[onnx-backend] winOcrTierInfinity failed: ENOENT
```

→ `bin/win-ocr.exe` が repo に同梱されているはずだが、git LFS or .gitignore で抜けていれば
`git lfs pull` or 既存 main の bin/ をコピー。

---

## 9. 完了確認チェックリスト

- [ ] §1 ネイティブビルド完了
- [ ] §2 ORT runtime DLL 配置 + ORT_DYLIB_PATH 設定
- [ ] §3.1 Florence-2-base 5 ファイル配置
- [ ] §3.2 OmniParser-v2 1 ファイル配置
- [ ] §3.3 PaddleOCR-v4-server 2 ファイル配置
- [ ] §3.4 PaddleOCR-v4-mobile 2 ファイル配置 (cross-check 用、任意)
- [ ] §4.1 capability profile が AMD RDNA4 で出力
- [ ] §4.2 ensureWarm が "warm" 返す
- [ ] §5.1 RX 9070 XT で warm p99 ≤ 30ms 達成
- [ ] §5.4 BENCH.md 生成
- [ ] §6 PR 作成 + merge

---

END OF RUNBOOK.
