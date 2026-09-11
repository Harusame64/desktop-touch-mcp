/**
 * No tool hands back what the screen hides, and no field is named by its value.
 *
 * MEASURED 2026-09-11 win2 (internal `dev/cdp-password/RESULTS.md` and `RESULTS-retake-before.md`,
 * on `befc1e8b`): on an ordinary login form, a password field's value came back as its name in
 * `desktop_discover`, `browser_overview` and `browser_click`'s candidates — an aria-label and a
 * `<label for>` did not help; `browser_form` returned every value, passwords included; and
 * `desktop_state` returned a password through its CDP fallback.
 *
 * These cells run the scripts the tools ship — not a copy of them — against a page shaped like the
 * one win2 used: the same fields, the same fake values. Then they sweep every answer for the values,
 * with win2's corrected pattern (the first one needed a trailing digit and was blind to
 * `PROBE-AREA-*`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/engine/cdp-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/cdp-bridge.js")>()),
  evaluateInTab: vi.fn(),
}));

import { evaluateInTab } from "../../src/engine/cdp-bridge.js";
import type { TargetSpec } from "../../src/engine/world-graph/session-registry.js";

// ── A page small enough to read ──────────────────────────────────────────────

class FakeText {
  readonly nodeType = 3;
  parentElement: FakeEl | null = null;
  constructor(public nodeValue: string) {}
  get textContent(): string { return this.nodeValue; }
}

type Child = FakeEl | FakeText;

class FakeEl {
  readonly nodeType = 1;
  readonly tagName: string;
  childNodes: Child[] = [];
  parentElement: FakeEl | null = null;
  labels: FakeEl[] = [];
  rect = { left: 10, top: 10, width: 160, height: 20 };
  /** A page script that refuses programmatic writes, the way a guarded or controlled input can. */
  rejectsWrites = false;
  private current: string;

  constructor(tag: string, public attrs: Record<string, string> = {}, children: Array<Child | string> = [], value?: string) {
    this.tagName = tag.toUpperCase();
    for (const c of children) this.append(typeof c === "string" ? new FakeText(c) : c);
    // A <textarea>'s text node is its INITIAL value; a script may have set a different current one.
    this.current = value ?? (this.tagName === "TEXTAREA" ? this.textContent : (attrs.value ?? ""));
  }

  append(c: Child): this { c.parentElement = this; this.childNodes.push(c); return this; }
  get value(): string { return this.current; }
  set value(v: string) { if (!this.rejectsWrites) this.current = String(v); }
  get id(): string { return this.attrs.id ?? ""; }
  get name(): string { return this.attrs.name ?? ""; }
  get type(): string { return this.tagName === "INPUT" ? (this.attrs.type ?? "text").toLowerCase() : ""; }
  get placeholder(): string { return this.attrs.placeholder ?? ""; }
  get href(): string { return this.attrs.href ?? ""; }
  get disabled(): boolean { return "disabled" in this.attrs; }
  get readOnly(): boolean { return "readonly" in this.attrs; }
  get checked(): boolean { return "checked" in this.attrs; }
  get isContentEditable(): boolean { return false; }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
  get innerText(): string { return this.textContent; }
  get children(): FakeEl[] { return this.childNodes.filter((c): c is FakeEl => c instanceof FakeEl); }
  get previousElementSibling(): FakeEl | null {
    const siblings = this.parentElement?.children ?? [];
    const i = siblings.indexOf(this);
    return i > 0 ? siblings[i - 1] : null;
  }
  getAttribute(n: string): string | null { return n in this.attrs ? this.attrs[n] : null; }
  hasAttribute(n: string): boolean { return n in this.attrs; }
  matches(selector: string): boolean { return matchesSelector(this, selector); }
  closest(selector: string): FakeEl | null {
    if (this.matches(selector)) return this;
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }
  contains(other: Child | null): boolean {
    for (let e: Child | null = other; e; e = e.parentElement) if (e === this) return true;
    return false;
  }
  descendants(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(selector: string): FakeEl[] { return this.descendants().filter((e) => e.matches(selector)); }
  querySelector(selector: string): FakeEl | null { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }
  cloneNode(deep = false): FakeEl {
    const copy = new FakeEl(this.tagName, { ...this.attrs });
    if (deep) for (const c of this.childNodes) copy.append(c instanceof FakeEl ? c.cloneNode(true) : new FakeText(c.nodeValue));
    return copy;
  }
  remove(): void {
    const p = this.parentElement;
    if (p) { p.childNodes = p.childNodes.filter((c) => c !== this); this.parentElement = null; }
  }
  focus(): void {}
  select(): void {}
  dispatchEvent(): boolean { return true; }
}

