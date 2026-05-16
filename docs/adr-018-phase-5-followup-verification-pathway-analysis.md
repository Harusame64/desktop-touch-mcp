# ADR-018 Phase 5+N+1 — Verification pathway analysis (north-star re-evaluation)

- Status: **Analysis / draft (pre-PR)** — re-evaluates the path-A/B/C decision from a system-wide detection-capability lens
- Date: 2026-05-16
- Parent: `docs/adr-018-input-pipeline-3tier.md` §2.6 / `docs/adr-018-phase-5-followup-leaf-walker-subplan.md` §2.1 reverted-note
- Authors: Claude (Sonnet drafting, Opus initial judgment B → user pushback → re-evaluation under north star)
- Trigger: 2026-05-16 user prompt — "北極星を基準として EXCEL のスクロール対応のピンポイントでは無く、将来的な全体の検出能力の底上げという前提とした場合にその選択がただしいの？"

---

## 1. Why this document exists

PR #308 closed with a chain-trust assertion and a documented Codex P1 trade-off (boundary case → false-positive `delivered`). A follow-up "robust verification" effort was scoped against 3 candidate paths (A: UIA + phase correlation / B: existing MAE port / C: pHash 32×32). Opus recommended **B** on the grounds of "reuse existing helpers, low cost, ~100-150 lines, no new Rust dep."

The user pushed back: **the question wasn't "smallest delta" — it was "what raises overall system detection capability across the MCP surface."** This document re-evaluates A/B/C against that broader north star.

---

## 2. North star (re-statement)

ADR-018 §1.3 frames the underlying problem as:

> Without this fix, every user with a stay-resident accessibility / display-management tool (Dell DDPM, Logitech Options+, NVIDIA Game Filter, MS PowerToys FancyZones, AutoHotKey scripts, RDP shadow sessions) sees scroll silently degrade to a no-op. This is the most-used class of tool in the MCP surface and the silent-failure mode is unrecoverable from the LLM side — `ok:true` masks a 0-px scroll.

Restated as design invariants:

1. **Destination-explicit IO** — HWND on the wire end-to-end, no cursor-pixel routing.
2. **Honest observation per tier** — observation must NEVER silently degrade into a false-positive `delivered`. The LLM side must be able to act on the reported delivery status.
3. **Generality across custom-paint apps** — Excel cell grid is one instance of a class: Word `_WwG`, PowerPoint slide canvas, OneNote canvas, Photoshop/Blender custom controls, GPU-rendered games, RDP shadow surfaces. The solution must scale to that class, not bolt one-off heuristics per app.
4. **System-wide, not just scroll** — the same observation primitive should ideally serve click verification (`mouse_click.verifyDelivery`), keyboard input verification (`keyboard` BG `BackgroundInputNotDelivered`), and `desktop_act` post-state — wherever the MCP layer needs to confirm "did the user-visible state change."

Path B's strongest argument ("re-use existing helpers") is a code-organisation virtue. It is **silent on whether the resulting capability lifts the north star vs. encoding a one-off Excel scroll patch.** The pushback is that we picked the path with the lowest LOC, not the path that builds the right shared primitive for the next 12 months of verification work.

---

## 3. Capability surface — what each path produces

| Path | Primitive produced | Output shape | Re-usable for | Re-usable for | Re-usable for |
|---|---|---|---|---|---|
| | | | scroll | click verify | keyboard verify |
| **A** | (a) UIA `ScrollPattern.VerticalScrollPercent` pre/post; (b) phase correlation `(dx, dy)` shift vector | structured: numeric percent OR a 2D shift in pixels | ✓ canonical | ✓ click → focus shift → repaint detected as small (dx,dy) | ✓ keyboard type → text repaints in field → repaint detected |
| **B** | (a) `computeChangeFraction` (boolean over 1% threshold); (b) `findNewRows`/`findNewColumns` MAE search returning row-count | unstructured: "did it change a lot" + scroll-row count | ✓ for scroll-overlap (its design target) | △ "did anything change" but no localisation | △ same — no localisation |
| **C** | pHash 32×32 Hamming distance | unstructured: bits-different scalar | ✓ generic delta detector | ✓ same | ✓ same |

