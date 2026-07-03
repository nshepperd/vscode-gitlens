/**
 * GitLens Commit Composer — graph (compose-tools) route E2E.
 *
 * The in-graph compose mode drives the REAL `@gitkraken/compose-tools` pipeline (compose-group →
 * order) and applies via `applyComposePlan` — not the lightweight UI-only bypass. Setting a plan
 * strategy (`setComposerPlan`) is what tells the graph route to run the real pipeline instead of the
 * bypass (see `graph/compose/simulator.ts`); the simulator then synthesizes valid responses from the
 * real hunks. Everything is asserted at the git level, with the conservation invariants pinned on
 * every apply — see composerShared.ts.
 *
 * Also covered here:
 *   - Leftover restore (regression): when a proposed commit is DESELECTED, its hunks are "leftovers"
 *     that must survive as normal working changes. An apply that round-trips the working tree
 *     through a stash gets this wrong — `git stash pop --index` collides with the already-restored
 *     leftover, aborting with a spurious conflict and an abandoned stash. Pinned for a text and a
 *     binary leftover (the failure is not binary-specific; the binary form proves the guarantee
 *     holds for binary content too).
 *   - Scope picker: compose scope defaults to WIP-only; clicking an unpushed commit row below the
 *     WIP range pulls it into the composition, so compose can rewrite unpushed history together
 *     with WIP. The repo has a fake upstream pinned at the base commit so `U1` is genuinely
 *     "unpushed" (inert for the WIP-only tests).
 *
 * All scenarios share one VS Code instance (worker-scoped graph webview; this file opts out of
 * `fullyParallel` via `mode: 'default'`). Between tests
 * we reset git to a clean base and exit any active compose mode; each test then creates its working
 * changes and waits for GitLens to detect them (`waitForWipFiles`, run by the driver) BEFORE
 * entering compose. That wait matters because the compose curation list is a snapshot captured at
 * compose entry — it does not react to later working-tree changes — and VS Code's file watcher has
 * multi-second latency in the headless harness, so entering compose earlier would snapshot an
 * empty/partial scope.
 *
 * Requires a --debug build (`pnpm run bundle:e2e`).
 */
import * as process from 'node:process';
import type { FrameLocator } from '@playwright/test';
import { test as base, createTmpDir, expect, GitFixture } from '../baseTest.js';
import {
	assertComposeConserved,
	assertComposedAtop,
	baseBig,
	baseF1,
	baseF2,
	baseF3,
	binaryBytes,
	captureConservation,
	commitAll,
	enterCompose,
	generate,
	graphComposeAndCommit,
	openComposeGraph,
	rows,
	waitForWipFiles,
} from './composerShared.js';

