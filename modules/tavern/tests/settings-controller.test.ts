import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, nextTick, ref } from 'vue';

import { normalizeTavernDisplaySettings } from '../shared/settings';
import { useTavernSettingsController, type TavernSettingsWorkspaceKey } from '../app-src/components/settings/useTavernSettingsController';

function flushAsyncState() {
    return new Promise((resolve) => {
        setTimeout(async () => {
            await nextTick();
            resolve(undefined);
        }, 0);
    });
}

test('display settings revert to the last committed values when host save fails', async () => {
    const activeView = ref('home');
    const activeSettingsWorkspace = ref<TavernSettingsWorkspaceKey>('base');
    const agentConfig = ref<Record<string, unknown>>({});
    const tavernDisplaySettings = ref(normalizeTavernDisplaySettings({
        hiddenOutsideCount: 5,
        loadBatchSize: 20,
    }));
    let rejectSave: ((reason?: unknown) => void) | null = null;
    const controller = useTavernSettingsController({
        activeView,
        activeSettingsWorkspace,
        agentConfig,
        tavernDisplaySettings,
        effectiveContext: computed(() => ({})),
        currentWorldbookNativeCharacterId: computed(() => ''),
        homeThemeDark: ref(false),
        isRunning: ref(false),
        confirmDialog: async () => true,
        describeError: (error) => error instanceof Error ? error.message : String(error || ''),
        postToHost: () => {},
        requestHost: async (type) => {
            if (type !== 'xb-tavern:save-display-settings') {
                return {};
            }
            return await new Promise<Record<string, unknown>>((_resolve, reject) => {
                rejectSave = reject;
            });
        },
        shortText: (value = '') => String(value || ''),
    });

    controller.settingsContext.stepHiddenOutsideCount(1);
    assert.equal(controller.settingsContext.displaySettings.value.hiddenOutsideCount, 6);
    assert.equal(tavernDisplaySettings.value.hiddenOutsideCount, 6);

    rejectSave?.(new Error('save failed'));
    await flushAsyncState();

    assert.equal(controller.settingsContext.displaySettings.value.hiddenOutsideCount, 5);
    assert.equal(tavernDisplaySettings.value.hiddenOutsideCount, 5);
    assert.equal(controller.settingsContext.baseSettingsSaving.value, false);
    assert.equal(controller.settingsContext.baseSettingsStatus.value, 'save failed');
});

test('runtime chat preset follows the LittleWhiteBox selected preset state', async () => {
    const activeView = ref('chat');
    const activeSettingsWorkspace = ref<TavernSettingsWorkspaceKey>('chatPreset');
    const agentConfig = ref<Record<string, unknown>>({});
    const tavernDisplaySettings = ref(normalizeTavernDisplaySettings({}));
    const controller = useTavernSettingsController({
        activeView,
        activeSettingsWorkspace,
        agentConfig,
        tavernDisplaySettings,
        effectiveContext: computed(() => ({})),
        currentWorldbookNativeCharacterId: computed(() => ''),
        homeThemeDark: ref(false),
        isRunning: ref(false),
        confirmDialog: async () => true,
        describeError: (error) => error instanceof Error ? error.message : String(error || ''),
        postToHost: () => {},
        requestHost: async (type, payload = {}) => {
            if (type === 'xb-tavern:select-chat-preset') {
                const source = payload.payload as Record<string, unknown>;
                const name = String(source.promptManagerName || 'Preset B');
                return {
                    result: {
                        id: name,
                        name,
                        source: 'sillytavern',
                        promptManager: {
                            name,
                            prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'B MAIN' }],
                            promptOrder: [{ character_id: '0', order: [{ identifier: 'main', enabled: true }] }],
                            activeCharacterId: '0',
                            activeOrder: [{ identifier: 'main', enabled: true }],
                        },
                        sections: [],
                    },
                };
            }
            return {};
        },
        shortText: (value = '') => String(value || ''),
    });

    await controller.settingsContext.selectChatPresetFromHost('Preset B');

    assert.equal(controller.runtimeChatPreset.value.name, 'Preset B');
    assert.equal(controller.runtimeChatPreset.value.promptManager?.name, 'Preset B');
    assert.equal(
        String((controller.runtimeChatPreset.value.promptManager?.prompts as Array<Record<string, unknown>>)[0]?.content || ''),
        'B MAIN',
    );
});

