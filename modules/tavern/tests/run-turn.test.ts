import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

import db, {
    appendTavernMessage,
    createTavernManagerRun,
    createTavernSession,
    deleteTavernMessages,
    getTavernSession,
    listTavernManagerRuns,
    listTavernMessages,
    listTavernTurnSummaries,
    updateTavernMessage,
} from '../shared/session-db';
import {
    executeTavernMemoryTool,
    getTavernMemoryFile,
    getTavernMemoryIndex,
    writeTavernMemoryFile,
} from '../shared/memory-files';
import { executeTavernStateTool } from '../shared/structured-state';
import { createDefaultXbTavernPreset } from '../shared/presets';
import { buildTavernManagerSystemPrompt } from '../shared/assistant-presets';
import { ACTION_CHECK_TOOL_NAME } from '../shared/action-checks';
import {
    buildXbTavernMemoryIgnoredTerms,
    buildXbTavernMemoryQuery,
    selectXbTavernMemoryContext,
    setXbTavernMemoryTokenizerForTest,
} from '../shared/memory-retrieval';
import { mergeTavernSessionContract } from '../shared/session-contract';
import {
    CHANCE_ENCOUNTER_LABEL,
    createActionCheckEvent,
    getActionCheckEvents,
    getChanceEncounterEvent,
    injectActionCheckRenderMarkers,
} from '../shared/runtime-events';
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
import type { TavernApplyRegexItem } from '../shared/regex';
import type { TavernSubstituteParamsItem } from '../shared/substitute-params';

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

test('xb tavern run turn skips random encounters when contract disables them', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    let rawMessages = '';
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Keep the road quiet.',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                randomEncounters: false,
            }),
        },
        randomEncounterRoll: () => 0,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            rawMessages = JSON.stringify(options.messages);
            return {
                text: 'No encounter.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    const [userMessage] = await listTavernMessages(result.sessionId);
    assert.deepEqual(userMessage?.runtimeEvents, []);
    assert.doesNotMatch(rawMessages, /Chance Encounter Triggered/);
});

test('xb tavern run turn persists a triggered encounter and injects its prompt after the current user', async () => {
    await resetDb();
    const presetBase = createDefaultXbTavernPreset();
    const preset = {
        ...presetBase,
        sections: [
            ...(presetBase.sections || []),
            {
                id: 'after-history-sentinel',
                label: 'After History Sentinel',
                placement: 'afterHistory' as const,
                role: 'system' as const,
                content: 'AFTER_HISTORY_SENTINEL',
            },
        ],
    };
    let requestMessages: Array<{ role: string; content: string }> = [];
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Step into the clearing.',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                randomEncounters: true,
            }),
        },
        randomEncounterRoll: () => 0.05,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            requestMessages = options.messages.map((message) => ({
                role: message.role,
                content: message.content,
            }));
            return {
                text: 'The wind shifts.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    const [userMessage] = await listTavernMessages(result.sessionId);
    assert.equal(getChanceEncounterEvent(userMessage?.runtimeEvents)?.label, CHANCE_ENCOUNTER_LABEL);
    const userIndex = requestMessages.findIndex((message) => message.role === 'user' && message.content.includes('Step into the clearing.'));
    const eventIndex = requestMessages.findIndex((message) => message.role === 'system' && message.content.includes('Chance Encounter Triggered'));
    const afterHistoryIndex = requestMessages.findIndex((message) => message.content.includes('AFTER_HISTORY_SENTINEL'));
    assert.ok(userIndex >= 0);
    assert.ok(eventIndex > userIndex);
    assert.ok(afterHistoryIndex > eventIndex);
});

test('xb tavern rerun reuses an existing chance encounter without rerolling', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const first = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Keep watch.',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                randomEncounters: true,
            }),
        },
        randomEncounterRoll: () => 0.05,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'First answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });

    let rollCalls = 0;
    let rerunRawMessages = '';
    await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'ignored',
        reuseUserMessageOrder: 0,
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                randomEncounters: true,
            }),
        },
        randomEncounterRoll: () => {
            rollCalls += 1;
            return 0.95;
        },
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            rerunRawMessages = JSON.stringify(options.messages);
            return {
                text: 'Second answer.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    const [userMessage] = await listTavernMessages(first.sessionId);
    assert.equal(userMessage?.runtimeEvents?.length, 1);
    assert.equal(rollCalls, 0);
    assert.match(rerunRawMessages, /Chance Encounter Triggered/);
});

test('xb tavern random encounter cooldown skips the next new user turn and allows the one after', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const runtimeState = {
        contract: mergeTavernSessionContract(undefined, {
            randomEncounters: true,
        }),
    };
    const first = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Turn one.',
        runtimeState,
        randomEncounterRoll: () => 0.05,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'First answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });
    await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Turn two.',
        runtimeState,
        randomEncounterRoll: () => 0.05,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'Second answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });
    await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Turn three.',
        runtimeState,
        randomEncounterRoll: () => 0.05,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'Third answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });

    const userMessages = (await listTavernMessages(first.sessionId)).filter((message) => message.role === 'user');
    assert.equal(userMessages[0]?.runtimeEvents?.length, 1);
    assert.equal(userMessages[1]?.runtimeEvents?.length, 0);
    assert.equal(userMessages[2]?.runtimeEvents?.length, 1);
});

test('xb tavern edited rerun can reroll runtime events on the reused user message', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const runtimeState = {
        contract: mergeTavernSessionContract(undefined, {
            randomEncounters: true,
        }),
    };
    const first = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Original turn.',
        runtimeState,
        randomEncounterRoll: () => 0.05,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'Original answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });

    const [storedUser] = await listTavernMessages(first.sessionId);
    assert.ok(storedUser);
    await updateTavernMessage(first.sessionId, storedUser.order, {
        content: 'Edited turn.',
        runtimeEvents: [],
    });

    let rerunRawMessages = '';
    await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'ignored',
        reuseUserMessageOrder: storedUser.order,
        rerollRuntimeEvents: true,
        runtimeState,
        randomEncounterRoll: () => 0.05,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            rerunRawMessages = JSON.stringify(options.messages);
            return {
                text: 'Edited answer.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    const [updatedUser] = await listTavernMessages(first.sessionId);
    assert.equal(updatedUser?.content, 'Edited turn.');
    assert.equal(updatedUser?.runtimeEvents?.length, 1);
    assert.match(rerunRawMessages, /Chance Encounter Triggered/);
});

test('xb tavern run turn does not inject action-check protocol or tools when contract disables it', async () => {
    await resetDb();
    const presetBase = createDefaultXbTavernPreset();
    const preset = {
        ...presetBase,
        sections: [
            ...(presetBase.sections || []),
            {
                id: 'after-history-sentinel',
                label: 'After History Sentinel',
                placement: 'afterHistory' as const,
                role: 'system' as const,
                content: 'AFTER_HISTORY_SENTINEL',
            },
        ],
    };
    let rawMessages = '';
    let exposedTools: unknown[] = [];
    await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我想撬开这扇门。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: false,
                randomEncounters: false,
            }),
        },
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            rawMessages = JSON.stringify(options.messages);
            exposedTools = Array.isArray(options.tools) ? options.tools : [];
            return {
                text: '她抬手试了试门把。',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    assert.equal(exposedTools.length, 0);
    assert.doesNotMatch(rawMessages, /Runtime Protocol: Action Checks/);
    assert.doesNotMatch(rawMessages, /AFTER_HISTORY_SENTINEL.+Runtime Protocol: Action Checks/);
});

