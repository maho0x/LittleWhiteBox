import db, {
    appendTavernStructuredStatePatch,
    ensureSeedStructuredStateDocument,
    ensureTavernManagerStateSnapshot,
    getTavernStructuredStateDocument,
    listTavernStructuredStateDocuments,
    listTavernStructuredStatePatches,
    putTavernStructuredStateDocument,
    tavernManagerStateSnapshotsTable,
    tavernSessionsTable,
    tavernStateDocumentsTable,
    tavernStatePatchesTable,
    updateTavernManagerStateSnapshotAfter,
    type TavernStructuredStateDocType,
    type TavernStructuredStateDocumentRecord,
    type TavernStructuredStatePatchRecord,
} from './session-db';
import {
    buildSeedLabelId,
    buildSeedMapHint,
    createSeedMapDocument,
    isSeedLabelId,
    isUninitializedMapData,
    TAVERN_MAP_DOC_ID,
    TAVERN_MAP_DOC_TYPE,
    type TavernMapStatus,
    type TavernMapTheme,
} from './map-state-seed';
import { hasSpatialMapContent } from './map-state-content';
import { mergeMapElementPatch } from './map-state-ops';

export const TAVERN_STATE_TOOL_NAMES = {
    LIST: 'StateList',
    READ: 'StateRead',
    PATCH: 'StatePatch',
} as const;

export type TavernMapElementCategory =
    | 'wall'
    | 'road'
    | 'water'
    | 'terrain'
    | 'furniture'
    | 'door'
    | 'danger'
    | 'marker'
    | 'label'
    | 'grid'
    | 'magic'
    | 'secret';

export type TavernMapIconName =
    | 'x'
    | 'o'
    | '+'
    | 'star'
    | 'tree'
    | 'skull'
    | 'arrow-n'
    | 'arrow-s'
    | 'arrow-e'
    | 'arrow-w'
    | 'stairs-up'
    | 'stairs-down';

export interface TavernMapStyle {
    color?: string;
    width?: number;
    dash?: string;
}

export interface TavernMapDocumentMeta {
    name: string | null;
    viewBox: [number, number, number, number] | null;
    theme: TavernMapTheme;
    status: TavernMapStatus;
    hint?: string;
}

export interface TavernMapElement {
    id: string;
    at: [number, number];
    cat: TavernMapElementCategory;
    rect?: [number, number];
    circle?: number;
    path?: Array<[number, number]>;
    curve?: Array<[number, number]>;
    icon?: TavernMapIconName;
    text?: string;
    closed?: boolean;
    fill?: string;
    style?: TavernMapStyle;
}

export interface TavernMapDocument {
    meta: TavernMapDocumentMeta;
    elements: TavernMapElement[];
}

export type TavernMapPatchOp =
    | { op: 'meta'; set: Partial<TavernMapDocumentMeta> }
    | { op: 'add'; element: TavernMapElement }
    | { op: 'modify'; id: string; set: Partial<TavernMapElement> }
    | { op: 'remove'; id: string; _internalSoft?: true };

export interface TavernStateToolResult {
    ok: boolean;
    summary: string;
    docType?: TavernStructuredStateDocType;
    docId?: string;
    title?: string;
    revision?: number;
    changed?: boolean;
    appliedCount?: number;
    satisfiedCount?: number;
    failedCount?: number;
    count?: number;
    truncated?: boolean;
    nextOffset?: number;
    documents?: Array<Pick<TavernStructuredStateDocumentRecord, 'docType' | 'docId' | 'title' | 'revision' | 'digest' | 'status' | 'updatedAt'>>;
    document?: unknown;
    digest?: string;
    meta?: TavernMapDocumentMeta;
    elementCount?: number;
    element?: TavernMapElement;
    elements?: TavernMapElement[];
    removedElements?: TavernMapElement[];
    patches?: TavernStructuredStatePatchRecord[];
    changedIds?: string[];
    warnings?: string[];
    error?: string;
    details?: unknown;
}

export type TavernStateToolCaller = 'auto' | 'chat';

type MapShapeKey = 'rect' | 'circle' | 'path' | 'curve' | 'icon' | 'text';
type NormalizeSource = 'model-input' | 'stored-document';

const MAP_DOC_TYPE: TavernStructuredStateDocType = TAVERN_MAP_DOC_TYPE;
const DEFAULT_DOC_ID = TAVERN_MAP_DOC_ID;
const MAX_MAP_ELEMENTS = 2000;
const MAX_STATE_PATCH_OPS = 1000;
const MAX_STATE_READ_LIMIT = 300;

const MAP_SHAPE_KEYS: MapShapeKey[] = ['rect', 'circle', 'path', 'curve', 'icon', 'text'];
const MAP_GEOMETRY_KEYS: MapShapeKey[] = ['rect', 'circle', 'path', 'curve', 'icon'];
const MAP_ELEMENT_CATEGORIES = new Set<TavernMapElementCategory>([
    'wall',
    'road',
    'water',
    'terrain',
    'furniture',
    'door',
    'danger',
    'marker',
    'label',
    'grid',
    'magic',
    'secret',
]);
const MAP_ICON_NAMES = new Set<TavernMapIconName>([
    'x',
    'o',
    '+',
    'star',
    'tree',
    'skull',
    'arrow-n',
    'arrow-s',
    'arrow-e',
    'arrow-w',
    'stairs-up',
    'stairs-down',
]);
const MAP_THEMES = new Set<TavernMapTheme>(['parchment', 'paper', 'dark', 'blueprint', 'grid']);
const MAP_STATUSES = new Set<TavernMapStatus>(['uninitialized', 'active']);

function now(): number {
    return Date.now();
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown = '', limit = 400): string {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit) : text;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(value ?? null);
}

function deepEqual(left: unknown, right: unknown): boolean {
    return stableStringify(left) === stableStringify(right);
}

function normalizeDocType(value: unknown = MAP_DOC_TYPE): TavernStructuredStateDocType {
    const text = String(value || MAP_DOC_TYPE).trim();
    if (text !== MAP_DOC_TYPE) {throw new Error('state_doc_type_not_supported');}
    return MAP_DOC_TYPE;
}

function normalizeDocId(value: unknown = DEFAULT_DOC_ID): string {
    const text = String(value || DEFAULT_DOC_ID).trim() || DEFAULT_DOC_ID;
    if (!/^[\w.-]{1,80}$/i.test(text)) {throw new Error('state_doc_id_invalid');}
    return text;
}

function normalizeMapTheme(value: unknown, fallback: TavernMapTheme = 'parchment'): TavernMapTheme {
    return MAP_THEMES.has(String(value || '').trim() as TavernMapTheme)
        ? String(value).trim() as TavernMapTheme
        : fallback;
}

function normalizeMapStatus(value: unknown, fallback: TavernMapStatus = 'active'): TavernMapStatus {
    return MAP_STATUSES.has(String(value || '').trim() as TavernMapStatus)
        ? String(value).trim() as TavernMapStatus
        : fallback;
}

function normalizeViewBox(value: unknown): [number, number, number, number] | null {
    if (value === null) {return null;}
    if (!Array.isArray(value) || value.length !== 4) {return null;}
    const numbers = value.map((item) => Number(item));
    if (!numbers.every((item) => Number.isFinite(item))) {return null;}
    return [numbers[0], numbers[1], Math.max(1, numbers[2]), Math.max(1, numbers[3])];
}

function normalizePoint(value: unknown): [number, number] | null {
    if (Array.isArray(value) && value.length >= 2) {
        const x = Number(value[0]);
        const y = Number(value[1]);
        return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
    }
    if (isPlainObject(value)) {
        const x = Number(value.x ?? value.cx);
        const y = Number(value.y ?? value.cy);
        return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
    }
    return null;
}

