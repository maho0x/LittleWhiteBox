<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type {
    TavernStructuredStateDocumentRecord,
    TavernStructuredStatePatchRecord,
} from '../../shared/session-db';
import type { TavernMapDocument, TavernMapElement, TavernMapStateDocumentItem } from '../../shared/structured-state';
import { isRenderableMapDocument } from '../../shared/map-state-content';
import { createSeedMapDocument } from '../../shared/map-state-seed';
import { applyTrustedMapPatchOps } from '../../shared/map-state-ops';
import { getTavernMapDisplayViewBox, getTavernMapElementBounds, type TavernMapBounds } from '../map-display';
import {
    gameIconScaleTransform,
    gameIconTranslateTransform,
    getTavernGameIconGlyph,
    TAVERN_MAP_ICON_ATTRIBUTION,
} from '../map-glyphs';

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
    transform: string;
    glyphTransform?: string;
    glyphScaleTransform?: string;
    fillRule: 'nonzero' | 'evenodd';
    gameIcon: boolean;
}

interface MapReplayFrame {
    revision: number;
    document: TavernMapDocument;
    patch: TavernStructuredStatePatchRecord;
    index: number;
}

function pickPenAnimationItem<T extends { gameIcon: boolean; layer: string; path: string }>(items: T[]): T | null {
    return items.find((item) => !item.gameIcon && item.layer !== 'label' && !!item.path) || null;
}

const props = withDefaults(defineProps<{
    documents?: TavernMapStateDocumentItem[];
    activeDocId?: string;
    selectedDocId?: string;
    document: TavernStructuredStateDocumentRecord | null;
    patches: TavernStructuredStatePatchRecord[];
    compact?: boolean;
}>(), {
    documents: () => [],
    activeDocId: 'main',
    selectedDocId: '',
    compact: false,
});
const emit = defineEmits<{
    (event: 'update:selectedDocId', docId: string): void;
}>();

const replayKey = ref(0);
const replayMode = ref<MapReplayMode>('patch');
const timelineIndex = ref(0);
const localSelectedDocId = ref('');
const mapSvgRef = ref<SVGSVGElement | null>(null);
const mapPanOffset = ref<[number, number]>([0, 0]);
const mapZoom = ref(1);
const mapDrag = ref<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
    viewWidth: number;
    viewHeight: number;
    clientWidth: number;
    clientHeight: number;
} | null>(null);
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

const selectedDocumentRecord = computed<TavernMapStateDocumentItem | TavernStructuredStateDocumentRecord | null>(() => {
    const docs = Array.isArray(props.documents) ? props.documents : [];
    const selected = String(localSelectedDocId.value || props.activeDocId || props.document?.docId || '').trim();
    return docs.find((document) => document.docId === selected)
        || docs.find((document) => document.docId === props.activeDocId)
        || props.document
        || null;
});
const selectedDocPatches = computed(() => {
    const docId = String(selectedDocumentRecord.value?.docId || '').trim();
    return docId && docId === String(props.document?.docId || '').trim() ? props.patches : [];
});
const mapDocument = computed<TavernMapDocument | null>(() => {
    const data = selectedDocumentRecord.value?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {return null;}
    return normalizeDisplayMap(data);
});

