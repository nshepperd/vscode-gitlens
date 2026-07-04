import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { env as processEnv } from 'process';
import type { ComposeHunk, ComposePlanResult, ComposeSource } from '@gitkraken/compose-tools';
import { applyComposePlan, composePlan } from '@gitkraken/compose-tools';
import { suite, suiteTeardown, test } from 'mocha';

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

/** Creates a temp repo with `files` committed, returning the repo path and base SHA.
 *  Buffer values are written verbatim (for binary fixtures); strings as UTF-8. */
function setupRepo(files: Record<string, string | Buffer>): { repo: string; base: string } {
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

/**
 * A deterministic pseudo-binary blob: a PNG signature followed by bytes that
 * include NUL, so git classifies it as binary (NUL in the first 8000 bytes).
 * Distinct `seed`s yield distinct content, modelling a binary modification.
 */
function binaryBlob(seed: number): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const body = Buffer.alloc(256);
	for (let i = 0; i < body.length; i++) {
		body[i] = (i * 31 + seed) & 0xff;
	}
	return Buffer.concat([signature, body]);
}

/** Raw bytes of `file` on disk. */
function readBytes(repo: string, file: string): Buffer {
	return readFileSync(join(repo, file));
}

/** Raw bytes of `path` as stored in commit `sha`, or null if the path is absent. */
function bytesInCommit(repo: string, sha: string, path: string): Buffer | null {
	try {
		// No `encoding` → execFileSync returns a Buffer, preserving binary content.
		return execFileSync('git', ['show', `${sha}:${path}`], { cwd: repo, env: gitEnv, maxBuffer: 64 * 1024 * 1024 });
	} catch {
		return null;
	}
}

/** Asserts `actual` exists and is byte-for-byte equal to `expected`. */
function assertBytesEqual(actual: Buffer | null, expected: Buffer, message: string): void {
	assert.ok(
		actual != null && Buffer.compare(actual, expected) === 0,
		`${message} (got ${actual == null ? 'null' : `${actual.length} bytes`}, expected ${expected.length} bytes)`,
	);
}

/** Positional group helper: assigns every collected hunk to one commit. */
const assignAll = (hunks: PromptHunk[]): number[][] => [hunks.map((_, i) => i)];

/**
 * Models the left-sidebar composer's per-hunk deselection.
 *
 * In the real composer the AI assigns every hunk at generate time; the user then
 * deselects hunks in the webview, and `reconstructPlan` drops them from their
 * commits before apply. Deselection therefore happens at APPLY time (editing the
 * plan), not generate time — dropping hunks during generation instead trips the
 * library's "every hunk must be grouped" validator. This returns a copy of the
 * plan with every hunk of `fileName` removed from all commits, so the library
 * treats those hunks as leftovers (re-applied to the working tree).
 */
