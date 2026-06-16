import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeTavernDisplaySettings,
} from '../shared/settings';

test('tavern settings normalize display limits in tavern layer', () => {
    assert.deepEqual(normalizeTavernDisplaySettings({
        hiddenOutsideCount: 0,
        loadBatchSize: 18,
    }), {
        hiddenOutsideCount: 1,
        loadBatchSize: 20,
    });

    assert.deepEqual(normalizeTavernDisplaySettings({
        hiddenOutsideCount: 27,
        loadBatchSize: 53,
    }), {
        hiddenOutsideCount: 20,
        loadBatchSize: 50,
    });
});