function pointOrThrow(value: unknown, error: string): [number, number] {
    const point = normalizePoint(value);
    if (!point) {throw new Error(error);}
    return point;
}

function pointListOrThrow(value: unknown, error: string, minPoints = 2): Array<[number, number]> {
    if (!Array.isArray(value) || value.length < minPoints) {throw new Error(error);}
    const points = value.map((item) => normalizePoint(item));
    if (points.some((point) => !point)) {throw new Error(error);}
    return points as Array<[number, number]>;
}

function positiveNumber(value: unknown): number | null {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function numberPair(value: unknown): [number, number] | null {
    if (!Array.isArray(value) || value.length < 2) {return null;}
    const left = Number(value[0]);
    const right = Number(value[1]);
    return Number.isFinite(left) && Number.isFinite(right) ? [left, right] : null;
}

function normalizeCategory(value: unknown, fallback: TavernMapElementCategory): TavernMapElementCategory {
    const text = String(value || '').trim() as TavernMapElementCategory;
    if (text && MAP_ELEMENT_CATEGORIES.has(text)) {return text;}
    return fallback;
}

function normalizeIcon(value: unknown): TavernMapIconName | undefined {
    const text = String(value || '').trim() as TavernMapIconName;
    return MAP_ICON_NAMES.has(text) ? text : undefined;
}

function normalizeStyle(value: unknown): TavernMapStyle | undefined {
    if (value === null) {return undefined;}
    const source = isPlainObject(value) ? value : {};
    const next: TavernMapStyle = {};
    const color = normalizeText(source.color, 80);
    const dash = normalizeText(source.dash, 80);
    const width = positiveNumber(source.width);
    if (color) {next.color = color;}
    if (dash) {next.dash = dash;}
    if (width !== null) {next.width = width;}
    return Object.keys(next).length ? next : undefined;
}

function normalizeMapMeta(value: unknown, fallback: Partial<TavernMapDocumentMeta> = {}): TavernMapDocumentMeta {
    const source = isPlainObject(value) ? value : {};
    const status = normalizeMapStatus(source.status ?? fallback.status ?? 'active', fallback.status ?? 'active');
    const nameSource = 'name' in source ? source.name : fallback.name;
    const hintSource = 'hint' in source ? source.hint : fallback.hint;
    return {
        name: nameSource === null ? null : normalizeText(nameSource, 120) || null,
        viewBox: 'viewBox' in source ? normalizeViewBox(source.viewBox) : normalizeViewBox(fallback.viewBox ?? null),
        theme: normalizeMapTheme(source.theme ?? fallback.theme ?? 'parchment', fallback.theme ?? 'parchment'),
        status,
        ...(status === 'uninitialized'
            ? { hint: normalizeText(hintSource ?? buildSeedMapHint(), 1200) || buildSeedMapHint() }
            : (normalizeText(hintSource, 1200) ? { hint: normalizeText(hintSource, 1200) } : {})),
    };
}

function normalizeMetaSet(value: unknown): Partial<TavernMapDocumentMeta> {
    if (!isPlainObject(value)) {throw new Error('map_meta_set_required');}
    const set: Partial<TavernMapDocumentMeta> = {};
    if ('name' in value) {
        set.name = value.name === null ? null : normalizeText(value.name, 120) || null;
    }
    if ('viewBox' in value) {
        set.viewBox = normalizeViewBox(value.viewBox);
    }
    if ('theme' in value) {
        set.theme = normalizeMapTheme(value.theme);
    }
    if ('status' in value) {
        set.status = normalizeMapStatus(value.status);
    }
    if ('hint' in value) {
        const hint = normalizeText(value.hint, 1200);
        set.hint = hint || undefined;
    }
    return set;
}

function mergeMapMeta(current: TavernMapDocumentMeta, set: Partial<TavernMapDocumentMeta>): TavernMapDocumentMeta {
    return normalizeMapMeta({
        ...current,
        ...set,
        ...(set.hint === undefined && 'hint' in set ? { hint: null } : {}),
    }, current);
}

function shapeKeyForElement(element: Partial<TavernMapElement>): MapShapeKey | null {
    for (const key of MAP_SHAPE_KEYS) {
        if (key === 'circle') {
            if (typeof element.circle === 'number') {return key;}
            continue;
        }
        if (key === 'text') {
            if (typeof element.text === 'string' && element.text.trim()) {return key;}
            continue;
        }
        if (Array.isArray(element[key])) {return key;}
        if (typeof element[key] === 'string' && element[key]) {return key;}
    }
    return null;
}

function defaultCategoryForShape(shape: MapShapeKey | null): TavernMapElementCategory {
    if (shape === 'text') {return 'label';}
    if (shape === 'icon') {return 'marker';}
    return 'wall';
}

function arcToCurvePoints(source: Record<string, unknown>, id: string): Array<[number, number]> {
    const center = pointOrThrow(source.center ?? source.pos ?? { x: source.cx, y: source.cy }, `map_element_center_required:${id}`);
    const radius = positiveNumber(source.r ?? source.radius);
    if (radius === null) {throw new Error(`map_element_radius_required:${id}`);}
    const start = Number(source.startAngle);
    const end = Number(source.endAngle);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {throw new Error(`map_element_arc_angles_required:${id}`);}
    const delta = end - start;
    const segments = Math.max(4, Math.min(24, Math.ceil(Math.abs(delta) / 30)));
    return Array.from({ length: segments + 1 }, (_, index) => {
        const angle = (start + (delta * index / segments)) * Math.PI / 180;
        return [
            Number((center[0] + radius * Math.cos(angle)).toFixed(2)),
            Number((center[1] + radius * Math.sin(angle)).toFixed(2)),
        ];
    });
}

function normalizePathLikePoints(
    value: unknown,
    id: string,
    at: [number, number] | null,
): { at: [number, number]; points: Array<[number, number]> } {
    const absolute = pointListOrThrow(value, `map_element_points_required:${id}`, 2);
    if (at) {
        return { at, points: absolute };
    }
    const anchor = absolute[0];
    return {
        at: anchor,
        points: absolute.map(([x, y]) => [Number((x - anchor[0]).toFixed(2)), Number((y - anchor[1]).toFixed(2))]),
    };
}

function labelPositionForElement(element: Pick<TavernMapElement, 'at' | 'rect' | 'circle' | 'path' | 'curve' | 'icon'>): [number, number] {
    const [x, y] = element.at;
    if (element.rect) {return [x + Math.max(18, element.rect[0] / 2), y - 18];}
    if (typeof element.circle === 'number') {return [x + element.circle + 18, y - 6];}
    return [x + 18, y - 18];
}

function assertElementId(id: string, options: { allowReserved?: boolean } = {}): string {
    if (!id || !/^[\w:.-]{1,120}$/i.test(id)) {throw new Error('map_element_id_invalid');}
    if (!options.allowReserved && isSeedLabelId(id)) {throw new Error(`map_element_id_reserved:${id}`);}
    return id;
}

function validateShapeConflict(id: string, shapeKeys: MapShapeKey[]) {
    const unique = [...new Set(shapeKeys)];
    if (!unique.length) {throw new Error(`map_element_shape_required:${id}`);}
    if (unique.length === 1) {return;}
    if (unique.length === 2 && unique.includes('text') && unique.some((shape) => MAP_GEOMETRY_KEYS.includes(shape))) {return;}
    throw new Error(`map_element_shape_conflict:${id}`);
}

function finalizeElement(
    element: Partial<TavernMapElement>,
    id: string,
    options: {
        allowReservedId?: boolean;
    } = {},
): TavernMapElement {
    const finalId = assertElementId(id, { allowReserved: options.allowReservedId === true });
    const shape = shapeKeyForElement(element);
    if (!shape) {throw new Error(`map_element_shape_required:${finalId}`);}
    const at = pointOrThrow(element.at, `map_element_at_required:${finalId}`);
    const cat = normalizeCategory(element.cat, defaultCategoryForShape(shape));
    const next: TavernMapElement = {
        id: finalId,
        at,
        cat,
    };
    if (element.rect) {
        const rect = numberPair(element.rect);
        if (!rect || rect[0] <= 0 || rect[1] <= 0) {throw new Error(`map_element_rect_invalid:${finalId}`);}
        next.rect = rect;
    }
    if (typeof element.circle === 'number') {
        if (!(element.circle > 0)) {throw new Error(`map_element_radius_required:${finalId}`);}
        next.circle = element.circle;
    }
    if (element.path) {
        next.path = pointListOrThrow(element.path, `map_element_points_required:${finalId}`, 2);
    }
    if (element.curve) {
        next.curve = pointListOrThrow(element.curve, `map_element_points_required:${finalId}`, 2);
    }
    if (element.icon) {
        const icon = normalizeIcon(element.icon);
        if (!icon) {throw new Error(`map_element_icon_invalid:${finalId}`);}
        next.icon = icon;
    }
    if (element.text !== undefined) {
        const text = normalizeText(element.text, 240);
        if (!text) {throw new Error(`map_element_text_required:${finalId}`);}
        next.text = text;
    }
    if (element.closed === true) {next.closed = true;}
    if (normalizeText(element.fill, 120)) {next.fill = normalizeText(element.fill, 120);}
    if (element.style !== undefined) {
        const style = normalizeStyle(element.style);
        if (style) {next.style = style;}
    }
    return next;
}

function normalizeMapElementInput(
    value: unknown,
    options: {
        forcedId?: string;
        allowReservedId?: boolean;
        splitGeometryText?: boolean;
        source?: NormalizeSource;
    } = {},
): TavernMapElement[] {
    if (!isPlainObject(value)) {throw new Error('map_element_must_be_object');}
    const source = options.source || 'model-input';
    const rawId = options.forcedId || String(value.id || '').trim();
    const id = assertElementId(rawId, {
        allowReserved: options.allowReservedId === true || source === 'stored-document',
    });
    let at = normalizePoint(value.at ?? value.pos ?? value.center ?? value.position);
    if (!at && (value.x !== undefined || value.y !== undefined)) {
        at = normalizePoint({ x: value.x, y: value.y });
    }
    if (!at && (value.cx !== undefined || value.cy !== undefined)) {
        at = normalizePoint({ x: value.cx, y: value.cy });
    }

    const shapeParts: Partial<TavernMapElement> = {};
    const legacyType = String(value.type || '').trim();

    const rect = numberPair(value.rect ?? value.size ?? (value.width !== undefined || value.height !== undefined ? [value.width, value.height] : null));
    if (rect) {shapeParts.rect = rect;}

    const circle = legacyType === 'arc' ? null : positiveNumber(value.circle ?? value.r ?? value.radius);
    if (circle !== null) {shapeParts.circle = circle;}

    const pathSource = value.path ?? value.points ?? value.line
        ?? ((value.x1 !== undefined || value.y1 !== undefined || value.x2 !== undefined || value.y2 !== undefined)
            ? [[value.x1, value.y1], [value.x2, value.y2]]
            : null);
    const curveSource = value.curve;

    const textValue = normalizeText(value.text ?? value.content ?? value.label ?? value.value, 240);
    if (textValue) {shapeParts.text = textValue;}

    const icon = normalizeIcon(value.icon);
    if (icon) {shapeParts.icon = icon;}

    if (legacyType === 'line' && pathSource) {
        const normalized = normalizePathLikePoints(pathSource, id, at);
        at = normalized.at;
        shapeParts.path = normalized.points;
    } else if (legacyType === 'curve' && (curveSource ?? pathSource)) {
        const normalized = normalizePathLikePoints(curveSource ?? pathSource, id, at);
        at = normalized.at;
        shapeParts.curve = normalized.points;
    } else if (legacyType === 'fill' && pathSource) {
        const normalized = normalizePathLikePoints(pathSource, id, at);
        at = normalized.at;
        shapeParts.path = normalized.points;
        shapeParts.closed = true;
        if (normalizeText(value.fill, 120)) {shapeParts.fill = normalizeText(value.fill, 120);}
    } else if (legacyType === 'arc') {
        const normalized = normalizePathLikePoints(arcToCurvePoints(value, id), id, at);
        at = normalized.at;
        shapeParts.curve = normalized.points;
    } else {
        if (pathSource && !shapeParts.path && !shapeParts.curve) {
            const normalized = normalizePathLikePoints(pathSource, id, at);
            at = normalized.at;
            shapeParts.path = normalized.points;
        }
        if (curveSource && !shapeParts.curve) {
            const normalized = normalizePathLikePoints(curveSource, id, at);
            at = normalized.at;
            shapeParts.curve = normalized.points;
        }
    }

    const shapeKeys = MAP_SHAPE_KEYS.filter((key) => {
        if (key === 'circle') {return typeof shapeParts.circle === 'number';}
        if (key === 'text') {return typeof shapeParts.text === 'string' && !!shapeParts.text.trim();}
        return key in shapeParts;
    });
    validateShapeConflict(id, shapeKeys);

    const cat = normalizeCategory(value.cat, defaultCategoryForShape(shapeKeys.find((key) => key !== 'text') || shapeKeys[0] || null));
    const base: Partial<TavernMapElement> = {
        id,
        at: at || undefined,
        cat,
        closed: value.closed === true || shapeParts.closed === true,
        fill: normalizeText(value.fill ?? shapeParts.fill, 120) || undefined,
        style: normalizeStyle(value.style),
        ...shapeParts,
    };

    if (shapeKeys.length === 2 && options.splitGeometryText !== false) {
        const geometryKey = shapeKeys.find((key) => key !== 'text') as MapShapeKey;
        const geometry: Partial<TavernMapElement> = {
            id,
            at: base.at,
            cat: normalizeCategory(value.cat, defaultCategoryForShape(geometryKey)),
            closed: base.closed,
            fill: base.fill,
            style: base.style,
            [geometryKey]: base[geometryKey],
        };
        const geometryElement = finalizeElement(geometry, id, { allowReservedId: options.allowReservedId === true || source === 'stored-document' });
        const labelId = buildSeedLabelId(id);
        const labelElement = finalizeElement({
            id: labelId,
            at: labelPositionForElement(geometryElement),
            cat: 'label',
            text: base.text,
        }, labelId, { allowReservedId: true });
        return [geometryElement, labelElement];
    }

    return [finalizeElement(base, id, { allowReservedId: options.allowReservedId === true || source === 'stored-document' })];
}

function normalizeMapDocument(
    value: unknown,
    fallback: Partial<TavernMapDocumentMeta> = {},
    normalizeSource: NormalizeSource = 'stored-document',
): TavernMapDocument {
    const raw = isPlainObject(value) ? value : {};
    const meta = normalizeMapMeta(raw.meta, fallback);
    const elements = Array.isArray(raw.elements)
        ? raw.elements.flatMap((element) => normalizeMapElementInput(element, { source: normalizeSource }))
        : [];
    if (elements.length > MAX_MAP_ELEMENTS) {throw new Error('map_elements_limit_exceeded');}
    const ids = new Set<string>();
    elements.forEach((element) => {
        if (ids.has(element.id)) {throw new Error(`map_element_duplicate:${element.id}`);}
        ids.add(element.id);
    });
    return { meta, elements };
}

function defaultMapDocument(): TavernMapDocument {
    return normalizeMapDocument(createSeedMapDocument(), createSeedMapDocument().meta, 'stored-document');
}

function normalizeMapDocumentFromRecord(document: TavernStructuredStateDocumentRecord | null): TavernMapDocument {
    if (!document?.data) {return defaultMapDocument();}
    return normalizeMapDocument(document.data, createSeedMapDocument().meta, 'stored-document');
}

function createMapDigest(document: TavernMapDocument, revision = 0): string {
    if (document.meta.status !== 'active' || !hasSpatialMapContent(document.elements)) {return '';}
    const title = normalizeText(document.meta.name || 'Map', 80) || 'Map';
    const byCat = new Map<string, TavernMapElement[]>();
    document.elements.forEach((element) => {
        const group = byCat.get(element.cat) || [];
        group.push(element);
        byCat.set(element.cat, group);
    });
    const labels = document.elements
        .filter((element) => typeof element.text === 'string' && element.text.trim())
        .map((element) => normalizeText(element.text, 40))
        .filter(Boolean)
        .slice(0, 8);
    const doors = (byCat.get('door') || []).map((element) => element.id).slice(0, 8);
    const dangers = (byCat.get('danger') || []).map((element) => element.id).slice(0, 8);
    return [
        `Map: ${title} (revision ${revision}, ${document.elements.length} elements)`,
        labels.length ? `Labels: ${labels.join(', ')}` : '',
        doors.length ? `Doors/Routes: ${doors.join(', ')}` : '',
        dangers.length ? `Danger/Markers: ${dangers.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

function mapTitle(document: TavernMapDocument): string {
    return normalizeText(document.meta.name || 'Map', 120) || 'Map';
}

function mapElementSummary(element: TavernMapElement): TavernMapElement {
    return cloneJson(element);
}

function describeMapPatchError(error = ''): string {
    const [code, rawId = 'element'] = String(error || '').split(':');
    const id = rawId || 'element';
    switch (code) {
    case 'map_element_id_invalid':
        return 'Invalid element id. Use a short stable id containing only letters, numbers, underscores, dots, colons, and hyphens.';
    case 'map_element_id_reserved':
        return `${id} uses the reserved \`__label__\` prefix. Use a normal id instead.`;
    case 'map_element_at_required':
        return `${id} is missing a position. Provide \`at:[x,y]\`. Legacy aliases such as pos/center/x+y are also accepted.`;
    case 'map_element_rect_invalid':
        return `${id} has an invalid rect. Use positive dimensions such as \`rect:[120,80]\`.`;
    case 'map_element_radius_required':
        return `${id} is missing a valid radius. \`circle\` must be a number greater than 0.`;
    case 'map_element_points_required':
        return `${id} is missing a valid point array. \`path\` and \`curve\` need at least two points. With \`at\`, points are relative offsets; without \`at\`, the first point becomes the anchor.`;
    case 'map_element_text_required':
        return `${id} is missing text content. \`text\` must be a short non-empty label.`;
    case 'map_element_icon_invalid':
        return `${id} has an invalid icon. Use one of x/o/+/star/tree/skull/arrow-n/arrow-s/arrow-e/arrow-w/stairs-up/stairs-down.`;
    case 'map_element_shape_required':
        return `${id} is missing a shape field. Every element must provide exactly one of rect/circle/path/curve/icon/text.`;
    case 'map_element_shape_conflict':
        return `${id} has multiple shape fields. Only the special "geometry + text" input is allowed, and it will be split into a derived label automatically.`;
    case 'map_element_duplicate':
        return `${id} is duplicated. Use a stable unique id.`;
    case 'map_element_not_found':
        return `${id} does not exist. Use StateRead summary/elements first to find existing ids.`;
    case 'map_element_already_exists':
        return `${id} already exists. Use \`modify\` to change it. If it is already identical, do not repeat the \`add\`.`;
    case 'map_element_id_cannot_change':
        return `${id} cannot change id inside a \`modify\` op.`;
    case 'map_meta_set_required':
        return '`meta` requires a `set` object.';
    case 'map_modify_set_required':
        return `${id} is missing a \`set\` object. \`modify\` requires \`set\`.`;
    case 'map_op_not_supported':
        return `Unsupported op: ${id}. Supported canonical ops are meta/add/modify/remove. Legacy init/reset/replace input is still absorbed at runtime.`;
    case 'map_element_center_required':
        return `${id} is missing a center point.`;
    case 'map_element_arc_angles_required':
        return `${id} is missing arc start/end angles.`;
    default:
        return error;
    }
}

function summarizePatchFailures(failed: Array<{ index: number; error: string; hint?: string }>): string {
    const head = failed.slice(0, 3).map((item) => {
        const position = item.index >= 0 ? `op ${item.index + 1}` : 'transaction';
        return `${position}: ${item.hint || describeMapPatchError(item.error) || item.error}`;
    });
    const more = failed.length > head.length ? `; plus ${failed.length - head.length} more failures` : '';
    return head.length ? `${head.join('; ')}${more}` : '';
}

function enforceRenderableMapState(document: TavernMapDocument, warnings: string[] = []): {
    document: TavernMapDocument;
    statusChanged: boolean;
} {
    const hasSpatial = hasSpatialMapContent(document.elements);
    if (hasSpatial) {
        if (document.meta.status === 'uninitialized') {
            return {
                document: {
                    ...document,
                    meta: mergeMapMeta(document.meta, { status: 'active' }),
                },
                statusChanged: true,
            };
        }
        return { document, statusChanged: false };
    }
    if (document.meta.status === 'active') {
        warnings.push('Map stays uninitialized: it needs at least one spatial geometry element. Name, viewBox, or text labels alone are not enough.');
        return {
            document: {
                ...document,
                meta: mergeMapMeta(document.meta, { status: 'uninitialized' }),
            },
            statusChanged: true,
        };
    }
    return { document, statusChanged: false };
}

function summarizeMapElements(document: TavernMapDocument, args: Record<string, unknown> = {}): {
    elements: TavernMapElement[];
    count: number;
    truncated: boolean;
    nextOffset: number;
} {
    const query = normalizeText(args.query, 120).toLowerCase();
    const shape = String(args.elementType || args.type || '').trim();
    const category = String(args.category || args.cat || '').trim();
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Math.min(MAX_STATE_READ_LIMIT, Number(args.limit) || 30));
    const matches = document.elements.filter((element) => {
        const elementShape = shapeKeyForElement(element) || '';
        if (shape && elementShape !== shape) {return false;}
        if (category && element.cat !== category) {return false;}
        if (!query) {return true;}
        const haystack = [
            element.id,
            element.cat,
            elementShape,
            element.text,
            element.icon,
        ].map((item) => String(item || '').toLowerCase()).join('\n');
        return haystack.includes(query);
    });
    const page = matches.slice(offset, offset + limit).map(mapElementSummary);
    const nextOffset = offset + page.length < matches.length ? offset + page.length : 0;
    return {
        elements: page,
        count: matches.length,
        truncated: nextOffset > 0,
        nextOffset,
    };
}

