import { validateAction, type FamilyAction } from './family-source-bundle.js';

// Platform-local conversion input. This does not define or change the central ledger contract.
export type BilibiliAnchor = {
  family_id: string;
  purpose: 'source' | 'derivative' | 'usage';
  terms: string[];
  evidence_refs: FamilyAction['evidence_refs'];
  source_hint?: { kind: 'url' | 'named' | 'quote'; value: string };
};

export function anchorRequests(anchor: BilibiliAnchor) {
  if (
    !anchor.family_id ||
    !['source', 'derivative', 'usage'].includes(anchor.purpose) ||
    !Array.isArray(anchor.terms) ||
    !anchor.terms.every((term) => typeof term === 'string') ||
    !Array.isArray(anchor.evidence_refs) ||
    !anchor.evidence_refs.length
  )
    throw new Error('Bilibili anchor requires family, purpose, terms and original evidence refs');
  const prototype: FamilyAction = validateAction({
    action_type: 'search',
    target_platform: 'douyin',
    family_id: anchor.family_id,
    query: 'anchor-validation',
    purpose: anchor.purpose === 'source' ? 'find_original_reference' : 'find_independent_uses',
    evidence_refs: anchor.evidence_refs,
    query_layer: 'rule_seed',
    is_actual_search_log: false,
  });
  const context = {
    anchor_family_id: anchor.family_id,
    purpose: anchor.purpose,
    evidence_refs: prototype.evidence_refs,
    terms: [...anchor.terms],
    source_hint: anchor.source_hint
      ? { kind: anchor.source_hint.kind, value: anchor.source_hint.value }
      : null,
    relation_status: 'candidate',
  };
  if (anchor.purpose === 'source' && !anchor.source_hint)
    return { context, searches: [], detail_url: null, stop: 'missing_source' };
  if (anchor.purpose === 'source' && anchor.source_hint?.kind === 'url') {
    const url = new URL(anchor.source_hint.value);
    if (
      url.origin !== 'https://www.douyin.com' ||
      url.href !== `https://www.douyin.com${url.pathname}` ||
      !/^\/video\/\d{8,30}$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Direct source requires canonical Douyin video URL; short/external links need explicit resolution',
      );
    return { context, searches: [], detail_url: url.href, stop: null };
  }
  if (anchor.source_hint && !['url', 'named', 'quote'].includes(anchor.source_hint.kind))
    throw new Error('Unsupported explicit source hint');
  const terms = anchor.purpose === 'source' ? [anchor.source_hint!.value] : anchor.terms;
  const searches = [...new Set(terms.map((term) => term.trim()))].map((query) =>
    validateAction({ ...prototype, query }),
  );
  return { context, searches, detail_url: null, stop: searches.length ? null : 'missing_query' };
}
