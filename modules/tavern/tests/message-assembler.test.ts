import test from 'node:test';
import assert from 'node:assert/strict';

import {
    XBTavernSelectiveLogic,
    XBTavernWorldPosition,
    activateWorldEntries,
    buildXbTavernMessages,
    createXbTavernBuildSnapshot,
    squashChatHistory,
} from '../shared/message-assembler';
import {
    DEFAULT_XB_TAVERN_PRESET_ID,
    createDefaultXbTavernPreset,
    listBuiltInXbTavernPresets,
} from '../shared/presets';

test('xb tavern assembler keeps top preset sections before character data', () => {
    const result = buildXbTavernMessages({
        character: {
            name: 'Aster',
            description: 'A careful pilot.',
        },
        user: {
            name: 'Player',
        },
    }, {
        sections: [{ placement: 'top', role: 'system', content: 'Preset tone' }],
    }, {
        currentUserMessage: 'Hello.',
    });

    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[0].content, 'Preset tone');
    assert.deepEqual(result.messageLayers.slice(0, 1).map((item) => item.layer), ['preset']);
    assert.deepEqual(JSON.parse(result.meta.rawMessagesJson), result.messages);
    assert.match(result.messages.map((message) => message.content).join('\n'), /<character_card>/);
    assert.equal(result.messages.filter((message) => message.content === 'Preset tone').length, 1);
});

test('xb tavern default preset uses editable sections without hidden top prompts', () => {
    const preset = createDefaultXbTavernPreset();
    const result = buildXbTavernMessages({
        character: { name: 'Aster', description: 'Pilot.' },
    }, preset, {
        currentUserMessage: '继续。',
    });

    assert.equal(preset.id, DEFAULT_XB_TAVERN_PRESET_ID);
    assert.equal(preset.name, '小白酒馆默认角色扮演预设');
    assert.equal(preset.version, '1.0.0');
    assert.equal(listBuiltInXbTavernPresets()[0]?.id, DEFAULT_XB_TAVERN_PRESET_ID);
    assert.equal(result.messageLayers[0]?.layer, 'preset');
    assert.equal(result.messageLayers[0]?.sourceId, 'source-priority');
    assert.match(result.messages[0]?.content || '', /你正在小白酒馆中进行角色扮演/);
});

test('xb tavern preset labels are debug metadata only', () => {
    const result = buildXbTavernMessages({}, {
        sections: [{
            id: 'debug-label-test',
            label: 'Debug Label',
            locked: true,
            placement: 'beforeHistory',
            role: 'system',
            content: 'Actual preset content.',
        }],
    }, {
        currentUserMessage: 'Hello.',
    });

    assert.equal(result.messageLayers.some((layer) => layer.label === 'Debug Label'), true);
    assert.equal(result.messageLayers.some((layer) => layer.sourceId === 'debug-label-test'), true);
    assert.equal(result.messages.some((message) => message.content.includes('Debug Label')), false);
    assert.deepEqual(JSON.parse(result.meta.rawMessagesJson), result.messages);
});

test('xb tavern disabled preset sections stay out of model messages', () => {
    const result = buildXbTavernMessages({}, {
        sections: [
            {
                id: 'enabled-section',
                label: 'Enabled',
                enabled: true,
                placement: 'beforeHistory',
                role: 'system',
                content: 'Enabled content.',
            },
            {
                id: 'disabled-section',
                label: 'Disabled',
                enabled: false,
                placement: 'beforeHistory',
                role: 'system',
                content: 'Disabled content.',
            },
        ],
    }, {
        currentUserMessage: 'Hello.',
    });

    assert.equal(result.messages.some((message) => message.content === 'Enabled content.'), true);
    assert.equal(result.messages.some((message) => message.content === 'Disabled content.'), false);
    assert.equal(result.messageLayers.some((layer) => layer.sourceId === 'enabled-section'), true);
    assert.equal(result.messageLayers.some((layer) => layer.sourceId === 'disabled-section'), false);
});