function normalizePartialSet(value: unknown, id: string): Partial<TavernMapElement> {
    if (!isPlainObject(value)) {throw new Error(`map_modify_set_required:${id}`);}
    const set: Partial<TavernMapElement> = {};
    if ('id' in value && normalizeText(value.id, 120) && normalizeText(value.id, 120) !== id) {
        throw new Error(`map_element_id_cannot_change:${id}`);
    }
    if ('at' in value || 'pos' in value || 'center' in value || 'position' in value || 'x' in value || 'y' in value || 'cx' in value || 'cy' in value) {
        const point = normalizePoint(value.at ?? value.pos ?? value.center ?? value.position)
            || normalizePoint({ x: value.x, y: value.y })
            || normalizePoint({ x: value.cx, y: value.cy });
        if (!point) {throw new Error(`map_element_at_required:${id}`);}
        set.at = point;
    }
    if ('cat' in value) {
        set.cat = normalizeCategory(value.cat, 'wall');
    }
    if ('rect' in value || 'size' in value || 'width' in value || 'height' in value) {
        const rect = numberPair(value.rect ?? value.size ?? [value.width, value.height]);
        if (!rect || rect[0] <= 0 || rect[1] <= 0) {throw new Error(`map_element_rect_invalid:${id}`);}
        set.rect = rect;
    }
    if ('circle' in value || 'r' in value || 'radius' in value) {
        const circle = positiveNumber(value.circle ?? value.r ?? value.radius);
        if (circle === null) {throw new Error(`map_element_radius_required:${id}`);}
        set.circle = circle;
    }
    if ('path' in value || 'points' in value || 'line' in value) {
        const baseAt = set.at || null;
        const normalized = normalizePathLikePoints(value.path ?? value.points ?? value.line, id, baseAt);
        if (!set.at) {set.at = normalized.at;}
        set.path = normalized.points;
    }
    if ('curve' in value) {
        const baseAt = set.at || null;
        const normalized = normalizePathLikePoints(value.curve, id, baseAt);
        if (!set.at) {set.at = normalized.at;}
        set.curve = normalized.points;
    }
    if ('icon' in value) {
        const icon = normalizeIcon(value.icon);
        if (!icon) {throw new Error(`map_element_icon_invalid:${id}`);}
        set.icon = icon;
    }
    if ('text' in value || 'content' in value || 'label' in value || 'value' in value) {
        const text = normalizeText(value.text ?? value.content ?? value.label ?? value.value, 240);
        if (!text) {throw new Error(`map_element_text_required:${id}`);}
        set.text = text;
    }
    if ('closed' in value) {
        set.closed = value.closed === true;
    }
    if ('fill' in value) {
        set.fill = value.fill === null ? undefined : normalizeText(value.fill, 120) || undefined;
    }
    if ('style' in value) {
        set.style = value.style === null ? undefined : normalizeStyle(value.style);
    }
    const legacyType = String(value.type || '').trim();
    if (legacyType === 'fill' && !set.path) {
        const normalized = normalizePathLikePoints(value.points, id, set.at || null);
        set.at = normalized.at;
        set.path = normalized.points;
        set.closed = true;
    }
    if (legacyType === 'arc' && !set.curve) {
        const normalized = normalizePathLikePoints(arcToCurvePoints(value, id), id, set.at || null);
        set.at = normalized.at;
        set.curve = normalized.points;
    }
    return set;
}

