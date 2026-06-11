import * as assert from 'assert';
import type { AIActionType, AIModel } from '../models/model.js';
import type { AIChatMessage } from '../models/provider.js';
import { AnthropicProvider } from '../providers/anthropicProvider.js';
import type { AIProviderContext } from '../providers/context.js';

/*
 * Anthropic's native Messages API (https://api.anthropic.com/v1/messages) rejects
 * `system`-role entries inside `messages` with a 400:
 *   "messages.0: use the top-level 'system' parameter for the initial system prompt"
 *
 * Some callers (notably the compose-tools AiModelPort adapter, which goes through
 * `sendRequest`) embed the system prompt as a leading `system`-role message. These tests
 * pin the wire contract: the provider must hoist such messages into the top-level
 * `system` param before the request is serialized.
 */

interface CapturedRequest {
	url: string;
	body: {
		model: string;
		system?: string;
		messages: { role: string; content: string }[];
		max_tokens?: number;
		max_completion_tokens?: number;
	};
}

function anthropicOkResponse(): Response {
	return new Response(
		JSON.stringify({
			id: 'msg_test',
			model: 'claude-sonnet-4-6',
			content: [{ type: 'text', text: 'response text' }],
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } },
	);
}

class TestAnthropicProvider extends AnthropicProvider {
	// Expose the protected request-translation seam so the existing-top-level-system
	// case (which no public caller can produce today) can be exercised directly.
	fetchCoreForTest(action: AIActionType, model: AIModel<'anthropic'>, request: object): Promise<Response> {
		return this.fetchCore(action, model, 'sk-test', request, undefined);
	}
}

function createProvider(captured: CapturedRequest[]): TestAnthropicProvider {
	const context: AIProviderContext = {
		fetch: (url, init) => {
			captured.push({ url: url.toString(), body: JSON.parse(init?.body as string) });
			return Promise.resolve(anthropicOkResponse());
		},
		getApiKey: () => Promise.resolve('sk-test'),
		getProviderConfig: () => ({ enabled: true }),
		getOrPromptUrl: () => Promise.resolve(undefined),
	};
	return new TestAnthropicProvider(context);
}

async function getModel(provider: AnthropicProvider): Promise<AIModel<'anthropic'>> {
	const models = await provider.getModels();
	const model = models.find(m => m.id === 'claude-sonnet-4-6');
	assert.ok(model, 'expected claude-sonnet-4-6 in the model list');
	return model;
}

function sendRequest(
	provider: TestAnthropicProvider,
	model: AIModel<'anthropic'>,
	messages: AIChatMessage[],
): Promise<unknown> {
	return provider.sendRequest('generate-commits', model, 'sk-test', () => Promise.resolve(messages), {
		signal: new AbortController().signal,
		modelOptions: { outputTokens: 1000, temperature: 0 },
	});
}

suite('AnthropicProvider request shape', () => {
	test('hoists a leading system-role message into the top-level system param', async () => {
		const captured: CapturedRequest[] = [];
		const provider = createProvider(captured);
		const model = await getModel(provider);

		await sendRequest(provider, model, [
			// Mirrors the compose-tools adapter, which casts the role to satisfy the union
			{ role: 'system' as 'user', content: 'You are a commit organizer.' },
			{ role: 'user', content: 'Organize these hunks.' },
		]);

		assert.strictEqual(captured.length, 1);
		const { body } = captured[0];
		assert.strictEqual(body.system, 'You are a commit organizer.', 'system prompt should be hoisted to top level');
		assert.deepStrictEqual(
			body.messages.map(m => m.role),
			['user'],
			'no system-role entries may remain inside messages',
		);
		assert.strictEqual(body.messages[0].content, 'Organize these hunks.');
	});

	test('hoists and joins multiple system-role messages', async () => {
		const captured: CapturedRequest[] = [];
		const provider = createProvider(captured);
		const model = await getModel(provider);

		await sendRequest(provider, model, [
			{ role: 'system' as 'user', content: 'First instruction.' },
			{ role: 'system' as 'user', content: 'Second instruction.' },
			{ role: 'user', content: 'Go.' },
		]);

		const { body } = captured[0];
		assert.strictEqual(body.system, 'First instruction.\n\nSecond instruction.');
		assert.deepStrictEqual(
			body.messages.map(m => m.role),
			['user'],
		);
	});

	test('leaves requests without system messages untouched', async () => {
		const captured: CapturedRequest[] = [];
		const provider = createProvider(captured);
		const model = await getModel(provider);

		await sendRequest(provider, model, [
			{ role: 'user', content: 'first' },
			{ role: 'assistant', content: 'second' },
			{ role: 'user', content: 'third' },
		]);

		const { body } = captured[0];
		assert.strictEqual(body.system, undefined);
		assert.deepStrictEqual(
			body.messages.map(m => m.role),
			['user', 'assistant', 'user'],
		);
	});

	test('preserves an existing top-level system param while still stripping system-role messages', async () => {
		const captured: CapturedRequest[] = [];
		const provider = createProvider(captured);
		const model = await getModel(provider);

		await provider.fetchCoreForTest('generate-commits', model, {
			model: model.id,
			system: 'Existing top-level prompt.',
			messages: [
				{ role: 'system', content: 'Embedded prompt.' },
				{ role: 'user', content: 'Go.' },
			],
			max_completion_tokens: 1000,
		});

		const { body } = captured[0];
		assert.strictEqual(
			body.system,
			'Existing top-level prompt.\n\nEmbedded prompt.',
			'existing system param must come first, embedded system messages appended',
		);
		assert.deepStrictEqual(
			body.messages.map(m => m.role),
			['user'],
		);
	});

	test('rewrites max_completion_tokens to max_tokens', async () => {
		const captured: CapturedRequest[] = [];
		const provider = createProvider(captured);
		const model = await getModel(provider);

		await sendRequest(provider, model, [{ role: 'user', content: 'hello' }]);

		const { body } = captured[0];
		assert.strictEqual(typeof body.max_tokens, 'number');
		assert.ok(!('max_completion_tokens' in body), 'max_completion_tokens must not reach the wire');
	});

	test('parses the Anthropic-native response shape', async () => {
		const captured: CapturedRequest[] = [];
		const provider = createProvider(captured);
		const model = await getModel(provider);

		const result = (await sendRequest(provider, model, [{ role: 'user', content: 'hello' }])) as {
			content: string;
			usage?: { promptTokens?: number; completionTokens?: number };
		};

		assert.strictEqual(result.content, 'response text');
		assert.strictEqual(result.usage?.promptTokens, 10);
		assert.strictEqual(result.usage?.completionTokens, 5);
	});
});
