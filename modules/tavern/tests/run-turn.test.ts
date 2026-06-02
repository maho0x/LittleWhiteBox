import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

import db, {
    createTavernSession,
    deleteTavernMessages,
    getTavernSession,
    listTavernEpisodeSummaries,
    listTavernManagerRuns,
    listTavernMessages,
    listTavernTurnSummaries,
    updateTavernSessionSnapshot,
    upsertTavernTurnSummary,
} from '../shared/session-db';
import { createDefaultXbTavernPreset } from '../shared/presets';
import {
    buildXbTavernMemoryIgnoredTerms,
    buildXbTavernMemoryQuery,
    selectXbTavernMemoryContext,
    setXbTavernMemoryTokenizerForTest,
} from '../shared/memory-retrieval';
import {
    buildContextHistory,
    buildTavernRequestSnapshot,
    runTavernOnce,
    runXbTavernTurn,
    simulateXbTavernRequest,
    type XbTavernRunResult,
    type TavernRunOnceOptions,
} from '../app-src/runtime/run-once';
import { createXbTavernAgentRuntime, EMPTY_XB_TAVERN_CAPABILITY_REGISTRY } from '../app-src/runtime/agent-runtime';
import { resolveXbTavernProviderConfig } from '../app-src/runtime/provider';

async function resetDb() {
    await db.delete();
    await db.open();
}

function tokenizeForMemoryTests(text: string): string[] {
    const value = String(text || '').normalize('NFKC').toLowerCase();
    const tokens: string[] = value.match(/[a-z0-9]{3,}/g) || [];
    const runs = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) || [];
    runs.forEach((run) => {
        for (let size = 2; size <= Math.min(6, run.length); size += 1) {
            for (let index = 0; index <= run.length - size; index += 1) {
                tokens.push(run.slice(index, index + size));
            }
        }
    });
    return tokens;
}

setXbTavernMemoryTokenizerForTest({
    jiebaCut: (text) => tokenizeForMemoryTests(text),
    tinySegmenter: {
        segment: (text) => tokenizeForMemoryTests(text),
    },
});

test('xb tavern run turn saves user and assistant messages and updates session state', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster', description: 'Pilot.' },
            user: { name: 'Player' },
            worldBooks: [{
                name: 'Lore',
                entries: [{
                    uid: 'sticky-entry',
                    content: 'Station lore.',
                    constant: true,
                    sticky: 2,
                }],
            }],
        },
        preset,
        currentUserMessage: 'Hello.',
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'Hi from Aster.',
            provider: 'fake-provider',
            model: 'fake-model',
            finishReason: 'stop',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                provider: 'fake-provider',
                model: 'fake-model',
            }),
        }),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.previewMatchesRequest, true);
    assert.equal(result.nextTurn, 1);
    assert.equal(result.requestSnapshot.provider, 'fake-provider');
    assert.equal(result.requestSnapshot.model, 'fake-model');
    assert.equal(result.requestSnapshot.presetName, '默认');
    const messages = await listTavernMessages(result.sessionId);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(messages[1]?.content, 'Hi from Aster.');
    assert.equal(messages[1]?.provider, 'fake-provider');
    assert.equal(messages[1]?.model, 'fake-model');
    assert.equal(messages[1]?.finishReason, 'stop');
    const session = await getTavernSession(result.sessionId);
    assert.equal(session?.state?.turn, 1);
    assert.equal(Object.keys(session?.state?.worldEntryStates || {}).some((key) => key.includes('sticky-entry')), true);
    assert.equal(session?.state?.lastProvider, 'fake-provider');
});

