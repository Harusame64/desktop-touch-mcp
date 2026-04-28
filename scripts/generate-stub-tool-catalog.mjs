import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const toolsDir = path.join(root, 'src', 'tools');
const outPath = path.join(root, 'src', 'stub-tool-catalog.ts');

const TOOL_FILES = [
  'browser.ts', 'clipboard.ts', 'desktop-state.ts', 'dock.ts', 'server-status.ts', 'events.ts',
  'keyboard.ts', 'macro.ts', 'mouse.ts', 'notification.ts', 'perception.ts', 'pin.ts',
  'screenshot.ts', 'scroll-capture.ts', 'scroll-to-element.ts', 'smart-scroll.ts',
  'terminal.ts', 'ui-elements.ts', 'wait-until.ts', 'window.ts', 'workspace.ts',
  // Phase 2 dispatchers
  'window-dock.ts',
  'scroll.ts',
];

function buildDesc(d) {
  const parts = [`Purpose: ${d.purpose}`, `Details: ${d.details}`];
  if (d.prefer) parts.push(`Prefer: ${d.prefer}`);
  if (d.caveats) parts.push(`Caveats: ${d.caveats}`);
  if (d.examples?.length) parts.push(`Examples:\n${d.examples.map((e) => `  ${e}`).join('\n')}`);
  return parts.join('\n');
}

function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function skipTemplate(src, i) {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') {
      i += 2;
      i = scanBalanced(src, i, '{', '}');
      continue;
    }
    i++;
  }
  return i;
}

function scanBalanced(src, i, open, close) {
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(src, i); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i + 2); if (i < 0) return src.length; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === open) depth++;
    else if (c === close) depth--;
    i++;
  }
  return i;
}

function splitTopLevelArgs(s) {
  const args = [];
  let start = 0;
  let depthParen = 0, depthBrace = 0, depthBracket = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { i = skipString(s, i) - 1; continue; }
    if (c === '`') { i = skipTemplate(s, i) - 1; continue; }
    // Skip line comments (// ...) and block comments (/* ... */). Without this
    // a quote inside a comment (`// action='raw'`) would be interpreted as a
    // string start and silently swallow real commas — which broke the
    // discriminatedUnion variant split for scroll.ts (Codex PR #40 P2).
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i + 2);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const blockEnd = s.indexOf('*/', i + 2);
      i = blockEnd < 0 ? s.length : blockEnd + 1;
      continue;
    }
    if (c === '(') depthParen++;
    else if (c === ')') depthParen--;
    else if (c === '{') depthBrace++;
    else if (c === '}') depthBrace--;
    else if (c === '[') depthBracket++;
    else if (c === ']') depthBracket--;
    else if (c === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      args.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(s.slice(start).trim());
  return args;
}

function evalExpr(expr, extra = {}) {
  const context = {
    buildDesc,
    _defaultPort: 9222,
    DEFAULT_CDP_PORT: 9222,
    FLUENT_KINDS: ['target.exists', 'target.identity', 'target.title', 'target.rect', 'target.foreground', 'target.zOrder', 'modal.above', 'target.focusedElement', 'browser.url', 'browser.title', 'browser.readyState'],
    GUARD_KINDS: ['target.identityStable', 'safe.keyboardTarget', 'safe.clickCoordinates', 'stable.rect', 'browser.ready'],
    EVENT_TYPES: ['window_appeared', 'window_disappeared', 'foreground_changed'],
    ...extra,
  };
  return vm.runInNewContext(expr, context, { timeout: 1000 });
}

function parseDescription(expr) {
  try {
    return String(evalExpr(expr));
  } catch {
    const m = /^([A-Za-z_$][\w$]*)$/.exec(expr.trim());
    if (m) return undefined;
    return expr.replace(/\s+/g, ' ').slice(0, 500);
  }
}

function extractServerTools(src, file) {
  const out = [];
  let idx = 0;
  while ((idx = src.indexOf('server.tool(', idx)) >= 0) {
    const argsStart = idx + 'server.tool('.length;
    const end = scanBalanced(src, argsStart, '(', ')');
    const callBody = src.slice(argsStart, end - 1);
    const args = splitTopLevelArgs(callBody);
    if (args.length >= 3) {
      let name;
      try { name = String(evalExpr(args[0])); } catch {}
      const description = parseDescription(args[1]);
      const schemaName = /^[A-Za-z_$][\w$]*$/.test(args[2]) ? args[2] : undefined;
      if (name && description) out.push({ name, description, schemaName, file });
    }
    idx = end;
  }
  return out;
}