test('xb tavern run turn injects action-check protocol after current user and exposes ActionCheck tool', async () => {
    await resetDb();
    const presetBase = createDefaultXbTavernPreset();
    const preset = {
        ...presetBase,
        sections: [
            ...(presetBase.sections || []),
            {
                id: 'after-history-sentinel',
                label: 'After History Sentinel',
                placement: 'afterHistory' as const,
                role: 'system' as const,
                content: 'AFTER_HISTORY_SENTINEL',
            },
        ],
    };
    let requestMessages: Array<{ role: string; content: string }> = [];
    let exposedToolNames: string[] = [];
    await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我想撬开这扇门。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            requestMessages = options.messages.map((message) => ({
                role: message.role,
                content: message.content,
            }));
            exposedToolNames = (Array.isArray(options.tools) ? options.tools : [])
                .map((tool) => String((tool as { function?: { name?: string } })?.function?.name || ''))
                .filter(Boolean);
            return {
                text: '她先观察锁孔的磨损。',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                    requestTask: {
                        messages: options.messages,
                        tools: options.tools,
                        toolChoice: options.toolChoice,
                    },
                }),
            };
        },
    });

    const userIndex = requestMessages.findIndex((message) => message.role === 'user' && message.content.includes('我想撬开这扇门'));
    const protocolIndex = requestMessages.findIndex((message) => message.role === 'system' && message.content.includes('Runtime Protocol: Action Checks'));
    const afterHistoryIndex = requestMessages.findIndex((message) => message.content.includes('AFTER_HISTORY_SENTINEL'));
    assert.ok(userIndex >= 0);
    assert.ok(protocolIndex > userIndex);
    assert.ok(afterHistoryIndex > protocolIndex);
    assert.deepEqual(exposedToolNames, [ACTION_CHECK_TOOL_NAME]);
});

test('xb tavern run turn executes multiple action checks and persists assistant runtime events', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const rolls = [16, 12];
    let requestCount = 0;
    const executeRunOnce = Object.assign(async (options: TavernRunOnceOptions) => {
        requestCount += 1;
        if (requestCount === 1) {
            return {
                text: '她猛地跃向断桥彼端。 ',
                toolCalls: [{
                    id: 'check-1',
                    name: ACTION_CHECK_TOOL_NAME,
                    arguments: JSON.stringify({
                        action: 'Leap across the broken bridge',
                        stat: 'Agility',
                        difficulty: 14,
                    }),
                }, {
                    id: 'check-2',
                    name: ACTION_CHECK_TOOL_NAME,
                    arguments: JSON.stringify({
                        action: 'Catch the far stone lip',
                        stat: 'Grip',
                        difficulty: 10,
                    }),
                }],
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                    requestTask: {
                        messages: options.messages,
                        tools: options.tools,
                        toolChoice: options.toolChoice,
                    },
                }),
            };
        }
        assert.equal(options.toolResponses?.length, 2);
        assert.equal(options.messages.length, 0);
        return {
            text: '落点稳住，手指也死死扣进了石缝。',
            finishReason: 'stop',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                requestTask: {
                    messages: options.messages,
                    tools: options.tools,
                    toolResponses: options.toolResponses,
                },
            }),
        };
    }, { supportsSessionToolLoop: true }) as Parameters<typeof runXbTavernTurn>[0]['executeRunOnce'];
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我跳过去，然后抓住对岸石沿。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        actionCheckRoll: () => rolls.shift() || 1,
        executeRunOnce,
    });

    assert.equal(requestCount, 2);
    const messages = await listTavernMessages(result.sessionId);
    const assistantEvents = getActionCheckEvents(messages[1]?.runtimeEvents);
    assert.equal(assistantEvents.length, 2);
    assert.equal(assistantEvents[0]?.roll, 16);
    assert.equal(assistantEvents[0]?.success, true);
    assert.equal(assistantEvents[1]?.roll, 12);
    assert.equal(assistantEvents[1]?.success, true);
    assert.equal(assistantEvents[0]?.insertAfterChars, assistantEvents[1]?.insertAfterChars);
    assert.match(messages[1]?.content || '', /她猛地跃向断桥彼端/);
    assert.match(messages[1]?.content || '', /落点稳住/);
});

test('xb tavern action checks keep live dice visible even when the model calls the tool before any preface text', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const liveSnapshots: Array<{ text: string; eventCount: number }> = [];
    let requestCount = 0;
    await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我立刻翻过窗台。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        actionCheckRoll: () => 18,
        onStreamProgress: (snapshot) => {
            liveSnapshots.push({
                text: String(snapshot.text || ''),
                eventCount: Array.isArray(snapshot.liveActionCheckEvents) ? snapshot.liveActionCheckEvents.length : 0,
            });
        },
        executeRunOnce: Object.assign(async (options: TavernRunOnceOptions) => {
            requestCount += 1;
            if (requestCount === 1) {
                return {
                    text: '',
                    toolCalls: [{
                        id: 'check-preface-free',
                        name: ACTION_CHECK_TOOL_NAME,
                        arguments: JSON.stringify({
                            action: 'Vault through the window',
                            stat: 'Agility',
                            difficulty: 13,
                        }),
                    }],
                    requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
                };
            }
            assert.equal(options.messages.length, 0);
            assert.equal(options.toolResponses?.[0]?.id, 'check-preface-free');
            return {
                text: '她一撑窗沿，顺势翻进了室内。',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        }, { supportsSessionToolLoop: true }) as Parameters<typeof runXbTavernTurn>[0]['executeRunOnce'],
    });

    assert.equal(requestCount, 2);
    assert.equal(liveSnapshots.some((snapshot) => snapshot.text === '' && snapshot.eventCount === 1), true);
});

test('xb tavern action checks stream cumulative text across tool rounds', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const streamed: string[] = [];
    const liveEventCounts: number[] = [];
    let requestCount = 0;
    await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我试着撬锁，然后推门。 ',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        actionCheckRoll: () => 17,
        onStreamProgress: (snapshot) => {
            if (typeof snapshot.text === 'string') {
                streamed.push(snapshot.text);
            }
            if (Array.isArray(snapshot.liveActionCheckEvents)) {
                liveEventCounts.push(snapshot.liveActionCheckEvents.length);
            }
        },
        executeRunOnce: Object.assign(async (options: TavernRunOnceOptions) => {
            requestCount += 1;
            if (requestCount === 1) {
                options.onStreamProgress?.({ text: '她把铁丝探进锁孔。 ' });
                return {
                    text: '她把铁丝探进锁孔。 ',
                    toolCalls: [{
                        id: 'check-stream',
                        name: ACTION_CHECK_TOOL_NAME,
                        arguments: JSON.stringify({
                            action: 'Pick the lock',
                            stat: 'Finesse',
                            difficulty: 12,
                        }),
                    }],
                    requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
                };
            }
            assert.equal(options.messages.length, 0);
            options.onStreamProgress?.({ text: '门闩一松，她顺势推门而入。' });
            return {
                text: '门闩一松，她顺势推门而入。',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        }, { supportsSessionToolLoop: true }) as Parameters<typeof runXbTavernTurn>[0]['executeRunOnce'],
    });

    assert.deepEqual(streamed, [
        '她把铁丝探进锁孔。 ',
        '她把铁丝探进锁孔。 ',
        '她把铁丝探进锁孔。 门闩一松，她顺势推门而入。',
    ]);
    assert.deepEqual(liveEventCounts, [1]);
});

test('xb tavern action checks discard live dice results when the assistant never reaches a saved final reply', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const liveEventCounts: number[] = [];
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我赌一把，从塔窗翻进去。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        actionCheckRoll: () => 19,
        onStreamProgress: (snapshot) => {
            if (Array.isArray(snapshot.liveActionCheckEvents)) {
                liveEventCounts.push(snapshot.liveActionCheckEvents.length);
            }
        },
        executeRunOnce: Object.assign(async (options: TavernRunOnceOptions) => {
            if (!options.toolResponses?.length) {
                return {
                    text: '她踩上窗沿，准备一口气翻进去。 ',
                    toolCalls: [{
                        id: 'check-void',
                        name: ACTION_CHECK_TOOL_NAME,
                        arguments: JSON.stringify({
                            action: 'Vault through the tower window',
                            stat: 'Agility',
                            difficulty: 13,
                        }),
                    }],
                    requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
                };
            }
            assert.equal(options.messages.length, 0);
            throw new Error('provider_exploded_mid_reply');
        }, { supportsSessionToolLoop: true }) as Parameters<typeof runXbTavernTurn>[0]['executeRunOnce'],
    });

    assert.deepEqual(liveEventCounts, [1]);
    assert.equal(result.assistantMessage, undefined);
    assert.match(result.errorMessage?.content || '', /provider_exploded_mid_reply/);
    const messages = await listTavernMessages(result.sessionId);
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.error, true);
    assert.equal(getActionCheckEvents(messages[1]?.runtimeEvents).length, 0);
});

