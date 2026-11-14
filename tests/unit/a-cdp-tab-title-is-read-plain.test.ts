/**
 * internal #406 — Chrome's `/json` list HTML-escapes a target's title, while the window's title shows it plain. A page
 * titled "… viewport & smooth …" was then not matched to its window, and its scroll left CDP for the window road
 * (win2, dev/406-spike: scroll.locomotive.ca, and local pages with &, <, >, ", ').
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { listTabs, listTabsLight, unescapeTargetTitle } from "../../src/engine/cdp-bridge.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("the tab list reads titles plain", () => {
  it("listTabs and listTabsLight give the title as the window shows it, and leave the url alone", async () => {
    const raw = [{ id: "T406-plain-title", type: "page", url: "http://h/?a=1&amp;b=2", title: "viewport &amp; smooth &lt;x&gt;" }];
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(raw))) as never;
    expect((await listTabs(9222))[0]).toMatchObject({ title: "viewport & smooth <x>", url: "http://h/?a=1&amp;b=2" });
    expect((await listTabsLight(9222))[0]).toEqual({ id: "T406-plain-title", type: "page", url: "http://h/?a=1&amp;b=2", title: "viewport & smooth <x>" });
  });
});

describe("unescapeTargetTitle", () => {
  it("the five that /json escapes come back plain", () => {
    expect(unescapeTargetTitle("Locomotive Scroll — Detection of elements in viewport &amp; smooth scrolling with parallax effects"))
      .toBe("Locomotive Scroll — Detection of elements in viewport & smooth scrolling with parallax effects");
    expect(unescapeTargetTitle("&lt;a&gt; &quot;q&quot; &#39;s&#39;")).toBe("<a> \"q\" 's'");
  });
  it("one pass: a title that reads \"&amp;\" itself (sent as \"&amp;amp;\") stays \"&amp;\"", () => {
    expect(unescapeTargetTitle("Tom &amp;amp; Jerry")).toBe("Tom &amp; Jerry");
    expect(unescapeTargetTitle("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });
  it("anything else is left as it is", () => {
    for (const t of ["", "Plain title", "AT&T", "&nbsp; &copy; &#169; &#x27;", "a & b", "&amp", "&#39"]) {
      expect(unescapeTargetTitle(t)).toBe(t);
    }
  });
});
