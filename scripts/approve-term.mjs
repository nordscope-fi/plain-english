import { isMap, isSeq, parseDocument } from 'yaml';

/** A deliberate project exception for one literal term and one lexical rule. */
export function approveTerm(text, term, ruleId, reason) {
  if (!/^[A-Za-z][\w .-]{0,79}$/.test(term) || !/[\w]$/.test(term)) {
    throw new Error('Approve one short word or name, not a passage.');
  }
  if (!/^[\w-]+$/.test(ruleId) || /(?:length|count|paragraph|sentence|structure)/.test(ruleId)) {
    throw new Error('This rule checks context, not an approved term.');
  }
  if (typeof reason !== 'string' || !reason.trim() || /[\r\n\x00-\x1f]/.test(reason)) {
    throw new Error('Give a one-line reason for this project exception.');
  }
  const doc = parseDocument(text || 'version: 1\nextends: default\n');
  if (doc.errors.length) throw new Error('The project configuration cannot be parsed.');
  if (!isMap(doc.contents)) throw new Error('The project configuration must be a mapping.');
  const existing = doc.get('allow', true);
  if (existing !== undefined && !isSeq(existing)) throw new Error('The existing allow entries must be a list.');
  if (existing === undefined) doc.set('allow', doc.createNode([]));
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = doc.createNode({ pattern: `(?<![\\w])${escaped}(?![\\w])`, rules: [ruleId], ...(ruleId === 'unglossed-term' ? { semantic: true } : {}) });
  entry.commentBefore = ` Approved in Plain English review: ${reason.trim()}`;
  doc.addIn(['allow'], entry);
  return doc.toString();
}