test('xb tavern action checks render markers keep one whole markdown string and group same-offset rolls', () => {
    const payload = injectActionCheckRenderMarkers('她把铁丝探进锁孔。门开了。', [
        createActionCheckEvent({
            action: 'Pick the lock',
            stat: 'Finesse',
            difficulty: 12,
            roll: 15,
            success: true,
            insertAfterChars: 9,
        }),
        createActionCheckEvent({
            action: 'Keep the hinges quiet',
            stat: 'Stealth',
            difficulty: 10,
            roll: 14,
            success: true,
            insertAfterChars: 9,
        }),
    ]);

    assert.equal(payload.groups.length, 1);
    assert.equal(payload.groups[0]?.events.length, 2);
    assert.match(payload.text, /门开了/);
    assert.equal(payload.text.length, '她把铁丝探进锁孔。门开了。'.length + 1);
});

test('xb tavern run turn denies unknown RP tools and does not persist action-check events for them', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    let requestCount = 0;
    const executeRunOnce = Object.assign(async (options: TavernRunOnceOptions) => {
        requestCount += 1;
        if (requestCount === 1) {
            return {
                text: '她屏住呼吸，手已经探向警铃底座。 ',
                toolCalls: [{
                    id: 'weird-tool',
                    name: 'ImprovisedExplosionSolver',
                    arguments: JSON.stringify({ problem: 'alarm' }),
                }],
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        }
        assert.match(JSON.stringify(options.toolResponses || []), /只允许调用 ActionCheck/);
        return {
            text: '她停下手，决定先重新判断线路走向。',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        };
    }, { supportsSessionToolLoop: true }) as Parameters<typeof runXbTavernTurn>[0]['executeRunOnce'];
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我试着摸黑拆掉警铃。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        executeRunOnce,
    });

    assert.equal(requestCount, 2);
    const messages = await listTavernMessages(result.sessionId);
    assert.equal(getActionCheckEvents(messages[1]?.runtimeEvents).length, 0);
});

test('xb tavern action checks replay tool results through messages when session tool loop is unavailable', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    let requestCount = 0;
    await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我赌一把，从窗台翻进塔里。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        actionCheckRoll: () => 18,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            requestCount += 1;
            if (requestCount === 1) {
                assert.equal(Array.isArray(options.toolResponses), false);
                return {
                    text: '她踩上窗沿，呼吸压得极轻。 ',
                    toolCalls: [{
                        id: 'check-replay',
                        name: ACTION_CHECK_TOOL_NAME,
                        arguments: JSON.stringify({
                            action: 'Vault through the tower window',
                            stat: 'Agility',
                            difficulty: 13,
                        }),
                    }],
                    requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
                };
            }
            assert.equal(Array.isArray(options.toolResponses), false);
            const replayTool = options.messages.find((message) => message.role === 'tool') as {
                tool_call_id?: string;
                toolName?: string;
            } | undefined;
            assert.equal(replayTool?.tool_call_id, 'check-replay');
            assert.equal(replayTool?.toolName, ACTION_CHECK_TOOL_NAME);
            return {
                text: '她借着惯性翻入塔内，靴跟轻轻擦过石窗。',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    assert.equal(requestCount, 2);
});

test('xb tavern action checks send a final reminder when tools finished but model returns no visible text', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    let requestCount = 0;
    const executeRunOnce = Object.assign(async (options: TavernRunOnceOptions) => {
        requestCount += 1;
        if (requestCount === 1) {
            return {
                text: '她把发夹探进锁孔。 ',
                toolCalls: [{
                    id: 'check-reminder',
                    name: ACTION_CHECK_TOOL_NAME,
                    arguments: JSON.stringify({
                        action: 'Pick the lock',
                        stat: 'Finesse',
                        difficulty: 12,
                    }),
                }],
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        }
        if (requestCount === 2) {
            assert.equal(options.toolResponses?.[0]?.id, 'check-reminder');
            assert.equal(options.messages.length, 0);
            return {
                text: '',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                    requestTask: {
                        finalAnswerReminderText: options.finalAnswerReminderText,
                    },
                }),
            };
        }
        assert.match(String(options.finalAnswerReminderText || ''), /Do not call more tools/);
        assert.equal(options.messages.length, 0);
        return {
            text: '锁芯发出一声轻响，门闩终于松开。',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                requestTask: {
                    finalAnswerReminderText: options.finalAnswerReminderText,
                },
            }),
        };
    }, { supportsSessionToolLoop: true }) as Parameters<typeof runXbTavernTurn>[0]['executeRunOnce'];

    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我试着撬开这把锁。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        actionCheckRoll: () => 15,
        executeRunOnce,
    });

    assert.equal(requestCount, 3);
    assert.match(result.assistantMessage?.content || '', /门闩终于松开/);
});

test('xb tavern action checks still send the final reminder after the max tool round only returns more tools', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    let requestCount = 0;
    const executeRunOnce = Object.assign(async (options: TavernRunOnceOptions) => {
        requestCount += 1;
        if (requestCount <= 8) {
            if (requestCount === 1) {
                assert.equal(Array.isArray(options.toolResponses), false);
            } else {
                assert.equal(options.messages.length, 0);
                assert.equal(options.toolResponses?.[0]?.id, `check-${requestCount - 1}`);
                assert.equal(String(options.finalAnswerReminderText || ''), '');
            }
            return {
                text: '',
                toolCalls: [{
                    id: `check-${requestCount}`,
                    name: ACTION_CHECK_TOOL_NAME,
                    arguments: JSON.stringify({
                        action: `Risky attempt ${requestCount}`,
                        stat: 'Luck',
                        difficulty: 12,
                    }),
                }],
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                    requestTask: {
                        messages: options.messages,
                        toolResponses: options.toolResponses,
                        finalAnswerReminderText: options.finalAnswerReminderText,
                    },
                }),
            };
        }
        if (requestCount === 9) {
            assert.equal(options.messages.length, 0);
            assert.equal(options.toolResponses?.[0]?.id, 'check-8');
            assert.equal(String(options.finalAnswerReminderText || ''), '');
            return {
                text: '',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                    requestTask: {
                        messages: options.messages,
                        toolResponses: options.toolResponses,
                        finalAnswerReminderText: options.finalAnswerReminderText,
                    },
                }),
            };
        }
        assert.equal(requestCount, 10);
        assert.equal(options.messages.length, 0);
        assert.match(String(options.finalAnswerReminderText || ''), /Do not call more tools/);
        return {
            text: '命运终于尘埃落定，她没有继续冒险，而是收住了动作。',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                requestTask: {
                    messages: options.messages,
                    toolResponses: options.toolResponses,
                    finalAnswerReminderText: options.finalAnswerReminderText,
                },
            }),
        };
    }, { supportsSessionToolLoop: true }) as Parameters<typeof runXbTavernTurn>[0]['executeRunOnce'];

    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我连续冒险，直到命运给出最后结果。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        actionCheckRoll: () => 15,
        executeRunOnce,
    });

    assert.equal(requestCount, 10);
    assert.match(result.assistantMessage?.content || '', /命运终于尘埃落定/);
});

test('xb tavern action checks fail the turn when the model still gives no conclusion after the final reminder', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    let requestCount = 0;
    const executeRunOnce = Object.assign(async (options: TavernRunOnceOptions) => {
        requestCount += 1;
        if (requestCount === 1) {
            return {
                text: '她把发夹探进锁孔。 ',
                toolCalls: [{
                    id: 'check-no-conclusion',
                    name: ACTION_CHECK_TOOL_NAME,
                    arguments: JSON.stringify({
                        action: 'Pick the lock',
                        stat: 'Finesse',
                        difficulty: 12,
                    }),
                }],
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        }
        return {
            text: '',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                requestTask: {
                    finalAnswerReminderText: options.finalAnswerReminderText,
                },
            }),
        };
    }, { supportsSessionToolLoop: true }) as Parameters<typeof runXbTavernTurn>[0]['executeRunOnce'];

    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我试着撬开这把锁。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        actionCheckRoll: () => 4,
        executeRunOnce,
    });

    assert.equal(requestCount, 3);
    assert.equal(result.assistantMessage, undefined);
    assert.match(result.errorMessage?.content || '', /没有给出有效结论/);
});

