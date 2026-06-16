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
        homeThemeDark: ref(false),
        isRunning: ref(false),
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
