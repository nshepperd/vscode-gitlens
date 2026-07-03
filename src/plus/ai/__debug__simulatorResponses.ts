import type { AIActionType } from '@gitlens/ai/models/model.js';
import type { AIChatMessage } from '@gitlens/ai/models/provider.js';
import type { PlanStrategy } from './__debug__simulatorState.js';

const summarized = (summary: string, body: string) => `<summary>${summary}</summary><body>${body}</body>`;

const explainBody = `## Summary
The simulated AI explanation reaches the configured surface end-to-end.

## Highlights
- Wiring verified
- Markdown renders
- Surface receives content`;

const reviewOverviewDefault = `<overview>Simulated review overview. Two focus areas were identified for verification purposes.</overview>
<area severity="suggestion" files="src/example.ts">
<label>Simulated focus area</label>
<rationale>This area exists so the review UI has something to render. Do not interpret semantically.</rationale>
<findings>
<finding severity="suggestion" file="src/example.ts" lines="1-10">
<title>Simulated finding</title>
<description>Placeholder finding content for the live verification flow.</description>
</finding>
</findings>
</area>`;

const reviewDetailDefault = `<findings>
<finding severity="suggestion" file="src/example.ts" lines="1-10">
<title>Simulated detail finding</title>
<description>Placeholder detail finding content for the live verification flow.</description>
</finding>
</findings>`;

// generate-commits has no synthesizable default — the validator demands hunk-index
// conservation against the prompt's hunkMap, which we cannot derive without prompt parsing.
// Returning an obviously-rejected payload makes the no-inject failure mode predictable.
const generateCommitsRejection = `{"commits":[]}`;

// Plain string-keyed map — TS gets confused by Record/Map when the key union contains a template
// literal (`generate-create-${...}`), even though all keys are valid AIActionType members.
const defaults: { readonly [key: string]: string | undefined } = {
	'explain-changes': summarized('Simulated explanation', explainBody),
	'review-changes': reviewOverviewDefault,
	'generate-commitMessage': summarized('Simulated commit message', 'Deterministic body for verification.'),
	'generate-stashMessage': summarized('Simulated stash message', 'WIP — simulated.'),
	'generate-changelog': summarized('Simulated changelog', '## Changes\n- Simulated entry'),
	'generate-create-cloudPatch': summarized('Simulated cloud patch description', 'Simulated patch body.'),
	'generate-create-codeSuggestion': summarized('Simulated code suggestion', 'Simulated suggestion body.'),
	'generate-create-pullRequest': summarized('Simulated pull request', '## Summary\n- Simulated PR body'),
	'generate-commits': generateCommitsRejection,
	'generate-searchQuery': 'message:simulated',
};

export function getDefaultResponse(action: AIActionType): string {
	return defaults[action] ?? `<summary>Unhandled simulated action</summary><body>${action}</body>`;
}

// Used when mode === 'invalid'. Composer's validator will reject this; parser-tolerant
// actions will simply render garbage (which is the documented behavior for that mode).
export function getInvalidResponse(action: AIActionType): string {
	if (action === 'generate-commits') return `{"commits":[{"message":"invalid","hunks":[{"hunk":99999}]}]}`;
	return '<<<malformed simulator output>>>';
}

// Used when the review action is invoked in two-pass detail mode. The action type stays
// 'review-changes' but the consumer is parseReviewDetailResult, which expects findings.
export function getReviewDetailDefault(): string {
	return reviewDetailDefault;
}

interface PromptHunk {
	index: number;
	fileName: string;
}
interface HunkMapEntry {
	index: number;
	hunkHeader: string;
}
interface PromptExistingCommit {
	hunkIndices?: number[];
}

function extractTag(content: string, tag: string): string | undefined {
	return content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
}

