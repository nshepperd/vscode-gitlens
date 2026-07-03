/**
 * Shared fixtures, helpers, and drivers for the Commit Composer e2e specs (composer*.test.ts).
 *
 * ## AI simulator
 * The AI is handled by GitLens's built-in simulator (a --debug-only provider, no real key — see
 * `src/plus/ai/__debug__simulator*`). It synthesizes a `generate-commits` response from the prompt's
 * real hunks using the strategy set via `setComposerPlan` (`together`/`separate`/`by-file`/
 * `split-file`) and stamps every commit message with a `Simulated-Plan: <tag>` trailer, so tests can
 * count exactly the composed commits with `git log --grep=<tag>`.
 *
 * ## Conservation invariants
 * Composing only re-partitions changes into commits — it must never change what is on disk. That
 * makes these properties required postconditions of EVERY successful apply, regardless of scenario
 * (asserted by {@link assertComposeConserved}, which the drivers run after every apply):
 *   - Working tree conserved — the materialized working-tree tree (every byte on disk, tracked +
 *     untracked) must be identical before and after.
 *   - No abandoned stash — any stash round-trip the apply performs must be fully popped.
 *   - Branch pointer preserved — the repo stays on the same (non-detached) branch. Most content
 *     assertions are HEAD-relative, so without this a detached-HEAD apply would pass them all.
 *
 * ## Drivers
 * {@link composeAndApply} (webview route) and {@link graphComposeAndCommit} (graph route) run the
 * full straight-line protocol — set plan, open, generate, apply, then pin the standard
 * postconditions ({@link assertComposedAtop}). Tests that interact mid-flow (deselect, cancel,
 * tamper, exit) compose the lower-level helpers directly instead.
 *
 * Intentionally NOT a `*.test.ts` file, so Playwright's `testMatch` ignores it.
 */
import type { FrameLocator } from '@playwright/test';
import type { PlanStrategy } from '../../../src/plus/ai/__debug__simulatorState.js';
import type { ComposerCommandArgs } from '../../../src/webviews/plus/composer/registration.js';
import type { GitFixture, VSCodeInstance } from '../baseTest.js';
import { expect, MaxTimeout } from '../baseTest.js';

// ============================================================================
// Content fixtures
// ============================================================================

// Base (committed) content shared across the graph compose scenarios.
export const baseF1 = 'a1\na2\na3\n';
export const baseF2 = 'b1\nb2\n';
export const baseF3 = 'c1\nc2\nc3\n';
export const baseBig = rows();

/**
 * A 20-row file body with optional 0-based row overrides — spread-out rows so a top + bottom edit
 * yields two independent hunks (for split/partial-staging cases).
 */