test('xb tavern world activation supports constant, keyword, and selective logic', () => {
    const entries = activateWorldEntries([
        {
            uid: 1,
            comment: 'constant lore',
            content: 'The city never sleeps.',
            constant: true,
            order: 10,
        },
        {
            uid: 2,
            comment: 'keyword lore',
            content: 'The station has old doors.',
            key: ['station'],
            order: 20,
        },
        {
            uid: 3,
            comment: 'selective lore',
            content: 'The vault opens only during rain.',
            key: ['vault'],
            keysecondary: ['rain'],
            selectiveLogic: XBTavernSelectiveLogic.AND_ALL,
            order: 30,
        },
        {
            uid: 4,
            comment: 'disabled lore',
            content: 'Disabled.',
            key: ['station'],
            disable: true,
            order: 40,
        },
    ], {
        scanText: 'The player reaches the station. The vault is quiet.',
    });

    assert.deepEqual(entries.map((entry) => entry.uid), [2, 1]);
});

test('xb tavern world activation honors decorator activation and suppression', () => {
    const entries = activateWorldEntries([
        {
            uid: 'forced',
            content: '@@activate\nForced lore.',
        },
        {
            uid: 'suppressed',
            content: '@@dont_activate\nSuppressed lore.',
            constant: true,
        },
    ], {
        scanText: '',
    });

    assert.deepEqual(entries.map((entry) => entry.uid), ['forced']);
    assert.equal(entries[0].content, 'Forced lore.');
});

test('xb tavern world activation supports recursion, budget, probability and sticky gates', () => {
    const entries = activateWorldEntries([
        {
            uid: 'first',
            content: 'Hidden relay keyword.',
            key: ['station'],
            order: 10,
        },
        {
            uid: 'recursive',
            content: 'Recursive lore.',
            key: ['relay'],
            order: 9,
        },
        {
            uid: 'sticky',
            content: 'Sticky lore.',
            key: ['missing'],
            order: 8,
        },
        {
            uid: 'blocked',
            content: 'Blocked lore.',
            key: ['station'],
            probability: 0,
            order: 7,
        },
    ], {
        scanText: 'station',
        recursion: true,
        recursionLimit: 3,
        turn: 5,
        budgetChars: 80,
        entryStates: {
            sticky: { stickyUntilTurn: 8 },
        },
    });

    assert.deepEqual(entries.map((entry) => entry.uid), ['first', 'recursive', 'sticky']);
});

test('xb tavern assembler exposes world candidate explanations', () => {
    const result = buildXbTavernMessages({
        worldBooks: [{
            name: 'DebugWorld',
            entries: [
                {
                    uid: 'hit',
                    comment: 'hit lore',
                    content: 'Hit lore.',
                    key: ['station'],
                    order: 20,
                },
                {
                    uid: 'miss',
                    comment: 'miss lore',
                    content: 'Miss lore.',
                    key: ['moon'],
                    order: 10,
                },
            ],
        }],
    }, {
    }, {
        currentUserMessage: 'The station door opens.',
    });

    const hit = result.worldEntryCandidates.find((entry) => entry.uid === 'hit');
    const miss = result.worldEntryCandidates.find((entry) => entry.uid === 'miss');
    assert.equal(hit?.sourceWorldBook, 'DebugWorld');
    assert.equal(hit?.status, 'activated');
    assert.equal(hit?.activationReason, 'keyword');
    assert.equal(hit?.positionLabel, 'after character');
    assert.equal(miss?.status, 'not_matched');
    assert.equal(result.activatedWorldEntries[0].sourceWorldBook, 'DebugWorld');
});