const latestPatch = computed(() => selectedDocPatches.value.at(-1) || null);
const mapBadgeExpanded = ref(false);
const timelineFrames = computed<MapReplayFrame[]>(() => {
    const sorted = [...selectedDocPatches.value].sort((left, right) => Number(left.revision || 0) - Number(right.revision || 0));
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

const baseViewBoxArray = computed<[number, number, number, number]>(() => getTavernMapDisplayViewBox(activeMapDocument.value));
const viewBoxArray = computed<[number, number, number, number]>(() => {
    const [x, y, width, height] = baseViewBoxArray.value;
    const [offsetX, offsetY] = mapPanOffset.value;
    const zoom = Math.max(0.5, Math.min(4, mapZoom.value));
    const zoomedWidth = width / zoom;
    const zoomedHeight = height / zoom;
    return [
        Number((x + offsetX + (width - zoomedWidth) / 2).toFixed(2)),
        Number((y + offsetY + (height - zoomedHeight) / 2).toFixed(2)),
        Number(zoomedWidth.toFixed(2)),
        Number(zoomedHeight.toFixed(2)),
    ];
});
const viewBox = computed(() => viewBoxArray.value.join(' '));
const mapZoomLabel = computed(() => `${Math.round(mapZoom.value * 100)}%`);
const theme = computed(() => String(activeMapDocument.value?.meta?.theme || 'parchment'));
const title = computed(() => String(replayMode.value === 'timeline'
    ? activeMapDocument.value?.meta?.name || selectedDocumentRecord.value?.title || '地图'
    : selectedDocumentRecord.value?.title || activeMapDocument.value?.meta?.name || '地图'));
const digest = computed(() => String(selectedDocumentRecord.value?.digest || ''));
const revisionLabel = computed(() => activeTimelineFrame.value && replayMode.value === 'timeline'
    ? `revision ${activeTimelineFrame.value.revision}`
    : selectedDocumentRecord.value ? `revision ${selectedDocumentRecord.value.revision}` : 'no map');
const patchLabel = computed(() => activePatch.value?.summary || (activePatch.value ? `revision ${activePatch.value.revision}` : '等待空间变化'));
const badgeModeLabel = computed(() => (
    replayMode.value === 'full'
        ? '完整重绘'
        : replayMode.value === 'timeline'
            ? `回合 ${timelineLabel.value}`
            : '地图更新'
));
const digestLines = computed(() => digest.value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 4));
const elementCount = computed(() => activeMapDocument.value?.elements.length || 0);
const totalPatchCount = computed(() => selectedDocPatches.value.length);
const mapDocuments = computed(() => Array.isArray(props.documents) && props.documents.length
    ? props.documents
    : props.document ? [{ ...props.document, active: true }] : []);
const timelineLabel = computed(() => activeTimelineFrame.value ? `${activeTimelineFrame.value.index + 1} / ${timelineFrames.value.length}` : '0 / 0');
const hasRenderableMap = computed(() => isRenderableMapDocument(activeMapDocument.value));
const showMapBadge = computed(() => !!activePatch.value);

watch(() => props.document?.revision, () => {
    replayMode.value = 'patch';
    clearTimelineTimer();
    timelineIndex.value = Math.max(0, timelineFrames.value.length - 1);
    replayKey.value += 1;
    mapBadgeExpanded.value = false;
    resetMapPan();
});

watch(() => [props.selectedDocId, props.activeDocId, props.document?.docId, props.documents.length] as const, () => {
    const next = String(props.selectedDocId || localSelectedDocId.value || props.activeDocId || props.document?.docId || '').trim();
    const exists = mapDocuments.value.some((document) => document.docId === next);
    const resolved = exists ? next : String(props.activeDocId || props.document?.docId || mapDocuments.value[0]?.docId || '').trim();
    localSelectedDocId.value = resolved;
    if (resolved && resolved !== props.selectedDocId) {
        emit('update:selectedDocId', resolved);
    }
}, { immediate: true });

watch(() => selectedDocPatches.value.length, () => {
    if (timelineIndex.value >= timelineFrames.value.length) {
        timelineIndex.value = Math.max(0, timelineFrames.value.length - 1);
    }
    if (replayMode.value === 'timeline' && !canReplayTimeline.value) {
        replayMode.value = 'patch';
        clearTimelineTimer();
    }
    mapBadgeExpanded.value = false;
    resetMapPan();
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

function resetMapPan() {
    mapPanOffset.value = [0, 0];
    mapZoom.value = 1;
    mapDrag.value = null;
}

function setMapZoom(nextZoom: number, anchor?: { clientX: number; clientY: number }) {
    const svg = mapSvgRef.value;
    const bounds = svg?.getBoundingClientRect();
    const [oldX, oldY, oldWidth, oldHeight] = viewBoxArray.value;
    const [baseX, baseY, baseWidth, baseHeight] = baseViewBoxArray.value;
    const clampedZoom = Number(Math.max(0.5, Math.min(4, nextZoom)).toFixed(2));
    if (clampedZoom === mapZoom.value) {return;}

    let anchorRatioX = 0.5;
    let anchorRatioY = 0.5;
    if (anchor && bounds && bounds.width > 0 && bounds.height > 0) {
        anchorRatioX = Math.max(0, Math.min(1, (anchor.clientX - bounds.left) / bounds.width));
        anchorRatioY = Math.max(0, Math.min(1, (anchor.clientY - bounds.top) / bounds.height));
    }
    const anchorMapX = oldX + oldWidth * anchorRatioX;
    const anchorMapY = oldY + oldHeight * anchorRatioY;
    const nextWidth = baseWidth / clampedZoom;
    const nextHeight = baseHeight / clampedZoom;
    mapZoom.value = clampedZoom;
    mapPanOffset.value = [
        Number((anchorMapX - nextWidth * anchorRatioX - baseX - (baseWidth - nextWidth) / 2).toFixed(2)),
        Number((anchorMapY - nextHeight * anchorRatioY - baseY - (baseHeight - nextHeight) / 2).toFixed(2)),
    ];
}

function zoomMapBy(step: number) {
    setMapZoom(mapZoom.value + step);
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
    const gameIcon = getTavernGameIconGlyph(icon);
    if (gameIcon) {return gameIcon.path;}
    if (icon === 'x') {return `M ${x - h} ${y - h} L ${x + h} ${y + h} M ${x + h} ${y - h} L ${x - h} ${y + h}`;}
    if (icon === 'o') {return `M ${x - h} ${y} A ${h} ${h} 0 1 0 ${x + h} ${y} A ${h} ${h} 0 1 0 ${x - h} ${y}`;}
    if (icon === 'arrow-n') {return `M ${x} ${y + s} L ${x} ${y - s} M ${x - h} ${y - h} L ${x} ${y - s} L ${x + h} ${y - h}`;}
    if (icon === 'arrow-s') {return `M ${x} ${y - s} L ${x} ${y + s} M ${x - h} ${y + h} L ${x} ${y + s} L ${x + h} ${y + h}`;}
    if (icon === 'arrow-e') {return `M ${x - s} ${y} L ${x + s} ${y} M ${x + h} ${y - h} L ${x + s} ${y} L ${x + h} ${y + h}`;}
    if (icon === 'arrow-w') {return `M ${x + s} ${y} L ${x - s} ${y} M ${x - h} ${y - h} L ${x - s} ${y} L ${x - h} ${y + h}`;}
    if (icon === 'stairs-up') {return `M ${x - 9} ${y + 7} H ${x - 3} V ${y + 1} H ${x + 3} V ${y - 5} H ${x + 9} M ${x + 3} ${y - 5} L ${x + 3} ${y - 10} M ${x + 3} ${y - 10} L ${x} ${y - 7} M ${x + 3} ${y - 10} L ${x + 6} ${y - 7}`;}
    if (icon === 'stairs-down') {return `M ${x - 9} ${y - 7} H ${x - 3} V ${y - 1} H ${x + 3} V ${y + 5} H ${x + 9} M ${x + 3} ${y + 5} L ${x + 3} ${y + 10} M ${x + 3} ${y + 10} L ${x} ${y + 7} M ${x + 3} ${y + 10} L ${x + 6} ${y + 7}`;}
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
        actor: '#b94035',
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

function mergeBounds(left: TavernMapBounds | null, right: TavernMapBounds | null): TavernMapBounds | null {
    if (!left) {return right;}
    if (!right) {return left;}
    const minX = Math.min(left.minX, right.minX);
    const minY = Math.min(left.minY, right.minY);
    const maxX = Math.max(left.maxX, right.maxX);
    const maxY = Math.max(left.maxY, right.maxY);
    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY),
    };
}

function mapBodyBounds(): TavernMapBounds | null {
    return (activeMapDocument.value?.elements || []).reduce<TavernMapBounds | null>((bounds, item) => {
        if (item.text || String(item.cat || '') === 'label') {return bounds;}
        return mergeBounds(bounds, getTavernMapElementBounds(item));
    }, null);
}

function labelPosition(element: TavernMapElement): [number, number] {
    if (!element.text || String(element.cat || '') !== 'label') {return element.at;}
    const id = String(element.id || '').trim().toLowerCase();
    if (id.startsWith('__label__')) {return element.at;}
    const [viewX, viewY, viewWidth, viewHeight] = viewBoxArray.value;
    const topGuard = viewY + Math.max(72, viewHeight * 0.26);
    if (!['label', 'room-label', 'scene-label', 'place-label', 'map-label'].includes(id) || element.at[1] >= topGuard) {
        return element.at;
    }
    const bodyBounds = mapBodyBounds();
    const left = (bodyBounds?.minX ?? viewX) + 24;
    const right = (bodyBounds?.maxX ?? viewX + viewWidth) - 24;
    const bodyTop = bodyBounds ? bodyBounds.minY + Math.min(90, Math.max(42, bodyBounds.height * 0.22)) : topGuard;
    const y = Math.max(topGuard, bodyTop);
    return [
        Math.min(right, Math.max(left, element.at[0])),
        Math.min(viewY + viewHeight - 24, y),
    ];
}

function labelFontSize(element: TavernMapElement): number {
    if (!element.text || String(element.cat || '') !== 'label') {return 14;}
    const id = String(element.id || '').trim().toLowerCase();
    if (id.startsWith('__label__')) {return 14;}
    if (['label', 'room-label', 'scene-label', 'place-label', 'map-label'].includes(id)) {return 13;}
    return 14;
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
        const [labelX, labelY] = labelPosition(element);
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
            x: labelX,
            y: labelY,
            fontSize: labelFontSize(element),
            anchor: 'middle',
            transform: '',
            fillRule: 'nonzero',
            gameIcon: false,
        }];
    }

    const path = elementPath(element);
    if (!path) {return [];}
    const gameIcon = element.icon ? getTavernGameIconGlyph(element.icon) : null;
    const length = gameIcon ? 120 : estimatePathLength(element, path);
    const durationMs = forcedOpKind === 'remove' ? 1050 : Math.max(680, Math.min(2200, length * 4.2));
    const color = forcedOpKind === 'remove' ? '#b94035' : elementColor(element);
    const fill = forcedOpKind === 'remove' ? 'rgba(185, 64, 53, 0.16)' : elementFill(element);
    const items: MapRenderItem[] = [];
    if (gameIcon) {
        items.push({
            element,
            id: `${element.id}-glyph`,
            layer: 'line',
            path,
            color,
            fill: color,
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
            transform: '',
            glyphTransform: gameIconTranslateTransform(element.at[0], element.at[1]),
            glyphScaleTransform: gameIconScaleTransform(),
            fillRule: gameIcon.fillRule,
            gameIcon: true,
        });
        return items;
    }
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
            transform: '',
            fillRule: 'nonzero',
            gameIcon: false,
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
        transform: '',
        fillRule: 'nonzero',
        gameIcon: false,
    });
    return items;
}