test('xb tavern run turn can trigger manager summary with delegate config', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    let managerProvider = '';
    let managerPrompt = '';
    let managerCalls = 0;
    const result = await runXbTavernTurn({
        agentConfig: {
            currentPresetName: '主聊天',
            delegatePresetName: '后台管理者',
            presets: {
                主聊天: {
                    provider: 'sillytavern-claude',
                    modelConfigs: {
                        'sillytavern-claude': { model: 'main-model' },
                    },
                },
            },
            delegateConfig: {
                provider: 'sillytavern-openai-compatible',
                modelConfigs: {
                    'sillytavern-openai-compatible': { model: 'manager-model' },
                },
            },
        },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我们去码头。',
        runManager: true,
        awaitManager: true,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: '她点头，把灯吹灭。',
            provider: 'sillytavern-claude',
            model: 'main-model',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                provider: 'sillytavern-claude',
                model: 'main-model',
            }),
        }),
        executeManagerOnce: async (options) => {
            managerCalls += 1;
            managerPrompt = JSON.stringify(options.messages);
            const delegateConfig = options.agentConfig.delegateConfig as { provider?: string } | undefined;
            managerProvider = String(delegateConfig?.provider || '');
            if (managerCalls === 1) {
                return {
                    provider: 'sillytavern-openai-compatible',
                    model: 'manager-model',
                    text: '',
                    toolCalls: [{
                        id: 'write-turn',
                        name: 'MemoryWrite',
                        arguments: {
                            filePath: 'memory/turns/20260601-0000.md',
                            content: [
                                '# Turn 1',
                                '',
                                '- Turn: 1',
                                '- Source: messages 0/1',
                                '',
                                '## Summary',
                                '两人决定去码头，Aster 接受行动。',
                                '',
                                '## State',
                                'Aster 更主动。',
                                '',
                                '## Relationship',
                                '信任增加。',
                                '',
                                '## Location Time Items',
                                '目标地点变成码头。',
                                '',
                                '## Hooks',
                                '- 抵达码头',
                                '',
                                '## Tags',
                                '- 码头',
                            ].join('\n'),
                        },
                    }, {
                        id: 'write-episode',
                        name: 'MemoryWrite',
                        arguments: {
                            filePath: 'memory/episodes/001.md',
                            content: [
                                '# 去码头',
                                '',
                                '- Range: turn 1-1',
                                '',
                                '## Summary',
                                '本阶段围绕两人前往码头展开。',
                                '',
                                '## Key Changes',
                                '- 行动目标确定',
                                '',
                                '## Unresolved',
                                '- 码头有什么',
                            ].join('\n'),
                        },
                    }],
                };
            }
            return {
                provider: 'sillytavern-openai-compatible',
                model: 'manager-model',
                text: '已更新本轮记忆档案。',
            };
        },
    });

    const debugRuns = await listTavernManagerRuns(result.sessionId);
    assert.equal(result.managerStatus, 'completed', JSON.stringify(debugRuns[0] || null));
    assert.ok(result.managerRunId);
    assert.equal(managerProvider, 'sillytavern-openai-compatible');
    assert.match(managerPrompt, /后台管理者/);
    const summaries = await listTavernTurnSummaries(result.sessionId);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.userOrder, 0);
    assert.equal(summaries[0]?.assistantOrder, 1);
    assert.match(summaries[0]?.summary || '', /码头/);
    const episodes = await listTavernEpisodeSummaries(result.sessionId);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0]?.title, '去码头');
    const runs = await listTavernManagerRuns(result.sessionId);
    assert.equal(runs[0]?.status, 'completed');
    assert.equal(runs[0]?.model, 'manager-model');
});

