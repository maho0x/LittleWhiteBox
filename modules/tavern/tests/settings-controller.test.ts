import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, nextTick, ref } from 'vue';

import { normalizeTavernDisplaySettings } from '../shared/settings';
import { useTavernSettingsController } from '../app-src/components/settings/useTavernSettingsController';

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
    const activeSettingsWorkspace = ref<'api' | 'chatPreset' | 'worldbooks' | 'regex' | 'assistantPreset' | 'base'>('base');
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
    const activeSettingsWorkspace = ref<'api' | 'chatPreset' | 'worldbooks' | 'regex' | 'assistantPreset' | 'base'>('chatPreset');
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