test('xb tavern action checks remap dice-card offsets after aiOutput regex rewrites the final assistant text', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我跳过断桥。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        actionCheckRoll: () => 18,
        applyRegex: async (items) => ({
            items: items.map((item) => item.placement === 'aiOutput'
                ? {
                    id: item.id,
                    text: String(item.text || '').replace('她猛地跃向断桥彼端。 ', '她先深吸一口气，猛地跃向断桥彼端。 '),
                    changed: true,
                }
                : { id: item.id, text: item.text, changed: false }),
            changedCount: items.some((item) => item.placement === 'aiOutput') ? 1 : 0,
        }),
        executeRunOnce: Object.assign(async (options: TavernRunOnceOptions) => {
            if (!options.toolResponses?.length) {
                return {
                    text: '她猛地跃向断桥彼端。 ',
                    toolCalls: [{
                        id: 'check-remap',
                        name: ACTION_CHECK_TOOL_NAME,
                        arguments: JSON.stringify({
                            action: 'Leap across the broken bridge',
                            stat: 'Agility',
                            difficulty: 14,
                        }),
                    }],
                    requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
                };
            }
            return {
                text: '落地时她稳稳收住重心。',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        }, { supportsSessionToolLoop: true }) as Parameters<typeof runXbTavernTurn>[0]['executeRunOnce'],
    });

    const messages = await listTavernMessages(result.sessionId);
    const assistant = messages.find((message) => message.role === 'assistant' && !message.error);
    const events = getActionCheckEvents(assistant?.runtimeEvents);
    assert.match(assistant?.content || '', /她先深吸一口气/);
    assert.equal(events.length, 1);
    assert.equal(
        (assistant?.content || '').slice(0, events[0]?.insertAfterChars || 0),
        '她先深吸一口气，猛地跃向断桥彼端。 ',
    );
});

test('xb tavern rerun regenerates assistant action checks cleanly instead of reusing old dice events', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const first = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: '我撬门。',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        actionCheckRoll: () => 17,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            if (!options.toolResponses?.length) {
                return {
                    text: '她把铁丝探进锁孔。 ',
                    toolCalls: [{
                        id: 'check-1',
                        name: ACTION_CHECK_TOOL_NAME,
                        arguments: JSON.stringify({
                            action: 'Pick the lock',
                            stat: 'Finesse',
                            difficulty: 12,
                        }),
                    }],
                    requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
                };
            }
            return {
                text: '锁芯轻轻一响，门开了。',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    let rerunCalls = 0;
    await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'ignored',
        reuseUserMessageOrder: 0,
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: true,
                randomEncounters: false,
            }),
        },
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            rerunCalls += 1;
            assert.equal(options.toolResponses?.length || 0, 0);
            return {
                text: '她停手，决定先听门后的动静。',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    assert.equal(rerunCalls, 1);
    const messages = await listTavernMessages(first.sessionId);
    assert.equal(messages.length, 2);
    assert.equal(getActionCheckEvents(messages[1]?.runtimeEvents).length, 0);
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
            delegatePresetName: '记忆管理员',
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
            const turnMemoryPath = managerPrompt.match(/memory\/turns\/\d{8}-\d+\.md/)?.[0] || '';
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
                            filePath: turnMemoryPath,
                            content: [
                                '# 去码头',
                                '',
                                '两人决定去码头，Aster 接受行动。',
                                '',
                                '状态：',
                                'Aster 更主动。',
                                '',
                                '关系：',
                                '信任增加。',
                                '',
                                '地点与物品：',
                                '目标地点变成码头。',
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
    assert.match(managerPrompt, /小白酒馆后台管理员/);
    assert.match(managerPrompt, /后台统筹者/);
    assert.match(managerPrompt, /## Work Loop/);
    assert.match(managerPrompt, /## Source Strategy/);
    assert.match(managerPrompt, /## Structured State/);
    assert.match(managerPrompt, /建议流水路径：memory\/turns\/\d{8}-0000\.md/);
    assert.match(managerPrompt, /In automatic after-turn runs, use MemoryWrite or MemoryEdit/i);
    assert.match(managerPrompt, /New sessions already include a seed map/i);
    assert.match(managerPrompt, /Read StateRead first, inspect `meta\.status` and `meta\.hint`/i);
    assert.match(managerPrompt, /If the map is still `uninitialized`, initialize it with one `meta \+ add` transaction/i);
    assert.match(managerPrompt, /initialize it with one `meta \+ add` transaction/i);
    assert.match(managerPrompt, /always start with StateRead summary and inspect `meta\.status`/i);
    assert.match(managerPrompt, /Do not decide whether to read based only on your own guess about/i);
    assert.match(managerPrompt, /When a map already exists, use incremental `add` \/ `modify` \/ `remove` \/ `meta` updates/i);
    assert.match(managerPrompt, /First appearance does not require a prior/i);
    assert.match(managerPrompt, /what defines the boundary, where are the entrances and exits, where is the current player or viewpoint focus/i);
    assert.match(managerPrompt, /For indoor scenes, use an outer-wall rect as the anchor/i);
    assert.match(managerPrompt, /`meta\.viewBox` is the camera/i);
    assert.match(managerPrompt, /at least one spatial geometry element/i);
    assert.match(managerPrompt, /Place text labels 15-25 units beside what they describe/i);
    assert.match(managerPrompt, /enough geometry to carry the map body/i);
    assert.match(managerPrompt, /回复像电纸书完成文件操作后的交代/);
    assert.match(managerPrompt, /Use MemoryGrep to ask whether a fact already exists in memory\. Use ChatHistory grep to ask whether something happened in the RP source text\./i);
    assert.doesNotMatch(managerPrompt, /可派生格式/);
    assert.doesNotMatch(managerPrompt, /messages userOrder\/assistantOrder/);
    assert.doesNotMatch(managerPrompt, /ChatHistory recent 读取最新消息/);
    assert.doesNotMatch(managerPrompt, /MemoryEdit `edits` 必须是真正的非空数组/);
    const summaries = await listTavernTurnSummaries(result.sessionId);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.userOrder, 0);
    assert.equal(summaries[0]?.assistantOrder, 1);
    assert.match(summaries[0]?.summary || '', /码头/);
    const runs = await listTavernManagerRuns(result.sessionId);
    assert.equal(runs[0]?.status, 'completed');
    assert.equal(runs[0]?.model, 'manager-model');
});

test('tavern manager prompt strips unauthorized module rules cleanly', () => {
    const memoryOnly = buildTavernManagerSystemPrompt({}, {
        includeMemory: true,
        includeCartography: false,
    });
    assert.match(memoryOnly, /MemoryWrite/);
    assert.doesNotMatch(memoryOnly, /## Structured State/);
    assert.doesNotMatch(memoryOnly, /StateRead/);
    assert.doesNotMatch(memoryOnly, /inspect or change the map/i);
    assert.doesNotMatch(memoryOnly, /spatial relation view/i);
    assert.doesNotMatch(memoryOnly, /The map is extra spatial state/i);

    const mapOnly = buildTavernManagerSystemPrompt({}, {
        includeMemory: false,
        includeCartography: true,
    });
    assert.match(mapOnly, /## Structured State/);
    assert.match(mapOnly, /StateRead summary/);
    assert.doesNotMatch(mapOnly, /MemoryWrite/);
    assert.doesNotMatch(mapOnly, /memory\/session\.md/);
    assert.doesNotMatch(mapOnly, /校正记忆/);
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
    await writeTavernMemoryFile(session.id, 'memory/turns/20260601-0000.md', '# 本轮记忆\n\nAster 把银钥匙藏在码头钟楼下面。', {
        source: 'manager',
    });
    for (let index = 2; index <= 13; index += 1) {
        await writeTavernMemoryFile(session.id, `memory/turns/20260601-${String(index).padStart(4, '0')}.md`, `# 本轮记忆\n\n无关闲聊 ${index}。`, {
            source: 'manager',
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

test('xb tavern regex transforms user input, world info, and AI output in the real turn path', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: 'Regex turn',
        characterId: 'char-1',
        characterName: 'Aster',
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
            worldBooks: [{
                name: 'Lore',
                entries: [{
                    uid: 'regex-world',
                    content: 'RAW_WORLD should be transformed.',
                    constant: true,
                }],
            }],
        },
        state: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: false,
                randomEncounters: false,
            }),
        },
    });
    await appendTavernMessage(session.id, { role: 'user', content: 'OLD_USER already saved.' });
    await appendTavernMessage(session.id, {
        role: 'assistant',
        content: 'OLD_AI already saved.',
        thoughts: [{ label: 'hidden', text: 'OLD_REASONING already saved.' }],
    });
    const calls: Array<{ placement: string; isPrompt: boolean; depth: unknown; text: string }> = [];
    const streamed: string[] = [];
    let providerMessagesJson = '';
    const applyRegex = async (items: TavernApplyRegexItem[]) => ({
        items: items.map((item) => {
            calls.push({
                placement: item.placement,
                isPrompt: item.options?.isPrompt === true,
                depth: item.options?.depth,
                text: item.text,
            });
            const isPrompt = item.options?.isPrompt === true;
            return {
                id: item.id,
                text: isPrompt && item.placement === 'userInput'
                    ? item.text.replace(/SAVED_USER/g, 'PROMPT_USER').replace(/OLD_USER/g, 'PROMPT_OLD_USER')
                    : isPrompt && item.placement === 'aiOutput'
                        ? item.text.replace(/OLD_AI/g, 'PROMPT_OLD_AI')
                        : isPrompt && item.placement === 'reasoning'
                            ? item.text.replace(/OLD_REASONING/g, 'PROMPT_OLD_REASONING')
                        : item.text
                            .replace(/RAW_USER/g, 'SAVED_USER')
                            .replace(/RAW_WORLD/g, 'REGEX_WORLD')
                            .replace(/RAW_AI/g, 'REGEX_AI')
                            .replace(/RAW_REASONING/g, 'REGEX_REASONING'),
                changed: /RAW_(USER|WORLD|AI|REASONING)|SAVED_USER|OLD_USER|OLD_AI|OLD_REASONING/.test(item.text),
            };
        }),
        changedCount: items.filter((item) => /RAW_(USER|WORLD|AI|REASONING)|SAVED_USER|OLD_USER|OLD_AI|OLD_REASONING/.test(item.text)).length,
    });
    const result = await runXbTavernTurn({
        sessionId: session.id,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: session.contextSnapshot || {},
        preset,
        currentUserMessage: 'RAW_USER asks.',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                actionChecks: false,
                randomEncounters: false,
            }),
        },
        applyRegex,
        onStreamProgress: (snapshot) => {
            if (typeof snapshot.text === 'string') {streamed.push(snapshot.text);}
        },
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            providerMessagesJson = JSON.stringify(options.messages);
            return {
                text: 'RAW_AI replies.',
                thoughts: [{ label: 'thinking', text: 'RAW_REASONING hidden thought.' }],
                provider: 'fake-provider',
                model: 'fake-model',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages, {
                    provider: 'fake-provider',
                    model: 'fake-model',
                    regexApplications: options.regexApplications,
                }),
            };
        },
    });

    assert.equal(calls.some((call) => call.placement === 'userInput' && !call.isPrompt && call.text === 'RAW_USER asks.'), true);
    assert.equal(calls.some((call) => call.placement === 'userInput' && call.isPrompt && call.text === 'SAVED_USER asks.' && call.depth === 0), true);
    assert.equal(calls.some((call) => call.placement === 'userInput' && call.isPrompt && call.text === 'OLD_USER already saved.' && call.depth === 2), true);
    assert.equal(calls.some((call) => call.placement === 'aiOutput' && call.isPrompt && call.text === 'OLD_AI already saved.' && call.depth === 1), true);
    assert.equal(calls.some((call) => call.placement === 'reasoning' && call.isPrompt && call.text === 'OLD_REASONING already saved.' && call.depth === 1), true);
    assert.match(providerMessagesJson, /PROMPT_USER asks/);
    assert.match(providerMessagesJson, /PROMPT_OLD_USER already saved/);
    assert.match(providerMessagesJson, /PROMPT_OLD_AI already saved/);
    assert.match(providerMessagesJson, /PROMPT_OLD_REASONING already saved/);
    assert.match(providerMessagesJson, /REGEX_WORLD should be transformed/);
    assert.doesNotMatch(providerMessagesJson, /"thoughts"/);
    assert.doesNotMatch(providerMessagesJson, /RAW_USER|RAW_WORLD|SAVED_USER/);
    assert.equal(providerMessagesJson.includes('"content":"OLD_USER already saved."'), false);
    assert.equal(providerMessagesJson.includes('"content":"OLD_AI already saved."'), false);
    assert.equal(streamed.at(-1), 'REGEX_AI replies.');
    const messages = await listTavernMessages(result.sessionId);
    assert.equal(messages[0]?.content, 'OLD_USER already saved.');
    assert.equal(messages[1]?.content, 'OLD_AI already saved.');
    assert.deepEqual(messages[1]?.thoughts, [{ label: 'hidden', text: 'OLD_REASONING already saved.' }]);
    assert.equal(messages[2]?.content, 'SAVED_USER asks.');
    assert.equal(messages[3]?.content, 'REGEX_AI replies.');
    assert.deepEqual(messages[3]?.thoughts, [{ label: 'thinking', text: 'REGEX_REASONING hidden thought.' }]);
    assert.equal((result.requestSnapshot.regexApplications as { userInput?: number; worldInfo?: number; aiOutput?: number; reasoning?: number } | undefined)?.userInput, 3);
    assert.equal((result.requestSnapshot.regexApplications as { userInput?: number; worldInfo?: number } | undefined)?.worldInfo, 1);
    assert.equal((result.requestSnapshot.regexApplications as { aiOutput?: number } | undefined)?.aiOutput, 2);
    assert.equal((result.requestSnapshot.regexApplications as { reasoning?: number } | undefined)?.reasoning, 2);
});

