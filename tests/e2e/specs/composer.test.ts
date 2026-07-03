/**
 * GitLens Commit Composer — webview route: composition correctness & clean apply.
 *
 * These tests drive the real Commit Composer webview in a live VS Code instance and assert the
 * RESULT at the git level: the composer must commit exactly the intended subset of changes and
 * apply it cleanly without losing or corrupting any data — including for the change types most
 * likely to lose data when split into commits (renames, deletions, binaries, no-trailing-newline
 * content). Driven by the AI simulator; every apply pins the standard postconditions — see
 * composerShared.ts.
 *
 * Auto-Compose is Pro-gated, so every apply enables both the subscription and AI simulations.
 * Requires a --debug build (the simulator lives behind DEBUG): `pnpm run bundle:e2e`.
 */
import * as process from 'node:process';
import { test as base, createTmpDir, expect, GitFixture } from '../baseTest.js';
import {
	assertComposedAtop,
	autoCompose,
	binaryBytes,
	captureConservation,
	clickComposerButton,
	composeAndApply,
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
				// Base content the tests mutate. The rows() files have enough spread-out lines to
				// produce two independent hunks for the split cases.
				await git.createFile('a.txt', 'line1\nline2\nline3\n');
				await git.createFile('b.txt', 'alpha\nbeta\n');
				await git.createFile('big.txt', rows());
				await git.createFile('ren.txt', 'ren1\nren2\nren3\n');
				await git.createFile('del.txt', 'delete me\n');
				await git.createFile('nl.txt', 'a\nb\nc\n');
				await git.createFile('renbig.txt', rows());
				// A committed binary file the binary tests mutate (null bytes => git treats it as binary).
				await git.createBinaryFile('img.bin', binaryBytes(0));
				await git.stageAll();
				await git.commitStaged('Base commit');
				// Tag the clean base so each test can reset to it (the worker shares one workspace repo).
				await git.tag('e2e-base');
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

/** Reset the shared workspace repo to the tagged clean base before each test. */
async function freshRepo(workspacePath: string): Promise<GitFixture> {
	const git = new GitFixture(workspacePath);
	await git.reset('e2e-base', 'hard');
	await git.clean();
	return git;
}

test.describe('Commit Composer — composition correctness (webview route)', () => {
	test.afterEach(async ({ vscode }) => {
		await vscode.gitlens.resetUI();
	});

	test('composes only the staged subset and leaves unstaged changes untouched', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);

		// Stage a modification to a.txt and a new c.txt; leave b.txt's change unstaged.
		await git.createFile('a.txt', 'line1-mod\nline2\nline3\nline4\n');
		await git.createFile('c.txt', 'new file\n');
		await git.createFile('b.txt', 'alpha\nbeta\ngamma\n');
		await git.stage('a.txt');
		await git.stage('c.txt');

		// Two staged hunks (a.txt, c.txt) -> 'separate' -> two commits; b.txt is excluded.
		await composeAndApply(vscode, git, {
			tag: 'SUBSET-001',
			strategy: 'separate',
			commits: 2,
			baseRef: 'e2e-base',
			open: { includedUnstagedChanges: false },
		});

		// No data lost: a.txt + c.txt committed; b.txt's unstaged change still in the working tree.
		expect(await git.readFileAtRef('a.txt')).toBe('line1-mod\nline2\nline3\nline4\n');
		expect(await git.readFileAtRef('c.txt')).toBe('new file\n');
		expect(await git.status()).toBe(' M b.txt');
		expect(await git.readFile('b.txt')).toBe('alpha\nbeta\ngamma\n');
	});

	test('"together" strategy organizes all staged hunks into a single commit', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		await git.createFile('a.txt', 'line1-x\nline2\nline3\n');
		await git.createFile('b.txt', 'alpha-x\nbeta\n');
		await git.stageAll();

		await composeAndApply(vscode, git, {
			tag: 'TOGETHER-001',
			strategy: 'together',
			commits: 1,
			baseRef: 'e2e-base',
		});

		expect(await git.readFileAtRef('a.txt')).toBe('line1-x\nline2\nline3\n');
		expect(await git.readFileAtRef('b.txt')).toBe('alpha-x\nbeta\n');
		expect(await git.isClean()).toBe(true);
	});

	test('"split-file" splits one file\'s two hunks across two commits, applying cleanly', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);

		// Two independent hunks in a single file (top + bottom), staged.
		const expected = rows([1, 'row 2 CHANGED'], [17, 'row 18 CHANGED']);
		await git.createFile('big.txt', expected);
		await git.stage('big.txt');

		// One file with two hunks -> split across two commits.
		await composeAndApply(vscode, git, {
			tag: 'SPLIT-001',
			strategy: 'split-file',
			commits: 2,
			baseRef: 'e2e-base',
		});

		// Both hunks applied across the two commits with no data lost.
		expect(await git.readFileAtRef('big.txt')).toBe(expected);
		expect(await git.isClean()).toBe(true);
	});
});

