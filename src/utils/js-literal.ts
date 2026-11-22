/**
 * js-literal.ts — a value written as a literal into a script the page runs (Runtime.evaluate).
 *
 * JSON.stringify gives a valid JS literal, but leaves `<`, `>`, `/` and the line separators U+2028 / U+2029 as they
 * are. CodeQL's js/bad-code-sanitization asks for them escaped wherever text from the page is built into code: the
 * by-axis act gates write the matched element's name, role and id back into their script (CodeQL alerts 217–226).
 * Escaped as \uXXXX they read back as the same string. JSON.stringify's own rules still apply to what is not a
 * string, number, boolean, null or plain JSON data (NaN becomes null, a Date its ISO string).
 */
export function jsLiteral(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return "undefined";
  return s.replace(/[<>\u2028\u2029]|\//g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