test('xb tavern assembler exposes world budget and insertion debug metadata', () => {
    const result = buildXbTavernMessages({
        worldBooks: [{
            name: 'BudgetWorld',
            entries: [
                {
                    uid: 'large',
                    comment: 'large lore',
                    content: 'Large lore costs many chars.',
                    constant: true,
                    order: 20,
                    position: XBTavernWorldPosition.before,
                },
                {
                    uid: 'small',
                    comment: 'small lore',
                    content: 'Small.',
                    constant: true,
                    order: 10,
                    position: XBTavernWorldPosition.atDepth,
                    depth: 1,
                },
            ],
        }],
    }, {
    }, {
        currentUserMessage: 'Hello.',
        worldSettings: {
            budgetChars: 12,
        },
    });

    const large = result.worldEntryCandidates.find((entry) => entry.uid === 'large');
    const small = result.worldEntryCandidates.find((entry) => entry.uid === 'small');
    assert.equal(large?.status, 'budget_skipped');
    assert.equal(large?.budgetShortfall, 'Large lore costs many chars.'.length - 12);
    assert.equal(large?.insertionTarget, 'before character card');
    assert.equal(small?.status, 'activated');
    assert.equal(small?.insertionTarget, 'history depth 1');
    assert.equal(result.meta.worldBudget.enabled, true);
    assert.equal(result.meta.worldBudget.limit, 12);
    assert.equal(result.meta.worldBudget.used, 'Small.'.length);
    assert.equal(result.meta.worldPositionCounts['history depth 1'], 1);
    assert.equal(result.activatedWorldEntries.map((entry) => entry.uid).includes('large'), false);
});

test('xb tavern assembler distinguishes probability failures from budget skips', () => {
    const result = buildXbTavernMessages({
        worldBooks: [{
            name: 'ProbabilityWorld',
            entries: [
                {
                    uid: 'blocked',
                    comment: 'blocked probability',
                    content: 'Blocked by probability.',
                    constant: true,
                    probability: 0,
                    order: 10,
                },
            ],
        }],
    }, {
    }, {
        currentUserMessage: 'Hello.',
        worldSettings: {
            budgetChars: 100,
        },
    });

    assert.equal(result.activatedWorldEntries.length, 0);
    assert.equal(result.worldEntryCandidates[0]?.status, 'probability_failed');
    assert.equal(result.worldEntryCandidates[0]?.activationReason, 'constant');
});

test('xb tavern world candidate matrix explains every activation and skip gate', () => {
    const result = buildXbTavernMessages({
        worldBooks: [{
            name: 'MatrixWorld',
            entries: [
                {
                    uid: 'forced-budget',
                    comment: 'forced but too large',
                    content: '@@activate\nThis forced entry is intentionally too long for the tiny test budget.',
                    order: 100,
                    position: XBTavernWorldPosition.before,
                },
                {
                    uid: 'active',
                    comment: 'active keyword',
                    content: 'Active.',
                    key: ['station'],
                    order: 90,
                    position: XBTavernWorldPosition.after,
                },
                {
                    uid: 'disabled',
                    content: 'Disabled.',
                    constant: true,
                    disable: true,
                },
                {
                    uid: 'suppressed',
                    content: '@@dont_activate\nSuppressed.',
                    constant: true,
                },
                {
                    uid: 'cooldown',
                    content: 'Cooling.',
                    constant: true,
                },
                {
                    uid: 'delay',
                    content: 'Delayed.',
                    constant: true,
                },
                {
                    uid: 'miss',
                    content: 'Miss.',
                    key: ['moon'],
                },
                {
                    uid: 'secondary',
                    content: 'Secondary miss.',
                    key: ['station'],
                    keysecondary: ['rain'],
                    selective: true,
                    selectiveLogic: XBTavernSelectiveLogic.AND_ALL,
                },
                {
                    uid: 'probability',
                    content: 'Probability miss.',
                    constant: true,
                    probability: 50,
                    useProbability: true,
                },
            ],
        }],
    }, {
    }, {
        currentUserMessage: 'The station opens.',
        worldSettings: {
            turn: 5,
            budgetChars: 20,
            random: () => 1,
            entryStates: {
                'MatrixWorld\u0000cooldown': { cooldownUntilTurn: 9 },
                'MatrixWorld\u0000delay': { delayUntilTurn: 9 },
            },
        },
    });

    const byUid = Object.fromEntries(result.worldEntryCandidates.map((entry) => [entry.uid, entry]));
    assert.equal(byUid['forced-budget']?.status, 'budget_skipped');
    assert.equal(byUid['forced-budget']?.activationReason, 'decorator');
    assert.equal(byUid['forced-budget']?.budgetUsedBefore, 0);
    assert.equal(typeof byUid['forced-budget']?.budgetShortfall, 'number');
    assert.equal(byUid['forced-budget']?.insertionTarget, 'before character card');
    assert.equal(byUid.active?.status, 'activated');
    assert.equal(byUid.active?.activationReason, 'keyword');
    assert.equal(byUid.active?.sourceWorldBook, 'MatrixWorld');
    assert.equal(byUid.active?.positionLabel, 'after character');
    assert.equal(byUid.disabled?.status, 'disabled');
    assert.equal(byUid.suppressed?.status, 'suppressed_by_decorator');
    assert.equal(byUid.cooldown?.status, 'cooldown');
    assert.equal(byUid.delay?.status, 'delay');
    assert.equal(byUid.miss?.status, 'not_matched');
    assert.equal(byUid.secondary?.status, 'secondary_not_matched');
    assert.equal(byUid.probability?.status, 'probability_failed');
    assert.deepEqual(result.activatedWorldEntries.map((entry) => entry.uid), ['active']);
    assert.equal(result.meta.worldBudget.skippedChars, byUid['forced-budget']?.contentChars);
});