**Phase correlation in A returns a *vector*.** That's a structured signal that other tiers can consume: did the page move down by 50 px? was there only a 1 px drift (anti-aliasing)? did the focus rectangle move sideways (focus shift)? `computeChangeFraction` returns "did >1% of blocks change." That answers a yes/no, not a "what changed how."

**UIA `ScrollPattern.VerticalScrollPercent` is the canonical accessibility API observation.** When the app exposes it, it gives an exact numeric percent — by definition the most reliable observation channel. ADR-018 Tier 1 already uses it for *dispatch*; using it symmetrically for *observation* is the natural design (and was originally listed as the Tier 1 observation in ADR-018 §2.2).

---

## 4. Empirical risk re-check on path B

Opus's path-B recommendation rested on this claim:

> 0.36% raw-byte change on a 1422400-byte buffer ≈ 5120 changed bytes ≈ thousands of changed blocks — orders of magnitude above the existing 2-5% block-fraction thresholds.

This is true only **if the 5120 byte changes are distributed across many 8×8 blocks**. The empirical data was:

```
pre[0:60]  = 525252ff 525252ff 525252ff … (dark-gray row-label strip)
post[0:60] = 525252ff 525252ff 525252ff …
byte diff: 5120 / 1422400 ( 0.36 %)
```

A 1422400-byte buffer at 4 channels × 889 width × 400 height = 4 × 8 × 8 = 256 bytes per 8×8 block. That gives 1422400 / 256 ≈ **5556 blocks**. If the 5120 byte changes are concentrated (e.g., in the thin row-number column on the left edge, ~30 px wide × 400 tall × 4 channels = ~48000 bytes total — even all-pixels-changed there is at most 48000 bytes), they'd live in roughly 30/889 ≈ 3.4% of blocks horizontally × 100% vertically = ~190 affected blocks.

- 5120 changed bytes across 190 blocks ≈ 27 bytes per block average — **above** `NOISE_THRESHOLD=16` per block, so those blocks WOULD register.
- Path B might work. **But Opus's calculation didn't account for spatial concentration**, and the threshold (NOISE_THRESHOLD=16 *per channel*) interacts with the 4-channel layout in a way that needs verification.

The honest answer is: **B might work empirically — but it hasn't been verified, and its detection ceiling is "did something move", not "what moved by how much."**

Path A's UIA pre-snapshot is empirically known to be exact when the pattern is exposed. Path A's phase correlation gives sub-pixel `(dx, dy)` regardless of content. **Neither requires the empirical verification step B does.**

---

## 5. Cost re-evaluation (LOC ≠ value)

| Path | LOC | New crate | Days | Capability ceiling |
|---|---|---|---|---|
| A | ~200-300 (Rust + TS) | `rustfft` | 3-5 | (dx,dy) vector + UIA percent — structured, generalises |
| B | ~100-150 (TS) | none | 1 | "did >1% change" + scroll row count — unstructured |
| C | ~50 (Rust + TS) | `image_hasher` | 1 | "did pHash diff exceed bits-threshold" — unstructured |

Opus weighted **LOC × time** heavily; the user's frame is **capability × longevity**. A's 200 lines build a primitive that the rest of the MCP can lean on for the next 12 months. B's 100 lines is glue specific to one PostMessage path.

ADR-018 itself (§1.3) is a single ADR that spent ~6 weeks of trunk land + 7 sub-plan PRs. The cost of one more ~5-day PR to install a foundational primitive is small relative to the system-wide debt it pays down.

---

## 6. Re-evaluation against decision criteria