test('xb tavern run turn retrieves relevant old memory beyond recent summaries', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: 'Memory retrieval',
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
    });
    await upsertTavernTurnSummary({
        sessionId: session.id,
        turn: 1,
        userOrder: 0,
        assistantOrder: 1,
        summary: 'Aster 把银钥匙藏在码头钟楼下面。',
        tags: ['银钥匙', '码头钟楼'],
    });
    for (let index = 2; index <= 13; index += 1) {
        await upsertTavernTurnSummary({
            sessionId: session.id,
            turn: index,
            userOrder: index * 2,
            assistantOrder: index * 2 + 1,
            summary: `无关闲聊 ${index}。`,
        });
    }

    let rawMessagesJson = '';
    await runXbTavernTurn({
        sessionId: session.id,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: session.contextSnapshot || {},
        preset,
        currentUserMessage: '她还记得银钥匙放在哪里吗？',
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            rawMessagesJson = JSON.stringify(options.messages);
            return {
                text: '她记得。',
                provider: 'fake-provider',
                model: 'fake-model',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                    provider: 'fake-provider',
                    model: 'fake-model',
                }),
            };
        },
    });

    assert.match(rawMessagesJson, /银钥匙藏在码头钟楼下面/);
});

test('xb tavern memory recall reuses tokenizer terms without letting user and character names recall everything', () => {
    const context = {
        character: { name: 'Aster' },
        user: { name: 'Player' },
        history: [] as Array<{ role: 'assistant'; content: string }>,
    };
    const queryText = buildXbTavernMemoryQuery(context, 'Player：Aster 还记得银钥匙吗？');
    const ignoredTerms = buildXbTavernMemoryIgnoredTerms(context);
    const turnSummaries = [
        {
            id: 'old-key',
            sessionId: 'session',
            turn: 1,
            userOrder: 0,
            assistantOrder: 1,
            summary: 'Aster 把银钥匙藏在码头钟楼下面。',
            tags: ['银钥匙', '码头钟楼'],
            status: 'active' as const,
            createdAt: 1,
            updatedAt: 1,
        },
        ...Array.from({ length: 12 }, (_, index) => ({
            id: `noise-${index}`,
            sessionId: 'session',
            turn: index + 2,
            userOrder: (index + 2) * 2,
            assistantOrder: (index + 2) * 2 + 1,
            summary: `Aster 和 Player 进行无关闲聊 ${index}。`,
            status: 'active' as const,
            createdAt: index + 2,
            updatedAt: index + 2,
        })),
    ];

    const memory = selectXbTavernMemoryContext({
        turnSummaries,
        queryText,
        ignoredTerms,
        recentTurnCount: 0,
        recentEpisodeCount: 0,
    });

    assert.deepEqual(memory.turnSummaries?.map((summary) => summary.id), ['old-key']);
});

test('xb tavern memory query uses current input plus the last two history messages', () => {
    const queryText = buildXbTavernMemoryQuery({
        character: { name: 'Aster' },
        user: { name: 'Player' },
        history: [
            { role: 'user', content: 'old-1 银钥匙' },
            { role: 'assistant', content: 'old-2 码头' },
            { role: 'user', content: 'near-1 钟楼' },
            { role: 'assistant', content: 'near-2 暗门' },
        ],
    }, 'Player：继续');

    assert.match(queryText, /继续/);
    assert.match(queryText, /near-1/);
    assert.match(queryText, /near-2/);
    assert.doesNotMatch(queryText, /old-1/);
    assert.doesNotMatch(queryText, /old-2/);
    assert.doesNotMatch(queryText, /Player：/);
});

test('xb tavern memory recall does not keep recent turn summaries without a match', () => {
    const memory = selectXbTavernMemoryContext({
        turnSummaries: Array.from({ length: 3 }, (_, index) => ({
            id: `recent-${index}`,
            sessionId: 'session',
            turn: index + 1,
            userOrder: index * 2,
            assistantOrder: index * 2 + 1,
            summary: `普通闲聊 ${index}`,
            status: 'active' as const,
            createdAt: index + 1,
            updatedAt: index + 1,
        })),
        queryText: '银钥匙在哪里？',
    });

    assert.deepEqual(memory.turnSummaries, []);
});

