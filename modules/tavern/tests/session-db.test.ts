import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

import db, {
    appendTavernMessage,
    appendTavernManagerMessage,
    createTavernSession,
    deleteTavernSession,
    deleteTavernMessages,
    deriveAndActivateDefaultTavernPreset,
    getActiveTavernPresetId,
    getSelectedTavernSessionId,
    getTavernSession,
    listTavernEpisodeSummaries,
    listTavernManagerMessages,
    listTavernManagerMemorySnapshots,
    listTavernManagerStateSnapshots,
    listTavernManagerRuns,
    listUserTavernPresets,
    listTavernMessages,
    listTavernTurnSummaries,
    markTavernMemoryStaleFromOrder,
    loadActiveTavernPreset,
    mergeWorldEntryStates,
    normalizeTavernSessionState,
    replaceTavernSessionState,
    rollbackManagerRunsForMessageRange,
    rollbackManagerStateRunsForMessageRange,
    saveTavernPreset,
    setActiveTavernPresetId,
    touchRunningTavernManagerRun,
    updateTavernManagerMessage,
    updateTavernMessage,
    updateTavernManagerRun,
    updateTavernSessionState,
    upsertTavernEpisodeSummary,
    upsertTavernTurnSummary,
    createTavernManagerRun,
    getTavernStructuredStateDocument,
    listTavernStructuredStatePatches,
} from '../shared/session-db';
import { DEFAULT_XB_TAVERN_PRESET_ID, createDefaultXbTavernPreset } from '../shared/presets';
import { DEFAULT_TAVERN_SESSION_CONTRACT, mergeTavernSessionContract } from '../shared/session-contract';
import { buildXbTavernMessages, createXbTavernBuildSnapshot } from '../shared/message-assembler';
import { createChanceEncounterEvent } from '../shared/runtime-events';
import {
    MAX_MANAGER_TOOL_ROUNDS,
    cancelAndRollbackXbTavernManagersForMessageRange,
    runXbTavernManagerChat,
    runXbTavernManagerAfterTurn,
    scheduleXbTavernManagerAfterTurn,
} from '../app-src/runtime/manager';
import {
    buildTurnMemoryPath,
    ensureTavernMemoryDefaults,
    executeTavernMemoryTool,
    getTavernManagerToolDefinitions,
    getTavernMemoryFile,
    getTavernMemoryIndex,
    listTavernMemoryFiles,
    rebuildTavernMemoryDerivedIndex,
    writeTavernMemoryFile,
} from '../shared/memory-files';
import { executeTavernStateTool, getTavernStateToolDefinitions } from '../shared/structured-state';
import * as looseToolArgumentsModule from '../../agent-core/runtime/loose-tool-arguments.js';

const { repairLooseToolArguments } = looseToolArgumentsModule as unknown as {
    repairLooseToolArguments: (text: string, toolName?: string) => string;
};

function turnMemoryPathFor(userMessage: { order: number }, assistantMessage: { createdAt?: number }): string {
    return buildTurnMemoryPath(userMessage.order, Number(assistantMessage.createdAt) || Date.now());
}

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

test('tavern session db keeps session display names clean', async () => {
    await db.delete();
    await db.open();

    const titled = await createTavernSession({
        title: 'Seraphina · 小白酒馆',
        characterName: 'SillyTavern System · 第 96 轮 · 134 条可用消息',
    });
    assert.equal(titled.title, 'Seraphina');
    assert.equal(titled.characterName, '');

    const named = await createTavernSession({
        characterName: 'Seraphina · 会话',
    });
    assert.equal(named.title, 'Seraphina');
    assert.equal(named.characterName, 'Seraphina');
});

test('new tavern sessions start with a seed map document', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Seed map' });
    const document = await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main');

    assert.equal(document?.revision, 0);
    assert.equal((document?.data as { meta?: { status?: string } })?.meta?.status, 'uninitialized');
    assert.equal((document?.data as { elements?: unknown[] })?.elements?.length, 0);
    const hint = (document?.data as { meta?: { hint?: string } })?.meta?.hint || '';
    assert.match(hint, /室内场景样例/);
    assert.match(hint, /室外场景样例/);
    assert.match(hint, /至少放一个空间几何元素/);
    assert.equal((await listTavernStructuredStatePatches({ sessionId: session.id })).length, 0);
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
        thoughts: [{ label: 'thinking', text: 'Reasoning.' }],
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
    assert.deepEqual(messages[0]?.thoughts, [{ label: 'thinking', text: 'Reasoning.' }]);
    assert.deepEqual(messages[0]?.providerPayload, { text: 'OK.' });
    assert.deepEqual(messages[0]?.requestSnapshot, { messageCount: 1 });
    assert.deepEqual(messages[0]?.runtimeEvents, []);
});

test('tavern session db preserves runtime events and lets user edits clear them', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Runtime events' });
    const userMessage = await appendTavernMessage(session.id, {
        role: 'user',
        content: 'Roll the road.',
        runtimeEvents: [createChanceEncounterEvent('2026-06-11T10:00:00.000Z')],
    });

    assert.equal(userMessage.runtimeEvents?.[0]?.type, 'chanceEncounter');
    assert.equal(userMessage.runtimeEvents?.[0]?.label, '[ 🎲 CHANCE ENCOUNTER TRIGGERED ]');

    const listed = await listTavernMessages(session.id);
    assert.equal(listed[0]?.runtimeEvents?.length, 1);

    const updated = await updateTavernMessage(session.id, userMessage.order, {
        content: 'Roll the road again.',
        runtimeEvents: [],
    });

    assert.equal(updated?.content, 'Roll the road again.');
    assert.deepEqual(updated?.runtimeEvents, []);
});

test('tavern session db deletes sessions with related records', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Delete me', characterName: 'Aster' });
    const other = await createTavernSession({ title: 'Keep me', characterName: 'Nia' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: 'Hi.' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: 'Hello.' });
    await upsertTavernTurnSummary({
        sessionId: session.id,
        turn: 1,
        userOrder: userMessage.order,
        assistantOrder: assistantMessage.order,
        summary: 'They greeted each other.',
    });
    await upsertTavernEpisodeSummary({
        sessionId: session.id,
        id: 'episode-delete',
        title: 'Greeting',
        summary: 'Greeting.',
    });
    await createTavernManagerRun({
        sessionId: session.id,
        turn: 1,
        userOrder: userMessage.order,
        assistantOrder: assistantMessage.order,
        trigger: 'after_turn',
    });
    await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{ op: 'add', element: { id: 'delete-map-room', type: 'rect', pos: [0, 0], size: [10, 10], cat: 'wall' } }],
    });

    assert.equal(await deleteTavernSession(session.id), 1);
    assert.equal(await getTavernSession(session.id), null);
    assert.equal((await listTavernMessages(session.id)).length, 0);
    assert.equal((await listTavernTurnSummaries(session.id)).length, 0);
    assert.equal((await listTavernEpisodeSummaries(session.id)).length, 0);
    assert.equal((await listTavernManagerRuns(session.id)).length, 0);
    assert.equal(await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main'), null);
    assert.equal((await listTavernStructuredStatePatches({ sessionId: session.id })).length, 0);
    assert.equal(await getSelectedTavernSessionId(), other.id);
});

test('tavern session db updates and deletes message records by order', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Edit messages' });
    await appendTavernMessage(session.id, { role: 'user', content: 'Original user.' });
    await appendTavernMessage(session.id, {
        role: 'assistant',
        content: 'Original assistant.',
        thoughts: [{ label: '旧思考', text: '旧内容。' }],
    });
    await appendTavernMessage(session.id, { role: 'user', content: 'Next user.' });

    const updated = await updateTavernMessage(session.id, 0, { content: 'Edited user.' });
    assert.equal(updated?.content, 'Edited user.');
    const updatedAssistant = await updateTavernMessage(session.id, 1, {
        thoughts: [{ label: '新思考', text: '新内容。' }],
    });
    assert.deepEqual(updatedAssistant?.thoughts, [{ label: '新思考', text: '新内容。' }]);

    assert.equal(await deleteTavernMessages(session.id, [1]), 1);
    const messages = await listTavernMessages(session.id);
    assert.deepEqual(messages.map((message) => `${message.order}:${message.content}`), [
        '0:Edited user.',
        '2:Next user.',
    ]);
});