| Criterion | A (UIA + phase correlation) | B (MAE port) | C (pHash 32×32) |
|---|---|---|---|
| Empirical Excel robustness | UIA path: exact when exposed; phase correlation: sub-pixel shift regardless | Block-SAD: spatial-concentration-dependent (unverified) | Aliases on periodic grid (per Hacker Factor / pHash discussions) |
| Generalisation to Word `_WwG` / PowerPoint / OneNote / RDP / games | ✓ phase correlation is content-agnostic | △ scroll-row MAE is scroll-specific | △ same hash, same alias risk per app |
| Re-use as click / keyboard verify primitive | ✓ phase correlation gives (dx,dy) shift for any visual state change | △ "did it change >1%" — useful but coarse | △ "did pHash differ" — coarse |
| Engineering cost | high (200-300 lines, new dep, 3-5 days) | low (100-150 lines, no dep, 1 day) | very low (50 lines, new dep, 1 day) |
| Maintenance burden | rustfft is stable, pure-Rust SIMD | none (existing helpers) | image_hasher is maintained but external |
| Risk: false positive on caret blink / Excel marching-ants | phase correlation: peak amplitude < threshold filters these out | block-SAD: HIGH (every block-change counts) | pHash: HIGH (any bit-flip counts) |
| Risk: false negative on Excel | UIA: zero if exposed; phase correlation: very low (frequency-domain shift detect) | spatial-concentration-dependent (unverified) | structural alias on periodic grid |
| PR scope discipline | one PR feasible (helper + tests + docs) | one PR feasible (smaller) | one PR feasible (smallest) |
| Aligned with ADR-018 north star (§1.3, §2.2, §2.3) | ✓ destination-explicit, honest, generalises | △ honest (boundary still wrong), partial generalisation | △ same |

---

## 7. Verdict under the north-star lens

**Path A is correct when the goal is system-wide detection-capability lift.** Path B is correct when the goal is "fix Excel scroll observation with minimum delta." The user's framing is the former — therefore A.

Concretely:

1. **UIA pre/post `ScrollPattern.VerticalScrollPercent`** lifts the Tier 1 observation surface — symmetric with the Tier 1 dispatch path that already exists. When Excel/Word/PowerPoint expose the pattern, the dispatcher gets an exact percent.
2. **Phase correlation (FFT via `rustfft`)** lifts the Tier 3+4 fallback observation surface — content-agnostic, gives a structured (dx,dy) shift vector. The same primitive serves:
   - Tier 3 `PostMessage` chain-trust verification (the immediate use case)
   - Future `mouse_click.verifyDelivery` "did the click cause a visible focus/repaint shift" — a known gap in the current heuristic
   - Future `keyboard` BG verification when UIA TextPattern read-back is unavailable
   - Future `desktop_act` post-state verification

Path B remains valuable as a **fall-back tier** when neither UIA nor phase correlation produce a confident signal (e.g., capture failure, FFT cost prohibitive on a hot path). But it is not the primary primitive — it's the existing 8×8 block-SAD already in the codebase.

Path C is **superseded**: pHash 32×32's structural alias on periodic grids is the same failure mode that motivated this work. The "smallest delta" virtue isn't enough to justify replacing the existing dHash without solving the periodic-grid problem.

---

## 8. Round 2 — User review findings (2026-05-16)

The Round 1 verdict (Path A as a pair of "UIA pre/post + phase correlation") was reviewed and pushed back on. Verbatim findings:

- **P1 — phase correlation 過信** — "Excel のような周期格子、低テクスチャ、行ヘッダだけ変わるケースではピークが曖昧になり得ます。`peak amplitude > 0.05` だけでなく、`peak / secondPeak`、軸方向の符号、タイルごとの一致率、低テクスチャ判定を入れる前提にした方が安全です。"
- **P1 — click / keyboard verification への一般化が広すぎる** — "スクロールの『平行移動検知』と、クリック/入力の『局所 repaint 検知』を同じ primitive で扱っています。クリックや文字入力は全体 shift が 0 のことが多いので、phase correlation は主役ではなく `motion vector + dirty/residual map` の一要素にした方がよいです。"
- **P2 — multi-frame temporal が中心になっていない** — "pre/post 1 組の検知に寄っています。今回の本丸はむしろここで、`t=0, 50, 100, 200 ms` のような低周波 multi-frame ring buffer を持ち、N フレーム内の最大変化/安定後変化を見る設計にすると、かなり北極星っぽくなります。"
- **P2 — UIA 観測 API の実装形が ADR で曖昧** — "PostMessage 後の leaf HWND に対して『read-only に percent を取る』公開 API としては ADR 上でまだ曖昧です。`uia_read_scroll_percent_at_hwnd(hwnd, axis)` のような additive napi を明記すると実装者が迷わないです。"

