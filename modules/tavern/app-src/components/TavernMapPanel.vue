<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type {
    TavernStructuredStateDocumentRecord,
    TavernStructuredStatePatchRecord,
} from '../../shared/session-db';
import type { TavernMapDocument, TavernMapElement } from '../../shared/structured-state';
import { isRenderableMapDocument } from '../../shared/map-state-content';
import { createSeedMapDocument } from '../../shared/map-state-seed';
import { applyTrustedMapPatchOps } from '../../shared/map-state-ops';
import { getTavernMapDisplayViewBox, getTavernMapElementBounds } from '../map-display';

type MapReplayMode = 'full' | 'patch' | 'timeline';
type MapRenderLayer = 'fill' | 'line' | 'label';
type MapOpKind = 'add' | 'modify' | 'remove' | 'stable';

interface MapRenderItem {
    element: TavernMapElement;
    id: string;
    layer: MapRenderLayer;
    path: string;
    color: string;
    fill: string;
    strokeWidth: number;
    dash: string;
    delayMs: number;
    durationMs: number;
    length: number;
    opKind: MapOpKind;
    text: string;
    x: number;
    y: number;
    fontSize: number;
    anchor: string;
}

interface MapReplayFrame {
    revision: number;
    document: TavernMapDocument;
    patch: TavernStructuredStatePatchRecord;
    index: number;
}

const props = withDefaults(defineProps<{
    document: TavernStructuredStateDocumentRecord | null;
    patches: TavernStructuredStatePatchRecord[];
    compact?: boolean;
}>(), {
    compact: false,
});

const replayKey = ref(0);
const replayMode = ref<MapReplayMode>('patch');
const timelineIndex = ref(0);
let timelineTimer: number | undefined;

function cloneValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function defaultDisplayMap(): TavernMapDocument {
    return createSeedMapDocument();
}

function normalizeDisplayMap(value: unknown): TavernMapDocument {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return defaultDisplayMap();}
    const source = value as Partial<TavernMapDocument>;
    const fallback = defaultDisplayMap();
    return {
        meta: source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta)
            ? {
                ...fallback.meta,
                ...cloneValue(source.meta),
            }
            : fallback.meta,
        elements: Array.isArray(source.elements)
            ? cloneValue(source.elements).filter((element): element is TavernMapElement => !!element && typeof element === 'object' && !Array.isArray(element) && typeof (element as TavernMapElement).id === 'string')
            : [],
    };
}

const mapDocument = computed<TavernMapDocument | null>(() => {
    const data = props.document?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {return null;}
    return normalizeDisplayMap(data);
});

const latestPatch = computed(() => props.patches.at(-1) || null);
const timelineFrames = computed<MapReplayFrame[]>(() => {
    const sorted = [...props.patches].sort((left, right) => Number(left.revision || 0) - Number(right.revision || 0));
    let document = defaultDisplayMap();
    return sorted.map((patch, index) => {
        const ops = Array.isArray(patch.ops) ? patch.ops as Array<Record<string, unknown>> : [];
        document = applyTrustedMapPatchOps(normalizeDisplayMap(document), ops);
        return {
            revision: Number(patch.revision || index + 1),
            document: cloneValue(document),
            patch,
            index,
        };
    });
});
const activeTimelineFrame = computed(() => {
    if (!timelineFrames.value.length) {return null;}
    const index = Math.max(0, Math.min(timelineIndex.value, timelineFrames.value.length - 1));
    return timelineFrames.value[index] || null;
});
const canReplayTimeline = computed(() => timelineFrames.value.length > 0 && Number(timelineFrames.value[0]?.revision || 0) <= 1);
const activePatch = computed(() => replayMode.value === 'timeline' ? activeTimelineFrame.value?.patch || latestPatch.value : latestPatch.value);
const activeMapDocument = computed(() => replayMode.value === 'timeline' ? activeTimelineFrame.value?.document || mapDocument.value : mapDocument.value);
const latestOps = computed(() => Array.isArray(activePatch.value?.ops) ? activePatch.value?.ops as Array<Record<string, unknown>> : []);
const latestChangedIds = computed(() => new Set((activePatch.value?.changedIds || []).map((id) => String(id || '').trim()).filter(Boolean)));
const latestOpById = computed(() => {
    const map = new Map<string, MapOpKind>();
    latestOps.value.forEach((op) => {
        const opName = String(op.op || '').trim();
        const element = op.element && typeof op.element === 'object' && !Array.isArray(op.element) ? op.element as Record<string, unknown> : null;
        const id = String(op.id || element?.id || '').trim();
        if (id && (opName === 'add' || opName === 'modify' || opName === 'remove')) {
            map.set(id, opName as MapOpKind);
        }
    });
    return map;
});
const removedOps = computed(() => latestOps.value
    .filter((op) => String(op.op || '').trim() === 'remove')
    .map((op, index) => ({
        id: String(op.id || `removed-${index}`).trim(),
        delayMs: index * 120,
    }))
    .filter((item) => item.id));
