/* eslint-disable */
// Auto-generated JS binding for desktop-touch-engine native addon.

const { existsSync } = require('fs');
const { join } = require('path');

// Try MSVC first (official publish triple per package.json), then GNU (dev toolchain).
const bindingCandidates = [
  'desktop-touch-engine.win32-x64-msvc.node',
  'desktop-touch-engine.win32-x64-gnu.node',
];

let nativeBinding = null;
let lastError = null;
const triedPaths = [];

for (const name of bindingCandidates) {
  const bindingPath = join(__dirname, name);
  triedPaths.push(bindingPath);
  if (!existsSync(bindingPath)) continue;
  try {
    nativeBinding = require(bindingPath);
    break;
  } catch (e) {
    lastError = e;
  }
}

if (!nativeBinding) {
  throw new Error(
    'Failed to load desktop-touch-engine native addon. ' +
    `Tried: ${triedPaths.join(', ')}. ` +
    (lastError ? `Last load error: ${lastError.message}` : 'No matching .node binary found for this platform.')
  );
}

const { computeChangeFraction, dhashFromRaw, hammingDistance } = nativeBinding;

module.exports.computeChangeFraction = computeChangeFraction;
module.exports.dhashFromRaw = dhashFromRaw;
module.exports.hammingDistance = hammingDistance;

// ─── UIA (Windows-only) ─────────────────────────────────────────────────────
// These are available only when the .node binary was compiled on Windows.
// Each is guarded so non-Windows builds don't throw at import time.

if (typeof nativeBinding.uiaGetElements === 'function') {
  module.exports.uiaGetElements = nativeBinding.uiaGetElements;
}
if (typeof nativeBinding.uiaGetFocusedAndPoint === 'function') {
  module.exports.uiaGetFocusedAndPoint = nativeBinding.uiaGetFocusedAndPoint;
}
if (typeof nativeBinding.uiaGetFocusedElement === 'function') {
  module.exports.uiaGetFocusedElement = nativeBinding.uiaGetFocusedElement;
}
if (typeof nativeBinding.uiaScrollIntoView === 'function') {
  module.exports.uiaScrollIntoView = nativeBinding.uiaScrollIntoView;
}
if (typeof nativeBinding.uiaGetScrollAncestors === 'function') {
  module.exports.uiaGetScrollAncestors = nativeBinding.uiaGetScrollAncestors;
}
if (typeof nativeBinding.uiaScrollByPercent === 'function') {
  module.exports.uiaScrollByPercent = nativeBinding.uiaScrollByPercent;
}
if (typeof nativeBinding.uiaGetVirtualDesktopStatus === 'function') {
  module.exports.uiaGetVirtualDesktopStatus = nativeBinding.uiaGetVirtualDesktopStatus;
}

// Phase C: Actions
if (typeof nativeBinding.uiaClickElement === 'function') {
  module.exports.uiaClickElement = nativeBinding.uiaClickElement;
}
if (typeof nativeBinding.uiaSetValue === 'function') {
  module.exports.uiaSetValue = nativeBinding.uiaSetValue;
}
if (typeof nativeBinding.uiaInsertText === 'function') {
  module.exports.uiaInsertText = nativeBinding.uiaInsertText;
}
if (typeof nativeBinding.uiaGetElementBounds === 'function') {
  module.exports.uiaGetElementBounds = nativeBinding.uiaGetElementBounds;
}
if (typeof nativeBinding.uiaGetElementChildren === 'function') {
  module.exports.uiaGetElementChildren = nativeBinding.uiaGetElementChildren;
}
if (typeof nativeBinding.uiaGetTextViaTextPattern === 'function') {
  module.exports.uiaGetTextViaTextPattern = nativeBinding.uiaGetTextViaTextPattern;
}