test('xb tavern memory recall gives tags and hooks stronger lexical weight than plain summary text', () => {
    const memory = selectXbTavernMemoryContext({
        turnSummaries: [{
            id: 'summary-hit',
            sessionId: 'session',
            turn: 1,
            userOrder: 0,
            assistantOrder: 1,
            summary: '银钥匙曾被提到。',
            status: 'active' as const,
            createdAt: 1,
            updatedAt: 1,
        }, {
            id: 'tag-hit',
            sessionId: 'session',
            turn: 2,
            userOrder: 2,
            assistantOrder: 3,
            summary: '他们换了一个话题。',
            hooks: ['银钥匙'],
            tags: ['银钥匙'],
            status: 'active' as const,
            createdAt: 2,
            updatedAt: 2,
        }],
        queryText: '银钥匙',
    });
    const byId = new Map((memory.turnSummaries || []).map((summary) => [summary.id, summary]));

    assert.ok(Number(byId.get('tag-hit')?.recallScore || 0) > Number(byId.get('summary-hit')?.recallScore || 0));
});

test('xb tavern memory recall filters weak one-off summary matches but keeps weighted hook matches', () => {
    const memory = selectXbTavernMemoryContext({
        turnSummaries: [{
            id: 'weak-summary-hit',
            sessionId: 'session',
            turn: 1,
            userOrder: 0,
            assistantOrder: 1,
            summary: '银钥匙。',
            status: 'active' as const,
            createdAt: 1,
            updatedAt: 1,
        }, {
            id: 'strong-hook-hit',
            sessionId: 'session',
            turn: 2,
            userOrder: 2,
            assistantOrder: 3,
            summary: '他们继续赶路。',
            hooks: ['银钥匙'],
            tags: ['银钥匙'],
            status: 'active' as const,
            createdAt: 2,
            updatedAt: 2,
        }],
        queryText: '银钥匙',
    });

    assert.deepEqual(memory.turnSummaries?.map((summary) => summary.id), ['strong-hook-hit']);
});

test('xb tavern memory recall handles Japanese text through the loaded tokenizer path', () => {
    const memory = selectXbTavernMemoryContext({
        turnSummaries: [{
            id: 'ja-omamori',
            sessionId: 'session',
            turn: 1,
            userOrder: 0,
            assistantOrder: 1,
            summary: '凛は古い神社で赤いお守りを隠した。',
            tags: ['赤いお守り', '神社'],
            status: 'active' as const,
            createdAt: 1,
            updatedAt: 1,
        }],
        queryText: '赤いお守りはどこ？',
        recentTurnCount: 0,
        recentEpisodeCount: 0,
    });

    assert.deepEqual(memory.turnSummaries?.map((summary) => summary.id), ['ja-omamori']);
});

test('xb tavern memory recall does not inject raw turn and episode markdown twice', () => {
    const memory = selectXbTavernMemoryContext({
        turnSummaries: [{
            id: 'md-turn-session-0-1',
            sessionId: 'session',
            turn: 1,
            userOrder: 0,
            assistantOrder: 1,
            summary: 'Aster 把银钥匙藏在码头钟楼下面。',
            tags: ['银钥匙'],
            status: 'active' as const,
            createdAt: 1,
            updatedAt: 1,
        }],
        episodeSummaries: [{
            id: 'md-episode-session-memory/episodes/001.md',
            sessionId: 'session',
            title: '码头钟楼',
            summary: '围绕银钥匙和码头钟楼的阶段。',
            startTurn: 1,
            endTurn: 1,
            turnSummaryIds: ['md-turn-session-0-1'],
            keyChanges: ['银钥匙已藏好'],
            unresolved: ['谁会找到银钥匙'],
            status: 'active' as const,
            createdAt: 1,
            updatedAt: 1,
        }],
        memoryFiles: [{
            sessionId: 'session',
            path: 'memory/turns/20260601-0000.md',
            content: '# Turn 1\n\n## Summary\nAster 把银钥匙藏在码头钟楼下面。',
            status: 'active' as const,
            source: 'manager',
            createdAt: 1,
            updatedAt: 1,
        }, {
            sessionId: 'session',
            path: 'memory/episodes/001.md',
            content: '# 码头钟楼\n\n## Summary\n围绕银钥匙和码头钟楼的阶段。',
            status: 'active' as const,
            source: 'manager',
            createdAt: 1,
            updatedAt: 1,
        }, {
            sessionId: 'session',
            path: 'memory/state.md',
            content: '# 稳定状态\n\n## 物品\n- 银钥匙在码头钟楼下面。',
            status: 'active' as const,
            source: 'manager',
            createdAt: 1,
            updatedAt: 1,
        }, {
            sessionId: 'session',
            path: 'memory/notes.md',
            content: '# 临时笔记\n\n银钥匙在这里也出现。',
            status: 'active' as const,
            source: 'manager',
            createdAt: 1,
            updatedAt: 1,
        }],
        queryText: '银钥匙在哪里？',
        recentTurnCount: 0,
        recentEpisodeCount: 0,
        recentMemoryFileCount: 0,
    });

    assert.deepEqual(memory.turnSummaries?.map((summary) => summary.id), ['md-turn-session-0-1']);
    assert.deepEqual(memory.episodeSummaries?.map((episode) => episode.id), ['md-episode-session-memory/episodes/001.md']);
    assert.deepEqual(memory.memoryFiles?.map((file) => file.path), ['memory/state.md']);
});

