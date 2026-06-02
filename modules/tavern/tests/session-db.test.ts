import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

import db, {
    appendTavernMessage,
    createTavernSession,
    deleteTavernMessages,
    deriveAndActivateDefaultTavernPreset,
    getActiveTavernPresetId,
    getSelectedTavernSessionId,
    getTavernSession,
    listTavernEpisodeSummaries,
    listTavernManagerRuns,
    listUserTavernPresets,
    listTavernMessages,
    listTavernTurnSummaries,
    markTavernMemoryStaleFromOrder,
    loadActiveTavernPreset,
    mergeWorldEntryStates,
    normalizeTavernSessionState,
    replaceTavernSessionState,
    saveTavernPreset,
    setActiveTavernPresetId,
    updateTavernMessage,
    updateTavernManagerRun,
    updateTavernSessionState,
    upsertTavernEpisodeSummary,
    upsertTavernTurnSummary,
    createTavernManagerRun,
} from '../shared/session-db';
import { DEFAULT_XB_TAVERN_PRESET_ID, createDefaultXbTavernPreset } from '../shared/presets';
import { buildXbTavernMessages, createXbTavernBuildSnapshot } from '../shared/message-assembler';
import {
    parseXbTavernManagerResult,
    runXbTavernManagerAfterTurn,
} from '../app-src/runtime/manager';
import {
    ensureTavernMemoryDefaults,
    executeTavernMemoryTool,
    getTavernMemoryIndex,
    listTavernMemoryFiles,
    rebuildTavernMemoryDerivedIndex,
} from '../shared/memory-files';

test('tavern session db stores independent sessions and messages', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({
        title: 'Aster test',
        characterId: '0',
        characterName: 'Aster',
        contextSnapshot: { character: { id: '0', name: 'Aster' } },
        presetId: 'preset-1',
        presetName: 'Preset One',
    });
    const buildResult = buildXbTavernMessages({
        character: { id: '0', name: 'Aster' },
    }, {
        id: 'preset-1',
        name: 'Preset One',
    }, {
        currentUserMessage: 'Hello.',
    });
    const buildSnapshot = createXbTavernBuildSnapshot({ character: { id: '0', name: 'Aster' } }, { id: 'preset-1', name: 'Preset One' }, buildResult);
    await appendTavernMessage(session.id, {
        role: 'user',
        content: 'Hello.',
        buildSnapshot,
        presetId: 'preset-1',
        presetName: 'Preset One',
    });
    await appendTavernMessage(session.id, {
        role: 'assistant',
        content: 'Hi.',
        requestSnapshot: { messageCount: buildResult.messages.length },
    });

    assert.equal(await getSelectedTavernSessionId(), session.id);
    const messages = await listTavernMessages(session.id);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(messages[0]?.buildSnapshot?.presetId, 'preset-1');
    assert.deepEqual(messages[1]?.requestSnapshot, { messageCount: buildResult.messages.length });
});

test('tavern session db stores only cloneable snapshots from runtime inputs', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({
        title: 'Clone guard',
        contextSnapshot: {
            character: { id: '1', name: 'Nia' },
        },
        state: {
            turn: 1,
            helper: () => 'not cloneable',
        },
    });

    await appendTavernMessage(session.id, {
        role: 'assistant',
        content: 'OK.',
        providerPayload: {
            text: 'OK.',
            helper: () => 'not cloneable',
        },
        requestSnapshot: {
            messageCount: 1,
            helper: () => 'not cloneable',
        },
    });

    const messages = await listTavernMessages(session.id);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]?.providerPayload, { text: 'OK.' });
    assert.deepEqual(messages[0]?.requestSnapshot, { messageCount: 1 });
});

test('tavern session db updates and deletes message records by order', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Edit messages' });
    await appendTavernMessage(session.id, { role: 'user', content: 'Original user.' });
    await appendTavernMessage(session.id, { role: 'assistant', content: 'Original assistant.' });
    await appendTavernMessage(session.id, { role: 'user', content: 'Next user.' });

    const updated = await updateTavernMessage(session.id, 0, { content: 'Edited user.' });
    assert.equal(updated?.content, 'Edited user.');

    assert.equal(await deleteTavernMessages(session.id, [1]), 1);
    const messages = await listTavernMessages(session.id);
    assert.deepEqual(messages.map((message) => `${message.order}:${message.content}`), [
        '0:Edited user.',
        '2:Next user.',
    ]);
});