function deselectFile(result: ComposePlanResult, fileName: string): ComposePlanResult {
	const dropped = new Set(result.source.hunks.filter(h => h.fileName === fileName).map(h => h.index));
	const strip = <T extends { hunkIndices: number[] }>(commit: T): T => ({
		...commit,
		hunkIndices: commit.hunkIndices.filter(i => !dropped.has(i)),
	});
	return {
		...result,
		plan: {
			...result.plan,
			allOrderedCommits: result.plan.allOrderedCommits.map(strip),
			branches: result.plan.branches.map(bp => ({
				...bp,
				branchGroup: { ...bp.branchGroup, commits: bp.branchGroup.commits.map(strip) },
			})),
		},
	};
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

		// Ref-move apply never disturbs the working tree: the new commit is built ref-only
		// and HEAD is moved onto it with a mixed reset, so the deselected commit's hunks
		// (f2, f3) AND the excluded file's change (f0) all simply remain as working changes.
		// Nothing is stashed, nothing is lost, and there is no spurious conflict.
		//
		// This replaces the former stash-based behavior — a design wart where the deselected
		// hunks were re-applied on top of a stash that still held the excluded change, so git
		// refused the auto-pop and the library surfaced a spurious `stashConflict` with f0
		// trapped in a leftover stash. The ref-move design eliminates that wart entirely.
		assert.deepStrictEqual(
			modifiedPaths(repo),
			['f0.txt', 'f2.txt', 'f3.txt'],
			'the deselected commit’s hunks and the excluded file all remain as working changes',
		);
		assert.strictEqual(stashConflict, undefined, 'ref-move never stashes, so there is no stash conflict');
		assert.strictEqual(git(repo, 'stash', 'list').trim(), '', 'ref-move creates no stash');
		assert.ok(
			readFileSync(join(repo, 'f0.txt'), 'utf8').includes('CHANGE-F0'),
			'the excluded file’s change remains directly in the working tree',
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

	/*
	 * Binary files (e.g. a PNG) in the working tree. git represents these as
	 * `GIT binary patch` deltas rather than line hunks, so they exercise a
	 * different path through the library's collect → commit → leftover/stash
	 * machinery than the text cases above. Reported symptom: applying a compose
	 * stack in a repo containing binary changes surfaced a stash conflict.
	 *
	 * "Deselect" here mirrors the left-sidebar composer (NOT the graph): the user
	 * drops a hunk from a commit, so it is never assigned to any commit and the
	 * library treats it as a leftover hunk re-applied to the working tree. That is
	 * modelled by the stub omitting the hunk's index (see `assignOnly`), with no
	 * `hunkFilter` on apply.
	 */
	suite('binary files across apply', () => {
		test('baseline: a modified tracked binary file commits with its exact bytes', async () => {
			const { repo, base } = setupRepo({ 'root.txt': lines('root', 3), 'img.png': binaryBlob(1) });
			writeFileSync(join(repo, 'img.png'), binaryBlob(2));

			const { result } = await generate(repo, assignAll);
			const { stashConflict } = await apply(repo, result);

			const commits = commitsSince(repo, base);
			assert.strictEqual(commits.length, 1);
			assert.deepStrictEqual(filesOf(repo, commits[0]), ['img.png']);
			assertBytesEqual(
				bytesInCommit(repo, commits[0], 'img.png'),
				binaryBlob(2),
				'the committed blob must be the new binary content, not a truncated/empty patch',
			);
			assert.deepStrictEqual(modifiedPaths(repo), [], 'workdir should be clean after a full apply');
			assert.strictEqual(stashConflict, undefined);
		});

		test('an untracked binary file is composed (added) with its exact bytes', async () => {
			const { repo, base } = setupRepo({ 'root.txt': lines('root', 3) });
			writeFileSync(join(repo, 'a.txt'), 'aaa\n');
			writeFileSync(join(repo, 'img.png'), binaryBlob(5));
			git(repo, 'add', 'a.txt');

			const { result } = await generate(repo, assignAll);
			const { stashConflict } = await apply(repo, result);

			const commits = commitsSince(repo, base);
			assert.strictEqual(commits.length, 1);
			assert.deepStrictEqual(filesOf(repo, commits[0]), ['a.txt', 'img.png']);
			assertBytesEqual(
				bytesInCommit(repo, commits[0], 'img.png'),
				binaryBlob(5),
				'the untracked binary must be committed with its exact bytes',
			);
			assert.deepStrictEqual(modifiedPaths(repo), [], 'workdir should be clean after a full apply');
			assert.strictEqual(stashConflict, undefined);
		});

		test('a deselected tracked binary modification survives in the workdir', async () => {
			const { repo, base } = setupRepo({ 't.txt': lines('t', 12), 'img.png': binaryBlob(1) });
			changeLine(repo, 't.txt', 3, 'CHANGE-T');
			writeFileSync(join(repo, 'img.png'), binaryBlob(2));

			// The AI groups everything; the user then deselects the img.png hunk → leftover.
			const { result } = await generate(repo, assignAll);
			const { stashConflict } = await apply(repo, deselectFile(result, 'img.png'));

			const commits = commitsSince(repo, base);
			assert.strictEqual(commits.length, 1);
			assert.deepStrictEqual(filesOf(repo, commits[0]), ['t.txt']);

			assertBytesEqual(
				readBytes(repo, 'img.png'),
				binaryBlob(2),
				'the deselected binary modification must survive on disk (not be reverted or corrupted)',
			);
			assert.deepStrictEqual(modifiedPaths(repo), ['img.png']);
			assert.strictEqual(stashConflict, undefined, 'a deselected binary file must not cause a stash conflict');
			assert.strictEqual(git(repo, 'stash', 'list').trim(), '', 'the compose stash must be consumed');
		});

		// Control: the SAME deselect flow with a tracked TEXT modification instead of
		// binary, to isolate whether the spurious stash conflict is binary-specific or
		// a property of deselecting any tracked modification through the composer.
		test('CONTROL a deselected tracked text modification survives in the workdir', async () => {
			const { repo, base } = setupRepo({ 't.txt': lines('t', 12), 'other.txt': lines('other', 12) });
			changeLine(repo, 't.txt', 3, 'CHANGE-T');
			changeLine(repo, 'other.txt', 3, 'CHANGE-OTHER');

			const { result } = await generate(repo, assignAll);
			const { stashConflict } = await apply(repo, deselectFile(result, 'other.txt'));

			const commits = commitsSince(repo, base);
			assert.strictEqual(commits.length, 1);
			assert.deepStrictEqual(filesOf(repo, commits[0]), ['t.txt']);
			assert.ok(readFileSync(join(repo, 'other.txt'), 'utf8').includes('CHANGE-OTHER'));
			assert.deepStrictEqual(modifiedPaths(repo), ['other.txt']);
			assert.strictEqual(
				stashConflict,
				undefined,
				'a deselected text modification must not cause a stash conflict',
			);
			assert.strictEqual(git(repo, 'stash', 'list').trim(), '', 'the compose stash must be consumed');
		});

		test('a deselected untracked binary file survives on disk (data-loss regression)', async () => {
			const { repo, base } = setupRepo({ 'root.txt': lines('root', 3) });
			writeFileSync(join(repo, 'a.txt'), 'aaa\n');
			writeFileSync(join(repo, 'img.png'), binaryBlob(5));
			git(repo, 'add', 'a.txt');

			// The AI groups everything; the user then deselects the untracked binary → leftover.
			const { result } = await generate(repo, assignAll);
			const { stashConflict } = await apply(repo, deselectFile(result, 'img.png'));

			const commits = commitsSince(repo, base);
			assert.strictEqual(commits.length, 1);
			assert.deepStrictEqual(filesOf(repo, commits[0]), ['a.txt']);

			assertBytesEqual(
				readBytes(repo, 'img.png'),
				binaryBlob(5),
				'the deselected untracked binary must survive on disk with its exact bytes',
			);
			assert.deepStrictEqual(
				modifiedPaths(repo),
				['img.png'],
				'img.png must be back in the working tree, untracked',
			);
			assert.strictEqual(stashConflict, undefined);
			assert.strictEqual(git(repo, 'stash', 'list').trim(), '', 'the compose stash must be consumed');
		});

		test('an excluded binary file (graph hunkFilter) survives in the workdir', async () => {
			const { repo, base } = setupRepo({ 't.txt': lines('t', 12), 'img.png': binaryBlob(1) });
			changeLine(repo, 't.txt', 3, 'CHANGE-T');
			writeFileSync(join(repo, 'img.png'), binaryBlob(2));
			const filter = excludeFilter('img.png');

			// Graph-style exclusion: filter both phases; commit the surviving t.txt hunk.
			const { result } = await generate(repo, () => [[0]], filter);
			const { stashConflict } = await apply(repo, result, { hunkFilter: filter });

			const commits = commitsSince(repo, base);
			assert.strictEqual(commits.length, 1);
			assert.deepStrictEqual(filesOf(repo, commits[0]), ['t.txt']);

			assertBytesEqual(
				readBytes(repo, 'img.png'),
				binaryBlob(2),
				'the excluded binary modification must survive on disk',
			);
			assert.deepStrictEqual(modifiedPaths(repo), ['img.png']);
			assert.strictEqual(stashConflict, undefined);
		});

		test('a commit stack mixing text and binary applies cleanly', async () => {
			const { repo, base } = setupRepo({
				'f0.txt': lines('f0', 12),
				'f1.txt': lines('f1', 12),
				'img.png': binaryBlob(1),
			});
			changeLine(repo, 'f0.txt', 3, 'CHANGE-F0');
			changeLine(repo, 'f1.txt', 3, 'CHANGE-F1');
			writeFileSync(join(repo, 'img.png'), binaryBlob(2));

			// Two commits: {f0 + img.png} then {f1}. Diff order is lexicographic
			// (f0=0, f1=1, img.png=2), so the binary rides in the first commit.
			const { result } = await generate(repo, () => [[0, 2], [1]]);
			const { stashConflict } = await apply(repo, result);

			const commits = commitsSince(repo, base);
			assert.strictEqual(commits.length, 2);
			assert.deepStrictEqual(filesOf(repo, commits[0]), ['f0.txt', 'img.png']);
			assert.deepStrictEqual(filesOf(repo, commits[1]), ['f1.txt']);
			assertBytesEqual(
				bytesInCommit(repo, commits[0], 'img.png'),
				binaryBlob(2),
				'the binary must commit intact',
			);
			assert.deepStrictEqual(modifiedPaths(repo), [], 'workdir should be clean after a full apply');
			assert.strictEqual(stashConflict, undefined);
		});
	});
});

