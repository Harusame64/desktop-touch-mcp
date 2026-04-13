# Ideals for a Desktop Automation MCP as "Eyes and Hands" for LLMs

> 2026-04-13 — Notes born from a conversation with Claude Sonnet 4.6

---

## Core Idea: Describe the World in "Meaning", Not "Coordinates"

The root cause of LLM confusion during automation is the **"fukuwarai state" — acting without understanding the context of its own actions**.
Like placing facial features on a blindfolded face, clicking based solely on coordinates.
To resolve this, what happens before and after each operation must be expressed in semantic terms.

---

## 1. State Is Made Explicit Before and After Each Operation

**Before (fukuwarai)**
```
Clicked at (1182, 141)
```

**After (ideal)**
```
Clicked "New issue" button (GitHub Issues toolbar)
→ Page navigated to: /issues/new
→ "Title" input is now focused
```

"How the world changed" is returned in words as the result of an action.
The LLM can decide its next move without needing a confirmation screenshot.

---

## 2. "Why It Happened" Is Communicated

Extend the existing `hints` philosophy further.

```json
{
  "result": "ok",
  "element": "Multiply",
  "why": "matched automationId='multiplyButton'",
  "state": "invoked",
  "windowReady": true
}
```

`state` candidates: `invoked` / `disabled` / `toggled` / `not_found`

- Pressed while `disabled`
- Triggered the next operation while still `loading`

Such "misfires" can be detected and reported in advance.

---

## 3. Lightweight Context to Know "Where Am I Now"

A mode to understand current position without a full screenshot.

```json
{
  "focusedWindow": "Calculator",
  "focusedElement": "Display area (value: '29,232')",
  "cursorNear": "equalButton",
  "pageState": "ready"
}
```

`pageState` candidates: `ready` / `loading` / `dialog` / `error`

Richer than `screenshot(detail='meta')`, far cheaper than `detail='text'`.
**"Where am I right now"** answered in a single call.

---

## 4. Recognition Results with Confidence Scores

OCR and UIA results come with "how much to trust them."

```json
{
  "name": "Harusame64 / desktop-touch-mcp",
  "source": "ocr",
  "confidence": 0.91
},
{
  "name": "Hョ「し5ョ01を64",
  "source": "ocr",
  "confidence": 0.23
}
```

For low-confidence results (e.g., below 0.5), a fallback strategy is automatically suggested.

```
confidence=0.23: OCR uncertain. Suggest: dotByDot screenshot of region or browser_eval()
```

---

## 5. Think in "Meaningful Units" of Operation

Rather than a list of individual tools, intent-based operation units would be ideal.

```
navigate_to(window="Chrome", url="...")
fill_form(window="X", fields={title: "...", body: "..."})
wait_until(window="Calculator", condition="value_changed")
```

`wait_until` is especially important. It eliminates redundant screenshots taken just to poll for a state change.

---

## 6. "Failure Explanations" Are Constructive

**Now**
```
click_element failed: SyntaxError at position 40
```

**Ideal**
```
click_element failed: element "Text Editor" found but
  InvokePattern not supported on Document type.
  → Try: mouse_click(clickAt) or set_element_value() instead
```

When something fails, hints tell the LLM "what to try next."
LLMs can learn from failure — but they need the information to do so.

---

## 7. "Environment Context" Is Cached Once

Learns and caches window structure within the session. Only deltas are returned after the initial snapshot — the UIA equivalent of a P-frame in video codecs.

```
# First call: full UIA fetch (expensive)
get_ui_elements(windowTitle="Calculator")

# Subsequent calls: deltas only
get_ui_elements(windowTitle="Calculator", cached=true)
→ "Using cached layout (3s ago). Changed: display value '0' → '29,232'"
```

---

## Summary

| Now | Ideal |
|---|---|
| Operate by coordinates | Operate by name / meaning |
| Only result returned | Result + reason + next step returned |
| Failure is an exception message | Failure includes suggestions |
| Full fetch every time | Delta / cache utilized |
| OCR output is flat | With confidence scores |
| "Where am I" requires screenshot | Lightweight context API |

---

## In One Line

> Not a tool where the LLM "operates while thinking," but a tool where the LLM can **"think while operating."**
