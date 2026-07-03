/**
 * GitLens Commit Composer — Recompose (webview route), all entry points.
 *
 * "Recompose" loads the combined diff of EXISTING commits and re-splits them into a new commit
 * sequence, routed to the webview composer via three arg shapes:
 *   - Recompose from here  → `range: { base, head }`   (rewrites base..head, base preserved)
 *   - Recompose Branch     → `branchName` only         (rewrites the branch's unique commits atop
 *                                                       the resolved merge target)
 *   - Recompose Selected   → `commitShas` (+ branch)   (locks the commits NOT listed)
 * The graph context-menu items ("Recompose Commits (Preview)" on a branch row, "Recompose Commits
 * From Here (Preview)" on a commit row) execute `gitlens.recomposeBranch` /
 * `gitlens.recomposeFromCommit`, which resolve the args and open the same composer. Driving the
 * VS Code-native context menu is fragile, so the wiring tests invoke those commands directly —
 * exercising the real arg-resolution the menu items rely on.
 *
 * Core invariant, asserted at the git level: recompose preserves the TOTAL diff — the final tree at
 * HEAD is byte-identical (same content, restructured commits), the base/merge-base is preserved,
 * and the working tree is untouched. The composeAndApply driver pins all of this on every apply.
 *
 * Repo shape: main (Base) → feature (F1, F2 which also adds f2.txt, F3), all edits to f1.txt.
 * Requires a --debug build (`pnpm run bundle:e2e`).
 */
import * as process from 'node:process';
import { test as base, createTmpDir, expect, GitFixture } from '../baseTest.js';
import {
	assertComposedAtop,
	captureConservation,
	clickComposerButton,
	composeAndApply,
	generateAndWait,
	getComposerState,
	openComposerPanel,
} from './composerShared.js';

