/**
 * modal-detection.test.ts
 *
 * Pin the MODAL_RE contract down so the next time someone "improves" the
 * regex they cannot silently re-introduce the substring false positives that
 * caused PR #36's E2E flakiness (a Claude Code conversation titled
 * "Review PR#36 feedback and CI errors" matched /error/ and falsely set
 * hasModal=true on every desktop_state call).
 */

import { describe, it, expect } from "vitest";
import { MODAL_RE } from "../../src/tools/desktop-state.js";

describe("MODAL_RE — true positives (real modal dialog titles)", () => {
  const positives = [
    // English standalone keywords
    "Save As",
    "Confirm Delete",
    "Error",
    "Warning: Disk Full",
    "Dialog Box",
    "File Open Dialog",
    // English mixed-case
    "save as",
    "ERROR",
    // Japanese keywords
    "警告",
    "エラー",
    "ファイルを保存しますか? - 確認",
    "通知",
    "ダイアログ",
    "名前を付けて保存",
    // Common composite titles
    "Save As - Notepad",
    "Confirm File Replace",
  ];

  for (const title of positives) {
    it(`detects "${title}" as modal`, () => {
      expect(MODAL_RE.test(title)).toBe(true);
    });
  }
});

describe("MODAL_RE — false positives prevented (regular window titles)", () => {
  const negatives = [
    // The exact bug that caused PR #36 E2E flakiness:
    "⠂ Review PR#36 feedback and CI errors",
    // English plurals / suffixes that previously matched substrings:
    "Review CI errors",
    "Confirmation Number 12345",
    "Alerting Service Logs",
    "Prompt Engineering Guide",
    "Dialogue Editor",
    // Compound/related words:
    "errorList.json - VS Code",
    "alerts-dashboard - Grafana",
    "Conversation Prompts",
    // Application titles that contain the keyword as part of a word:
    "Sentry Errors Dashboard",
    "Slack Notifications", // English "Notifications" doesn't match anything (we don't have "notification" in EN)
    // Browser tabs that might contain similar substrings:
    "Stack Overflow - 'errors' search results",
    "GitHub - prompt-toolkit/python-prompt-toolkit: Library for building interactive command lines",
    // Editor / IDE windows showing modal-related code:
    "modal.ts - VS Code",
    "DialogService.tsx - WebStorm",
  ];

  for (const title of negatives) {
    it(`does NOT flag "${title}" as modal`, () => {
      expect(MODAL_RE.test(title)).toBe(false);
    });
  }
});

describe("MODAL_RE — known acceptable Japanese substring matches", () => {
  // Japanese terms are matched as substrings because \b does not recognise
  // Japanese word boundaries. These cases are intentional false positives
  // that we accept as a trade-off for catching legitimate Japanese modals.
  // Documented here so the trade-off is explicit and reviewable.
  const acceptedSubstrings = [
    "通知センター", // notification center — substring of 通知
    "確認事項",     // checklist — substring of 確認
    "Twitter 通知", // tweet notifications — substring of 通知
  ];

  for (const title of acceptedSubstrings) {
    it(`(known trade-off) flags "${title}" as modal due to JA substring match`, () => {
      expect(MODAL_RE.test(title)).toBe(true);
    });
  }
});