test('tavern preset db derives, activates, edits and resets presets', async () => {
    await db.delete();
    await db.open();

    assert.equal(await getActiveTavernPresetId(), DEFAULT_XB_TAVERN_PRESET_ID);
    assert.equal((await loadActiveTavernPreset()).id, DEFAULT_XB_TAVERN_PRESET_ID);

    const derived = await deriveAndActivateDefaultTavernPreset('我的测试预设');
    assert.notEqual(derived.id, DEFAULT_XB_TAVERN_PRESET_ID);
    assert.equal(await getActiveTavernPresetId(), derived.id);
    assert.equal((await listUserTavernPresets()).length, 1);

    const edited = {
        ...derived.preset,
        name: '改过的预设',
        sections: [
            ...(derived.preset.sections || []),
            {
                id: 'custom',
                label: '自定义',
                placement: 'afterHistory' as const,
                role: 'system' as const,
                content: '只存在用户预设里。',
            },
        ],
    };
    await saveTavernPreset(edited);
    assert.equal((await loadActiveTavernPreset()).name, '改过的预设');

    await setActiveTavernPresetId(DEFAULT_XB_TAVERN_PRESET_ID);
    assert.deepEqual(await loadActiveTavernPreset(), createDefaultXbTavernPreset());
});

test('tavern session state stores turn and merges world entry states', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({
        title: 'Runtime state',
        state: {
            turn: 2,
            worldEntryStates: {
                'Lore\u0000gate': { stickyUntilTurn: 4 },
            },
        },
    });

    assert.deepEqual(normalizeTavernSessionState(session.state), {
        turn: 2,
        worldEntryStates: {
            'Lore\u0000gate': { stickyUntilTurn: 4 },
        },
    });

    await updateTavernSessionState(session.id, {
        turn: 3,
        worldEntryStates: {
            'Lore\u0000gate': { cooldownUntilTurn: 5 },
            'Lore\u0000new': { delayUntilTurn: 6 },
        },
        lastProvider: 'fake-provider',
    });

    const updated = await getTavernSession(session.id);
    assert.equal(updated?.state?.turn, 3);
    assert.deepEqual(updated?.state?.worldEntryStates, {
        'Lore\u0000gate': { stickyUntilTurn: 4, cooldownUntilTurn: 5 },
        'Lore\u0000new': { delayUntilTurn: 6 },
    });
    assert.equal(updated?.state?.lastProvider, 'fake-provider');

    assert.deepEqual(mergeWorldEntryStates({
        a: { stickyUntilTurn: 1 },
    }, {
        a: { cooldownUntilTurn: 2 },
    }), {
        a: { stickyUntilTurn: 1, cooldownUntilTurn: 2 },
    });

    await replaceTavernSessionState(session.id, {
        turn: 1,
        worldEntryStates: {
            'Lore\u0000fresh': { stickyUntilTurn: 2 },
        },
        lastProvider: '',
    });
    const replaced = await getTavernSession(session.id);
    assert.equal(replaced?.state?.turn, 1);
    assert.deepEqual(replaced?.state?.worldEntryStates, {
        'Lore\u0000fresh': { stickyUntilTurn: 2 },
    });
    assert.equal(replaced?.state?.lastProvider, '');
});

test('tavern memory db stores turn summaries, episodes, and manager runs', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Memory' });
    const turnSummary = await upsertTavernTurnSummary({
        sessionId: session.id,
        turn: 1,
        userOrder: 0,
        assistantOrder: 1,
        summary: '两人确认了共同目标。',
        hooks: ['下一步去码头'],
        tags: ['目标'],
    });
    const episode = await upsertTavernEpisodeSummary({
        sessionId: session.id,
        title: '码头前夜',
        summary: '阶段围绕出发前的试探。',
        startTurn: 1,
        endTurn: 1,
        turnSummaryIds: [turnSummary.id],
        keyChanges: ['关系缓和'],
    });
    const run = await createTavernManagerRun({
        sessionId: session.id,
        turn: 1,
        userOrder: 0,
        assistantOrder: 1,
        status: 'queued',
    });
    await updateTavernManagerRun(run.id, {
        status: 'completed',
        parsedAction: 'create_new_episode',
    });

    assert.equal((await listTavernTurnSummaries(session.id))[0]?.episodeId, episode.id);
    assert.equal((await listTavernEpisodeSummaries(session.id))[0]?.title, '码头前夜');
    assert.equal((await listTavernManagerRuns(session.id))[0]?.status, 'completed');

    assert.equal(await markTavernMemoryStaleFromOrder(session.id, 0), 1);
    assert.equal((await listTavernTurnSummaries(session.id)).length, 0);
    assert.equal((await listTavernTurnSummaries(session.id, { includeStale: true }))[0]?.status, 'stale');
    assert.equal((await listTavernEpisodeSummaries(session.id, { includeStale: true }))[0]?.status, 'stale');
});

