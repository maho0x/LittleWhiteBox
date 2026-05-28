import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

import db, {
    appendTavernMessage,
    createTavernSession,
    deriveAndActivateDefaultTavernPreset,
    getActiveTavernPresetId,
    getSelectedTavernSessionId,
    getTavernSession,
    listUserTavernPresets,
    listTavernMessages,
    loadActiveTavernPreset,
    mergeWorldEntryStates,
    normalizeTavernSessionState,
    saveTavernPreset,
    setActiveTavernPresetId,
    updateTavernSessionState,
} from '../shared/session-db';
import { DEFAULT_XB_TAVERN_PRESET_ID, createDefaultXbTavernPreset } from '../shared/presets';
import { buildXbTavernMessages, createXbTavernBuildSnapshot } from '../shared/message-assembler';

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
        systemPrompt: 'Top',
        toolPrompt: 'Tools',
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
});