test('xb tavern world activation follows SillyTavern sticky, selective and decorator precedence', () => {
    const result = buildXbTavernMessages({
        worldBooks: [{
            name: 'SemanticsWorld',
            entries: [
                {
                    uid: 'selective-off',
                    content: 'Secondary keys ignored when selective is false.',
                    key: ['station'],
                    keysecondary: ['rain'],
                    selective: false,
                    order: 30,
                },
                {
                    uid: 'sticky-over-cooldown',
                    content: 'Sticky survives cooldown and probability.',
                    key: ['missing'],
                    probability: 0,
                    order: 20,
                },
                {
                    uid: 'decorator-duel',
                    content: '@@activate\n@@dont_activate\nActivate wins if both decorators exist.',
                    order: 10,
                },
            ],
        }],
    }, {
    }, {
        currentUserMessage: 'The station opens.',
        worldSettings: {
            turn: 4,
            entryStates: {
                'SemanticsWorld\u0000sticky-over-cooldown': {
                    stickyUntilTurn: 8,
                    cooldownUntilTurn: 8,
                },
            },
        },
    });

    const byUid = Object.fromEntries(result.worldEntryCandidates.map((entry) => [entry.uid, entry]));
    assert.equal(byUid['selective-off']?.status, 'activated');
    assert.equal(byUid['selective-off']?.activationReason, 'keyword');
    assert.equal(byUid['sticky-over-cooldown']?.status, 'activated');
    assert.equal(byUid['sticky-over-cooldown']?.activationReason, 'sticky');
    assert.equal(byUid['decorator-duel']?.status, 'activated');
    assert.equal(byUid['decorator-duel']?.activationReason, 'decorator');
    assert.deepEqual(result.activatedWorldEntries.map((entry) => entry.uid), [
        'selective-off',
        'sticky-over-cooldown',
        'decorator-duel',
    ]);
});

test('xb tavern world recursion respects the configured recursion limit', () => {
    const entries = activateWorldEntries([
        {
            uid: 'first',
            content: 'relay',
            key: ['station'],
            order: 30,
        },
        {
            uid: 'second',
            content: 'beacon',
            key: ['relay'],
            order: 20,
        },
        {
            uid: 'third',
            content: 'final',
            key: ['beacon'],
            order: 10,
        },
    ], {
        scanText: 'station',
        recursion: true,
        recursionLimit: 2,
    });

    assert.deepEqual(entries.map((entry) => entry.uid), ['first', 'second']);
});