test('xb tavern simulated request applies regex without saving messages', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: 'Regex simulation',
        characterId: 'char-1',
        characterName: 'Aster',
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
            worldBooks: [{
                name: 'Lore',
                entries: [{
                    uid: 'regex-world',
                    content: 'RAW_WORLD prompt lore.',
                    constant: true,
                }],
            }],
        },
    });
    const applyRegex = async (items: TavernApplyRegexItem[]) => ({
        items: items.map((item) => ({
            id: item.id,
            text: item.text.replace(/RAW_USER/g, 'REGEX_USER').replace(/RAW_WORLD/g, 'REGEX_WORLD'),
            changed: /RAW_(USER|WORLD)/.test(item.text),
        })),
        changedCount: items.filter((item) => /RAW_(USER|WORLD)/.test(item.text)).length,
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
        currentUserMessage: 'RAW_USER simulate.',
        applyRegex,
    });

    assert.match(result.requestSnapshot.rawRequestJson, /REGEX_USER simulate/);
    assert.match(result.requestSnapshot.rawRequestJson, /REGEX_WORLD prompt lore/);
    assert.doesNotMatch(result.requestSnapshot.rawRequestJson, /RAW_USER|RAW_WORLD/);
    assert.deepEqual(await listTavernMessages(session.id), []);
});