function buildNextElement(current: TavernMapElement, set: Partial<TavernMapElement>): TavernMapElement {
    const next = mergeMapElementPatch(current, set);
    return finalizeElement(next, current.id, { allowReservedId: isSeedLabelId(current.id) });
}

async function getSeededMapDocumentRecord(
    sessionId = '',
    docType: TavernStructuredStateDocType = MAP_DOC_TYPE,
    docId = DEFAULT_DOC_ID,
): Promise<TavernStructuredStateDocumentRecord | null> {
    if (docType !== MAP_DOC_TYPE || docId !== DEFAULT_DOC_ID) {
        return await getTavernStructuredStateDocument(sessionId, docType, docId);
    }
    const existing = await getTavernStructuredStateDocument(sessionId, docType, docId);
    if (existing) {return existing;}
    return await ensureSeedStructuredStateDocument(sessionId, { touchSession: false });
}

function buildCanonicalFullReplaceOps(current: TavernMapDocument, next: TavernMapDocument): TavernMapPatchOp[] {
    const ops: TavernMapPatchOp[] = [];
    current.elements.forEach((element) => {
        ops.push({ op: 'remove', id: element.id, _internalSoft: true });
    });
    ops.push({
        op: 'meta',
        set: {
            name: next.meta.name,
            viewBox: next.meta.viewBox,
            theme: next.meta.theme,
            status: next.meta.status,
            hint: next.meta.hint,
        },
    });
    next.elements.forEach((element) => {
        ops.push({ op: 'add', element });
    });
    return ops;
}