test('tavern chat preset compatibility wrappers do not create local prompt presets', async () => {
    await db.delete();
    await db.open();

    assert.equal(await getActiveTavernPresetId(), DEFAULT_XB_TAVERN_PRESET_ID);
    assert.equal((await loadActiveTavernPreset()).id, DEFAULT_XB_TAVERN_PRESET_ID);

    const derived = await deriveAndActivateDefaultTavernPreset('我的测试预设');
    assert.equal(derived.id, DEFAULT_XB_TAVERN_PRESET_ID);
    assert.equal(await getActiveTavernPresetId(), DEFAULT_XB_TAVERN_PRESET_ID);
    assert.equal((await listUserTavernPresets()).length, 0);

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
    const saved = await saveTavernPreset(edited);
    assert.equal(saved.name, '改过的预设');
    assert.equal((await loadActiveTavernPreset()).name, '酒馆当前聊天预设');
    assert.equal((await listUserTavernPresets()).length, 0);

    await setActiveTavernPresetId('local-preset-id');
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
        contract: DEFAULT_TAVERN_SESSION_CONTRACT,
        worldEntryStates: {
            'Lore\u0000gate': { stickyUntilTurn: 4 },
        },
        nativeWorldInfoTimedState: {
            sticky: {},
            cooldown: {},
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
    assert.deepEqual(replaced?.state?.contract, DEFAULT_TAVERN_SESSION_CONTRACT);
    assert.equal(replaced?.state?.lastProvider, '');
});

test('replaceTavernSessionState preserves stored contract when runtime rebuild omits config fields', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({
        title: 'Contract replace',
        state: {
            turn: 2,
            contract: {
                memoryArchiving: false,
                cartographyEngine: false,
                actionChecks: true,
                randomEncounters: true,
                questOrchestration: false,
            },
            worldEntryStates: {
                'Lore\u0000gate': { stickyUntilTurn: 4 },
            },
        },
    });

    await replaceTavernSessionState(session.id, {
        turn: 5,
        worldEntryStates: {
            'Lore\u0000gate': { cooldownUntilTurn: 8 },
        },
    });

    const replaced = await getTavernSession(session.id);
    assert.deepEqual(normalizeTavernSessionState(replaced?.state), {
        turn: 5,
        contract: {
            memoryArchiving: false,
            cartographyEngine: false,
            actionChecks: true,
            randomEncounters: true,
            questOrchestration: false,
        },
        worldEntryStates: {
            'Lore\u0000gate': { cooldownUntilTurn: 8 },
        },
        nativeWorldInfoTimedState: {
            sticky: {},
            cooldown: {},
        },
    });
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

test('tavern manager run heartbeat only touches active running runs', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Manager heartbeat' });
    const run = await createTavernManagerRun({
        sessionId: session.id,
        turn: 1,
        userOrder: 0,
        assistantOrder: 1,
        status: 'running',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const touched = await touchRunningTavernManagerRun(run.id);
    assert.equal(touched?.status, 'running');
    assert.ok(Number(touched?.updatedAt || 0) >= run.updatedAt);

    const completed = await updateTavernManagerRun(run.id, { status: 'completed' });
    const afterTerminalHeartbeat = await touchRunningTavernManagerRun(run.id);
    assert.equal(afterTerminalHeartbeat?.status, 'completed');
    assert.equal((await listTavernManagerRuns(session.id))[0]?.status, 'completed');
    assert.equal(completed?.status, 'completed');
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

    await writeTavernMemoryFile(session.id, 'memory/turns/20260601-user.md', '用户手动修正。', { source: 'user' });
    assert.equal((await getTavernMemoryFile(session.id, 'memory/turns/20260601-user.md'))?.content, '用户手动修正。');

    const written = await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'memory/turns/20260601-0000.md',
        content: [
            '# 码头银钥匙',
            '',
            'Aster 把银钥匙藏在码头钟楼下面。',
            '',
            '## 线索',
            '- 银钥匙',
        ].join('\n'),
    });
    assert.equal(written.ok, true);

    const grep = await executeTavernMemoryTool(session.id, 'MemoryGrep', {
        pattern: '银钥匙',
    });
    assert.equal(grep.ok, true);
    assert.equal(grep.matches?.[0]?.line, 1);

    const index = await rebuildTavernMemoryDerivedIndex(session.id);
    assert.equal(index.status, 'ready');
    assert.equal((await getTavernMemoryIndex(session.id))?.status, 'ready');
    assert.equal((await listTavernTurnSummaries(session.id)).length, 0);

    await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'memory/turns/20260601-0000.md',
        content: [
            '# Broken',
            '',
            '这份记录没有固定标题，但仍然是普通 Markdown 档案。',
        ].join('\n'),
    });
    const rebuilt = await rebuildTavernMemoryDerivedIndex(session.id);
    assert.equal(rebuilt.status, 'ready');
    const looseGrep = await executeTavernMemoryTool(session.id, 'MemoryGrep', {
        pattern: '固定标题',
        path: 'memory/turns/',
    });
    assert.equal(looseGrep.count, 1);

    assert.equal(await markTavernMemoryStaleFromOrder(session.id, 0), 1);
    assert.equal((await listTavernMemoryFiles(session.id, { includeStale: true }))
        .find((file) => file.path === 'memory/turns/20260601-0000.md')?.status, 'stale');
});

test('ChatHistory range mode treats missing endOrder as open-ended', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'ChatHistory range' });
    await appendTavernMessage(session.id, { role: 'user', content: '第 0 条。' });
    await appendTavernMessage(session.id, {
        role: 'assistant',
        content: '第 1 条。',
        thoughts: [{ label: 'hidden', text: '第 1 条思考。' }],
    });
    await appendTavernMessage(session.id, { role: 'user', content: '第 2 条。' });

    const result = await executeTavernMemoryTool(session.id, 'ChatHistory', {
        mode: 'range',
        startOrder: 1,
        full: true,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.messages?.map((message) => message.order), [1, 2]);
    assert.deepEqual(result.messages?.[0]?.thoughts, [{ label: 'hidden', text: '第 1 条思考。' }]);

    const preview = await executeTavernMemoryTool(session.id, 'ChatHistory', {
        mode: 'range',
        startOrder: 1,
        limit: 1,
    });
    assert.equal(preview.messages?.[0]?.reasoningSnippet, '第 1 条思考。');
});

test('MemoryRead returns raw content, line numbers, and pagination hints', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Memory read lines' });
    await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'memory/state.md',
        content: ['# 状态栏', '', '## 当前事实', '- 银钥匙在钟楼。', '- 小满知道暗号。'].join('\n'),
    });

    const result = await executeTavernMemoryTool(session.id, 'MemoryRead', {
        filePath: 'memory/state.md',
        offset: 3,
        limit: 2,
    });

    assert.equal(result.ok, true);
    assert.equal(result.lineStart, 3);
    assert.equal(result.lineEnd, 4);
    assert.equal(result.totalLines, 5);
    assert.equal(result.truncated, true);
    assert.equal(result.nextOffset, 5);
    assert.match(result.content || '', /## 当前事实/);
    assert.match(result.numberedContent || '', /^3: ## 当前事实/m);
});

test('MemoryGrep supports scope, context, pagination, and output modes', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Memory grep paging' });
    await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'memory/state.md',
        content: ['# 状态栏', '银钥匙在钟楼。', '她没有拿走钥匙。', '银钥匙仍是伏笔。'].join('\n'),
    });

    const firstPage = await executeTavernMemoryTool(session.id, 'MemoryGrep', {
        pattern: '银钥匙',
        path: 'memory/state.md',
        limit: 1,
        contextLines: 1,
    });

    assert.equal(firstPage.ok, true);
    assert.equal(firstPage.count, 2);
    assert.equal(firstPage.truncated, true);
    assert.equal(firstPage.nextOffset, 1);
    assert.equal(firstPage.matches?.[0]?.line, 2);
    assert.match(firstPage.matches?.[0]?.context || '', /^1: # 状态栏/m);

    const counts = await executeTavernMemoryTool(session.id, 'MemoryGrep', {
        pattern: '钥匙',
        path: 'memory/state.md',
        outputMode: 'count',
    });
    assert.equal(counts.matches?.[0]?.count, 3);
});

test('MemoryEdit persists partial successes and reports diagnostics like ebook Edit', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Memory edit partial' });
    await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'memory/state.md',
        content: ['# 状态栏', '- 旧事实。', '- 保留。'].join('\n'),
    });

    const edit = await executeTavernMemoryTool(session.id, 'MemoryEdit', {
        filePath: 'memory/state.md',
        edits: [
            { oldString: '旧事实', newString: '新事实' },
            { oldString: '不存在的片段', newString: '不会出现' },
        ],
    });

    assert.equal(edit.ok, false);
    assert.equal(edit.changed, true);
    assert.equal(edit.partial, true);
    assert.equal(edit.appliedCount, 1);
    assert.equal(edit.failedCount, 1);

    const read = await executeTavernMemoryTool(session.id, 'MemoryRead', {
        filePath: 'memory/state.md',
    });
    assert.match(read.content || '', /新事实/);
    assert.doesNotMatch(read.content || '', /不会出现/);
});

test('loose JSON repair knows tavern manager tool arguments', () => {
    const repairedHistory = JSON.parse(repairLooseToolArguments(
        '{mode:"range", startOrder:40, full:true, limit:3}',
        'ChatHistory',
    ));
    assert.deepEqual(repairedHistory, {
        mode: 'range',
        limit: 3,
        startOrder: 40,
        full: true,
    });

    const repairedGrep = JSON.parse(repairLooseToolArguments(
        '{query:"银钥匙", scope:"memory/state.md", useRegex:false, contextLines:1}',
        'MemoryGrep',
    ));
    assert.equal(repairedGrep.pattern, '银钥匙');
    assert.equal(repairedGrep.path, 'memory/state.md');
    assert.equal(repairedGrep.regex, false);
    assert.equal(repairedGrep.contextLines, 1);
});

test('ChatHistory tool schema documents range, grep, pagination, and full content semantics', () => {
    const chatHistory = getTavernManagerToolDefinitions()
        .find((tool) => tool.function.name === 'ChatHistory');
    const parameters = chatHistory?.function.parameters as {
        properties?: Record<string, { description?: string }>;
    };

    assert.match(chatHistory?.function.description || '', /original RP chat history/);
    assert.match(parameters.properties?.mode?.description || '', /recent reads the latest messages/);
    assert.match(parameters.properties?.offset?.description || '', /pages backward from the newest/);
    assert.match(parameters.properties?.offset?.description || '', /skips earlier ascending results/);
    assert.match(parameters.properties?.startOrder?.description || '', /continues through the latest message/);
    assert.match(parameters.properties?.endOrder?.description || '', /inclusive/);
    assert.match(parameters.properties?.full?.description || '', /exact wording or source evidence/);
});