const removedElements = computed<TavernMapElement[]>(() => {
    const source = Array.isArray(activePatch.value?.removedElements) ? activePatch.value?.removedElements : [];
    return source.filter((item): item is TavernMapElement => !!item && typeof item === 'object' && !Array.isArray(item) && typeof (item as TavernMapElement).id === 'string');
});

const viewBoxArray = computed<[number, number, number, number]>(() => getTavernMapDisplayViewBox(activeMapDocument.value));
const viewBox = computed(() => viewBoxArray.value.join(' '));
const theme = computed(() => String(activeMapDocument.value?.meta?.theme || 'parchment'));
const title = computed(() => String(replayMode.value === 'timeline'
    ? activeMapDocument.value?.meta?.name || props.document?.title || '地图'
    : props.document?.title || activeMapDocument.value?.meta?.name || '地图'));
const digest = computed(() => String(props.document?.digest || ''));
const revisionLabel = computed(() => activeTimelineFrame.value && replayMode.value === 'timeline'
    ? `revision ${activeTimelineFrame.value.revision}`
    : props.document ? `revision ${props.document.revision}` : 'no map');
const patchLabel = computed(() => activePatch.value?.summary || (activePatch.value ? `revision ${activePatch.value.revision}` : '等待空间变化'));
const digestLines = computed(() => digest.value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 4));
const elementCount = computed(() => activeMapDocument.value?.elements.length || 0);
const totalPatchCount = computed(() => props.patches.length);
const timelineLabel = computed(() => activeTimelineFrame.value ? `${activeTimelineFrame.value.index + 1} / ${timelineFrames.value.length}` : '0 / 0');
const hasRenderableMap = computed(() => isRenderableMapDocument(activeMapDocument.value));

watch(() => props.document?.revision, () => {
    replayMode.value = 'patch';
    clearTimelineTimer();
    timelineIndex.value = Math.max(0, timelineFrames.value.length - 1);
    replayKey.value += 1;
});

watch(() => props.patches.length, () => {
    if (timelineIndex.value >= timelineFrames.value.length) {
        timelineIndex.value = Math.max(0, timelineFrames.value.length - 1);
    }
    if (replayMode.value === 'timeline' && !canReplayTimeline.value) {
        replayMode.value = 'patch';
        clearTimelineTimer();
    }
});

onBeforeUnmount(() => {
    clearTimelineTimer();
});

function clearTimelineTimer() {
    if (timelineTimer !== undefined) {
        window.clearTimeout(timelineTimer);
        timelineTimer = undefined;
    }
}

function numberPair(value: unknown, fallback: [number, number] = [0, 0]): [number, number] {
    if (!Array.isArray(value) || value.length < 2) {return fallback;}
    const left = Number(value[0]);
    const right = Number(value[1]);
    return Number.isFinite(left) && Number.isFinite(right) ? [left, right] : fallback;
}

function absolutePoints(element: TavernMapElement, points: Array<[number, number]>): Array<[number, number]> {
    return points.map(([dx, dy]) => [element.at[0] + dx, element.at[1] + dy]);
}

function pointsToPath(points: Array<[number, number]>, closed = false): string {
    if (!Array.isArray(points) || points.length < 2) {return '';}
    const path = [`M ${points[0][0]} ${points[0][1]}`, ...points.slice(1).map(([x, y]) => `L ${x} ${y}`)];
    if (closed) {path.push('Z');}
    return path.join(' ');
}