/**
 * Extract tools registered via server.registerTool(name, { description, inputSchema }, handler).
 * Used by Phase 2 dispatcher tools (keyboard, clipboard, window_dock, scroll, terminal).
 */
function extractRegisterTools(src, file) {
  const out = [];
  const pattern = 'server.registerTool(';
  let idx = 0;
  while ((idx = src.indexOf(pattern, idx)) >= 0) {
    const argsStart = idx + pattern.length;
    const end = scanBalanced(src, argsStart, '(', ')');
    const callBody = src.slice(argsStart, end - 1);
    const args = splitTopLevelArgs(callBody);
    if (args.length < 2) { idx = end; continue; }

    // First arg: tool name
    let name;
    try { name = String(evalExpr(args[0])); } catch { idx = end; continue; }

    // Second arg: config object { description: ..., inputSchema: ... }
    const configExpr = args[1].trim();
    if (!configExpr.startsWith('{')) { idx = end; continue; }

    // Extract description field
    const configBody = configExpr.slice(1, scanBalanced(configExpr, 1, '{', '}') - 1);

    // Find description: buildDesc({...}) or description: "..." or description: `...`
    let description;
    const descRe = /description\s*:\s*/g;
    let dm;
    while ((dm = descRe.exec(configBody)) !== null) {
      const pos = dm.index + dm[0].length;
      if (configBody.startsWith('buildDesc(', pos)) {
        try {
          const bdEnd = scanBalanced(configBody, pos + 'buildDesc('.length, '(', ')');
          const bdArg = configBody.slice(pos + 'buildDesc('.length, bdEnd - 1);
          const obj = evalExpr(`(${bdArg})`);
          description = buildDesc(obj);
        } catch { /* skip */ }
      } else {
        const q = configBody[pos];
        if (q === '"' || q === "'") {
          // Proper string extraction
          let s = '';
          let i = pos + 1;
          while (i < configBody.length && configBody[i] !== q) {
            if (configBody[i] === '\\' && i + 1 < configBody.length) {
              const esc = configBody[i + 1];
              s += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
              i += 2;
            } else { s += configBody[i++]; }
          }
          description = s;
        } else if (q === '`') {
          // Template literal — skip interpolations
          let s = '';
          let i = pos + 1;
          while (i < configBody.length && configBody[i] !== '`') {
            if (configBody[i] === '$' && configBody[i + 1] === '{') {
              let depth = 1; i += 2;
              while (i < configBody.length && depth > 0) {
                if (configBody[i] === '{') depth++;
                else if (configBody[i] === '}') depth--;
                i++;
              }
            } else { s += configBody[i++]; }
          }
          description = s;
        }
      }
      if (description) break;
    }

    // Find inputSchema: schemaName
    let schemaName;
    const isRe = /inputSchema\s*:\s*([A-Za-z_$][\w$]*)/;
    const ism = isRe.exec(configBody);
    if (ism) schemaName = ism[1];

    if (name && description) {
      out.push({ name, description, schemaName, file });
    }
    idx = end;
  }
  return out;
}

function findConstExpression(src, name) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const m = re.exec(src);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  while (/\s/.test(src[i] || '')) i++;
  if (src[i] === '{') {
    const end = scanBalanced(src, i + 1, '{', '}');
    return src.slice(i, end);
  }
  // For non-object expressions (e.g. `z.discriminatedUnion(...)`,
  // `z.object({...})`, `coercedBoolean()...`), scan forward respecting nested
  // parens / braces / brackets and string/template/comment lexemes. Stop at
  // the first `;` or unmatched newline at depth 0. Without this, the previous
  // implementation truncated multi-line expressions at the first newline,
  // which silently broke discriminatedUnion serialization in the stub catalog
  // (Codex PR #40 P2).
  const start = i;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(src, i); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i + 2);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const blockEnd = src.indexOf('*/', i + 2);
      i = blockEnd < 0 ? src.length : blockEnd + 2;
      continue;
    }
    if (c === '(') { depthParen++; i++; continue; }
    if (c === ')') { depthParen--; i++; continue; }
    if (c === '{') { depthBrace++; i++; continue; }
    if (c === '}') { depthBrace--; i++; continue; }
    if (c === '[') { depthBracket++; i++; continue; }
    if (c === ']') { depthBracket--; i++; continue; }
    if (depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      if (c === ';') break;
      if (c === '\n') {
        // Bare newline at depth 0 ends the expression unless the following
        // non-whitespace continues the call chain (rare for top-level consts).
        // Look ahead: if the next non-whitespace char is a continuation token,
        // keep going; otherwise, terminate.
        let j = i + 1;
        while (j < src.length && /[ \t]/.test(src[j])) j++;
        const next = src[j];
        if (next === '.' || next === ',' || next === ')' || next === ']') {
          i++;
          continue;
        }
        break;
      }
    }
    i++;
  }
  return src.slice(start, i).trim();
}