/** Split on a separator that is not inside brackets or parentheses. */
function splitTop(selector: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of selector) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function matchesSelector(el: FakeEl, selector: string): boolean {
  return splitTop(selector, ",").some((part) => matchesCompound(el, part));
}

/** Tag, #id, [attr], [attr=value], :not(…), :disabled — what the shipped scripts ask for, and no more. */
function matchesCompound(el: FakeEl, compound: string): boolean {
  if (/[\s>+~]/.test(compound.replace(/\[[^\]]*\]|\([^)]*\)/g, ""))) {
    throw new Error(`fake page: no combinators — ${compound}`);
  }
  let rest = compound;
  const tag = /^(\*|[a-zA-Z][\w-]*)/.exec(rest);
  if (tag) {
    if (tag[1] !== "*" && tag[1].toUpperCase() !== el.tagName) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    let m: RegExpExecArray | null;
    if ((m = /^#([\w-]+)/.exec(rest))) {
      if (el.id !== m[1]) return false;
    } else if ((m = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest))) {
      const have = el.getAttribute(m[1]);
      const want = m[2] ?? m[3] ?? m[4];
      if (have === null || (want !== undefined && have !== want)) return false;
    } else if ((m = /^:not\(([^()]*)\)/.exec(rest))) {
      if (matchesCompound(el, m[1])) return false;
    } else if ((m = /^:disabled/.exec(rest))) {
      if (!el.disabled) return false;
    } else if ((m = /^:modal/.exec(rest))) {
      return false;
    } else {
      throw new Error(`fake page: selector not supported — ${compound}`);
    }
    rest = rest.slice(m[0].length);
  }
  return true;
}

interface Page {
  window: Record<string, unknown>;
  document: Record<string, unknown>;
}

function pageWith(body: FakeEl, activeElement: FakeEl | null = null): Page {
  const all = (): FakeEl[] => [body, ...body.descendants()];
  const style = (el: { attrs?: Record<string, string> }) => {
    const mask = el?.attrs?.style?.includes("-webkit-text-security: disc") ? "disc" : "none";
    return {
      display: "block", visibility: "visible", opacity: "1", position: "static", cursor: "auto",
      transform: "none", zIndex: "auto", overflow: "visible", overflowY: "visible",
      webkitTextSecurity: mask,
      getPropertyValue: (p: string) => (p === "-webkit-text-security" ? mask : ""),
    };
  };
  return {
    window: {
      innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 880,
      screenX: 0, screenY: 0, scrollY: 0, devicePixelRatio: 1,
      getComputedStyle: style,
    },
    document: {
      body,
      documentElement: { scrollHeight: 1000 },
      activeElement,
      querySelectorAll: (s: string) => body.querySelectorAll(s),
      querySelector: (s: string) => body.querySelector(s),
      getElementById: (id: string) => all().find((e) => e.id === id) ?? null,
      elementFromPoint: () => null,
    },
  };
}

class FakeEvent {
  constructor(public type: string, public init?: object) {}
}

