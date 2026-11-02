/**
 * A JSON object a page assigns in a script (`window.__INITIAL_STATE__={…};(function…`): from the
 * first brace after the marker to its matching one, strings and escapes respected. JavaScript's
 * `undefined` outside strings (some pages write their state with it) reads as null.
 */
export function jsonAfter(html: string, marker: string): unknown {
  const at = html.indexOf(marker);
  if (at < 0) return undefined;
  const start = html.indexOf('{', at + marker.length);
  if (start < 0) return undefined;
  let depth = 0;
  let quote = '';
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(withoutUndefined(html.slice(start, i + 1)));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function withoutUndefined(source: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      out += c;
      if (c === '\\') out += source[++i] ?? '';
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (
      source.startsWith('undefined', i) &&
      !/[\w$]/.test(source[i - 1] ?? '') &&
      !/[\w$]/.test(source[i + 9] ?? '')
    ) {
      out += 'null';
      i += 8;
    } else out += c;
  }
  return out;
}
