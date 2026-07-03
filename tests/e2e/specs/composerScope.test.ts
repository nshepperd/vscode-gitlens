/**
 * GitLens Commit Composer — webview route: INPUT-SCOPE edge cases (what goes into the composition).
 *
 * composer.test.ts covers whole-file staged subsets; this file covers the trickier scope shapes that
 * are the classic index-vs-worktree data-loss traps:
 *   1. Partial staging — a single file with a STAGED hunk and a separate UNSTAGED hunk. Only the
 *      staged hunk must compose; the unstaged hunk must survive as a working change.
 *   2. `includedUnstagedChanges: true` — staged AND unstaged changes composed together.
 *   3. Untracked files — a brand-new file must be composable (added) without loss.
 *   4. Concurrent edit during generation — a working-tree change made WHILE the AI is generating
 *      must survive the apply.
 *
 * Driven by the AI simulator, asserted at the git level — see composerShared.ts.
 * Requires a --debug build (`pnpm run bundle:e2e`).
 */
import * as process from 'node:process';
import { test as base, createTmpDir, expect, GitFixture } from '../baseTest.js';
import {
	assertComposedAtop,
	captureConservation,
	clickComposerButton,
	composeAndApply,
	getComposerState,
	openComposerPanel,
	rows,
} from './composerShared.js';

const test = base.extend({
	vscodeOptions: [
		{
			vscodeVersion: process.env.VSCODE_VERSION ?? 'stable',
			setup: async () => {
				const repoDir = await createTmpDir();
				const git = new GitFixture(repoDir);
				await git.init();
				await git.createFile('a.txt', 'line1\nline2\nline3\n');
				await git.createFile('b.txt', 'alpha\nbeta\n');
				await git.createFile('big.txt', rows());
				await git.stageAll();
				await git.commitStaged('Base commit');
				await git.tag('scope-base');
				return repoDir;
			},
		},
		{ scope: 'worker' },
	],
});

// Opt this file out of `fullyParallel`: its tests share one worker-scoped VS Code instance and run
// sequentially. Unlike `serial` mode, a failure restarts the worker and continues with the
// remaining tests instead of skipping them.
test.describe.configure({ mode: 'default' });

