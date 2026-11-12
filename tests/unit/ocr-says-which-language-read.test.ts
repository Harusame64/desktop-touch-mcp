import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// internal #357: win-ocr.exe falls back to a profile language when the one asked for has no OCR pack
// installed ('en' on a Japanese machine reads with 'ja'). The reply names the engine that read.

const { exeOutput } = vi.hoisted(() => ({ exeOutput: { value: "" } }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => true };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { write: () => boolean; end: () => void }; kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => {
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from(exeOutput.value, "utf8"));
            child.emit("close", 0);
          });
        },
      });
      child.kill = () => {};
      return child;
    },
  };
});

const { runOcr, ocrLanguageUsed, ocrLanguageWarning, _resetOcrLanguageUsedForTest } = await import("../../src/engine/ocr-bridge.js");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

describe("OCR names the language that read (internal #357)", () => {
  beforeEach(() => _resetOcrLanguageUsedForTest());

  it("warns when 'en' was read with the 'ja' engine", async () => {
    exeOutput.value = '{"language":"ja","words":[{"text":"Lorem","bbox":{"x":0,"y":0,"width":10,"height":10}}]}';
    const words = await runOcr(PNG, "en");
    expect(words).toHaveLength(1);
    expect(ocrLanguageUsed("en")).toBe("ja");
    const w = ocrLanguageWarning("en");
    expect(w).toMatch(/^ocr_language_fallback: /);
    expect(w).toContain("'en'");
    expect(w).toContain("'ja' engine");
  });

  it("says nothing when the engine's tag has the same primary language (en vs en-US)", async () => {
    exeOutput.value = '{"language":"en-US","words":[]}';
    await runOcr(PNG, "en");
    expect(ocrLanguageUsed("en")).toBe("en-US");
    expect(ocrLanguageWarning("en")).toBeNull();
  });

  it("warns for a script the engine does not cover (zh-TW read by zh-Hans-CN)", async () => {
    exeOutput.value = '{"language":"zh-Hans-CN","words":[]}';
    await runOcr(PNG, "zh-TW");
    expect(ocrLanguageWarning("zh-TW")).toMatch(/^ocr_language_fallback: /);
    exeOutput.value = '{"language":"zh-Hans-CN","words":[]}';
    await runOcr(PNG, "zh");
    expect(ocrLanguageWarning("zh")).toBeNull();
  });

  it("takes a script subtag as the same language (zh-CN read by zh-Hans-CN), and a longer request too (en-US by en)", async () => {
    exeOutput.value = '{"language":"zh-Hans-CN","words":[]}';
    await runOcr(PNG, "zh-CN");
    expect(ocrLanguageWarning("zh-CN")).toBeNull();
    exeOutput.value = '{"language":"en","words":[]}';
    await runOcr(PNG, "en-US");
    expect(ocrLanguageWarning("en-US")).toBeNull();
  });

  it("looks the request up case-blind", async () => {
    exeOutput.value = '{"language":"ja","words":[]}';
    await runOcr(PNG, "en-US");
    expect(ocrLanguageWarning("en-us")).toMatch(/^ocr_language_fallback: /);
    expect(ocrLanguageUsed("EN-us")).toBe("ja");
  });

  it("forgets an earlier answer when a later exe does not say", async () => {
    exeOutput.value = '{"language":"ja","words":[]}';
    await runOcr(PNG, "en");
    exeOutput.value = '{"words":[]}';
    await runOcr(PNG, "en");
    expect(ocrLanguageWarning("en")).toBeNull();
  });

  it("claims nothing when an older win-ocr.exe does not say (control)", async () => {
    exeOutput.value = '{"words":[]}';
    await runOcr(PNG, "en");
    expect(ocrLanguageUsed("en")).toBeUndefined();
    expect(ocrLanguageWarning("en")).toBeNull();
  });

  it("reads win-ocr's missing-pack error as an error, not as bad JSON", async () => {
    exeOutput.value = '{"error":"OCR language pack not installed for: en"}';
    await expect(runOcr(PNG, "en")).rejects.toThrow("OCR language pack not installed for: en");
  });
});