All four findings are accepted. The Round 1 verdict over-claimed phase correlation as a single primitive that solves both translation detection and local-repaint detection; collapsed scroll/click/keyboard into one primitive (whereas click/keyboard are local-repaint problems, fundamentally different from scroll's global translation); and centred the design on a single pre/post pair when the right architecture is a multi-frame ring buffer.

---

## 9. Round 2 — A2 framework: Temporal Motion Observation Layer

Rename Path A to **A2 — Temporal Motion Observation Layer (TMOL)**. The framework is a *layered observation pipeline*, not a single algorithm. Each layer is a candidate implementation that plugs into a stable contract; layers are stacked highest-confidence-first.

### 9.1 Architecture (single contract, pluggable implementations)

```
verifyVisualMotion(
  leafHwnd,
  region,
  axisHint?: "vertical" | "horizontal" | null,
  capability: "scroll_translation" | "local_repaint" | "any_change",
): VisualMotionObservation
```

`VisualMotionObservation`:
```ts
{
  motion: "translation" | "local_repaint" | "no_change" | "indeterminate";
  // Present when the algorithm produced a numeric shift (e.g. UIA percent for
  // source: "uia_scroll_percent"); may be absent for sources that produce
  // only a binary motion verdict (e.g. source: "temporal_ring_observation_only").
  // Sub-pixel possible. ADR-019 Stage 2b sub-plan §2.4 Option A — `shift` is
  // present when measurable; `motion` is present always.
  shift?: { dx: number; dy: number; confidence: number };
  // Present when the algorithm measured a local repaint signature (e.g.
  // SSIM residual fraction for source: "ssim_residual"); may be absent for
  // sources that produce only a binary motion verdict (Stage 2b sub-plan §2.4
  // Option A relaxation, same rationale as `shift?` above). Stage 4 emits
  // `residual` even on no_change / indeterminate outputs so the
  // `meanSsim?: number` audit field is reachable for the Wang
  // perceptually-identical boundary (Stage 4 sub-plan §4 P15 default (a)).
  residual?: { fractionChanged: number; centroid?: { x: number; y: number }; meanSsim?: number };
  // metadata
  source: "uia_scroll_percent" | "block_motion_vectors" | "tiled_phase_correlation"
         | "ssim_residual" | "dxgi_dirty_rect" | "optical_flow"
         | "temporal_ring_observation_only" | "chain_trust_unverified";
  framesSampled: number;
  totalElapsedMs: number;
}
```

The dispatcher picks layers based on `capability`:

| Capability | Primary layer | Fallback chain |
|---|---|---|
| `scroll_translation` (scroll dispatcher) | UIA `ScrollPattern.VerticalScrollPercent` if exposed | block motion vectors → tiled phase correlation → SSIM residual → chain_trust_unverified |
| `local_repaint` (click verify, BG keyboard verify) | SSIM residual on focused element rect (if known) | block motion vectors with `dy=0` constraint → optical flow sparse → chain_trust_unverified |
| `any_change` (general verifyDelivery) | DXGI Desktop Duplication dirty/move rect (if available) | block motion vectors → SSIM residual → chain_trust_unverified |

### 9.2 Multi-frame ring buffer (the north-star part)

This is the architectural feature the user named as the load-bearing piece. Instead of "capture pre, post, compare":

1. Capture `pre` snapshot right before the dispatch action.
2. Issue the action (PostMessage / SendInput / CDP / UIA).
3. Sample `post` frames at `t = 30, 60, 120, 240 ms` (4 frames; cap total settle at 240 ms).
4. **Decision rule**: motion observed iff `∃ post_frame ∈ ring such that motion(pre, post_frame) ≥ threshold` AND `post_frame_last` is stable (within `noise_threshold` of `post_frame_last - 1`).

The dual condition ("motion → settle → final-differs-from-pre") catches:
- **GPU staleness** — `PrintWindow` at t=30 ms returns the pre-paint cached frame; t=120 ms returns the post-paint. Without the ring buffer, we'd capture only t=30 and miss the real change.
- **Transient animations** (cursor blink, marching-ants, hover effects) — motion observed in middle frames but final frame matches pre → reject as transient noise, not a real delivery.
- **Real scrolls** — motion observed AND final frame differs from pre by the same shift → accept.

This is what the user named "動画エンコード的な" — analogous to I/P/B inter-frame coding's residual + motion compensation, applied to UI-state verification rather than video compression.

### 9.3 Candidate implementations per primitive

For `scroll_translation` (priority order):

1. **UIA `CurrentVerticalScrollPercent`** — exact, when exposed. Probe required (see §10 OQ1).
2. **Block motion vectors (16×16 SAD coarse-to-fine)** — robust to Excel periodic grid because each 16×16 block carries enough local structure to register a `dy`. Majority vote across all blocks gives the global scroll amount. Already partially implemented in `src/pixel_diff.rs` (SSE2 SAD on 8×8 blocks); extending to 16×16 with `(dx, dy)` search radius ±row_height is a moderate Rust addition.
3. **Tiled phase correlation** — `rustfft` on each of N tiles (e.g. 4×4 grid of 64×64 tiles), majority vote on `dy`. Robust against the periodic-grid-vs-row-header pathology because each tile sees mixed-frequency local content. Cost: 16 FFTs vs Round 1's 1 FFT. Still under 20 ms on 1080p with rustfft SIMD.
4. **SSIM residual map** — Wang et al. 2004 metric; converts to a "did this region change" signal. Used as a confidence floor (if SSIM ≥ 0.99 everywhere → no_change regardless of motion-vector noise).
5. **DXGI Desktop Duplication dirty/move rects** — Windows-native OS-level frame-diff metadata. Captured by the OS-side compositor, not by our PrintWindow. Highly accurate but tied to the desktop-duplication surface, not a single window. Suitable for full-screen / multi-window observation; integration is heavier (DXGI desktop duplication session lifecycle).

For `local_repaint` (click verify, BG keyboard verify):

1. **SSIM residual on focused-element rect** — the click's expected effect is a local visual change inside a known rect (the clicked element's UIA bounds). SSIM there gives a clean delta.
2. **Block motion vectors constrained to `dy=0`** — for click feedback (highlight, focus rectangle), the "movement" is a content change without translation. Block-SAD with `dy=0` (or ε bound) captures this as a residual term.
3. **Optical flow (Lucas-Kanade sparse)** — generic; samples N sparse feature points, computes per-point flow. Lower priority — block motion + SSIM cover most cases.

For `any_change` (general verifyDelivery):

1. **DXGI Desktop Duplication dirty/move rects** — best signal when available; OS knows authoritatively what changed.
2. **Block motion vectors** + **SSIM residual map** — software-only fallback when DXGI not in scope (or window not on the primary desktop).

### 9.4 phase correlation, properly gated

The original Round 1 framing was "phase correlation peak amplitude > 0.05 → motion." That's insufficient on Excel-class periodic grids. Round 2 gating:

```
phase_correlation_pass(pre, post):
  let (peak1_loc, peak1_val) = argmax(crossspec_inverse(pre, post))
  let peak2_val = max(crossspec_inverse(pre, post) \ neighbourhood(peak1_loc))
  let ratio = peak1_val / peak2_val           // ≥ 3 → confident peak
  let texture = variance(pre)                  // ≥ noise_floor → enough texture
  let tile_agreement = ratio_of_tiles_with_same_dy   // ≥ 0.5 → coherent shift
  return ratio ≥ 3 AND texture ≥ noise_floor AND tile_agreement ≥ 0.5
```

Tile agreement is the load-bearing add. A single FFT on a 256×256 patch of Excel's row-header strip can produce ambiguous peaks; computing per-tile correlation and requiring a majority of tiles to agree on the same `(dx, dy)` distinguishes "genuine global shift" from "ambiguous low-texture pattern match."

References: Guizar-Sicairos et al. 2008 (sub-pixel phase correlation via local oversampling) — the canonical algorithm for the high-confidence peak detection.

### 9.5 Concrete UIA napi (P2 finding 4)

Add to `src/uia/scroll.rs`:

```rust
#[napi]
pub fn uia_read_scroll_percent_at_hwnd(
  hwnd: BigInt,
  axis: String,  // "vertical" | "horizontal"
) -> napi::Result<Option<f64>>;
```

Implementation: `ElementFromHandle(hwnd)` → walk UIA ancestors via `RawViewWalker` looking for `IUIAutomationScrollPattern` → if found, read `CurrentVerticalScrollPercent` / `CurrentHorizontalScrollPercent` → return as `Option<f64>` (None when no pattern). Read-only; no `SetScrollPercent` side effect.

This is the additive observation API the dispatcher consults *before* falling through to block motion / phase correlation. The existing `uia_scroll_by_wheel_at_hwnd` (Tier 1 dispatch) is a *write* path; this is its read-only sibling.

### 9.6 Renamed envelope shape

ADR-018 §2.6.2 reason taxonomy is unchanged. The new envelope field is `verifyDelivery.observation`:

```
verifyDelivery: {
  status: "delivered" | "not_delivered" | "unverifiable";
  channel: "uia" | "cdp" | "postmessage" | "send_input";
  reason: …;                       // existing
  observation?: {                  // additive, optional
    source: "uia_scroll_percent" | "block_motion_vectors" | "tiled_phase_correlation"
           | "ssim_residual" | "dxgi_dirty_rect" | "optical_flow"
           | "temporal_ring_observation_only" | "chain_trust_unverified";
    shift?: { dx: number; dy: number; confidence: number };
    // Stage 4 sub-plan §4 P15 decision lock default (a): `meanSsim?` is the
    // Wang "perceptually identical" floor for the `ssim_residual` pipeline.
    residual?: { fractionChanged: number; centroid?: { x: number; y: number }; meanSsim?: number };
    framesSampled?: number;
  };
}
```

Existing callers that ignore `observation` are unaffected.

---

## 10. Recommended pathway (Phase 5+N+1, Round 2)

**Land in stages — not one PR.** The TMOL framework's surface is too large for one PR; the user's framing requires building the *primitive*, which is multiple sub-PRs:

### Stage 1 — UIA observation read-only API (1 PR, ~1-2 days)

- Add `uia_read_scroll_percent_at_hwnd(hwnd, axis)` napi in `src/uia/scroll.rs` per §9.5.
- Wire into `postWheelToHwnd` chain-trust path: pre-snapshot the percent, post-snapshot after settle, compare against `SCROLL_PERCENT_EPSILON`. When pattern exposed AND moved → emit `delivered_via_postmessage` with `observation.source: "uia_scroll_percent"`. When pattern not exposed → fall through to Stage 2 (or chain-trust if Stage 2 not yet landed).
- Empirical probe: does EXCEL7 expose `ScrollPattern` for reads? If yes, this single stage resolves Excel observation without any image processing.
- Carry-over: `mouse_click.verifyDelivery` / `keyboard` BG verify can reuse the read-only UIA percent for any element that exposes ScrollPattern in its ancestor chain.

