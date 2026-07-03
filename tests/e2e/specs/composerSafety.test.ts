/**
 * GitLens Commit Composer — webview route: failure paths & the apply-time safety guard.
 *
 * The composer must fail SAFELY: whether AI generation never produces a valid plan, the user
 * cancels mid-generation, the composer is closed without applying, or the repository changed
 * underneath a generated plan (content re-staged differently, a manual commit from a terminal),
 * the result must be the same — no commits created, no stash left behind, and the user's staged
 * change left byte-for-byte intact. For stale plans the guard direction matters:
 * composerScope.test.ts proves benign concurrent edits do NOT trip the apply, so these tests prove
 * a genuinely stale plan DOES refuse to apply (a safety error surfaces instead of a commit).
 *
 * NOTE on simulator modes: `error`/`cancel`/`quota` make the AI provider throw an `AIError`, which
 * the AI service surfaces via an interactive `window.showErrorMessage(..., 'Retry')` — unanswerable
 * headlessly, so those modes are not exercised. We instead cover `invalid` (the composer's own
 * 4-attempt validation failure, no modal) and real user cancellation via the Cancel button during a
 * `slow` generation.
 *
 * Requires a --debug build (`pnpm run bundle:e2e`).
 */
import * as process from 'node:process';
import { test as base, createTmpDir, expect, GitFixture } from '../baseTest.js';
import {
	assertComposeConserved,
	autoCompose,
	captureConservation,
	clickComposerButton,
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
				await git.createFile('app.txt', 'v1\n');
				await git.stageAll();
				await git.commitStaged('Base commit');
				await git.tag('guard-base');
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

test.describe('Commit Composer — failure paths & apply guard (webview route)', () => {
	test.afterEach(async ({ vscode }) => {
		await vscode.gitlens.resetUI();
	});

	async function freshRepoWithStagedChange(workspacePath: string): Promise<GitFixture> {
		const git = new GitFixture(workspacePath);
		await git.reset('guard-base', 'hard');
		await git.clean();
		await git.createFile('app.txt', 'v1\nchange\n');
		await git.stage('app.txt');
		return git;
	}

	/** No commit was made and the staged change is fully intact (still STAGED, exact content). */
	async function assertNoDataLoss(git: GitFixture): Promise<void> {
		expect(await git.log()).toEqual(['Base commit', 'Initial commit']); // history unchanged
		// Exact porcelain match: a failure that silently unstaged ( M) or deleted (D ) the change
		// would still "contain app.txt" — the state must be byte-for-byte what the user had.
		expect(await git.status()).toBe('M  app.txt');
		expect(await git.readFile('app.txt')).toBe('v1\nchange\n'); // working-tree content intact
		expect(await git.stashList()).toEqual([]); // nothing squirreled away in a stash
	}

	test('AI invalid mode: 4-attempt validation failure fails safely', async ({ vscode }) => {
		const git = await freshRepoWithStagedChange(vscode.electron.workspacePath);

		await using _sub = await vscode.gitlens.startSubscriptionSimulation();
		await using _ai = await vscode.gitlens.startAISimulation('invalid');

		const composer = await openComposerPanel(vscode, { repoPath: git.repoPath, mode: 'preview' });

		const clicked = await clickComposerButton(composer, 'Auto-Compose Commits');
		expect(clicked, 'Auto-Compose button should be present').not.toBeNull();
		// Poll the error directly — it is the definitive "generation finished (and failed)" signal.
		// Polling `generatingCommits === false` would race: the flag flips true asynchronously, so an
		// immediate poll can pass before generation even starts.
		await expect
			.poll(async () => (await getComposerState(composer))?.aiOperationError ?? null, { timeout: 30000 })
			.not.toBeNull();
		await assertNoDataLoss(git);
	});

	test('user cancellation via the Cancel button during generation is safe and the panel stays usable', async ({
		vscode,
	}) => {
		const git = await freshRepoWithStagedChange(vscode.electron.workspacePath);

		await using _sub = await vscode.gitlens.startSubscriptionSimulation();
		await using _ai = await vscode.gitlens.startAISimulation('slow'); // 1.5s delay gives a cancel window
		const tag = 'CANCEL-USER';
		await vscode.gitlens.setComposerPlan('separate', tag);

		const composer = await openComposerPanel(vscode, { repoPath: git.repoPath, mode: 'preview' });

		const commitsBefore = (await getComposerState(composer))?.commits.length ?? 0;

		const started = await clickComposerButton(composer, 'Auto-Compose Commits');
		expect(started, 'Auto-Compose button should be present').not.toBeNull();
		// Cancel immediately, within the slow-generation window. The Cancel button only exists while
		// generation is in flight, so finding it proves we cancelled a live generation (no race).
		const cancelled = await clickComposerButton(composer, 'Cancel');
		expect(cancelled, 'Cancel button should be present during generation').not.toBeNull();

		await expect
			.poll(async () => (await getComposerState(composer))?.generatingCommits === false, { timeout: 20000 })
			.toBe(true);

		// The cancellation actually took effect: no plan landed (no new commits, none tagged).
		const afterCancel = await getComposerState(composer);
		expect(afterCancel!.commits.length, 'cancel must discard the in-flight plan').toBe(commitsBefore);
		expect(afterCancel!.commits.some(c => c.message.includes(tag))).toBe(false);

		// Cancellation did not partially apply anything; the change is intact.
		await assertNoDataLoss(git);

		// The panel is still usable: a retry generates a plan normally (webview-only — not applied).
		await autoCompose(composer, 1);
		await assertNoDataLoss(git);
	});

	test('closing the composer after generation, without applying, changes nothing', async ({ vscode }) => {
		const git = await freshRepoWithStagedChange(vscode.electron.workspacePath);
		const conservation = await captureConservation(git);

		await using _sub = await vscode.gitlens.startSubscriptionSimulation();
		await using _ai = await vscode.gitlens.startAISimulation('default');
		const tag = 'ABANDON-001';
		await vscode.gitlens.setComposerPlan('separate', tag);

		const composer = await openComposerPanel(vscode, { repoPath: git.repoPath, mode: 'preview' });

		// Generate a full plan… then walk away without clicking Create.
		await autoCompose(composer, 1);
		await vscode.gitlens.executeCommand('workbench.action.closeActiveEditor');

		// Give any (buggy) dispose-time side effects a moment to land before asserting.
		await new Promise(resolve => setTimeout(resolve, 1000));

		expect(await git.countCommits({ grep: tag })).toBe(0); // the plan was never applied
		await assertNoDataLoss(git);
		await assertComposeConserved(git, conservation);
	});

	test('refuses to apply when the staged content changed after generation', async ({ vscode }) => {
		const git = await freshRepoWithStagedChange(vscode.electron.workspacePath);

		await using _sub = await vscode.gitlens.startSubscriptionSimulation();
		await using _ai = await vscode.gitlens.startAISimulation('default');
		const tag = 'GUARD-STAGED';
		await vscode.gitlens.setComposerPlan('separate', tag);

		const composer = await openComposerPanel(vscode, { repoPath: git.repoPath, mode: 'preview' });
		await autoCompose(composer, 1);

		// The plan is now stale: re-stage DIFFERENT content for the same file (as a user would from a
		// terminal), then try to apply anyway.
		const tampered = 'v1\ntampered\n';
		await git.createFile('app.txt', tampered);
		await git.stage('app.txt');
		expect(await git.status()).toBe('M  app.txt');
		const conservation = await captureConservation(git);

		const clicked = await clickComposerButton(composer, 'Create');
		expect(clicked).toMatch(/Create 1 Commit/i);

		// The guard must fire — a safety error surfaces instead of a commit.
		await expect
			.poll(async () => (await getComposerState(composer))?.safetyError ?? null, { timeout: 20000 })
			.not.toBeNull();

		// Nothing was applied and nothing was lost: history unchanged, the tampered staged change intact.
		expect(await git.countCommits({ grep: tag })).toBe(0);
		expect(await git.log()).toEqual(['Base commit', 'Initial commit']);
		expect(await git.status()).toBe('M  app.txt');
		expect(await git.readFile('app.txt')).toBe(tampered);
		await assertComposeConserved(git, conservation);
	});

	test('refuses to apply when HEAD moved after generation (manual commit in a terminal)', async ({ vscode }) => {
		const git = await freshRepoWithStagedChange(vscode.electron.workspacePath);

		await using _sub = await vscode.gitlens.startSubscriptionSimulation();
		await using _ai = await vscode.gitlens.startAISimulation('default');
		const tag = 'GUARD-HEAD';
		await vscode.gitlens.setComposerPlan('separate', tag);

		const composer = await openComposerPanel(vscode, { repoPath: git.repoPath, mode: 'preview' });
		await autoCompose(composer, 1);

		// The user beats the composer to it: commits the staged change manually. Applying the plan on
		// top would double-apply it — the guard must refuse.
		await git.commitStaged('Manual commit');
		expect(await git.isClean()).toBe(true);
		const conservation = await captureConservation(git);

		const clicked = await clickComposerButton(composer, 'Create');
		expect(clicked).toMatch(/Create 1 Commit/i);

		await expect
			.poll(async () => (await getComposerState(composer))?.safetyError ?? null, { timeout: 20000 })
			.not.toBeNull();

		// The manual commit stands alone — the composer added nothing on top of (or instead of) it.
		expect(await git.countCommits({ grep: tag })).toBe(0);
		expect(await git.log()).toEqual(['Manual commit', 'Base commit', 'Initial commit']);
		expect(await git.readFileAtRef('app.txt')).toBe('v1\nchange\n');
		expect(await git.isClean()).toBe(true);
		await assertComposeConserved(git, conservation);
	});
});
