import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

const { createSessionStore } = await import('../app-src/state/session-store.js');
const {
    default: db,
    messagesTable,
    sessionsTable,
} = await import('../shared/session-db.js');
const { createPlanLedger } = await import('../shared/plan-ledger.js');

async function resetDb() {
    await db.delete();
    await db.open();
}

function createState() {
    return {
        assistantSessionId: '',
        messages: [],
        historySummary: '',
        archivedTurnCount: 0,
        sidebarCollapsed: true,
        localSources: [],
        isWorkspaceOpen: false,
        workspaceWidth: 520,
        workspacePanelMode: 'workspace',
        selectedSourceId: 'all',
        selectedFilePath: '',
        selectedTreePath: '',
        selectedSkillFilePath: '',
        fileSearchQuery: '',
        showModifiedOnly: false,
        viewerMode: 'current',
        mobileWorkspacePane: 'tree',
        treeExpandedKeys: [],
        skillTreeExpandedKeys: [],
    };
}

function createStore(state) {
    return createSessionStore({
        state,
        createRequestId: () => 'tool-restored',
        normalizeAttachments: (attachments) => Array.isArray(attachments) ? attachments : [],
        normalizeThoughtBlocks: (thoughts) => Array.isArray(thoughts) ? thoughts : [],
        getActiveContextMessages: () => state.messages,
    });
}

test('session store keeps legacy default session on first restore', async () => {
    await resetDb();
    await sessionsTable.put({
        id: 'default',
        updatedAt: 1,
        historySummary: 'legacy summary',
    });
    await messagesTable.put({
        sessionId: 'default',
        order: 0,
        role: 'user',
        content: 'hello',
        attachments: [],
        thoughts: [],
    });

    const state = createState();
    const store = createStore(state);
    await store.restoreSession();

    assert.equal(state.assistantSessionId, 'default');
    assert.equal(state.historySummary, 'legacy summary');
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].content, 'hello');
});

test('clearSession rotates assistantSessionId and clears old plans', async () => {
    await resetDb();
    const state = createState();
    const store = createStore(state);
    const ledger = createPlanLedger({
        createId: () => 'plan-old',
        now: () => 100,
    });

    await store.restoreSession();
    const oldSessionId = state.assistantSessionId;
    state.messages = [{ role: 'user', content: 'keep until clear' }];
    await store.persistSession();
    await ledger.createPlan(oldSessionId, { title: 'old plan' });

    const result = await store.clearSession();
    assert.equal(result.ok, true);
    assert.notEqual(state.assistantSessionId, oldSessionId);
    assert.equal(await messagesTable.where('sessionId').equals(oldSessionId).count(), 0);

    const oldPlans = await ledger.listPlans(oldSessionId);
    assert.equal(oldPlans.count, 0);
});