/** Evaluate a shipped expression against the page, and hand back what CDP's returnByValue would. */
function run(expression: string, page: Page): unknown {
  const fn = new Function(
    "window", "document", "CSS", "HTMLInputElement", "HTMLTextAreaElement", "InputEvent", "Event",
    `return ${expression.trim()}`,
  );
  const value = fn(page.window, page.document, { escape: (s: string) => s }, class {}, class {}, FakeEvent, FakeEvent);
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** win2's retake page (`pw-page-2.html`), plus a field masked by CSS and a submit button. */
function loginPage() {
  const el = (tag: string, attrs: Record<string, string> = {}, children: Array<Child | string> = [], value?: string) =>
    new FakeEl(tag, attrs, children, value);
  const p1 = el("input", { id: "p1", type: "password" }, [], "PROBE-SECRET-1");
  const p2 = el("input", { id: "p2", type: "password", placeholder: "Password" }, [], "PROBE-SECRET-2");
  const t1 = el("input", { id: "t1", type: "text" }, [], "PROBE-TEXT-9");
  const p3 = el("input", { id: "p3", type: "password", "aria-label": "Account password" }, [], "PROBE-SECRET-3");
  const l4 = el("label", { for: "p4" }, ["PASSCODE-LABEL"]);
  const p4 = el("input", { id: "p4", type: "password" }, [], "PROBE-SECRET-4");
  p4.labels = [l4];
  const t2 = el("input", { id: "t2", type: "text", "aria-label": "Search" }, [], "PROBE-TYPED-7");
  const a1 = el("textarea", { id: "a1" }, ["PROBE-AREA-INIT"], "PROBE-AREA-NOW");
  // Not on win2's page: a text input the page draws as dots with CSS, and a submit input — whose
  // value IS its name, the caption drawn on the button.
  const m1 = el("input", { id: "m1", type: "text", title: "PIN", style: "-webkit-text-security: disc" }, [], "PROBE-SECRET-5");
  const s1 = el("input", { id: "s1", type: "submit" }, [], "Log in");
  const go = el("button", { id: "go" }, ["GO"]);
  const form = el("form", { id: "form" }, [
    el("p", {}, [p1]), el("p", {}, [p2]), el("p", {}, [t1]), el("p", {}, [p3]), el("p", {}, [l4, " ", p4]),
    el("p", {}, [t2]), el("p", {}, [a1]), el("p", {}, [m1]), el("p", {}, [go, s1]),
  ]);
  const body = el("body", {}, [el("h1", {}, ["RFS PW PAGE 2"]), form]);
  body.descendants().forEach((e, i) => { e.rect = { left: 10, top: 10 + i * 24, width: 160, height: 20 }; });
  return { body, p1, p2, p3, p4, t1, t2, a1, m1 };
}

const PROBE = /PROBE-[A-Z0-9-]*[A-Z0-9]/g;
/** A text field's value may still come back as its VALUE — so each cell names what it allows. */
const TEXT_VALUES = ["PROBE-TEXT-9", "PROBE-TYPED-7", "PROBE-AREA-NOW"];

function leaked(text: string, allowed: string[] = []): string[] {
  return [...new Set(text.match(PROBE) ?? [])].filter((t) => !allowed.includes(t)).sort();
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

let fixture: ReturnType<typeof loginPage>;
let page: Page;

beforeEach(() => {
  fixture = loginPage();
  page = pageWith(fixture.body);
  vi.mocked(evaluateInTab).mockReset();
  vi.mocked(evaluateInTab).mockImplementation(async (expression: string) => run(expression, page));
});

describe("a field is named by its name, never by its value", () => {
  async function nameOf(el: FakeEl): Promise<string> {
    const { ELEMENT_NAME_JS } = await import("../../src/tools/_element-name-js.js");
    el.attrs.id ||= "subject";
    return run(`(function(){ ${ELEMENT_NAME_JS} return __fieldName(document.getElementById(${JSON.stringify(el.attrs.id)})); })()`, page) as string;
  }

  it("takes the HTML-AAM order: aria-labelledby, aria-label, label, title, placeholder", async () => {
    const heading = new FakeEl("span", { id: "hd" }, ["Billing"]);
    fixture.body.append(heading);
    const field = (attrs: Record<string, string>) => {
      const f = new FakeEl("input", { type: "password", ...attrs }, [], "PROBE-SECRET-9");
      fixture.body.append(f);
      return f;
    };
    expect(await nameOf(field({ id: "f1", "aria-labelledby": "hd", "aria-label": "A" }))).toBe("Billing");
    expect(await nameOf(field({ id: "f2", "aria-label": "A", title: "T", placeholder: "P" }))).toBe("A");
    const labelled = field({ id: "f3", title: "T", placeholder: "P" });
    labelled.labels = [new FakeEl("label", {}, ["L"])];
    expect(await nameOf(labelled)).toBe("L");
    expect(await nameOf(field({ id: "f4", title: "T", placeholder: "P" }))).toBe("T");
    expect(await nameOf(field({ id: "f5", placeholder: "P" }))).toBe("P");
    expect(await nameOf(field({ id: "f6", "aria-placeholder": "AP" }))).toBe("AP");
    expect(await nameOf(field({ id: "f7" }))).toBe("");
  });

  it("does not take a field's text from a label or a reference that contains the field", async () => {
    // A label wrapping a <textarea> has the textarea's initial value as part of its text, and
    // aria-labelledby may point at the field itself (spec-legal: "Amount [value]").
    const area = new FakeEl("textarea", { id: "notes" }, ["PROBE-AREA-DRAFT"]);
    const wrap = new FakeEl("label", {}, ["Notes ", area]);
    area.labels = [wrap];
    const self = new FakeEl("input", { id: "amt", "aria-labelledby": "amt" }, [], "PROBE-TEXT-42");
    fixture.body.append(wrap).append(self);
    expect(await nameOf(area)).toBe("Notes");
    expect(await nameOf(self)).toBe("");
  });

  it("keeps a button-type input's value as its name — it is the caption, not an entry", async () => {
    const submit = new FakeEl("input", { id: "b1", type: "submit" }, [], "Log in");
    const image = new FakeEl("input", { id: "b2", type: "image", alt: "Search" }, [], "PROBE-IMG");
    fixture.body.append(submit).append(image);
    expect(await nameOf(submit)).toBe("Log in");
    expect(await nameOf(image)).toBe("Search");
  });
});

describe("the tools win2 measured leak nothing the page masks", () => {
  it("desktop_discover labels each field by its name, or by its type when it has none", async () => {
    const { fetchBrowserCandidates } = await import("../../src/tools/desktop-providers/browser-provider.js");
    const result = await fetchBrowserCandidates({ tabId: "tab-1" } as TargetSpec);
    const labels = Object.fromEntries(result.candidates.map((c) => [c.locator?.cdp?.selector, c.label]));
    expect(labels).toMatchObject({
      "#p1": "input[password]", "#p2": "Password", "#t1": "input[text]", "#p3": "Account password",
      "#p4": "PASSCODE-LABEL", "#t2": "Search", "#a1": "textarea", "#m1": "PIN", "#s1": "Log in",
    });
    expect(leaked(JSON.stringify(result.candidates.map((c) => c.label)))).toEqual([]);
    // A text field's value stays on its candidate as its value; a masked field's is never read.
    expect(leaked(JSON.stringify(result), TEXT_VALUES)).toEqual([]);
  });

  it("browser_overview names inputs and shows nothing typed in them", async () => {
    const { browserGetInteractiveHandler } = await import("../../src/tools/browser.js");
    const text = textOf(await browserGetInteractiveHandler({
      types: ["all"], inViewportOnly: false, maxResults: 50, port: 9222, includeContext: false,
    }));
    expect(leaked(text)).toEqual([]);
    for (const name of ["Account password", "PASSCODE-LABEL", "Search", "Password", "PIN", "Log in"]) {
      expect(text).toContain(`"text": "${name}"`);
    }
  });

  it("browser_click's ambiguity candidates are named, not valued", async () => {
    // win2's arm: by:"ariaLabel", pattern "a" hit P3 and T2, and the candidates were NAMED
    // `PROBE-SECRET-3` and `PROBE-TYPED-7`.
    const { buildActionCandidateFactsJs } = await import("../../src/tools/browser-resolver.js");
    const facts = run(buildActionCandidateFactsJs({ by: "ariaLabel", pattern: "a", caseSensitive: false, includeModal: true }), page) as {
      candidates: Array<{ name: string }>;
    };
    expect(facts.candidates.map((c) => c.name).sort()).toEqual(["Account password", "Search"]);
    expect(leaked(JSON.stringify(facts))).toEqual([]);
  });

  it("browser_search's results carry no value, on the axis that lists every field", async () => {
    const { buildCandidateCollectionJs } = await import("../../src/tools/browser-resolver.js");
    for (const [by, pattern] of [["selector", "input, textarea"], ["regex", "."]] as const) {
      const found = run(buildCandidateCollectionJs({
        by, pattern, maxResults: 50, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false,
      }), page);
      expect(leaked(JSON.stringify(found)), by).toEqual([]);
    }
  });

  it("browser_form withholds a masked field's value, says whether it holds one, and keeps the rest", async () => {
    const { browserGetFormHandler } = await import("../../src/tools/browser.js");
    const text = textOf(await browserGetFormHandler({
      selector: "#form", includeHidden: false, maxResults: 50, port: 9222, includeContext: false,
    }));
    const fields = Object.fromEntries((JSON.parse(text) as { fields: Array<Record<string, unknown>> }).fields.map((f) => [f.id, f]));
    for (const id of ["p1", "p2", "p3", "p4", "m1"]) {
      expect(fields[id], id).toMatchObject({ value: null, valueWithheld: "masked", hasValue: true });
    }
    expect(fields.t1).toMatchObject({ value: "PROBE-TEXT-9" });
    expect(fields.t1).not.toHaveProperty("valueWithheld");
    expect(fields.p4.label).toBe("PASSCODE-LABEL");
    expect(leaked(text, TEXT_VALUES)).toEqual([]);
  });

  it("desktop_state's CDP read gives no masked value, and no field's text as its name", async () => {
    const { CDP_FOCUSED_ELEMENT_SCRIPT, buildElementInfoFromCdp } = await import("../../src/tools/desktop-state.js");
    const focus = (el: FakeEl) => buildElementInfoFromCdp(run(CDP_FOCUSED_ELEMENT_SCRIPT, pageWith(fixture.body, el)) as object);
    expect(focus(fixture.p1)).toEqual({ name: "p1", type: "INPUT" });
    expect(focus(fixture.m1)).toEqual({ name: "m1", type: "INPUT" });
    // A text field keeps its value — the field is named, and the value is the value.
    expect(focus(fixture.t2)).toEqual({ name: "t2", type: "INPUT", value: "PROBE-TYPED-7" });
    const unnamed = new FakeEl("textarea", {}, ["PROBE-AREA-INIT"], "PROBE-AREA-NOW");
    fixture.body.append(unnamed);
    expect(focus(unnamed).name).toBe("TEXTAREA");
  });

  it("browser_fill does not read back a masked field — not even what the page kept instead", async () => {
    const { browserFillInputHandler } = await import("../../src/tools/browser.js");
    fixture.p1.rejectsWrites = true;
    const refused = JSON.stringify(await browserFillInputHandler({ selector: "#p1", value: "PROBE-NEW-1", port: 9222, includeContext: false }));
    expect(refused).toContain("actualWithheld");
    expect(refused).not.toContain("PROBE-SECRET-1");
    const filled = JSON.stringify(await browserFillInputHandler({ selector: "#p2", value: "PROBE-NEW-2", port: 9222, includeContext: false }));
    expect(filled).toContain("actualWithheld");
    expect(filled).not.toContain('\\"actual\\"');
  });

  it("browser_fill by axis does not read back a masked field either", async () => {
    const { buildFillActJs } = await import("../../src/tools/browser-resolver.js");
    fixture.p3.rejectsWrites = true;
    const acted = run(buildFillActJs(
      { by: "ariaLabel", pattern: "Account password", caseSensitive: false },
      0, 0, "PROBE-NEW-3",
      { name: "Account password", role: null, ariaLabel: "Account password", tag: "input", total: 1 },
    ), page);
    expect(acted).toMatchObject({ ok: true, actualWithheld: true, fullMatches: false });
    expect(JSON.stringify(acted)).not.toContain("PROBE-SECRET-3");
  });
});
