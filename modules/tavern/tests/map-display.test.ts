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
import {
    getTavernMapSceneSurfaceArea,
    getTavernMapSceneSurfaceBackground,
    getTavernMapSceneSurfaceElement,
    getTavernMapSceneSurfaceFill,
} from '../app-src/map-scene-surface';
import {
    tavernMapElementColor,
    tavernMapElementFill,
    tavernMapElementLineCasing,
    tavernMapElementStrokeWidth,
    tavernMapElementUsesSameSurfaceMaterial,
} from '../app-src/map-render-style';
import { TAVERN_MAP_ICON_NAMES } from '../shared/map-icon-names';
import type { TavernMapDocument, TavernMapElement } from '../shared/structured-state';

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

test('map display bounds do not let light glow radius expand the camera fit', () => {
    const base: TavernMapDocument = {
        meta: { name: 'Tavern', theme: 'dark', viewBox: null, status: 'active', mood: 'warm' },
        elements: [
            { id: 'room', at: [100, 100], rect: [200, 120], cat: 'terrain', material: 'wood' },
        ],
    };
    const withLight: TavernMapDocument = {
        ...base,
        elements: [
            ...base.elements,
            { id: 'firelight', at: [110, 110], circle: 240, cat: 'light', material: 'warm-light' },
        ],
    };

    assert.deepEqual(getTavernMapDisplayViewBox(withLight), getTavernMapDisplayViewBox(base));
});

test('map display bounds do not let light-layer materials expand the camera fit', () => {
    const base: TavernMapDocument = {
        meta: { name: 'Dungeon', theme: 'dark', viewBox: null, status: 'active', mood: 'dark' },
        elements: [
            { id: 'cell', at: [100, 100], rect: [200, 120], cat: 'terrain', material: 'tile' },
        ],
    };
    const withShadow: TavernMapDocument = {
        ...base,
        elements: [
            ...base.elements,
            { id: 'shadow-pool', at: [110, 110], circle: 300, cat: 'terrain', material: 'shadow' },
        ],
    };

    assert.deepEqual(getTavernMapDisplayViewBox(withShadow), getTavernMapDisplayViewBox(base));
});

test('map scene surface promotes the dominant terrain into the viewport background', () => {
    const document: TavernMapDocument = {
        meta: { name: 'Forest Clearing', theme: 'parchment', viewBox: [-160, -120, 320, 240], status: 'active', mood: 'calm' },
        elements: [
            { id: 'path', at: [-120, 40], cat: 'road', path: [[0, 0], [220, -80]], material: 'dirt' },
            { id: 'grass-main', at: [0, 0], cat: 'terrain', circle: 90, material: 'grass' },
            { id: 'lamp-glow', at: [20, 10], cat: 'light', circle: 200, material: 'warm-light' },
        ],
    };

    const surface = getTavernMapSceneSurfaceElement(document);

    assert.equal(surface?.id, 'grass-main');
    assert.equal(getTavernMapSceneSurfaceFill(surface), 'url(#mat-grass)');
    assert.match(getTavernMapSceneSurfaceBackground(surface), /#486d3e/);
});

test('map scene surface supports RP room-scale surface materials', () => {
    const materials = [
        ['tatami', /#d3c282/],
        ['sand', /#ead7a4/],
        ['marble', /#eef0f3/],
    ] as const;

    materials.forEach(([material, expectedBackground]) => {
        const surface: TavernMapElement = { id: `${material}-surface`, at: [0, 0], rect: [320, 220], cat: 'terrain', material };

        assert.equal(getTavernMapSceneSurfaceFill(surface), `url(#mat-${material})`);
        assert.match(getTavernMapSceneSurfaceBackground(surface), expectedBackground);
    });
});

test('map scene surface ignores bedding and fabric materials reserved for furniture', () => {
    const document: TavernMapDocument = {
        meta: { name: 'Soft Furnishings', theme: 'parchment', viewBox: null, status: 'active' },
        elements: [
            { id: 'oversized-sheet', at: [0, 0], rect: [520, 360], cat: 'terrain', material: 'bed-sheet' },
            { id: 'floor', at: [20, 20], rect: [240, 160], cat: 'terrain', material: 'wood' },
            { id: 'sofa', at: [80, 70], rect: [90, 34], cat: 'furniture', material: 'fabric' },
        ],
    };

    const surface = getTavernMapSceneSurfaceElement(document);

    assert.equal(surface?.id, 'floor');
    assert.equal(getTavernMapSceneSurfaceElement({
        meta: { name: 'Only Bedding', theme: 'parchment', viewBox: null, status: 'active' },
        elements: [
            { id: 'sheet', at: [0, 0], rect: [520, 360], cat: 'terrain', material: 'bed-sheet' },
            { id: 'drape', at: [0, 0], rect: [420, 220], cat: 'terrain', material: 'fabric' },
        ],
    }), null);
});

test('map scene surface ignores non-terrain areas and light-layer terrain', () => {
    const document: TavernMapDocument = {
        meta: { name: 'Marked Floor', theme: 'parchment', viewBox: null, status: 'active' },
        elements: [
            { id: 'lake', at: [0, 0], cat: 'water', circle: 220, material: 'water' },
            { id: 'shadow', at: [0, 0], cat: 'terrain', circle: 240, material: 'shadow' },
            { id: 'floor', at: [-80, -60], cat: 'terrain', rect: [160, 120], material: 'tile' },
        ],
    };

    assert.equal(getTavernMapSceneSurfaceArea(document.elements[0]), 0);
    assert.equal(getTavernMapSceneSurfaceArea(document.elements[1]), 0);
    assert.equal(getTavernMapSceneSurfaceElement(document)?.id, 'floor');
});

test('map renderer gives secondary same-material terrain visible foreground contrast', () => {
    const surface: TavernMapElement = { id: 'forest', at: [-200, -120], rect: [400, 240], cat: 'terrain', material: 'grass' };
    const deepWoods: TavernMapElement = { id: 'deep-woods', at: [-160, -90], rect: [120, 100], cat: 'terrain', material: 'grass' };
    const context = { surfaceElementId: surface.id, surfaceMaterial: surface.material };

    assert.equal(tavernMapElementUsesSameSurfaceMaterial(deepWoods, context), true);
    assert.match(tavernMapElementFill(deepWoods, context), /rgba\(236, 218, 126, 0\.17\)/);
    assert.equal(tavernMapElementColor(deepWoods, context), '#e5cf7a');
    assert.equal(tavernMapElementStrokeWidth(deepWoods) >= 2.4, true);
});

test('map renderer gives roads and water open lines casing and readable width', () => {
    const road: TavernMapElement = { id: 'main-road', at: [0, 0], path: [[0, 0], [160, 40]], cat: 'road', material: 'dirt' };
    const stream: TavernMapElement = { id: 'stream', at: [0, 0], curve: [[0, 0], [80, -20], [160, 0]], cat: 'water', material: 'water' };

    const roadCasing = tavernMapElementLineCasing(road);
    const streamCasing = tavernMapElementLineCasing(stream);

    assert.ok(roadCasing);
    assert.ok(streamCasing);
    assert.equal(tavernMapElementStrokeWidth(road) >= 5.6, true);
    assert.equal(tavernMapElementStrokeWidth(stream) >= 5, true);
    assert.equal(roadCasing.width > tavernMapElementStrokeWidth(road), true);
    assert.equal(streamCasing.width > tavernMapElementStrokeWidth(stream), true);
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