test('xb tavern simulated request applies prompt-stage regex to history without rewriting saved text', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: 'Regex prompt simulation',
        characterId: 'char-1',
        characterName: 'Aster',
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
    });
    await appendTavernMessage(session.id, { role: 'user', content: 'OLD_USER saved.' });
    await appendTavernMessage(session.id, {
        role: 'assistant',
        content: 'OLD_AI saved.',
        thoughts: [{ label: 'hidden', text: 'OLD_REASONING saved.' }],
    });
    const applyRegex = async (items: TavernApplyRegexItem[]) => ({
        items: items.map((item) => {
            const isPrompt = item.options?.isPrompt === true;
            const text = isPrompt && item.placement === 'userInput'
                ? item.text.replace(/SAVED_USER/g, 'PROMPT_USER').replace(/OLD_USER/g, 'PROMPT_OLD_USER')
                : isPrompt && item.placement === 'aiOutput'
                    ? item.text.replace(/OLD_AI/g, 'PROMPT_OLD_AI')
                    : isPrompt && item.placement === 'reasoning'
                        ? item.text.replace(/OLD_REASONING/g, 'PROMPT_OLD_REASONING')
                    : item.text.replace(/RAW_USER/g, 'SAVED_USER');
            return {
                id: item.id,
                text,
                changed: text !== item.text,
            };
        }),
        changedCount: items.length,
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
        currentUserMessage: 'RAW_USER simulate.',
        applyRegex,
    });

    assert.match(result.requestSnapshot.rawRequestJson, /PROMPT_USER simulate/);
    assert.match(result.requestSnapshot.rawRequestJson, /PROMPT_OLD_USER saved/);
    assert.match(result.requestSnapshot.rawRequestJson, /PROMPT_OLD_AI saved/);
    assert.match(result.requestSnapshot.rawRequestJson, /PROMPT_OLD_REASONING saved/);
    assert.doesNotMatch(result.requestSnapshot.rawRequestJson, /"thoughts"/);
    assert.doesNotMatch(result.requestSnapshot.rawRequestJson, /RAW_USER|SAVED_USER/);
    assert.equal(result.requestSnapshot.rawRequestJson.includes('"content": "OLD_USER saved."'), false);
    assert.equal(result.requestSnapshot.rawRequestJson.includes('"content": "OLD_AI saved."'), false);
    assert.deepEqual((await listTavernMessages(session.id)).map((message) => message.content), [
        'OLD_USER saved.',
        'OLD_AI saved.',
    ]);
    assert.deepEqual((await listTavernMessages(session.id))[1]?.thoughts, [{ label: 'hidden', text: 'OLD_REASONING saved.' }]);
});

test('xb tavern regex failure before sending does not save untransformed chat messages', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: 'Regex failure',
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
    });

    await assert.rejects(
        () => runXbTavernTurn({
            sessionId: session.id,
            agentConfig: { provider: 'fake-provider', model: 'fake-model' },
            contextSnapshot: session.contextSnapshot || {},
            preset,
            currentUserMessage: 'RAW_USER fails.',
            applyRegex: async () => {
                throw new Error('regex_failed_before_send');
            },
            executeRunOnce: async () => {
                throw new Error('provider_should_not_run');
            },
        }),
        /regex_failed_before_send/,
    );
    assert.deepEqual(await listTavernMessages(session.id), []);
});

test('xb tavern applies native macro substitution to user input, world keys, world content, and final prompt JSON', async () => {
    await resetDb();
    const session = await createTavernSession({
        title: 'Macro substitution',
        characterId: 'char-1',
        characterName: 'Aster',
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster', description: 'Pilot for {{user}}.' },
            user: { name: 'Player' },
            worldBooks: [{
                name: 'Lore',
                entries: [{
                    uid: 'macro-world',
                    key: ['{{char}} beacon'],
                    content: 'World says {{char}} trusts {{user}}.',
                }],
            }],
            worldSettings: {
                scanDepth: 2,
            },
        },
    });
    await appendTavernMessage(session.id, { role: 'assistant', content: 'Earlier {{char}} note.' });
    const applySubstituteParams = async (items: TavernSubstituteParamsItem[]) => ({
        items: items.map((item) => {
            const text = item.text
                .replace(/\{\{char\}\}/g, String(item.options?.name2Override || 'Aster'))
                .replace(/\{\{user\}\}/g, String(item.options?.name1Override || 'Player'));
            return {
                id: item.id,
                text,
                changed: text !== item.text,
            };
        }),
        changedCount: items.filter((item) => /\{\{(?:char|user)\}\}/.test(item.text)).length,
    });
    let providerMessagesJson = '';

    const result = await runXbTavernTurn({
        sessionId: session.id,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: session.contextSnapshot || {},
        chatPreset: {
            sections: [{
                id: 'macro-preset',
                role: 'system',
                placement: 'top',
                content: 'Preset greets {{char}} and {{user}}.',
            }],
        },
        currentUserMessage: '{{char}} beacon from {{user}}.',
        applySubstituteParams,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            providerMessagesJson = JSON.stringify(options.messages);
            return {
                text: 'Done.',
                provider: 'fake-provider',
                model: 'fake-model',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    assert.match(providerMessagesJson, /Preset greets Aster and Player/);
    assert.match(providerMessagesJson, /Pilot for Player/);
    assert.match(providerMessagesJson, /World says Aster trusts Player/);
    assert.match(providerMessagesJson, /Earlier Aster note/);
    assert.match(providerMessagesJson, /Aster beacon from Player/);
    assert.doesNotMatch(providerMessagesJson, /\{\{char\}\}|\{\{user\}\}/);
    assert.match(result.requestSnapshot.rawRequestJson, /World says Aster trusts Player/);
    assert.doesNotMatch(result.requestSnapshot.rawRequestJson, /\{\{char\}\}|\{\{user\}\}/);
    const messages = await listTavernMessages(result.sessionId);
    assert.equal(messages.find((message) => message.role === 'user')?.content, 'Aster beacon from Player.');
});

test('xb tavern does not pass empty macro name overrides that would hide SillyTavern globals', async () => {
    await resetDb();
    const session = await createTavernSession({
        title: 'Macro fallback',
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
            user: { name: '' },
        },
    });
    const seenOptions: Array<Record<string, unknown> | undefined> = [];
    const applySubstituteParams = async (items: TavernSubstituteParamsItem[]) => ({
        items: items.map((item) => {
            seenOptions.push(item.options as Record<string, unknown> | undefined);
            const charName = Object.prototype.hasOwnProperty.call(item.options || {}, 'name2Override')
                ? String(item.options?.name2Override ?? '')
                : 'GlobalChar';
            const userName = Object.prototype.hasOwnProperty.call(item.options || {}, 'name1Override')
                ? String(item.options?.name1Override ?? '')
                : 'GlobalUser';
            const text = item.text
                .replace(/\{\{char\}\}/g, charName)
                .replace(/\{\{user\}\}/g, userName);
            return {
                id: item.id,
                text,
                changed: text !== item.text,
            };
        }),
        changedCount: items.filter((item) => /\{\{(?:char|user)\}\}/.test(item.text)).length,
    });
    let providerMessagesJson = '';

    const result = await runXbTavernTurn({
        sessionId: session.id,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: session.contextSnapshot || {},
        chatPreset: {
            sections: [{
                id: 'macro-fallback-preset',
                role: 'system',
                placement: 'top',
                content: 'Preset sees {{char}} and {{user}}.',
            }],
        },
        currentUserMessage: '{{char}} meets {{user}}.',
        applySubstituteParams,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            providerMessagesJson = JSON.stringify(options.messages);
            return {
                text: 'Done.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    assert.equal(seenOptions.some((options) => Object.prototype.hasOwnProperty.call(options || {}, 'name1Override')), false);
    assert.equal(seenOptions.some((options) => String(options?.name2Override || '') === 'Aster'), true);
    assert.match(providerMessagesJson, /Preset sees Aster and GlobalUser/);
    assert.match(providerMessagesJson, /Aster meets GlobalUser/);
    assert.equal((await listTavernMessages(result.sessionId)).find((message) => message.role === 'user')?.content, 'Aster meets GlobalUser.');
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
            content: '# 银钥匙\n\nAster 把银钥匙藏在码头钟楼下面。',
            status: 'active' as const,
            source: 'manager',
            createdAt: 1,
            updatedAt: 1,
        }, {
            sessionId: 'session',
            path: 'memory/episodes/001.md',
            content: '# 码头钟楼\n\n围绕银钥匙和码头钟楼的阶段。',
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

test('xb tavern world entry substitution skips null worldbook records', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const loreEntry = {
        uid: 'lore-1',
        key: ['Aster'],
        content: '{{char}} meets {{user}} in the old hall.',
        sourceWorldBook: 'BrokenLore',
        world: 'BrokenLore',
        position: 0,
    };
    const contextSnapshot = {
        character: { id: 'char-1', name: 'Aster', description: 'A careful scout.' },
        user: { name: 'Player' },
        worldBooks: [
            null,
            { name: 'BrokenLore', entries: [null, loreEntry] },
        ],
        worldEntries: [null, loreEntry],
    } as unknown as Parameters<typeof simulateXbTavernRequest>[0]['contextSnapshot'];
    const session = await createTavernSession({
        title: 'Aster',
        characterId: 'char-1',
        characterName: 'Aster',
        contextSnapshot,
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
        contextSnapshot,
        preset,
        currentUserMessage: 'Aster 继续前进。',
        applySubstituteParams: async (items: TavernSubstituteParamsItem[]) => ({
            items: items.map((item) => ({
                id: item.id,
                text: item.text.replace(/\{\{char\}\}/g, 'Aster').replace(/\{\{user\}\}/g, 'Player'),
                changed: item.text.includes('{{'),
            })),
            changedCount: items.filter((item) => item.text.includes('{{')).length,
        }),
    });
    assert.match(result.buildSnapshot.rawMessagesJson, /Aster meets Player in the old hall\./);
    assert.doesNotMatch(result.buildSnapshot.rawMessagesJson, /null/);
});

test('xb tavern simulated request injects map digest without full map JSON', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: 'Map digest',
        characterId: 'char-map',
        characterName: 'Mapper',
        contextSnapshot: {
            character: { id: 'char-map', name: 'Mapper', description: 'A cartographer.' },
        },
        presetId: preset.id,
        presetName: preset.name,
    });
    await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{
            op: 'init',
            document: {
                meta: { name: 'Hidden Cellar', theme: 'parchment', viewBox: [0, 0, 500, 400] },
                elements: [
                    { id: 'cellar-room', type: 'rect', pos: [30, 30], size: [120, 80], cat: 'wall' },
                    { id: 'cellar-label', type: 'text', pos: [90, 80], content: 'Cellar', cat: 'label' },
                ],
            },
        }],
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
        currentUserMessage: '我看向地窖。',
    });

    assert.match(result.buildSnapshot.rawMessagesJson, /可视化结构状态摘要/);
    assert.match(result.buildSnapshot.rawMessagesJson, /Hidden Cellar/);
    assert.match(result.buildSnapshot.rawMessagesJson, /revision 1/);
    assert.doesNotMatch(result.buildSnapshot.rawMessagesJson, /"elements"/);
    assert.equal(result.buildSnapshot.structuredStates?.[0]?.docType, 'tavern.map');
    assert.equal(result.buildSnapshot.structuredStates?.[0]?.docId, 'main');
    assert.equal(result.buildSnapshot.structuredStates?.[0]?.revision, 1);
    assert.ok(Number(result.buildSnapshot.structuredStates?.[0]?.digestChars) > 0);
});