test('xb tavern world activation honors case, whole-word, cooldown, delay, and state updates', () => {
    const entries = activateWorldEntries([
        {
            uid: 'case',
            content: 'Case-sensitive lore.',
            key: ['Vault'],
            caseSensitive: true,
        },
        {
            uid: 'whole',
            content: 'Whole-word lore.',
            key: ['cat'],
            matchWholeWords: true,
        },
        {
            uid: 'cooling',
            content: 'Cooling lore.',
            constant: true,
        },
        {
            uid: 'delayed',
            content: 'Delayed lore.',
            constant: true,
            delay: 5,
        },
    ], {
        scanText: 'Vault cat catalog',
        turn: 3,
        entryStates: {
            cooling: { cooldownUntilTurn: 9 },
        },
    });

    assert.deepEqual(entries.map((entry) => entry.uid), ['case', 'whole']);

    const result = buildXbTavernMessages({
        worldEntries: [
            { uid: 'sticky', content: 'Sticky next.', constant: true, sticky: 2 },
            { uid: 'cooldown', content: 'Cooldown next.', constant: true, cooldown: 3 },
        ],
    }, {
    }, {
        currentUserMessage: 'Hello.',
        worldSettings: { turn: 4 },
    });

    assert.deepEqual(result.meta.worldEntryStateUpdates['direct\u0000sticky'], { stickyUntilTurn: 6 });
    assert.deepEqual(result.meta.worldEntryStateUpdates['direct\u0000cooldown'], { cooldownUntilTurn: 7 });
});

test('xb tavern world entry states are keyed by activation key across world books', () => {
    const result = buildXbTavernMessages({
        worldBooks: [
            {
                name: 'Alpha',
                entries: [{ uid: 'shared', content: 'Alpha lore.', constant: true, cooldown: 2 }],
            },
            {
                name: 'Beta',
                entries: [{ uid: 'shared', content: 'Beta lore.', constant: true, cooldown: 4 }],
            },
        ],
    }, {
    }, {
        currentUserMessage: 'Hello.',
        worldSettings: { turn: 10 },
    });

    assert.deepEqual(result.meta.worldEntryStateUpdates['Alpha\u0000shared'], { cooldownUntilTurn: 12 });
    assert.deepEqual(result.meta.worldEntryStateUpdates['Beta\u0000shared'], { cooldownUntilTurn: 14 });
});

test('xb tavern assembler does not double count flattened world entries when world books exist', () => {
    const entry = {
        uid: 'same',
        content: 'Same lore.',
        constant: true,
    };
    const result = buildXbTavernMessages({
        worldBooks: [{ name: 'BookA', entries: [entry] }],
        worldEntries: [entry],
    }, {
    }, {
        currentUserMessage: 'Hello.',
    });

    assert.equal(result.worldEntryCandidates.length, 1);
    assert.equal(result.activatedWorldEntries.length, 1);
});

test('xb tavern assembler deduplicates repeated entries from the same world book', () => {
    const result = buildXbTavernMessages({
        worldBooks: [
            {
                name: 'BookA',
                entries: [
                    { uid: 'same', content: 'Same lore.', constant: true },
                    { uid: 'same', content: 'Same lore.', constant: true },
                    { content: 'No uid lore.', key: ['station'] },
                    { content: 'No uid lore.', key: ['station'] },
                ],
            },
            {
                name: 'BookA',
                entries: [
                    { uid: 'same', content: 'Same lore.', constant: true },
                ],
            },
        ],
    }, {
    }, {
        currentUserMessage: 'station',
    });

    assert.equal(result.worldEntryCandidates.length, 2);
    assert.equal(result.activatedWorldEntries.length, 2);
    assert.deepEqual(result.worldEntryCandidates.map((entry) => entry.content).sort(), ['No uid lore.', 'Same lore.']);
});

