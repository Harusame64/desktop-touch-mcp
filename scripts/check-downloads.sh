#!/usr/bin/env bash
# npm download stats for @harusame64/desktop-touch-mcp
# Usage: bash scripts/check-downloads.sh

PKG="@harusame64/desktop-touch-mcp"
echo "=== $PKG download stats ==="
echo ""

for period in last-day last-week last-month; do
  result=$(curl -s "https://api.npmjs.org/downloads/point/$period/$PKG")
  count=$(echo "$result" | grep -o '"downloads":[0-9]*' | cut -d: -f2)
  if [ -n "$count" ]; then
    printf "%-12s %s\n" "$period:" "$count"
  else
    error=$(echo "$result" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
    printf "%-12s %s\n" "$period:" "(no data — $error)"
  fi
done

echo ""
echo "--- Daily breakdown (last 30 days) ---"
end=$(date +%Y-%m-%d)
start=$(date -d "-30 days" +%Y-%m-%d 2>/dev/null || date -v-30d +%Y-%m-%d 2>/dev/null)
if [ -n "$start" ]; then
  range_result=$(curl -s "https://api.npmjs.org/downloads/range/$start:$end/$PKG")
  echo "$range_result" | python -c "
import json,sys
try:
    d=json.load(sys.stdin)
    days=d.get('downloads',[])
    total=0
    for day in days:
        dl=day['downloads']
        if dl>0:
            print(f\"  {day['day']}: {dl}\")
        total+=dl
    print(f\"\n  Total (30d): {total}\")
    if not days:
        print('  (no data yet)')
except Exception as e:
    print(f'  (parse error: {e})')
" 2>&1
else
  echo "  (date calculation not available on this platform)"
fi