test('MemoryEdit tool schema documents edit modes and array discipline', () => {
    const editTool = getTavernManagerToolDefinitions()
        .find((tool) => tool.function.name === 'MemoryEdit');
    const parameters = editTool?.function.parameters as {
        properties?: Record<string, { description?: string }>;
    };

    assert.match(editTool?.function.description || '', /Read the current file first/i);
    assert.match(editTool?.function.description || '', /mix oldString edits with line-number edits/i);
    assert.match(editTool?.function.description || '', /bottom to top/);
    assert.match(editTool?.function.description || '', /not semantic fuzzy search/);
    assert.match(parameters.properties?.edits?.description || '', /Real non-empty JSON array/);
    assert.match(parameters.properties?.edits?.description || '', /not a quoted JSON string/);
    assert.match(parameters.properties?.edits?.description || '', /startLine\/endLine\/newString/);
    assert.match(parameters.properties?.edits?.description || '', /insertAtLine\/newString/);
});

test('StatePatch creates and updates tavern map documents with semantic ops', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map state' });
    const init = await executeTavernStateTool(session.id, 'StatePatch', {
        docType: 'tavern.map',
        docId: 'main',
        ops: [{
            op: 'init',
            document: {
                meta: { name: 'Rusty Flagon', theme: 'parchment', viewBox: [0, 0, 600, 420] },
                elements: [
                    { id: 'hall', type: 'rect', pos: [50, 50], size: [300, 200], cat: 'wall' },
                ],
            },
        }],
    }, { caller: 'auto' });

    assert.equal(init.ok, true);
    assert.equal(init.changed, true);
    assert.equal(init.revision, 1);

    const update = await executeTavernStateTool(session.id, 'StatePatch', {
        docType: 'tavern.map',
        docId: 'main',
        baseRevision: 1,
        desc: '打开北门并出现标记',
        ops: [
            { op: 'add', element: { id: 'north-door', type: 'arc', center: [180, 50], r: 20, startAngle: 0, endAngle: 90, cat: 'door' } },
            { op: 'modify', id: 'hall', changes: { style: { color: '#553' } } },
            { op: 'meta', changes: { name: 'Rusty Flagon - North Door' } },
        ],
    }, { caller: 'auto' });

    assert.equal(update.ok, true);
    assert.equal(update.changed, true);
    assert.equal(update.appliedCount, 3);
    assert.equal(update.revision, 2);
    assert.deepEqual(update.changedIds?.sort(), ['hall', 'meta', 'north-door'].sort());

    const read = await executeTavernStateTool(session.id, 'StateRead', {
        docType: 'tavern.map',
        docId: 'main',
        mode: 'summary',
    });
    assert.equal(read.ok, true);
    assert.match(read.digest || '', /Rusty Flagon - North Door/);

    const doors = await executeTavernStateTool(session.id, 'StateRead', {
        docType: 'tavern.map',
        docId: 'main',
        mode: 'elements',
        category: 'door',
    });
    assert.equal(doors.ok, true);
    assert.equal(doors.count, 1);
    assert.equal(doors.elements?.[0]?.id, 'north-door');

    const remove = await executeTavernStateTool(session.id, 'StatePatch', {
        docType: 'tavern.map',
        docId: 'main',
        baseRevision: 2,
        desc: '北门被移除',
        ops: [
            { op: 'remove', id: 'north-door' },
        ],
    }, { caller: 'auto' });
    assert.equal(remove.ok, true);
    assert.equal(remove.revision, 3);
    assert.equal(remove.removedElements?.[0]?.id, 'north-door');
    assert.equal(Array.isArray(remove.removedElements?.[0]?.curve), true);
    const patches = await listTavernStructuredStatePatches({ sessionId: session.id });
    assert.equal(patches.at(-1)?.changedIds?.includes('north-door'), true);
    const removed = patches.at(-1)?.removedElements as Array<{ id?: string; curve?: unknown[] }> | undefined;
    assert.equal(removed?.[0]?.id, 'north-door');
    assert.equal(Array.isArray(removed?.[0]?.curve), true);
});

test('StatePatch rejects quoted ops, revision conflicts, invalid ids, and keeps atomic state', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map patch discipline' });
    const badArray = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: JSON.stringify([{ op: 'meta', changes: { name: 'bad' } }]),
    });
    assert.equal(badArray.ok, false);
    assert.equal(badArray.error, 'state_patch_ops_must_be_array');

    await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{ op: 'add', element: { id: 'room', type: 'rect', pos: [0, 0], size: [100, 80], cat: 'wall' } }],
    });
    const conflict = await executeTavernStateTool(session.id, 'StatePatch', {
        baseRevision: 0,
        ops: [{ op: 'meta', changes: { name: 'should not save' } }],
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, 'state_revision_conflict');

    const invalid = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [
            { op: 'add', element: { id: 'bad-type', type: 'polygon', cat: 'wall' } },
            { op: 'add', element: { id: 'valid-later', type: 'circle', center: [1, 2], r: 3, cat: 'marker' } },
        ],
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.changed, false);
    const doc = await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main');
    const elements = (doc?.data as { elements?: Array<{ id?: string }> })?.elements || [];
    assert.equal(elements.some((element) => element.id === 'valid-later'), false);
});

test('StatePatch rejects map elements without drawable geometry', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map geometry discipline' });
    const invalid = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [
            { op: 'add', element: { id: 'floating-label', type: 'text', cat: 'label', content: 'Nowhere' } },
            { op: 'add', element: { id: 'empty-line', type: 'line', cat: 'road' } },
            { op: 'add', element: { id: 'valid-room', type: 'rect', pos: [10, 10], size: [80, 50], cat: 'wall' } },
        ],
    });

    assert.equal(invalid.ok, false);
    assert.equal(invalid.changed, false);
    assert.match(JSON.stringify(invalid.details), /map_element_at_required:floating-label/);
    const seed = await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main');
    assert.equal(seed?.revision, 0);
    assert.equal((seed?.data as { meta?: { status?: string } })?.meta?.status, 'uninitialized');

    const valid = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [
            { op: 'add', element: { id: 'current-position', type: 'icon', cat: 'marker', pos: [60, 35], icon: 'o' } },
            { op: 'add', element: { id: 'room-label', type: 'text', cat: 'label', pos: [60, 65], content: 'Forest clearing' } },
        ],
    });

    assert.equal(valid.ok, true);
    assert.equal(valid.appliedCount, 2);
});

test('StatePatch accepts common map geometry aliases and explains failures', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map alias ergonomics' });
    const result = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{
            op: 'init',
            meta: { name: 'Alias map', viewBox: [0, 0, 400, 300] },
            elements: [
                { id: 'room', type: 'rect', x: 20, y: 30, width: 200, height: 120, cat: 'wall' },
                { id: 'player', type: 'circle', cx: 80, cy: 90, radius: 6, cat: 'marker' },
                { id: 'road', type: 'line', x1: 20, y1: 160, x2: 260, y2: 160, cat: 'road' },
                { id: 'label', type: 'text', x: 90, y: 72, label: 'Clearing', cat: 'label' },
            ],
        }],
    });

    assert.equal(result.ok, true);
    const document = await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main');
    const elements = (document?.data as { elements?: Array<Record<string, unknown>> })?.elements || [];
    assert.deepEqual(elements.find((element) => element.id === 'room')?.at, [20, 30]);
    assert.deepEqual(elements.find((element) => element.id === 'room')?.rect, [200, 120]);
    assert.deepEqual(elements.find((element) => element.id === 'player')?.at, [80, 90]);
    assert.equal(elements.find((element) => element.id === 'player')?.circle, 6);
    assert.deepEqual(elements.find((element) => element.id === 'road')?.at, [20, 160]);
    assert.deepEqual(elements.find((element) => element.id === 'road')?.path, [[0, 0], [240, 0]]);
    assert.equal(elements.find((element) => element.id === 'label')?.text, 'Clearing');

    const invalid = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{ op: 'add', element: { id: 'bad-label', type: 'text', cat: 'label', content: 'No position' } }],
    });
    assert.equal(invalid.ok, false);
    assert.match(invalid.summary, /bad-label 缺少位置/);
    assert.match(JSON.stringify(invalid.details), /at:\[x,y\]/);
});

test('StatePatch keeps system-derived label ids readable while rejecting reserved ids from model input', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map derived labels' });
    const write = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{
            op: 'add',
            element: { id: 'room', at: [20, 30], rect: [140, 90], cat: 'wall', text: 'South room' },
        }],
    });

    assert.equal(write.ok, true);
    assert.equal(write.appliedCount, 2);
    const summary = await executeTavernStateTool(session.id, 'StateRead', { mode: 'summary' });
    assert.equal(summary.ok, true);
    const document = await executeTavernStateTool(session.id, 'StateRead', { mode: 'document' });
    const ids = ((document.document as { elements?: Array<{ id?: string }> })?.elements || []).map((element) => element.id);
    assert.deepEqual(ids.sort(), ['__label__room', 'room']);

    const reserved = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{
            op: 'add',
            element: { id: '__label__intruder', at: [0, 0], text: 'Bad', cat: 'label' },
        }],
    });
    assert.equal(reserved.ok, false);
    assert.match(reserved.summary, /系统保留前缀/);
});