const renderItems = computed<MapRenderItem[]>(() => (activeMapDocument.value?.elements || [])
    .flatMap((element, index) => buildRenderItemsForElement(element, index)));

const fillItems = computed(() => renderItems.value.filter((item) => item.layer === 'fill'));
const lineItems = computed(() => renderItems.value.filter((item) => item.layer === 'line'));
const regularLineItems = computed(() => lineItems.value.filter((item) => !item.gameIcon));
const gameIconLineItems = computed(() => lineItems.value.filter((item) => item.gameIcon));
const labelItems = computed(() => renderItems.value.filter((item) => item.layer === 'label'));
const removedRenderItems = computed(() => removedElements.value.flatMap((element, index) => buildRenderItemsForElement(element, index, 'remove')));
const removedFillItems = computed(() => removedRenderItems.value.filter((item) => item.layer === 'fill'));
const removedLineItems = computed(() => removedRenderItems.value.filter((item) => item.layer === 'line'));
const regularRemovedLineItems = computed(() => removedLineItems.value.filter((item) => !item.gameIcon));
const gameIconRemovedLineItems = computed(() => removedLineItems.value.filter((item) => item.gameIcon));
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
    const animated = pickPenAnimationItem(animatedItems.value);
    if (!animated) {return { display: 'none' };}
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
        item.gameIcon ? 'map-game-icon' : `map-${item.layer}`,
        `cat-${item.element.cat || 'wall'}`,
        `op-${item.opKind}`,
        {
            'is-animated': replayMode.value === 'full' || item.opKind !== 'stable',
            'is-latest': latestChangedIds.value.has(item.element.id),
            'is-game-icon': item.gameIcon,
        },
    ];
}