### Stage 2 — Multi-frame ring buffer + block motion vectors (1 PR, ~3-4 days)

- Add `captureMultiFrameRing(hwnd, region, schedule: number[])` in `src/engine/layer-buffer.ts` — captures `pre + post[]` at the requested ms offsets, returns the ring as a typed array.
- Add `computeBlockMotion(pre, post, blockSize, searchRadius)` in `src/pixel_diff.rs` (Rust SSE2 extension of existing block-SAD). Returns per-block `(dx, dy)` + a global vote.
- Wire into `postWheelToHwnd` chain-trust path: capture ring → for each post-frame, compute motion vs pre → return motion observed when (a) ≥ 1 post-frame shows coherent shift AND (b) the last post-frame is stable (within noise) → emit `delivered_via_postmessage` with `observation.source: "block_motion_vectors"` and `shift: { dx, dy }`.
- Excel periodic-grid case: 16×16 blocks each carry enough local structure for unambiguous `dy` register; majority vote across blocks gives the row count. Empirical bench required to confirm `0.36% byte change` translates to a non-zero majority vote.

### Stage 3 — Tiled phase correlation (1 PR, ~2-3 days)

- Add `rustfft` Rust crate; new `src/image/phase_correlation.rs` module with the proper gating from §9.4 (peak/secondPeak ratio, texture floor, tile agreement).
- Wire as a fallback under block motion: when block-motion's majority vote has low confidence (e.g., tile agreement < 0.5), invoke tiled phase correlation as the higher-resolution disambiguator.
- Out-of-scope: full-window single FFT (the Round 1 framing) — explicitly rejected in favour of tiled.

### Stage 4 — SSIM residual map for click/keyboard verify (1 PR, ~2-3 days)

- Different primitive from scroll's "did it translate?". SSIM detects "did the focused-element rect change."
- Wire into `mouse_click.verifyDelivery` and `keyboard` BG verify. **Not in the scroll path.**
- This is the click/keyboard generalization that Round 1 conflated with phase correlation; Round 2 cleanly separates it.

### Stage 5 — DXGI Desktop Duplication dirty/move rects (1 PR, ~5-7 days, exploratory)

- Tied to the desktop-duplication surface; integration is heavier than the per-window paths above.
- Carry-over: not blocking scroll/click verification; investigate as a Phase 5+N+2 carry-over.

### Stage 6 — Optical flow (defer until Stage 1-4 telemetry)

- Lucas-Kanade sparse / Farneback dense. Generic visual-state-change observation. Likely overkill for scroll/click/keyboard once Stages 1-4 are wired.
- Defer to telemetry-driven decision.

### What lands first

**Stage 1 alone resolves Excel observation if EXCEL7 exposes ScrollPattern for reads** — empirical probe is the gating step. If yes, Stages 2-6 become optional optimisations for non-UIA-friendly apps. If no, Stage 2 becomes the primary work, with Stage 1 as the lightweight pre-check.

Recommended ordering: **Stage 1 → empirical probe → decide Stage 2 priority based on outcome.**

---

## 11. Round 2 — Trade-offs explicitly accepted

By adopting A2 over Path A Round 1:

- **Larger scope** (5 stages vs. 1 PR), but each stage is independently shippable and provides observable LLM-side capability. Reflects the user's "system-wide" framing.
- **No single "phase correlation = solved" bet.** The framework lists 6 candidate implementations across 3 primitives (`scroll_translation` / `local_repaint` / `any_change`), each chosen for its specific failure mode.
- **Multi-frame ring buffer is central**, not optional. This was the user's named load-bearing architectural feature.
- **Click / keyboard primitive is `local_repaint`, not `scroll_translation`** — explicit primitive split.