test('StatePatch infers path anchors without at and keeps at optional in the public schema', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map inferred anchors' });
    const result = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{
            op: 'add',
            element: { id: 'road', path: [[20, 160], [260, 160]], cat: 'road' },
        }],
    });

    assert.equal(result.ok, true);
    const document = await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main');
    const road = ((document?.data as { elements?: Array<Record<string, unknown>> })?.elements || []).find((element) => element.id === 'road');
    assert.deepEqual(road?.at, [20, 160]);
    assert.deepEqual(road?.path, [[0, 0], [240, 0]]);

    const statePatch = getTavernStateToolDefinitions().find((tool) => tool.function.name === 'StatePatch');
    const required = (((statePatch?.function.parameters as { properties?: { ops?: { items?: { properties?: { element?: { required?: string[] } } } } } })
        ?.properties?.ops?.items?.properties?.element?.required) || []);
    assert.equal(required.includes('at'), false);
});

test('StatePatch ignores model soft remove flags and still reports missing targets', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map remove discipline' });
    const result = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{ op: 'remove', id: 'missing', soft: true }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'state_patch_failed');
    assert.match(result.summary, /missing 不存在/);
});

test('StatePatch keeps weak maps uninitialized until they have spatial content', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map activation gate' });
    const weak = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [
            { op: 'meta', set: { name: 'Only label', viewBox: [0, 0, 400, 300], status: 'active' } },
            { op: 'add', element: { id: 'label', at: [200, 120], text: 'Only label', cat: 'label' } },
        ],
    });

    assert.equal(weak.ok, true);
    assert.match((weak.warnings || []).join('\n'), /至少需要一个空间几何元素/);
    const weakRead = await executeTavernStateTool(session.id, 'StateRead', { mode: 'summary' });
    assert.equal(weakRead.meta?.status, 'uninitialized');

    const strong = await executeTavernStateTool(session.id, 'StatePatch', {
        baseRevision: weakRead.revision,
        ops: [
            { op: 'add', element: { id: 'ground', at: [200, 160], circle: 80, cat: 'terrain' } },
        ],
    });

    assert.equal(strong.ok, true);
    const strongRead = await executeTavernStateTool(session.id, 'StateRead', { mode: 'summary' });
    assert.equal(strongRead.meta?.status, 'active');
});

test('StatePatch accepts large initial map patches without the old low op ceiling', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Large map init' });
    const ops = Array.from({ length: 120 }, (_, index) => ({
        op: 'add',
        element: {
            id: `tile-${index + 1}`,
            type: 'rect',
            pos: [(index % 20) * 12, Math.floor(index / 20) * 12],
            size: [8, 8],
            cat: 'terrain',
        },
    }));

    const result = await executeTavernStateTool(session.id, 'StatePatch', { ops });

    assert.equal(result.ok, true);
    assert.equal(result.appliedCount, 120);
    const doc = await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main');
    assert.equal(((doc?.data as { elements?: unknown[] })?.elements || []).length, 120);
});

test('StatePatch dryRun keeps revision stable and legacy reset/init inputs are still absorbed atomically', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map dry-run reset' });
    await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{ op: 'add', element: { id: 'old-room', type: 'rect', pos: [0, 0], size: [90, 70], cat: 'wall' } }],
    });

    const unsafeInit = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{
            op: 'init',
            document: {
                meta: { name: 'New Map' },
                elements: [{ id: 'new-room', type: 'rect', pos: [10, 10], size: [40, 40], cat: 'wall' }],
            },
        }],
    });
    assert.equal(unsafeInit.ok, false);
    assert.equal(unsafeInit.error, 'state_patch_failed');

    const dryRun = await executeTavernStateTool(session.id, 'StatePatch', {
        baseRevision: 1,
        dryRun: true,
        ops: [{ op: 'modify', id: 'old-room', changes: { cat: 'secret' } }],
    });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.changed, true);
    assert.equal((await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main'))?.revision, 1);
    assert.equal((await listTavernStructuredStatePatches({ sessionId: session.id })).length, 1);

    const reset = await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{
            op: 'reset',
            document: {
                meta: { name: 'New Map' },
                elements: [{ id: 'new-room', type: 'rect', pos: [10, 10], size: [40, 40], cat: 'wall' }],
            },
        }],
    });
    assert.equal(reset.ok, true);
    assert.equal(reset.revision, 2);
    const doc = await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main');
    const ids = ((doc?.data as { elements?: Array<{ id?: string }> })?.elements || []).map((element) => element.id);
    assert.deepEqual(ids, ['new-room']);
});

test('StatePatch snapshots roll back manager map writes and preserve conflicts', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map rollback' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '进北屋。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '北屋里有一口井。' });
    const run = await createTavernManagerRun({
        sessionId: session.id,
        trigger: 'after_turn',
        status: 'running',
        turn: 1,
        userOrder: userMessage.order,
        assistantOrder: assistantMessage.order,
    });

    await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{ op: 'add', element: { id: 'north-room', type: 'rect', pos: [10, 10], size: [80, 60], cat: 'wall' } }],
    }, {
        caller: 'auto',
        managerRunId: run.id,
        sourceUserOrder: userMessage.order,
        sourceAssistantOrder: assistantMessage.order,
    });
    assert.equal((await listTavernManagerStateSnapshots(run.id)).length, 1);

    const rollback = await rollbackManagerStateRunsForMessageRange(session.id, userMessage.order);
    assert.equal(rollback.rolledBack, 1);
    const rolledBack = await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main');
    assert.equal((rolledBack?.data as { meta?: { status?: string } })?.meta?.status, 'uninitialized');
    assert.equal((await listTavernStructuredStatePatches({ sessionId: session.id })).length, 0);
    assert.equal((await listTavernStructuredStatePatches({ sessionId: session.id, includeRolledBack: true }))[0]?.status, 'rolled_back');

    const conflictRun = await createTavernManagerRun({
        sessionId: session.id,
        trigger: 'after_turn',
        status: 'running',
        turn: 2,
        userOrder: userMessage.order,
        assistantOrder: assistantMessage.order,
    });
    await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{ op: 'add', element: { id: 'well', type: 'circle', center: [20, 20], r: 8, cat: 'water' } }],
    }, { caller: 'auto', managerRunId: conflictRun.id });
    await executeTavernStateTool(session.id, 'StatePatch', {
        baseRevision: 1,
        ops: [{ op: 'meta', changes: { name: '用户手改地图名' } }],
    }, { caller: 'chat' });
    const conflict = await rollbackManagerStateRunsForMessageRange(session.id, userMessage.order);
    assert.deepEqual(conflict.conflicts, ['tavern.map/main']);
    const snapshot = (await listTavernManagerStateSnapshots(conflictRun.id))[0];
    assert.equal(snapshot?.rollbackStatus, 'conflict');
});

test('StatePatch serializes concurrent map writes without losing elements', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Map concurrency' });
    const [left, right] = await Promise.all([
        executeTavernStateTool(session.id, 'StatePatch', {
            ops: [{ op: 'add', element: { id: 'left-room', type: 'rect', pos: [0, 0], size: [60, 40], cat: 'wall' } }],
        }, { caller: 'auto' }),
        executeTavernStateTool(session.id, 'StatePatch', {
            ops: [{ op: 'add', element: { id: 'right-room', type: 'rect', pos: [80, 0], size: [60, 40], cat: 'wall' } }],
        }, { caller: 'chat' }),
    ]);

    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    const doc = await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main');
    const elements = (doc?.data as { elements?: Array<{ id?: string }> })?.elements || [];
    assert.equal(doc?.revision, 2);
    assert.equal(elements.some((element) => element.id === 'left-room'), true);
    assert.equal(elements.some((element) => element.id === 'right-room'), true);
    assert.deepEqual((await listTavernStructuredStatePatches({ sessionId: session.id })).map((patch) => patch.revision), [1, 2]);
});

test('manager range cancellation rolls back state-only writes without leaving cancelled status', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'State-only range rollback' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '进入庭院。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '庭院里有一道侧门。' });
    const run = await createTavernManagerRun({
        sessionId: session.id,
        trigger: 'after_turn',
        status: 'running',
        turn: 1,
        userOrder: userMessage.order,
        assistantOrder: assistantMessage.order,
    });

    await executeTavernStateTool(session.id, 'StatePatch', {
        ops: [{ op: 'add', element: { id: 'yard', type: 'rect', pos: [0, 0], size: [100, 80], cat: 'terrain' } }],
    }, {
        caller: 'auto',
        managerRunId: run.id,
        sourceUserOrder: userMessage.order,
        sourceAssistantOrder: assistantMessage.order,
    });

    const rollback = await cancelAndRollbackXbTavernManagersForMessageRange(session.id, assistantMessage.order);
    assert.equal(rollback.rolledBack, 1);
    const rolledBack = await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main');
    assert.equal((rolledBack?.data as { meta?: { status?: string } })?.meta?.status, 'uninitialized');
    assert.equal((await listTavernManagerRuns(session.id))[0]?.status, 'rolled_back');
});