function replayLatestPatch() {
    clearTimelineTimer();
    replayMode.value = 'patch';
    replayKey.value += 1;
    resetMapPan();
}

function replayFullMap() {
    clearTimelineTimer();
    replayMode.value = 'full';
    replayKey.value += 1;
    resetMapPan();
}

function replayTimeline() {
    if (!canReplayTimeline.value) {return;}
    replayMode.value = 'timeline';
    timelineIndex.value = 0;
    replayKey.value += 1;
    resetMapPan();
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
    resetMapPan();
}

function toggleMapBadge() {
    mapBadgeExpanded.value = !mapBadgeExpanded.value;
}

function collapseMapBadge() {
    mapBadgeExpanded.value = false;
}

function handleSelectedDocChange(event: Event) {
    const target = event.target instanceof HTMLSelectElement ? event.target : null;
    localSelectedDocId.value = String(target?.value || '').trim();
    emit('update:selectedDocId', localSelectedDocId.value);
    replayMode.value = 'patch';
    clearTimelineTimer();
    replayKey.value += 1;
    resetMapPan();
}

function handleMapPointerDown(event: PointerEvent) {
    const svg = event.currentTarget instanceof SVGSVGElement ? event.currentTarget : mapSvgRef.value;
    if (!svg || event.button !== 0) {return;}
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {return;}
    const [, , viewWidth, viewHeight] = viewBoxArray.value;
    const [startPanX, startPanY] = mapPanOffset.value;
    mapDrag.value = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPanX,
        startPanY,
        viewWidth,
        viewHeight,
        clientWidth: bounds.width,
        clientHeight: bounds.height,
    };
    svg.setPointerCapture(event.pointerId);
}