/*
 * Regression tests for the ref-move rewrite-range apply (delivered via the same pnpm patch).
 *
 * The old `applyRangeRewrite` stashed the working changes, `reset --hard` to the new tip, and
 * popped the stash. That flow could conflict on the pop (spurious stashConflict + an abandoned
 * stash + a worktree left mid-merge), and when `includeWorkdir` was active but a workdir portion
 * was excluded from it, the hard reset destroyed the excluded changes outright.
 *
 * The patched flow never writes the worktree: it moves the refs, and re-baselines the index only
 * when the rewrite changed the tip tree (mixed reset) — a tree-preserving rewrite (the common full
 * recompose) leaves the index alone, so `git status`, including the staged/unstaged split, is
 * byte-for-byte identical across the apply.
 */
suite('compose-tools rewrite-range ref-move apply', () => {
	suiteTeardown(() => {
		for (const repo of repos) {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	/** Base + two range commits (C1 changes a.txt, C2 changes b.txt), plus committed d/w files. */
	function setupRangeRepo(): { repo: string; base: string; c1: string; c2: string } {
		const { repo, base } = setupRepo({
			'a.txt': lines('a', 12),
			'b.txt': lines('b', 12),
			'd.txt': lines('d', 12),
			'w.txt': lines('w', 12),
		});
		changeLine(repo, 'a.txt', 3, 'RANGE-A');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-m', 'C1');
		const c1 = git(repo, 'rev-parse', 'HEAD').trim();
		changeLine(repo, 'b.txt', 3, 'RANGE-B');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-m', 'C2');
		const c2 = git(repo, 'rev-parse', 'HEAD').trim();
		return { repo: repo, base: base, c1: c1, c2: c2 };
	}

	function statusOf(repo: string): string {
		return git(repo, 'status', '--porcelain');
	}

	function stashesOf(repo: string): string {
		return git(repo, 'stash', 'list').trim();
	}

	/** The materialized working-tree tree (tracked + untracked staged into a throwaway index). */
	function materializedTree(repo: string): string {
		const dir = mkdtempSync(join(tmpdir(), 'gl-mat-'));
		try {
			const env = { ...gitEnv, GIT_INDEX_FILE: join(dir, 'index') };
			execFileSync('git', ['add', '-A'], { cwd: repo, env: env });
			return execFileSync('git', ['write-tree'], { cwd: repo, env: env, encoding: 'utf8' }).trim();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	async function generateRange(
		repo: string,
		source: ComposeSource,
		group: (hunks: PromptHunk[]) => number[][],
	): Promise<ComposePlanResult> {
		const stub = createModelStub(group);
		return composePlan({
			git: createGitPort(repo),
			model: stub.port,
			source: source,
			depth: 'quick',
		});
	}

	async function applyRange(
		repo: string,
		result: ComposePlanResult,
		source: ComposeSource,
		applyCommitIds?: string[],
	): Promise<{ stashConflict?: unknown }> {
		const applied = await applyComposePlan({
			git: createGitPort(repo),
			applyPlan: { plan: result.plan, source: source, snapshot: result.snapshot },
			applyCommitIds: applyCommitIds,
			stashLabel: 'gl-compose-test',
			authorAttribution: 'plurality',
		});
		return { stashConflict: applied.stashConflict };
	}

	test('tree-preserving recompose leaves a dirty status byte-identical, with no stash', async () => {
		const { repo, base, c1, c2 } = setupRangeRepo();
		// Dirty state in every column: a staged new file, an unstaged edit, and an untracked file.
		writeFileSync(join(repo, 's.txt'), lines('s', 4));
		git(repo, 'add', 's.txt');
		changeLine(repo, 'w.txt', 5, 'UNSTAGED-EDIT');
		writeFileSync(join(repo, 'u.txt'), lines('u', 4));

		const statusBefore = statusOf(repo);
		const treeBefore = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
		const worktreeBefore = materializedTree(repo);
		assert.ok(statusBefore.includes('A  s.txt'), 'precondition: the new file is staged');

		const source = { type: 'commit-range' as const, branch: 'main', from: c1, to: c2 };
		const result = await generateRange(repo, source, assignAll); // squash C1+C2 → 1 commit
		const { stashConflict } = await applyRange(repo, result, source);

		assert.strictEqual(stashConflict, undefined);
		const commits = commitsSince(repo, base);
		assert.strictEqual(commits.length, 1, 'the range must be squashed into one commit');
		assert.strictEqual(git(repo, 'rev-parse', 'HEAD^{tree}').trim(), treeBefore, 'tip tree preserved');
		// The headline: the index was never touched, so the full status — including the
		// staged/unstaged split — is byte-for-byte what it was before the apply.
		assert.strictEqual(statusOf(repo), statusBefore, 'status (incl. staged split) must be unchanged');
		assert.strictEqual(materializedTree(repo), worktreeBefore, 'the on-disk tree must be conserved');
		assert.strictEqual(stashesOf(repo), '', 'no stash may be created or left behind');
	});

	test('partial apply: the deselected commit surfaces as a working change, with no stash', async () => {
		const { repo, base, c1, c2 } = setupRangeRepo();
		writeFileSync(join(repo, 'u.txt'), lines('u', 4)); // untracked dirt riding along
		const worktreeBefore = materializedTree(repo);

		const source = { type: 'commit-range' as const, branch: 'main', from: c1, to: c2 };
		// Diff order is lexicographic: a.txt=0, b.txt=1 → commit-1 {a}, commit-2 {b}.
		const result = await generateRange(repo, source, hunks => hunks.map((_, i) => [i]));
		const { stashConflict } = await applyRange(repo, result, source, ['commit-1']);

		assert.strictEqual(stashConflict, undefined);
		const commits = commitsSince(repo, base);
		assert.strictEqual(commits.length, 1);
		assert.deepStrictEqual(filesOf(repo, commits[0]), ['a.txt']);
		// C2's change is no longer committed — it must survive as an ordinary working change
		// (the worktree still holds it; nothing was written or stashed to make that happen).
		assert.deepStrictEqual(modifiedPaths(repo), ['b.txt', 'u.txt']);
		assert.ok(readFileSync(join(repo, 'b.txt'), 'utf8').includes('RANGE-B'));
		assert.ok(!patchOf(repo, commits[0]).includes('RANGE-B'), 'the deselected change must not be committed');
		assert.strictEqual(materializedTree(repo), worktreeBefore, 'the on-disk tree must be conserved');
		assert.strictEqual(stashesOf(repo), '', 'no stash may be created or left behind');
	});

	test('includeWorkdir staged-only: an excluded unstaged edit survives the apply', async () => {
		// Regression: the old flow took no stash when includeWorkdir was active and then
		// `reset --hard` to the new tip — destroying any workdir changes EXCLUDED from the
		// includeWorkdir scope (here: the unstaged edit). The ref-move never writes the worktree.
		const { repo, base, c1, c2 } = setupRangeRepo();
		changeLine(repo, 'w.txt', 5, 'STAGED-EDIT');
		git(repo, 'add', 'w.txt');
		changeLine(repo, 'd.txt', 7, 'UNSTAGED-EDIT'); // excluded from the compose scope

		const source = {
			type: 'commit-range' as const,
			branch: 'main',
			from: c1,
			to: c2,
			includeWorkdir: { includeStaged: true, includeUnstaged: false, includeUntracked: false },
		};
		const result = await generateRange(repo, source, assignAll); // range + staged → 1 commit
		const { stashConflict } = await applyRange(repo, result, source);

		assert.strictEqual(stashConflict, undefined);
		const commits = commitsSince(repo, base);
		assert.strictEqual(commits.length, 1);
		assert.ok(patchOf(repo, commits[0]).includes('STAGED-EDIT'), 'the staged edit must be committed');
		// The unstaged (out-of-scope) edit is still on disk and still uncommitted.
		assert.deepStrictEqual(modifiedPaths(repo), ['d.txt']);
		assert.ok(readFileSync(join(repo, 'd.txt'), 'utf8').includes('UNSTAGED-EDIT'));
		assert.ok(!patchOf(repo, commits[0]).includes('UNSTAGED-EDIT'));
		assert.strictEqual(stashesOf(repo), '', 'no stash may be created or left behind');
	});

	test('recomposing a branch that is NOT checked out leaves the current checkout untouched', async () => {
		const { repo, base, c1, c2 } = setupRangeRepo();
		// Move the range onto a feature branch and return main to the base.
		git(repo, 'branch', 'feature', c2);
		git(repo, 'reset', '--hard', base);
		// Dirty the CURRENT (main) checkout — it must not be disturbed by the feature rewrite.
		changeLine(repo, 'w.txt', 5, 'MAIN-DIRT');
		writeFileSync(join(repo, 's.txt'), lines('s', 4));
		git(repo, 'add', 's.txt');
		const statusBefore = statusOf(repo);
		const mainSha = git(repo, 'rev-parse', 'HEAD').trim();

		const source = { type: 'commit-range' as const, branch: 'feature', from: c1, to: c2 };
		const result = await generateRange(repo, source, assignAll);
		const { stashConflict } = await applyRange(repo, result, source);

		assert.strictEqual(stashConflict, undefined);
		// feature was rewritten (squashed to one commit atop base) with its content intact...
		const featureCommits = git(repo, 'rev-list', '--reverse', `${base}..feature`).trim().split('\n');
		assert.strictEqual(featureCommits.length, 1);
		assert.strictEqual(
			git(repo, 'rev-parse', 'feature^{tree}').trim(),
			git(repo, 'rev-parse', `${c2}^{tree}`).trim(),
			'feature tip tree preserved',
		);
		// ...while the checked-out main was left completely alone.
		assert.strictEqual(git(repo, 'rev-parse', 'HEAD').trim(), mainSha, 'main must not move');
		assert.strictEqual(statusOf(repo), statusBefore, 'the main checkout status must be unchanged');
		assert.strictEqual(stashesOf(repo), '', 'no stash may be created or left behind');
	});
});
