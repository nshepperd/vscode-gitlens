import * as assert from 'assert';
import type { AIChatMessage } from '@gitlens/ai/models/provider.js';
import { synthesizeGenerateCommitsResponse } from '../__debug__simulatorResponses.js';
import type { PlanStrategy } from '../__debug__simulatorState.js';

/*
 * Unit tests for the AI simulator's deterministic `generate-commits` synthesizer. The synthesizer
 * parses the real hunks out of a request prompt and partitions the unassigned ones per a chosen
 * strategy, so e2e tests can drive the composer's AI flow without a real model and without
 * hand-crafting responses that mirror test-specific hunk indices.
 */

interface PromptHunk {
	index: number;
	fileName: string;
}
interface ExistingCommit {
	id: string;
	message: string;
	hunkIndices: number[];
}
interface SynthesizedCommit {
	message: string;
	explanation: string;
	hunks: { hunk: number }[];
}

/** Builds a request prompt shaped like the real `generate-commits` prompt (tags + JSON payloads). */
function buildPrompt(hunks: PromptHunk[], existingCommits: ExistingCommit[] = []): string {
	const hunkMap = hunks.map(h => ({ index: h.index, hunkHeader: `@@ hunk ${h.index} @@` }));
	const fullHunks = hunks.map(h => ({
		index: h.index,
		fileName: h.fileName,
		diffHeader: `diff --git a/${h.fileName} b/${h.fileName}`,
		hunkHeader: `@@ hunk ${h.index} @@`,
		content: `+line for hunk ${h.index}`,
		source: 'working',
	}));
	return [
		'<hunks>',
		JSON.stringify(fullHunks),
		'</hunks>',
		'<existing_commits>',
		JSON.stringify(existingCommits),
		'</existing_commits>',
		'<hunk_map>',
		JSON.stringify(hunkMap),
		'</hunk_map>',
	].join('\n');
}

function userMsg(content: string): AIChatMessage {
	return { role: 'user', content: content };
}

/** Parses the synthesized response the same way the production validator does. */
function parseOutput(response: string): SynthesizedCommit[] {
	const inner = response.match(/<output>([\s\S]*?)<\/output>/)?.[1]?.trim();
	assert.ok(inner != null, `response missing <output> wrapper: ${response}`);
	return JSON.parse(inner) as SynthesizedCommit[];
}

/** Collects every hunk index used across all commits (the conservation set). */
function usedIndices(commits: SynthesizedCommit[]): number[] {
	return commits.flatMap(c => c.hunks.map(h => h.hunk)).sort((a, b) => a - b);
}

const threeHunksTwoFiles: PromptHunk[] = [
	{ index: 0, fileName: 'a.ts' },
	{ index: 1, fileName: 'a.ts' },
	{ index: 2, fileName: 'b.ts' },
];

function synth(
	hunks: PromptHunk[],
	strategy: PlanStrategy,
	opts?: { existing?: ExistingCommit[]; tag?: string },
): SynthesizedCommit[] {
	const result = synthesizeGenerateCommitsResponse(
		[userMsg(buildPrompt(hunks, opts?.existing))],
		strategy,
		opts?.tag,
	);
	assert.ok(result != null, 'expected a synthesized response');
	return parseOutput(result);
}