test('runtime chat preset ignores unsaved editor draft and tracks synced ST active preset', async () => {
    const activeView = ref('settings');
    const activeSettingsWorkspace = ref<TavernSettingsWorkspaceKey>('chatPreset');
    const agentConfig = ref<Record<string, unknown>>({});
    const tavernDisplaySettings = ref(normalizeTavernDisplaySettings({}));
    const controller = useTavernSettingsController({
        activeView,
        activeSettingsWorkspace,
        agentConfig,
        tavernDisplaySettings,
        effectiveContext: computed(() => ({})),
        currentWorldbookNativeCharacterId: computed(() => ''),
        homeThemeDark: ref(false),
        isRunning: ref(false),
        confirmDialog: async () => true,
        describeError: (error) => error instanceof Error ? error.message : String(error || ''),
        postToHost: () => {},
        requestHost: async (type) => {
            if (type === 'xb-tavern:list-chat-presets') {
                return {
                    result: {
                        active: {
                            id: 'Preset B',
                            name: 'Preset B',
                            source: 'sillytavern',
                            promptManager: {
                                name: 'Preset B',
                                prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'B MAIN' }],
                                promptOrder: [{ character_id: '0', order: [{ identifier: 'main', enabled: true }] }],
                                activeCharacterId: '0',
                                activeOrder: [{ identifier: 'main', enabled: true }],
                            },
                            sections: [],
                        },
                        components: { promptManager: ['Preset A', 'Preset B'] },
                    },
                };
            }
            return {};
        },
        shortText: (value = '') => String(value || ''),
    });

    controller.applyHostChatPreset({
        chatPreset: {
            id: 'Preset A',
            name: 'Preset A',
            source: 'sillytavern',
            promptManager: {
                name: 'Preset A',
                prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'A MAIN' }],
                promptOrder: [{ character_id: '0', order: [{ identifier: 'main', enabled: true }] }],
                activeCharacterId: '0',
                activeOrder: [{ identifier: 'main', enabled: true }],
            },
            sections: [],
        },
    });
    controller.settingsContext.updatePromptByIdentifier('main', { content: 'UNSAVED DRAFT' });

    assert.equal(
        String((controller.runtimeChatPreset.value.promptManager?.prompts as Array<Record<string, unknown>>)[0]?.content || ''),
        'A MAIN',
    );

    await controller.settingsContext.syncChatPresetFromHost();

    assert.equal(controller.runtimeChatPreset.value.name, 'Preset B');
    assert.equal(
        String((controller.runtimeChatPreset.value.promptManager?.prompts as Array<Record<string, unknown>>)[0]?.content || ''),
        'B MAIN',
    );
    assert.equal(
        String((controller.settingsContext.preset.value.promptManager?.prompts as Array<Record<string, unknown>>)[0]?.content || ''),
        'UNSAVED DRAFT',
    );
});

