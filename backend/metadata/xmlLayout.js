'use strict';

// Lexical positions only, AFTER strict evidence validation by the caller.
// Parsed-object serialization would lose unknown XML and lexical formatting.
function locateElements(xml) {
  const invalid = () => { const error = new Error('Unsupported XML layout'); error.code = 'UNSUPPORTED_XML'; throw error; };
  const stack = [], children = [];
  let root = null, cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) break;
    let terminator = null;
    if (xml.startsWith('<!--', start)) terminator = '-->';
    else if (xml.startsWith('<![CDATA[', start)) terminator = ']]>';
    else if (xml.startsWith('<?', start)) terminator = '?>';
    if (terminator) {
      if (terminator !== ']]>' && stack.length === 2) stack[1].hasMarkup = true;
      const end = xml.indexOf(terminator, start + 2);
      if (end < 0) invalid();
      cursor = end + terminator.length; continue;
    }
    let quote = null, end = start + 1;
    for (; end < xml.length; end++) {
      const c = xml[end];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const token = xml.slice(start, end + 1);
    if (token.startsWith('</')) {
      const node = stack.pop();
      if (!node) invalid();
      node.closeStart = start; node.end = end + 1;
    } else {
      const match = /^<([^\s/>]+)/.exec(token);
      if (!match || token.startsWith('<!')) invalid();
      const node = { name: match[1], start, openEnd: end + 1, selfClosing: /\/>$/.test(token), children: 0, hasMarkup: false };
      if (!stack.length) root = node;
      else {
        stack[stack.length - 1].children++;
        if (stack.length === 1) children.push(node);
      }
      if (node.selfClosing) { node.closeStart = end - 1; node.end = end + 1; }
      else stack.push(node);
    }
    cursor = end + 1;
  }
  if (!root || stack.length) invalid();
  return { root, children };
}

module.exports = { locateElements };
