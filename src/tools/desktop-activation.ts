// Pure resolver for the v2 activation contract. No side-effects — tested in isolation.
// Priority: DISABLE=1 > default(ON). See docs/anti-fukuwarai-v2-activation-policy.md.

export type V2ActivationDecision = {
  enabled: boolean;
  /** true when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2 === "1" (kill switch active). */
  disabledByFlag: boolean;
};

export function resolveV2Activation(
  env: Record<string, string | undefined> = process.env
): V2ActivationDecision {
  const disabledByFlag = env["DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2"] === "1";
  return { enabled: !disabledByFlag, disabledByFlag };
}
