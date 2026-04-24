# win-ocr

C# console application wrapping Windows.Media.Ocr (WinRT).

## Input / Output

**Input**: PNG bytes on stdin.  
**Output**: JSON on stdout — `{"words": [...]}` or `{"error": "..."}`.

Each word object:
```json
{
  "text": "FANUC",
  "bbox": {"x": 10, "y": 5, "width": 50, "height": 12},
  "lineWordCount": 3,
  "lineCharCount": 23
}
```

## Line quality statistics

`lineWordCount` and `lineCharCount` are added per-word and reflect the
`OcrLine` they belong to.

| Field | Definition |
|---|---|
| `lineWordCount` | `OcrLine.Words.Count` — number of word tokens in this line |
| `lineCharCount` | `OcrLine.Text.Length` — full line text length including spaces |

These fields are consumed by `calibrateOcrConfidence()` in `ocr-bridge.ts`
to derive a **word density** quality signal:

```
wordDensity = lineWordCount / max(1, lineCharCount)
```

For a healthy ASCII line like `"FANUC Integration Service"` (3 words, 25 chars):
- density ≈ 0.12 → healthy

For an over-split line like `"F A N U C"` (5 words, 9 chars):
- density ≈ 0.56 → suspected OCR fragmentation → confidence penalty applied

CJK lines are excluded from density penalisation because single-character
tokenisation is normal (e.g. `"フ","ァ","イ","ル"` for `"ファイル"`).

## Build

```bash
cd tools/win-ocr
dotnet publish -c Release -o ../../bin/
```

Requires .NET 8+ and Windows SDK (Windows.Media.Ocr).
The resulting `../../bin/win-ocr.exe` is committed to the repository.
