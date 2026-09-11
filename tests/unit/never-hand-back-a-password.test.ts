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
  /** A keyed controlled component that replaces the element when its input event fires. */
  detachOnInput = false;
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
  get type(): string {
    if (this.tagName === "INPUT") return (this.attrs.type ?? "text").toLowerCase();
    if (this.tagName === "TEXTAREA") return "textarea";
    if (this.tagName === "SELECT") return "select-one";
    if (this.tagName === "BUTTON") return (this.attrs.type ?? "submit").toLowerCase();
    return "";
  }
  get placeholder(): string { return this.attrs.placeholder ?? ""; }
  get href(): string { return this.attrs.href ?? ""; }
  get disabled(): boolean { return "disabled" in this.attrs; }
  get readOnly(): boolean { return "readonly" in this.attrs; }
  get checked(): boolean { return "checked" in this.attrs; }
  /** As in a real DOM: an element's own attribute, else its parent's editability ("false" stops it). */
  get isContentEditable(): boolean {
    const own = this.attrs.contenteditable;
    if (own === "false") return false;
    if (own !== undefined) return true;
    return this.parentElement ? this.parentElement.isContentEditable : false;
  }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v: string) {
    if (this.rejectsWrites) return;
    this.childNodes = [];
    this.append(new FakeText(String(v)));
  }
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
  scrollIntoView(): void {}
  dispatchEvent(event?: { type?: string }): boolean {
    // Detached, it keeps only its own style: an inherited mask is gone, as a class's would be.
    if (this.detachOnInput && event?.type === "input") this.remove();
    return true;
  }
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
    } else if (/^:modal/.test(rest)) {
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
    // -webkit-text-security is inherited, as in a real computed style.
    let masked = false;
    for (let e = el as FakeEl | null; e?.attrs; e = e.parentElement) {
      if (e.attrs.style?.includes("-webkit-text-security: disc")) { masked = true; break; }
    }
    const mask = masked ? "disc" : "none";
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

/**
 * Evaluate a shipped expression against the page, and hand back what CDP's returnByValue would.
 * `extra` binds more names for the expression — values go in as parameters, never into the code.
 */
function run(expression: string, page: Page, extra: Record<string, unknown> = {}): unknown {
  const fn = new Function(
    "window", "document", "CSS", "HTMLInputElement", "HTMLTextAreaElement", "InputEvent", "Event", ...Object.keys(extra),
    `return ${expression.trim()}`,
  );
  const value = fn(
    page.window, page.document, { escape: (s: string) => s }, class {}, class {}, FakeEvent, FakeEvent, ...Object.values(extra),
  );
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
  // After PR 側 codex on #623: masking is not only an input's. A textarea the page masks, a
  // contenteditable PIN pad, a masked span inside a button, and a textarea whose aria-labelledby
  // points at itself (spec-legal).
  const m2 = el("textarea", { id: "m2", "aria-label": "Recovery code", style: "-webkit-text-security: disc" }, ["PROBE-SECRET-6"]);
  const ce = el("div", { id: "ce", contenteditable: "true", role: "textbox", "aria-label": "PIN entry", style: "-webkit-text-security: disc" }, ["PROBE-SECRET-7"]);
  const reveal = el("button", { id: "reveal" }, ["Code: ", el("span", { style: "-webkit-text-security: disc" }, ["PROBE-SECRET-8"])]);
  const n2 = el("textarea", { id: "n2", "aria-labelledby": "n2" }, ["PROBE-AREA-SELF"]);
  const form = el("form", { id: "form" }, [
    el("p", {}, [p1]), el("p", {}, [p2]), el("p", {}, [t1]), el("p", {}, [p3]), el("p", {}, [l4, " ", p4]),
    el("p", {}, [t2]), el("p", {}, [a1]), el("p", {}, [m1]), el("p", {}, [m2]), el("p", {}, [go, s1]),
    // Inside the form, so browser_form reads the button too (win's outside read on #623).
    el("p", {}, [reveal]),
    // A submit input the page masks: its caption is drawn as dots, so it is no name (PR 側 codex on #623).
    el("p", {}, [el("input", { id: "ms", type: "submit", style: "-webkit-text-security: disc" }, [], "PROBE-SECRET-14")]),
    // A checkbox and a hidden input under a masked container: neither draws text for the style to hide.
    el("p", { style: "-webkit-text-security: disc" }, [
      el("input", { id: "cb", type: "checkbox", checked: "" }),
      el("input", { id: "hid", type: "hidden" }, [], "PAGE-TOKEN"),
      // A file input draws the chosen file's name, so the style covers it.
      el("input", { id: "fi", type: "file" }, [], "C:\\fakepath\\PROBE-FILE-1"),
    ]),
  ]);
  // Editable regions: what was typed into them is an entry, not a name (win's outside read on #623).
  const ed = el("div", { id: "ed", contenteditable: "true" }, ["PROBE-TYPED-8"]);
  const tb = el("div", { id: "tb", role: "textbox" }, ["PROBE-TYPED-9"]);
  // A second unnamed password field — "confirm password" — which must stay a separate entity, and a
  // label wrapping a textarea, whose name must not carry the textarea's text (2ゲート目 on #623).
  const p5 = el("input", { id: "p5", type: "password" }, [], "PROBE-SECRET-11");
  form.append(el("p", {}, [p5]));
  const c1 = el("textarea", { id: "c1" }, ["PROBE-AREA-C1"]);
  const lc = el("label", { id: "lc" }, ["Comment ", c1]);
  c1.labels = [lc];
  // A dialog named by a heading that holds masked text: the modal facts name it too.
  const dialog = el("div", { id: "dlg", role: "dialog", "aria-modal": "true", "aria-labelledby": "dlgt" }, [
    el("h2", { id: "dlgt" }, ["Verify ", el("span", { style: "-webkit-text-security: disc" }, ["PROBE-SECRET-13"])]),
  ]);
  // A draft in an editor: the host is the entry, and its heading and link keep their names
  // (2ゲート目 on #623: every descendant of an editing host had been an entry).
  // A typed paragraph inside it is named by its text as well — the text the screen shows, which is
  // what rule 1 says for the inside of an editor (win's outside read on #623).
  const doc = el("div", { id: "doc", contenteditable: "true" }, [
    el("h2", {}, ["Draft title"]),
    el("a", { href: "https://example.com/more" }, ["Read more"]),
    el("p", {}, ["PROBE-TYPED-15"]),
  ]);
  const body = el("body", {}, [el("h1", {}, ["RFS PW PAGE 2"]), form, ce, n2, ed, tb, lc, dialog, doc]);
  body.descendants().forEach((e, i) => { e.rect = { left: 10, top: 10 + i * 24, width: 160, height: 20 }; });
  return { body, p1, p2, p3, p4, p5, t1, t2, a1, m1, m2, ce, n2, ed, tb, c1 };
}

const PROBE = /PROBE-[A-Z0-9-]*[A-Z0-9]/g;
/** A text field's value may still come back as its VALUE — so each cell names what it allows. */
const TEXT_VALUES = ["PROBE-TEXT-9", "PROBE-TYPED-7", "PROBE-AREA-NOW", "PROBE-AREA-SELF", "PROBE-AREA-C1"];

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
    return run(`(function(){ ${ELEMENT_NAME_JS} return __fieldName(document.getElementById(subjectId)); })()`, page, { subjectId: el.attrs.id }) as string;
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
    // A textarea pointing at itself: its own text node is its value (PR 側 codex on #623, P2).
    const selfArea = new FakeEl("textarea", { id: "sa", "aria-labelledby": "sa" }, ["PROBE-AREA-SELF2"]);
    // A reference to something the page masks gives nothing either.
    const hidden = new FakeEl("span", { id: "hs", style: "-webkit-text-security: disc" }, ["PROBE-SECRET-10"]);
    const toHidden = new FakeEl("input", { id: "rh", "aria-labelledby": "hs" });
    // An editor inside a label is an entry too: its typed text stays out of the label's name.
    const bio = new FakeEl("input", { id: "bio" });
    bio.labels = [new FakeEl("label", {}, ["Bio ", new FakeEl("div", { contenteditable: "true" }, ["PROBE-TYPED-10"])])];
    fixture.body.append(wrap).append(self).append(selfArea).append(hidden).append(toHidden).append(bio);
    expect(await nameOf(area)).toBe("Notes");
    expect(await nameOf(self)).toBe("");
    expect(await nameOf(selfArea)).toBe("");
    expect(await nameOf(toHidden)).toBe("");
    expect(await nameOf(bio)).toBe("Bio");
  });

  it("names a button-type input by its labels, then its caption; an image input by alt, never its value", async () => {
    // HTML-AAM §4.1.2 and §4.1.3 (win's outside read on #623): labels come first for these too,
    // and an image input's value is not its name.
    const submit = new FakeEl("input", { id: "b1", type: "submit" }, [], "Log in");
    const image = new FakeEl("input", { id: "b2", type: "image", alt: "Search" }, [], "PROBE-IMG");
    const labelled = new FakeEl("input", { id: "b3", type: "submit" }, [], "Submit");
    labelled.labels = [new FakeEl("label", {}, ["Pay now"])];
    const bare = new FakeEl("input", { id: "b4", type: "image" }, [], "PROBE-IMG2");
    fixture.body.append(submit).append(image).append(labelled).append(bare);
    expect(await nameOf(submit)).toBe("Log in");
    expect(await nameOf(image)).toBe("Search");
    expect(await nameOf(labelled)).toBe("Pay now");
    expect(await nameOf(bare)).toBe("");
  });
});