test('State tools are in the unified manager tool schema', () => {
    const names = getTavernManagerToolDefinitions().map((tool) => tool.function.name);
    assert.equal(names.includes('MemoryEdit'), true);
    assert.equal(names.includes('ChatHistory'), true);
    assert.equal(names.includes('StateList'), true);
    assert.equal(names.includes('StateRead'), true);
    assert.equal(names.includes('StatePatch'), true);

    const statePatch = getTavernStateToolDefinitions().find((tool) => tool.function.name === 'StatePatch');
    assert.match(statePatch?.function.description || '', /meta\/add\/modify\/remove/);
    assert.match(statePatch?.function.description || '', /one atomic transaction/);
    assert.match(statePatch?.function.description || '', /at:\[x,y\]/);
    assert.match(statePatch?.function.description || '', /Legacy init\/reset\/replace input is still absorbed/);
});

test('tavern manager uses memory tools and records tool trace', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Tool manager' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '把银钥匙藏好。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她把银钥匙塞进码头钟楼的砖缝。' });
    const turnPath = turnMemoryPathFor(userMessage, assistantMessage);
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
                    text: '先记录本轮银钥匙位置。',
                    thoughts: [{
                        label: '空间线索',
                        text: '银钥匙位置发生了明确变化，需要写入流水。',
                    }],
                    toolCalls: [{
                        id: 'write-turn',
                        name: 'MemoryWrite',
                        arguments: {
                            filePath: turnPath,
                            content: [
                                '# 银钥匙藏匿',
                                '',
                                '本轮确认银钥匙被藏进码头钟楼砖缝。',
                                '',
                                '## 当前状态',
                                '银钥匙暂时安全。',
                                '',
                                '## 线索',
                                '- 码头钟楼',
                            ].join('\n'),
                        },
                    }],
                };
            }
            const liveRun = (await listTavernManagerRuns(session.id))[0];
            const liveTrace = liveRun?.toolTrace as Array<Record<string, unknown>>;
            assert.equal(liveRun?.status, 'running');
            assert.equal(liveTrace?.[0]?.status, 'resolved');
            assert.equal(liveTrace?.[0]?.preface, '先记录本轮银钥匙位置。');
            assert.equal(((liveTrace?.[0]?.thoughts as Array<{ text?: string }>) || [])[0]?.text, '银钥匙位置发生了明确变化，需要写入流水。');
            return {
                provider: 'fake-manager',
                model: 'memory-model',
                text: `已更新 ${turnPath}。`,
            };
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedFiles, [turnPath]);
    assert.equal((await listTavernMemoryFiles(session.id)).some((file) => file.path === turnPath), true);
    assert.match((await listTavernTurnSummaries(session.id))[0]?.summary || '', /银钥匙/);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.equal(run?.status, 'completed');
    assert.equal(Array.isArray(run?.toolTrace), true);
    assert.equal(run?.changedFiles?.[0], turnPath);
});

test('tavern auto manager prompt omits unauthorized module instructions from both system and user messages', async () => {
    await db.delete();
    await db.open();

    const memorySession = await createTavernSession({ title: 'Memory-only prompt' });
    const memoryUser = await appendTavernMessage(memorySession.id, { role: 'user', content: '把线索记下来。' });
    const memoryAssistant = await appendTavernMessage(memorySession.id, { role: 'assistant', content: '线索已经明确。' });
    let memoryPrompt = '';
    await runXbTavernManagerAfterTurn({
        sessionId: memorySession.id,
        agentConfig: {},
        userMessage: memoryUser,
        assistantMessage: memoryAssistant,
        turn: 1,
        sessionContract: mergeTavernSessionContract(undefined, {
            memoryArchiving: true,
            cartographyEngine: false,
        }),
        executeManagerOnce: async (options) => {
            memoryPrompt = JSON.stringify(options.messages);
            return { provider: 'fake-manager', model: 'memory-only', text: '已检查。' };
        },
    });
    assert.match(memoryPrompt, /MemoryWrite/);
    assert.doesNotMatch(memoryPrompt, /StateRead summary/);
    assert.doesNotMatch(memoryPrompt, /## Structured State/);
    assert.doesNotMatch(memoryPrompt, /地图不能替代本轮流水和文字记忆/);
    assert.doesNotMatch(memoryPrompt, /空间关系图/);

    const mapSession = await createTavernSession({ title: 'Map-only prompt' });
    const mapUser = await appendTavernMessage(mapSession.id, { role: 'user', content: '看看前面地形。' });
    const mapAssistant = await appendTavernMessage(mapSession.id, { role: 'assistant', content: '前面是一条狭长走廊。' });
    let mapPrompt = '';
    await runXbTavernManagerAfterTurn({
        sessionId: mapSession.id,
        agentConfig: {},
        userMessage: mapUser,
        assistantMessage: mapAssistant,
        turn: 1,
        sessionContract: mergeTavernSessionContract(undefined, {
            memoryArchiving: false,
            cartographyEngine: true,
        }),
        executeManagerOnce: async (options) => {
            mapPrompt = JSON.stringify(options.messages);
            return { provider: 'fake-manager', model: 'map-only', text: '已检查。' };
        },
    });
    assert.match(mapPrompt, /StateRead summary/);
    assert.match(mapPrompt, /当前契约只授权地图系统；不要补写 memory Markdown/);
    assert.doesNotMatch(mapPrompt, /MemoryWrite/);
    assert.doesNotMatch(mapPrompt, /memory\/session\.md/);
    assert.doesNotMatch(mapPrompt, /建议流水路径：/);
});

test('tavern auto manager denies unauthorized MemoryWrite without side effects', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Blocked memory write' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '别写记忆。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '那就只看地图。' });
    let calls = 0;

    const executeManagerOnce = (async (options) => {
        calls += 1;
        if (calls === 1) {
            return {
                provider: 'fake-manager',
                model: 'map-only',
                text: '我先试着写记忆。',
                toolCalls: [{
                    id: 'blocked-memory',
                    name: 'MemoryWrite',
                    arguments: {
                        filePath: 'memory/session.md',
                        content: 'should not be written',
                    },
                }],
            };
        }
        assert.equal(options.toolResponses?.[0]?.name, 'MemoryWrite');
        assert.match(JSON.stringify(options.toolResponses?.[0]?.response || {}), /契约未授权 Memory Archiving/);
        return {
            provider: 'fake-manager',
            model: 'map-only',
            text: '已跳过未授权记忆写入。',
        };
    }) as Parameters<typeof runXbTavernManagerAfterTurn>[0]['executeManagerOnce'] & { supportsSessionToolLoop?: boolean };
    executeManagerOnce.supportsSessionToolLoop = true;

    const result = await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        sessionContract: mergeTavernSessionContract(undefined, {
            memoryArchiving: false,
            cartographyEngine: true,
        }),
        executeManagerOnce,
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(result.changedFiles, []);
    assert.equal((await listTavernMemoryFiles(session.id)).some((file) => file.path === 'memory/session.md'), false);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.match(JSON.stringify(run?.toolTrace || []), /契约未授权 Memory Archiving/);
});

test('tavern auto manager denies unauthorized StatePatch without side effects', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Blocked state patch' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '别动地图。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '那我只整理文字。' });
    let calls = 0;

    const executeManagerOnce = (async (options) => {
        calls += 1;
        if (calls === 1) {
            return {
                provider: 'fake-manager',
                model: 'memory-only',
                text: '我先试着改地图。',
                toolCalls: [{
                    id: 'blocked-state',
                    name: 'StatePatch',
                    arguments: {
                        ops: [{
                            op: 'add',
                            element: { id: 'marker', at: [80, 60], icon: 'o', cat: 'marker' },
                        }],
                    },
                }],
            };
        }
        assert.equal(options.toolResponses?.[0]?.name, 'StatePatch');
        assert.match(JSON.stringify(options.toolResponses?.[0]?.response || {}), /契约未授权 Cartography Engine/);
        return {
            provider: 'fake-manager',
            model: 'memory-only',
            text: '已跳过未授权地图改动。',
        };
    }) as Parameters<typeof runXbTavernManagerAfterTurn>[0]['executeManagerOnce'] & { supportsSessionToolLoop?: boolean };
    executeManagerOnce.supportsSessionToolLoop = true;

    const result = await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        sessionContract: mergeTavernSessionContract(undefined, {
            memoryArchiving: true,
            cartographyEngine: false,
        }),
        executeManagerOnce,
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(result.changedStates, []);
    assert.equal((await listTavernStructuredStatePatches({ sessionId: session.id })).length, 0);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.match(JSON.stringify(run?.toolTrace || []), /契约未授权 Cartography Engine/);
});