test('tavern memory files are scoped markdown sources with derived index', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Memory files', characterName: 'Aster' });
    const defaults = await ensureTavernMemoryDefaults(session.id, { characterName: 'Aster' });
    assert.deepEqual(defaults.map((file) => file.path).sort(), [
        'memory/episodes/001.md',
        'memory/inbox.md',
        'memory/session.md',
        'memory/state.md',
    ]);

    const blocked = await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'book/state.md',
        content: 'nope',
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error || '', /memory_path_scope_required/);

    const written = await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'memory/turns/20260601-0000.md',
        content: [
            '# Turn 1',
            '',
            '- Turn: 1',
            '- Source: messages 0/1',
            '',
            '## Summary',
            'Aster 把银钥匙藏在码头钟楼下面。',
            '',
            '## Hooks',
            '- 银钥匙',
        ].join('\n'),
    });
    assert.equal(written.ok, true);

    const grep = await executeTavernMemoryTool(session.id, 'MemoryGrep', {
        pattern: '银钥匙',
    });
    assert.equal(grep.ok, true);
    assert.equal(grep.matches?.[0]?.line, 7);

    const index = await rebuildTavernMemoryDerivedIndex(session.id);
    assert.equal(index.status, 'ready');
    assert.equal((await getTavernMemoryIndex(session.id))?.status, 'ready');
    assert.match((await listTavernTurnSummaries(session.id))[0]?.summary || '', /银钥匙/);

    await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'memory/turns/20260601-0000.md',
        content: [
            '# Broken',
            '',
            '## Summary',
            '这份记录缺少 Source，不能继续派生。',
        ].join('\n'),
    });
    await rebuildTavernMemoryDerivedIndex(session.id);
    assert.equal((await listTavernTurnSummaries(session.id, { includeStale: true }))
        .find((summary) => summary.id.startsWith(`md-turn-${session.id}-`))?.status, 'stale');

    assert.equal(await markTavernMemoryStaleFromOrder(session.id, 0), 2);
    assert.equal((await listTavernMemoryFiles(session.id, { includeStale: true }))
        .find((file) => file.path === 'memory/turns/20260601-0000.md')?.status, 'stale');
});

test('tavern manager uses memory tools and records tool trace', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Tool manager' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '把银钥匙藏好。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她把银钥匙塞进码头钟楼的砖缝。' });
    let calls = 0;

    const result = await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        executeManagerOnce: async () => {
            calls += 1;
            if (calls === 1) {
                return {
                    provider: 'fake-manager',
                    model: 'memory-model',
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
                                '本轮确认银钥匙被藏进码头钟楼砖缝。',
                                '',
                                '## State',
                                '银钥匙暂时安全。',
                                '',
                                '## Hooks',
                                '- 码头钟楼',
                            ].join('\n'),
                        },
                    }],
                };
            }
            return {
                provider: 'fake-manager',
                model: 'memory-model',
                text: '已更新 memory/turns/20260601-0000.md。',
            };
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedFiles, ['memory/turns/20260601-0000.md']);
    assert.equal((await listTavernMemoryFiles(session.id)).some((file) => file.path === 'memory/turns/20260601-0000.md'), true);
    assert.match((await listTavernTurnSummaries(session.id))[0]?.summary || '', /银钥匙/);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.equal(run?.status, 'completed');
    assert.equal(Array.isArray(run?.toolTrace), true);
    assert.equal(run?.changedFiles?.[0], 'memory/turns/20260601-0000.md');
});