test.describe('Commit Composer — input scope (webview route)', () => {
	test.afterEach(async ({ vscode }) => {
		await vscode.gitlens.resetUI();
	});

	async function freshRepo(workspacePath: string): Promise<GitFixture> {
		const git = new GitFixture(workspacePath);
		await git.reset('scope-base', 'hard');
		await git.clean();
		return git;
	}

	test('partial staging: composes only the staged hunk, leaving the unstaged hunk uncommitted', async ({
		vscode,
	}) => {
		const git = await freshRepo(vscode.electron.workspacePath);

		// Stage the TOP hunk, then edit the BOTTOM → the file has one staged and one unstaged hunk.
		const stagedOnlyContent = rows([1, 'row 2 STAGED']);
		await git.createFile('big.txt', stagedOnlyContent);
		await git.stage('big.txt');
		const worktreeContent = rows([1, 'row 2 STAGED'], [17, 'row 18 UNSTAGED']);
		await git.createFile('big.txt', worktreeContent);
		expect(await git.status()).toBe('MM big.txt'); // staged + unstaged, same file
		const indexBefore = await git.indexTree();

		// Default (includedUnstagedChanges unset): only the STAGED hunk is in scope → one commit.
		await composeAndApply(vscode, git, {
			tag: 'SCOPE-PARTIAL',
			strategy: 'separate',
			commits: 1,
			baseRef: 'scope-base',
		});

		// Committed content has ONLY the staged (top) hunk; the unstaged bottom hunk survives
		// untouched in the working tree.
		expect(await git.readFileAtRef('big.txt')).toBe(stagedOnlyContent);
		expect(await git.readFile('big.txt')).toBe(worktreeContent);
		expect(await git.status()).toBe(' M big.txt');
		// The apply re-slices the cut: the staged subset became the tip, and the mixed reset
		// flattened staging (index == HEAD).
		expect(await git.headTree()).toBe(indexBefore);
		expect(await git.indexTree()).toBe(await git.headTree());
	});

	test('composes an untracked file (added) alongside a tracked change without data loss', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);

		const newContent = 'brand new file\n';
		const modA = 'line1-x\nline2\nline3\n';
		await git.createFile('new.txt', newContent); // untracked — never staged
		await git.createFile('a.txt', modA); // unstaged tracked
		expect(await git.status()).toBe(' M a.txt\n?? new.txt');

		// No staged changes → the composer falls back to including the unstaged + untracked changes;
		// by-file: new.txt + a.txt → 2 commits.
		await composeAndApply(vscode, git, {
			tag: 'SCOPE-UNTRACKED',
			strategy: 'by-file',
			commits: 2,
			baseRef: 'scope-base',
		});

		// The untracked file is now tracked at HEAD with its exact content; the tracked change applied too.
		expect(await git.readFileAtRef('new.txt')).toBe(newContent);
		expect(await git.readFileAtRef('a.txt')).toBe(modA);
		expect(await git.isClean()).toBe(true);
	});

	test('a working-tree edit made DURING generation survives the apply', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);

		const modA = 'line1-mod\nline2\nline3\n';
		await git.createFile('a.txt', modA);
		await git.stage('a.txt');

		// Hand-rolled rather than composeAndApply: the conservation snapshot must be captured AFTER
		// the mid-generation write, and the write must land while generation is in flight.
		await using _sub = await vscode.gitlens.startSubscriptionSimulation();
		await using _ai = await vscode.gitlens.startAISimulation('slow'); // ~1.5s window to race an edit in
		const tag = 'SCOPE-CONCURRENT';
		await vscode.gitlens.setComposerPlan('separate', tag);

		const composer = await openComposerPanel(vscode, { repoPath: git.repoPath, mode: 'preview' });

		// Kick off generation, then — while it's still running — make an unrelated working-tree change.
		const started = await clickComposerButton(composer, 'Auto-Compose Commits');
		expect(started, 'Auto-Compose button should be present').not.toBeNull();
		const concurrentContent = 'written while the AI was generating\n';
		await git.createFile('concurrent.txt', concurrentContent);
		const conservation = await captureConservation(git);
		const baseSha = await git.revParse('scope-base');

		// Let generation settle (the tagged plan landing is the settle signal — see generateAndWait),
		// then apply.
		await expect
			.poll(
				async () => {
					const state = await getComposerState(composer);
					return (
						state != null && !state.generatingCommits && state.commits.some(c => c.message.includes(tag))
					);
				},
				{ timeout: 20000 },
			)
			.toBe(true);
		expect((await getComposerState(composer))?.commits.length).toBe(1);
		const clicked = await clickComposerButton(composer, 'Create');
		expect(clicked).toMatch(/Create 1 Commit/i);

		await assertComposedAtop(git, { tag: tag, count: 1, baseSha: baseSha, conservation: conservation });
		expect(await git.readFileAtRef('a.txt')).toBe(modA); // the staged change committed
		// The concurrent edit was NOT destroyed by the apply — it's still on disk, uncommitted.
		expect(await git.readFile('concurrent.txt')).toBe(concurrentContent);
		expect(await git.status()).toBe('?? concurrent.txt');
	});

	test('includedUnstagedChanges: composes staged AND unstaged changes together', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);

		const modA = 'line1-staged\nline2\nline3\n';
		const modB = 'alpha\nbeta\ngamma\n';
		await git.createFile('a.txt', modA);
		await git.stage('a.txt'); // staged
		await git.createFile('b.txt', modB); // unstaged
		expect(await git.status()).toBe('M  a.txt\n M b.txt');
		const worktreeBefore = await git.materializedTree();

		// by-file over the combined staged+unstaged diff → a.txt + b.txt → 2 commits.
		await composeAndApply(vscode, git, {
			tag: 'SCOPE-UNSTAGED-INCLUDED',
			strategy: 'by-file',
			commits: 2,
			baseRef: 'scope-base',
			open: { includedUnstagedChanges: true },
		});

		// BOTH the staged and the unstaged change were committed (contrast with the default subset
		// path); the whole scope committed, so the new tip equals the pre-compose disk state.
		expect(await git.readFileAtRef('a.txt')).toBe(modA);
		expect(await git.readFileAtRef('b.txt')).toBe(modB);
		expect(await git.isClean()).toBe(true);
		expect(await git.headTree()).toBe(worktreeBefore);
	});
});