test('xb tavern assembler keeps same uid entries separate across world books', () => {
    const result = buildXbTavernMessages({
        worldBooks: [
            {
                name: 'BookA',
                entries: [{ uid: 1, content: 'Book A lore.', constant: true, order: 2 }],
            },
            {
                name: 'BookB',
                entries: [{ uid: 1, content: 'Book B lore.', constant: true, order: 1 }],
            },
        ],
    }, {
    }, {
        currentUserMessage: 'Hello.',
    });

    assert.equal(result.activatedWorldEntries.length, 2);
    assert.deepEqual(result.activatedWorldEntries.map((entry) => entry.sourceWorldBook), ['BookA', 'BookB']);
    assert.equal(new Set(result.worldEntryCandidates.map((entry) => entry.activationKey)).size, 2);
    assert.deepEqual(result.worldEntryCandidates.map((entry) => entry.status), ['activated', 'activated']);
});

test('xb tavern assembler maps world positions into stable message locations', () => {
    const result = buildXbTavernMessages({
        character: {
            name: 'Aster',
            description: 'Pilot.',
        },
        user: {
            name: 'Player',
        },
        history: [
            { role: 'user', content: 'We enter the station.' },
            { role: 'assistant', content: 'Aster checks the lights.' },
        ],
        worldEntries: [
            {
                uid: 'before',
                content: 'Before character lore.',
                constant: true,
                position: XBTavernWorldPosition.before,
            },
            {
                uid: 'after',
                content: 'After character lore.',
                constant: true,
                position: XBTavernWorldPosition.after,
            },
            {
                uid: 'depth',
                content: 'Depth lore.',
                constant: true,
                position: XBTavernWorldPosition.atDepth,
                depth: 0,
                role: 'system',
            },
            {
                uid: 'outlet',
                content: 'Outlet lore.',
                constant: true,
                position: XBTavernWorldPosition.outlet,
                outletName: 'status',
            },
            {
                uid: 'author-note',
                content: 'Author note lore.',
                constant: true,
                position: XBTavernWorldPosition.ANTop,
            },
            {
                uid: 'example-message',
                content: 'Example message lore.',
                constant: true,
                position: XBTavernWorldPosition.EMBottom,
            },
        ],
    }, {
    }, {
        currentUserMessage: 'Look at the vault.',
        historyMode: 'raw',
    });

    const contents = result.messages.map((message) => message.content);
    assert.equal(contents.indexOf('<world_info_before_character>\nBefore character lore.\n</world_info_before_character>') < contents.findIndex((content) => content.includes('<character_card>')), true);
    assert.equal(contents.indexOf('<world_info_after_character>\nAfter character lore.\n</world_info_after_character>') > contents.findIndex((content) => content.includes('<character_card>')), true);
    assert.deepEqual(result.outlets, { status: 'Outlet lore.' });
    assert.equal(contents.includes('<world_info_author_note_top>\nAuthor note lore.\n</world_info_author_note_top>'), true);
    assert.equal(contents.includes('<world_info_examples_bottom>\nExample message lore.\n</world_info_examples_bottom>'), true);
    assert.equal(contents.includes('Look at the vault.'), true);
    assert.equal(contents.includes('<world_info_depth depth="0">\nDepth lore.\n</world_info_depth>'), true);
});

test('xb tavern build snapshot summarizes context, preset, world activation, and raw messages', () => {
    const context = {
        character: { id: 'char-1', name: 'Aster' },
        user: { name: 'Player' },
        history: [{ role: 'user' as const, content: 'Earlier.' }],
        worldBooks: [{
            name: 'Lore',
            entries: [{ uid: 'lore', content: 'Lore text.', constant: true }],
        }],
    };
    const preset = {
        id: 'preset-1',
        name: 'Preset One',
    };
    const result = buildXbTavernMessages(context, preset, {
        currentUserMessage: 'Now.',
    });
    const snapshot = createXbTavernBuildSnapshot(context, preset, result, { ok: true });

    assert.equal(snapshot.presetId, 'preset-1');
    assert.equal(snapshot.characterName, 'Aster');
    assert.equal(snapshot.historyCount, 1);
    assert.deepEqual(snapshot.worldBooks, [{ name: 'Lore', entries: 1 }]);
    assert.equal(snapshot.messageCount, result.messages.length);
    assert.equal(snapshot.rawMessagesJson, result.meta.rawMessagesJson);
    assert.equal(snapshot.activatedWorldEntries[0]?.sourceWorldBook, 'Lore');
    assert.deepEqual(snapshot.diagnostics, { ok: true });
});

