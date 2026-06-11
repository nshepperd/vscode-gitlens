import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { suite, suiteTeardown, test } from 'mocha';
import { tmpdir } from 'os';
import { env as processEnv } from 'process';
import { join } from 'path';
import type { ComposeHunk, ComposePlanResult } from '@gitkraken/compose-tools';
import { applyComposePlan, composePlan } from '@gitkraken/compose-tools';

/*
 * Regression tests for the generate/apply hunk index-space mismatch in
 * `@gitkraken/compose-tools` (delivered locally via a pnpm patch — see
 * `patches/` and `pnpm-workspace.yaml`).
 *
 * The bug: when a `hunkFilter` excludes files, the surviving hunks keep their
 * absolute (pre-filter) `index` values, while the AI plan is validated into a
 * dense 0..N-1 space over the filtered count. Apply then matches plan indices
 * against absolute hunk indices and fails with `Hunk index N not found`
 * (or, worse, silently mis-resolves where the spaces partially overlap).
 *
 * These tests run the real library workflows against real temp git repos
 * (the GitPort is backed by the git CLI) with a deterministic AiModelPort stub
 * standing in for the model — no network, no AI.
 *
 * Run with: pnpm run test:compose-tools
 */

// Ignore the user's global/system git config so the temp repos behave predictably.
const gitEnv = {
	...processEnv,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_SYSTEM: '/dev/null',
	GIT_TERMINAL_PROMPT: '0',
};

function git(repo: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd: repo,
		encoding: 'utf8',
		env: gitEnv,
		maxBuffer: 64 * 1024 * 1024,
	});
}

/** GitPort backed by the real git CLI, equivalent to GitLens's `createComposeGitPort`. */
function createGitPort(repo: string): { exec: (args: string[], options?: GitExecOptions) => Promise<string> } {
	return {
		exec: (args, options) =>
			Promise.resolve(
				execFileSync('git', args, {
					cwd: repo,
					encoding: 'utf8',
					maxBuffer: 64 * 1024 * 1024,
					env: { ...gitEnv, ...options?.env },
					input: options?.stdin,
					// Keep the library's expected-failure probes (e.g. commitlint config
					// lookups) from echoing `fatal:` noise to the test output.
					stdio: ['pipe', 'pipe', 'pipe'],
				}),
			),
	};
}
interface GitExecOptions {
	env?: Record<string, string>;
	stdin?: string;
	signal?: AbortSignal;
}

interface PromptHunk {
	index: number;
	fileName: string;
	hunkHeader: string;
	content?: string;
}

/**
 * Deterministic AiModelPort stub.
 *
 * `group` receives the hunks parsed from the prompt's `<hunks>` block and returns
 * groups of POSITIONAL indices (array positions, not `hunk.index` values) — one
 * group per commit. This emulates the real model's only coherent reading of the
 * prompt: the system prompt demands indices 0..N-1 over the N presented hunks
 * (and the library's validator rejects anything else), so the model must map
 * hunks positionally regardless of the `index` fields it was shown.
 */
function createModelStub(group: (hunks: PromptHunk[]) => number[][]) {
	const prompts: string[] = [];
	return {
		prompts: prompts,
		port: {
			generate: (params: { system?: string; messages: { role: string; content: string }[] }) => {
				const user = params.messages.at(-1)?.content ?? '';
				prompts.push(user);
				const match = user.match(/<hunks>\n?([\s\S]*?)\n?<\/hunks>/);
				if (!match) throw new Error('Model stub: no <hunks> block found in prompt');

				const hunks = JSON.parse(match[1]) as PromptHunk[];
				const commits = group(hunks).map((indices, i) => ({
					id: `commit-${i + 1}`,
					message: `Commit ${i + 1}`,
					explanation: `Test commit ${i + 1}`,
					hunks: indices,
				}));
				const output = {
					branches: [{ id: 'default', name: '', title: '', description: '', commits: commits }],
				};
				return Promise.resolve({ text: `<output>${JSON.stringify(output)}</output>` });
			},
		},
	};
}

