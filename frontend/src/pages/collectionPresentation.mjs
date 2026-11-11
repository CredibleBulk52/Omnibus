export function collectionPresentation(collection) {
  const name = collection.name || '';
  const match = name.match(/\s*\((\d{4})\s*(?:to|–|-)\s*(\d{4}|present)\)\s*$/i);
  const paragraphs = (collection.description || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs[0]?.length > 240) {
    const sentence = paragraphs[0].match(/^.{20,220}?[.!?](?:\s|$)/);
    const split = sentence ? sentence[0].length : paragraphs[0].lastIndexOf(' ', 220);
    if (split > 0) paragraphs.splice(0, 1, paragraphs[0].slice(0, split).trim(), paragraphs[0].slice(split).trim());
  }
  return { title:match ? name.slice(0, match.index) : name, dates:match ? `${match[1]}–${match[2]}` : '', lead:paragraphs[0] || '', paragraphs:paragraphs.slice(1) };
}

export function editableCollectionRules(collection) {
  if (collection.conditionGroup) {
    const group = typeof collection.conditionGroup === 'string' ? JSON.parse(collection.conditionGroup) : collection.conditionGroup;
    if (!group || !Array.isArray(group.rules)) throw new Error('Invalid rules');
    return group;
  }
  return { id:'collection-rules', type:'group', condition:'AND', rules:(collection.rules || []).map((r,i) => ({id:`rule-${i}`, field:r.field || r.type || r.rule_type, operator:r.operator || 'contains', value:r.value || r.rule_value || '', value2:r.value2 || ''})) };
}
