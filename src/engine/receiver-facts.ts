/**
 * ADR-036 family 2 — what can be read about the handle characters were posted to.
 *
 * **Lifted out of `tools/desktop-executor.ts` unchanged**, because a second road is about to read
 * the same facts and two readers would be two chances to disagree. The `desktop_act` rung has read
 * them since #630; the `keyboard` tool reads them from here (arm A). Nothing in this module decides
 * anything — the rule is `engine/keyboard-target.ts`, and it is given these.
 */

import {
  getWindowClassName,
  getWindowOwner,
  getWindowParent,
  getWindowRectByHwnd,
  getWindowRoot,
  getWindowStyle,
} from "./win32.js";

/** Handles are compared as 32-bit values: the same window can arrive sign-extended on one road. */
function sameHwnd(a: bigint, b: bigint): boolean {
  return BigInt.asUintN(32, a) === BigInt.asUintN(32, b);
}

export interface ReceiverFacts {
  receiverClass: string;
  receiverRect: { x: number; y: number; width: number; height: number } | null;
  /** GA_ROOT of the receiver: the top-level window that holds it. */
  receiverRootHwnd: bigint | null;
  /** GWL_STYLE. On an Edit-family class, ES_READONLY marks a field that will not take characters. */
  receiverStyle: number | null;
  /**
   * The receiver's parents, nearest first, up to but not including its top-level window. A compound
   * control keeps the focus in a child window of its own, so this is what tells "inside the named
   * control" from "another control". The walk is bounded; when it stops short the list holds what was
   * walked — which can still show "inside" and never "not inside" — and `ancestorsComplete` says so.
   */
  receiverAncestors: bigint[] | null;
  ancestorsComplete: boolean;
}

/**
 * Read the facts. Bounded, so a parent chain that loops cannot hang the caller.
 */
export async function readReceiverFacts(receiver: bigint): Promise<ReceiverFacts> {
  const root = getWindowRoot(receiver);
  const chain: bigint[] = [];
  let complete = false;
  if (root !== null) {
    let cur: bigint = receiver;
    complete = sameHwnd(cur, root);
    for (let i = 0; i < 16 && !complete; i++) {
      const parent = getWindowParent(cur);
      if (parent === null) break;
      if (sameHwnd(parent, root)) {
        complete = true;
        break;
      }
      chain.push(parent);
      cur = parent;
    }
  }
  return {
    receiverClass: getWindowClassName(receiver),
    receiverRect: getWindowRectByHwnd(receiver),
    receiverRootHwnd: root,
    receiverStyle: getWindowStyle(receiver),
    receiverAncestors: root !== null ? chain : null,
    ancestorsComplete: root !== null ? complete : false,
  };
}

/**
 * The owners of a top-level window, nearest first (GW_OWNER, bounded).
 *
 * A null ENDS the walk and proves nothing: `getWindowOwner` answers null both for "no owner" and for
 * "the call failed". Measured on 2026-09-16 (win2, the owned-window arm): the receiver was the owned
 * form's child edit, one level deeper than the ownership relation — so a record that names the
 * receiver still does not name the owner, and this chain is what carries the relation.
 */
export function readOwnerChain(root: bigint | null): bigint[] {
  const owners: bigint[] = [];
  let cur = root;
  for (let i = 0; i < 8 && cur !== null; i++) {
    const owner = getWindowOwner(cur);
    if (owner === null) break;
    owners.push(owner);
    cur = owner;
  }
  return owners;
}

/** ES_READONLY: on an edit control, the field will not take typed characters. */
const ES_READONLY = 0x0800;

/**
 * The window classes whose style bit 0x0800 is ES_READONLY: Win32 `Edit`, the RichEdit family, and the
 * WinForms classes built on them (`WindowsForms10.EDIT.…`, `WindowsForms10.RichEdit20W.…`).
 *
 * In any other class the low style bits mean something else; on a Button, 0x0800 is BS_BOTTOM. And a
 * class whose name merely contains "edit" keeps its read-only state somewhere else, so for it the
 * answer is `null` (2ゲート目, second read). Two examples are a WPF `HwndWrapper[SomeEditor.exe;;…]`
 * and a custom editor pane.
 */
const EDIT_CONTROL_CLASS = /^(?:WindowsForms10\.)?(?:Edit|RichEdit\w*)(?:\.|$)/i;

/**
 * `editReadOnly` as both roads write it and the rule reads it: only an Edit-family class's bit
 * answers. **One implementation on purpose** — the tool road grew its own for an hour and that is the
 * shape this ADR keeps paying for.
 */
export function editReadOnlyOf(className: string | null, style: number | null): boolean | null {
  return style !== null && className !== null && EDIT_CONTROL_CLASS.test(className) ? (style & ES_READONLY) !== 0 : null;
}