const test = base.extend({
	vscodeOptions: [
		{
			vscodeVersion: process.env.VSCODE_VERSION ?? 'stable',
			setup: async () => {
				const repoDir = await createTmpDir();
				const git = new GitFixture(repoDir);
				await git.init();
				await git.createFile('f1.txt', baseF1);
				await git.createFile('f2.txt', baseF2);
				await git.createFile('f3.txt', baseF3);
				await git.createFile('big.txt', baseBig);
				await git.createBinaryFile('img.bin', binaryBytes(0));
				await git.stageAll();
				await git.commitStaged('Base commit');
				// Pin a fake upstream at the base commit so the next commit is genuinely "unpushed"
				// (for the scope-picker test); inert for the WIP-only tests.
				await git.createRemoteBranch('origin', 'main', 'HEAD');
				await git.setUpstream('main', 'origin/main');
				await git.commit('U1 unpushed', 'u1.txt', 'u1 content\n');
				// Clean at launch; each test creates its own working changes post-launch.
				await git.tag('graph-base');
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

test.describe('Commit Composer — graph (compose-tools) route', () => {
	test.setTimeout(120000);

	let graphWebview: FrameLocator;
	let dispose: (() => Promise<void>) | undefined;

	/** Reset to clean base, then write the given working-tree files. */
	async function resetAndModify(workspacePath: string, files: Record<string, string>): Promise<GitFixture> {
		const git = new GitFixture(workspacePath);
		await git.reset('graph-base', 'hard');
		await git.clean();
		for (const [name, content] of Object.entries(files)) {
			await git.createFile(name, content);
		}
		return git;
	}

	test.beforeAll(async ({ vscode }) => {
		({ graphWebview, dispose } = await openComposeGraph(vscode));
	});

	test.afterAll(async ({ vscode }) => {
		await dispose?.();
		await vscode.gitlens.resetUI();
	});

	// Light GUI cleanup: exit compose mode so the next test starts from the WIP anchor. A successful
	// Commit All already auto-exits; this only catches a test that bailed mid-flow.
	test.afterEach(async () => {
		const close = graphWebview.locator('gl-action-chip.mode-close');
		if (await close.isVisible().catch(() => false)) {
			await close.click().catch(() => undefined);
		}
	});

	test('happy path: composes working changes and commits them', async ({ vscode }) => {
		const git = await resetAndModify(vscode.electron.workspacePath, {
			'f1.txt': 'a1-mod\na2\na3\n',
			'f2.txt': 'b1\nb2\nb3\n',
		});

		await graphComposeAndCommit(vscode, graphWebview, git, {
			tag: 'SERIAL-HAPPY',
			strategy: 'by-file',
			files: 2,
			commits: 2,
			baseRef: 'graph-base',
		});

		expect(await git.readFileAtRef('f1.txt')).toBe('a1-mod\na2\na3\n');
		expect(await git.readFileAtRef('f2.txt')).toBe('b1\nb2\nb3\n');
		expect(await git.isClean()).toBe(true);
	});

	test('exclude file before compose: excluded file stays uncommitted', async ({ vscode }) => {
		const tag = 'SERIAL-EXCLUDE-FILE';
		const modF1 = 'a1-x\na2\na3\n';
		const modF2 = 'b1\nb2\nb2b\n';
		const modF3 = 'c1\nc2\nc3-x\n';
		const git = await resetAndModify(vscode.electron.workspacePath, {
			'f1.txt': modF1,
			'f2.txt': modF2,
			'f3.txt': modF3,
		});
		const baseSha = await git.revParse('graph-base');
		const conservation = await captureConservation(git);
		await vscode.gitlens.setComposerPlan('by-file', tag);

		await waitForWipFiles(graphWebview, 3);
		await enterCompose(graphWebview, 3);

		// Deselect f3 in the curation list before composing.
		const f3Checkbox = graphWebview.locator(
			'.scope-files__tree gl-tree-item[id="tree-item-f3.txt"] .checkbox__input',
		);
		await f3Checkbox.uncheck();
		await expect(f3Checkbox).not.toBeChecked();

		await generate(graphWebview, 2);
		await commitAll(graphWebview);

		await assertComposedAtop(git, { tag: tag, count: 2, baseSha: baseSha, conservation: conservation });
		expect(await git.readFileAtRef('f1.txt')).toBe(modF1);
		expect(await git.readFileAtRef('f2.txt')).toBe(modF2);
		expect(await git.readFileAtRef('f3.txt')).toBe(baseF3); // f3 NOT committed
		expect(await git.readFile('f3.txt')).toBe(modF3); // f3's change still in the working tree
		expect(await git.status()).toBe(' M f3.txt');
	});

	test('binary: commits a modified binary file byte-identically via the graph route', async ({ vscode }) => {
		const modF1 = 'a1-bin\na2\na3\n';
		const git = await resetAndModify(vscode.electron.workspacePath, { 'f1.txt': modF1 });
		const modBytes = binaryBytes(5);
		await git.createBinaryFile('img.bin', modBytes);

		await graphComposeAndCommit(vscode, graphWebview, git, {
			tag: 'SERIAL-BINARY',
			strategy: 'by-file',
			files: 2, // f1.txt + img.bin
			commits: 2,
			baseRef: 'graph-base',
		});

		expect(await git.readFileAtRef('f1.txt')).toBe(modF1);
		// The binary landed byte-identically through the graph compose-tools apply.
		expect((await git.readBinaryFileAtRef('img.bin', 'HEAD')).equals(modBytes)).toBe(true);
		expect(await git.isClean()).toBe(true);
	});

	test('exclude proposed commit: deselected change stays uncommitted', async ({ vscode }) => {
		const tag = 'SERIAL-EXCLUDE-COMMIT';
		const modF1 = 'a1-y\na2\na3\n';
		const modF2 = 'b1\nb2\nb2y\n';
		const git = await resetAndModify(vscode.electron.workspacePath, { 'f1.txt': modF1, 'f2.txt': modF2 });
		const expected: Record<string, string> = { 'f1.txt': modF1, 'f2.txt': modF2 };
		const baseByFile: Record<string, string> = { 'f1.txt': baseF1, 'f2.txt': baseF2 };
		const baseSha = await git.revParse('graph-base');
		const conservation = await captureConservation(git);
		await vscode.gitlens.setComposerPlan('by-file', tag);

		await waitForWipFiles(graphWebview, 2);
		await enterCompose(graphWebview, 2);
		await generate(graphWebview, 2);

		// Deselect the 2nd proposed commit.
		const secondCommit = graphWebview.locator('.compose-commit').nth(1);
		await secondCommit.locator('gl-button.compose-commit__check').click();
		await expect(secondCommit).toHaveClass(/compose-commit--excluded/);

		const commitButton = graphWebview.locator('gl-button.compose-plan__commit').first();
		await expect(commitButton).toContainText(/Commit 1 Change Set/i);
		await commitButton.click();

		await assertComposedAtop(git, { tag: tag, count: 1, baseSha: baseSha, conservation: conservation });

		const dirtyLines = (await git.status()).split('\n').filter(l => l.trim().length > 0);
		expect(dirtyLines).toHaveLength(1);
		const dirtyFile = dirtyLines[0].slice(3).trim();
		const committedFile = dirtyFile === 'f1.txt' ? 'f2.txt' : 'f1.txt';

		expect(await git.readFileAtRef(committedFile)).toBe(expected[committedFile]);
		expect(await git.readFileAtRef(dirtyFile)).toBe(baseByFile[dirtyFile]);
		expect(await git.readFile(dirtyFile)).toBe(expected[dirtyFile]);
	});

	test('pre-staged index: staged, unstaged, and partially staged changes compose together', async ({ vscode }) => {
		const git = await resetAndModify(vscode.electron.workspacePath, {});
		// f1: fully STAGED modification.
		const modF1 = 'a1-staged\na2\na3\n';
		await git.createFile('f1.txt', modF1);
		await git.stage('f1.txt');
		// f2: fully UNSTAGED modification.
		const modF2 = 'b1\nb2\nb2-unstaged\n';
		await git.createFile('f2.txt', modF2);
		// big: PARTIALLY staged — stage a top edit, then edit the bottom on disk too.
		await git.createFile('big.txt', rows([1, 'row 2 STAGED']));
		await git.stage('big.txt');
		const bigFull = rows([1, 'row 2 STAGED'], [17, 'row 18 UNSTAGED']);
		await git.createFile('big.txt', bigFull);
		expect(await git.status()).toBe('MM big.txt\nM  f1.txt\n M f2.txt');

		// The graph compose scope covers the whole WIP (index + worktree), so all three files — with
		// their combined staged+unstaged content — must fold into the composition through the
		// compose-tools apply (a code path the webview partial-staging test does NOT exercise).
		await graphComposeAndCommit(vscode, graphWebview, git, {
			tag: 'SERIAL-PRESTAGED',
			strategy: 'by-file',
			files: 3,
			commits: 3, // one commit per file (big's two hunks share one)
			baseRef: 'graph-base',
		});

		// Every file landed with its FULL on-disk content — including big.txt's staged AND unstaged hunks.
		expect(await git.readFileAtRef('f1.txt')).toBe(modF1);
		expect(await git.readFileAtRef('f2.txt')).toBe(modF2);
		expect(await git.readFileAtRef('big.txt')).toBe(bigFull);
		expect(await git.isClean()).toBe(true);
	});

	test("split-file: one file's two hunks land in two commits via the graph route", async ({ vscode }) => {
		// Two independent hunks (top + bottom) in a single file — `split-file` forces them into
		// DIFFERENT commits, exercising compose-tools' hunk-level patch slicing (the graph tests above
		// only ever split at file granularity).
		const bigFull = rows([1, 'row 2 CHANGED'], [17, 'row 18 CHANGED']);
		const git = await resetAndModify(vscode.electron.workspacePath, { 'big.txt': bigFull });

		await graphComposeAndCommit(vscode, graphWebview, git, {
			tag: 'SERIAL-SPLIT',
			strategy: 'split-file',
			files: 1,
			commits: 2, // 2 hunks → 2 commits
			baseRef: 'graph-base',
		});

		// Both hunks applied across the two commits with nothing lost or duplicated.
		expect(await git.readFileAtRef('big.txt')).toBe(bigFull);
		expect(await git.isClean()).toBe(true);
	});

	test('leftover restore (text): a DESELECTED commit applies cleanly and leaves no abandoned stash', async ({
		vscode,
	}) => {
		const tag = 'LEFTOVER-TEXT';
		const modF1 = 'a1-lo\na2\na3\n';
		const modF2 = 'b1\nb2\nb2-lo\n';
		const git = await resetAndModify(vscode.electron.workspacePath, { 'f1.txt': modF1, 'f2.txt': modF2 });
		const baseSha = await git.revParse('graph-base');
		const conservation = await captureConservation(git);
		await vscode.gitlens.setComposerPlan('by-file', tag);

		await waitForWipFiles(graphWebview, 2);
		await enterCompose(graphWebview, 2);
		await generate(graphWebview, 2);

		// Deselect the 2nd proposed commit → its file becomes a leftover.
		const secondCommit = graphWebview.locator('.compose-commit').nth(1);
		await secondCommit.locator('gl-button.compose-commit__check').click();
		await expect(secondCommit).toHaveClass(/compose-commit--excluded/);

		const commitButton = graphWebview.locator('gl-button.compose-plan__commit').first();
		await expect(commitButton).toContainText(/Commit 1 Change Set/i);
		await commitButton.click();

		// One commit landed atop the untouched base; the deselected change survives as a normal
		// working change, and no stash was abandoned (assertComposedAtop checks it).
		await assertComposedAtop(git, { tag: tag, count: 1, baseSha: baseSha, conservation: conservation });
		const dirty = (await git.status()).split('\n').filter(l => l.trim().length > 0);
		expect(dirty).toHaveLength(1);
		const leftover = dirty[0].slice(3).trim();
		expect(await git.readFileAtRef(leftover)).toBe(leftover === 'f1.txt' ? baseF1 : baseF2); // not committed
		expect(await git.readFile(leftover)).toBe(leftover === 'f1.txt' ? modF1 : modF2); // preserved in workdir
	});

	test('leftover restore (binary): a DESELECTED binary commit applies cleanly and leaves no abandoned stash', async ({
		vscode,
	}) => {
		const tag = 'LEFTOVER-BINARY';
		const git = await resetAndModify(vscode.electron.workspacePath, { 'f1.txt': 'a1-bin-lo\na2\na3\n' });
		const modBytes = binaryBytes(7);
		await git.createBinaryFile('img.bin', modBytes);
		const baseSha = await git.revParse('graph-base');
		const conservation = await captureConservation(git);
		await vscode.gitlens.setComposerPlan('by-file', tag);

		await waitForWipFiles(graphWebview, 2);
		await enterCompose(graphWebview, 2);
		// `by-file` deterministically yields one commit per file: the binary (rendered with `+0 −0`
		// stats) and the text file (`+1 −1`).
		await generate(graphWebview, 2);

		// Deselect the BINARY's commit (the `+0 −0` one) so the binary becomes the leftover.
		const binaryCommit = graphWebview.locator('.compose-commit', { hasText: '+0' });
		await expect(binaryCommit).toHaveCount(1);
		await binaryCommit.locator('gl-button.compose-commit__check').click();
		await expect(binaryCommit).toHaveClass(/compose-commit--excluded/);

		const commitButton = graphWebview.locator('gl-button.compose-plan__commit').first();
		await expect(commitButton).toContainText(/Commit 1 Change Set/i);
		await commitButton.click();

		// The text change commits atop the untouched base; the binary survives byte-identical as the
		// ONLY remaining working change (nothing else may be left dirty by the leftover restore).
		await assertComposedAtop(git, { tag: tag, count: 1, baseSha: baseSha, conservation: conservation });
		expect(await git.readFileAtRef('f1.txt')).toBe('a1-bin-lo\na2\na3\n');
		expect(await git.status()).toBe(' M img.bin');
		expect((await git.readBinaryFileAtRef('img.bin', 'HEAD')).equals(binaryBytes(0))).toBe(true); // not committed
		expect((await git.readBinaryFile('img.bin')).equals(modBytes)).toBe(true); // preserved in workdir
	});

	test('scope picker: includes an unpushed commit in the compose scope', async ({ vscode }) => {
		const tag = 'SCOPE-UNPUSHED';
		const git = await resetAndModify(vscode.electron.workspacePath, {});
		const pushedBase = await git.revParse('HEAD~1'); // "Base commit" (== origin/main) — preserved

		// A WIP working change (distinct file from the unpushed commit's).
		const wipContent = 'wip content\n';
		await git.createFile('wip.txt', wipContent);
		const conservation = await captureConservation(git);
		await vscode.gitlens.setComposerPlan('by-file', tag);

		// Default compose scope is WIP only → one file (wip.txt).
		await waitForWipFiles(graphWebview, 1);
		await enterCompose(graphWebview, 1);

		// Extend the scope down to the unpushed commit by clicking its row.
		const unpushedRow = graphWebview.locator('.scope-row[data-state="unpushed"]').first();
		await expect(unpushedRow).toBeVisible({ timeout: 30000 });
		await unpushedRow.click();
		await expect(unpushedRow).toHaveClass(/scope-row--included/);
		// Scope now covers WIP + the unpushed commit → two files (wip.txt + u1.txt).
		await expect
			.poll(async () => graphWebview.locator('.scope-files__tree gl-tree-item').count(), { timeout: 15000 })
			.toBe(2);

		await generate(graphWebview, 2); // by-file: wip.txt + u1.txt → 2 commits
		await commitAll(graphWebview);

		await assertComposedAtop(git, { tag: tag, count: 2, baseSha: pushedBase, conservation: conservation });
		// The unpushed commit was rewritten into the composition — its original commit is gone —
		// and both its content and the WIP change are committed.
		expect(await git.log()).not.toContain('U1 unpushed');
		expect(await git.readFileAtRef('u1.txt')).toBe('u1 content\n');
		expect(await git.readFileAtRef('wip.txt')).toBe(wipContent);
		expect(await git.isClean()).toBe(true);
		// Everything folded in → the new tip equals the pre-compose disk state exactly.
		expect(await git.headTree()).toBe(conservation.worktree);
	});

	test('rename split across commits: an unstaged rename+edit composes cleanly with no stash', async ({ vscode }) => {
		// Mirror of a real-world report: an UNSTAGED rename with edits (top + bottom hunks), composed
		// from the graph with scope = WIP. `split-file` forces the renamed file's hunks into different
		// commits. The apply must land the rename + both edits and must NOT round-trip the working
		// changes through a stash (the stash pop conflicts against the already-materialized rename,
		// abandoning the stash and leaving the tree in a merge-conflict state).
		const bigFull = rows([1, 'row 2 RENAMED-EDIT'], [17, 'row 18 RENAMED-EDIT']);
		const git = await resetAndModify(vscode.electron.workspacePath, { 'big2.txt': bigFull });
		await git.deleteFile('big.txt'); // unstaged rename: big.txt → big2.txt (plus the edits)

		// The WIP tree shows the delete + the (untracked) new path as two entries; the hunk shape
		// depends on git's rename detection, so take the count from the settled plan.
		await graphComposeAndCommit(vscode, graphWebview, git, {
			tag: 'SERIAL-RENAME-SPLIT',
			strategy: 'split-file',
			files: 2,
			minCommits: 2, // the plan must actually split
			baseRef: 'graph-base',
		});

		// The rename landed with the full edited content; the old path is gone; nothing dirty.
		expect(await git.readFileAtRef('big2.txt')).toBe(bigFull);
		await expect(git.readFileAtRef('big.txt')).rejects.toThrow();
		expect(await git.isClean()).toBe(true);
	});

	// Deliberately LAST: in full-suite runs under parallel load, the wand chip has intermittently
	// failed to re-render after a manual mode-close exit, timing out the next test's enterCompose
	// (re-entry after a Commit All, which auto-exits, has been reliable — every earlier test relies
	// on it; and re-entry after a manual exit works when run in isolation). Keeping this test last
	// sidesteps that flake entirely.
	test('exiting compose mode after generating applies nothing', async ({ vscode }) => {
		const tag = 'SERIAL-EXIT';
		const modF1 = 'a1-exit\na2\na3\n';
		const git = await resetAndModify(vscode.electron.workspacePath, { 'f1.txt': modF1 });
		const conservation = await captureConservation(git);
		await vscode.gitlens.setComposerPlan('by-file', tag);

		await waitForWipFiles(graphWebview, 1);
		await enterCompose(graphWebview, 1);
		await generate(graphWebview, 1);

		// Walk away: exit compose mode without committing the generated plan.
		await graphWebview.locator('gl-action-chip.mode-close').click();
		await expect(graphWebview.locator('.compose-panel')).toBeHidden({ timeout: 30000 });

		// Give any (buggy) exit-time side effects a moment to land before asserting.
		await new Promise(resolve => setTimeout(resolve, 1000));

		expect(await git.countCommits({ grep: tag })).toBe(0); // the plan was never applied
		expect(await git.status()).toBe(' M f1.txt'); // the working change is fully intact
		expect(await git.readFile('f1.txt')).toBe(modF1);
		await assertComposeConserved(git, conservation);
	});
});