test('chat preset save feedback stays on the save button instead of the status banner', async () => {
    const activeView = ref('settings');
    const activeSettingsWorkspace = ref<TavernSettingsWorkspaceKey>('chatPreset');
    const agentConfig = ref<Record<string, unknown>>({});
    const tavernDisplaySettings = ref(normalizeTavernDisplaySettings({}));
    const controller = useTavernSettingsController({
        activeView,
        activeSettingsWorkspace,
        agentConfig,
        tavernDisplaySettings,
        effectiveContext: computed(() => ({})),
        currentWorldbookNativeCharacterId: computed(() => ''),
        homeThemeDark: ref(false),
        isRunning: ref(false),
        confirmDialog: async () => true,
        describeError: (error) => error instanceof Error ? error.message : String(error || ''),
        postToHost: () => {},
        requestHost: async (type) => {
            if (type === 'xb-tavern:save-chat-preset') {
                return { ok: false, error: 'host refused save' };
            }
            return {};
        },
        shortText: (value = '') => String(value || ''),
    });

    controller.applyHostChatPreset({
        chatPreset: {
            id: 'Preset A',
            name: 'Preset A',
            source: 'sillytavern',
            promptManager: {
                name: 'Preset A',
                rawPreset: {
                    prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'A MAIN' }],
                    prompt_order: [{ character_id: 'char-1', order: [{ identifier: 'main', enabled: true }] }],
                },
                prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'A MAIN' }],
                promptOrder: [{ character_id: 'char-1', order: [{ identifier: 'main', enabled: true }] }],
                activeCharacterId: 'char-1',
                activeOrder: [{ identifier: 'main', enabled: true }],
            },
            sections: [],
        },
    });
    controller.settingsContext.updatePromptByIdentifier('main', { content: 'A MAIN edited' });

    await controller.settingsContext.saveCurrentPreset();

    assert.equal(controller.settingsContext.presetStatus.value, '');
    assert.equal(controller.settingsContext.presetSaveFeedback.value.status, 'error');
    assert.equal(controller.settingsContext.presetSaveFeedback.value.error, 'host refused save');
});

test('chat preset server save reports timeout through the save button', async () => {
    const activeView = ref('settings');
    const activeSettingsWorkspace = ref<TavernSettingsWorkspaceKey>('chatPreset');
    const agentConfig = ref<Record<string, unknown>>({});
    const tavernDisplaySettings = ref(normalizeTavernDisplaySettings({}));
    const timers: Array<{ callback: () => void; delay?: number }> = [];
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let saveSignal: AbortSignal | null = null;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
        const entry = {
            callback: () => {
                if (typeof callback === 'function') {
                    callback();
                }
            },
            delay,
        };
        timers.push(entry);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    try {
        const controller = useTavernSettingsController({
            activeView,
            activeSettingsWorkspace,
            agentConfig,
            tavernDisplaySettings,
            effectiveContext: computed(() => ({})),
            currentWorldbookNativeCharacterId: computed(() => ''),
            homeThemeDark: ref(false),
            isRunning: ref(false),
            confirmDialog: async () => true,
            describeError: (error) => error instanceof Error ? error.message : String(error || ''),
            postToHost: () => {},
            requestHost: async (type, _payload, options = {}) => {
                if (type === 'xb-tavern:save-chat-preset') {
                    saveSignal = options.signal || null;
                    return await new Promise<Record<string, unknown>>((_resolve, reject) => {
                        options.signal?.addEventListener('abort', () => reject(new Error('request_aborted')), { once: true });
                    });
                }
                return {};
            },
            shortText: (value = '') => String(value || ''),
        });

        controller.applyHostChatPreset({
            chatPreset: {
                id: 'Preset A',
                name: 'Preset A',
                source: 'sillytavern',
                promptManager: {
                    name: 'Preset A',
                    rawPreset: {
                        prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'A MAIN' }],
                        prompt_order: [{ character_id: 'char-1', order: [{ identifier: 'main', enabled: true }] }],
                    },
                    prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'A MAIN' }],
                    promptOrder: [{ character_id: 'char-1', order: [{ identifier: 'main', enabled: true }] }],
                    activeCharacterId: 'char-1',
                    activeOrder: [{ identifier: 'main', enabled: true }],
                },
                sections: [],
            },
        });
        controller.settingsContext.updatePromptByIdentifier('main', { content: 'A MAIN edited' });

        const savePromise = controller.settingsContext.saveCurrentPreset();
        const saveTimeout = timers.find((timer) => timer.delay === 5000);
        assert.ok(saveTimeout);
        saveTimeout.callback();
        await savePromise;

        assert.equal(saveSignal?.aborted, true);
        assert.equal(controller.settingsContext.presetStatus.value, '');
        assert.equal(controller.settingsContext.presetSaveFeedback.value.status, 'error');
        assert.equal(controller.settingsContext.presetSaveFeedback.value.error, '保存超时，请重试');
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});