function parseTagJson<T>(content: string, tag: string): T | undefined {
	const raw = extractTag(content, tag);
	if (raw == null) return undefined;

	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

interface ComposeToolsBranch {
	id: string;
	commits?: { id: string }[];
}

/** Trailer embedded in each synthesized commit message — own paragraph so it never disturbs the
 * summary line, but is reliably matchable with `git log --grep=<tag>` for commit-count asserts. */
function tagTrailer(tag?: string): string {
	return tag ? `\n\nSimulated-Plan: ${tag}` : '';
}

/**
 * Synthesizes a deterministic `generate-commits` response from the request's real hunks,
 * partitioning them per `strategy`. Both compose routes funnel through `sendRequest('generate-commits')`,
 * and compose-tools (graph route) runs a multi-turn conversation, so the task is detected from the
 * LAST user message's intent (not accumulated tags, which leak across turns):
 *
 *  - last user asks for `orderedCommitIds` → compose-tools `order` task — echoes the prior
 *    assistant grouping's commit ids in order.
 *  - any message has `<hunk_map>`          → GitLens legacy `generate-commits` (webview route) — flat array.
 *  - any message has `<hunks>`             → compose-tools `compose-group`/`group` task — nested branches.
 *
 * Each path conserves every hunk index by construction, so the response always passes the
 * respective validator regardless of the test's diff. Returns `undefined` (→ rejection default)
 * when the prompt can't be parsed or matches no known contract.
 */
export function synthesizeGenerateCommitsResponse(
	messages: readonly AIChatMessage[],
	strategy: PlanStrategy,
	tag?: string,
): string | undefined {
	const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
	const all = messages.map(m => m.content).join('\n\n');
	if (!all) return undefined;

	// Order is a follow-up turn referencing the prior grouping — detect it by the request's intent,
	// before the leaked `<hunks>` from earlier turns would mis-route it to grouping.
	if (lastUser.includes('orderedCommitIds')) return synthesizeOrderResponse(messages);
	if (all.includes('<hunk_map>')) return synthesizeLegacyGroupingResponse(all, strategy, tag);
	if (all.includes('<hunks>')) return synthesizeComposeGroupResponse(all, strategy, tag);
	return undefined;
}

/** GitLens legacy `generate-commits` (webview route): flat `[{message,explanation,hunks:[{hunk}]}]`. */
function synthesizeLegacyGroupingResponse(prompt: string, strategy: PlanStrategy, tag?: string): string | undefined {
	const hunkMap = parseTagJson<HunkMapEntry[]>(prompt, 'hunk_map');
	if (!Array.isArray(hunkMap) || hunkMap.length === 0) return undefined;

	const fileByIndex = hunkFileMap(prompt);
	const existingCommits = parseTagJson<PromptExistingCommit[]>(prompt, 'existing_commits') ?? [];
	const assigned = new Set<number>(existingCommits.flatMap(c => c.hunkIndices ?? []));

	// hunkMap is already in index order; preserve it so split groups stay file-position-ordered.
	const unassigned = hunkMap.map(h => h.index).filter(i => !assigned.has(i));
	if (unassigned.length === 0) return undefined;

	const trailer = tagTrailer(tag);
	const commits = partitionHunks(unassigned, fileByIndex, strategy).map((indices, i) => ({
		message: `Simulated commit ${i + 1} (${strategy})${trailer}`,
		explanation: `Deterministic simulator grouping (${strategy}) of hunks: ${indices.join(', ')}.`,
		hunks: indices.map(hunk => ({ hunk: hunk })),
	}));

	return `<output>${JSON.stringify(commits)}</output>`;
}

/**
 * compose-tools `compose-group`/`group` task (graph route): nested
 * `{branches:[{id,name,title,description,commits:[{id,message,explanation,hunks:[<number>]}]}]}`.
 * Commits-mode composition → a single branch carrying the partitioned commits.
 */
function synthesizeComposeGroupResponse(prompt: string, strategy: PlanStrategy, tag?: string): string | undefined {
	const hunks = parseTagJson<PromptHunk[]>(prompt, 'hunks');
	if (!Array.isArray(hunks) || hunks.length === 0) return undefined;

	const fileByIndex = new Map<number, string>(hunks.map(h => [h.index, h.fileName]));
	const indices = hunks.map(h => h.index);
	const trailer = tagTrailer(tag);

	const commits = partitionHunks(indices, fileByIndex, strategy).map((group, i) => ({
		id: `sim-commit-${i}`,
		message: `Simulated commit ${i + 1} (${strategy})${trailer}`,
		explanation: `Deterministic simulator grouping (${strategy}) of hunks: ${group.join(', ')}.`,
		hunks: group,
	}));

	const result = {
		branches: [
			{
				id: 'sim-branch-0',
				name: 'simulated',
				title: 'Simulated composition',
				description: `Deterministic simulator grouping (${strategy}).`,
				commits: commits,
			},
		],
	};
	return `<output>${JSON.stringify(result)}</output>`;
}

/**
 * compose-tools `order` task (graph route): `{branches:[{branchId,orderedCommitIds}],rationale}`.
 * The order request references "the branches and commits you created" rather than re-listing them,
 * so we recover the branch/commit ids from the most recent assistant grouping in the conversation
 * (falling back to a `<branches>` tag for deep-mode order) and echo each branch's commits in order.
 */
function synthesizeOrderResponse(messages: readonly AIChatMessage[]): string | undefined {
	let branches: ComposeToolsBranch[] | undefined;

	// Most recent assistant `<output>` grouping carries the ids the order task must reference.
	for (let i = messages.length - 1; i >= 0 && branches == null; i--) {
		if (messages[i].role !== 'assistant') continue;

		const out = extractTag(messages[i].content, 'output');
		if (out == null) continue;

		try {
			const parsed = JSON.parse(out) as { branches?: ComposeToolsBranch[] };
			if (Array.isArray(parsed.branches)) {
				branches = parsed.branches;
			}
		} catch {
			// keep scanning earlier assistant turns
		}
	}

	// Deep-mode order presents the grouping inline via a `<branches>` tag.
	branches ??= parseTagJson<ComposeToolsBranch[]>(messages.map(m => m.content).join('\n\n'), 'branches');
	if (!Array.isArray(branches) || branches.length === 0) return undefined;

	const result = {
		branches: branches.map(b => ({
			branchId: b.id,
			orderedCommitIds: (b.commits ?? []).map(c => c.id),
		})),
		rationale: 'Simulated deterministic ordering.',
	};
	return `<output>${JSON.stringify(result)}</output>`;
}

/** Maps each hunk index → its file name, parsed from the prompt's `<hunks>` JSON. */
function hunkFileMap(prompt: string): Map<number, string> {
	const hunks = parseTagJson<PromptHunk[]>(prompt, 'hunks') ?? [];
	return new Map<number, string>(hunks.map(h => [h.index, h.fileName]));
}

function partitionHunks(indices: number[], fileByIndex: Map<number, string>, strategy: PlanStrategy): number[][] {
	switch (strategy) {
		case 'together':
			return [indices];
		case 'separate':
			return indices.map(i => [i]);
		case 'by-file':
			return [...groupByFile(indices, fileByIndex).values()];
		case 'split-file': {
			// Split the file with the most hunks across two commits to stress multi-commit apply on
			// a single file (the data-loss/binary trap); all other hunks share one commit so every
			// index is still conserved. Falls back to `separate` when no file has 2+ hunks to split.
			const byFile = groupByFile(indices, fileByIndex);
			let target: number[] | undefined;
			for (const group of byFile.values()) {
				if (group.length >= 2 && (target == null || group.length > target.length)) {
					target = group;
				}
			}
			if (target == null) return indices.map(i => [i]);

			const targetSet = new Set(target);
			const rest = indices.filter(i => !targetSet.has(i));
			const mid = Math.ceil(target.length / 2);
			const groups: number[][] = [target.slice(0, mid), target.slice(mid)];
			if (rest.length) {
				groups.push(rest);
			}
			return groups;
		}
	}
}

function groupByFile(indices: number[], fileByIndex: Map<number, string>): Map<string, number[]> {
	const groups = new Map<string, number[]>();
	for (const i of indices) {
		const key = fileByIndex.get(i) ?? '';
		const group = groups.get(key);
		if (group != null) {
			group.push(i);
		} else {
			groups.set(key, [i]);
		}
	}
	return groups;
}
