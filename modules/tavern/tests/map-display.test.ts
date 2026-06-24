import assert from 'node:assert/strict';
import test from 'node:test';

import {
    atlasGlyphForScale,
    getTavernGameIconGlyph,
    getTavernMapIconRenderSize,
    gameIconScaleTransform,
    gameIconTransform,
    gameIconTranslateTransform,
    isTavernLegacyMapIcon,
} from '../app-src/map-glyphs';
import { getTavernMapDisplayViewBox, getTavernMapDocumentBounds } from '../app-src/map-display';
import { TAVERN_MAP_ICON_NAMES } from '../shared/map-icon-names';
import type { TavernMapDocument } from '../shared/structured-state';

test('map display keeps the stored viewBox as the camera frame when one is present', () => {
    const document: TavernMapDocument = {
        meta: { name: 'Outer Rim', theme: 'parchment', viewBox: [0, 0, 800, 600], status: 'active' },
        elements: [
            { id: 'outer-wall', at: [1200, 900], cat: 'wall', path: [[0, 0], [300, 300]] },
        ],
    };

    const viewBox = getTavernMapDisplayViewBox(document);

    assert.deepEqual(viewBox, [0, 0, 800, 600]);
});

test('map display viewBox keeps negative coordinates and tiny maps visible with a stable minimum frame', () => {
    const document: TavernMapDocument = {
        meta: { name: 'Cellar', theme: 'dark', viewBox: null, status: 'active' },
        elements: [
            { id: 'door', at: [-60, -40], cat: 'door', icon: 'arrow-n' },
            { id: 'label', at: [-30, -10], cat: 'label', text: 'Secret hatch' },
        ],
    };

    const bounds = getTavernMapDocumentBounds(document);
    const viewBox = getTavernMapDisplayViewBox(document);

    assert.ok(bounds);
    assert.ok(viewBox[0] <= bounds.minX);
    assert.ok(viewBox[1] <= bounds.minY);
    assert.ok(viewBox[0] + viewBox[2] >= bounds.maxX);
    assert.ok(viewBox[1] + viewBox[3] >= bounds.maxY);
    assert.equal(viewBox[2] >= 160, true);
    assert.equal(Number((viewBox[2] / viewBox[3]).toFixed(2)), Number((800 / 600).toFixed(2)));
});

test('map display viewBox falls back to document viewBox when the map has no elements', () => {
    const document: TavernMapDocument = {
        meta: { name: 'Empty field', theme: 'paper', viewBox: [12, 24, 640, 360], status: 'active' },
        elements: [],
    };

    assert.deepEqual(getTavernMapDisplayViewBox(document), [12, 24, 640, 360]);
});

test('map glyph registry upgrades semantic icons while preserving legacy markers', () => {
    assert.equal(TAVERN_MAP_ICON_NAMES.includes('heart'), true);
    assert.equal(TAVERN_MAP_ICON_NAMES.includes('perfume'), true);
    assert.equal(TAVERN_MAP_ICON_NAMES.includes('skull'), true);
    assert.equal(TAVERN_MAP_ICON_NAMES.includes('tree'), true);
    assert.equal(TAVERN_MAP_ICON_NAMES.includes('star'), true);

    assert.equal(!!getTavernGameIconGlyph('skull'), true);
    assert.equal(!!getTavernGameIconGlyph('tree'), true);
    assert.equal(!!getTavernGameIconGlyph('star'), true);
    assert.equal(isTavernLegacyMapIcon('x'), true);
    assert.equal(isTavernLegacyMapIcon('stairs-up'), true);
    assert.equal(isTavernLegacyMapIcon('skull'), false);
    assert.equal(getTavernMapIconRenderSize('heart') > getTavernMapIconRenderSize('x'), true);
});

test('game icon transforms keep at coordinates as the visual anchor', () => {
    assert.equal(gameIconTranslateTransform(260, 292), 'translate(260, 292)');
    assert.equal(gameIconScaleTransform(), 'scale(0.04688)');
    assert.equal(gameIconTransform(260, 292), 'matrix(0.04688, 0, 0, 0.04688, 248, 280)');
});

test('atlas scale glyphs do not use road as a first-pass location default', () => {
    const defaults = ['city', 'district', 'building', 'floor', 'room', 'outdoor'].map(atlasGlyphForScale);

    assert.deepEqual(defaults, ['castle', 'village', 'house', 'stairs', 'door', 'forest']);
    assert.equal(defaults.includes('road'), false);
});