suite('AI Simulator generate-commits synthesizer', () => {
	test('together: one commit holding every hunk', () => {
		const commits = synth(threeHunksTwoFiles, 'together');
		assert.strictEqual(commits.length, 1);
		assert.deepStrictEqual(usedIndices(commits), [0, 1, 2]);
	});

	test('separate: one commit per hunk', () => {
		const commits = synth(threeHunksTwoFiles, 'separate');
		assert.strictEqual(commits.length, 3);
		assert.deepStrictEqual(usedIndices(commits), [0, 1, 2]);
		assert.ok(commits.every(c => c.hunks.length === 1));
	});

	test('by-file: groups hunks by file name', () => {
		const commits = synth(threeHunksTwoFiles, 'by-file');
		assert.strictEqual(commits.length, 2);
		assert.deepStrictEqual(usedIndices(commits), [0, 1, 2]);
		// a.ts -> [0,1], b.ts -> [2]
		const sizes = commits.map(c => c.hunks.length).sort();
		assert.deepStrictEqual(sizes, [1, 2]);
	});

	test('split-file: splits the busiest file across commits, conserving all hunks', () => {
		const commits = synth(threeHunksTwoFiles, 'split-file');
		// a.ts (2 hunks) splits into [0] and [1]; b.ts's [2] rides in the "rest" commit.
		assert.strictEqual(commits.length, 3);
		assert.deepStrictEqual(usedIndices(commits), [0, 1, 2]);
		assert.ok(commits.every(c => c.hunks.length === 1));
	});

	test('conservation always holds: no missing, extra, or duplicate indices', () => {
		for (const strategy of ['together', 'separate', 'by-file', 'split-file'] as const) {
			const commits = synth(threeHunksTwoFiles, strategy);
			const used = usedIndices(commits);
			assert.deepStrictEqual(used, [0, 1, 2], `strategy ${strategy} broke conservation`);
			assert.strictEqual(new Set(used).size, used.length, `strategy ${strategy} produced duplicates`);
		}
	});

	test('excludes hunks already assigned to existing commits', () => {
		const commits = synth(threeHunksTwoFiles, 'together', {
			existing: [{ id: 'c1', message: 'existing', hunkIndices: [0] }],
		});
		// Only the unassigned hunks (1, 2) should be organized; 0 must not be reassigned.
		assert.deepStrictEqual(usedIndices(commits), [1, 2]);
	});

	test('embeds the tag as a trailer in every commit message', () => {
		const commits = synth(threeHunksTwoFiles, 'separate', { tag: 'CASE-abc123' });
		assert.ok(commits.length > 0);
		assert.ok(
			commits.every(c => c.message.includes('Simulated-Plan: CASE-abc123')),
			'every commit message should carry the tag trailer',
		);
	});

	test('finds the prompt even when a retry appends a later user message', () => {
		const messages: AIChatMessage[] = [
			userMsg(buildPrompt(threeHunksTwoFiles)),
			{ role: 'assistant', content: 'bad attempt' },
			userMsg('Please try again with a different approach.'),
		];
		const result = synthesizeGenerateCommitsResponse(messages, 'together');
		assert.ok(result != null);
		assert.deepStrictEqual(usedIndices(parseOutput(result)), [0, 1, 2]);
	});

	test('returns undefined when the prompt has no hunk_map', () => {
		const result = synthesizeGenerateCommitsResponse([userMsg('no tags here')], 'together');
		assert.strictEqual(result, undefined);
	});

	test('returns undefined when every hunk is already assigned', () => {
		const result = synthesizeGenerateCommitsResponse(
			[userMsg(buildPrompt(threeHunksTwoFiles, [{ id: 'c1', message: 'm', hunkIndices: [0, 1, 2] }]))],
			'together',
		);
		assert.strictEqual(result, undefined);
	});
});

// ----------------------------------------------------------------------------------------------
// compose-tools (graph route) tasks: compose-group/group (nested branches) and order.
// ----------------------------------------------------------------------------------------------

interface ComposeGroupResult {
	branches: {
		id: string;
		name: string;
		title: string;
		description: string;
		commits: { id: string; message: string; explanation: string; hunks: number[] }[];
	}[];
}
interface OrderResult {
	branches: { branchId: string; orderedCommitIds: string[] }[];
	rationale: string;
}

/** Builds a compose-group/group prompt: `<hunks>` JSON, no `<hunk_map>`, no `<branches>`. */
function buildComposeGroupPrompt(hunks: PromptHunk[]): string {
	const payload = hunks.map(h => ({
		index: h.index,
		fileName: h.fileName,
		hunkHeader: `@@ hunk ${h.index} @@`,
		additions: 1,
		deletions: 0,
	}));
	return ['<hunks>', JSON.stringify(payload), '</hunks>', '<commit_messages>', '[]', '</commit_messages>'].join('\n');
}

function assistantMsg(content: string): AIChatMessage {
	return { role: 'assistant', content: content };
}

// The real compose-tools `order` request — a follow-up turn that references "the branches and
// commits you created" (in conversation history) and asks for `orderedCommitIds`; it does NOT
// re-list the hunks or branches inline.
const orderRequest =
	'Based on the branches and commits you created, determine the optimal order for the commits within each branch. Return the ordered commit IDs per branch as JSON with orderedCommitIds inside <output> tags.';