test('tavern manager chat keeps full tool access even when the stored contract disables auto work', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({
        title: 'Manual manager full tools',
        state: {
            contract: mergeTavernSessionContract(undefined, {
                memoryArchiving: false,
                cartographyEngine: false,
            }),
        },
    });
    let calls = 0;
    const result = await runXbTavernManagerChat({
        sessionId: session.id,
        agentConfig: {},
        question: '把这件事记到 session 里。',
        executeManagerOnce: async (options) => {
            calls += 1;
            if (calls === 1) {
                assert.match(JSON.stringify(options.messages), /MemoryWrite/);
                return {
                    provider: 'fake-manager',
                    model: 'chat-tools',
                    text: '我直接更新现有记忆。',
                    toolCalls: [{
                        id: 'manual-write',
                        name: 'MemoryWrite',
                        arguments: {
                            filePath: 'memory/session.md',
                            content: '# Session\n\n手动管理员仍可写入。',
                        },
                    }],
                };
            }
            return {
                provider: 'fake-manager',
                model: 'chat-tools',
                text: '已写入。',
            };
        },
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.match((await getTavernMemoryFile(session.id, 'memory/session.md'))?.content || '', /手动管理员仍可写入/);
});

test('tavern manager stores one preface for parallel tool calls in the same round', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Parallel trace display' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '记录两件事。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她提到北门和银钥匙。' });
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
                    text: '同时写两份档案。',
                    thoughts: [{ label: '归档', text: '同一轮并行工具共享这段思考。' }],
                    toolCalls: [{
                        id: 'write-session',
                        name: 'MemoryWrite',
                        arguments: { filePath: 'memory/session.md', content: '北门存在。' },
                    }, {
                        id: 'write-state',
                        name: 'MemoryWrite',
                        arguments: { filePath: 'memory/state.md', content: '银钥匙在场。' },
                    }],
                };
            }
            return {
                provider: 'fake-manager',
                model: 'memory-model',
                text: '已写入。',
            };
        },
    });

    assert.equal(result.ok, true);
    const run = (await listTavernManagerRuns(session.id))[0];
    const trace = run?.toolTrace as Array<{ preface?: string; thoughts?: unknown[] }>;
    assert.equal(trace?.[0]?.preface, '同时写两份档案。');
    assert.equal(trace?.[1]?.preface, '');
    assert.equal((trace?.[0]?.thoughts || []).length, 1);
    assert.equal((trace?.[1]?.thoughts || []).length, 0);
});

test('tavern manager tool loop follows ebook round budget instead of stopping after eight rounds', async () => {
    await db.delete();
    await db.open();

    assert.equal(MAX_MANAGER_TOOL_ROUNDS, 48);

    const session = await createTavernSession({ title: 'Long manager tool loop' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '把这些线索都整理进去。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她连续列出了九个地点线索。' });
    let calls = 0;

    const result = await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        executeManagerOnce: async () => {
            calls += 1;
            if (calls <= 9) {
                return {
                    provider: 'fake-manager',
                    model: 'memory-model',
                    text: '',
                    toolCalls: [{
                        id: `write-${calls}`,
                        name: 'MemoryWrite',
                        arguments: {
                            filePath: `memory/turns/long-loop-${calls}.md`,
                            content: `# 线索 ${calls}\n\n第 ${calls} 条线索。`,
                        },
                    }],
                };
            }
            return {
                provider: 'fake-manager',
                model: 'memory-model',
                text: '九条线索已整理。',
            };
        },
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 10);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.equal(run?.status, 'completed');
    assert.equal((run?.toolTrace as unknown[] | undefined)?.length, 9);
    assert.equal((await listTavernMemoryFiles(session.id)).filter((file) => file.path.startsWith('memory/turns/long-loop-')).length, 9);
});

test('tavern manager preserves streamed thoughts and provider tool replay payloads', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Provider replay manager' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '记下北门。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '北门半开，门后有蓝光。' });
    const turnPath = turnMemoryPathFor(userMessage, assistantMessage);
    let calls = 0;

    const result = await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        executeManagerOnce: async (options) => {
            calls += 1;
            if (calls === 1) {
                options.onStreamProgress?.({
                    text: '先记录北门状态。',
                    thoughts: [{ label: 'Gemini 思考', text: '这里有空间状态变化。' }],
                });
                return {
                    provider: 'sillytavern-google',
                    model: 'gemini-test',
                    text: '',
                    providerPayload: {
                        googleContent: {
                            role: 'model',
                            parts: [
                                { thought: true, text: '这里有空间状态变化。', thoughtSignature: 'sig-thought' },
                                { functionCall: { id: 'write-turn', name: 'MemoryWrite', args: { filePath: turnPath, content: '# 北门\n\n北门半开，门后有蓝光。' } }, thoughtSignature: 'sig-tool' },
                            ],
                        },
                    },
                    toolCalls: [{
                        id: 'write-turn',
                        name: 'MemoryWrite',
                        arguments: {
                            filePath: turnPath,
                            content: '# 北门\n\n北门半开，门后有蓝光。',
                        },
                    }],
                };
            }
            const replayAssistant = options.messages?.find((message) => message.role === 'assistant' && Array.isArray((message as { tool_calls?: unknown[] }).tool_calls)) as ({ providerPayload?: unknown } | undefined);
            const replayTool = options.messages?.find((message) => message.role === 'tool') as { toolName?: string; tool_call_id?: string } | undefined;
            assert.equal(replayAssistant?.providerPayload && typeof replayAssistant.providerPayload === 'object', true);
            assert.equal((replayTool?.toolName || ''), 'MemoryWrite');
            assert.equal(replayTool?.tool_call_id, 'write-turn');
            return {
                provider: 'sillytavern-google',
                model: 'gemini-test',
                text: '已记录北门。',
            };
        },
    });

    assert.equal(result.ok, true);
    const run = (await listTavernManagerRuns(session.id))[0];
    const trace = run?.toolTrace as Array<Record<string, unknown>>;
    assert.equal(trace?.[0]?.preface, '先记录北门状态。');
    assert.equal(((trace?.[0]?.thoughts as Array<{ text?: string }>) || [])[0]?.text, '这里有空间状态变化。');
});

test('tavern manager chat forwards streamed tool drafts for live tool-turn UI', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Manager live tool draft' });
    const progress: Array<Record<string, unknown>> = [];
    const result = await runXbTavernManagerChat({
        sessionId: session.id,
        agentConfig: {},
        question: '查一下状态。',
        executeManagerOnce: async (options) => {
            options.onStreamProgress?.({
                text: '',
                toolCallDraft: true,
                toolCalls: [{
                    id: 'draft-read',
                    name: 'MemoryRead',
                    arguments: { path: 'memory/state.md' },
                }],
            });
            return {
                provider: 'fake-manager',
                model: 'memory-model',
                text: '我会先查状态档案。',
            };
        },
        onStreamProgress: (snapshot) => {
            progress.push(snapshot as Record<string, unknown>);
        },
    });

    assert.equal(result.ok, true);
    assert.equal(progress.some((snapshot) => snapshot.toolCallDraft === true), true);
    assert.equal(progress.some((snapshot) => (snapshot.toolCalls as Array<{ name?: string }> | undefined)?.[0]?.name === 'MemoryRead'), true);
});

test('tavern manager persists provider tool protocol messages for later manager chat replay', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Persisted manager protocol' });
    await appendTavernManagerMessage(session.id, { role: 'user', content: '读一下北门。' });
    await appendTavernManagerMessage(session.id, {
        role: 'assistant',
        content: '我先查档案。',
        thoughts: [{ label: 'Gemini 思考', text: '需要读取 memory/state.md。' }],
        providerPayload: {
            googleContent: {
                role: 'model',
                parts: [
                    { thought: true, text: '需要读取 memory/state.md。', thoughtSignature: 'sig-read' },
                    { functionCall: { id: 'read-state', name: 'MemoryRead', args: { path: 'memory/state.md' } }, thoughtSignature: 'sig-tool' },
                ],
            },
        },
        tool_calls: [{
            id: 'read-state',
            type: 'function',
            function: {
                name: 'MemoryRead',
                arguments: '{"path":"memory/state.md"}',
            },
        }],
    });
    await appendTavernManagerMessage(session.id, {
        role: 'tool',
        content: '{"ok":true,"content":"北门半开。"}',
        toolCallId: 'read-state',
        toolName: 'MemoryRead',
    });
    await appendTavernManagerMessage(session.id, { role: 'assistant', content: '北门半开。' });

    let replayChecked = false;
    const result = await runXbTavernManagerChat({
        sessionId: session.id,
        agentConfig: {},
        question: '继续判断。',
        executeManagerOnce: async (options) => {
            const replayAssistant = options.messages?.find((message) => (
                message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length
            ));
            const replayTool = options.messages?.find((message) => message.role === 'tool');
            assert.equal(replayAssistant?.providerPayload && typeof replayAssistant.providerPayload === 'object', true);
            assert.equal(replayAssistant?.tool_calls?.[0]?.function?.name, 'MemoryRead');
            assert.equal(replayTool?.tool_call_id, 'read-state');
            assert.equal(replayTool?.toolName, 'MemoryRead');
            replayChecked = true;
            return { provider: 'fake-manager', model: 'memory-model', text: '已确认。' };
        },
    });

    assert.equal(result.ok, true);
    assert.equal(replayChecked, true);
});

test('tavern manager uses session toolResponses when runner supports session tool loop', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Session tool loop' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '记下北门。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '北门半开。' });
    const turnPath = turnMemoryPathFor(userMessage, assistantMessage);
    let calls = 0;
    const executeManagerOnce = (async (options) => {
        calls += 1;
        if (calls === 1) {
            assert.equal(Array.isArray(options.toolResponses), false);
            return {
                provider: 'sillytavern-google',
                model: 'gemini-test',
                text: '',
                providerPayload: {
                    googleContent: {
                        role: 'model',
                        parts: [
                            { functionCall: { id: 'write-turn', name: 'MemoryWrite', args: { filePath: turnPath, content: '# 北门\n\n北门半开。' } } },
                        ],
                    },
                },
                toolCalls: [{
                    id: 'write-turn',
                    name: 'MemoryWrite',
                    arguments: {
                        filePath: turnPath,
                        content: '# 北门\n\n北门半开。',
                    },
                }],
            };
        }
        assert.equal(options.toolResponses?.length, 1);
        assert.equal(options.toolResponses?.[0]?.id, 'write-turn');
        assert.equal(options.toolResponses?.[0]?.name, 'MemoryWrite');
        return {
            provider: 'sillytavern-google',
            model: 'gemini-test',
            text: '已记录北门。',
        };
    }) as Parameters<typeof runXbTavernManagerAfterTurn>[0]['executeManagerOnce'] & { supportsSessionToolLoop?: boolean };
    executeManagerOnce.supportsSessionToolLoop = true;

    const result = await runXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        executeManagerOnce,
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 2);
});

