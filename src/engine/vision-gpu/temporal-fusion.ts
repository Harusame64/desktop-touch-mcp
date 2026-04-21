import type { RecognizedText } from "./types.js";

export interface FusedTextState {
  /** Committed stable text, or null while votes are still accumulating. */
  text: string | null;
  /**
   * Normalized confidence in [0, 1] — comparable with UIA/OCR/CDP source confidences.
   * Computed as `leaderVote * (1 - voteDecay)`, which maps the geometric-series maximum
   * back to approximately the observed OCR confidence.
   */
  confidence: number;
  stable: boolean;
  consecutiveCount: number;
  /** Unix ms when the leader text was last *directly observed*. Use as UiEntityCandidate.observedAtMs. */
  observedAtMs: number;
}

export interface TemporalFusionOptions {
  /**
   * Consecutive frames with the *observed* leader text required for stability.
   * Clamped to ≥ 2 — single-frame commits violate "1 フレームの OCR を真実とみなさない".
   */
  stableConsecutive?: number;
  /**
   * Vote decay factor applied to all accumulated votes on each update (default: 0.7).
   * Lower values forget faster. 0 = clear all old votes on every frame.
   */
  voteDecay?: number;
  /** Minimum confidence floor — observations below this are ignored (default: 0.1). */
  minConfidence?: number;
}

interface FusionState {
  votes: Map<string, number>;
  leader: string | null;
  leaderVote: number;
  leaderLastObservedMs: number;
  consecutiveCount: number;
  stable: boolean;
}

export class TemporalFusion {
  private readonly states = new Map<string, FusionState>();
  private readonly stableConsecutive: number;
  private readonly voteDecay: number;
  private readonly minConfidence: number;

  constructor(opts: TemporalFusionOptions = {}) {
    this.stableConsecutive = Math.max(2, opts.stableConsecutive ?? 2);
    this.voteDecay = opts.voteDecay ?? 0.7;
    this.minConfidence = opts.minConfidence ?? 0.1;
  }

  update(trackId: string, candidate: RecognizedText): FusedTextState {
    // Filter invalid observations — empty text or below confidence floor.
    if (!candidate.text.trim() || candidate.confidence < this.minConfidence) {
      const s = this.states.get(trackId);
      return s ? this._snapshot(s) : this._emptySnapshot(candidate.tsMs);
    }

    let s = this.states.get(trackId);
    if (!s) {
      s = {
        votes: new Map(),
        leader: null,
        leaderVote: 0,
        leaderLastObservedMs: candidate.tsMs,
        consecutiveCount: 0,
        stable: false,
      };
      this.states.set(trackId, s);
    }

    // Decay existing votes. Map.set on an existing key is safe during iteration
    // (preserves insertion order, does not introduce new entries to visit).
    for (const [text, v] of s.votes) {
      const decayed = v * this.voteDecay;
      if (decayed < 0.001) s.votes.delete(text);
      else s.votes.set(text, decayed);
    }

    s.votes.set(candidate.text, (s.votes.get(candidate.text) ?? 0) + candidate.confidence);

    // Find winner and runner-up. Use candidate.text as tie-breaker for determinism —
    // the currently observed text wins ties rather than relying on Map insertion order.
    let winner = candidate.text;
    let winnerVote = 0;
    let runnerUpVote = 0;
    for (const [text, v] of s.votes) {
      if (v > winnerVote || (v === winnerVote && text === candidate.text)) {
        runnerUpVote = winnerVote;
        winnerVote = v;
        winner = text;
      } else if (v > runnerUpVote) {
        runnerUpVote = v;
      }
    }
    s.leaderVote = winnerVote;

    if (winner !== s.leader) {
      // New vote leader — reset stability.
      s.leader = winner;
      // Consecutive count starts at 1 only when the observed text directly caused the switch.
      s.consecutiveCount = candidate.text === winner ? 1 : 0;
      s.stable = false;
      if (candidate.text === winner) s.leaderLastObservedMs = candidate.tsMs;
    } else if (candidate.text === s.leader) {
      // Same leader AND directly observed this frame — advance streak.
      s.consecutiveCount++;
      s.leaderLastObservedMs = candidate.tsMs;
    }
    // else: same leader by accumulated votes but not observed this frame — hold streak, don't advance.

    // De-stabilize when a challenger closes the margin.
    // Threshold: runner-up vote within 2/3 of leader vote.
    // Also reset consecutiveCount so the leader must re-establish dominance from scratch
    // (prevents the stability promotion below from immediately re-committing).
    if (s.stable && runnerUpVote > 0 && runnerUpVote * 1.5 >= winnerVote) {
      s.stable = false;
      s.consecutiveCount = 0;
    }

    if (s.consecutiveCount >= this.stableConsecutive) {
      s.stable = true;
    }

    return this._snapshot(s);
  }

  getState(trackId: string): FusedTextState | null {
    const s = this.states.get(trackId);
    return s ? this._snapshot(s) : null;
  }

  /** Call when TrackStore evicts a lost track to prevent unbounded state growth. */
  clear(trackId: string): void {
    this.states.delete(trackId);
  }

  private _snapshot(s: FusionState): FusedTextState {
    return {
      text: s.stable ? s.leader : null,
      confidence: Math.min(1, s.leaderVote * (1 - this.voteDecay)),
      stable: s.stable,
      consecutiveCount: s.consecutiveCount,
      observedAtMs: s.leaderLastObservedMs,
    };
  }

  private _emptySnapshot(tsMs: number): FusedTextState {
    return { text: null, confidence: 0, stable: false, consecutiveCount: 0, observedAtMs: tsMs };
  }
}