test.describe('Commit Composer — file-type edge cases (webview route)', () => {
	test.afterEach(async ({ vscode }) => {
		await vscode.gitlens.resetUI();
	});

	test('composes a file rename without losing content', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		const content = await git.readFile('ren.txt');
		// Rename ren.txt → ren2.txt (git detects rename, or treats as add+delete — either must apply cleanly).
		await git.createFile('ren2.txt', content);
		await git.deleteFile('ren.txt');
		await git.stageAll();

		await composeAndApply(vscode, git, {
			tag: 'EDGE-RENAME',
			strategy: 'together',
			commits: 1,
			baseRef: 'e2e-base',
		});

		expect(await git.readFileAtRef('ren2.txt')).toBe(content); // renamed file present, content intact
		await expect(git.readFileAtRef('ren.txt')).rejects.toThrow(); // original gone
		expect(await git.isClean()).toBe(true);
	});

	test('composes a file deletion', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		await git.deleteFile('del.txt');
		await git.stageAll();

		await composeAndApply(vscode, git, {
			tag: 'EDGE-DELETE',
			strategy: 'together',
			commits: 1,
			baseRef: 'e2e-base',
		});

		await expect(git.readFileAtRef('del.txt')).rejects.toThrow(); // deletion applied at HEAD
		expect(await git.isClean()).toBe(true);
	});

	test('preserves a file with no trailing newline byte-for-byte', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		const noNewline = 'a\nb\nMODIFIED'; // deliberately no final \n
		await git.createFile('nl.txt', noNewline);
		await git.stage('nl.txt');

		await composeAndApply(vscode, git, {
			tag: 'EDGE-NONEWLINE',
			strategy: 'together',
			commits: 1,
			baseRef: 'e2e-base',
		});

		// The composer must NOT add or strip the trailing newline.
		expect(await git.readFileAtRef('nl.txt')).toBe(noNewline);
		expect(await git.isClean()).toBe(true);
	});

	test('composes a binary add and a binary delete without corruption or data loss', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);

		// Add a brand-new binary file and delete the existing one; stage both.
		const addedBytes = binaryBytes(2);
		await git.createBinaryFile('added.bin', addedBytes);
		await git.deleteFile('img.bin');
		await git.stageAll();

		await composeAndApply(vscode, git, {
			tag: 'BINARY-002',
			strategy: 'together',
			commits: 1,
			baseRef: 'e2e-base',
		});

		// The add landed byte-identically; the delete took effect; nothing left behind.
		expect((await git.readBinaryFileAtRef('added.bin', 'HEAD')).equals(addedBytes)).toBe(true);
		await expect(git.readBinaryFileAtRef('img.bin', 'HEAD')).rejects.toThrow();
		expect(await git.isClean()).toBe(true);
	});

	test('commits a modified binary file byte-identically and redacts its body from the AI prompt', async ({
		vscode,
	}) => {
		const git = await freshRepo(vscode.electron.workspacePath);
		const baseSha = await git.revParse('e2e-base');

		// Modify the committed binary file and a text file; stage both.
		const newBytes = binaryBytes(1);
		await git.createBinaryFile('img.bin', newBytes);
		await git.createFile('a.txt', 'line1-bin\nline2\nline3\n');
		await git.stage('img.bin');
		await git.stage('a.txt');
		const conservation = await captureConservation(git);

		// Hand-rolled rather than composeAndApply: the prompt must be read back while the AI
		// simulation is still active.
		await using _sub = await vscode.gitlens.startSubscriptionSimulation();
		await using _ai = await vscode.gitlens.startAISimulation('default');
		const tag = 'BINARY-001';
		await vscode.gitlens.setComposerPlan('separate', tag);

		const composer = await openComposerPanel(vscode, { repoPath: git.repoPath, mode: 'preview' });

		// Binary file (1 hunk) + text change (1 hunk) -> 'separate' -> 2 commits.
		await autoCompose(composer, 2);
		await clickComposerButton(composer, 'Create');
		await assertComposedAtop(git, { tag: tag, count: 2, baseSha: baseSha, conservation: conservation });

		// Redaction: the AI prompt must NOT carry the binary patch body, but must still reference
		// the file by name with a placeholder so the model can still group it.
		const prompt = (await vscode.gitlens.getLastAIMessages())?.map(m => m.content).join('\n') ?? '';
		expect(prompt).not.toContain('GIT binary patch');
		expect(prompt).toContain('img.bin');
		expect(prompt).toContain('Binary file');

		// The binary landed byte-identically (no corruption), text applied, tree clean.
		expect((await git.readBinaryFileAtRef('img.bin', 'HEAD')).equals(newBytes)).toBe(true);
		expect(await git.readFileAtRef('a.txt')).toBe('line1-bin\nline2\nline3\n');
		expect(await git.isClean()).toBe(true);
	});

	test('splits a renamed-and-edited file across commits without losing the rename or content', async ({ vscode }) => {
		const git = await freshRepo(vscode.electron.workspacePath);

		// Rename renbig.txt → renbig2.txt AND edit its top + bottom rows — a rename whose content
		// changes arrive as two independent hunks. `split-file` forces those hunks into DIFFERENT
		// commits, so the rename must survive being applied across a multi-commit chain (the classic
		// corruption trap: the second commit's patch must apply against the already-renamed file).
		const expected = rows([1, 'row 2 RENAMED-EDIT'], [17, 'row 18 RENAMED-EDIT']);
		await git.createFile('renbig2.txt', expected);
		await git.deleteFile('renbig.txt');
		await git.stageAll();

		// The hunk shape depends on git's rename detection (rename + 2 content hunks, or whole-file
		// delete + add), so take the count from the settled plan rather than predicting it.
		await composeAndApply(vscode, git, {
			tag: 'EDGE-RENAME-SPLIT',
			strategy: 'split-file',
			minCommits: 2, // split-file must actually split
			baseRef: 'e2e-base',
		});

		// The rename landed with the full edited content, the old path is gone, and nothing leaked.
		expect(await git.readFileAtRef('renbig2.txt')).toBe(expected);
		await expect(git.readFileAtRef('renbig.txt')).rejects.toThrow();
		expect(await git.isClean()).toBe(true);
	});
});