test('tavern manager accepts older active summaries without accepting fake ids', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Bounded manager' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '去码头。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她答应了。' });
    const summaries: Array<Awaited<ReturnType<typeof upsertTavernTurnSummary>>> = [];
    for (let index = 0; index < 6; index += 1) {
        summaries.push(await upsertTavernTurnSummary({
            sessionId: session.id,
            turn: index + 1,
            userOrder: 10 + index * 2,
            assistantOrder: 11 + index * 2,
            summary: `第 ${index + 1} 条摘要。`,
        }));
    }

    let calls = 0;
    await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 7,
        recentTurnSummaries: summaries,
        recentEpisodeSummaries: [],
        executeManagerOnce: async () => {
            calls += 1;
            if (calls === 1) {
                return {
                    text: '',
                    toolCalls: [{
                        id: 'write-turn',
                        name: 'MemoryWrite',
                        arguments: {
                            filePath: 'memory/turns/20260601-0000.md',
                            content: [
                                '# Turn 7',
                                '',
                                '- Turn: 7',
                                '- Source: messages 0/1',
                                '',
                                '## Summary',
                                '本轮决定去码头。',
                            ].join('\n'),
                        },
                    }, {
                        id: 'write-episode',
                        name: 'MemoryWrite',
                        arguments: {
                            filePath: 'memory/episodes/007.md',
                            content: [
                                '# 码头',
                                '',
                                '- Range: turn 1-7',
                                '',
                                '## Summary',
                                '最近几轮开始转向码头。',
                                '',
                                '## Turn Summary IDs',
                                `- ${summaries[0]?.id}`,
                                `- ${summaries[5]?.id}`,
                                '- not-real',
                            ].join('\n'),
                        },
                    }],
                };
            }
            return {
                text: '已更新码头阶段档案。',
            };
        },
    });

    const episodes = await listTavernEpisodeSummaries(session.id);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0]?.turnSummaryIds.includes(summaries[0]?.id || ''), true);
    assert.equal(episodes[0]?.turnSummaryIds.includes(summaries[5]?.id || ''), true);
    assert.equal(episodes[0]?.turnSummaryIds.includes('not-real'), false);
});

test('tavern manager requires memory tools instead of accepting plain JSON or prose', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'No tools' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '继续。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她继续。' });

    const result = await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        executeManagerOnce: async () => ({
            provider: 'fake-manager',
            model: 'memory-model',
            text: JSON.stringify({
                turnSummary: {
                    summary: '这段 JSON 不应该被系统代写成 MD。',
                },
            }),
        }),
    });

    const runs = await listTavernManagerRuns(session.id);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'manager_memory_tool_required');
    assert.equal(runs[0]?.status, 'failed');
    assert.match(runs[0]?.outputText || '', /不应该被系统代写/);
    assert.equal((await listTavernMemoryFiles(session.id)).some((file) => file.path.startsWith('memory/turns/')), false);
});

test('tavern manager refuses to write memory when source messages changed', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Stale source' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '原句。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '原回复。' });
    await updateTavernMessage(session.id, assistantMessage.order, { content: '新回复。' });

    const result = await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        executeManagerOnce: async () => ({
            text: JSON.stringify({
                turnSummary: { summary: '不应该写入。' },
            }),
        }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'manager_source_messages_changed');
    assert.equal((await listTavernTurnSummaries(session.id)).length, 0);
    assert.equal((await listTavernManagerRuns(session.id))[0]?.status, 'failed');
});

test('tavern manager keeps raw output when no memory tool is used', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Bad JSON' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '继续。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她继续。' });

    const result = await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        executeManagerOnce: async () => ({
            provider: 'fake-manager',
            model: 'memory-model',
            text: '这不是 JSON',
        }),
    });

    const runs = await listTavernManagerRuns(session.id);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'manager_memory_tool_required');
    assert.equal(runs[0]?.status, 'failed');
    assert.equal(runs[0]?.outputText, '这不是 JSON');
    assert.equal(runs[0]?.provider, 'fake-manager');
    assert.equal(runs[0]?.model, 'memory-model');
});

test('tavern manager fails the run when any memory tool fails', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Tool failure' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '藏好钥匙。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她把钥匙藏好。' });
    let calls = 0;

    const result = await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        executeManagerOnce: async () => {
            calls += 1;
            if (calls === 1) {
                return {
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
                                '钥匙已经藏好。',
                            ].join('\n'),
                        },
                    }, {
                        id: 'bad-read',
                        name: 'MemoryRead',
                        arguments: {
                            filePath: 'book/state.md',
                        },
                    }],
                };
            }
            return { text: '已更新。' };
        },
    });

    const runs = await listTavernManagerRuns(session.id);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'manager_memory_tool_failed');
    assert.equal(runs[0]?.status, 'failed');
    assert.deepEqual(runs[0]?.changedFiles, ['memory/turns/20260601-0000.md']);
    assert.equal((runs[0]?.toolTrace as Array<{ ok?: boolean }>).some((item) => item.ok === false), true);
});

test('tavern manager result parser requires a small summary', () => {
    assert.throws(() => parseXbTavernManagerResult('{}'), /manager_turn_summary_required/);
});