describe("the tools win2 measured leak nothing the page masks", () => {
  it("desktop_discover labels each field by its name, or by its type when it has none", async () => {
    const { fetchBrowserCandidates } = await import("../../src/tools/desktop-providers/browser-provider.js");
    const result = await fetchBrowserCandidates({ tabId: "tab-1" } as TargetSpec);
    const labels = Object.fromEntries(result.candidates.map((c) => [c.locator?.cdp?.selector, c.label]));
    expect(labels).toMatchObject({
      "#p1": "input[password] #p1", "#p2": "Password", "#t1": "input[text] #t1", "#p3": "Account password",
      "#p4": "PASSCODE-LABEL", "#t2": "Search", "#a1": "textarea #a1", "#m1": "PIN", "#s1": "Log in",
      "#m2": "Recovery code", "#reveal": "Code:", "#n2": "textarea #n2", "#p5": "input[password] #p5",
      "#c1": "Comment", "#ms": "input[submit] #ms",
    });
    // Two unnamed fields of one type stay two: a CDP candidate has no rect, so the label is the key.
    const allLabels = result.candidates.map((c) => c.label);
    expect(new Set(allLabels).size).toBe(allLabels.length);
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
    for (const name of ["Account password", "PASSCODE-LABEL", "Search", "Password", "PIN", "Log in", "Recovery code", "Code:", "Read more"]) {
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
    // The modal facts name the dialog from its heading, without the masked text in it.
    expect(JSON.stringify(facts)).toContain('"name":"Verify"');
  });

  it("browser_search's results carry no value, on the axis that lists every field", async () => {
    const { buildCandidateCollectionJs } = await import("../../src/tools/browser-resolver.js");
    for (const [by, pattern] of [["selector", "input, textarea"], ["regex", "."]] as const) {
      const found = run(buildCandidateCollectionJs({
        by, pattern, maxResults: 50, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false,
      }), page);
      // The one PROBE allowed is the typed paragraph inside the editor, named by the text it shows —
      // and only as that paragraph's whole name, never inside a longer one (win's outside read).
      expect(leaked(JSON.stringify(found), ["PROBE-TYPED-15"]), by).toEqual([]);
      for (const r of (found as { results?: Array<{ text: string }> }).results ?? []) {
        if (r.text.includes("PROBE-TYPED-15")) expect(r.text, by).toBe("PROBE-TYPED-15");
      }
    }
    // The decision, pinned: inside an editor a paragraph's name is its text, typed or not.
    const typed = run(buildCandidateCollectionJs({
      by: "text", pattern: "TYPED-15", maxResults: 50, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false,
    }), page) as { results: Array<{ text: string }> };
    expect(typed.results.map((r) => r.text)).toEqual(["PROBE-TYPED-15"]);
    // A label found by its text is named without the textarea inside it (2ゲート目 on #623).
    const comment = run(buildCandidateCollectionJs({
      by: "text", pattern: "Comment", maxResults: 50, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false,
    }), page) as { results: Array<{ text: string }> };
    expect(comment.results.map((r) => r.text)).toEqual(["Comment"]);
    // A heading inside an editor keeps its name: only the editing host is an entry.
    const draft = run(buildCandidateCollectionJs({
      by: "text", pattern: "Draft", maxResults: 50, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false,
    }), page) as { results: Array<{ text: string }> };
    expect(draft.results.map((r) => r.text)).toEqual(["Draft title"]);
    // The text axes do not match what the page masks: a hit would answer what the hidden text says.
    for (const by of ["text", "regex"] as const) {
      const found = run(buildCandidateCollectionJs({
        by, pattern: "SECRET", maxResults: 50, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false,
      }), page) as { total: number };
      expect(found.total, by).toBe(0);
    }
  });

  it("browser_form withholds a masked field's value, says whether it holds one, and keeps the rest", async () => {
    const { browserGetFormHandler } = await import("../../src/tools/browser.js");
    const text = textOf(await browserGetFormHandler({
      selector: "#form", includeHidden: false, maxResults: 50, port: 9222, includeContext: false,
    }));
    const fields = Object.fromEntries((JSON.parse(text) as { fields: Array<Record<string, unknown>> }).fields.map((f) => [f.id, f]));
    for (const id of ["p1", "p2", "p3", "p4", "p5", "m1", "m2", "ms"]) {
      expect(fields[id], id).toMatchObject({ value: null, valueWithheld: "masked", hasValue: true });
    }
    expect(fields.t1).toMatchObject({ value: "PROBE-TEXT-9" });
    // A button's value is its text, without the masked span inside it.
    expect(fields.reveal).toMatchObject({ value: "Code:" });
    // A checkbox keeps its checked state under a masked container.
    expect(fields.cb).toMatchObject({ checked: true });
    expect(fields.cb).not.toHaveProperty("valueWithheld");
    // …and a hidden input, when the caller asks for hidden ones, keeps its value.
    const withHidden = textOf(await browserGetFormHandler({
      selector: "#form", includeHidden: true, maxResults: 50, port: 9222, includeContext: false,
    }));
    const hiddenFields = (JSON.parse(withHidden) as { fields: Array<Record<string, unknown>> }).fields;
    expect(hiddenFields.find((f) => f.id === "hid")).toMatchObject({ value: "PAGE-TOKEN" });
    // …while a file input under it, which draws the chosen file's name, is withheld.
    expect(hiddenFields.find((f) => f.id === "fi")).toMatchObject({ value: null, valueWithheld: "masked" });
    expect(leaked(withHidden, TEXT_VALUES)).toEqual([]);
    expect(fields.t1).not.toHaveProperty("valueWithheld");
    expect(fields.p4.label).toBe("PASSCODE-LABEL");
    expect(leaked(text, TEXT_VALUES)).toEqual([]);
  });

  it("desktop_state's CDP read gives no masked value, and no field's text as its name", async () => {
    const { CDP_FOCUSED_ELEMENT_SCRIPT, buildElementInfoFromCdp } = await import("../../src/tools/desktop-state.js");
    const focus = (el: FakeEl) => buildElementInfoFromCdp(run(CDP_FOCUSED_ELEMENT_SCRIPT, pageWith(fixture.body, el)) as object);
    expect(focus(fixture.p1)).toEqual({ name: "p1", type: "INPUT" });
    expect(focus(fixture.m1)).toEqual({ name: "m1", type: "INPUT" });
    expect(focus(fixture.m2)).toEqual({ name: "m2", type: "TEXTAREA" });
    // A masked contenteditable has no value, and its text is not offered as its name.
    expect(focus(fixture.ce)).toEqual({ name: "ce", type: "DIV" });
    // An editor's typed text is not offered as its name either (win's outside read on #623).
    expect(focus(fixture.ed)).toEqual({ name: "ed", type: "DIV" });
    expect(focus(fixture.tb)).toEqual({ name: "tb", type: "DIV" });
    // With no id and no name the text is next in line, so only an unnamed editor shows the leak
    // (win's note on the arm's design).
    const bare = new FakeEl("div", { contenteditable: "true" }, ["PROBE-TYPED-12"]);
    const bareBox = new FakeEl("div", { role: "textbox" }, ["PROBE-TYPED-13"]);
    fixture.body.append(bare).append(bareBox);
    expect(focus(bare)).toEqual({ name: "DIV", type: "DIV" });
    expect(focus(bareBox)).toEqual({ name: "DIV", type: "DIV" });
    // An unnamed element that is not an entry is named by its text — without the masked text or
    // the editor inside it (win's outside read on #623: this read innerText).
    const box = new FakeEl("div", {}, [
      "Card ",
      new FakeEl("span", { style: "-webkit-text-security: disc" }, ["PROBE-SECRET-12"]),
      new FakeEl("div", { contenteditable: "true" }, ["PROBE-TYPED-14"]),
    ]);
    fixture.body.append(box);
    expect(focus(box)).toEqual({ name: "Card", type: "DIV" });
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
    expect(refused).toContain("valueWithheld");
    expect(refused).not.toContain("PROBE-SECRET-1");
    // …nor the value the caller passed: a copy in a transcript is still a copy (win2's round on #623).
    expect(refused).not.toContain("PROBE-NEW-1");
    const filled = JSON.stringify(await browserFillInputHandler({ selector: "#p2", value: "PROBE-NEW-2", port: 9222, includeContext: false }));
    expect(filled).toContain("valueWithheld");
    expect(filled).not.toContain("PROBE-NEW-2");
    expect(filled).not.toContain('\\"actual\\"');
    fixture.m2.rejectsWrites = true;
    const area = JSON.stringify(await browserFillInputHandler({ selector: "#m2", value: "PROBE-NEW-6", port: 9222, includeContext: false }));
    expect(area).toContain("valueWithheld");
    expect(area).not.toContain("PROBE-SECRET-6");
    expect(area).not.toContain("PROBE-NEW-6");
    // The control: a text field still echoes what was filled, and what the page kept.
    const text = JSON.stringify(await browserFillInputHandler({ selector: "#t1", value: "PROBE-NEW-9", port: 9222, includeContext: false }));
    expect(text).toContain("PROBE-NEW-9");
    expect(text).not.toContain("valueWithheld");
  });

  it("browser_fill decides masking before the page's handlers run, which can replace the field", async () => {
    // A field masked by its container, replaced by a keyed controlled component on `input`: after
    // the event the old node is detached and shows no mask, so a check made only then read the
    // field as plain and returned what the page kept (PR 側 codex on #623).
    const { browserFillInputHandler } = await import("../../src/tools/browser.js");
    const { buildFillActJs } = await import("../../src/tools/browser-resolver.js");
    const place = () => {
      const card = new FakeEl("input", { id: "card", type: "text", "aria-label": "Card number" }, [], "PROBE-SECRET-15");
      card.rejectsWrites = true;
      card.detachOnInput = true;
      fixture.body.append(new FakeEl("p", { style: "-webkit-text-security: disc" }, [card]));
      card.rect = { left: 10, top: 900, width: 160, height: 20 };
      return card;
    };
    place();
    const bySelector = JSON.stringify(await browserFillInputHandler({ selector: "#card", value: "PROBE-NEW-15", port: 9222, includeContext: false }));
    expect(bySelector).toContain("valueWithheld");
    expect(bySelector).not.toContain("PROBE-SECRET-15");
    fixture = loginPage();
    page = pageWith(fixture.body);
    place();
    const byAxis = run(buildFillActJs(
      { by: "ariaLabel", pattern: "Card number", caseSensitive: false },
      0, 0, "PROBE-NEW-15",
      { name: "Card number", role: null, ariaLabel: "Card number", tag: "input", total: 1 },
    ), page);
    expect(byAxis).toMatchObject({ ok: true, actualWithheld: true });
    expect(JSON.stringify(byAxis)).not.toContain("PROBE-SECRET-15");
  });

  it("scroll(action='to_element') reports the element's name, not an entry's text or a masked one's", async () => {
    // A fourth naming site that read textContent (win's outside read on #623).
    const { scrollToElementHandler } = await import("../../src/tools/scroll-to-element.js");
    const said = async (selector: string) => textOf(await scrollToElementHandler({ selector, block: "center", port: 9222 }));
    for (const selector of ["#a1", "#ed", "#tb", "#m2", "#ce", "#n2"]) {
      expect(leaked(await said(selector)), selector).toEqual([]);
    }
    const button = await said("#reveal");
    expect(button).toContain("Code:");
    expect(leaked(button)).toEqual([]);
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
    // A contenteditable PIN pad the page masks (PR 側 codex on #623, P1).
    fixture.ce.rejectsWrites = true;
    const pad = run(buildFillActJs(
      { by: "ariaLabel", pattern: "PIN entry", caseSensitive: false },
      0, 0, "PROBE-NEW-7",
      { name: "PIN entry", role: "textbox", ariaLabel: "PIN entry", tag: "div", total: 1 },
    ), page);
    expect(pad).toMatchObject({ ok: true, actualWithheld: true, fullMatches: false });
    expect(JSON.stringify(pad)).not.toContain("PROBE-SECRET-7");
  });
});