const repos: string[] = [];

/** Creates a temp repo with `files` committed, returning the repo path and base SHA. */
function setupRepo(files: Record<string, string>): { repo: string; base: string } {
	const repo = mkdtempSync(join(tmpdir(), 'gl-compose-test-'));
	repos.push(repo);
	git(repo, 'init', '-b', 'main');
	// The library commits via the port (plain `git commit-tree` etc.), so identity must
	// come from repo config, not per-command -c flags.
	git(repo, 'config', 'user.name', 'Test');
	git(repo, 'config', 'user.email', 'test@test');
	git(repo, 'config', 'commit.gpgsign', 'false');
	git(repo, 'config', 'core.autocrlf', 'false');
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(repo, name), content);
	}
	git(repo, 'add', '-A');
	git(repo, 'commit', '-m', 'base');
	return { repo: repo, base: git(repo, 'rev-parse', 'HEAD').trim() };
}

function lines(prefix: string, count: number): string {
	return `${Array.from({ length: count }, (_, i) => `${prefix} line ${i + 1}`).join('\n')}\n`;
}

/** Appends `marker` to line `lineNo` (1-based) of `file` — a single-line, length-stable change. */
function changeLine(repo: string, file: string, lineNo: number, marker: string): void {
	const path = join(repo, file);
	const content = readFileSync(path, 'utf8').split('\n');
	content[lineNo - 1] = `${content[lineNo - 1]} ${marker}`;
	writeFileSync(path, content.join('\n'));
}

function commitsSince(repo: string, base: string): string[] {
	const out = git(repo, 'rev-list', '--reverse', `${base}..HEAD`).trim();
	return out ? out.split('\n') : [];
}

function filesOf(repo: string, sha: string): string[] {
	return git(repo, 'show', '--name-only', '--format=', sha)
		.split('\n')
		.filter(l => l.trim())
		.sort();
}

function patchOf(repo: string, sha: string): string {
	return git(repo, 'show', '--format=', sha);
}

function modifiedPaths(repo: string): string[] {
	return git(repo, 'status', '--porcelain')
		.split('\n')
		.filter(l => l.trim())
		.map(l => l.slice(3).trim())
		.sort();
}

function excludeFilter(...fileNames: string[]): (hunks: ComposeHunk[]) => ComposeHunk[] {
	const excluded = new Set(fileNames);
	// Mirrors GitLens's graph hunkFilter: filters, does NOT renumber.
	return hunks => hunks.filter(h => !excluded.has(h.fileName));
}

/** Four files, one single-hunk change each. Diff order (and thus absolute hunk
 *  index order) is lexicographic: f0=0, f1=1, f2=2, f3=3. */
function setupFourFileRepo(): { repo: string; base: string } {
	const { repo, base } = setupRepo({
		'f0.txt': lines('f0', 12),
		'f1.txt': lines('f1', 12),
		'f2.txt': lines('f2', 12),
		'f3.txt': lines('f3', 12),
	});
	changeLine(repo, 'f0.txt', 3, 'CHANGE-F0');
	changeLine(repo, 'f1.txt', 3, 'CHANGE-F1');
	changeLine(repo, 'f2.txt', 3, 'CHANGE-F2');
	changeLine(repo, 'f3.txt', 3, 'CHANGE-F3');
	return { repo: repo, base: base };
}

async function generate(
	repo: string,
	group: (hunks: PromptHunk[]) => number[][],
	hunkFilter?: (hunks: ComposeHunk[]) => ComposeHunk[],
): Promise<{ result: ComposePlanResult; prompts: string[] }> {
	const stub = createModelStub(group);
	const result = await composePlan({
		git: createGitPort(repo),
		model: stub.port,
		source: { type: 'workdir' },
		depth: 'quick',
		hunkFilter: hunkFilter,
	});
	return { result: result, prompts: stub.prompts };
}