/** Builds the realistic order-turn message sequence: group prompt → assistant grouping → order request. */
function buildOrderConversation(hunks: PromptHunk[], strategy: PlanStrategy): AIChatMessage[] {
	const groupPrompt = buildComposeGroupPrompt(hunks);
	const grouping = synthesizeGenerateCommitsResponse([userMsg(groupPrompt)], strategy);
	assert.ok(grouping != null, 'expected a grouping response to seed the order turn');
	return [userMsg(groupPrompt), assistantMsg(grouping), userMsg(orderRequest)];
}

function parseComposeGroup(response: string): ComposeGroupResult {
	const inner = response.match(/<output>([\s\S]*?)<\/output>/)?.[1]?.trim();
	assert.ok(inner != null, `response missing <output>: ${response}`);
	return JSON.parse(inner) as ComposeGroupResult;
}

suite('AI Simulator compose-tools (graph route) synthesizer', () => {
	test('compose-group: a single branch carrying the partitioned commits (separate)', () => {
		const response = synthesizeGenerateCommitsResponse(
			[userMsg(buildComposeGroupPrompt(threeHunksTwoFiles))],
			'separate',
			'GRAPH-1',
		);
		assert.ok(response != null);
		const result = parseComposeGroup(response);

		assert.strictEqual(result.branches.length, 1, 'commits-mode → single branch');
		const commits = result.branches[0].commits;
		assert.strictEqual(commits.length, 3, 'separate → one commit per hunk');
		// hunks are plain index arrays (not {hunk: N}); conservation holds.
		const used = commits.flatMap(c => c.hunks).sort((a, b) => a - b);
		assert.deepStrictEqual(used, [0, 1, 2]);
		assert.ok(commits.every(c => typeof c.id === 'string' && c.id.length > 0));
		assert.ok(commits.every(c => c.message.includes('Simulated-Plan: GRAPH-1')));
	});

	test('compose-group: by-file groups hunks and conserves every index (together)', () => {
		const sep = parseComposeGroup(
			synthesizeGenerateCommitsResponse([userMsg(buildComposeGroupPrompt(threeHunksTwoFiles))], 'by-file')!,
		);
		const sizes = sep.branches[0].commits.map(c => c.hunks.length).sort();
		assert.deepStrictEqual(sizes, [1, 2]); // a.ts -> [0,1], b.ts -> [2]

		const tog = parseComposeGroup(
			synthesizeGenerateCommitsResponse([userMsg(buildComposeGroupPrompt(threeHunksTwoFiles))], 'together')!,
		);
		assert.strictEqual(tog.branches[0].commits.length, 1);
		assert.deepStrictEqual(tog.branches[0].commits[0].hunks, [0, 1, 2]);
	});

	test('order: echoes the prior grouping’s commit ids per branch, in order', () => {
		const response = synthesizeGenerateCommitsResponse(
			buildOrderConversation(threeHunksTwoFiles, 'separate'),
			'separate',
		);
		assert.ok(response != null);
		const inner = response.match(/<output>([\s\S]*?)<\/output>/)?.[1]?.trim();
		const result = JSON.parse(inner!) as OrderResult;

		// 'separate' grouping → 3 commits (sim-commit-0..2) under the single sim-branch-0.
		assert.deepStrictEqual(result.branches, [
			{ branchId: 'sim-branch-0', orderedCommitIds: ['sim-commit-0', 'sim-commit-1', 'sim-commit-2'] },
		]);
		assert.ok(typeof result.rationale === 'string');
	});

	test('order is detected from the request intent despite leaked <hunks> from the grouping turn', () => {
		// Regression guard for the real bug: the order turn's conversation still contains the
		// grouping turn's `<hunks>`, but the dispatcher must produce an ORDER response (keyed on the
		// request asking for orderedCommitIds), not another grouping.
		const response = synthesizeGenerateCommitsResponse(
			buildOrderConversation(threeHunksTwoFiles, 'together'),
			'together',
		);
		assert.ok(response != null);
		assert.ok(response.includes('orderedCommitIds'), 'should be an order response');
		assert.ok(!response.includes('"hunks"'), 'must not be a grouping response');
	});
});
