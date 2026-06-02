import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_XB_TAVERN_WORLD_SETTINGS,
    buildXbTavernBrain,
    createXbTavernRuntimeState,
    createXbTavernWorldSettings,
} from '../shared/brain';
import { createDefaultXbTavernPreset } from '../shared/presets';

test('xb tavern brain applies one shared runtime contract for preview and runs', () => {
    const preset = createDefaultXbTavernPreset();
    const brain = buildXbTavernBrain({
        context: {
            character: { id: 'char-1', name: 'Aster' },
            user: { name: 'Player' },
            worldBooks: [{
                name: 'Lore',
                entries: [{
                    uid: 'station',
                    content: 'Station lore.',
                    key: 'station',
                    order: 1,
                }],
            }],
        },
        preset,
        currentUserMessage: 'The station opens.',
        historyMode: 'squash',
        turn: 3,
        entryStates: {},
        diagnostics: { ok: true },
    });

    assert.equal(brain.runtimeState.worldSettings?.recursion, DEFAULT_XB_TAVERN_WORLD_SETTINGS.recursion);
    assert.equal(brain.runtimeState.worldSettings?.recursionLimit, DEFAULT_XB_TAVERN_WORLD_SETTINGS.recursionLimit);
    assert.equal(brain.runtimeState.worldSettings?.budgetChars, DEFAULT_XB_TAVERN_WORLD_SETTINGS.budgetChars);
    assert.equal(brain.runtimeState.worldSettings?.turn, 3);
    assert.equal(brain.buildResult.activatedWorldEntries.length, 1);
    assert.equal(brain.rawMessagesJson, brain.buildSnapshot.rawMessagesJson);
    assert.deepEqual(JSON.parse(brain.rawMessagesJson), brain.buildResult.messages);
});

test('xb tavern brain world setting helper normalizes state defaults', () => {
    const worldSettings = createXbTavernWorldSettings({
        turn: -2,
        entryStates: {
            'World\u0000entry': { cooldownUntilTurn: 4 },
        },
    });
    const runtimeState = createXbTavernRuntimeState({
        context: {},
        preset: {},
        currentUserMessage: 'Hello.',
        turn: -2,
        entryStates: worldSettings.entryStates,
    });

    assert.equal(worldSettings.turn, 0);
    assert.equal(runtimeState.currentUserMessage, 'Hello.');
    assert.equal(runtimeState.historyMode, 'squash');
    assert.deepEqual(runtimeState.worldSettings?.entryStates, {
        'World\u0000entry': { cooldownUntilTurn: 4 },
    });
});

test('xb tavern brain injects memory between history and current user message', () => {
    const preset = createDefaultXbTavernPreset();
    const brain = buildXbTavernBrain({
        context: {
            character: { id: 'char-1', name: 'Aster' },
            history: [{ role: 'assistant', content: 'Old reply.' }],
        },
        preset,
        currentUserMessage: 'Continue.',
        memoryContext: {
            episodeSummaries: [{
                id: 'episode-1',
                title: '初遇',
                summary: '双方完成试探。',
                startTurn: 1,
                endTurn: 3,
                keyChanges: ['信任增加'],
            }],
            turnSummaries: [{
                id: 'turn-3',
                turn: 3,
                userOrder: 4,
                assistantOrder: 5,
                summary: 'Aster 接受了邀请。',
                tags: ['邀请'],
            }],
        },
    });

    const memoryLayer = brain.buildResult.messageLayers.find((layer) => layer.layer === 'memory');
    const currentUserLayer = brain.buildResult.messageLayers.find((layer) => layer.label === 'current user message');
    const historyLayer = brain.buildResult.messageLayers.find((layer) => layer.label === 'history 1');
    assert.ok(memoryLayer);
    assert.ok(currentUserLayer);
    assert.ok(historyLayer);
    assert.ok(memoryLayer.index > historyLayer.index);
    assert.ok(memoryLayer.index < currentUserLayer.index);
    assert.match(brain.buildResult.messages[memoryLayer.index]?.content || '', /<session_memory>/);
    assert.match(brain.rawMessagesJson, /Aster 接受了邀请/);
});