function curveToPath(points: Array<[number, number]>, closed = false): string {
    if (!Array.isArray(points) || points.length < 2) {return '';}
    if (points.length === 2) {return pointsToPath(points, closed);}
    const tension = 0.3;
    const path = [`M ${points[0][0]} ${points[0][1]}`];
    for (let index = 0; index < points.length - 1; index += 1) {
        const p0 = points[Math.max(index - 1, 0)];
        const p1 = points[index];
        const p2 = points[index + 1];
        const p3 = points[Math.min(index + 2, points.length - 1)];
        path.push(`C ${p1[0] + (p2[0] - p0[0]) * tension} ${p1[1] + (p2[1] - p0[1]) * tension}, ${p2[0] - (p3[0] - p1[0]) * tension} ${p2[1] - (p3[1] - p1[1]) * tension}, ${p2[0]} ${p2[1]}`);
    }
    if (closed) {path.push('Z');}
    return path.join(' ');
}

function rectToPath(element: TavernMapElement): string {
    const [x, y] = element.at;
    const [width, height] = numberPair(element.rect, [10, 10]);
    return `M ${x} ${y} L ${x + width} ${y} L ${x + width} ${y + height} L ${x} ${y + height} Z`;
}

function circleToPath(element: TavernMapElement): string {
    const [cx, cy] = element.at;
    const radius = Number(element.circle || 8);
    const r = Number.isFinite(radius) && radius > 0 ? radius : 8;
    return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy}`;
}

function iconToPath(element: TavernMapElement): string {
    const [x, y] = element.at;
    const s = 10;
    const h = s / 2;
    const icon = String(element.icon || '+');
    if (icon === 'x') {return `M ${x - h} ${y - h} L ${x + h} ${y + h} M ${x + h} ${y - h} L ${x - h} ${y + h}`;}
    if (icon === 'o') {return `M ${x - h} ${y} A ${h} ${h} 0 1 0 ${x + h} ${y} A ${h} ${h} 0 1 0 ${x - h} ${y}`;}
    if (icon === 'tree') {return `M ${x} ${y - 8} L ${x - 6} ${y + 2} L ${x + 6} ${y + 2} Z M ${x} ${y + 2} L ${x} ${y + 8}`;}
    if (icon === 'star') {return `M ${x} ${y - 7} L ${x + 2} ${y - 2} L ${x + 7} ${y - 2} L ${x + 3} ${y + 1} L ${x + 5} ${y + 7} L ${x} ${y + 3} L ${x - 5} ${y + 7} L ${x - 3} ${y + 1} L ${x - 7} ${y - 2} L ${x - 2} ${y - 2} Z`;}
    if (icon === 'arrow-n') {return `M ${x} ${y + s} L ${x} ${y - s} M ${x - h} ${y - h} L ${x} ${y - s} L ${x + h} ${y - h}`;}
    if (icon === 'arrow-s') {return `M ${x} ${y - s} L ${x} ${y + s} M ${x - h} ${y + h} L ${x} ${y + s} L ${x + h} ${y + h}`;}
    if (icon === 'arrow-e') {return `M ${x - s} ${y} L ${x + s} ${y} M ${x + h} ${y - h} L ${x + s} ${y} L ${x + h} ${y + h}`;}
    if (icon === 'arrow-w') {return `M ${x + s} ${y} L ${x - s} ${y} M ${x - h} ${y - h} L ${x - s} ${y} L ${x - h} ${y + h}`;}
    return `M ${x - h} ${y} L ${x + h} ${y} M ${x} ${y - h} L ${x} ${y + h}`;
}

function elementPath(element: TavernMapElement): string {
    if (element.rect) {return rectToPath(element);}
    if (typeof element.circle === 'number') {return circleToPath(element);}
    if (element.path) {return pointsToPath(absolutePoints(element, element.path), element.closed === true);}
    if (element.curve) {return curveToPath(absolutePoints(element, element.curve), element.closed === true);}
    if (element.icon) {return iconToPath(element);}
    return '';
}

function elementColor(element: TavernMapElement): string {
    if (element.style?.color) {return String(element.style.color);}
    const colors: Record<string, string> = {
        wall: '#2f2418',
        road: '#9a8253',
        water: '#2d7490',
        terrain: '#55734b',
        furniture: '#765d37',
        door: '#a5652b',
        danger: '#b94035',
        marker: '#b94035',
        label: '#2b2118',
        grid: '#9f987f',
        magic: '#76539a',
        secret: '#68625b',
    };
    return colors[String(element.cat || 'wall')] || colors.wall;
}

function elementFill(element: TavernMapElement): string {
    if (element.fill) {return String(element.fill);}
    const fills: Record<string, string> = {
        water: 'rgba(63, 136, 167, 0.24)',
        terrain: 'rgba(87, 121, 70, 0.18)',
        danger: 'rgba(180, 64, 54, 0.15)',
        magic: 'rgba(126, 83, 154, 0.16)',
        secret: 'rgba(63, 56, 48, 0.10)',
    };
    const hasAreaShape = !!element.rect || typeof element.circle === 'number' || ((!!element.path || !!element.curve) && element.closed === true);
    return hasAreaShape ? (fills[String(element.cat || '')] || 'rgba(92, 70, 36, 0.08)') : 'none';
}

function strokeWidth(element: TavernMapElement): number {
    const width = Number(element.style?.width || 2);
    return Number.isFinite(width) && width > 0 ? width : 2;
}

function dashArray(element: TavernMapElement): string {
    return String(element.style?.dash || '');
}

function estimatePathLength(element: TavernMapElement, path: string): number {
    if (typeof element.circle === 'number') {
        return Math.max(32, Math.PI * 2 * element.circle);
    }
    if (element.rect) {
        return Math.max(40, Math.abs(element.rect[0]) * 2 + Math.abs(element.rect[1]) * 2);
    }
    const coordinates = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
    let length = 0;
    for (let index = 0; index + 3 < coordinates.length; index += 2) {
        const dx = coordinates[index + 2] - coordinates[index];
        const dy = coordinates[index + 3] - coordinates[index + 1];
        length += Math.hypot(dx, dy);
    }
    return Math.max(28, Math.min(2400, length || 180));
}

function opKindFor(element: TavernMapElement): MapOpKind {
    if (replayMode.value === 'full') {return 'add';}
    return latestOpById.value.get(element.id) || (latestChangedIds.value.has(element.id) ? 'modify' : 'stable');
}

function buildRenderItemsForElement(element: TavernMapElement, index: number, forcedOpKind?: MapOpKind): MapRenderItem[] {
    if (!getTavernMapElementBounds(element)) {return [];}
    const opKind = forcedOpKind || opKindFor(element);
    const baseDelay = forcedOpKind === 'remove'
        ? index * 110
        : replayMode.value === 'full'
            ? index * 115
            : opKind === 'stable' ? 0 : index * 30;

    if (element.text) {
        return [{
            element,
            id: `${element.id}-label`,
            layer: 'label',
            path: '',
            color: forcedOpKind === 'remove' ? '#b94035' : elementColor(element),
            fill: 'none',
            strokeWidth: 0,
            dash: '',
            delayMs: baseDelay,
            durationMs: 900,
            length: 60,
            opKind,
            text: element.text,
            x: element.at[0],
            y: element.at[1],
            fontSize: 14,
            anchor: 'middle',
        }];
    }

    const path = elementPath(element);
    if (!path) {return [];}
    const length = estimatePathLength(element, path);
    const durationMs = forcedOpKind === 'remove' ? 1050 : Math.max(680, Math.min(2200, length * 4.2));
    const color = forcedOpKind === 'remove' ? '#b94035' : elementColor(element);
    const fill = forcedOpKind === 'remove' ? 'rgba(185, 64, 53, 0.16)' : elementFill(element);
    const items: MapRenderItem[] = [];
    if (fill !== 'none') {
        items.push({
            element,
            id: `${element.id}-fill`,
            layer: 'fill',
            path,
            color,
            fill,
            strokeWidth: 0,
            dash: '',
            delayMs: baseDelay,
            durationMs,
            length,
            opKind,
            text: '',
            x: 0,
            y: 0,
            fontSize: 0,
            anchor: 'middle',
        });
    }
    items.push({
        element,
        id: `${element.id}-line`,
        layer: 'line',
        path,
        color,
        fill: 'none',
        strokeWidth: strokeWidth(element),
        dash: dashArray(element),
        delayMs: baseDelay,
        durationMs,
        length,
        opKind,
        text: '',
        x: 0,
        y: 0,
        fontSize: 0,
        anchor: 'middle',
    });
    return items;
}

const renderItems = computed<MapRenderItem[]>(() => (activeMapDocument.value?.elements || [])
    .flatMap((element, index) => buildRenderItemsForElement(element, index)));

const fillItems = computed(() => renderItems.value.filter((item) => item.layer === 'fill'));
const lineItems = computed(() => renderItems.value.filter((item) => item.layer === 'line'));
const labelItems = computed(() => renderItems.value.filter((item) => item.layer === 'label'));
const removedRenderItems = computed(() => removedElements.value.flatMap((element, index) => buildRenderItemsForElement(element, index, 'remove')));
const removedFillItems = computed(() => removedRenderItems.value.filter((item) => item.layer === 'fill'));
const removedLineItems = computed(() => removedRenderItems.value.filter((item) => item.layer === 'line'));
const removedLabelItems = computed(() => removedRenderItems.value.filter((item) => item.layer === 'label'));
const animatedItems = computed(() => renderItems.value.filter((item) => replayMode.value === 'full' || item.opKind !== 'stable'));
const totalAnimationMs = computed(() => {
    const animated = animatedItems.value;
    if (!animated.length) {return 1200;}
    return Math.max(...animated.map((item) => item.delayMs + item.durationMs)) + 360;
});
const progressStyle = computed(() => ({
    '--map-progress-duration': `${totalAnimationMs.value}ms`,
}));
const penStyle = computed(() => {
    const animated = animatedItems.value.find((item) => item.layer !== 'label' && item.path) || animatedItems.value[0];
    if (!animated || !animated.path) {return { display: 'none' };}
    return {
        offsetPath: `path("${animated.path}")`,
        animationDelay: `${animated.delayMs}ms`,
        animationDuration: `${animated.durationMs}ms`,
    };
});

function scheduleTimelineNext() {
    clearTimelineTimer();
    if (replayMode.value !== 'timeline' || !canReplayTimeline.value || timelineFrames.value.length <= 1) {return;}
    void nextTick(() => {
        timelineTimer = window.setTimeout(() => {
            if (replayMode.value !== 'timeline') {return;}
            timelineIndex.value = timelineIndex.value + 1 >= timelineFrames.value.length ? 0 : timelineIndex.value + 1;
            replayKey.value += 1;
            scheduleTimelineNext();
        }, totalAnimationMs.value + 420);
    });
}

function itemStyle(item: MapRenderItem) {
    return {
        '--map-delay': `${item.delayMs}ms`,
        '--map-duration': `${item.durationMs}ms`,
        '--map-length': `${item.length}`,
    };
}

function itemClass(item: MapRenderItem) {
    return [
        'map-element',
        `map-${item.layer}`,
        `cat-${item.element.cat || 'wall'}`,
        `op-${item.opKind}`,
        {
            'is-animated': replayMode.value === 'full' || item.opKind !== 'stable',
            'is-latest': latestChangedIds.value.has(item.element.id),
        },
    ];
}

function replayLatestPatch() {
    clearTimelineTimer();
    replayMode.value = 'patch';
    replayKey.value += 1;
}

function replayFullMap() {
    clearTimelineTimer();
    replayMode.value = 'full';
    replayKey.value += 1;
}

function replayTimeline() {
    if (!canReplayTimeline.value) {return;}
    replayMode.value = 'timeline';
    timelineIndex.value = 0;
    replayKey.value += 1;
    scheduleTimelineNext();
}

function stepTimeline(offset: number) {
    clearTimelineTimer();
    replayMode.value = 'timeline';
    if (!canReplayTimeline.value) {return;}
    const length = timelineFrames.value.length;
    if (!length) {return;}
    timelineIndex.value = (timelineIndex.value + offset + length) % length;
    replayKey.value += 1;
}
</script>

<template>
  <aside
    class="tavern-map-panel xb-editor"
    :class="{ 'is-compact': compact }"
  >
    <header
      v-if="!compact"
      class="tavern-editor-head xb-editor-head tavern-map-head"
    >
      <div class="tavern-map-title">
        <span class="tavern-map-kicker">LIVE CARTOGRAPHY</span>
        <strong>{{ title }}</strong>
        <span v-if="document">{{ revisionLabel }} · {{ elementCount }} elements</span>
      </div>
      <div class="tavern-editor-actions xb-editor-actions tavern-map-actions">
        <button
          type="button"
          class="tavern-editor-mode-button"
          :class="{ active: replayMode === 'patch' }"
          :disabled="!latestPatch"
          @click="replayLatestPatch"
        >
          最近回合
        </button>
        <button
          type="button"
          class="tavern-editor-mode-button"
          :class="{ active: replayMode === 'full' }"
          :disabled="!hasRenderableMap"
          @click="replayFullMap"
        >
          完整重绘
        </button>
        <button
          type="button"
          class="tavern-editor-mode-button"
          :class="{ active: replayMode === 'timeline' }"
          :disabled="!canReplayTimeline"
          @click="replayTimeline"
        >
          回合回放
        </button>
      </div>
    </header>

    <div
      v-if="hasRenderableMap"
      class="tavern-map-canvas"
      :class="[`theme-${theme}`, `mode-${replayMode}`]"
    >
      <div class="tavern-map-stage-title">
        {{ title }}
      </div>
      <svg
        :key="replayKey"
        :viewBox="viewBox"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        :aria-label="title"
      >
        <defs>
          <filter
            id="tavern-map-sketch"
            x="-5%"
            y="-5%"
            width="110%"
            height="110%"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.025"
              numOctaves="3"
              seed="7"
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="0.65"
            />
          </filter>
          <filter
            id="tavern-map-glow"
            x="-30%"
            y="-30%"
            width="160%"
            height="160%"
          >
            <feGaussianBlur
              stdDeviation="3"
              result="blur"
            />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g class="map-fill-layer">
          <path
            v-for="item in fillItems"
            :key="item.id"
            :d="item.path"
            :fill="item.fill"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          />
        </g>
        <g
          class="map-line-layer"
          filter="url(#tavern-map-sketch)"
        >
          <path
            v-for="item in lineItems"
            :key="item.id"
            :d="item.path"
            :fill="item.fill"
            :stroke="item.color"
            :stroke-width="item.strokeWidth"
            :stroke-dasharray="item.dash"
            stroke-linecap="round"
            stroke-linejoin="round"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          />
        </g>
        <g class="map-label-layer">
          <text
            v-for="item in labelItems"
            :key="item.id"
            :x="item.x"
            :y="item.y"
            :font-size="item.fontSize"
            :fill="item.color"
            :text-anchor="item.anchor"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          >
            {{ item.text }}
          </text>
        </g>
        <g class="map-removed-layer">
          <path
            v-for="item in removedFillItems"
            :key="`removed-fill-${item.id}`"
            :d="item.path"
            :fill="item.fill"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          />
          <path
            v-for="item in removedLineItems"
            :key="`removed-line-${item.id}`"
            :d="item.path"
            :fill="item.fill"
            :stroke="item.color"
            :stroke-width="item.strokeWidth"
            :stroke-dasharray="item.dash"
            stroke-linecap="round"
            stroke-linejoin="round"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          />
          <text
            v-for="item in removedLabelItems"
            :key="`removed-label-${item.id}`"
            :x="item.x"
            :y="item.y"
            :font-size="item.fontSize"
            :fill="item.color"
            :text-anchor="item.anchor"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          >
            {{ item.text }}
          </text>
        </g>
      </svg>
      <div
        :key="`pen-${replayKey}`"
        class="tavern-map-pen"
        :style="penStyle"
      />
      <div
        :key="`progress-${replayKey}`"
        class="tavern-map-progress"
        :style="progressStyle"
      />
      <div class="tavern-map-badge">
        <span>{{ replayMode === 'full' ? '完整重绘' : replayMode === 'timeline' ? `回合 ${timelineLabel}` : '地图更新' }}</span>
        <strong>{{ patchLabel }}</strong>
      </div>
      <div
        v-if="replayMode === 'timeline' && canReplayTimeline && timelineFrames.length > 1"
        class="tavern-map-timeline-control"
      >
        <button
          type="button"
          @click="stepTimeline(-1)"
        >
          上一回合
        </button>
        <button
          type="button"
          @click="stepTimeline(1)"
        >
          下一回合
        </button>
      </div>
      <div
        v-if="removedOps.length"
        :key="`removed-${replayKey}`"
        class="tavern-map-removed-stack"
      >
        <span
          v-for="item in removedOps"
          :key="item.id"
          :style="{ animationDelay: `${item.delayMs}ms` }"
        >
          - {{ item.id }}
        </span>
      </div>
    </div>

    <div
      v-else
      class="tavern-map-empty"
    >
      <strong>地图待初始化</strong>
      <span>当前会话已备好种子地图；剧情出现明确空间变化后，后台会激活并维护它。</span>
    </div>

    <footer
      v-if="!compact"
      class="tavern-editor-foot xb-editor-foot tavern-map-foot"
    >
      <span>{{ totalPatchCount }} patches</span>
      <span v-if="digestLines.length">{{ digestLines[0] }}</span>
      <span v-if="digestLines[1]">{{ digestLines[1] }}</span>
    </footer>
  </aside>
</template>