test('xb tavern simulated request injects only memory files when cartography is disabled', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: 'Memory only contract',
        characterId: 'char-memory',
        characterName: 'Archivist',
        contextSnapshot: {
            character: { id: 'char-memory', name: 'Archivist', description: 'Keeps notes.' },
        },
        presetId: preset.id,
        presetName: preset.name,
        state: {
            contract: mergeTavernSessionContract(undefined, {
                memoryArchiving: true,
                cartographyEngine: false,
            }),
        },
    });
    await writeTavernMemoryFile(session.id, 'memory/session.md', '# Session\nSECRET_MEMORY_NOTE', { source: 'user' });
    await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{
            op: 'meta',
            set: {
                name: 'Hidden Cellar',
                viewBox: [0, 0, 500, 400],
                status: 'active',
            },
        }, {
            op: 'add',
            element: { id: 'cellar-room', at: [30, 30], rect: [120, 80], cat: 'wall' },
        }],
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
        currentUserMessage: '把档案给我。',
    });

    assert.match(result.buildSnapshot.rawMessagesJson, /SECRET_MEMORY_NOTE/);
    assert.doesNotMatch(result.buildSnapshot.rawMessagesJson, /可视化结构状态摘要/);
    assert.equal(result.buildSnapshot.structuredStates, undefined);
});

test('xb tavern simulated request injects only structured state when memory archiving is disabled', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: 'Map only contract',
        characterId: 'char-map-only',
        characterName: 'Scout',
        contextSnapshot: {
            character: { id: 'char-map-only', name: 'Scout', description: 'Checks routes.' },
        },
        presetId: preset.id,
        presetName: preset.name,
        state: {
            contract: mergeTavernSessionContract(undefined, {
                memoryArchiving: false,
                cartographyEngine: true,
            }),
        },
    });
    await writeTavernMemoryFile(session.id, 'memory/session.md', '# Session\nSECRET_MEMORY_NOTE', { source: 'user' });
    await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{
            op: 'meta',
            set: {
                name: 'River Road',
                viewBox: [0, 0, 500, 400],
                status: 'active',
            },
        }, {
            op: 'add',
            element: { id: 'camp', at: [120, 90], rect: [180, 120], cat: 'terrain' },
        }],
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
        currentUserMessage: '前面有什么路？',
    });

    assert.match(result.buildSnapshot.rawMessagesJson, /可视化结构状态摘要/);
    assert.match(result.buildSnapshot.rawMessagesJson, /River Road/);
    assert.doesNotMatch(result.buildSnapshot.rawMessagesJson, /SECRET_MEMORY_NOTE/);
    assert.doesNotMatch(result.buildSnapshot.rawMessagesJson, /固定记忆档案/);
    assert.equal(result.buildSnapshot.structuredStates?.[0]?.docId, 'main');
});

test('xb tavern simulated request ignores unusable empty session snapshots', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: '旧空会话',
        characterId: '',
        characterName: '',
        contextSnapshot: {},
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
        contextSnapshot: {
            character: {
                id: 'char-live',
                name: 'Live Aster',
                description: 'Live character card.',
            },
            worldBooks: [{
                name: 'Live Lore',
                entries: [{
                    uid: 'live-lore',
                    content: 'Live constant lore.',
                    constant: true,
                }],
            }],
        },
        preset,
        currentUserMessage: '模拟当前资料。',
    });

    assert.match(result.requestSnapshot.rawRequestJson, /<character_card>/);
    assert.match(result.requestSnapshot.rawRequestJson, /Live Aster/);
    assert.match(result.requestSnapshot.rawRequestJson, /Live constant lore/);
});

test('xb tavern simulated request ignores system-name session snapshots', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const session = await createTavernSession({
        title: '坏快照',
        characterId: 'system',
        characterName: 'SillyTavern System',
        contextSnapshot: {
            character: {
                id: 'system',
                name: 'SillyTavern System',
            },
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
        contextSnapshot: {
            character: {
                id: 'seraphina',
                name: 'Seraphina',
                description: 'A real character card.',
            },
            worldBooks: [{
                name: 'Seraphina Lore',
                entries: [{
                    uid: 'seraphina-lore',
                    content: 'Seraphina constant lore.',
                    constant: true,
                }],
            }],
        },
        preset,
        currentUserMessage: '继续。',
    });

    assert.doesNotMatch(result.requestSnapshot.rawRequestJson, /SillyTavern System/);
    assert.match(result.requestSnapshot.rawRequestJson, /Seraphina/);
    assert.match(result.requestSnapshot.rawRequestJson, /Seraphina constant lore/);
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
    let managerCalls = 0;
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Start then stop.',
        runManager: true,
        awaitManager: true,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            options.onStreamProgress?.({ text: '# Partial\n\nStill useful.' });
            const error = new Error('aborted by user');
            error.name = 'AbortError';
            throw error;
        },
        executeManagerOnce: async () => {
            managerCalls += 1;
            return { text: '不应该调用自动管理员。' };
        },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.finishReason, 'aborted');
    assert.equal(result.nextTurn, 1);
    assert.equal(result.managerRunId, '');
    assert.equal(result.managerStatus, '');
    assert.equal(managerCalls, 0);
    const messages = await listTavernMessages(result.sessionId);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(messages[1]?.content, '# Partial\n\nStill useful.');
    assert.equal(messages[1]?.error, false);
    assert.equal(messages[1]?.finishReason, 'aborted');
    assert.doesNotMatch(messages[1]?.content || '', /<h1>/);
    assert.equal((await listTavernManagerRuns(result.sessionId)).length, 0);
});