function handleMapPointerMove(event: PointerEvent) {
    const drag = mapDrag.value;
    if (!drag || drag.pointerId !== event.pointerId) {return;}
    const deltaX = -((event.clientX - drag.startClientX) / drag.clientWidth) * drag.viewWidth;
    const deltaY = -((event.clientY - drag.startClientY) / drag.clientHeight) * drag.viewHeight;
    mapPanOffset.value = [
        Number((drag.startPanX + deltaX).toFixed(2)),
        Number((drag.startPanY + deltaY).toFixed(2)),
    ];
}

function handleMapPointerEnd(event: PointerEvent) {
    const drag = mapDrag.value;
    if (!drag || drag.pointerId !== event.pointerId) {return;}
    const svg = event.currentTarget instanceof SVGSVGElement ? event.currentTarget : mapSvgRef.value;
    if (svg?.hasPointerCapture(event.pointerId)) {
        svg.releasePointerCapture(event.pointerId);
    }
    mapDrag.value = null;
}

function handleMapWheel(event: WheelEvent) {
    if (!mapSvgRef.value) {return;}
    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    setMapZoom(mapZoom.value + direction * 0.18, { clientX: event.clientX, clientY: event.clientY });
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
        <span v-if="selectedDocumentRecord">{{ revisionLabel }} · {{ elementCount }} elements</span>
      </div>
      <div class="tavern-editor-actions xb-editor-actions tavern-map-actions">
        <select
          class="tavern-map-select"
          :value="selectedDocumentRecord?.docId || ''"
          :disabled="mapDocuments.length <= 1"
          aria-label="选择地图"
          @change="handleSelectedDocChange"
        >
          <option
            v-for="mapDocumentItem in mapDocuments"
            :key="mapDocumentItem.docId"
            :value="mapDocumentItem.docId"
          >
            {{ mapDocumentItem.active ? '当前 · ' : '' }}{{ mapDocumentItem.title || mapDocumentItem.docId }}
          </option>
        </select>
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
      :class="[`theme-${theme}`, `mode-${replayMode}`, { 'is-panning': mapDrag }]"
    >
      <div
        v-if="compact"
        class="tavern-map-compact-controls is-floating"
      >
        <select
          class="tavern-map-select"
          :value="selectedDocumentRecord?.docId || ''"
          :disabled="mapDocuments.length <= 1"
          aria-label="选择地图"
          @change="handleSelectedDocChange"
        >
          <option
            v-for="mapDocumentItem in mapDocuments"
            :key="mapDocumentItem.docId"
            :value="mapDocumentItem.docId"
          >
            {{ mapDocumentItem.active ? '当前 · ' : '' }}{{ mapDocumentItem.title || mapDocumentItem.docId }}
          </option>
        </select>
      </div>
      <div
        class="tavern-map-zoom-controls"
        aria-label="地图缩放"
      >
        <button
          type="button"
          aria-label="缩小地图"
          :disabled="mapZoom <= 0.5"
          @click="zoomMapBy(-0.25)"
        >
          -
        </button>
        <button
          type="button"
          class="tavern-map-zoom-value"
          aria-label="重置地图缩放"
          @click="resetMapPan"
        >
          {{ mapZoomLabel }}
        </button>
        <button
          type="button"
          aria-label="放大地图"
          :disabled="mapZoom >= 4"
          @click="zoomMapBy(0.25)"
        >
          +
        </button>
      </div>
      <svg
        ref="mapSvgRef"
        :key="replayKey"
        :viewBox="viewBox"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        :aria-label="title"
        @pointerdown="handleMapPointerDown"
        @pointermove="handleMapPointerMove"
        @pointerup="handleMapPointerEnd"
        @pointercancel="handleMapPointerEnd"
        @dblclick="resetMapPan"
        @wheel="handleMapWheel"
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
            :transform="item.transform"
            :fill-rule="item.fillRule"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          />
        </g>
        <g
          class="map-line-layer"
          filter="url(#tavern-map-sketch)"
        >
          <path
            v-for="item in regularLineItems"
            :key="item.id"
            :d="item.path"
            :fill="item.fill"
            :stroke="item.color"
            :stroke-width="item.strokeWidth"
            :stroke-dasharray="item.dash"
            :transform="item.transform"
            :fill-rule="item.fillRule"
            stroke-linecap="round"
            stroke-linejoin="round"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          />
          <g
            v-for="item in gameIconLineItems"
            :key="item.id"
            :transform="item.glyphTransform"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          >
            <g :transform="item.glyphScaleTransform">
              <path
                :d="item.path"
                :fill="item.fill"
                :fill-rule="item.fillRule"
                transform="translate(-256, -256)"
                class="map-game-icon-path"
              />
            </g>
          </g>
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
            :transform="item.transform"
            :fill-rule="item.fillRule"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          />
          <path
            v-for="item in regularRemovedLineItems"
            :key="`removed-line-${item.id}`"
            :d="item.path"
            :fill="item.fill"
            :stroke="item.color"
            :stroke-width="item.strokeWidth"
            :stroke-dasharray="item.dash"
            :transform="item.transform"
            :fill-rule="item.fillRule"
            stroke-linecap="round"
            stroke-linejoin="round"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          />
          <g
            v-for="item in gameIconRemovedLineItems"
            :key="`removed-game-icon-${item.id}`"
            :transform="item.glyphTransform"
            :class="itemClass(item)"
            :style="itemStyle(item)"
          >
            <g :transform="item.glyphScaleTransform">
              <path
                :d="item.path"
                :fill="item.fill"
                :fill-rule="item.fillRule"
                transform="translate(-256, -256)"
                class="map-game-icon-path"
              />
            </g>
          </g>
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
      <div
        v-if="showMapBadge"
        class="tavern-map-badge-shell"
        :class="{ 'is-open': mapBadgeExpanded }"
      >
        <button
          type="button"
          class="tavern-map-badge-toggle"
          :aria-expanded="mapBadgeExpanded"
          :title="mapBadgeExpanded ? '收起地图更新提示' : '显示地图更新提示'"
          aria-label="切换地图更新提示"
          @click="toggleMapBadge"
        >
          !
        </button>
        <button
          v-if="mapBadgeExpanded"
          type="button"
          class="tavern-map-badge"
          title="收起地图更新提示"
          @click="collapseMapBadge"
        >
          <span>{{ badgeModeLabel }}</span>
          <strong>{{ patchLabel }}</strong>
        </button>
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
      <div
        v-if="compact"
        class="tavern-map-compact-controls"
      >
        <select
          class="tavern-map-select"
          :value="selectedDocumentRecord?.docId || ''"
          :disabled="mapDocuments.length <= 1"
          aria-label="选择地图"
          @change="handleSelectedDocChange"
        >
          <option
            v-for="mapDocumentItem in mapDocuments"
            :key="mapDocumentItem.docId"
            :value="mapDocumentItem.docId"
          >
            {{ mapDocumentItem.active ? '当前 · ' : '' }}{{ mapDocumentItem.title || mapDocumentItem.docId }}
          </option>
        </select>
      </div>
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
      <span class="tavern-map-icon-credit">{{ TAVERN_MAP_ICON_ATTRIBUTION }}</span>
    </footer>
  </aside>
</template>