By NOT adopting Path A Round 1 (single-FFT phase correlation):

- We give up the "single elegant primitive" framing. The Round 1 framing was simpler but conflated translation and local-repaint detection — a category error the user flagged.

By NOT adopting Path B:

- Path B's `computeChangeFraction` + `findNewRows` is folded into A2 Stage 2 as the **starting point** for block motion vectors. The existing helper is the foundation; the extension is the per-block `(dx, dy)` search.

By NOT adopting Path C:

- Same as Round 1: pHash structurally aliases on periodic grids.

---

## 12. Round 2 — Open questions

1. **Does EXCEL7 expose `IUIAutomationScrollPattern` for reads?** Empirical probe needed before Stage 1 implementation. If yes, Stage 1 alone resolves Excel; if no, Stage 2 becomes primary.
2. **Block motion vector latency budget** on 1080p windows — bench `pre + 4 post-frames @ 30/60/120/240 ms` capture + per-frame 16×16 block SAD on a 889×400 region. If > 50 ms p99, downsample to 444×200 first.
3. **Multi-frame ring buffer trigger conditions** — how aggressive should the schedule be? `[30, 60, 120, 240]` is a starting point; settling apps (Excel) may need `[30, 60, 120, 240, 500]`; over-aggressive scheduling wastes capture cost.
4. **DXGI Desktop Duplication scope** — does it fit our per-window observation model, or is it strictly a screen-wide signal? Separate ADR likely.
5. **Click / keyboard primitive boundary** — for click verification, the "focused-element rect" isn't always knowable (e.g., custom-paint canvas like Photoshop). SSIM on the full window rect is the fallback; calibrate threshold.
6. **Phase correlation gating params** — `peak/secondPeak ≥ 3`, `texture ≥ noise_floor`, `tile_agreement ≥ 0.5` are rule-of-thumb thresholds; per-app empirical calibration needed.

---

## 13. Final recommendation (Round 2)

**Adopt A2 — Temporal Motion Observation Layer (TMOL)** as the Phase 5+N+1 verification framework. Five stages, each independently shippable, with Stage 1 (read-only UIA `ScrollPercent`) as the empirical probe and likely-sufficient fix for Excel scroll observation. The multi-frame ring buffer is the architectural backbone (user's "動画エンコード的な"). Scroll uses `scroll_translation` primitive (block motion / tiled phase correlation); click/keyboard use `local_repaint` primitive (SSIM residual). Phase correlation is one implementation candidate inside `scroll_translation`, properly gated with peak/secondPeak ratio + tile agreement, NOT a stand-alone primitive.

Open Stage 1 as the next PR after user approval of this revised analysis. The empirical probe (does EXCEL7 expose `ScrollPattern` for reads?) decides the priority of Stage 2+.

---

## 14. References (Round 2 additions)

- Wang et al., "Image quality assessment: from error visibility to structural similarity" (SSIM, 2004) — IEEE Trans. Image Process.
- Guizar-Sicairos, Thurman, Fienup, "Efficient subpixel image registration algorithms" (2008) — Optics Letters, the canonical sub-pixel phase correlation paper
- [Microsoft DXGI Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api) — `IDXGIOutputDuplication::AcquireNextFrame` returns dirty / move rect metadata
- [Windows.Graphics.Capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) — per-window capture (alternative to PrintWindow)
- [OpenCV Optical Flow tutorial](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html) — Lucas-Kanade / Farneback patterns
- [`rustfft` crate](https://docs.rs/rustfft/) — pure-Rust SIMD FFT for phase correlation
- [Phase correlation — Wikipedia](https://en.wikipedia.org/wiki/Phase_correlation)
- ADR-018 §1.3 (system-wide silent-failure framing) — `docs/adr-018-input-pipeline-3tier.md`
