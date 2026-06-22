import test from 'node:test';
import assert from 'node:assert/strict';

import {
    mergeTavernSessionContract,
    resolveTavernSessionContractRuntime,
} from '../shared/session-contract';
import {
    buildDeniedAutoManagerToolResult,
    isAutoManagerToolAllowed,
    resolveTavernAutoManagerToolPolicy,
} from '../app-src/runtime/contract-policy';

test('tavern contract runtime resolves module capabilities without leaking reserved toggles', () => {
    const memoryOnly = resolveTavernSessionContractRuntime(mergeTavernSessionContract(undefined, {
        memoryArchiving: true,
        cartographyEngine: false,
    }));
    assert.equal(memoryOnly.includeMemoryFiles, true);
    assert.equal(memoryOnly.includeStructuredStates, false);
    assert.equal(memoryOnly.includeActionChecks, true);
    assert.equal(memoryOnly.includeRandomEncounters, true);
    assert.equal(memoryOnly.hasAutomaticManagerWork, true);
    assert.deepEqual(memoryOnly.managerPromptOptions, {
        includeMemory: true,
        includeCartography: false,
        includeQuestOrchestration: false,
    });

    const mapOnly = resolveTavernSessionContractRuntime(mergeTavernSessionContract(undefined, {
        memoryArchiving: false,
        cartographyEngine: true,
    }));
    assert.equal(mapOnly.includeMemoryFiles, false);
    assert.equal(mapOnly.includeStructuredStates, true);
    assert.equal(mapOnly.includeActionChecks, true);
    assert.equal(mapOnly.includeRandomEncounters, true);
    assert.equal(mapOnly.hasAutomaticManagerWork, true);
    assert.deepEqual(mapOnly.managerPromptOptions, {
        includeMemory: false,
        includeCartography: true,
        includeQuestOrchestration: false,
    });

    const disabled = resolveTavernSessionContractRuntime(mergeTavernSessionContract(undefined, {
        memoryArchiving: false,
        cartographyEngine: false,
    }));
    assert.equal(disabled.includeMemoryFiles, false);
    assert.equal(disabled.includeStructuredStates, false);
    assert.equal(disabled.includeActionChecks, true);
    assert.equal(disabled.includeRandomEncounters, true);
    assert.equal(disabled.hasAutomaticManagerWork, false);
    assert.deepEqual(disabled.managerPromptOptions, {
        includeMemory: false,
        includeCartography: false,
        includeQuestOrchestration: false,
    });

    const reservedOnly = resolveTavernSessionContractRuntime(mergeTavernSessionContract(undefined, {
        memoryArchiving: false,
        cartographyEngine: false,
        actionChecks: true,
        randomEncounters: true,
        questOrchestration: true,
    }));
    assert.equal(reservedOnly.includeMemoryFiles, false);
    assert.equal(reservedOnly.includeStructuredStates, false);
    assert.equal(reservedOnly.includeActionChecks, true);
    assert.equal(reservedOnly.includeRandomEncounters, true);
    assert.equal(reservedOnly.includeQuestOrchestration, true);
    assert.equal(reservedOnly.hasAutomaticManagerWork, true);
    assert.deepEqual(reservedOnly.managerPromptOptions, {
        includeMemory: false,
        includeCartography: false,
        includeQuestOrchestration: true,
    });
});

test('tavern auto manager tool policy keeps read tools and module-specific write tools only', () => {
    const memoryOnly = resolveTavernAutoManagerToolPolicy(mergeTavernSessionContract(undefined, {
        memoryArchiving: true,
        cartographyEngine: false,
    }));
    assert.equal(memoryOnly.allowedToolNames.includes('Read'), true);
    assert.equal(memoryOnly.allowedToolNames.includes('Grep'), true);
    assert.equal(memoryOnly.allowedToolNames.includes('Write'), true);
    assert.equal(memoryOnly.allowedToolNames.includes('MapInspect'), false);
    assert.equal(memoryOnly.allowedToolNames.includes('EventPatch'), false);
    assert.equal(memoryOnly.deniedToolNames.includes('MapPatch'), true);

    const mapOnly = resolveTavernAutoManagerToolPolicy(mergeTavernSessionContract(undefined, {
        memoryArchiving: false,
        cartographyEngine: true,
    }));
    assert.equal(mapOnly.allowedToolNames.includes('Read'), true);
    assert.equal(mapOnly.allowedToolNames.includes('MapPatch'), true);
    assert.equal(mapOnly.allowedToolNames.includes('EventPatch'), false);
    assert.equal(mapOnly.allowedToolNames.includes('Write'), false);
    assert.equal(mapOnly.deniedToolNames.includes('Edit'), true);

    const questOnly = resolveTavernAutoManagerToolPolicy(mergeTavernSessionContract(undefined, {
        memoryArchiving: false,
        cartographyEngine: false,
        questOrchestration: true,
    }));
    assert.equal(questOnly.allowedToolNames.includes('Read'), true);
    assert.equal(questOnly.allowedToolNames.includes('EventPatch'), true);
    assert.equal(questOnly.allowedToolNames.includes('Write'), false);
    assert.equal(questOnly.allowedToolNames.includes('MapPatch'), false);

    const disabled = resolveTavernAutoManagerToolPolicy(mergeTavernSessionContract(undefined, {
        memoryArchiving: false,
        cartographyEngine: false,
    }));
    assert.deepEqual(disabled.allowedToolNames, ['LS', 'Grep', 'Read']);
    assert.equal(isAutoManagerToolAllowed('Write', disabled.runtime.contract), false);
    assert.equal(isAutoManagerToolAllowed('MapPatch', disabled.runtime.contract), false);
    assert.equal(isAutoManagerToolAllowed('EventPatch', disabled.runtime.contract), false);
    assert.equal(isAutoManagerToolAllowed('Read', disabled.runtime.contract), true);

    const memoryDenied = buildDeniedAutoManagerToolResult('Write', disabled.runtime.contract);
    assert.equal(memoryDenied.ok, false);
    assert.match(memoryDenied.summary, /契约未授权 记忆存档/);

    const stateDenied = buildDeniedAutoManagerToolResult('MapPatch', disabled.runtime.contract);
    assert.equal(stateDenied.ok, false);
    assert.match(stateDenied.summary, /契约未授权 制图引擎/);

    const taskDenied = buildDeniedAutoManagerToolResult('EventPatch', disabled.runtime.contract);
    assert.equal(taskDenied.ok, false);
    assert.match(taskDenied.summary, /契约未授权 织线者/);
});