async function apply(
	repo: string,
	result: ComposePlanResult,
	options?: {
		hunkFilter?: (hunks: ComposeHunk[]) => ComposeHunk[];
		applyCommitIds?: string[];
	},
): Promise<{ stashConflict?: unknown }> {
	const applied = await applyComposePlan({
		git: createGitPort(repo),
		applyPlan: { plan: result.plan, source: { type: 'workdir' }, snapshot: result.snapshot },
		hunkFilter: options?.hunkFilter,
		applyCommitIds: options?.applyCommitIds,
		stashLabel: 'gl-compose-test',
		authorAttribution: 'plurality',
	});
	return { stashConflict: applied.stashConflict };
}

suite('compose-tools generate/apply hunk index space', () => {
	suiteTeardown(() => {
		for (const repo of repos) {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test('baseline: full changeset (no exclusions) applies correctly', async () => {
		const { repo, base } = setupFourFileRepo();

		const { result } = await generate(repo, () => [
			[0, 1],
			[2, 3],
		]);
		const { stashConflict } = await apply(repo, result);

		assert.strictEqual(stashConflict, undefined);
		const commits = commitsSince(repo, base);
		assert.strictEqual(commits.length, 2);
		assert.deepStrictEqual(filesOf(repo, commits[0]), ['f0.txt', 'f1.txt']);
		assert.deepStrictEqual(filesOf(repo, commits[1]), ['f2.txt', 'f3.txt']);
		assert.deepStrictEqual(modifiedPaths(repo), [], 'workdir should be clean after a full apply');
	});

	test('excluding the FIRST file in diff order still applies the plan correctly', async () => {
		const { repo, base } = setupFourFileRepo();
		const filter = excludeFilter('f0.txt');

		// Survivors in absolute space: f1=1, f2=2, f3=3. Plan space (dense): f1=0, f2=1, f3=2.
		const { result } = await generate(repo, () => [[0], [1, 2]], filter);
		const { stashConflict } = await apply(repo, result, { hunkFilter: filter });

		assert.strictEqual(stashConflict, undefined);
		const commits = commitsSince(repo, base);
		assert.strictEqual(commits.length, 2);
		assert.deepStrictEqual(filesOf(repo, commits[0]), ['f1.txt']);
		assert.deepStrictEqual(filesOf(repo, commits[1]), ['f2.txt', 'f3.txt']);
		assert.deepStrictEqual(
			modifiedPaths(repo),
			['f0.txt'],
			'the excluded file’s change must survive in the workdir — and nothing else',
		);
		assert.ok(readFileSync(join(repo, 'f0.txt'), 'utf8').includes('CHANGE-F0'));
	});

	test('excluding a MIDDLE file still applies the plan correctly', async () => {
		const { repo, base } = setupFourFileRepo();
		const filter = excludeFilter('f1.txt');

		// Survivors in absolute space: f0=0, f2=2, f3=3. Plan space (dense): f0=0, f2=1, f3=2.
		const { result } = await generate(repo, () => [[0, 1], [2]], filter);
		const { stashConflict } = await apply(repo, result, { hunkFilter: filter });

		assert.strictEqual(stashConflict, undefined);
		const commits = commitsSince(repo, base);
		assert.strictEqual(commits.length, 2);
		assert.deepStrictEqual(filesOf(repo, commits[0]), ['f0.txt', 'f2.txt']);
		assert.deepStrictEqual(filesOf(repo, commits[1]), ['f3.txt']);
		assert.deepStrictEqual(modifiedPaths(repo), ['f1.txt']);
	});

	test('handoff repro: excluding all files but the LAST leaves plan [0] vs absolute [N-1]', async () => {
		const { repo, base } = setupRepo({
			'f0.txt': lines('f0', 12),
			'f1.txt': lines('f1', 12),
			'f2.txt': lines('f2', 12),
			'f3.txt': lines('f3', 12),
			'f4.txt': lines('f4', 12),
		});
		for (const f of ['f0', 'f1', 'f2', 'f3', 'f4']) {
			changeLine(repo, `${f}.txt`, 3, `CHANGE-${f.toUpperCase()}`);
		}
		const filter = excludeFilter('f0.txt', 'f1.txt', 'f2.txt', 'f3.txt');

		// One survivor: f4, absolute index 4 — the plan references it as dense index 0.
		const { result } = await generate(repo, () => [[0]], filter);
		const { stashConflict } = await apply(repo, result, { hunkFilter: filter });

		assert.strictEqual(stashConflict, undefined);
		const commits = commitsSince(repo, base);
		assert.strictEqual(commits.length, 1);
		assert.deepStrictEqual(filesOf(repo, commits[0]), ['f4.txt']);
		assert.deepStrictEqual(modifiedPaths(repo), ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt']);
	});

	test('regression guard: excluding the LAST file (spaces coincidentally align) keeps working', async () => {
		const { repo, base } = setupFourFileRepo();
		const filter = excludeFilter('f3.txt');

		// Survivors f0=0, f1=1, f2=2 — absolute already equals dense, so this case
		// works on the unpatched library too and must not regress.
		const { result } = await generate(repo, () => [[0], [1, 2]], filter);
		const { stashConflict } = await apply(repo, result, { hunkFilter: filter });

		assert.strictEqual(stashConflict, undefined);
		const commits = commitsSince(repo, base);
		assert.strictEqual(commits.length, 2);
		assert.deepStrictEqual(filesOf(repo, commits[0]), ['f0.txt']);
		assert.deepStrictEqual(filesOf(repo, commits[1]), ['f1.txt', 'f2.txt']);
		assert.deepStrictEqual(modifiedPaths(repo), ['f3.txt']);
	});

	test('hunk-level: two hunks of one file split across commits, with an exclusion shifting indices', async () => {
		const { repo, base } = setupRepo({
			'f0.txt': lines('f0', 12),
			'f2.txt': lines('f2', 30),
			'f3.txt': lines('f3', 12),
		});
		changeLine(repo, 'f0.txt', 3, 'CHANGE-F0');
		changeLine(repo, 'f2.txt', 3, 'CHANGE-TOP');
		changeLine(repo, 'f2.txt', 27, 'CHANGE-BOTTOM');
		changeLine(repo, 'f3.txt', 3, 'CHANGE-F3');
		const filter = excludeFilter('f0.txt');

		// Absolute space: f0=0, f2(top)=1, f2(bottom)=2, f3=3.
		// Plan space after excluding f0: f2(top)=0, f2(bottom)=1, f3=2.
		// Commit 1 takes f2's top hunk + f3; commit 2 takes f2's bottom hunk alone.
		const { result } = await generate(repo, () => [[0, 2], [1]], filter);
		const { stashConflict } = await apply(repo, result, { hunkFilter: filter });

		assert.strictEqual(stashConflict, undefined);
		const commits = commitsSince(repo, base);
		assert.strictEqual(commits.length, 2);

		const patch1 = patchOf(repo, commits[0]);
		assert.ok(patch1.includes('CHANGE-TOP'), 'commit 1 must contain f2’s top hunk');
		assert.ok(patch1.includes('CHANGE-F3'), 'commit 1 must contain f3’s hunk');
		assert.ok(!patch1.includes('CHANGE-BOTTOM'), 'commit 1 must NOT contain f2’s bottom hunk');

		const patch2 = patchOf(repo, commits[1]);
		assert.deepStrictEqual(filesOf(repo, commits[1]), ['f2.txt']);
		assert.ok(patch2.includes('CHANGE-BOTTOM'), 'commit 2 must contain f2’s bottom hunk');
		assert.ok(!patch2.includes('CHANGE-TOP'), 'commit 2 must NOT contain f2’s top hunk');

		assert.deepStrictEqual(modifiedPaths(repo), ['f0.txt']);
	});

	test('partial apply: applyCommitIds + exclusion commits only the selected hunks, losing nothing', async () => {
		const { repo, base } = setupFourFileRepo();
		const filter = excludeFilter('f0.txt');

		// Plan space: f1=0 (commit-1), f2=1 and f3=2 (commit-2). Apply only commit-1.
		const { result } = await generate(repo, () => [[0], [1, 2]], filter);
		const { stashConflict } = await apply(repo, result, {
			hunkFilter: filter,
			applyCommitIds: ['commit-1'],
		});

		const commits = commitsSince(repo, base);
		assert.strictEqual(commits.length, 1);
		assert.deepStrictEqual(filesOf(repo, commits[0]), ['f1.txt']);
		assert.deepStrictEqual(
			modifiedPaths(repo),
			['f2.txt', 'f3.txt'],
			'the deselected commit’s hunks must be re-applied to the workdir',
		);

		// Library design wart (independent of the index-space fix, worth raising upstream):
		// the deselected hunks are re-applied to the workdir BEFORE the stash holding the
		// excluded file's change is restored, so git refuses the auto-pop and the library
		// signals it via `stashConflict` instead. The excluded change must still be fully
		// recoverable from the labeled stash — nothing may be lost.
		assert.deepStrictEqual(stashConflict, { stashLabel: 'gl-compose-test', conflictedFiles: [] });
		assert.ok(git(repo, 'stash', 'list').includes('gl-compose-test'), 'the compose stash must survive');
		assert.ok(
			git(repo, 'stash', 'show', '-p', 'stash@{0}').includes('CHANGE-F0'),
			'the excluded file’s change must be recoverable from the stash',
		);
	});

	test('generation: the prompt presents hunks in a dense 0..N-1 index space', async () => {
		const { repo } = setupFourFileRepo();
		const filter = excludeFilter('f0.txt');

		const { prompts } = await generate(repo, () => [[0, 1, 2]], filter);

		assert.strictEqual(prompts.length, 1, 'plan should validate on the first attempt');
		const match = prompts[0].match(/<hunks>\n?([\s\S]*?)\n?<\/hunks>/);
		if (!match) throw new Error('prompt must contain a <hunks> block');

		const promptHunks = JSON.parse(match[1]) as PromptHunk[];
		assert.deepStrictEqual(
			promptHunks.map(h => h.index),
			[0, 1, 2],
			'hunk indices in the prompt must be dense and match the "indices 0 to N-1" instruction',
		);
		assert.ok(
			prompts[0].includes('Organize these 3 code hunks (indices 0 to 2)'),
			'prompt instruction must agree with the presented hunk count',
		);
	});

	test('preview invariant: plan hunkIndices resolve against the returned source hunks', async () => {
		const { repo } = setupFourFileRepo();
		const filter = excludeFilter('f0.txt');

		const { result } = await generate(repo, () => [[0], [1, 2]], filter);

		// GitLens's plan preview (libraryPlanToProposedCommits) builds a Map keyed by
		// `hunk.index` from `result.source.hunks` and looks the plan's indices up in it.
		// Every plan index must resolve, and resolution must agree with array position —
		// otherwise the preview silently drops hunks or attributes them to wrong commits.
		const hunks = result.source.hunks;
		hunks.forEach((h, i) => assert.strictEqual(h.index, i, `source hunk at position ${i} must carry index ${i}`));

		const byIndex = new Map(hunks.map(h => [h.index, h]));
		const expected: Record<string, string[]> = { 'commit-1': ['f1.txt'], 'commit-2': ['f2.txt', 'f3.txt'] };
		for (const commit of result.plan.allOrderedCommits) {
			const resolved = commit.hunkIndices.map(i => byIndex.get(i)).filter(h => h != null);
			assert.strictEqual(
				resolved.length,
				commit.hunkIndices.length,
				`every hunk index of ${commit.id} must resolve against source hunks`,
			);
			assert.deepStrictEqual(
				resolved.map(h => h.fileName).sort(),
				expected[commit.id],
				`${commit.id} must resolve to the files the stub assigned to it`,
			);
		}
	});

	/*
	 * Untracked files are stored in a stash's THIRD parent (`stash^3`), not in the stash
	 * commit's main tree. The library's post-apply stash restore has a tree-equivalence
	 * shortcut that compares only the MAIN tree against the new state — so when every
	 * tracked change was committed but an excluded UNTRACKED file survived only in the
	 * stash, the shortcut wrongly concluded "all content represented" and dropped the
	 * stash, silently destroying the only copy of the file.
	 */
	suite('untracked files across apply', () => {
		test('an excluded untracked file must survive apply (data-loss regression)', async () => {
			// Mirrors the reported flow: from a root commit, create file `a` (staged) and
			// file `b` (untracked), compose, deselect `b`, accept the generated commits.
			const { repo, base } = setupRepo({ 'root.txt': lines('root', 3) });
			writeFileSync(join(repo, 'a'), 'aaa\n');
			writeFileSync(join(repo, 'b'), 'lol\n');
			git(repo, 'add', 'a');
			const filter = excludeFilter('b');

			const { result } = await generate(repo, hunks => [hunks.map((_, i) => i)], filter);
			const { stashConflict } = await apply(repo, result, { hunkFilter: filter });

			const commits = commitsSince(repo, base);
			assert.strictEqual(commits.length, 1);
			assert.deepStrictEqual(filesOf(repo, commits[0]), ['a']);

			assert.strictEqual(readFileSync(join(repo, 'b'), 'utf8'), 'lol\n', 'b must survive on disk');
			assert.deepStrictEqual(modifiedPaths(repo), ['b'], 'b must be back in the working tree, untracked');
			assert.strictEqual(stashConflict, undefined);
			assert.strictEqual(git(repo, 'stash', 'list').trim(), '', 'the compose stash must be consumed');
		});

		test('composing staged + untracked files together still ends clean', async () => {
			const { repo, base } = setupRepo({ 'root.txt': lines('root', 3) });
			writeFileSync(join(repo, 'a'), 'aaa\n');
			writeFileSync(join(repo, 'b'), 'lol\n');
			git(repo, 'add', 'a');

			const { result } = await generate(repo, hunks => [hunks.map((_, i) => i)]);
			const { stashConflict } = await apply(repo, result);

			const commits = commitsSince(repo, base);
			assert.strictEqual(commits.length, 1);
			assert.deepStrictEqual(filesOf(repo, commits[0]), ['a', 'b']);
			assert.deepStrictEqual(modifiedPaths(repo), [], 'workdir should be clean after a full apply');
			assert.strictEqual(stashConflict, undefined);
			assert.strictEqual(git(repo, 'stash', 'list').trim(), '', 'the compose stash must be consumed');
		});

		test('excluded tracked modification + included untracked file are both preserved', async () => {
			const { repo, base } = setupRepo({ 't.txt': lines('t', 12) });
			changeLine(repo, 't.txt', 3, 'CHANGE-T');
			writeFileSync(join(repo, 'b'), 'lol\n');
			const filter = excludeFilter('t.txt');

			const { result } = await generate(repo, hunks => [hunks.map((_, i) => i)], filter);
			const { stashConflict } = await apply(repo, result, { hunkFilter: filter });

			const commits = commitsSince(repo, base);
			assert.strictEqual(commits.length, 1);
			assert.deepStrictEqual(filesOf(repo, commits[0]), ['b']);

			assert.ok(
				readFileSync(join(repo, 't.txt'), 'utf8').includes('CHANGE-T'),
				'the excluded tracked modification must survive in the workdir',
			);
			assert.deepStrictEqual(modifiedPaths(repo), ['t.txt']);
			assert.strictEqual(stashConflict, undefined);
			assert.strictEqual(git(repo, 'stash', 'list').trim(), '', 'the compose stash must be consumed');
		});
	});
});