test('xb tavern aborted partial output records AI_OUTPUT regex in request snapshot metadata', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const result = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Start then stop.',
        applyRegex: async (items: TavernApplyRegexItem[]) => ({
            items: items.map((item) => ({
                id: item.id,
                text: item.placement === 'aiOutput' ? item.text.replace(/RAW_PARTIAL/g, 'REGEX_PARTIAL') : item.text,
                changed: item.placement === 'aiOutput' && item.text.includes('RAW_PARTIAL'),
            })),
            changedCount: items.filter((item) => item.placement === 'aiOutput' && item.text.includes('RAW_PARTIAL')).length,
        }),
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            options.onStreamProgress?.({ text: 'RAW_PARTIAL text.' });
            const error = new Error('aborted by user');
            error.name = 'AbortError';
            throw error;
        },
    });

    assert.equal(result.finishReason, 'aborted');
    assert.equal(result.assistantMessage?.content, 'REGEX_PARTIAL text.');
    assert.equal((result.requestSnapshot.regexApplications as { aiOutput?: number } | undefined)?.aiOutput, 1);
    const messages = await listTavernMessages(result.sessionId);
    assert.equal(messages[1]?.content, 'REGEX_PARTIAL text.');
    assert.equal(((messages[1]?.requestSnapshot as { regexApplications?: { aiOutput?: number } })?.regexApplications)?.aiOutput, 1);
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

test('xb tavern rerun uses regenerate world info trigger', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const contextSnapshot = {
        character: { id: 'char-1', name: 'Aster' },
        worldBooks: [{
            name: 'Lore',
            entries: [
                { uid: 'normal-only', content: 'NORMAL_TRIGGER_LORE', constant: true, triggers: ['normal'] },
                { uid: 'regen-only', content: 'REGENERATE_TRIGGER_LORE', constant: true, triggers: ['regenerate'] },
            ],
        }],
    };
    const first = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot,
        preset,
        currentUserMessage: 'Try again.',
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            const rawMessages = JSON.stringify(options.messages);
            assert.match(rawMessages, /NORMAL_TRIGGER_LORE/);
            assert.doesNotMatch(rawMessages, /REGENERATE_TRIGGER_LORE/);
            return {
                text: 'Old answer.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });
    assert.equal(await deleteTavernMessages(first.sessionId, [1]), 1);

    let rerunRawMessages = '';
    await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot,
        preset,
        currentUserMessage: 'ignored',
        reuseUserMessageOrder: 0,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            rerunRawMessages = JSON.stringify(options.messages);
            return {
                text: 'New answer.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    assert.match(rerunRawMessages, /REGENERATE_TRIGGER_LORE/);
    assert.doesNotMatch(rerunRawMessages, /NORMAL_TRIGGER_LORE/);
});

test('xb tavern rerun rebuilds world entry state with macro-substituted world keys', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const contextSnapshot = {
        character: { id: 'char-1', name: 'Aster' },
        user: { name: 'Player' },
        worldBooks: [{
            name: 'Lore',
            entries: [{
                uid: 'macro-sticky',
                key: ['{{char}} trigger'],
                content: 'MACRO_STICKY_LORE',
                sticky: 8,
            }],
        }],
    };
    const applySubstituteParams = async (items: TavernSubstituteParamsItem[]) => ({
        items: items.map((item) => {
            const text = item.text
                .replace(/\{\{char\}\}/g, String(item.options?.name2Override || 'Aster'))
                .replace(/\{\{user\}\}/g, String(item.options?.name1Override || 'Player'));
            return {
                id: item.id,
                text,
                changed: text !== item.text,
            };
        }),
        changedCount: items.filter((item) => /\{\{(?:char|user)\}\}/.test(item.text)).length,
    });
    const first = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot,
        preset,
        currentUserMessage: '{{char}} trigger.',
        applySubstituteParams,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'First.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });
    const second = await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot,
        preset,
        currentUserMessage: 'No trigger here.',
        applySubstituteParams,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'Second.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });
    await deleteTavernMessages(second.sessionId, [3]);

    let rerunRawMessages = '';
    await runXbTavernTurn({
        sessionId: second.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot,
        preset,
        currentUserMessage: 'ignored',
        reuseUserMessageOrder: 2,
        applySubstituteParams,
        executeRunOnce: async (options: TavernRunOnceOptions) => {
            rerunRawMessages = JSON.stringify(options.messages);
            return {
                text: 'Second again.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });

    assert.match(rerunRawMessages, /MACRO_STICKY_LORE/);
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

test('xb tavern rerun preserves contract and skips automatic manager work when disabled', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    let managerCalls = 0;
    const first = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'Keep the contract.',
        runtimeState: {
            contract: mergeTavernSessionContract(undefined, {
                memoryArchiving: false,
                cartographyEngine: false,
            }),
        },
        runManager: true,
        awaitManager: true,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'First answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
        executeManagerOnce: async () => {
            managerCalls += 1;
            throw new Error('manager should stay disabled');
        },
    });

    assert.equal(first.managerRunId, '');
    assert.equal(first.managerStatus, '');
    assert.equal(managerCalls, 0);

    const rerun = await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'ignored',
        reuseUserMessageOrder: 0,
        runManager: true,
        awaitManager: true,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'Rerun answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
        executeManagerOnce: async () => {
            managerCalls += 1;
            throw new Error('manager should stay disabled');
        },
    });

    assert.equal(rerun.managerRunId, '');
    assert.equal(rerun.managerStatus, '');
    assert.equal(managerCalls, 0);
    assert.equal((await listTavernManagerRuns(first.sessionId)).length, 0);
    const session = await getTavernSession(first.sessionId);
    assert.equal(session?.state?.contract?.memoryArchiving, false);
    assert.equal(session?.state?.contract?.cartographyEngine, false);
});

test('xb tavern rerun preserves rollback conflicts instead of rebuilding them away', async () => {
    await resetDb();
    const preset = createDefaultXbTavernPreset();
    const first = await runXbTavernTurn({
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'First turn.',
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'First answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });
    const messages = await listTavernMessages(first.sessionId);
    const userMessage = messages.find((message) => message.role === 'user');
    const assistantMessage = messages.find((message) => message.role === 'assistant');
    assert.ok(userMessage);
    assert.ok(assistantMessage);
    const run = await createTavernManagerRun({
        sessionId: first.sessionId,
        turn: 1,
        userOrder: userMessage.order,
        assistantOrder: assistantMessage.order,
        trigger: 'after_turn',
        status: 'completed',
        changedFiles: ['memory/session.md'],
    });
    const before = (await getTavernMemoryFile(first.sessionId, 'memory/session.md'))?.content || '';
    const writeResult = await executeTavernMemoryTool(first.sessionId, 'MemoryWrite', {
        filePath: 'memory/session.md',
        content: `${before}\n\n管理员写入。`,
    }, {
        caller: 'auto',
        managerRunId: run.id,
    });
    assert.equal(writeResult.ok, true);
    await writeTavernMemoryFile(first.sessionId, 'memory/session.md', '用户手动修正。', { source: 'user' });

    await runXbTavernTurn({
        sessionId: first.sessionId,
        agentConfig: { provider: 'fake-provider', model: 'fake-model' },
        contextSnapshot: {
            character: { id: 'char-1', name: 'Aster' },
        },
        preset,
        currentUserMessage: 'ignored',
        reuseUserMessageOrder: userMessage.order,
        executeRunOnce: async (options: TavernRunOnceOptions) => ({
            text: 'Replacement answer.',
            requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
        }),
    });

    assert.equal((await getTavernMemoryFile(first.sessionId, 'memory/session.md'))?.content, '用户手动修正。');
    assert.match((await getTavernMemoryIndex(first.sessionId))?.error || '', /rollback_conflict:memory\/session\.md/);
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

test('xb tavern run turn prefers the latest live context for an existing session', async () => {
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
                text: 'I am new.',
                requestSnapshot: buildTavernRequestSnapshot(options.agentConfig, options.messages),
            };
        },
    });
    assert.match(sentRaw, /New Character/);
    assert.doesNotMatch(sentRaw, /Old Character/);
    const updated = await getTavernSession(session.id);
    assert.equal(updated?.contextSnapshot?.character?.name, 'New Character');
});
