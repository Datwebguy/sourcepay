import OpenAI from 'openai';

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not configured. SourcePay routes citation decisions through an LLM and will not fall back to keyword-only matching.',
    );
  }
  client = new OpenAI({ apiKey });
  return client;
}

function getModel() {
  return process.env.OPENAI_MODEL || 'gpt-5.6-luna';
}

const SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    rationale: {
      type: 'string',
      description:
        'One or two sentence explanation of the overall citation strategy for this objective and budget.',
    },
    selections: {
      type: 'array',
      description: 'One entry for every candidate source provided, in the same order.',
      items: {
        type: 'object',
        properties: {
          sourceId: { type: 'string' },
          worthCiting: {
            type: 'boolean',
            description:
              'True only if this source substantively helps answer the research objective, not just because it shares keywords.',
          },
          reason: {
            type: 'string',
            description: 'One sentence on why this source was or was not selected.',
          },
        },
        required: ['sourceId', 'worthCiting', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['rationale', 'selections'],
  additionalProperties: false,
};

const MAX_CANDIDATES = 20;
const MAX_CONTENT_CHARS = 600;

/**
 * Ask the LLM which pre-filtered candidate sources are actually worth citing for
 * this objective and budget. Candidates have already passed a keyword relevance
 * pre-filter (server/index.mjs `routeSources`) — this is the judgment layer on
 * top of that, not a replacement for it.
 */
export async function selectCitationsWithAgent({ objective, budget, candidates }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { rationale: '', decisions: new Map() };
  }

  const trimmedCandidates = candidates.slice(0, MAX_CANDIDATES);

  // Test-only: skip the live OpenAI call so the suite doesn't need a real API key.
  // Mirrors SOURCEPAY_ENABLE_SOCIAL_PROOF_MOCK. Never enable in production.
  if (process.env.SOURCEPAY_ENABLE_AGENT_MOCK === '1') {
    const decisions = new Map(
      trimmedCandidates.map((candidate) => [
        candidate.id,
        { worthCiting: true, reason: 'Test stub: SOURCEPAY_ENABLE_AGENT_MOCK=1, live agent call skipped.' },
      ]),
    );
    return {
      rationale: 'Test stub rationale (SOURCEPAY_ENABLE_AGENT_MOCK=1) — no live OpenAI call was made.',
      decisions,
    };
  }

  const openai = getClient();

  const candidatePayload = trimmedCandidates.map((candidate) => ({
    sourceId: candidate.id,
    kind: candidate.kind,
    title: candidate.title,
    priceUsdc: candidate.price,
    content: String(candidate.content ?? '').slice(0, MAX_CONTENT_CHARS),
  }));

  const response = await openai.responses.parse({
    model: getModel(),
    instructions:
      'You are SourcePay\'s citation-routing agent. A buyer has a research objective and a USDC budget. ' +
      'You are given creator-owned sources that already passed a keyword pre-filter. Decide which of them ' +
      'are genuinely worth citing to answer the objective — not just because they share words with it. ' +
      'Favor a small, precise set of sources over padding the selection to spend the whole budget. ' +
      'Return a decision for every candidate you were given.',
    input: JSON.stringify({
      objective,
      budgetUsdc: budget,
      candidates: candidatePayload,
    }),
    text: {
      format: {
        type: 'json_schema',
        name: 'citation_selection',
        schema: SELECTION_SCHEMA,
        strict: true,
      },
    },
  });

  const parsed = response.output_parsed;
  if (!parsed || !Array.isArray(parsed.selections)) {
    throw new Error('Agent returned an unparseable citation decision.');
  }

  const decisions = new Map();
  for (const selection of parsed.selections) {
    if (!selection || typeof selection.sourceId !== 'string') continue;
    decisions.set(selection.sourceId, {
      worthCiting: Boolean(selection.worthCiting),
      reason: String(selection.reason ?? ''),
    });
  }

  return {
    rationale: String(parsed.rationale ?? ''),
    decisions,
  };
}