function splitObjectFields(objExpr) {
  const body = objExpr.trim().replace(/^\{/, '').replace(/\}$/, '');
  const fields = [];
  let start = 0;
  let depthParen = 0, depthBrace = 0, depthBracket = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") { i = skipString(body, i) - 1; continue; }
    if (c === '`') { i = skipTemplate(body, i) - 1; continue; }
    if (c === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i + 2);
      i = nl < 0 ? body.length : nl;
      continue;
    }
    if (c === '/' && body[i + 1] === '*') {
      const blockEnd = body.indexOf('*/', i + 2);
      i = blockEnd < 0 ? body.length : blockEnd + 1;
      continue;
    }
    if (c === '(') depthParen++;
    else if (c === ')') depthParen--;
    else if (c === '{') depthBrace++;
    else if (c === '}') depthBrace--;
    else if (c === '[') depthBracket++;
    else if (c === ']') depthBracket--;
    else if (c === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      const field = body.slice(start, i).trim();
      if (field) fields.push(field);
      start = i + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last) fields.push(last);
  return fields;
}

const commonParams = {
  portParam: { type: 'integer', minimum: 1, maximum: 65535, default: 9222, description: 'Chrome/Edge CDP remote debugging port.', __optional: true },
  tabIdParam: { type: 'string', description: 'Tab ID from browser_open. Omit to use the first page tab.', __optional: true },
  selectorParam: { type: 'string', description: "CSS selector for the target element (e.g. '#submit', '.btn', 'button[type=submit]')." },
  includeContextParam: { type: 'boolean', default: true, description: 'When true, append activeTab and readyState context to the response.', __optional: true },
  narrateParam: { type: 'string', enum: ['minimal', 'rich'], default: 'minimal', description: 'Narration level. rich includes UIA or browser state diff when supported.', __optional: true },
  speedParam: { type: 'integer', minimum: 0, description: 'Cursor movement speed in px/sec. 0 = instant.', __optional: true },
  homingParam: { type: 'boolean', default: true, description: 'Enable homing correction if the target window moved.', __optional: true },
  windowTitleParam: { type: 'string', description: 'Partial title of the target window.', __optional: true },
  windowTitleFocusParam: { type: 'string', description: 'Partial title of the window that should receive keyboard input.', __optional: true },
  elementNameParam: { type: 'string', description: 'Name or label of the UI element.', __optional: true },
  elementIdParam: { type: 'string', description: 'AutomationId of the UI element.', __optional: true },
  forceFocusParam: { type: 'boolean', description: 'Bypass Windows foreground-stealing protection before focusing.', __optional: true },
  trackFocusParam: { type: 'boolean', default: true, description: 'Detect if focus was stolen after the action.', __optional: true },
  settleMsParam: { type: 'integer', minimum: 0, maximum: 2000, default: 300, description: 'Milliseconds to wait before checking post-action state.', __optional: true },
  hwndParam: { type: 'string', description: 'Direct window handle ID (takes precedence over windowTitle). Obtain from get_windows response (hwnd field). String type to avoid 64-bit precision issues.', __optional: true },
  hwndFocusParam: { type: 'string', description: 'Direct window handle ID (takes precedence over windowTitle). Obtain from get_windows response (hwnd field). String type to avoid 64-bit precision issues.', __optional: true },
  methodParam: { type: 'string', enum: ['auto', 'background', 'foreground'], default: 'auto', description: 'Input method. background = WM_CHAR PostMessage (no focus change); foreground = SendInput (current default); auto = pick automatically.', __optional: true },
};

