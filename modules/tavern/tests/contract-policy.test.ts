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
    assert.equal(memoryOnly.includeRandomEncounters, false);
    assert.equal(memoryOnly.hasAutomaticManagerWork, true);
    assert.deepEqual(memoryOnly.managerPromptOptions, {
        includeMemory: true,
        includeCartography: false,
    });

    const mapOnly = resolveTavernSessionContractRuntime(mergeTavernSessionContract(undefined, {
        memoryArchiving: false,
        cartographyEngine: true,
    }));
    assert.equal(mapOnly.includeMemoryFiles, false);
    assert.equal(mapOnly.includeStructuredStates, true);
    assert.equal(mapOnly.includeRandomEncounters, false);
    assert.equal(mapOnly.hasAutomaticManagerWork, true);
    assert.deepEqual(mapOnly.managerPromptOptions, {
        includeMemory: false,
        includeCartography: true,
    });

    const disabled = resolveTavernSessionContractRuntime(mergeTavernSessionContract(undefined, {
        memoryArchiving: false,
        cartographyEngine: false,
    }));
    assert.equal(disabled.includeMemoryFiles, false);
    assert.equal(disabled.includeStructuredStates, false);
    assert.equal(disabled.includeRandomEncounters, false);
    assert.equal(disabled.hasAutomaticManagerWork, false);
    assert.deepEqual(disabled.managerPromptOptions, {
        includeMemory: false,
        includeCartography: false,
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
    assert.equal(reservedOnly.includeRandomEncounters, true);
    assert.equal(reservedOnly.hasAutomaticManagerWork, false);
});

test('tavern auto manager tool policy keeps ChatHistory and module-specific tools only', () => {
    const memoryOnly = resolveTavernAutoManagerToolPolicy(mergeTavernSessionContract(undefined, {
        memoryArchiving: true,
        cartographyEngine: false,
    }));
    assert.equal(memoryOnly.allowedToolNames.includes('ChatHistory'), true);
    assert.equal(memoryOnly.allowedToolNames.includes('MemoryWrite'), true);
    assert.equal(memoryOnly.allowedToolNames.includes('StateRead'), false);
    assert.equal(memoryOnly.deniedToolNames.includes('StatePatch'), true);

    const mapOnly = resolveTavernAutoManagerToolPolicy(mergeTavernSessionContract(undefined, {
        memoryArchiving: false,
        cartographyEngine: true,
    }));
    assert.equal(mapOnly.allowedToolNames.includes('ChatHistory'), true);
    assert.equal(mapOnly.allowedToolNames.includes('StatePatch'), true);
    assert.equal(mapOnly.allowedToolNames.includes('MemoryWrite'), false);
    assert.equal(mapOnly.deniedToolNames.includes('MemoryRead'), true);

    const disabled = resolveTavernAutoManagerToolPolicy(mergeTavernSessionContract(undefined, {
        memoryArchiving: false,
        cartographyEngine: false,
    }));
    assert.deepEqual(disabled.allowedToolNames, ['ChatHistory']);
    assert.equal(isAutoManagerToolAllowed('MemoryWrite', disabled.runtime.contract), false);
    assert.equal(isAutoManagerToolAllowed('StatePatch', disabled.runtime.contract), false);

    const memoryDenied = buildDeniedAutoManagerToolResult('MemoryWrite', disabled.runtime.contract);
    assert.equal(memoryDenied.ok, false);
    assert.match(memoryDenied.summary, /契约未授权 Memory Archiving/);

    const stateDenied = buildDeniedAutoManagerToolResult('StatePatch', disabled.runtime.contract);
    assert.equal(stateDenied.ok, false);
    assert.match(stateDenied.summary, /契约未授权 Cartography Engine/);
});
