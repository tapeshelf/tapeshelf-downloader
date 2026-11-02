/**
 * Just enough XML for a DASH manifest, and usable where DOMParser is not (the service worker):
 * elements, attributes and text. Namespace prefixes are dropped (`cenc:pssh` is `pssh`).
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] === '#')
      return String.fromCodePoint(
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
      );
    return ENTITIES[name] ?? whole;
  });
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const tag =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attr = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let last = 0;
  for (let m = tag.exec(source); m; m = tag.exec(source)) {
    const top = stack[stack.length - 1]!;
    top.text += decode(source.slice(last, m.index));
    last = tag.lastIndex;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1 && stack[stack.length - 1]!.name === local(m[2])) stack.pop();
    } else if (m[3]) {
      const node: XmlNode = { name: local(m[3]), attrs: {}, children: [], text: '' };
      for (let a = attr.exec(m[4] ?? ''); a; a = attr.exec(m[4] ?? ''))
        node.attrs[local(a[1]!)] = decode(a[2] ?? a[3] ?? '');
      attr.lastIndex = 0;
      top.children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  const first = root.children[0];
  if (!first) throw new Error('not XML');
  return first;
}

/** Direct children with this name. */
export const childrenOf = (node: XmlNode | undefined, name: string): XmlNode[] =>
  node ? node.children.filter((c) => c.name === name) : [];

export const childOf = (node: XmlNode | undefined, name: string): XmlNode | undefined =>
  node?.children.find((c) => c.name === name);
