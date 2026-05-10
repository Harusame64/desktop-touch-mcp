/**
 * ADR-013 Option E (`foreground_flash` channel) — channel resolver.
 *
 * `bg-input.ts::canInjectViaPostMessage` は WM_CHAR 判定として今後も WT で
 * `{supported: false, reason: "wt_xaml_pipeline"}` を返し続ける (`background`
 * 契約 = "foreground 奪取しない" を破らない)。本 resolver は **caller が明示
 * opt-in した allowedChannels** を見て、WT 等の場合に `clipboard_flash` channel
 * を返す新 API。
 *
 * 設計詳細: `docs/adr-013-option-e-impl.md` v3 §4。
 *
 * caller migration ルール (二重分岐期間 = 0):
 * - `method: 'background'` の caller は `allowedChannels: ["wm_char"]`
 *   (default) で呼び、WT は引き続き `unsupported`
 * - `method: 'foreground_flash'` の caller は
 *   `allowedChannels: ["wm_char", "clipboard_flash"]` で呼び、WT で
 *   `clipboard_flash` channel を取得
 */

import {
  canInjectViaPostMessage,
  type InjectCheckResult,
} from "./bg-input.js";
import { getWindowProcessId } from "./win32.js";

/**
 * 背景入力 channel の判別子付き union。caller は `kind` で discriminator
 * として channel 別 dispatch する。
 */
export type BackgroundInputChannel =
  | { kind: "wm_char"; hwnd: bigint }
  | {
      kind: "clipboard_flash";
      hwnd: bigint;
      pid: number;
      constraints: { maxBytes: 5120; singleLineOnly: true };
    }
  | {
      kind: "cooperative_bridge";
      sessionId: string;
      pipeName: string;
    } // Option F (将来)
  | { kind: "unsupported"; reason: BackgroundUnsupportedReason };

export type BackgroundUnsupportedReason =
  | "elevated_target"
  | "no_supported_channel"
  | "wt_xaml_pipeline"
  | "user_disabled_foreground_flash"
  | "chromium"
  | "uwp_sandboxed"
  | "class_unknown";

export interface ResolveBackgroundInputOptions {
  /**
   * caller が許可している channel kinds。default は WM_CHAR のみで、これは
   * 既存 `method: 'background'` の挙動 (WT 不対応) を維持する。
   */
  allowedChannels?: Array<
    "wm_char" | "clipboard_flash" | "cooperative_bridge"
  >;
}

const DEFAULT_ALLOWED_CHANNELS: Array<
  "wm_char" | "clipboard_flash" | "cooperative_bridge"
> = ["wm_char"];

/**
 * 5KiB constraint constant (UTF-16 byte count、native validate_input と同期、
 * `src/win32/foreground_flash.rs::MAX_TEXT_UTF16_BYTES`)。
 */
const FOREGROUND_FLASH_MAX_BYTES = 5120 as const;

/**
 * `foreground_flash` channel 利用可否を `bg-input` の判定結果から導く。
 *
 * @param hwnd target HWND (`bigint`、既存 win32 surface と統一)
 * @param opts allowedChannels で channel 許可セットを caller 側から指定
 * @returns discriminated union — caller は `kind` で dispatch
 */
export function resolveBackgroundInputChannel(
  hwnd: bigint,
  opts?: ResolveBackgroundInputOptions,
): BackgroundInputChannel {
  const allowed = opts?.allowedChannels ?? DEFAULT_ALLOWED_CHANNELS;
  const allowedSet = new Set(allowed);

  // 既存 WM_CHAR support 判定 (Chrome/UWP/WT 等を `supported: false` で切り出す)
  const wmCheck = canInjectViaPostMessage(hwnd);

  // 1. WM_CHAR が supported なら (= 標準 Win32 / conhost クラス)
  //    allowed に含まれているなら wm_char channel を返す
  if (wmCheck.supported) {
    if (allowedSet.has("wm_char")) {
      return { kind: "wm_char", hwnd };
    }
    return { kind: "unsupported", reason: "no_supported_channel" };
  }

  // 2. WM_CHAR が non-supported (WT / Chromium / UWP) で、かつ
  //    `clipboard_flash` が allowed なら、WT 限定で channel を返す
  //    (Chromium / UWP は clipboard_flash でも foreground steal の意味がない:
  //     UI 側が独自レンダリングで paste 受け取り protocol を解釈しないため、
  //     wt_xaml_pipeline reason のみ clipboard_flash を提供)
  if (allowedSet.has("clipboard_flash") && wmCheck.reason === "wt_xaml_pipeline") {
    return makeClipboardFlashChannel(hwnd);
  }

  // 3. それ以外は WM_CHAR と同じ理由を再度返す
  return reasonFromInjectCheck(wmCheck);
}

function makeClipboardFlashChannel(hwnd: bigint): BackgroundInputChannel {
  let pid = 0;
  try {
    pid = getWindowProcessId(hwnd);
  } catch {
    pid = 0;
  }
  return {
    kind: "clipboard_flash",
    hwnd,
    pid,
    constraints: {
      maxBytes: FOREGROUND_FLASH_MAX_BYTES,
      singleLineOnly: true,
    },
  };
}

function reasonFromInjectCheck(check: InjectCheckResult): BackgroundInputChannel {
  if (!check.supported && check.reason) {
    switch (check.reason) {
      case "wt_xaml_pipeline":
        return { kind: "unsupported", reason: "wt_xaml_pipeline" };
      case "chromium":
        return { kind: "unsupported", reason: "chromium" };
      case "uwp_sandboxed":
        return { kind: "unsupported", reason: "uwp_sandboxed" };
      case "class_unknown":
        return { kind: "unsupported", reason: "class_unknown" };
    }
  }
  return { kind: "unsupported", reason: "no_supported_channel" };
}