function applyMapOps(source: TavernMapDocument, rawOps: unknown[]): {
    document: TavernMapDocument;
    effectiveOps: TavernMapPatchOp[];
    appliedCount: number;
    satisfiedCount: number;
    failed: Array<{ index: number; error: string; hint?: string }>;
    warnings: string[];
    changedIds: string[];
    removedElements: TavernMapElement[];
    changed: boolean;
} {
    if (!Array.isArray(rawOps)) {throw new Error('state_patch_ops_must_be_array');}
    if (!rawOps.length) {throw new Error('state_patch_ops_required');}
    if (rawOps.length > MAX_STATE_PATCH_OPS) {throw new Error('state_patch_ops_limit_exceeded');}

    let document = normalizeMapDocument(source, source.meta, 'stored-document');
    const effectiveOps: TavernMapPatchOp[] = [];
    const warnings: string[] = [];
    const changedIds = new Set<string>();
    const removedElements: TavernMapElement[] = [];
    const failed: Array<{ index: number; error: string; hint?: string }> = [];
    let appliedCount = 0;
    let satisfiedCount = 0;
    let changed = false;

    const findIndex = (id: string) => document.elements.findIndex((element) => element.id === id);

    const applyMeta = (set: Partial<TavernMapDocumentMeta>) => {
        const nextMeta = mergeMapMeta(document.meta, set);
        if (deepEqual(nextMeta, document.meta)) {
            satisfiedCount += 1;
            return;
        }
        document.meta = nextMeta;
        effectiveOps.push({ op: 'meta', set: cloneJson(set) });
        changed = true;
        appliedCount += 1;
        changedIds.add('meta');
    };

    const applyAdd = (element: TavernMapElement) => {
        const index = findIndex(element.id);
        if (index >= 0) {
            if (deepEqual(document.elements[index], element)) {
                satisfiedCount += 1;
                return;
            }
            throw new Error(`map_element_already_exists:${element.id}`);
        }
        document.elements.push(cloneJson(element));
        effectiveOps.push({ op: 'add', element: cloneJson(element) });
        changed = true;
        appliedCount += 1;
        changedIds.add(element.id);
    };

    const applyRemove = (id: string, options: { soft?: boolean; cascadeLabel?: boolean } = {}) => {
        const index = findIndex(id);
        if (index < 0) {
            if (options.soft) {
                satisfiedCount += 1;
                return;
            }
            throw new Error(`map_element_not_found:${id}`);
        }
        const [removed] = document.elements.splice(index, 1);
        removedElements.push(cloneJson(removed));
        effectiveOps.push({ op: 'remove', id, ...(options.soft ? { _internalSoft: true } : {}) });
        changed = true;
        appliedCount += 1;
        changedIds.add(id);
        if (options.cascadeLabel !== false && !isSeedLabelId(id)) {
            const labelId = buildSeedLabelId(id);
            if (findIndex(labelId) >= 0) {
                applyRemove(labelId, { soft: true, cascadeLabel: false });
            }
        }
    };

    const applyModify = (id: string, set: Partial<TavernMapElement>) => {
        const index = findIndex(id);
        if (index < 0) {throw new Error(`map_element_not_found:${id}`);}
        const current = document.elements[index];
        const next = buildNextElement(current, set);
        if (deepEqual(current, next)) {
            satisfiedCount += 1;
            return;
        }
        document.elements[index] = next;
        effectiveOps.push({ op: 'modify', id, set: cloneJson(set) });
        changed = true;
        appliedCount += 1;
        changedIds.add(id);

        if (!isSeedLabelId(id) && set.at && current.at) {
            const labelId = buildSeedLabelId(id);
            const labelIndex = findIndex(labelId);
            if (labelIndex >= 0) {
                const label = document.elements[labelIndex];
                const delta: [number, number] = [set.at[0] - current.at[0], set.at[1] - current.at[1]];
                if (delta[0] || delta[1]) {
                    const labelAt: [number, number] = [
                        Number((label.at[0] + delta[0]).toFixed(2)),
                        Number((label.at[1] + delta[1]).toFixed(2)),
                    ];
                    const moved = buildNextElement(label, { at: labelAt });
                    document.elements[labelIndex] = moved;
                    effectiveOps.push({ op: 'modify', id: labelId, set: { at: labelAt } });
                    changedIds.add(labelId);
                }
            }
        }
    };

    for (let index = 0; index < rawOps.length; index += 1) {
        const rawOp = rawOps[index];
        try {
            if (!isPlainObject(rawOp)) {throw new Error('op_must_be_object');}
            const op = String(rawOp.op || '').trim();
            if (!op) {throw new Error('map_op_not_supported:empty');}

            if (op === 'meta') {
                applyMeta(normalizeMetaSet(rawOp.set ?? rawOp.changes ?? rawOp.meta));
                continue;
            }

            if (op === 'add') {
                const elements = normalizeMapElementInput(rawOp.element ?? rawOp, { source: 'model-input' });
                elements.forEach((element) => applyAdd(element));
                continue;
            }

            if (op === 'remove') {
                const id = normalizeText(rawOp.id, 120);
                if (!id) {throw new Error('map_element_id_invalid');}
                applyRemove(id);
                continue;
            }

            if (op === 'modify') {
                const id = normalizeText(rawOp.id, 120);
                if (!id) {throw new Error('map_element_id_invalid');}
                applyModify(id, normalizePartialSet(rawOp.set ?? rawOp.changes, id));
                continue;
            }

            if (op === 'replace') {
                const id = normalizeText(rawOp.id, 120);
                if (!id) {throw new Error('map_element_id_invalid');}
                if (findIndex(id) < 0) {throw new Error(`map_element_not_found:${id}`);}
                applyRemove(id, { cascadeLabel: true });
                normalizeMapElementInput(rawOp.element, { forcedId: id, source: 'model-input' }).forEach((element) => applyAdd(element));
                continue;
            }

            if (op === 'init' || op === 'reset') {
                const next = normalizeMapDocument(rawOp.document || {
                    meta: {
                        ...(isPlainObject(rawOp.meta) ? rawOp.meta : {}),
                        status: 'active',
                    },
                    elements: rawOp.elements,
                }, {
                    ...document.meta,
                    status: 'active',
                    hint: document.meta.hint,
                }, 'model-input');
                if (op === 'init' && document.meta.status === 'active' && document.elements.length && rawOp.replaceDocument !== true) {
                    throw new Error('state_init_existing_document_requires_reset');
                }
                buildCanonicalFullReplaceOps(document, next).forEach((canonicalOp) => {
                    if (canonicalOp.op === 'meta') {applyMeta(canonicalOp.set);}
                    else if (canonicalOp.op === 'add') {applyAdd(canonicalOp.element);}
                    else if (canonicalOp.op === 'remove') {applyRemove(canonicalOp.id, { soft: canonicalOp._internalSoft === true, cascadeLabel: false });}
                });
                continue;
            }

            throw new Error(`map_op_not_supported:${op}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error || 'map_op_failed');
            failed.push({ index, error: message, hint: describeMapPatchError(message) });
            break;
        }
    }

    if (!failed.length) {
        const enforced = enforceRenderableMapState(document, warnings);
        document = enforced.document;
        if (enforced.statusChanged) {
            effectiveOps.push({ op: 'meta', set: { status: document.meta.status } });
            changed = true;
            changedIds.add('meta');
        }
    }

    if (!failed.length && document.elements.length > MAX_MAP_ELEMENTS) {
        failed.push({ index: -1, error: 'map_elements_limit_exceeded', hint: `Map has more than ${MAX_MAP_ELEMENTS} elements. Split or reduce the element count.` });
    }

    return {
        document,
        effectiveOps,
        appliedCount,
        satisfiedCount,
        failed,
        warnings,
        changedIds: [...changedIds],
        removedElements,
        changed,
    };
}

function buildMapElementSchema() {
    return {
        type: 'object',
        description: 'One map element. It must have `id` and `cat`, plus exactly one shape field: `rect`, `circle`, `path`, `curve`, `icon`, or `text`. Most elements use `at:[x,y]`; `path` and `curve` may omit `at` and let the first point become the anchor.',
        properties: {
            id: {
                type: 'string',
                description: 'Stable unique id. Do not use the reserved `__label__` prefix.',
            },
            at: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: 'Anchor coordinate `[x,y]`. Most elements should provide `at`; `path` and `curve` may omit it and use the first point as the anchor. North = smaller y, south = larger y, west = smaller x, east = larger x.',
            },
            cat: {
                type: 'string',
                enum: [...MAP_ELEMENT_CATEGORIES],
                description: 'Semantic category such as wall, door, marker, terrain, road, or label.',
            },
            rect: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: 'Rectangle `[width,height]`. The top-left corner is at `at`.',
            },
            circle: {
                type: 'number',
                description: 'Circle radius. The center is at `at`.',
            },
            path: {
                type: 'array',
                items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                description: 'Polyline point array. With `at`, points are relative offsets. Without `at`, points are absolute coordinates and the first point becomes the anchor.',
            },
            curve: {
                type: 'array',
                items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                description: 'Smooth curve point array. The anchor and relative/absolute rules are the same as `path`.',
            },
            icon: {
                type: 'string',
                enum: [...MAP_ICON_NAMES],
                description: 'Named icon marker.',
            },
            text: {
                type: 'string',
                description: 'Short label text. If you provide text together with geometry in an add input, the runtime will split the text into a derived label element automatically.',
            },
            closed: { type: 'boolean', description: 'Whether a path or curve should be closed.' },
            fill: { type: 'string', description: 'Fill token or color name for closed shapes.' },
            style: {
                type: 'object',
                description: 'Optional visual style overrides.',
                properties: {
                    color: { type: 'string', description: 'Stroke or text color.' },
                    width: { type: 'number', description: 'Stroke width.' },
                    dash: { type: 'string', description: 'Dash pattern string.' },
                },
                additionalProperties: false,
            },
        },
        required: ['id', 'cat'],
        additionalProperties: false,
    };
}

export function getTavernStateToolDefinitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    const mapElementSchema = buildMapElementSchema();
    return [
        {
            type: 'function',
            function: {
                name: TAVERN_STATE_TOOL_NAMES.LIST,
                description: [
                    'List structured state documents in the current session.',
                    'Returns document entries only. It does not read full state, elements, or patch history.',
                    'Use before StateRead when you need available structured documents such as `tavern.map/main`.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        docType: { type: 'string', enum: [MAP_DOC_TYPE], description: 'Optional structured document type filter. Currently `tavern.map`.' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TAVERN_STATE_TOOL_NAMES.READ,
                description: [
                    'Read a structured state document in the current session.',
                    'Use `summary` first. It returns the revision plus compact meta fields: status, name, viewBox, theme, hint, and digest.',
                    'For tavern maps, the default document is `tavern.map/main`. New sessions already include a seed map, so this document is readable even before first initialization.',
                    'Use `elements` to browse or filter map elements, `element` for one stable id, `document` for the full current state, and `history` for saved patch transactions.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        docType: { type: 'string', enum: [MAP_DOC_TYPE], description: 'Structured document type. Currently `tavern.map`.' },
                        docId: { type: 'string', description: 'Structured document id. Defaults to `main` for tavern maps.' },
                        mode: { type: 'string', enum: ['summary', 'elements', 'document', 'element', 'history'], description: '`summary` returns compact meta, `elements` pages/filter element summaries, `document` returns the full state, `element` returns one exact id, and `history` returns saved patch transactions.' },
                        elementId: { type: 'string', description: 'Required for `element` mode. Exact element id to read.' },
                        elementType: { type: 'string', enum: [...MAP_SHAPE_KEYS], description: 'Optional `elements`-mode shape filter such as rect, circle, path, curve, icon, or text.' },
                        category: { type: 'string', enum: [...MAP_ELEMENT_CATEGORIES], description: 'Optional `elements`-mode category filter such as wall, door, marker, terrain, road, or label.' },
                        query: { type: 'string', description: 'Optional `elements`-mode text query matched against id, category, shape, icon, and label text.' },
                        offset: { type: 'number', minimum: 0, description: 'Pagination offset for `elements` or `history` results. Default 0.' },
                        limit: { type: 'number', minimum: 1, maximum: MAX_STATE_READ_LIMIT, description: 'Maximum `elements` or `history` results to return. Default 30 for `elements`, 20 for `history`.' },
                        tail: { type: 'number', minimum: 1, maximum: MAX_STATE_READ_LIMIT, description: 'For `history` mode, return the final N patch transactions.' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TAVERN_STATE_TOOL_NAMES.PATCH,
                description: [
                    'Apply map patch transactions to the current session.',
                    'Canonical ops are `meta`, `add`, `modify`, and `remove`. One StatePatch call is one atomic transaction and becomes exactly one revision when it saves.',
                    'Use `meta` to update document fields such as name, viewBox, theme, status, or hint. Use `add` to create elements, `modify` to change existing ids, and `remove` to delete ids.',
                    'Each element has `id` and `cat`, plus exactly one shape field: `rect`, `circle`, `path`, `curve`, `icon`, or `text`. Most elements use `at:[x,y]`; `path` and `curve` may omit `at` and use the first point as the anchor.',
                    'With `at`, `path` and `curve` points are relative offsets. Without `at`, the points are treated as absolute coordinates and the stored result becomes relative to the first point.',
                    'If one add element contains geometry plus text, the runtime splits the text into a system label element automatically.',
                    '`meta.viewBox` is the camera. Changing it does not move elements. Move actors by changing their `at`, then adjust `viewBox` only if the camera should follow.',
                    'Legacy `init`, `reset`, and `replace` input is still absorbed at runtime, but do not rely on it in new calls.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        docType: { type: 'string', enum: [MAP_DOC_TYPE], description: 'Structured document type. Currently `tavern.map`.' },
                        docId: { type: 'string', description: 'Structured document id. Defaults to `main` for tavern maps.' },
                        baseRevision: { type: 'number', description: 'Optional optimistic revision check from StateRead summary/document.' },
                        dryRun: { type: 'boolean', description: 'Validate and simulate the transaction without saving or incrementing the revision.' },
                        desc: { type: 'string', description: 'Short one-line summary of this turn’s spatial update.' },
                        ops: {
                            type: 'array',
                            description: 'Patch ops as one atomic transaction. Use canonical `meta`, `add`, `modify`, or `remove` ops.',
                            items: {
                                type: 'object',
                                properties: {
                                    op: { type: 'string', enum: ['meta', 'add', 'modify', 'remove'], description: 'Operation type. Use `meta` for document fields, `add` for a new element, `modify` for an existing id, and `remove` for an existing id.' },
                                    id: { type: 'string', description: 'Exact element id for `modify` or `remove`.' },
                                    set: { type: 'object', description: 'For `meta`, the meta fields to update. For `modify`, the partial element fields to change. Shape-field changes replace the previous shape; `style` merges by field.' },
                                    element: { ...mapElementSchema, description: 'Full element object for `add`.' },
                                },
                                required: ['op'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['ops'],
                    additionalProperties: false,
                },
            },
        },
    ];
}

export async function executeTavernStateTool(
    sessionId = '',
    toolName = '',
    args: Record<string, unknown> = {},
    options: {
        caller?: TavernStateToolCaller;
        managerRunId?: string;
        sourceUserOrder?: number;
        sourceAssistantOrder?: number;
        beforeWriteGuard?: () => Promise<void> | void;
    } = {},
): Promise<TavernStateToolResult> {
    const id = String(sessionId || '').trim();
    if (!id) {return { ok: false, summary: 'Missing sessionId.', error: 'state_session_required' };}
    try {
        const docType = normalizeDocType(args.docType || MAP_DOC_TYPE);
        const docId = normalizeDocId(args.docId || DEFAULT_DOC_ID);

        if (toolName === TAVERN_STATE_TOOL_NAMES.LIST) {
            const documents = await listTavernStructuredStateDocuments(id, { docType, includeStale: true });
            return {
                ok: true,
                summary: `Found ${documents.length} structured state document(s).`,
                count: documents.length,
                documents: documents.map((document) => ({
                    docType: document.docType,
                    docId: document.docId,
                    title: document.title,
                    revision: document.revision,
                    digest: document.digest,
                    status: document.status,
                    updatedAt: document.updatedAt,
                })),
            };
        }

        if (toolName === TAVERN_STATE_TOOL_NAMES.READ) {
            const mode = String(args.mode || 'summary').trim() || 'summary';
            const record = await getSeededMapDocumentRecord(id, docType, docId);
            if (!record) {
                return { ok: false, summary: `${docType}/${docId} does not exist.`, docType, docId, error: 'state_document_not_found' };
            }
            const document = normalizeMapDocumentFromRecord(record);
            if (mode === 'summary') {
                return {
                    ok: true,
                    summary: `Read summary for ${record.title || docId}, revision ${record.revision}, status ${document.meta.status}.`,
                    docType,
                    docId,
                    title: record.title,
                    revision: record.revision,
                    digest: record.digest,
                    meta: cloneJson(document.meta),
                    elementCount: document.elements.length,
                };
            }
            if (mode === 'document') {
                return {
                    ok: true,
                    summary: `Read full state for ${record.title || docId}, revision ${record.revision}.`,
                    docType,
                    docId,
                    title: record.title,
                    revision: record.revision,
                    digest: record.digest,
                    meta: cloneJson(document.meta),
                    elementCount: document.elements.length,
                    document,
                };
            }
            if (mode === 'element') {
                const elementId = normalizeText(args.elementId, 120);
                if (!elementId) {return { ok: false, summary: 'Missing elementId.', docType, docId, error: 'state_element_id_required' };}
                const element = document.elements.find((item) => item.id === elementId);
                if (!element) {return { ok: false, summary: `${elementId} does not exist.`, docType, docId, revision: record.revision, error: 'state_element_not_found' };}
                return {
                    ok: true,
                    summary: `Read element ${elementId}.`,
                    docType,
                    docId,
                    revision: record.revision,
                    element: mapElementSummary(element),
                };
            }
            if (mode === 'elements') {
                const result = summarizeMapElements(document, args);
                return {
                    ok: true,
                    summary: `Matched ${result.count} map element(s); returned ${result.elements.length}.`,
                    docType,
                    docId,
                    revision: record.revision,
                    count: result.count,
                    truncated: result.truncated,
                    nextOffset: result.nextOffset,
                    elements: result.elements,
                };
            }
            if (mode === 'history') {
                const patches = await listTavernStructuredStatePatches({ sessionId: id, docType, docId });
                const tail = Math.max(0, Number(args.tail) || 0);
                const limit = Math.max(1, Math.min(MAX_STATE_READ_LIMIT, Number(args.limit) || 20));
                const offset = Math.max(0, Number(args.offset) || 0);
                const start = tail > 0 ? Math.max(0, patches.length - Math.min(MAX_STATE_READ_LIMIT, tail)) : offset;
                const page = patches.slice(start, start + (tail > 0 ? Math.min(MAX_STATE_READ_LIMIT, tail) : limit));
                const nextOffset = start + page.length < patches.length ? start + page.length : 0;
                return {
                    ok: true,
                    summary: `Found ${patches.length} saved patch transaction(s); returned ${page.length}.`,
                    docType,
                    docId,
                    revision: record.revision,
                    count: patches.length,
                    truncated: nextOffset > 0,
                    nextOffset,
                    patches: page,
                };
            }
            return { ok: false, summary: `Unsupported StateRead mode: ${mode}`, docType, docId, error: 'state_read_mode_invalid' };
        }

        if (toolName === TAVERN_STATE_TOOL_NAMES.PATCH) {
            if (!Array.isArray(args.ops)) {
                return { ok: false, summary: 'StatePatch ops must be a real array.', docType, docId, error: 'state_patch_ops_must_be_array' };
            }
            await options.beforeWriteGuard?.();
            return await db.transaction(
                'rw',
                tavernStateDocumentsTable,
                tavernStatePatchesTable,
                tavernManagerStateSnapshotsTable,
                tavernSessionsTable,
                async () => {
                    const existing = await getTavernStructuredStateDocument(id, docType, docId);
                    const currentRevision = Number(existing?.revision) || 0;
                    if (Number.isFinite(Number(args.baseRevision)) && Number(args.baseRevision) !== currentRevision) {
                        return {
                            ok: false,
                            summary: `Revision changed: current is ${currentRevision}, but this call was based on ${Number(args.baseRevision)}. Run StateRead again before patching.`,
                            docType,
                            docId,
                            revision: currentRevision,
                            error: 'state_revision_conflict',
                        };
                    }

                    const currentDocument = existing ? normalizeMapDocumentFromRecord(existing) : defaultMapDocument();
                    const patch = applyMapOps(currentDocument, args.ops as unknown[]);
                    if (patch.failed.length) {
                        const failureSummary = summarizePatchFailures(patch.failed);
                        return {
                            ok: false,
                            summary: `StatePatch was not saved: ${patch.failed.length} op(s) failed.${failureSummary ? ` ${failureSummary}` : ''}`,
                            docType,
                            docId,
                            revision: currentRevision,
                            changed: false,
                            appliedCount: 0,
                            satisfiedCount: patch.satisfiedCount,
                            failedCount: patch.failed.length,
                            warnings: patch.warnings,
                            error: 'state_patch_failed',
                            details: patch.failed,
                        };
                    }
                    if (!patch.changed) {
                        return {
                            ok: true,
                            summary: 'State is already at the target result. No write was needed.',
                            docType,
                            docId,
                            revision: currentRevision,
                            changed: false,
                            appliedCount: 0,
                            satisfiedCount: patch.satisfiedCount,
                            failedCount: 0,
                            warnings: patch.warnings,
                        };
                    }

                    const nextRevision = currentRevision + 1;
                    const digest = createMapDigest(patch.document, nextRevision);
                    if (args.dryRun === true) {
                        return {
                            ok: true,
                            summary: `Dry run passed: ${docType}/${docId} would advance to revision ${nextRevision} with ${patch.appliedCount} applied op(s). Nothing was saved.`,
                            docType,
                            docId,
                            title: mapTitle(patch.document),
                            revision: currentRevision,
                            digest,
                            changed: true,
                            appliedCount: patch.appliedCount,
                            satisfiedCount: patch.satisfiedCount,
                            failedCount: 0,
                            changedIds: patch.changedIds,
                            removedElements: patch.removedElements,
                            warnings: patch.warnings,
                            meta: cloneJson(patch.document.meta),
                            elementCount: patch.document.elements.length,
                        };
                    }

                    if (options.managerRunId) {
                        await ensureTavernManagerStateSnapshot({ managerRunId: options.managerRunId, sessionId: id, docType, docId });
                    }
                    const timestamp = now();
                    const saved = await putTavernStructuredStateDocument({
                        sessionId: id,
                        docType,
                        docId,
                        title: mapTitle(patch.document),
                        revision: nextRevision,
                        data: patch.document,
                        digest,
                        status: 'active',
                        source: options.caller || 'auto',
                        createdAt: Number(existing?.createdAt) || timestamp,
                        updatedAt: timestamp,
                    });
                    await appendTavernStructuredStatePatch({
                        sessionId: id,
                        docType,
                        docId,
                        revision: nextRevision,
                        status: 'active',
                        managerRunId: options.managerRunId,
                        sourceUserOrder: options.sourceUserOrder,
                        sourceAssistantOrder: options.sourceAssistantOrder,
                        source: options.caller || 'auto',
                        summary: normalizeText(args.desc || `StatePatch ${nextRevision}`, 400),
                        ops: patch.effectiveOps,
                        changedIds: patch.changedIds,
                        removedElements: patch.removedElements,
                    });
                    if (options.managerRunId) {
                        await updateTavernManagerStateSnapshotAfter({ managerRunId: options.managerRunId, sessionId: id, docType, docId });
                    }
                    return {
                        ok: true,
                        summary: `Updated ${docType}/${docId} to revision ${saved.revision} with ${patch.appliedCount} applied op(s).`,
                        docType,
                        docId,
                        title: saved.title,
                        revision: saved.revision,
                        digest: saved.digest,
                        changed: true,
                        appliedCount: patch.appliedCount,
                        satisfiedCount: patch.satisfiedCount,
                        failedCount: 0,
                        changedIds: patch.changedIds,
                        removedElements: patch.removedElements,
                        warnings: patch.warnings,
                        meta: cloneJson(patch.document.meta),
                        elementCount: patch.document.elements.length,
                    };
                },
            );
        }

        return { ok: false, summary: `${toolName} is not available.`, error: 'state_tool_not_available' };
    } catch (error) {
        const name = error instanceof Error ? error.name : '';
        const message = error instanceof Error ? error.message : String(error || 'state_tool_failed');
        if (name === 'AbortError' || message === 'manager_source_messages_changed' || message === 'manager_aborted') {
            throw error;
        }
        return {
            ok: false,
            summary: describeMapPatchError(message) || message,
            error: message,
        };
    }
}

export async function getTavernMapStateForSession(sessionId = ''): Promise<{
    document: TavernStructuredStateDocumentRecord | null;
    patches: TavernStructuredStatePatchRecord[];
}> {
    const record = await getSeededMapDocumentRecord(sessionId, MAP_DOC_TYPE, DEFAULT_DOC_ID);
    const normalizedDocument = record ? normalizeMapDocumentFromRecord(record) : null;
    const patches = record
        ? await listTavernStructuredStatePatches({ sessionId, docType: MAP_DOC_TYPE, docId: DEFAULT_DOC_ID, limit: 80 })
        : [];
    if (!record || !normalizedDocument) {return { document: null, patches: [] };}
    return {
        document: {
            ...record,
            data: normalizedDocument,
            title: mapTitle(normalizedDocument),
            digest: createMapDigest(normalizedDocument, record.revision),
        },
        patches,
    };
}

export async function listTavernStructuredStateDigests(sessionId = '') {
    const documents = await listTavernStructuredStateDocuments(sessionId, { includeStale: false });
    return documents
        .map((document) => ({
            record: document,
            normalized: normalizeMapDocumentFromRecord(document),
        }))
        .filter(({ normalized }) => normalized.meta.status === 'active' && !isUninitializedMapData(normalized))
        .map(({ record, normalized }) => ({
            docType: record.docType,
            docId: record.docId,
            title: mapTitle(normalized),
            revision: record.revision,
            digest: createMapDigest(normalized, record.revision),
        }));
}
