/**
 * DependencyGraph — reverse index from fluent keys to lens IDs.
 * Pure class, no OS imports.
 */

export class DependencyGraph {
  /** fluentKey → Set<lensId> */
  private forward = new Map<string, Set<string>>();
  /** lensId → Set<fluentKey> */
  private reverse = new Map<string, Set<string>>();

  addLens(lensId: string, fluentKeys: string[]): void {
    // Clean up any prior registration for this lens
    this.removeLens(lensId);

    const lensKeys = new Set<string>();
    for (const key of fluentKeys) {
      lensKeys.add(key);
      let lensSet = this.forward.get(key);
      if (!lensSet) { lensSet = new Set(); this.forward.set(key, lensSet); }
      lensSet.add(lensId);
    }
    this.reverse.set(lensId, lensKeys);
  }

  removeLens(lensId: string): void {
    const lensKeys = this.reverse.get(lensId);
    if (!lensKeys) return;
    for (const key of lensKeys) {
      const lensSet = this.forward.get(key);
      if (lensSet) {
        lensSet.delete(lensId);
        if (lensSet.size === 0) this.forward.delete(key);
      }
    }
    this.reverse.delete(lensId);
  }

  /** Return all lens IDs affected by a set of changed fluent keys. */
  lookupAffectedLenses(changedKeys: Set<string>): Set<string> {
    const affected = new Set<string>();
    for (const key of changedKeys) {
      const lensSet = this.forward.get(key);
      if (lensSet) { for (const id of lensSet) affected.add(id); }
    }
    return affected;
  }

  /** Return fluent keys registered for a given lens. */
  fluentsForLens(lensId: string): string[] {
    return [...(this.reverse.get(lensId) ?? [])];
  }

  hasLens(lensId: string): boolean {
    return this.reverse.has(lensId);
  }

  lensIds(): string[] {
    return [...this.reverse.keys()];
  }

  /** Reset all state. Only for tests. */
  __resetForTests(): void {
    this.forward.clear();
    this.reverse.clear();
  }
}