test('tavern manager accepts arbitrary turn markdown without schema parsing', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Normalized turn markdown' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '继续。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她继续。' });
    const turnPath = turnMemoryPathFor(userMessage, assistantMessage);
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
                            filePath: turnPath,
                            content: [
                                '# 自由格式流水',
                                '',
                                '这条 turns 记录没有任何固定骨架，但系统仍会按当前消息维护检索元数据。',
                            ].join('\n'),
                        },
                    }, {
                        id: 'write-map',
                        name: 'StatePatch',
                        arguments: {
                            ops: [{
                                op: 'add',
                                element: { id: 'invalid-turn-map-room', type: 'rect', pos: [0, 0], size: [80, 60], cat: 'wall' },
                            }],
                        },
                    }],
                };
            }
            return {
                provider: 'fake-manager',
                model: 'memory-model',
                text: '已写入。',
            };
        },
    });

    assert.equal(result.ok, true);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.equal(run?.status, 'completed');
    const file = await getTavernMemoryFile(session.id, turnPath);
    assert.doesNotMatch(file?.content || '', /messages 0\/1/);
    assert.match((await listTavernTurnSummaries(session.id))[0]?.summary || '', /固定骨架/);
    assert.notEqual(await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main'), null);
});

test('tavern manager does not roll back just because turn markdown has no fixed headings', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Invalid turn markdown' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '继续。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她继续。' });
    const turnPath = turnMemoryPathFor(userMessage, assistantMessage);
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
                            filePath: turnPath,
                            content: [
                                '# 自由记录',
                                '',
                                '这条 turns 记录只有一段普通正文。',
                            ].join('\n'),
                        },
                    }, {
                        id: 'write-map',
                        name: 'StatePatch',
                        arguments: {
                            ops: [{
                                op: 'add',
                                element: { id: 'invalid-turn-map-room', type: 'rect', pos: [0, 0], size: [80, 60], cat: 'wall' },
                            }],
                        },
                    }],
                };
            }
            return {
                provider: 'fake-manager',
                model: 'memory-model',
                text: '已写入，但格式坏了。',
            };
        },
    });

    assert.equal(result.ok, true);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.equal(run?.status, 'completed');
    assert.equal(run?.error, '');
    assert.match((await getTavernMemoryFile(session.id, turnPath))?.content || '', /普通正文/);
    assert.notEqual(await getTavernStructuredStateDocument(session.id, 'tavern.map', 'main'), null);
    assert.equal((await listTavernStructuredStatePatches({ sessionId: session.id })).length, 1);
});

test('tavern manager keeps episode markdown as readable files without parsing summary ids', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Bounded manager' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '去码头。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她答应了。' });
    const turnPath = turnMemoryPathFor(userMessage, assistantMessage);
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
                            filePath: turnPath,
                            content: [
                                '# 去码头',
                                '',
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
                                '## 阶段概述',
                                '最近几轮开始转向码头。',
                                '',
                                '## 相关流水',
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

    assert.equal((await listTavernEpisodeSummaries(session.id)).length, 0);
    const episodeFile = await getTavernMemoryFile(session.id, 'memory/episodes/007.md');
    assert.match(episodeFile?.content || '', /not-real/);
    const grep = await executeTavernMemoryTool(session.id, 'MemoryGrep', {
        pattern: '最近几轮开始转向码头',
        path: 'memory/episodes/',
    });
    assert.equal(grep.count, 1);
});

test('tavern manager completes when no current turn memory file is written', async () => {
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
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(runs[0]?.status, 'completed');
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
    assert.equal((await listTavernManagerRuns(session.id))[0]?.status, 'superseded');
});

test('tavern manager rolls back earlier memory writes when source messages change mid-run', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Mid-run rollback' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '记录这段。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她把线索放进抽屉。' });
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
                        id: 'write-episode',
                        name: 'MemoryWrite',
                        arguments: {
                            filePath: 'memory/episodes/mid-run.md',
                            content: '# 临时阶段\n\n这条写入稍后必须回滚。',
                        },
                    }],
                };
            }
            await updateTavernMessage(session.id, assistantMessage.order, { content: '她没有把线索放进抽屉。' });
            return {
                text: '',
                toolCalls: [{
                    id: 'write-state',
                    name: 'MemoryWrite',
                    arguments: {
                        filePath: 'memory/state.md',
                        content: '# State\n\n不应该写到这里。',
                    },
                }],
            };
        },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'manager_source_messages_changed');
    assert.equal((await getTavernMemoryFile(session.id, 'memory/episodes/mid-run.md')), null);
    assert.doesNotMatch((await getTavernMemoryFile(session.id, 'memory/state.md'))?.content || '', /不应该写到这里/);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.equal(run?.status, 'rolled_back');
    const snapshots = await listTavernManagerMemorySnapshots(run?.id || '');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.path, 'memory/episodes/mid-run.md');
    assert.equal(snapshots[0]?.rollbackStatus, 'rolled_back');
});

test('tavern manager cancellation aborts an active auto run and rolls back written memory', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Active cancel rollback' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '第一轮。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '第一轮回复。' });
    let calls = 0;
    let releaseSecondRound!: () => void;
    let resolveSecondRoundStarted!: () => void;
    const secondRoundGate = new Promise<void>((resolve) => {
        releaseSecondRound = resolve;
    });
    const secondRoundSeen = new Promise<void>((resolve) => {
        resolveSecondRoundStarted = resolve;
    });

    const scheduled = await scheduleXbTavernManagerAfterTurn({
        sessionId: session.id,
        agentConfig: {},
        userMessage,
        assistantMessage,
        turn: 1,
        awaitCompletion: false,
        executeManagerOnce: async () => {
            calls += 1;
            if (calls === 1) {
                return {
                    text: '',
                    toolCalls: [{
                        id: 'write-episode',
                        name: 'MemoryWrite',
                        arguments: {
                            filePath: 'memory/episodes/cancelled.md',
                            content: '# 会被取消\n\n旧管理员写入。',
                        },
                    }],
                };
            }
            resolveSecondRoundStarted();
            await secondRoundGate;
            return { text: '如果没有检查 abort，这里会错误完成。' };
        },
    });

    await secondRoundSeen;
    const rollback = await cancelAndRollbackXbTavernManagersForMessageRange(session.id, assistantMessage.order);
    assert.equal(rollback.rolledBack, 1);
    assert.equal(await getTavernMemoryFile(session.id, 'memory/episodes/cancelled.md'), null);
    releaseSecondRound();
    const completed = await scheduled.completion;

    assert.equal(completed?.ok, false);
    assert.notEqual(completed?.managerRun.status, 'completed');
    assert.equal((await getTavernMemoryFile(session.id, 'memory/episodes/cancelled.md')), null);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.equal(run?.status, 'rolled_back');
});

test('tavern manager rollback uses snapshots even when changedFiles were not finalized', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Snapshot truth' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '第一轮。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '第一轮回复。' });
    const run = await createTavernManagerRun({
        sessionId: session.id,
        turn: 1,
        userOrder: userMessage.order,
        assistantOrder: assistantMessage.order,
        trigger: 'after_turn',
        status: 'running',
        changedFiles: [],
    });

    const writeResult = await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'memory/episodes/not-finalized.md',
        content: '# 尚未 finalize\n\nchangedFiles 还没落库。',
    }, {
        caller: 'auto',
        managerRunId: run.id,
    });
    assert.equal(writeResult.ok, true);

    const rollback = await rollbackManagerRunsForMessageRange(session.id, assistantMessage.order);

    assert.equal(rollback.rolledBack, 1);
    assert.equal(await getTavernMemoryFile(session.id, 'memory/episodes/not-finalized.md'), null);
    assert.equal((await listTavernManagerRuns(session.id))[0]?.status, 'rolled_back');
});

test('tavern manager memory rollback is idempotent', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Idempotent rollback' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '第一轮。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '第一轮回复。' });
    const run = await createTavernManagerRun({
        sessionId: session.id,
        turn: 1,
        userOrder: userMessage.order,
        assistantOrder: assistantMessage.order,
        trigger: 'after_turn',
        status: 'completed',
        changedFiles: ['memory/episodes/idempotent.md'],
    });
    await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'memory/episodes/idempotent.md',
        content: '# 可重复回滚\n\n第一次回滚后第二次不应冲突。',
    }, {
        caller: 'auto',
        managerRunId: run.id,
    });

    const first = await rollbackManagerRunsForMessageRange(session.id, assistantMessage.order);
    const second = await rollbackManagerRunsForMessageRange(session.id, assistantMessage.order);

    assert.equal(first.rolledBack, 1);
    assert.equal(second.rolledBack, 0);
    assert.deepEqual(second.conflicts, []);
    const snapshot = (await listTavernManagerMemorySnapshots(run.id))[0];
    assert.equal(snapshot?.rollbackStatus, 'rolled_back');
});