const test = base.extend({
	vscodeOptions: [
		{
			vscodeVersion: process.env.VSCODE_VERSION ?? 'stable',
			setup: async () => {
				const repoDir = await createTmpDir();
				const git = new GitFixture(repoDir);
				await git.init();
				await git.commit('Base', 'base.txt', 'base\n'); // main
				await git.checkout('feature', true);
				await git.commit('F1', 'f1.txt', 'a\n');
				await git.createFile('f2.txt', 'b\n');
				await git.stageAll();
				await git.commit('F2', 'f1.txt', 'ab\n'); // f1 a→ab + add f2
				await git.commit('F3', 'f1.txt', 'abc\n'); // f1 ab→abc
				// Tag the full history so each test can restore it (recompose rewrites it).
				await git.tag('recompose-base');
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

test.describe('Commit Composer — recompose (webview route)', () => {
	test.afterEach(async ({ vscode }) => {
		await vscode.gitlens.resetUI();
	});

	/** Restore the tagged feature-branch history and clean the tree. */
	async function freshRepo(workspacePath: string): Promise<GitFixture> {
		const git = new GitFixture(workspacePath);
		await git.reset('recompose-base', 'hard');
		await git.clean();
		return git;
	}

	test('recompose from here (range) re-splits commits, preserving the total diff', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		const f1 = await git.revParse('HEAD~2'); // F1 — the recompose base, preserved
		const head = await git.revParse('HEAD'); // F3

		// Recompose from F2 → range = F2's parent (F1) .. F3, with branchName as the real
		// recomposeFromCommit command sends it (it selects the correct HEAD-safety check).
		const n = await composeAndApply(vscode, git, {
			tag: 'RECOMPOSE-FROMHERE',
			strategy: 'separate',
			trigger: 'Recompose',
			baseRef: 'HEAD~2',
			open: { branchName: 'feature', range: { base: f1, head: head } },
		});

		expect(n).toBeGreaterThan(0);
		expect(await git.readFileAtRef('f1.txt')).toBe('abc\n');
		expect(await git.readFileAtRef('f2.txt')).toBe('b\n');
		expect(await git.isClean()).toBe(true);
	});

	test('recompose with a dirty working tree preserves the uncommitted changes and leaves no stash', async ({
		vscode,
	}) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		const f1 = await git.revParse('HEAD~2');
		const head = await git.revParse('HEAD');

		// A dirty, uncommitted working change present at recompose time (unrelated to the range's
		// files). It is left OUT of scope, so it must be only re-sliced around — the driver's
		// conservation check pins it byte-identically, including no abandoned stash.
		const wipContent = 'uncommitted work in progress\n';
		await git.createFile('wip.txt', wipContent);
		expect(await git.status()).toBe('?? wip.txt');

		await composeAndApply(vscode, git, {
			tag: 'RECOMPOSE-DIRTY',
			strategy: 'separate',
			trigger: 'Recompose',
			baseRef: 'HEAD~2',
			open: { branchName: 'feature', range: { base: f1, head: head } },
		});

		// The dirty working change survived the recompose intact.
		expect(await git.readFile('wip.txt')).toBe(wipContent);
		expect(await git.status()).toBe('?? wip.txt');
	});

	test('recompose from here with "together" collapses the range into a single commit', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		const f1 = await git.revParse('HEAD~2');
		const head = await git.revParse('HEAD');

		await composeAndApply(vscode, git, {
			tag: 'RECOMPOSE-TOGETHER',
			strategy: 'together',
			trigger: 'Recompose',
			commits: 1,
			baseRef: 'HEAD~2',
			open: { branchName: 'feature', range: { base: f1, head: head } },
		});

		expect(await git.isClean()).toBe(true);
	});

	test("recompose branch re-splits the branch's unique commits, preserving the total diff", async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);

		// `branchName` with NO range → the composer resolves the merge target (feature → main works
		// headlessly without a remote) and recomposes the branch's unique commits.
		const n = await composeAndApply(vscode, git, {
			tag: 'RECOMPOSE-BRANCH',
			strategy: 'separate',
			trigger: 'Recompose',
			baseRef: 'HEAD~3', // "Base" on main — where feature forked
			open: { branchName: 'feature' },
		});

		expect(n).toBeGreaterThan(0);
		expect(await git.isClean()).toBe(true);
	});

	test('recompose selected locks the unselected commit, recomposing only the chosen ones', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		const mergeBase = await git.revParse('HEAD~3'); // Base
		const f2 = await git.revParse('HEAD~1');
		const f3 = await git.revParse('HEAD');
		const treeBefore = await git.headTree();
		const conservation = await captureConservation(git);

		await using _sub = await vscode.gitlens.startSubscriptionSimulation();
		await using _ai = await vscode.gitlens.startAISimulation('default');
		const tag = 'RECOMPOSE-SELECTED';
		// "together" so the two selected commits collapse into exactly one recomposed commit.
		await vscode.gitlens.setComposerPlan('together', tag);

		// Select F2 + F3 → F1 is locked (not listed in commitShas). Hand-rolled rather than
		// composeAndApply: in selected mode the composer's plan list also contains the LOCKED
		// commit, so the plan length differs from the tagged-commit count the driver pins.
		const composer = await openComposerPanel(vscode, {
			repoPath: git.repoPath,
			mode: 'preview',
			branchName: 'feature',
			commitShas: [f2, f3],
		});
		await expect
			.poll(async () => (await getComposerState(composer))?.hunkCount ?? 0, { timeout: 20000 })
			.toBeGreaterThan(0);

		await generateAndWait(composer, 'Recompose', tag);
		const applied = await clickComposerButton(composer, 'Create');
		expect(applied).toMatch(/Create \d+ Commits?/i);

		// Exactly one recomposed commit (the selected F2+F3, collapsed by "together") carries the
		// tag. No base pin: the locked F1 below it is itself rewritten (a history rewrite re-stamps
		// the committer date, so its sha changes even though its identity/content is intact).
		await assertComposedAtop(git, { tag: tag, count: 1, conservation: conservation });
		// Resulting history: <recomposed F2+F3> → F1 (locked, own commit, original message) → Base.
		expect(await git.getCommitMessage('HEAD~1')).toBe('F1');
		expect(await git.revParse('HEAD~2')).toBe(mergeBase);
		expect(await git.headTree()).toBe(treeBefore); // total content preserved across the rewrite
		expect(await git.isClean()).toBe(true);
	});

	test('gitlens.recomposeFromCommit opens + recomposes from the given commit', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		const f1 = await git.revParse('HEAD~2'); // F1 — parent of F2, the recompose base (preserved)
		const f2 = await git.revParse('HEAD~1'); // recompose FROM here
		const treeBefore = await git.headTree();
		const conservation = await captureConservation(git);

		await using _sub = await vscode.gitlens.startSubscriptionSimulation();
		await using _ai = await vscode.gitlens.startAISimulation('default');
		const tag = 'WIRE-FROMCOMMIT';
		await vscode.gitlens.setComposerPlan('together', tag);

		// The real command the "Recompose Commits From Here" menu item runs.
		await vscode.gitlens.executeCommand('gitlens.ai.recomposeFromCommit', {
			repoPath: git.repoPath,
			commitSha: f2,
			branchName: 'feature',
		});
		const composer = await vscode.gitlens.getComposerWebview();
		expect(composer, 'recomposeFromCommit should open the composer in recompose mode').not.toBeNull();
		await expect
			.poll(async () => (await getComposerState(composer!))?.hunkCount ?? 0, { timeout: 20000 })
			.toBeGreaterThan(0);

		await generateAndWait(composer!, 'Recompose', tag);
		const applied = await clickComposerButton(composer!, 'Create');
		expect(applied).toMatch(/Create \d+ Commits?/i);

		// F2..F3 recomposed atop the preserved F1; total content intact.
		await assertComposedAtop(git, { tag: tag, count: 1, baseSha: f1, conservation: conservation });
		expect(await git.headTree()).toBe(treeBefore);
		expect(await git.isClean()).toBe(true);
	});

	test("gitlens.recomposeBranch opens + recomposes the branch's unique commits", async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		const mergeBase = await git.revParse('HEAD~3'); // Base
		const treeBefore = await git.headTree();
		const conservation = await captureConservation(git);

		await using _sub = await vscode.gitlens.startSubscriptionSimulation();
		await using _ai = await vscode.gitlens.startAISimulation('default');
		const tag = 'WIRE-BRANCH';
		await vscode.gitlens.setComposerPlan('separate', tag);

		// The real command the branch-row "Recompose Commits" menu item runs.
		await vscode.gitlens.executeCommand('gitlens.ai.recomposeBranch', {
			repoPath: git.repoPath,
			branchName: 'feature',
		});
		const composer = await vscode.gitlens.getComposerWebview();
		expect(composer, 'recomposeBranch should open the composer in recompose mode').not.toBeNull();
		await expect
			.poll(async () => (await getComposerState(composer!))?.hunkCount ?? 0, { timeout: 20000 })
			.toBeGreaterThan(0);

		const n = await generateAndWait(composer!, 'Recompose', tag);
		expect(n).toBeGreaterThan(0);
		const applied = await clickComposerButton(composer!, 'Create');
		expect(applied).toMatch(/Create \d+ Commits?/i);

		await assertComposedAtop(git, { tag: tag, count: n, baseSha: mergeBase, conservation: conservation });
		expect(await git.headTree()).toBe(treeBefore);
		expect(await git.isClean()).toBe(true);
	});
});