export function rows(...overrides: [number, string][]): string {
	const body = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`);
	for (const [i, value] of overrides) {
		body[i] = value;
	}
	return `${body.join('\n')}\n`;
}

/** Deterministic 512-byte binary blob (includes null bytes so git treats the file as binary). */
export function binaryBytes(seed: number): Buffer {
	return Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7 + seed * 31) % 256));
}

// ============================================================================
// Conservation invariants
// ============================================================================

export interface ConservationSnapshot {
	/** Materialized working-tree tree sha — see GitFixture.materializedTree. */
	worktree: string;
	/** Current branch name at capture time. */
	branch: string;
}

/**
 * Snapshot the conservation anchors (working tree + branch). Capture AFTER the test has finished
 * writing its working-tree setup, then call {@link assertComposeConserved} once the apply landed.
 */
export async function captureConservation(git: GitFixture): Promise<ConservationSnapshot> {
	return {
		worktree: await git.materializedTree(),
		branch: await git.getCurrentBranch(),
	};
}

/** Assert the universal apply postconditions: working tree conserved, no stash left, branch preserved. */
export async function assertComposeConserved(git: GitFixture, before: ConservationSnapshot): Promise<void> {
	expect(await git.materializedTree(), 'the working tree must be byte-identical across the apply').toBe(
		before.worktree,
	);
	expect(await git.stashList(), 'the apply must not leave an abandoned stash behind').toEqual([]);
	expect(await git.getCurrentBranch(), 'the apply must stay on the same branch (not detach HEAD)').toBe(
		before.branch,
	);
}

/**
 * The standard post-apply pins: exactly `count` tagged commits landed, they sit directly atop the
 * untouched base (omit `baseSha` when the commits below them are themselves legitimately rewritten,
 * e.g. locked commits in recompose-selected), and the conservation invariants hold.
 */
export async function assertComposedAtop(
	git: GitFixture,
	expected: { tag: string; count: number; baseSha?: string; conservation: ConservationSnapshot },
): Promise<void> {
	await expect.poll(async () => git.countCommits({ grep: expected.tag }), { timeout: 30000 }).toBe(expected.count);
	if (expected.baseSha != null) {
		expect(
			await git.revParse(`HEAD~${expected.count}`),
			'the composed commits must sit directly atop the untouched base',
		).toBe(expected.baseSha);
	}
	await assertComposeConserved(git, expected.conservation);
}

// ============================================================================
// Webview (legacy) route helpers
// ============================================================================
// The composer webview panel (title "Commit Composer", root `gl-composer-apphost`) nests its
// controls several shadow roots deep, so these helpers walk the shadow DOM to read state and click
// buttons.

export interface ComposerState {
	commits: { id: string; hunks: number[]; message: string }[];
	generatingCommits: boolean;
	committing: boolean;
	aiOperationError: string | true | null;
	safetyError: string | null;
	hunkCount: number;
}

const getComposerStateScript = `(() => {
	const host = document.querySelector('gl-composer-apphost');
	const app = host && host.shadowRoot && host.shadowRoot.querySelector('gl-composer-app');
	if (!app || !app.state) return JSON.stringify(null);
	const s = app.state;
	return JSON.stringify({
		commits: (s.commits || []).map(c => ({ id: c.id, hunks: c.hunkIndices || [], message: (c.message && c.message.content) || '' })),
		generatingCommits: !!s.generatingCommits,
		committing: !!s.committing,
		aiOperationError: s.aiOperationError ? (s.aiOperationError.error || true) : null,
		safetyError: s.safetyError || null,
		hunkCount: (s.hunks || []).length,
	});
})()`;

/** Reads the composer app's live state (commit list, flags) from the webview. */
export async function getComposerState(webview: FrameLocator): Promise<ComposerState | null> {
	const json = String(await webview.locator(':root').evaluate(getComposerStateScript));
	return JSON.parse(json) as ComposerState | null;
}

/**
 * Click a `gl-button` in the composer by its (case-insensitive substring) label. The composer's
 * controls are nested several shadow roots deep, so we walk them rather than rely on a flat selector.
 * Returns the clicked label, or null if not found.
 */
export async function clickComposerButton(webview: FrameLocator, label: string): Promise<string | null> {
	const script = `(() => {
		const target = ${JSON.stringify(label.toLowerCase())};
		const host = document.querySelector('gl-composer-apphost');
		let clicked = null;
		const walk = (root, depth) => {
			if (!root || depth > 8 || clicked) return;
			root.querySelectorAll('gl-button').forEach(el => {
				if (clicked) return;
				const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
				if (t.toLowerCase().includes(target)) { el.click(); clicked = t; }
			});
			root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot, depth + 1); });
		};
		walk(host && host.shadowRoot, 0);
		return JSON.stringify(clicked);
	})()`;
	return JSON.parse(String(await webview.locator(':root').evaluate(script))) as string | null;
}

/** Open the Commit Composer webview panel and return its frame (fails the test if it doesn't open). */
export async function openComposerPanel(vscode: VSCodeInstance, args?: ComposerCommandArgs): Promise<FrameLocator> {
	await vscode.gitlens.openComposer(args);
	const composer = await vscode.gitlens.getComposerWebview();
	expect(composer, 'the Commit Composer webview should open').not.toBeNull();
	return composer!;
}

/** Auto-Compose and wait until generation settles (or fail loudly on an AI error). */
export async function autoCompose(webview: FrameLocator, expectedCommits: number): Promise<void> {
	const clicked = await clickComposerButton(webview, 'Auto-Compose Commits');
	expect(clicked, 'Auto-Compose Commits button should be present').not.toBeNull();

	// The commit count only reaches the expected value once generation has produced the plan, so it
	// is the settle signal; `generatingCommits` alone would race (it flips true via an async
	// notification, so it can still read false right after the click).
	await expect
		.poll(async () => (await getComposerState(webview))?.commits.length ?? -1, { timeout: 20000 })
		.toBe(expectedCommits);
	await expect.poll(async () => (await getComposerState(webview))?.generatingCommits, { timeout: 20000 }).toBe(false);

	const state = await getComposerState(webview);
	expect(state!.aiOperationError, 'auto-compose should not error').toBeNull();
}

/**
 * Click an AI-trigger button by label ("Auto-Compose Commits" or "Recompose"), wait for generation
 * to settle, assert no AI error, and return the resulting commit count. Use when the count isn't
 * known up front (e.g. recompose, where it depends on the combined-diff hunks).
 *
 * `planTag` must be the tag passed to `setComposerPlan` — a commit message carrying its
 * `Simulated-Plan: <tag>` trailer is the deterministic "the NEW plan landed" signal. Polling only
 * `generatingCommits === false` would race: the flag flips true via an async notification, so an
 * immediate poll can see it still false BEFORE generation starts (and in recompose mode the commit
 * list is pre-populated with the existing commits, so a count poll can't distinguish old from new).
 */
export async function generateAndWait(webview: FrameLocator, triggerLabel: string, planTag: string): Promise<number> {
	const clicked = await clickComposerButton(webview, triggerLabel);
	expect(clicked, `${triggerLabel} button should be present`).not.toBeNull();

	await expect
		.poll(
			async () => {
				const state = await getComposerState(webview);
				if (state == null) return 'no state';
				if (state.aiOperationError != null) return `AI error: ${String(state.aiOperationError)}`;
				if (!state.commits.some(c => c.message.includes(planTag))) return 'no tagged commits yet';
				return state.generatingCommits ? 'still generating' : 'settled';
			},
			{ timeout: 20000 },
		)
		.toBe('settled');

	const state = await getComposerState(webview);
	expect(state, 'composer state should be readable').not.toBeNull();
	expect(state!.aiOperationError, `${triggerLabel} should not error`).toBeNull();
	return state!.commits.length;
}

export interface ComposeApplyOptions {
	/** Plan tag passed to `setComposerPlan`; used to count exactly the composed commits. */
	tag: string;
	strategy: PlanStrategy;
	/** Exact number of commits the plan must propose (omit when the hunk shape decides). */
	commits?: number;
	/** Minimum commits the settled plan must propose (for shapes git may vary, e.g. renames). */
	minCommits?: number;
	/**
	 * Ref the composed commits must sit directly atop; omit to skip the pin (e.g. recompose-selected,
	 * where the locked commits below are themselves rewritten).
	 */
	baseRef?: string;
	/** Extra open args (scope/range/branch) merged over `{ repoPath, mode: 'preview' }`. */
	open?: Partial<ComposerCommandArgs>;
	/** AI trigger button label; use 'Recompose' for the recompose modes. */
	trigger?: 'Auto-Compose Commits' | 'Recompose';
}

/**
 * One-shot webview-route driver: enable the Pro + AI simulations, set the plan, open the composer,
 * generate, apply, and pin the standard postconditions ({@link assertComposedAtop}; recompose also
 * pins the final tree, since recompose preserves the total diff by definition). Returns the
 * composed-commit count for `HEAD~n`-relative content assertions. Tests that interact mid-flow
 * (deselect, cancel, tamper, mid-generation edits) should compose the lower-level helpers instead.
 */
export async function composeAndApply(
	vscode: VSCodeInstance,
	git: GitFixture,
	options: ComposeApplyOptions,
): Promise<number> {
	const conservation = await captureConservation(git);
	const baseSha = options.baseRef != null ? await git.revParse(options.baseRef) : undefined;
	const treeBefore = options.trigger === 'Recompose' ? await git.headTree() : undefined;

	// `await using` (not `using`): the disposers are async, and a fire-and-forget disable landing
	// during the NEXT apply's generation re-arms the AI consent dialog, failing that generation.
	await using _sub = await vscode.gitlens.startSubscriptionSimulation();
	await using _ai = await vscode.gitlens.startAISimulation('default');
	await vscode.gitlens.setComposerPlan(options.strategy, options.tag);

	const composer = await openComposerPanel(vscode, { repoPath: git.repoPath, mode: 'preview', ...options.open });

	if (options.trigger === 'Recompose') {
		// Recompose modes load the range's hunks asynchronously; wait before triggering.
		await expect
			.poll(async () => (await getComposerState(composer))?.hunkCount ?? 0, { timeout: 20000 })
			.toBeGreaterThan(0);
	}

	const n = await generateAndWait(composer, options.trigger ?? 'Auto-Compose Commits', options.tag);
	if (options.commits != null) {
		expect(n, 'the plan should propose the expected commit count').toBe(options.commits);
	}
	if (options.minCommits != null) {
		expect(n, 'the plan should propose at least the minimum commit count').toBeGreaterThanOrEqual(
			options.minCommits,
		);
	}

	const clicked = await clickComposerButton(composer, 'Create');
	expect(clicked).toMatch(new RegExp(`Create ${n} Commits?`, 'i'));

	await assertComposedAtop(git, { tag: options.tag, count: n, baseSha: baseSha, conservation: conservation });
	if (treeBefore != null) {
		expect(await git.headTree(), 'recompose must preserve the total diff (final tree unchanged)').toBe(treeBefore);
	}
	return n;
}

// ============================================================================
// Graph (compose-tools) route helpers
// ============================================================================

export async function ensureDetailsPanelOpen(gw: FrameLocator): Promise<void> {
	const toggle = gw.locator('gl-button[aria-label$="Details Panel"]').first();
	await expect(toggle).toBeVisible({ timeout: MaxTimeout });
	if ((await toggle.getAttribute('aria-label')) === 'Show Details Panel') {
		await toggle.click();
		await expect(gw.locator('gl-button[aria-label="Hide Details Panel"]').first()).toBeVisible({
			timeout: MaxTimeout,
		});
	}
}

export async function selectWip(gw: FrameLocator): Promise<void> {
	await ensureDetailsPanelOpen(gw);

	const wipHeader = gw.locator('gl-details-wip-header gl-details-header').first();
	if (await wipHeader.isVisible().catch(() => false)) return;

	const overviewButton = gw.locator('gl-button[data-action="wip"]').first();
	if (await overviewButton.isVisible().catch(() => false)) {
		await overviewButton.click();
		await ensureDetailsPanelOpen(gw);
		await expect(wipHeader).toBeVisible({ timeout: MaxTimeout });
		return;
	}

	const wipRow = gw
		.getByText(/Working (Changes|Tree)/)
		.filter({ visible: true })
		.first();
	await expect(wipRow).toBeVisible({ timeout: MaxTimeout });
	await wipRow.click();
	await ensureDetailsPanelOpen(gw);
	await expect(wipHeader).toBeVisible({ timeout: MaxTimeout });
}

/**
 * Enter compose mode from the WIP header's wand chip and wait until the file-curation list reflects
 * the working-tree files (so a test can deselect a file before composing).
 */
export async function enterCompose(gw: FrameLocator, expectedFiles: number): Promise<void> {
	await selectWip(gw);
	// The wand chip can lag behind a just-exited compose session, so re-anchor on the WIP row until
	// it renders rather than failing on a single click wait.
	const wand = gw.locator('gl-action-chip[icon="wand"]');
	await expect
		.poll(
			async () => {
				if (await wand.isVisible().catch(() => false)) return true;

				await selectWip(gw).catch(() => undefined);
				return false;
			},
			{ timeout: 30000, intervals: [1000] },
		)
		.toBe(true);
	await wand.click();
	await expect(gw.locator('.compose-panel')).toBeVisible({ timeout: MaxTimeout });
	await expect
		.poll(async () => gw.locator('.scope-files__tree gl-tree-item').count(), { timeout: 30000 })
		.toBe(expectedFiles);
}

/** Trigger generate (compose-group → order through the simulator) and wait for the proposed commits. */
export async function generate(gw: FrameLocator, expectedCommits: number): Promise<void> {
	await gw.locator('gl-ai-input[button-label="Compose"] .action-btn').click();
	await expect(gw.locator('.compose-commit').first()).toBeVisible({ timeout: 60000 });
	await expect.poll(async () => gw.locator('.compose-commit').count(), { timeout: 60000 }).toBe(expectedCommits);
}

/**
 * Like {@link generate}, but for scenarios where the exact commit count depends on how git shapes
 * the diff (e.g. whether a rename is detected). Waits for the proposed-commit list to settle
 * (same count across consecutive polls) and returns the count.
 */
export async function generateAndCount(gw: FrameLocator): Promise<number> {
	await gw.locator('gl-ai-input[button-label="Compose"] .action-btn').click();
	await expect(gw.locator('.compose-commit').first()).toBeVisible({ timeout: 60000 });

	let last = -1;
	await expect
		.poll(
			async () => {
				const count = await gw.locator('.compose-commit').count();
				const stable = count === last;
				last = count;
				return stable;
			},
			{ timeout: 60000, intervals: [500] },
		)
		.toBe(true);
	return last;
}

/** Apply the composed plan (Commit All / Commit N). */
export async function commitAll(gw: FrameLocator): Promise<void> {
	await gw.locator('gl-button.compose-plan__commit').first().click();
}

/**
 * Wait until GitLens's WIP file tree reflects exactly `expected` changed files. This rides out the
 * watcher latency so the subsequent compose-entry snapshot is correct. Re-anchors to the WIP row each
 * poll in case a HEAD move (e.g. from a reset) changed the selected graph row.
 */
export async function waitForWipFiles(gw: FrameLocator, expected: number): Promise<void> {
	await expect
		.poll(
			async () => {
				try {
					await selectWip(gw);
				} catch {
					// keep polling — the WIP row may not be selectable yet right after a reset
				}
				return gw.locator('gl-wip-tree-pane gl-tree-item').count();
			},
			{ timeout: 30000, intervals: [1000] },
		)
		.toBe(expected);
}

/**
 * Open the graph webview with the AI + subscription simulations active (compose is Pro-gated and AI
 * is driven by the simulator). Returns the webview and a disposer for the simulations.
 */
export async function openComposeGraph(
	vscode: VSCodeInstance,
): Promise<{ graphWebview: FrameLocator; dispose: () => Promise<void> }> {
	await vscode.gitlens.startSubscriptionSimulation();
	await vscode.gitlens.startAISimulation('default');

	await vscode.gitlens.showCommitGraphView();
	await vscode.gitlens.panel.open();

	const wv = await vscode.gitlens.getGitLensWebview('Graph', 'webviewView', 60000);
	expect(wv).not.toBeNull();
	await expect(wv!.locator('.details-content').first()).toBeVisible({ timeout: 30000 });

	return {
		graphWebview: wv!,
		dispose: async () => {
			await vscode.gitlens.stopAISimulation();
			await vscode.gitlens.stopSubscriptionSimulation();
		},
	};
}

export interface GraphComposeOptions {
	/** Plan tag passed to `setComposerPlan`; used to count exactly the composed commits. */
	tag: string;
	strategy: PlanStrategy;
	/** Number of changed files the WIP tree / compose scope must show before generating. */
	files: number;
	/** Exact number of commits the plan must propose (omit when the hunk shape decides). */
	commits?: number;
	/** Minimum commits the settled plan must propose (for shapes git may vary, e.g. renames). */
	minCommits?: number;
	/** Ref the composed commits must sit directly atop. */
	baseRef: string;
}

/**
 * One-shot graph-route driver: set the plan, wait for GitLens to detect the working changes, enter
 * compose, generate, Commit All, and pin the standard postconditions ({@link assertComposedAtop}).
 * Returns the composed-commit count. The graph simulations are enabled once per worker by
 * {@link openComposeGraph}, not per call. Tests that interact mid-flow (deselect a file/commit,
 * extend scope, exit without applying) should compose the lower-level helpers instead.
 */
export async function graphComposeAndCommit(
	vscode: VSCodeInstance,
	gw: FrameLocator,
	git: GitFixture,
	options: GraphComposeOptions,
): Promise<number> {
	const conservation = await captureConservation(git);
	const baseSha = await git.revParse(options.baseRef);
	await vscode.gitlens.setComposerPlan(options.strategy, options.tag);

	await waitForWipFiles(gw, options.files);
	await enterCompose(gw, options.files);

	let n: number;
	if (options.commits != null) {
		await generate(gw, options.commits);
		n = options.commits;
	} else {
		n = await generateAndCount(gw);
		if (options.minCommits != null) {
			expect(n, 'the plan should propose at least the minimum commit count').toBeGreaterThanOrEqual(
				options.minCommits,
			);
		}
	}
	await commitAll(gw);

	await assertComposedAtop(git, { tag: options.tag, count: n, baseSha: baseSha, conservation: conservation });
	return n;
}
