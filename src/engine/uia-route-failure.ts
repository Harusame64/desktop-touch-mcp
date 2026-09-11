/**
 * uia-route-failure.ts — which of the UIA route's known failures an aimed act ran into.
 *
 * ADR-036, the `aim_route_failed` classifier. An aimed act whose UIA route fails is refused rather
 * than finished as a blind coordinate press, and the refusal published one generic sentence for
 * every failure. Two of them have opposite recoveries — the element is not in the tree any more
 * (re-discover), or it is there and cannot do this through UI Automation (use another affordance) —
 * and a caller could not tell them apart: MEASURED 2026-09-11 win2
 * `dev/route-failure-strings/RESULTS.md`, arms Pi-a and Pi-b, the same sentence word for word.
 *
 * The backend's own text may NOT be forwarded to fill that gap. On the PowerShell road a failure can
 * be a shell rejection carrying the whole script, and on the `type` road the text being typed
 * (item 13). So this recognises the answers the backend is known to give, and says nothing for any
 * other. Every pattern below is a string that came back on a real machine:
 *
 *   MEASURED 2026-09-11 win2 `dev/route-failure-strings/RESULTS.md` — `5b5b4d58`, a Japanese-locale
 *   Windows 11, both roads (native by title, PowerShell by handle), click and setValue:
 *
 *   | failure    | click, both roads                             | setValue, native                             | setValue, PowerShell by handle |
 *   |------------|-----------------------------------------------|----------------------------------------------|--------------------------------|
 *   | not found  | `Element not found`                           | `Element not found`                          | `Element not found` |
 *   | no pattern | `InvokePattern not supported by this element` | `ValuePattern not supported by this element` | `Exception calling "GetCurrentPattern" with "1" argument(s): "Unsupported Pattern."` |
 *   | disabled   | `Element is disabled`                         | `Element is disabled`                        | `Exception calling "SetValue" with "1" argument(s): "The operation is not allowed on a nonenabled element."` |
 *
 * **The texts the bridge writes itself are matched whole.** A shell rejection carries the script,
 * and the script contains those very literals — a substring match would read a rejection as "not
 * found". The two .NET texts are matched by the PowerShell wrapper they arrive in, anchored at the
 * start, plus a fragment. They came back in English on a Japanese-locale machine; other locales are
 * not measured, and a localised one is simply not recognised — which publishes nothing, the answer
 * this had before.
 *
 * One more limit, measured the same day: `Element not found` is also what a lookup with an id from
 * another UIA vocabulary returns (win2's void first bridge run). In production the id comes from a
 * read on the same road, so "not found" is the right name here; it would not be for a reader that
 * builds locators some other way.
 *
 * **A read-only field is its own answer, and the client gives it before any provider is asked.**
 * The managed client's `ValuePattern.SetValue` reads `IsEnabled` and throws
 * `ElementNotEnabledException` (the `nonenabled element` text), then reads `IsReadOnly` and throws
 * `InvalidOperationException` (`Value is read-only.`), both before it calls the provider (dotnet/wpf,
 * `UIAutomationClient/System/Windows/Automation/ValuePattern.cs`). MEASURED 2026-09-11 win2
 * `dev/route-failure-strings/RESULTS-622.md`, on `90633009`: a disabled field typed through the
 * by-handle road gave the `nonenabled element` text, and a read-only WinForms Edit and a read-only
 * WPF TextBox both gave `Exception calling "SetValue" with "1" argument(s): "Value is read-only."`.
 * So on this road `nonenabled element` means disabled. Two providers do refuse a read-only field as
 * not enabled (WPF's `TextBoxAutomationPeer`, Chromium's `AXPlatformNodeWin`), but the client's
 * check comes first — reasoning from their source got this backwards once, in `00d1109`. A read-only
 * field in Chrome is not measured.
 *
 * **"The element" is the one the route matched, which need not be the entity.** The by-handle
 * scripts take the first descendant whose name contains the entity's label, narrowed by
 * AutomationId only when the entity has one, and the executor passes no control type. On a page
 * where a heading "Save changes" comes before the button "Save", a click on "Save" can be answered
 * for the heading. So the words say "the element the route matched" (2ゲート目, round 2; read in
 * the scripts, not reproduced).
 */

/** The failures this server can name. */
export type UiaRouteFailure =
  | "element_not_found"
  | "pattern_not_supported"
  | "element_disabled"
  | "element_read_only";

/** Written by the bridge itself (script and native), so they arrive as the whole message. */
const WHOLE: ReadonlyMap<string, UiaRouteFailure> = new Map([
  ["Element not found", "element_not_found"],
  ["InvokePattern not supported by this element", "pattern_not_supported"],
  ["ValuePattern not supported by this element", "pattern_not_supported"],
  ["Element is disabled", "element_disabled"],
]);

/** .NET's text inside PowerShell's method-invocation wrapper — the wrapper names the method. */
const WRAPPED: ReadonlyArray<{ readonly re: RegExp; readonly kind: UiaRouteFailure }> = [
  { re: /^Exception calling "GetCurrentPattern" with "\d+" argument\(s\): ".*Unsupported Pattern/, kind: "pattern_not_supported" },
  { re: /^Exception calling "SetValue" with "\d+" argument\(s\): ".*nonenabled element/, kind: "element_disabled" },
  { re: /^Exception calling "SetValue" with "\d+" argument\(s\): "Value is read-only\./, kind: "element_read_only" },
];

/** The failure an aimed UIA route ran into, when the backend's answer is one of the known ones. */
export function classifyUiaRouteFailure(err: unknown): UiaRouteFailure | undefined {
  if (!(err instanceof Error)) return undefined;
  const text = err.message.trim();
  const whole = WHOLE.get(text);
  if (whole !== undefined) return whole;
  return WRAPPED.find((w) => w.re.test(text))?.kind;
}

/** The engine's own words for each failure — the only text about it a caller is shown. */
export function describeUiaRouteFailure(kind: UiaRouteFailure): string {
  switch (kind) {
    case "element_not_found":
      return "the element was not found in that window's accessibility tree (it may have gone, been renamed, or moved)";
    case "pattern_not_supported":
      return "the element the route matched does not support this action through UI Automation";
    case "element_disabled":
      return "the element the route matched is disabled";
    case "element_read_only":
      return "the element the route matched is read-only";
  }
}
