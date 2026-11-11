/**
 * internal #377 (2.4.1 dogfood): NotifyIcon.ShowBalloonTip throws on an empty text inside the detached
 * PowerShell that shows the balloon, so an empty body showed nothing and the call answered ok:true.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { notificationShowHandler, notificationShowSchema } from "../../src/tools/notification.js";

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

beforeEach(() => vi.mocked(execFile).mockClear());

describe("notification_show with an empty body", () => {
  it.each(["", "   ", "\n\t"])("is refused as InvalidArgs (%j), and no balloon is started", async (body) => {
    const r = parse(await notificationShowHandler({ title: "t", body }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("InvalidArgs");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("is refused by the schema too", () => {
    const schema = z.object(notificationShowSchema);
    expect(schema.safeParse({ title: "t", body: "" }).success).toBe(false);
    expect(schema.safeParse({ title: "t", body: "  " }).success).toBe(false);
    expect(schema.safeParse({ title: "", body: "hello" }).success).toBe(true);
  });
});