function extractDescribe(valueExpr) {
  const searchExpr = primaryCallSuffix(valueExpr);
  const idx = searchExpr.indexOf('.describe(');
  if (idx < 0) return undefined;
  const start = idx + '.describe('.length;
  const end = scanBalanced(searchExpr, start, '(', ')');
  const arg = searchExpr.slice(start, end - 1).trim();
  try { return String(evalExpr(arg)); } catch { return undefined; }
}

function topLevelZCallMatch(valueExpr, callPath) {
  const segments = callPath.split('.').map((segment) => `\\s*\\.\\s*${segment}`).join('');
  return new RegExp(`^\\s*z${segments}\\s*\\(`).exec(valueExpr);
}

function hasTopLevelZCall(valueExpr, callPath) {
  return Boolean(topLevelZCallMatch(valueExpr, callPath));
}

function primaryCallSuffix(valueExpr) {
  const m = /^\s*z(?:\s*\.\s*[A-Za-z_$][\w$]*)+\s*\(/.exec(valueExpr);
  if (!m) return valueExpr;
  const end = scanBalanced(valueExpr, m[0].length, '(', ')');
  return valueExpr.slice(end);
}

function extractEnum(valueExpr) {
  const v = valueExpr.trim();
  const m = topLevelZCallMatch(v, 'enum');
  if (!m) return undefined;
  const start = m[0].length;
  const end = scanBalanced(v, start, '(', ')');
  const arg = v.slice(start, end - 1).trim();
  try { return evalExpr(arg); } catch { return undefined; }
}

function extractArrayEnum(valueExpr) {
  const v = valueExpr.trim();
  const m = topLevelZCallMatch(v, 'array');
  if (!m) return undefined;
  const start = m[0].length;
  const end = scanBalanced(v, start, '(', ')');
  const inner = v.slice(start, end - 1).trim();
  return extractEnum(inner);
}

// Extract the body inside the outermost z.object(...) call so the caller can
// recurse into the nested shape literal. Returns undefined when the value is
// not a top-level z.object expression (e.g. z.record, z.union, primitives).
//
// Without this, nested launch / target schemas were collapsed to a bare
// {type:'object'} in the stub catalog, hiding the inner property contract
// from cross-platform tool discovery (Codex review on PR #71).
function extractZObjectInner(valueExpr) {
  const v = valueExpr.trim();
  const m = topLevelZCallMatch(v, 'object');
  if (!m) return undefined;
  const start = m[0].length;
  const end = scanBalanced(v, start, '(', ')');
  return v.slice(start, end - 1).trim();
}

function extractDefault(valueExpr) {
  const searchExpr = primaryCallSuffix(valueExpr);
  const idx = searchExpr.indexOf('.default(');
  if (idx < 0) return undefined;
  const start = idx + '.default('.length;
  const end = scanBalanced(searchExpr, start, '(', ')');
  const arg = searchExpr.slice(start, end - 1).trim();
  try { return evalExpr(arg); } catch { return undefined; }
}

function inferProperty(valueExpr) {
  const v = valueExpr.trim();
  if (commonParams[v]) return { ...commonParams[v] };
  const prop = {};
  const description = extractDescribe(v);
  if (description) prop.description = description;
  const enumValues = extractEnum(v);
  if (enumValues) { prop.type = 'string'; prop.enum = enumValues; }
  else if (hasTopLevelZCall(v, 'literal')) { prop.const = undefined; }
  else if (hasTopLevelZCall(v, 'array') || /^\[/.test(v)) {
    prop.type = 'array';
    const itemEnum = extractArrayEnum(v);
    if (itemEnum) prop.items = { type: 'string', enum: itemEnum };
  }
  else if (hasTopLevelZCall(v, 'object')) {
    // Recursively expand the inner shape literal so nested schemas (e.g.
    // browser_open.launch = z.object({browser, port, ...}).optional()) appear
    // in the stub catalog with full property contracts, instead of collapsing
    // to an opaque {type:'object'} that hides the field set from non-Windows
    // tool discovery. Codex review on PR #71 (PR #70 follow-up).
    prop.type = 'object';
    prop.additionalProperties = false;
    const innerProperties = {};
    const innerRequired = [];
    const innerExpr = extractZObjectInner(v);
    if (innerExpr && innerExpr.startsWith('{')) {
      for (const rawField of splitObjectFields(innerExpr)) {
        const field = stripLeadingTrivia(rawField);
        const fm = /^([A-Za-z_$][\w$]*|["'][^"']+["'])\s*:\s*([\s\S]*)$/.exec(field);
        if (!fm) continue;
        const rawKey = fm[1];
        const key = rawKey[0] === '"' || rawKey[0] === "'" ? rawKey.slice(1, -1) : rawKey;
        const innerValueExpr = fm[2].trim();
        const innerProp = inferProperty(innerValueExpr);
        const innerOptional = innerProp.__optional === true ||
          innerValueExpr.includes('.optional()') ||
          innerValueExpr.includes('.default(');
        delete innerProp.__optional;
        innerProperties[key] = innerProp;
        if (!innerOptional) innerRequired.push(key);
      }
    }
    prop.properties = innerProperties;
    if (innerRequired.length) prop.required = innerRequired;
  }
  else if (hasTopLevelZCall(v, 'record') || hasTopLevelZCall(v, 'discriminatedUnion') || hasTopLevelZCall(v, 'union')) { prop.type = 'object'; }
  else if (hasTopLevelZCall(v, 'coerce.number') || hasTopLevelZCall(v, 'number')) { prop.type = v.includes('.int()') ? 'integer' : 'number'; }
  else if (hasTopLevelZCall(v, 'string')) { prop.type = 'string'; }
  else if (hasTopLevelZCall(v, 'boolean') || /^coercedBoolean\s*\(/.test(v)) { prop.type = 'boolean'; }
  else { prop.description ||= `Parameter '${v}' from the Windows server schema.`; }

  const def = extractDefault(v);
  if (def !== undefined) prop.default = def;
  const modifierSuffix = primaryCallSuffix(v);
  const min = /\.min\((\d[\d_]*)\)/.exec(modifierSuffix);
  const max = /\.max\((\d[\d_]*)\)/.exec(modifierSuffix);
  if (min) {
    const value = Number(min[1].replaceAll('_', ''));
    if (prop.type === 'string') prop.minLength = value;
    else if (prop.type === 'array') prop.minItems = value;
    else if (prop.type === 'number' || prop.type === 'integer') prop.minimum = value;
  }
  if (max) {
    const value = Number(max[1].replaceAll('_', ''));
    if (prop.type === 'string') prop.maxLength = value;
    else if (prop.type === 'array') prop.maxItems = value;
    else if (prop.type === 'number' || prop.type === 'integer') prop.maximum = value;
  }
  return prop;
}

function applySchemaOverrides(schemaName, properties, required) {
  if (schemaName !== 'perceptionRegisterSchema') return;

  properties.target = {
    description: "Target entity to track. 'window' targets use Win32; 'browserTab' targets use CDP.",
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: {
        type: 'string',
        enum: ['window', 'browserTab'],
        description: "Target kind to bind this lens to.",
      },
      match: {
        type: 'object',
        additionalProperties: false,
        properties: {
          titleIncludes: {
            type: 'string',
            minLength: 1,
            description: 'Case-insensitive substring that must appear in the window or browser tab title.',
          },
          urlIncludes: {
            type: 'string',
            minLength: 1,
            description: 'Case-insensitive substring that must appear in the browser tab URL.',
          },
        },
      },
    },
    required: ['kind', 'match'],
    anyOf: [
      {
        properties: {
          kind: { const: 'window' },
          match: {
            type: 'object',
            required: ['titleIncludes'],
          },
        },
      },
      {
        properties: {
          kind: { const: 'browserTab' },
          match: {
            type: 'object',
            anyOf: [
              { required: ['urlIncludes'] },
              { required: ['titleIncludes'] },
            ],
          },
        },
      },
    ],
  };
  if (!required.includes('target')) required.push('target');
}

// ─────────────────────────────────────────────────────────────────────────────
// discriminatedUnion → JSON Schema oneOf expansion (Codex PR #40 P2 fix)
// ─────────────────────────────────────────────────────────────────────────────

// Strip leading whitespace + line/block comments. Used by parseZObjectVariant
// because the source frequently puts a `// action='xxx' — ...` annotation
// directly before each `z.object({...})` variant, and splitTopLevelArgs keeps
// those comments attached to the variant text.
function stripLeadingTrivia(s) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i + 2);
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    break;
  }
  return s.slice(i);
}

