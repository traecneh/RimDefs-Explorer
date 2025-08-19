// Display names derived from XML quickly
let _parser;
function parser() { return _parser ??= new DOMParser(); }

export function rootNameAttr(xml) {
  try {
    const doc = parser().parseFromString(xml, 'application/xml');
    const root = doc.firstElementChild;
    if (!root) return null;
    const name = root.getAttribute('Name');
    return name || null;
  } catch { return null; }
}

export function displayName(item) {
  if (item.defName) return item.defName;
  const label = item.tagMap?.label?.[0];
  if (label) return label;
  const nm = rootNameAttr(item.xml);
  if (nm) return nm;
  // last resort: filename sans extension
  const tail = item.path?.split('/').pop() || '';
  return tail.replace(/\.xml$/i, '') || '(unnamed)';
}