test('tavern manager rollback does not overwrite user-edited memory conflicts', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Rollback conflict' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '第一轮。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '第一轮回复。' });
    await ensureTavernMemoryDefaults(session.id);
    const before = (await getTavernMemoryFile(session.id, 'memory/session.md'))?.content || '';
    const run = await createTavernManagerRun({
        sessionId: session.id,
        turn: 1,
        userOrder: userMessage.order,
        assistantOrder: assistantMessage.order,
        trigger: 'after_turn',
        status: 'completed',
        changedFiles: ['memory/session.md'],
    });

    const writeResult = await executeTavernMemoryTool(session.id, 'MemoryWrite', {
        filePath: 'memory/session.md',
        content: `${before}\n\n管理员写入。`,
    }, {
        caller: 'auto',
        managerRunId: run.id,
    });
    assert.equal(writeResult.ok, true);
    await writeTavernMemoryFile(session.id, 'memory/session.md', '用户手动修正。', { source: 'user' });

    const rollback = await rollbackManagerRunsForMessageRange(session.id, assistantMessage.order);

    assert.deepEqual(rollback.conflicts, ['memory/session.md']);
    assert.equal((await getTavernMemoryFile(session.id, 'memory/session.md'))?.content, '用户手动修正。');
    const snapshot = (await listTavernManagerMemorySnapshots(run.id))[0];
    assert.equal(snapshot?.rollbackStatus, 'conflict');
    assert.equal((await listTavernManagerRuns(session.id))[0]?.status, 'rolled_back');
    assert.match((await getTavernMemoryIndex(session.id))?.error || '', /rollback_conflict:memory\/session\.md/);
});

test('tavern manager keeps raw output when no current memory file is written', async () => {
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
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(runs[0]?.status, 'completed');
    assert.equal(runs[0]?.outputText, '这不是 JSON');
    assert.equal(runs[0]?.provider, 'fake-manager');
    assert.equal(runs[0]?.model, 'memory-model');
    assert.equal((await listTavernMemoryFiles(session.id)).some((file) => file.path.startsWith('memory/turns/')), false);
});

test('tavern manager keeps auto run completed when a non-critical tool call fails', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Tool failure' });
    const userMessage = await appendTavernMessage(session.id, { role: 'user', content: '藏好钥匙。' });
    const assistantMessage = await appendTavernMessage(session.id, { role: 'assistant', content: '她把钥匙藏好。' });
    const turnPath = turnMemoryPathFor(userMessage, assistantMessage);
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
                            filePath: turnPath,
                            content: [
                                '# 银钥匙',
                                '',
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
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(runs[0]?.status, 'completed');
    assert.deepEqual(runs[0]?.changedFiles, [turnPath]);
    assert.notEqual(await getTavernMemoryFile(session.id, turnPath), null);
    assert.equal((runs[0]?.toolTrace as Array<{ ok?: boolean }>).some((item) => item.ok === false), true);
});

test('tavern manager chat carries persisted manager history and can read RP raw text through ChatHistory', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Manager chat history' });
    await appendTavernMessage(session.id, { role: 'user', content: '上一轮原文。' });
    await appendTavernMessage(session.id, { role: 'assistant', content: '上一轮回复。' });
    await appendTavernManagerMessage(session.id, { role: 'user', content: '先前问：这段关系现在到哪了？' });
    await appendTavernManagerMessage(session.id, { role: 'assistant', content: '先前答：还在试探阶段。' });

    let firstRoundMessages = '';
    let toolNames: string[] = [];
    let calls = 0;
    const result = await runXbTavernManagerChat({
        sessionId: session.id,
        agentConfig: {},
        question: '继续看原文，帮我判断。',
        executeManagerOnce: async (options) => {
            calls += 1;
            firstRoundMessages = firstRoundMessages || JSON.stringify(options.messages);
            toolNames = Array.isArray(options.tools)
                ? options.tools.map((tool) => String((tool as { function?: { name?: string } }).function?.name || ''))
                : [];
            if (calls === 1) {
                return {
                    text: '',
                    toolCalls: [{
                        id: 'chat-history',
                        name: 'ChatHistory',
                        arguments: {
                            mode: 'recent',
                            limit: 2,
                            full: true,
                        },
                    }],
                };
            }
            return {
                text: '我已经读了原文，也保留了管理员自己的上下文。',
            };
        },
    });

    assert.equal(result.ok, true);
    const firstMessages = JSON.parse(firstRoundMessages) as Array<{ role?: string; content?: string }>;
    assert.equal(firstMessages[0]?.role, 'system');
    assert.match(firstMessages[0]?.content || '', /小白酒馆后台管理员/);
    assert.match(firstRoundMessages, /先前问：这段关系现在到哪了/);
    assert.match(firstRoundMessages, /先前答：还在试探阶段/);
    assert.match(firstRoundMessages, /继续看原文，帮我判断/);
    assert.equal(toolNames.includes('ChatHistory'), true);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.equal(Array.isArray(run?.toolTrace), true);
    assert.equal((run?.toolTrace as Array<{ name?: string }>)[0]?.name, 'ChatHistory');
});

test('tavern manager chat can update memory turn files when asked', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Manager chat guard' });
    let calls = 0;
    const result = await runXbTavernManagerChat({
        sessionId: session.id,
        agentConfig: {},
        question: '帮我直接改 turns。',
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
                            content: '# 手动写入流水',
                        },
                    }],
                };
            }
            return { text: '已按要求更新。' };
        },
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal((await listTavernMemoryFiles(session.id)).some((file) => file.path.startsWith('memory/turns/')), true);
    const run = (await listTavernManagerRuns(session.id))[0];
    assert.equal(run?.status, 'completed');
    assert.equal((run?.toolTrace as Array<{ ok?: boolean; error?: string }>)?.[0]?.ok, true);
    assert.match((await getTavernMemoryFile(session.id, 'memory/turns/20260601-0000.md'))?.content || '', /手动写入流水/);
});

test('tavern manager messages are session-scoped', async () => {
    await db.delete();
    await db.open();

    const first = await createTavernSession({ title: 'Manager A' });
    const second = await createTavernSession({ title: 'Manager B' });
    await appendTavernManagerMessage(first.id, { role: 'user', content: 'A-1' });
    await appendTavernManagerMessage(first.id, { role: 'assistant', content: 'A-2' });
    await appendTavernManagerMessage(second.id, { role: 'user', content: 'B-1' });

    assert.deepEqual((await listTavernManagerMessages(first.id)).map((message) => message.content), ['A-1', 'A-2']);
    assert.deepEqual((await listTavernManagerMessages(second.id)).map((message) => message.content), ['B-1']);
});

test('tavern manager message update reuses one timestamp for row and session', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Manager timestamp' });
    const message = await appendTavernManagerMessage(session.id, { role: 'assistant', content: '旧内容。' });
    const originalNow = Date.now;
    let tick = 1000;
    Date.now = () => {
        tick += 1;
        return tick;
    };
    try {
        const updated = await updateTavernManagerMessage(session.id, message.order, { content: '新内容。' });
        const refreshedSession = await getTavernSession(session.id);
        assert.equal(updated?.updatedAt, refreshedSession?.updatedAt);
    } finally {
        Date.now = originalNow;
    }
});

test('tavern manager message edit can clear stale provider protocol payloads', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Manager protocol edit' });
    const message = await appendTavernManagerMessage(session.id, {
        role: 'assistant',
        content: '旧内容。',
        providerPayload: {
            googleContent: {
                role: 'model',
                parts: [{ text: '旧内容。' }],
            },
        },
        tool_calls: [{
            id: 'old-tool',
            type: 'function',
            function: {
                name: 'MemoryRead',
                arguments: '{"path":"memory/state.md"}',
            },
        }],
    });

    const updated = await updateTavernManagerMessage(session.id, message.order, {
        content: '新内容。',
        clearProtocolPayload: true,
    });

    assert.equal(updated?.content, '新内容。');
    assert.equal(updated?.providerPayload, undefined);
    assert.equal(updated?.toolCalls, undefined);
    assert.equal(updated?.toolCallId, undefined);
    assert.equal(updated?.toolName, undefined);
});

test('tavern manager chat does not replay stale tool drafts from errored history messages', async () => {
    await db.delete();
    await db.open();

    const session = await createTavernSession({ title: 'Stale manager draft' });
    const user = await appendTavernManagerMessage(session.id, {
        role: 'user',
        content: '停一下。',
    });
    const staleAssistant = await appendTavernManagerMessage(session.id, {
        role: 'assistant',
        content: 'provider failed',
        error: true,
        finishReason: 'error',
        toolCalls: [{
            id: 'draft-read',
            name: 'MemoryRead',
            arguments: '{"path":"memory/state.md"}',
        }],
    });
    let replayMessages: unknown[] = [];

    const result = await runXbTavernManagerChat({
        sessionId: session.id,
        agentConfig: {},
        question: '现在状态如何？',
        history: [user, staleAssistant],
        executeManagerOnce: async (options) => {
            replayMessages = options.messages || [];
            return { text: '可以继续。', provider: 'fake-manager', model: 'memory-model' };
        },
    });

    const assistantReplay = (replayMessages as Array<Record<string, unknown>>).find((message) => (
        message.role === 'assistant' && message.content === 'provider failed'
    ));
    assert.equal(result.ok, true);
    assert.equal(Array.isArray((assistantReplay as { toolCalls?: unknown[] } | undefined)?.toolCalls), false);
    assert.equal(Array.isArray((assistantReplay as { tool_calls?: unknown[] } | undefined)?.tool_calls), false);
});