// Parse a single `z.object({...})` discriminatedUnion variant into a JSON
// Schema object. The discriminator field is rendered as `{const: literalValue}`
// so the dispatcher's required action value is preserved in the stub catalog.
function parseZObjectVariant(variantExprRaw, discriminator) {
  const variantExpr = stripLeadingTrivia(variantExprRaw);
  if (!variantExpr) return null;
  const m = /^z\s*\.\s*object\s*\(/.exec(variantExpr);
  if (!m) return null;
  const start = m[0].length;
  const end = scanBalanced(variantExpr, start, '(', ')');
  const objExpr = variantExpr.slice(start, end - 1).trim();
  if (!objExpr.startsWith('{')) return null;

  const properties = {};
  const required = [];
  for (const rawFieldVar of splitObjectFields(objExpr)) {
    // Phase 4 / Codex PR #41 P2: same leading-trivia issue as parseSchema —
    // strip before matching the key.
    const field = stripLeadingTrivia(rawFieldVar);
    const fm = /^([A-Za-z_$][\w$]*|["'][^"']+["'])\s*:\s*([\s\S]*)$/.exec(field);
    if (!fm) continue;
    const rawKey = fm[1];
    const key = rawKey[0] === '"' || rawKey[0] === "'" ? rawKey.slice(1, -1) : rawKey;
    const valueExpr = fm[2].trim();

    if (key === discriminator) {
      // Discriminator must be z.literal("xxx") per Zod contract.
      const litMatch = /^z\s*\.\s*literal\s*\(/.exec(valueExpr);
      if (litMatch) {
        const ls = litMatch[0].length;
        const le = scanBalanced(valueExpr, ls, '(', ')');
        const litArg = valueExpr.slice(ls, le - 1).trim();
        try {
          properties[key] = { const: evalExpr(litArg) };
        } catch {
          properties[key] = { type: 'string' };
        }
      } else {
        properties[key] = { type: 'string' };
      }
      required.push(key);
      continue;
    }

    const prop = inferProperty(valueExpr);
    const optional =
      prop.__optional === true ||
      valueExpr.includes('.optional()') ||
      valueExpr.includes('.default(');
    delete prop.__optional;
    properties[key] = prop;
    if (!optional) required.push(key);
  }

  const variant = { type: 'object', properties, additionalProperties: false };
  if (required.length) variant.required = required;
  return variant;
}

function parseDiscriminatedUnionSchema(rawExpr) {
  const m = /^z\s*\.\s*discriminatedUnion\s*\(/.exec(rawExpr);
  if (!m) return null;
  const argsStart = m[0].length;
  const argsEnd = scanBalanced(rawExpr, argsStart, '(', ')');
  const argsBody = rawExpr.slice(argsStart, argsEnd - 1);
  const args = splitTopLevelArgs(argsBody);
  if (args.length < 2) return null;

  let discriminator;
  try {
    discriminator = String(evalExpr(args[0]));
  } catch {
    return null;
  }

  const variantsExpr = args[1].trim();
  if (!variantsExpr.startsWith('[')) return null;
  const innerEnd = scanBalanced(variantsExpr, 1, '[', ']');
  const inner = variantsExpr.slice(1, innerEnd - 1);
  const variantExprs = splitTopLevelArgs(inner);

  const oneOf = [];
  for (const variantExpr of variantExprs) {
    const trimmed = variantExpr.trim();
    if (!trimmed) continue;
    const variantSchema = parseZObjectVariant(trimmed, discriminator);
    if (variantSchema) oneOf.push(variantSchema);
  }
  if (oneOf.length === 0) return null;
  return { type: 'object', oneOf };
}

function parseSchema(src, schemaName) {
  if (!schemaName) return { type: 'object', properties: {}, additionalProperties: false };
  const expr = findConstExpression(src, schemaName);
  if (!expr || !expr.trim().startsWith('{')) return { type: 'object', properties: {}, additionalProperties: true };
  const properties = {};
  const required = [];
  for (const rawField of splitObjectFields(expr)) {
    // splitObjectFields strips comment **content** during the scan but the
    // returned slice can still start with leading whitespace + // / /* */
    // comment lines (the scan skips them but the substring boundaries are
    // raw). Strip leading trivia before matching the field key — without
    // this, a comment block immediately before the first field caused that
    // field to silently drop (Codex PR #41 P2: includeCursor was missing
    // from desktop_state stub schema).
    const field = stripLeadingTrivia(rawField);
    const m = /^([A-Za-z_$][\w$]*|["'][^"']+["'])\s*:\s*([\s\S]*)$/.exec(field);
    if (!m) continue;
    const rawKey = m[1];
    const key = rawKey[0] === '"' || rawKey[0] === "'" ? rawKey.slice(1, -1) : rawKey;
    const valueExpr = m[2].trim();
    const prop = inferProperty(valueExpr);
    const optional = prop.__optional === true || valueExpr.includes('.optional()') || valueExpr.includes('.default(');
    delete prop.__optional;
    properties[key] = prop;
    if (!optional) required.push(key);
  }
  applySchemaOverrides(schemaName, properties, required);
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

const byName = new Map();
for (const file of TOOL_FILES) {
  const src = fs.readFileSync(path.join(toolsDir, file), 'utf8');
  for (const tool of extractServerTools(src, file)) {
    tool.inputSchema = parseSchema(src, tool.schemaName);
    byName.set(tool.name, tool);
  }
  for (const tool of extractRegisterTools(src, file)) {
    // Codex PR #40 (P2): expand discriminatedUnion into oneOf with each variant's
    // action-specific fields, instead of an opaque {action:string,
    // additionalProperties:true} stub. This restores cross-platform tool
    // discovery / validation accuracy for Phase 2/3 dispatchers.
    const rawExpr = tool.schemaName ? findConstExpression(src, tool.schemaName) : undefined;
    const isDiscrimUnion = rawExpr && /^\s*z\s*\.\s*discriminatedUnion\s*\(/.test(rawExpr);
    if (isDiscrimUnion) {
      const expanded = parseDiscriminatedUnionSchema(rawExpr.trim());
      tool.inputSchema = expanded || {
        type: 'object',
        properties: { action: { type: 'string' } },
        additionalProperties: true,
      };
    } else {
      tool.inputSchema = parseSchema(src, tool.schemaName);
    }
    byName.set(tool.name, tool);
  }
}

const tools = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
// Phase 4: 46 - 20 (10 privatized + 3 screenshot absorbed + 1 desktop_act
// absorbed + 6 desktop_state/desktop_discover absorbed) = 26 stub catalog
// entries. (Public surface = 26 stub + 2 dynamic v2 = 28 tools.)
if (tools.length < 26) {
  throw new Error(`Expected at least 26 tools, generated ${tools.length}`);
}

const header = `/**\n * Auto-generated by scripts/generate-stub-tool-catalog.mjs.\n *\n * This catalog is native-free: the non-Windows stub imports it so directory\n * hosts such as Glama can inspect the real tool descriptions and argument\n * schema without loading Win32, UIA, CDP, nut-js, or koffi modules.\n */\n\n`;
const content = header +
`export type JsonSchemaObject = {\n  type: \"object\";\n  /** Property map. Omitted when the schema uses \`oneOf\` for discriminated-union dispatchers (Phase 2/3). */\n  properties?: Record<string, unknown>;\n  required?: string[];\n  additionalProperties?: boolean;\n  /** Discriminated-union variants — one schema per dispatcher action (Phase 2/3 dispatchers). */\n  oneOf?: JsonSchemaObject[];\n};\n\n` +
`export interface StubToolCatalogEntry {\n  name: string;\n  description: string;\n  inputSchema: JsonSchemaObject;\n}\n\n` +
`export const STUB_TOOL_CATALOG: StubToolCatalogEntry[] = ${JSON.stringify(tools.map(({name, description, inputSchema}) => ({name, description, inputSchema})), null, 2)};\n\n` +
`export const STUB_TOOL_COUNT = STUB_TOOL_CATALOG.length;\n`;
fs.writeFileSync(outPath, content, 'utf8');
console.log(`Generated ${tools.length} tools -> ${path.relative(root, outPath)}`);