test('xb tavern assembler can squash chat history like a controlled preset layer', () => {
    const squashed = squashChatHistory([
        { role: 'user', content: 'Open the door.' },
        { role: 'assistant', content: 'The door opens.' },
    ], {
        role: 'assistant',
        userName: 'Mira',
        characterName: 'Aster',
    });

    assert.deepEqual(squashed, [{
        role: 'assistant',
        content: 'Mira: Open the door.\n\nAster: The door opens.',
    }]);
});

test('xb tavern assembler supports preset placements around history', () => {
    const result = buildXbTavernMessages({
        history: [{ role: 'user', content: 'Previous turn.' }],
    }, {
        sections: [
            { placement: 'beforeHistory', role: 'system', content: 'Before history rule.' },
            { placement: 'afterHistory', role: 'system', content: 'After history rule.' },
            { placement: 'assistantPrefill', role: 'assistant', content: 'Aster whispers:' },
        ],
    }, {
        currentUserMessage: 'Current turn.',
    });

    const contents = result.messages.map((message) => message.content);
    assert.equal(contents.includes('Before history rule.'), true);
    assert.equal(contents.includes('After history rule.'), true);
    assert.equal(result.messages[result.messages.length - 1].role, 'assistant');
    assert.equal(result.messages[result.messages.length - 1].content, 'Aster whispers:');
});

test('xb tavern preset sections preserve placement order without leaking debug metadata', () => {
    const result = buildXbTavernMessages({
        character: { name: 'Aster', description: 'Pilot.' },
        history: [{ role: 'assistant', content: 'Earlier.' }],
    }, {
        sections: [
            { id: 'top-a', label: 'Top A', placement: 'top', role: 'system', content: 'Top A content.' },
            { id: 'top-b', label: 'Top B', placement: 'top', role: 'system', content: 'Top B content.' },
            { id: 'before-char', label: 'Before Character', placement: 'beforeCharacter', role: 'system', content: 'Before character content.' },
            { id: 'after-char', label: 'After Character', placement: 'afterCharacter', role: 'system', content: 'After character content.' },
            { id: 'before-history', label: 'Before History', placement: 'beforeHistory', role: 'system', content: 'Before history content.' },
            { id: 'after-history', label: 'After History', placement: 'afterHistory', role: 'system', content: 'After history content.' },
            { id: 'prefill', label: 'Prefill', placement: 'assistantPrefill', role: 'assistant', content: 'Aster:' },
        ],
    }, {
        currentUserMessage: 'Now.',
    });

    const contents = result.messages.map((message) => message.content);
    assert.deepEqual(contents.slice(0, 2), ['Top A content.', 'Top B content.']);
    assert.equal(contents.indexOf('Before character content.') < contents.findIndex((content) => content.includes('<character_card>')), true);
    assert.equal(contents.indexOf('After character content.') > contents.findIndex((content) => content.includes('<character_card>')), true);
    assert.equal(contents.indexOf('Before history content.') < contents.indexOf('Now.'), true);
    assert.equal(contents.indexOf('After history content.') > contents.indexOf('Now.'), true);
    assert.equal(contents[contents.length - 1], 'Aster:');
    assert.deepEqual(JSON.parse(result.meta.rawMessagesJson), result.messages);
    assert.equal(result.messages.some((message) => message.content.includes('Before Character')), false);
    assert.equal(result.messageLayers.some((layer) => layer.label === 'Before Character'), true);
});
