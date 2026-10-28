import fs from 'node:fs/promises';
import { anchorRequests } from '../server/bilibili-anchor.js';
import { actionEvidence, validateAction } from '../server/family-source-bundle.js';

// Offline conversion only; neither starts readers nor clears platform pauses.
async function main() {
  const [input, objects] = process.argv.slice(2);
  if (!input || !objects || process.argv.length !== 4)
    throw new Error('Use anchor-requests.ts anchor.json evidence-objects-directory');
  const anchor = JSON.parse((await fs.readFile(input, 'utf8')).replace(/^\uFEFF/, ''));
  const result = anchorRequests(anchor);
  await actionEvidence(
    validateAction({
      action_type: 'search',
      target_platform: 'douyin',
      family_id: anchor.family_id,
      query: 'anchor-validation',
      purpose: 'find_original_reference',
      evidence_refs: result.context.evidence_refs,
      query_layer: 'rule_seed',
      is_actual_search_log: false,
    }),
    objects,
  );
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
