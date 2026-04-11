import { mouse } from "../engine/nutjs.js";

const FAILSAFE_RADIUS = 10;

export class FailsafeError extends Error {
  constructor() {
    super(
      "FAILSAFE triggered: mouse is at top-left corner (0,0). " +
      "Operation aborted for safety. Move mouse away from corner to resume."
    );
    this.name = "FailsafeError";
  }
}

/**
 * Check mouse position and throw FailsafeError if at top-left corner.
 * Call this before every tool execution.
 */
export async function checkFailsafe(): Promise<void> {
  try {
    const pos = await mouse.getPosition();
    if (pos.x <= FAILSAFE_RADIUS && pos.y <= FAILSAFE_RADIUS) {
      throw new FailsafeError();
    }
  } catch (err) {
    if (err instanceof FailsafeError) throw err;
    // Transient mouse query error — don't block tools
  }
}