test('xb tavern memory recall does not silently fall back when tokenizer is unavailable', () => {
    setXbTavernMemoryTokenizerForTest({});
    assert.throws(() => selectXbTavernMemoryContext({
        turnSummaries: [{
            id: 'zh-key',
            sessionId: 'session',
            turn: 1,
            userOrder: 0,
            assistantOrder: 1,
            summary: '银钥匙藏在码头钟楼下面。',
            status: 'active' as const,
            createdAt: 1,
            updatedAt: 1,
        }],
        queryText: '银钥匙在哪里？',
        recentTurnCount: 0,
        recentEpisodeCount: 0,
    }), /memory_tokenizer_not_ready/);
    setXbTavernMemoryTokenizerForTest({
        jiebaCut: (text) => tokenizeForMemoryTests(text),
        tinySegmenter: {
            segment: (text) => tokenizeForMemoryTests(text),
        },
    });
});

test('xb tavern provider resolver reports shared API readiness and request audit metadata', () => {
    const missing = resolveXbTavernProviderConfig({
        currentPresetName: '默认',
        presets: {
            默认: {
                provider: 'openai-compatible',
                modelConfigs: {
                    'openai-compatible': {
                        baseUrl: 'https://example.com/v1',
                        model: '',
                        apiKey: '',
                    },
                },
            },
        },
    });
    assert.equal(missing.readiness.ok, false);
    assert.deepEqual(missing.readiness.missing, ['模型', 'API Key']);

    const ready = resolveXbTavernProviderConfig({
        currentPresetName: '酒馆 Claude',
        presets: {
            '酒馆 Claude': {
                provider: 'sillytavern-claude',
                modelConfigs: {
                    'sillytavern-claude': {
                        model: 'claude-sonnet-4-0',
                        apiKey: '',
                    },
                },
            },
        },
    });
    assert.equal(ready.readiness.ok, true);
    assert.equal(ready.currentPresetName, '酒馆 Claude');
    assert.equal(ready.providerLabel, '酒馆 Claude');

    const snapshot = buildTavernRequestSnapshot({
        currentPresetName: '酒馆 Claude',
        presets: {
            '酒馆 Claude': {
                provider: 'sillytavern-claude',
                modelConfigs: {
                    'sillytavern-claude': {
                        model: 'claude-sonnet-4-0',
                    },
                },
            },
        },
    }, [{ role: 'user', content: 'Hello.' }]);
    assert.equal(snapshot.presetName, '酒馆 Claude');
    assert.equal(snapshot.providerLabel, '酒馆 Claude');
    assert.equal(snapshot.model, 'claude-sonnet-4-0');
    assert.match(snapshot.rawRequestJson, /"request"/);
    assert.match(snapshot.rawRequestJson, /"messages"/);
});

