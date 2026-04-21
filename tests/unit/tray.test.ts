import { describe, expect, it, vi } from "vitest";

import { createTrayMessageParser } from "../../src/utils/tray.js";

describe("createTrayMessageParser", () => {
  it("emits line-delimited tray messages", () => {
    const messages: string[] = [];
    const parse = createTrayMessageParser((message) => {
      messages.push(message);
    });

    parse("READY\nEXIT\n");

    expect(messages).toEqual(["READY", "EXIT"]);
  });

  it("buffers partial chunks until a newline arrives", () => {
    const onMessage = vi.fn();
    const parse = createTrayMessageParser(onMessage);

    parse("REA");
    parse("DY\nEX");
    parse("IT\n");

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(1, "READY");
    expect(onMessage).toHaveBeenNthCalledWith(2, "EXIT");
  });

  it("normalizes CRLF and ignores blank lines", () => {
    const messages: string[] = [];
    const parse = createTrayMessageParser((message) => {
      messages.push(message);
    });

    parse("\r\nREADY\r\n\r\nEXIT\r\n");

    expect(messages).toEqual(["READY", "EXIT"]);
  });
});