test('xb tavern simulated request builds raw API JSON without saving chat messages', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: 'Aster',
        characterId: 'char-1',
        characterName: 'Aster',
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster', description: 'A careful scout.' },
        },
        presetId: preset.id,
        presetName: preset.name,
    });
    const result = await simulateXbTavernRequest({
        sessionId: session.id,
        agentConfig: {
            currentPresetName: '酒馆 OpenAI',
            presets: {
                '酒馆 OpenAI': {
                    provider: 'sillytavern-openai-compatible',
                    modelConfigs: {
                        'sillytavern-openai-compatible': {
                            model: 'gpt-test',
                        },
                    },
                },
            },
        },
        contextSnapshot: session.contextSnapshot || {},
        preset,
        currentUserMessage: '只模拟，不发送。',
    });
    assert.equal(result.requestSnapshot.requestKind, 'simulated');
    assert.match(result.requestSnapshot.rawRequestJson, /"url": "\/api\/backends\/chat-completions\/generate"/);
    assert.match(result.requestSnapshot.rawRequestJson, /"stream": true/);
    assert.match(result.requestSnapshot.rawRequestJson, /只模拟，不发送。/);
    assert.deepEqual(await listTavernMessages(session.id), []);
});

test('xb tavern runtime keeps capability registry empty until agent tools are added', () => {
    const provider = resolveXbTavernProviderConfig({
        currentPresetName: '默认',
        presets: {
            默认: {
                provider: 'sillytavern-claude',
                modelConfigs: {
                    'sillytavern-claude': { model: 'claude-sonnet-4-0' },
                },
            },
        },
    });
    const runtime = createXbTavernAgentRuntime(provider);
    const task = runtime.buildChatTask({
        messages: [{ role: 'user', content: 'Hello.' }],
    });
    assert.deepEqual(runtime.capabilities, EMPTY_XB_TAVERN_CAPABILITY_REGISTRY);
    assert.deepEqual(task.tools, []);
    assert.equal(task.toolChoice, 'none');
});

test('xb tavern direct runtime fails before provider call when shared API config is incomplete', async () => {
    await assert.rejects(
        () => runTavernOnce({
            agentConfig: {
                currentPresetName: '默认',
                presets: {
                    默认: {
                        provider: 'openai-compatible',
                        modelConfigs: {
                            'openai-compatible': {
                                model: '',
                                apiKey: '',
                            },
                        },
                    },
                },
            },
            messages: [{ role: 'user', content: 'Hello.' }],
        }),
        /请先在 API 配置里选择模型\/填写 Key/,
    );
});

test('xb tavern run turn records provider failures as error assistant messages', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Fail once.',
        executeRunOnce: async () => {
            throw new Error('provider_failed');
        },
    });

    assert.equal(result.error, 'provider_failed');
    assert.equal(result.finishReason, 'error');
    assert.equal(result.nextTurn, 0);
    const messages = await listTavernMessages(result.sessionId);
    const savedRequestSnapshot = messages[1]?.requestSnapshot as { messageCount?: number } | undefined;
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(messages[1]?.error, true);
    assert.equal(messages[1]?.content, 'provider_failed');
    assert.equal(savedRequestSnapshot?.messageCount, result.requestSnapshot.messageCount);
    const session = await getTavernSession(result.sessionId);
    assert.equal(session?.state?.lastError, 'provider_failed');
    assert.equal(session?.state?.turn, 0);

    let retryRaw = '';
    await runXbTavernTurn({
        sessionId: result.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Retry.',
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            retryRaw = JSON.stringify(options.messages);
            return {
                text: 'Recovered.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });
    assert.doesNotMatch(retryRaw, /provider_failed/);
});

test('xb tavern run turn keeps the actual failed request snapshot when provider exposes it', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Fail with request snapshot.',
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            const error = new Error('provider_failed_after_request') as Error & { requestSnapshot?: unknown };
            error.requestSnapshot = buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                provider: 'actual-provider',
                model: 'actual-model',
                requestInspection: {
                    provider: 'actual-provider',
                    model: 'actual-model',
                    transport: 'test',
                    request: {
                        body: {
                            stream: true,
                            marker: 'actual-failed-request',
                        },
                    },
                },
            });
            throw error;
        },
    });

    assert.equal(result.error, 'provider_failed_after_request');
    assert.match(result.requestSnapshot.rawRequestJson, /actual-failed-request/);
    assert.equal(result.requestSnapshot.provider, 'actual-provider');
    const messages = await listTavernMessages(result.sessionId);
    assert.match(JSON.stringify(messages[1]?.requestSnapshot || {}), /actual-failed-request/);
    const session = await getTavernSession(result.sessionId);
    assert.match(JSON.stringify(session?.state?.lastRequestSnapshot || {}), /actual-failed-request/);
});

test('xb tavern run turn records aborted partial text as assistant message', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Start then stop.',
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            options.onStreamProgress?.({ text: '# Partial\n\nStill useful.' });
            const error = new Error('aborted by user');
            error.name = 'AbortError';
            throw error;
        },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.finishReason, 'aborted');
    assert.equal(result.nextTurn, 1);
    const messages = await listTavernMessages(result.sessionId);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(messages[1]?.content, '# Partial\n\nStill useful.');
    assert.equal(messages[1]?.error, false);
    assert.equal(messages[1]?.finishReason, 'aborted');
    assert.doesNotMatch(messages[1]?.content || '', /<h1>/);
});

test('xb tavern run turn records aborted empty run as error assistant message', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Stop before text.',
        executeRunOnce: async () => {
            const error = new Error('request aborted');
            error.name = 'AbortError';
            throw error;
        },
    });

    assert.equal(result.error, '已停止生成。');
    assert.equal(result.finishReason, 'aborted');
    assert.equal(result.nextTurn, 0);
    const messages = await listTavernMessages(result.sessionId);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(messages[1]?.content, '已停止生成。');
    assert.equal(messages[1]?.error, true);
    assert.equal(messages[1]?.finishReason, 'aborted');
    const session = await getTavernSession(result.sessionId);
    assert.equal(session?.state?.turn, 0);
});

test('xb tavern run turn keeps running when UI callbacks fail', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const originalWarn = console.warn;
    console.warn = () => {};
    let result: XbTavernRunResult | undefined;
    try {
        result = await runXbTavernTurn({
            agentConfig: { provider: 'fake-provider', model: 'fake-model' },
            contextSnapshot: {
                character: { id: 'char-1', name: 'Aster' },
            },
            preset,
            currentUserMessage: 'Do not let UI callbacks stop the turn.',
            onUserMessageSaved: () => {
                throw new Error('ui_user_callback_failed');
            },
            onAssistantMessageSaved: () => {
                throw new Error('ui_assistant_callback_failed');
            },
            executeRunOnce: async (options: TavernRunOnceOptions) => ({
                text: 'Still completed.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            }),
        });
    } finally {
        console.warn = originalWarn;
    }

    assert.ok(result);
    assert.equal(result.error, undefined);
    assert.equal(result.nextTurn, 1);
    const messages = await listTavernMessages(result.sessionId);
    assert.deepEqual(messages.map((message) => `${message.role}:${message.content}`), [
        'user:Do not let UI callbacks stop the turn.',
        'assistant:Still completed.',
    ]);
});

test('xb tavern run turn can rerun from an existing user without duplicating the user message', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const first = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Try again.',
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'Old answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });
    assert.equal(await deleteTavernMessages(first.sessionId, [1]), 1);

    let rawMessages = '';
    await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'ignored because reused order wins',
        reuseUserMessageOrder: 0,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            rawMessages = JSON.stringify(options.messages);
            return {
                text: 'New answer.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    const messages = await listTavernMessages(first.sessionId);
    assert.deepEqual(messages.map((message) => `${message.order}:${message.role}:${message.content}`), [
        '0:user:Try again.',
        '1:assistant:New answer.',
    ]);
    assert.equal((rawMessages.match(/Try again\./g) || []).length, 1);
    assert.doesNotMatch(rawMessages, /ignored because reused order wins/);
});

test('xb tavern rerun deletes future messages and rebuilds state from remaining history', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const contextSnapshot = {
        character: { id: 'char-1', name: 'Aster' },
        worldBooks: [{
            name: 'Lore',
            entries: [{
                uid: 'sticky-entry',
                content: 'Persistent lore.',
                constant: true,
                sticky: 8,
            }, {
                uid: 'second-entry',
                content: 'Only second turn lore.',
                key: ['Second user'],
                sticky: 6,
            }],
        }],
    };
    const first = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot,
        preset,
        currentUserMessage: 'First user.',
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'First answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });
    await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot,
        preset,
        currentUserMessage: 'Second user.',
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'Second answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });

    const rerun = await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot,
        preset,
        currentUserMessage: 'ignored',
        reuseUserMessageOrder: 0,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'Replacement answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });

    assert.equal(rerun.nextTurn, 1);
    const messages = await listTavernMessages(first.sessionId);
    assert.deepEqual(messages.map((message) => `${message.order}:${message.role}:${message.content}`), [
        '0:user:First user.',
        '1:assistant:Replacement answer.',
    ]);
    const session = await getTavernSession(first.sessionId);
    assert.equal(session?.state?.turn, 1);
    assert.deepEqual(session?.state?.worldEntryStates, {
        'Lore\u0000sticky-entry': { stickyUntilTurn: 8 },
    });
});

test('xb tavern context history filters saved error messages for preview and runtime', () => {
    const history = buildContextHistory([
        {
            sessionId: 'session',
            order: 0,
            role: 'user',
            content: 'Hello.',
            createdAt: 1,
        },
        {
            sessionId: 'session',
            order: 1,
            role: 'assistant',
            content: 'provider_failed',
            error: true,
            createdAt: 2,
        },
        {
            sessionId: 'session',
            order: 2,
            role: 'assistant',
            content: 'Recovered.',
            createdAt: 3,
        },
    ]);

    assert.deepEqual(history, [
        { role: 'user', content: 'Hello.' },
        { role: 'assistant', content: 'Recovered.' },
    ]);
});

test('xb tavern run turn keeps existing session context locked until explicit snapshot refresh', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: 'Locked',
        characterId: 'old',
        characterName: 'Old Character',
        contextSnapshot: {
            character: { id: 'old', name: 'Old Character', description: 'Old card.' },
        },
        presetId: preset.id,
        presetName: preset.name,
    });
    let sentRaw = '';
    await runXbTavernTurn({
        sessionId: session.id,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'new', name: 'New Character', description: 'New card.' },
        },
        preset,
        currentUserMessage: 'Who are you?',
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            sentRaw = JSON.stringify(options.messages);
            return {
                text: 'I am old.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });
    assert.match(sentRaw, /Old Character/);
    assert.doesNotMatch(sentRaw, /New Character/);

    await updateTavernSessionSnapshot(session.id, {
        contextSnapshot: {
            character: { id: 'new', name: 'New Character', description: 'New card.' },
        },
    });
    await runXbTavernTurn({
        sessionId: session.id,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'ignored', name: 'Ignored Character' },
        },
        preset,
        currentUserMessage: 'And now?',
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            sentRaw = JSON.stringify(options.messages);
            return {
                text: 'I am new.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });
    assert.match(sentRaw, /New Character/);
    assert.doesNotMatch(sentRaw, /Ignored Character/);
});
