import db, {
    appendTavernStructuredStatePatch,
    ensureSeedStructuredStateDocument,
    getTavernStructuredStateDocument,
    listTavernStructuredStateDocuments,
    listTavernStructuredStatePatches,
    putTavernStructuredStateDocument,
    tavernMessagesTable,
    tavernSessionsTable,
    tavernStateDocumentsTable,
    tavernStatePatchesTable,
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
import {
    createSeedAtlasDocument,
    TAVERN_ATLAS_DOC_ID,
    TAVERN_ATLAS_DOC_TYPE,
} from './atlas-state-seed';
import { hasSpatialMapContent } from './map-state-content';
import { mergeMapElementPatch } from './map-state-ops';
import {
    TAVERN_MAP_ICON_NAMES,
    type TavernMapIconName,
} from './map-icon-names';

export const TAVERN_STATE_TOOL_NAMES = {
    LIST: 'MapDocs',
    READ: 'MapInspect',
    PATCH: 'MapPatch',
} as const;

const LEGACY_TAVERN_STATE_TOOL_NAMES = {
    LIST: 'StateList',
    READ: 'StateRead',
    PATCH: 'StatePatch',
} as const;

function normalizeTavernStateToolName(toolName = ''): string {
    const name = String(toolName || '').trim();
    if (name === LEGACY_TAVERN_STATE_TOOL_NAMES.LIST) {return TAVERN_STATE_TOOL_NAMES.LIST;}
    if (name === LEGACY_TAVERN_STATE_TOOL_NAMES.READ) {return TAVERN_STATE_TOOL_NAMES.READ;}
    if (name === LEGACY_TAVERN_STATE_TOOL_NAMES.PATCH) {return TAVERN_STATE_TOOL_NAMES.PATCH;}
    return name;
}

export type TavernMapElementCategory =
    | 'wall'
    | 'road'
    | 'water'
    | 'terrain'
    | 'furniture'
    | 'door'
    | 'danger'
    | 'marker'
    | 'actor'
    | 'label'
    | 'grid'
    | 'magic'
    | 'secret';

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
    actorKey?: string;
    closed?: boolean;
    fill?: string;
    style?: TavernMapStyle;
}

export interface TavernMapDocument {
    meta: TavernMapDocumentMeta;
    elements: TavernMapElement[];
}

export type TavernAtlasLocationScale = 'city' | 'district' | 'building' | 'floor' | 'room' | 'outdoor';
export type TavernAtlasLocationStatus = 'mentioned' | 'visited';
export type TavernAtlasLinkKind = 'door' | 'stairs' | 'elevator' | 'path' | 'road' | 'portal' | 'passage';

export interface TavernAtlasLocation {
    key: string;
    name: string;
    scale: TavernAtlasLocationScale;
    status: TavernAtlasLocationStatus;
    parent?: string;
    mapDocId?: string;
    aliases?: string[];
    brief?: string;
}

export interface TavernAtlasLink {
    id: string;
    from: string;
    to: string;
    kind: TavernAtlasLinkKind;
    label?: string;
    bidirectional: boolean;
}

export interface TavernAtlasActorPosition {
    actorKey: string;
    locationKey: string;
}

export interface TavernAtlasDocument {
    version: 1;
    activeLocationKey?: string;
    locations: TavernAtlasLocation[];
    links: TavernAtlasLink[];
    actors: TavernAtlasActorPosition[];
}

export type TavernMapPatchOp =
    | { op: 'meta'; set: Partial<TavernMapDocumentMeta> }
    | { op: 'add'; element: TavernMapElement }
    | { op: 'modify'; id: string; set: Partial<TavernMapElement> }
    | { op: 'remove'; id: string; _internalSoft?: true };

export type TavernAtlasPatchOp =
    | { op: 'upsert-location'; key: string; set?: Partial<Omit<TavernAtlasLocation, 'key'>>; unset?: Array<'parent' | 'mapDocId' | 'aliases' | 'brief'> }
    | { op: 'remove-location'; key: string }
    | { op: 'upsert-link'; id?: string; from: string; to: string; kind: TavernAtlasLinkKind; label?: string; bidirectional?: boolean }
    | { op: 'remove-link'; id?: string; from?: string; to?: string; kind?: TavernAtlasLinkKind; bidirectional?: boolean }
    | { op: 'move-actor'; actorKey: string; locationKey: string };

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
    documents?: TavernStateDocumentListItem[];
    document?: unknown;
    digest?: string;
    meta?: TavernMapDocumentMeta;
    elementCount?: number;
    element?: TavernMapElement;
    elements?: TavernMapElement[];
    activeLocationKey?: string;
    locations?: TavernAtlasLocation[];
    location?: TavernAtlasLocation & { links?: TavernAtlasLink[]; actors?: TavernAtlasActorPosition[] };
    links?: TavernAtlasLink[];
    actors?: TavernAtlasActorPosition[];
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
const ATLAS_DOC_TYPE: TavernStructuredStateDocType = TAVERN_ATLAS_DOC_TYPE;
const DEFAULT_DOC_ID = TAVERN_MAP_DOC_ID;
const DEFAULT_ATLAS_DOC_ID = TAVERN_ATLAS_DOC_ID;
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
    'actor',
    'label',
    'grid',
    'magic',
    'secret',
]);
const MAP_ICON_NAMES = new Set<TavernMapIconName>(TAVERN_MAP_ICON_NAMES);
const SCENE_MAP_PLACE_SCALE_ICONS = new Set<string>(['house', 'castle', 'village', 'forest', 'temple', 'shop']);
const MAP_THEMES = new Set<TavernMapTheme>(['parchment', 'paper', 'dark', 'blueprint', 'grid']);
const MAP_STATUSES = new Set<TavernMapStatus>(['uninitialized', 'active']);
const ATLAS_LOCATION_SCALES = new Set<TavernAtlasLocationScale>(['city', 'district', 'building', 'floor', 'room', 'outdoor']);
const ATLAS_LOCATION_STATUSES = new Set<TavernAtlasLocationStatus>(['mentioned', 'visited']);
const ATLAS_LINK_KINDS = new Set<TavernAtlasLinkKind>(['door', 'stairs', 'elevator', 'path', 'road', 'portal', 'passage']);
const ATLAS_UNSET_FIELDS = new Set(['parent', 'mapDocId', 'aliases', 'brief']);

export type TavernStateDocumentListItem = Pick<TavernStructuredStateDocumentRecord, 'docType' | 'docId' | 'title' | 'revision' | 'digest' | 'status' | 'updatedAt'> & {
    active?: boolean;
};

export type TavernMapStateDocumentItem = TavernStructuredStateDocumentRecord & {
    active?: boolean;
};

function now(): number {
    return Date.now();
}

function normalizeMapDocId(value: unknown = DEFAULT_DOC_ID): string {
    const text = String(value || DEFAULT_DOC_ID).trim() || DEFAULT_DOC_ID;
    return /^[\w.-]{1,80}$/i.test(text) ? text : DEFAULT_DOC_ID;
}

function normalizeMapDocIdOrThrow(value: unknown, error = 'state_doc_id_invalid'): string {
    const text = String(value || '').trim();
    if (!text || !/^[\w.-]{1,80}$/i.test(text)) {throw new Error(error);}
    return text;
}

function isUninitializedSeedMapRecord(record: Pick<TavernStructuredStateDocumentRecord, 'docType' | 'docId' | 'revision' | 'data'> | null | undefined): boolean {
    return record?.docType === MAP_DOC_TYPE
        && record.docId === DEFAULT_DOC_ID
        && Number(record.revision) === 0
        && isUninitializedMapData(record.data);
}

function sortMapRecordsForDisplay<T extends Pick<TavernStructuredStateDocumentRecord, 'revision' | 'updatedAt'>>(records: T[]): T[] {
    return [...records].sort((left, right) => (
        (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0)
        || (Number(right.revision) || 0) - (Number(left.revision) || 0)
    ));
}

async function getActiveMapDocId(sessionId = ''): Promise<string> {
    const session = await tavernSessionsTable.get(String(sessionId || '').trim());
    return normalizeMapDocId(session?.state?.activeMapDocId || DEFAULT_DOC_ID);
}

async function setActiveMapDocId(sessionId = '', docId = DEFAULT_DOC_ID): Promise<string> {
    const id = String(sessionId || '').trim();
    const activeMapDocId = normalizeMapDocId(docId);
    if (!id) {return activeMapDocId;}
    const session = await tavernSessionsTable.get(id);
    const state = session?.state && typeof session.state === 'object' && !Array.isArray(session.state)
        ? { ...session.state, activeMapDocId }
        : { activeMapDocId };
    await tavernSessionsTable.update(id, {
        state,
        updatedAt: now(),
    });
    return activeMapDocId;
}

async function buildMapAtlasMismatchWarning(sessionId = '', activatedDocId = ''): Promise<string[]> {
    const atlasRecord = await getTavernStructuredStateDocument(sessionId, ATLAS_DOC_TYPE, DEFAULT_ATLAS_DOC_ID);
    const atlas = normalizeAtlasDocumentFromRecord(atlasRecord);
    const activeLocation = atlas.locations.find((location) => location.key === atlas.activeLocationKey);
    const atlasMapDocId = activeLocation?.mapDocId;
    if (!atlas.activeLocationKey || !atlasMapDocId || atlasMapDocId === activatedDocId) {return [];}
    return [
        `Map doc '${activatedDocId}' activated. Atlas still says player/current location is '${atlas.activeLocationKey}'. If the story moved the player, send tavern.atlas move-actor with actorKey:"player" and the correct locationKey.`,
    ];
}

async function resolveTavernActiveMapDocument(
    sessionId = '',
    options: { includeStale?: boolean } = {},
): Promise<{
    requestedDocId: string;
    activeDocId: string;
    record: TavernStructuredStateDocumentRecord | null;
    documents: TavernStructuredStateDocumentRecord[];
}> {
    await ensureSeedStructuredStateDocument(sessionId, { touchSession: false });
    const requestedDocId = await getActiveMapDocId(sessionId);
    const documents = await listTavernStructuredStateDocuments(sessionId, {
        docType: MAP_DOC_TYPE,
        includeStale: options.includeStale === true,
    });
    const initializedDocuments = sortMapRecordsForDisplay(documents.filter((document) => !isUninitializedSeedMapRecord(document)));
    const requestedRecord = documents.find((document) => document.docId === requestedDocId) || null;
    const defaultRecord = documents.find((document) => document.docId === DEFAULT_DOC_ID) || null;
    const record = requestedRecord && (!isUninitializedSeedMapRecord(requestedRecord) || !initializedDocuments.length)
        ? requestedRecord
        : (!isUninitializedSeedMapRecord(defaultRecord) ? defaultRecord : null)
        || initializedDocuments[0]
        || documents[0]
        || null;
    return {
        requestedDocId,
        activeDocId: record?.docId || requestedDocId,
        record,
        documents,
    };
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
    if (text === MAP_DOC_TYPE || text === ATLAS_DOC_TYPE) {return text as TavernStructuredStateDocType;}
    throw new Error('state_doc_type_not_supported');
}

function normalizeDocId(value: unknown = DEFAULT_DOC_ID): string {
    const text = String(value || DEFAULT_DOC_ID).trim() || DEFAULT_DOC_ID;
    if (!/^[\w.-]{1,80}$/i.test(text)) {throw new Error('state_doc_id_invalid');}
    return text;
}

function normalizeStateDocIdForType(docType: TavernStructuredStateDocType, value: unknown): string {
    if (docType === ATLAS_DOC_TYPE) {
        const text = String(value || DEFAULT_ATLAS_DOC_ID).trim() || DEFAULT_ATLAS_DOC_ID;
        if (text !== DEFAULT_ATLAS_DOC_ID) {throw new Error('atlas_doc_id_invalid');}
        return DEFAULT_ATLAS_DOC_ID;
    }
    return normalizeDocId(value || DEFAULT_DOC_ID);
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

function assertSceneMapIconAllowed(icon: TavernMapIconName | undefined, elementId: string): void {
    if (icon && SCENE_MAP_PLACE_SCALE_ICONS.has(icon)) {
        throw new Error(`map_element_icon_place_scale:${elementId}:${icon}`);
    }
}

function normalizeActorKey(value: unknown = ''): string {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .slice(0, 120);
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
            : {}),
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
    const actorKey = normalizeText(element.actorKey, 120);
    if (actorKey && next.cat === 'actor') {next.actorKey = actorKey;}
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
    if (icon) {
        if (source === 'model-input') {
            assertSceneMapIconAllowed(icon, id);
        }
        shapeParts.icon = icon;
    }

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
        actorKey: normalizeText(value.actorKey, 120) || undefined,
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
            actorKey: base.actorKey,
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
    void revision;
    if (document.meta.status !== 'active' || !hasSpatialMapContent(document.elements)) {return '';}
    const title = normalizeText(document.meta.name || 'Map', 80) || 'Map';
    const labels = document.elements
        .filter((element) => typeof element.text === 'string' && element.text.trim())
        .map((element) => normalizeText(element.text, 40))
        .filter(Boolean)
        .slice(0, 8);
    return [
        `地图：${title}`,
        labels.length ? `标注：${labels.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

function mapTitle(document: TavernMapDocument): string {
    return normalizeText(document.meta.name || 'Map', 120) || 'Map';
}

function normalizeAtlasKey(value: unknown = ''): string {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 120);
}

function normalizeAtlasKeyOrThrow(value: unknown, error: string): string {
    const key = normalizeAtlasKey(value);
    if (!key || /[/\\:*?"<>|\u0000-\u001F]/.test(key) || key === '.' || key === '..') {
        throw new Error(error);
    }
    return key;
}

function normalizeAtlasScale(value: unknown): TavernAtlasLocationScale {
    const text = String(value || '').trim() as TavernAtlasLocationScale;
    if (!ATLAS_LOCATION_SCALES.has(text)) {throw new Error('atlas_location_scale_invalid');}
    return text;
}

function normalizeAtlasStatus(value: unknown): TavernAtlasLocationStatus {
    const text = String(value || '').trim() as TavernAtlasLocationStatus;
    if (!ATLAS_LOCATION_STATUSES.has(text)) {throw new Error('atlas_location_status_invalid');}
    return text;
}

function normalizeAtlasLinkKind(value: unknown): TavernAtlasLinkKind {
    const text = String(value || '').trim() as TavernAtlasLinkKind;
    if (!ATLAS_LINK_KINDS.has(text)) {throw new Error('atlas_link_kind_invalid');}
    return text;
}

function normalizeAtlasStringArray(value: unknown, limit = 20): string[] | undefined {
    if (!Array.isArray(value)) {return undefined;}
    return [...new Set(value.map((item) => normalizeText(item, 80)).filter(Boolean))].slice(0, limit);
}

function defaultAtlasLinkId(from: string, to: string, kind: TavernAtlasLinkKind, bidirectional = true): string {
    if (bidirectional === false) {
        return `link:${from}:${to}:${kind}`;
    }
    return `link:${[from, to].sort().join(':')}:${kind}`;
}

function normalizeAtlasLocation(value: unknown): TavernAtlasLocation | null {
    if (!isPlainObject(value)) {return null;}
    const key = normalizeAtlasKey(value.key);
    const name = normalizeText(value.name, 120);
    const scaleText = String(value.scale || '').trim() as TavernAtlasLocationScale;
    const statusText = String(value.status || '').trim() as TavernAtlasLocationStatus;
    if (!key || !name || !ATLAS_LOCATION_SCALES.has(scaleText) || !ATLAS_LOCATION_STATUSES.has(statusText)) {return null;}
    const location: TavernAtlasLocation = {
        key,
        name,
        scale: scaleText,
        status: statusText,
    };
    const parent = normalizeAtlasKey(value.parent);
    if (parent) {location.parent = parent;}
    const mapDocId = normalizeText(value.mapDocId, 80);
    if (mapDocId && /^[\w.-]{1,80}$/i.test(mapDocId)) {location.mapDocId = mapDocId;}
    const aliases = normalizeAtlasStringArray(value.aliases);
    if (aliases?.length) {location.aliases = aliases;}
    const brief = normalizeText(value.brief, 240);
    if (brief) {location.brief = brief;}
    return location;
}

function normalizeAtlasLink(value: unknown): TavernAtlasLink | null {
    if (!isPlainObject(value)) {return null;}
    const from = normalizeAtlasKey(value.from);
    const to = normalizeAtlasKey(value.to);
    const kind = String(value.kind || '').trim() as TavernAtlasLinkKind;
    if (!from || !to || !ATLAS_LINK_KINDS.has(kind)) {return null;}
    const bidirectional = value.bidirectional !== false;
    const id = normalizeText(value.id, 160) || defaultAtlasLinkId(from, to, kind, bidirectional);
    const link: TavernAtlasLink = { id, from, to, kind, bidirectional };
    const label = normalizeText(value.label, 120);
    if (label) {link.label = label;}
    return link;
}

function normalizeAtlasActor(value: unknown): TavernAtlasActorPosition | null {
    if (!isPlainObject(value)) {return null;}
    const actorKey = normalizeActorKey(value.actorKey);
    const locationKey = normalizeAtlasKey(value.locationKey);
    return actorKey && locationKey ? { actorKey, locationKey } : null;
}

function defaultAtlasDocument(): TavernAtlasDocument {
    return normalizeAtlasDocument(createSeedAtlasDocument());
}

function normalizeAtlasDocument(value: unknown): TavernAtlasDocument {
    const raw = isPlainObject(value) ? value : {};
    const locations = Array.isArray(raw.locations)
        ? raw.locations.map(normalizeAtlasLocation).filter((item): item is TavernAtlasLocation => !!item)
        : [];
    const links = Array.isArray(raw.links)
        ? raw.links.map(normalizeAtlasLink).filter((item): item is TavernAtlasLink => !!item)
        : [];
    const actors = Array.isArray(raw.actors)
        ? raw.actors.map(normalizeAtlasActor).filter((item): item is TavernAtlasActorPosition => !!item)
        : [];
    const locationKeys = new Set<string>();
    const uniqueLocations: TavernAtlasLocation[] = [];
    locations.forEach((location) => {
        if (locationKeys.has(location.key)) {return;}
        locationKeys.add(location.key);
        uniqueLocations.push(location);
    });
    const linkIds = new Set<string>();
    const uniqueLinks: TavernAtlasLink[] = [];
    links.forEach((link) => {
        if (linkIds.has(link.id)) {return;}
        linkIds.add(link.id);
        uniqueLinks.push(link);
    });
    const actorMap = new Map<string, TavernAtlasActorPosition>();
    actors.forEach((actor) => actorMap.set(actor.actorKey, actor));
    const activeLocationKey = normalizeAtlasKey(raw.activeLocationKey);
    return {
        version: 1,
        ...(activeLocationKey ? { activeLocationKey } : {}),
        locations: uniqueLocations,
        links: uniqueLinks,
        actors: [...actorMap.values()],
    };
}

function normalizeAtlasDocumentFromRecord(document: TavernStructuredStateDocumentRecord | null): TavernAtlasDocument {
    if (!document?.data) {return defaultAtlasDocument();}
    return normalizeAtlasDocument(document.data);
}

function atlasTitle(document: TavernAtlasDocument): string {
    const active = document.locations.find((location) => location.key === document.activeLocationKey);
    return active ? `世界图：${active.name}` : '世界图';
}

function createAtlasDigest(document: TavernAtlasDocument): string {
    const active = document.locations.find((location) => location.key === document.activeLocationKey);
    const visitedCount = document.locations.filter((location) => location.status === 'visited').length;
    return [
        active ? `当前地点：${active.name}` : '',
        `地点：${document.locations.length}`,
        `连接：${document.links.length}`,
        `人物：${document.actors.length}`,
        visitedCount ? `已探索：${visitedCount}` : '',
    ].filter(Boolean).join('\n');
}

function hasParentCycle(locations: Map<string, TavernAtlasLocation>, startKey: string): boolean {
    const visited = new Set<string>();
    let current: string | undefined = startKey;
    while (current) {
        if (visited.has(current)) {return true;}
        visited.add(current);
        current = locations.get(current)?.parent;
    }
    return false;
}

function mapElementSummary(element: TavernMapElement): TavernMapElement {
    return cloneJson(element);
}

async function dedupeActorElementsForSavedDocument(input: {
    sessionId: string;
    docType: TavernStructuredStateDocType;
    docId: string;
    document: TavernMapDocument;
    timestamp: number;
    managerRunId?: string;
    sourceUserOrder?: number;
    sourceAssistantOrder?: number;
}): Promise<{
    document: TavernMapDocument;
    removedElements: TavernMapElement[];
    otherDocumentRemovals: Array<{
        docId: string;
        revision: number;
        removedElements: TavernMapElement[];
        removeOps: Extract<TavernMapPatchOp, { op: 'remove' }>[];
    }>;
}> {
    const actorKeyToKeepId = new Map<string, string>();
    input.document.elements.forEach((element) => {
        if (element.cat !== 'actor') {return;}
        const key = normalizeActorKey(element.actorKey || element.id);
        if (key) {actorKeyToKeepId.set(key, element.id);}
    });
    if (!actorKeyToKeepId.size) {
        return { document: input.document, removedElements: [], otherDocumentRemovals: [] };
    }

    const dedupeElements = (document: TavernMapDocument, isSavedDocument: boolean): {
        document: TavernMapDocument;
        removedElements: TavernMapElement[];
        removeOps: Extract<TavernMapPatchOp, { op: 'remove' }>[];
    } => {
        let changed = false;
        const removedActorIds = new Set<string>();
        const removedElements: TavernMapElement[] = [];
        const withoutDuplicateActors = document.elements.filter((element) => {
            if (element.cat !== 'actor') {return true;}
            const key = normalizeActorKey(element.actorKey || element.id);
            if (!actorKeyToKeepId.has(key)) {return true;}
            const keep = isSavedDocument && actorKeyToKeepId.get(key) === element.id;
            if (!keep) {
                removedElements.push(cloneJson(element));
                removedActorIds.add(element.id);
                changed = true;
            }
            return keep;
        });
        const removedLabelIds = new Set([...removedActorIds].map((actorId) => buildSeedLabelId(actorId)));
        const elements = removedLabelIds.size
            ? withoutDuplicateActors.filter((element) => {
                if (!removedLabelIds.has(element.id)) {return true;}
                removedElements.push(cloneJson(element));
                changed = true;
                return false;
            })
            : withoutDuplicateActors;
        const removeOps = removedElements.map((element) => ({ op: 'remove' as const, id: element.id }));
        return { document: changed ? { ...document, elements } : document, removedElements, removeOps };
    };

    const currentDedupe = dedupeElements(input.document, true);
    const otherDocumentRemovals: Array<{
        docId: string;
        revision: number;
        removedElements: TavernMapElement[];
        removeOps: Extract<TavernMapPatchOp, { op: 'remove' }>[];
    }> = [];
    const rows = await tavernStateDocumentsTable.where('sessionId').equals(input.sessionId).toArray();
    for (const row of rows) {
        if (row.docType !== input.docType || row.docId === input.docId || row.status === 'stale') {continue;}
        const current = normalizeMapDocumentFromRecord(row);
        const next = dedupeElements(current, false);
        if (!next.removedElements.length) {continue;}
        const revision = Math.max(0, Number(row.revision) || 0) + 1;
        const digest = createMapDigest(next.document, revision);
        await tavernStateDocumentsTable.put({
            ...row,
            data: next.document,
            digest,
            revision,
            title: mapTitle(next.document),
            updatedAt: input.timestamp,
        });
        await appendTavernStructuredStatePatch({
            sessionId: input.sessionId,
            docType: input.docType,
            docId: row.docId,
            revision,
            status: 'active',
            managerRunId: input.managerRunId,
            sourceUserOrder: input.sourceUserOrder,
            sourceAssistantOrder: input.sourceAssistantOrder,
            source: 'system',
            summary: normalizeText(`Actor dedupe ${revision}`, 400),
            ops: next.removeOps,
            changedIds: next.removedElements.map((element) => element.id),
            removedElements: next.removedElements,
        });
        otherDocumentRemovals.push({
            docId: row.docId,
            revision,
            removedElements: next.removedElements,
            removeOps: next.removeOps,
        });
    }

    return {
        document: currentDedupe.document,
        removedElements: currentDedupe.removedElements,
        otherDocumentRemovals,
    };
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
        return `${id} has an invalid icon. Use one of ${TAVERN_MAP_ICON_NAMES.join('/')}.`;
    case 'map_element_icon_place_scale':
        return `${id} uses a place icon inside a scene map. Scene maps should draw local space with geometry, small objects, labels, and actor positions instead of house/castle/village/forest/temple/shop.`;
    case 'map_element_shape_required':
        return `${id} is missing a shape field. Every element must provide exactly one of rect/circle/path/curve/icon/text.`;
    case 'map_element_shape_conflict':
        return `${id} has multiple shape fields. Only the special "geometry + text" input is allowed, and it will be split into a derived label automatically.`;
    case 'map_element_duplicate':
        return `${id} is duplicated. Use a stable unique id.`;
    case 'map_element_not_found':
        return `${id} does not exist. Use MapInspect summary/elements first to find existing ids.`;
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
    case 'atlas_doc_id_invalid':
        return 'Atlas has exactly one document: tavern.atlas/main.';
    case 'atlas_activate_not_supported':
        return 'Atlas does not support activate:true. Move the player with move-actor(actorKey:"player").';
    case 'atlas_location_key_invalid':
        return 'Invalid atlas location key. Use a stable non-empty key without path separators or control characters.';
    case 'atlas_location_create_required':
        return `${id} is new. Provide set.name, set.scale, and set.status.`;
    case 'atlas_location_not_found':
        return `${id} does not exist in the atlas. Create the location before linking or moving actors there.`;
    case 'atlas_parent_not_found':
        return `${id} does not exist. Create the parent location before assigning it.`;
    case 'atlas_parent_cycle':
        return `${id} would create a parent cycle.`;
    case 'atlas_link_location_not_found':
        return `${id} does not exist. Atlas links cannot point to missing locations.`;
    case 'atlas_link_kind_invalid':
        return 'Invalid atlas link kind. Use door/stairs/elevator/path/road/portal/passage.';
    case 'atlas_link_not_found':
        return `${id} does not exist. Use MapInspect links first.`;
    case 'atlas_location_has_children':
    case 'atlas_location_has_links':
    case 'atlas_location_has_actors':
    case 'atlas_location_active':
        return `${id} still has dependencies. Remove child locations, links, actors, or active status first.`;
    case 'atlas_op_not_supported':
        return `Unsupported atlas op: ${id}. Use upsert-location/remove-location/upsert-link/remove-link/move-actor.`;
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

function summarizeAtlasLocations(document: TavernAtlasDocument, args: Record<string, unknown> = {}): {
    locations: TavernAtlasLocation[];
    count: number;
    truncated: boolean;
    nextOffset: number;
} {
    const query = normalizeText(args.query, 120).toLowerCase();
    const parent = normalizeAtlasKey(args.parent);
    const status = String(args.status || '').trim();
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Math.min(MAX_STATE_READ_LIMIT, Number(args.limit) || 30));
    const matches = document.locations.filter((location) => {
        if (parent && location.parent !== parent) {return false;}
        if (status && location.status !== status) {return false;}
        if (!query) {return true;}
        return [
            location.key,
            location.name,
            location.scale,
            location.status,
            location.brief,
            ...(location.aliases || []),
        ].join('\n').toLowerCase().includes(query);
    });
    const page = matches.slice(offset, offset + limit).map((location) => cloneJson(location));
    const nextOffset = offset + page.length < matches.length ? offset + page.length : 0;
    return { locations: page, count: matches.length, truncated: nextOffset > 0, nextOffset };
}

function summarizeAtlasLinks(document: TavernAtlasDocument, args: Record<string, unknown> = {}): {
    links: TavernAtlasLink[];
    count: number;
    truncated: boolean;
    nextOffset: number;
} {
    const query = normalizeText(args.query, 120).toLowerCase();
    const from = normalizeAtlasKey(args.from);
    const to = normalizeAtlasKey(args.to);
    const kind = String(args.kind || '').trim();
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Math.min(MAX_STATE_READ_LIMIT, Number(args.limit) || 30));
    const matches = document.links.filter((link) => {
        if (from && link.from !== from) {return false;}
        if (to && link.to !== to) {return false;}
        if (kind && link.kind !== kind) {return false;}
        if (!query) {return true;}
        return [link.id, link.from, link.to, link.kind, link.label].join('\n').toLowerCase().includes(query);
    });
    const page = matches.slice(offset, offset + limit).map((link) => cloneJson(link));
    const nextOffset = offset + page.length < matches.length ? offset + page.length : 0;
    return { links: page, count: matches.length, truncated: nextOffset > 0, nextOffset };
}

function normalizeAtlasLocationSet(value: unknown = {}): Partial<Omit<TavernAtlasLocation, 'key'>> {
    if (!isPlainObject(value)) {throw new Error('atlas_location_set_required');}
    const set: Partial<Omit<TavernAtlasLocation, 'key'>> = {};
    if ('name' in value) {
        const name = normalizeText(value.name, 120);
        if (!name) {throw new Error('atlas_location_name_required');}
        set.name = name;
    }
    if ('scale' in value) {set.scale = normalizeAtlasScale(value.scale);}
    if ('status' in value) {set.status = normalizeAtlasStatus(value.status);}
    if ('parent' in value) {
        const parent = normalizeAtlasKey(value.parent);
        if (parent) {set.parent = parent;}
        else {set.parent = undefined;}
    }
    if ('mapDocId' in value) {
        const mapDocId = normalizeText(value.mapDocId, 80);
        if (mapDocId) {set.mapDocId = normalizeMapDocIdOrThrow(mapDocId, 'atlas_location_map_doc_id_invalid');}
        else {set.mapDocId = undefined;}
    }
    if ('aliases' in value) {set.aliases = normalizeAtlasStringArray(value.aliases) || [];}
    if ('brief' in value) {
        const brief = normalizeText(value.brief, 240);
        if (brief) {set.brief = brief;}
        else {set.brief = undefined;}
    }
    return set;
}

function applyAtlasOps(source: TavernAtlasDocument, rawOps: unknown[]): {
    document: TavernAtlasDocument;
    effectiveOps: TavernAtlasPatchOp[];
    appliedCount: number;
    satisfiedCount: number;
    failed: Array<{ index: number; error: string; hint?: string }>;
    warnings: string[];
    changedIds: string[];
    changed: boolean;
    syncedActiveMapDocId?: string;
} {
    if (!Array.isArray(rawOps)) {throw new Error('state_patch_ops_must_be_array');}
    if (!rawOps.length) {throw new Error('state_patch_ops_required');}
    if (rawOps.length > MAX_STATE_PATCH_OPS) {throw new Error('state_patch_ops_limit_exceeded');}

    let document = normalizeAtlasDocument(source);
    const effectiveOps: TavernAtlasPatchOp[] = [];
    const failed: Array<{ index: number; error: string; hint?: string }> = [];
    const warnings: string[] = [];
    const changedIds = new Set<string>();
    let appliedCount = 0;
    let satisfiedCount = 0;
    let changed = false;
    let syncedActiveMapDocId: string | undefined;

    const locationMap = () => new Map(document.locations.map((location) => [location.key, location]));
    const linkIndex = (id: string) => document.links.findIndex((link) => link.id === id);
    const actorIndex = (actorKey: string) => document.actors.findIndex((actor) => actor.actorKey === actorKey);
    const assertParentGraph = () => {
        const locations = locationMap();
        document.locations.forEach((location) => {
            if (location.parent) {
                if (location.parent === location.key) {throw new Error(`atlas_parent_cycle:${location.key}`);}
                if (!locations.has(location.parent)) {throw new Error(`atlas_parent_not_found:${location.parent}`);}
            }
        });
        document.locations.forEach((location) => {
            if (hasParentCycle(locations, location.key)) {throw new Error(`atlas_parent_cycle:${location.key}`);}
        });
    };
    const assertLinkEndpoints = (from: string, to: string) => {
        const locations = locationMap();
        if (!locations.has(from)) {throw new Error(`atlas_link_location_not_found:${from}`);}
        if (!locations.has(to)) {throw new Error(`atlas_link_location_not_found:${to}`);}
    };
    const markApplied = (op: TavernAtlasPatchOp, id: string) => {
        effectiveOps.push(cloneJson(op));
        changedIds.add(id);
        changed = true;
        appliedCount += 1;
    };

    rawOps.forEach((raw, index) => {
        try {
            if (!isPlainObject(raw)) {throw new Error('atlas_op_invalid');}
            const op = String(raw.op || '').trim();
            if (op === 'upsert-location') {
                const key = normalizeAtlasKeyOrThrow(raw.key, 'atlas_location_key_invalid');
                const set = normalizeAtlasLocationSet(raw.set || {});
                const rawUnset = Array.isArray(raw.unset) ? raw.unset.map((field) => String(field || '').trim()) : [];
                const invalidUnset = rawUnset.find((field) => !ATLAS_UNSET_FIELDS.has(field));
                if (invalidUnset) {throw new Error(`atlas_unset_field_invalid:${invalidUnset || 'empty'}`);}
                const unset = rawUnset.filter(Boolean);
                const existingIndex = document.locations.findIndex((location) => location.key === key);
                if (existingIndex < 0) {
                    if (!set.name || !set.scale || !set.status) {throw new Error(`atlas_location_create_required:${key}`);}
                    const location: TavernAtlasLocation = {
                        key,
                        name: set.name,
                        scale: set.scale,
                        status: set.status,
                    };
                    if (set.parent) {location.parent = set.parent;}
                    if (set.mapDocId) {location.mapDocId = set.mapDocId;}
                    if (set.aliases?.length) {location.aliases = set.aliases;}
                    if (set.brief) {location.brief = set.brief;}
                    document.locations.push(location);
                    assertParentGraph();
                    markApplied({ op: 'upsert-location', key, set: cloneJson(set), ...(unset.length ? { unset: unset as Array<'parent' | 'mapDocId' | 'aliases' | 'brief'> } : {}) }, `location:${key}`);
                    return;
                }
                const current = document.locations[existingIndex];
                const next: TavernAtlasLocation = { ...current, ...set };
                const effectiveSet: Partial<Omit<TavernAtlasLocation, 'key'>> = { ...set };
                if (current.status === 'visited' && set.status === 'mentioned') {
                    next.status = 'visited';
                    effectiveSet.status = 'visited';
                    warnings.push(`${key} is already visited; status was not downgraded to mentioned.`);
                }
                unset.forEach((field) => {
                    delete (next as unknown as Record<string, unknown>)[field];
                });
                if (!next.name || !next.scale || !next.status) {throw new Error(`atlas_location_required_field:${key}`);}
                document.locations[existingIndex] = next;
                assertParentGraph();
                if (deepEqual(current, next)) {
                    satisfiedCount += 1;
                    return;
                }
                markApplied({ op: 'upsert-location', key, set: cloneJson(effectiveSet), ...(unset.length ? { unset: unset as Array<'parent' | 'mapDocId' | 'aliases' | 'brief'> } : {}) }, `location:${key}`);
                return;
            }
            if (op === 'remove-location') {
                const key = normalizeAtlasKeyOrThrow(raw.key, 'atlas_location_key_invalid');
                const existingIndex = document.locations.findIndex((location) => location.key === key);
                if (existingIndex < 0) {throw new Error(`atlas_location_not_found:${key}`);}
                if (document.activeLocationKey === key) {throw new Error(`atlas_location_active:${key}`);}
                if (document.locations.some((location) => location.parent === key)) {throw new Error(`atlas_location_has_children:${key}`);}
                if (document.links.some((link) => link.from === key || link.to === key)) {throw new Error(`atlas_location_has_links:${key}`);}
                if (document.actors.some((actor) => actor.locationKey === key)) {throw new Error(`atlas_location_has_actors:${key}`);}
                document.locations.splice(existingIndex, 1);
                markApplied({ op: 'remove-location', key }, `location:${key}`);
                return;
            }
            if (op === 'upsert-link') {
                const from = normalizeAtlasKeyOrThrow(raw.from, 'atlas_link_from_required');
                const to = normalizeAtlasKeyOrThrow(raw.to, 'atlas_link_to_required');
                const kind = normalizeAtlasLinkKind(raw.kind);
                const bidirectional = raw.bidirectional !== false;
                const id = normalizeText(raw.id, 160) || defaultAtlasLinkId(from, to, kind, bidirectional);
                assertLinkEndpoints(from, to);
                const next: TavernAtlasLink = { id, from, to, kind, bidirectional };
                const label = normalizeText(raw.label, 120);
                if (label) {next.label = label;}
                const existingIndex = linkIndex(id);
                if (existingIndex >= 0) {
                    if (deepEqual(document.links[existingIndex], next)) {
                        satisfiedCount += 1;
                        return;
                    }
                    document.links[existingIndex] = next;
                } else {
                    document.links.push(next);
                }
                markApplied({ op: 'upsert-link', id, from, to, kind, ...(label ? { label } : {}), bidirectional }, `link:${id}`);
                return;
            }
            if (op === 'remove-link') {
                let id = normalizeText(raw.id, 160);
                if (!id) {
                    const from = normalizeAtlasKey(raw.from);
                    const to = normalizeAtlasKey(raw.to);
                    const kind = String(raw.kind || '').trim() as TavernAtlasLinkKind;
                    if (!from || !to || !ATLAS_LINK_KINDS.has(kind)) {throw new Error('atlas_link_remove_locator_required');}
                    id = defaultAtlasLinkId(from, to, kind, raw.bidirectional !== false);
                }
                const existingIndex = linkIndex(id);
                if (existingIndex < 0) {throw new Error(`atlas_link_not_found:${id}`);}
                document.links.splice(existingIndex, 1);
                markApplied({ op: 'remove-link', id }, `link:${id}`);
                return;
            }
            if (op === 'move-actor') {
                const actorKey = normalizeActorKey(raw.actorKey);
                const locationKey = normalizeAtlasKeyOrThrow(raw.locationKey, 'atlas_actor_location_required');
                if (!actorKey) {throw new Error('atlas_actor_key_required');}
                const location = locationMap().get(locationKey);
                if (!location) {throw new Error(`atlas_location_not_found:${locationKey}`);}
                const nextActor: TavernAtlasActorPosition = { actorKey, locationKey };
                const existingIndex = actorIndex(actorKey);
                const current = existingIndex >= 0 ? document.actors[existingIndex] : null;
                if (current && deepEqual(current, nextActor) && !(actorKey === 'player' && document.activeLocationKey !== locationKey)) {
                    satisfiedCount += 1;
                    return;
                }
                if (existingIndex >= 0) {document.actors[existingIndex] = nextActor;}
                else {document.actors.push(nextActor);}
                if (actorKey === 'player') {
                    document.activeLocationKey = locationKey;
                    const locationIndex = document.locations.findIndex((item) => item.key === locationKey);
                    if (locationIndex >= 0 && document.locations[locationIndex].status !== 'visited') {
                        document.locations[locationIndex] = { ...document.locations[locationIndex], status: 'visited' };
                    }
                    syncedActiveMapDocId = document.locations[locationIndex]?.mapDocId;
                }
                markApplied({ op: 'move-actor', actorKey, locationKey }, `actor:${actorKey}`);
                return;
            }
            throw new Error(`atlas_op_not_supported:${op || 'unknown'}`);
        } catch (error) {
            failed.push({
                index,
                error: error instanceof Error ? error.message : String(error || 'atlas_op_failed'),
            });
        }
    });

    return {
        document,
        effectiveOps,
        appliedCount,
        satisfiedCount,
        failed,
        warnings,
        changedIds: [...changedIds],
        changed,
        syncedActiveMapDocId,
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
        assertSceneMapIconAllowed(icon, id);
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

async function getSeededAtlasDocumentRecord(
    sessionId = '',
): Promise<TavernStructuredStateDocumentRecord | null> {
    const existing = await getTavernStructuredStateDocument(sessionId, ATLAS_DOC_TYPE, DEFAULT_ATLAS_DOC_ID);
    if (existing) {return existing;}
    await ensureSeedStructuredStateDocument(sessionId, { touchSession: false });
    return await getTavernStructuredStateDocument(sessionId, ATLAS_DOC_TYPE, DEFAULT_ATLAS_DOC_ID);
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
                description: 'Semantic category such as wall, door, marker, actor, terrain, road, or label.',
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
                description: 'Named scene-map icon marker. Use only small objects or abstract markers such as chest/table/bed/barrel/door/stairs/portal/skull/trap/fire/tree/rock/water/heart/lips/lovers/cherish/love-letter/locked-heart/perfume, or x/o/+ and arrows for markers and directions. Do not put place icons such as house/castle/village/forest/temple/shop inside a scene map; describe places in the atlas and draw local space with geometry, labels, and actor positions.',
            },
            text: {
                type: 'string',
                description: 'Short label text. If you provide text together with geometry in an add input, the runtime will split the text into a derived label element automatically.',
            },
            actorKey: {
                type: 'string',
                description: 'Optional full-session actor identity key for cat:"actor". If omitted, the element id is used as the actor key fallback.',
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
                    'List structured map documents in the current RP session.',
                    'Returns document entries only. It does not read full state, elements, or patch history.',
                    'Use before MapInspect when you need available scene-map documents, or when you need the atlas world index.',
                    'Map scope is fixed to this tavern session; it cannot inspect text sources, memory Markdown, RP chat history, character cards, world books, settings, or plugin source code.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        docType: { type: 'string', enum: [MAP_DOC_TYPE, ATLAS_DOC_TYPE], description: 'Optional structured document type filter: `tavern.map` for scene maps, `tavern.atlas` for the world index.' },
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
                    'Inspect a structured scene map or world atlas document in the current RP session.',
                    'Use `summary` first when choosing what to patch, checking revision, or deciding whether a map/atlas update is needed.',
                    'For `tavern.map`, use `summary` first, `elements` to browse map elements, `element` for one id, `document` for the full map, and `history` for saved map patch transactions.',
                    'For `tavern.atlas`, use `summary`, `document`, `locations`, `location`, `links`, `actors`, or `history`. Atlas does not have map elements.',
                    'This inspects structured spatial data only. Use LS/Grep/Read for text evidence, memory files, chat history, and worldbook material.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        docType: { type: 'string', enum: [MAP_DOC_TYPE, ATLAS_DOC_TYPE], description: 'Structured document type. Use `tavern.map` for scene maps or `tavern.atlas` for the world index.' },
                        docId: { type: 'string', description: 'Structured document id. Omit for the active map; atlas always uses `main`.' },
                        mode: { type: 'string', enum: ['summary', 'elements', 'document', 'element', 'history', 'locations', 'location', 'links', 'actors'], description: 'For maps: summary/elements/document/element/history. For atlas: summary/document/locations/location/links/actors/history.' },
                        elementId: { type: 'string', description: 'Required for `element` mode. Exact element id to read.' },
                        locationKey: { type: 'string', description: 'Required for atlas `location` mode.' },
                        actorKey: { type: 'string', description: 'Optional atlas `actors` filter.' },
                        parent: { type: 'string', description: 'Optional atlas `locations` parent filter.' },
                        status: { type: 'string', enum: ['mentioned', 'visited'], description: 'Optional atlas `locations` status filter.' },
                        from: { type: 'string', description: 'Optional atlas `links` from filter.' },
                        to: { type: 'string', description: 'Optional atlas `links` to filter.' },
                        kind: { type: 'string', enum: [...ATLAS_LINK_KINDS], description: 'Optional atlas `links` kind filter.' },
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
                    'Apply one structured map/atlas patch transaction to the current RP session.',
                    'Use this only for confirmed spatial changes from RP source text or a user-requested correction. If nothing spatial changed, do not patch.',
                    'Read MapInspect summary first unless you already have the current doc, ids, and revision from this turn. Use `baseRevision` when you are protecting against concurrent changes.',
                    'For `tavern.map`, canonical ops are `meta`, `add`, `modify`, and `remove`. One MapPatch call is one atomic transaction and becomes exactly one revision when it saves.',
                    'Use `meta` to update document fields such as name, viewBox, theme, status, or hint. Use `add` to create elements, `modify` to change existing ids, and `remove` to delete ids.',
                    'Each element has `id` and `cat`, plus exactly one shape field: `rect`, `circle`, `path`, `curve`, `icon`, or `text`. Most elements use `at:[x,y]`; `path` and `curve` may omit `at` and use the first point as the anchor.',
                    'For `cat:"actor"`, optional `actorKey` is the full-session identity key. If omitted, the element id is used. The runtime keeps only the latest actor with the same final key across all map documents.',
                    'With `at`, `path` and `curve` points are relative offsets. Without `at`, the points are treated as absolute coordinates and the stored result becomes relative to the first point.',
                    'If one add element contains geometry plus text, the runtime splits the text into a system label element automatically.',
                    'Atlas glyphs describe places. Scene maps describe local space. Do not put house/castle/village/forest/temple/shop icons inside a scene map; draw the local walls, doors, roads, furniture, hazards, objects, labels, and actor positions instead.',
                    'For `tavern.atlas/main`, use only `upsert-location`, `remove-location`, `upsert-link`, `remove-link`, and `move-actor`. There is no set-active-location op.',
                    'Atlas links may omit `id`. The default link id is `link:${sorted(from,to).join(":")}:${kind}` for bidirectional links and `link:${from}:${to}:${kind}` for `bidirectional:false`. Use an explicit id only when two locations need multiple same-kind links.',
                    'Move the player between places with `move-actor` and `actorKey:"player"`. That updates atlas.activeLocationKey, marks the location visited, and syncs activeMapDocId when the location has mapDocId. Non-player actors do not change the current location.',
                    'Pass `activate:true` only for `tavern.map` to make that map document active for map tools. Do not use map activate to represent player movement.',
                    '`meta.viewBox` is the camera. Changing it does not move elements. Move actors by changing their `at`, then adjust `viewBox` only if the camera should follow.',
                    'The `ops` argument must be a real JSON array, not a quoted JSON string. With `dryRun:true`, validate without saving or incrementing revision.',
                    'Legacy `init`, `reset`, and `replace` input is still absorbed at runtime, but do not rely on it in new calls.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        docType: { type: 'string', enum: [MAP_DOC_TYPE, ATLAS_DOC_TYPE], description: 'Structured document type. Use `tavern.map` for scene maps or `tavern.atlas` for the world index.' },
                        docId: { type: 'string', description: 'Structured document id. For scene maps, prefer an explicit stable place-named docId; omit only when intentionally maintaining the currently active scene-map doc. Atlas always uses `main`.' },
                        baseRevision: { type: 'number', description: 'Optional optimistic revision check from MapInspect summary/document.' },
                        dryRun: { type: 'boolean', description: 'Validate and simulate the transaction without saving or incrementing the revision.' },
                        activate: { type: 'boolean', description: 'Set this map document as the current scene after the transaction. With `ops:[]`, this only switches the active map.' },
                        desc: { type: 'string', description: 'Short one-line summary of this turn’s spatial update.' },
                        ops: {
                            type: 'array',
                            description: 'Patch ops as one atomic transaction. For maps use `meta/add/modify/remove`. For atlas use `upsert-location/remove-location/upsert-link/remove-link/move-actor`.',
                            items: {
                                type: 'object',
                                properties: {
                                    op: { type: 'string', enum: ['meta', 'add', 'modify', 'remove', 'upsert-location', 'remove-location', 'upsert-link', 'remove-link', 'move-actor'], description: 'Operation type. Map ops and atlas ops are selected by docType.' },
                                    id: { type: 'string', description: 'Map element id for `modify`/`remove`, or atlas link id for `upsert-link`/`remove-link`. Atlas links may omit it and use the default id rule.' },
                                    key: { type: 'string', description: 'Atlas location key for upsert-location/remove-location.' },
                                    locationKey: { type: 'string', description: 'Atlas target location key for move-actor.' },
                                    actorKey: { type: 'string', description: 'Atlas actor key for move-actor. Use actorKey:"player" for the player.' },
                                    from: { type: 'string', description: 'Atlas link source location key.' },
                                    to: { type: 'string', description: 'Atlas link target location key.' },
                                    kind: { type: 'string', enum: [...ATLAS_LINK_KINDS], description: 'Atlas link kind.' },
                                    label: { type: 'string', description: 'Optional atlas link label.' },
                                    bidirectional: { type: 'boolean', description: 'Atlas link direction flag. Defaults true.' },
                                    unset: { type: 'array', items: { type: 'string', enum: ['parent', 'mapDocId', 'aliases', 'brief'] }, description: 'Atlas upsert-location optional fields to remove.' },
                                    set: { type: 'object', description: 'For map `meta`/`modify`, fields to update. For atlas `upsert-location`, location fields to merge.' },
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
    const normalizedToolName = normalizeTavernStateToolName(toolName);
    if (!id) {return { ok: false, summary: 'Missing sessionId.', error: 'state_session_required' };}
    try {
        const explicitDocType = normalizeText(args.docType, 40);
        const hasExplicitDocType = !!explicitDocType;
        const docType = normalizeDocType(explicitDocType || MAP_DOC_TYPE);
        const explicitDocId = normalizeText(args.docId, 80);
        const docId = normalizeStateDocIdForType(docType, explicitDocId || (
            docType === MAP_DOC_TYPE && (normalizedToolName === TAVERN_STATE_TOOL_NAMES.READ || normalizedToolName === TAVERN_STATE_TOOL_NAMES.PATCH)
                ? (await resolveTavernActiveMapDocument(id)).activeDocId
                : docType === ATLAS_DOC_TYPE
                    ? DEFAULT_ATLAS_DOC_ID
                    : DEFAULT_DOC_ID
        ));

        if (normalizedToolName === TAVERN_STATE_TOOL_NAMES.LIST) {
            const listAllDocTypes = !hasExplicitDocType;
            const activeMapState = listAllDocTypes || docType === MAP_DOC_TYPE
                ? await resolveTavernActiveMapDocument(id, { includeStale: true })
                : null;
            const documents = listAllDocTypes
                ? await listTavernStructuredStateDocuments(id, { includeStale: true })
                : activeMapState?.documents || await listTavernStructuredStateDocuments(id, { docType, includeStale: true });
            const activeMapDocId = activeMapState?.activeDocId || DEFAULT_DOC_ID;
            const sorted = [...documents].sort((left, right) => {
                const leftActive = left.docType === MAP_DOC_TYPE && left.docId === activeMapDocId;
                const rightActive = right.docType === MAP_DOC_TYPE && right.docId === activeMapDocId;
                if (leftActive !== rightActive) {return leftActive ? -1 : 1;}
                if (left.docType !== right.docType) {return left.docType.localeCompare(right.docType);}
                return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0)
                    || (Number(right.revision) || 0) - (Number(left.revision) || 0);
            });
            return {
                ok: true,
                summary: `Found ${sorted.length} map/atlas document(s).`,
                count: sorted.length,
                docId: activeMapDocId,
                documents: sorted.map((document) => ({
                    docType: document.docType,
                    docId: document.docId,
                    title: document.title,
                    revision: document.revision,
                    digest: document.digest,
                    status: document.status,
                    updatedAt: document.updatedAt,
                    active: document.docType === MAP_DOC_TYPE
                        ? document.docId === activeMapDocId
                        : document.docType === ATLAS_DOC_TYPE && document.docId === DEFAULT_ATLAS_DOC_ID,
                })),
            };
        }

        if (normalizedToolName === TAVERN_STATE_TOOL_NAMES.READ) {
            const mode = String(args.mode || 'summary').trim() || 'summary';
            if (docType === ATLAS_DOC_TYPE) {
                const record = await getSeededAtlasDocumentRecord(id);
                if (!record) {
                    return { ok: false, summary: `${docType}/${docId} does not exist.`, docType, docId, error: 'state_document_not_found' };
                }
                const document = normalizeAtlasDocumentFromRecord(record);
                if (mode === 'summary') {
                    return {
                        ok: true,
                        summary: `Read atlas summary, revision ${record.revision}.`,
                        docType,
                        docId,
                        title: record.title,
                        revision: record.revision,
                        digest: createAtlasDigest(document),
                        activeLocationKey: document.activeLocationKey,
                        count: document.locations.length,
                        details: {
                            locationCount: document.locations.length,
                            linkCount: document.links.length,
                            actorCount: document.actors.length,
                        },
                    };
                }
                if (mode === 'document') {
                    return {
                        ok: true,
                        summary: `Read full atlas, revision ${record.revision}.`,
                        docType,
                        docId,
                        title: record.title,
                        revision: record.revision,
                        digest: createAtlasDigest(document),
                        activeLocationKey: document.activeLocationKey,
                        document,
                    };
                }
                if (mode === 'locations') {
                    const result = summarizeAtlasLocations(document, args);
                    return {
                        ok: true,
                        summary: `Matched ${result.count} atlas location(s); returned ${result.locations.length}.`,
                        docType,
                        docId,
                        revision: record.revision,
                        count: result.count,
                        truncated: result.truncated,
                        nextOffset: result.nextOffset,
                        locations: result.locations,
                    };
                }
                if (mode === 'location') {
                    const locationKey = normalizeAtlasKey(args.locationKey ?? args.key);
                    if (!locationKey) {return { ok: false, summary: 'Missing locationKey.', docType, docId, error: 'atlas_location_key_required' };}
                    const location = document.locations.find((item) => item.key === locationKey);
                    if (!location) {return { ok: false, summary: `${locationKey} does not exist.`, docType, docId, revision: record.revision, error: 'atlas_location_not_found' };}
                    return {
                        ok: true,
                        summary: `Read atlas location ${location.name}.`,
                        docType,
                        docId,
                        revision: record.revision,
                        location: {
                            ...cloneJson(location),
                            links: document.links.filter((link) => link.from === locationKey || link.to === locationKey).map((link) => cloneJson(link)),
                            actors: document.actors.filter((actor) => actor.locationKey === locationKey).map((actor) => cloneJson(actor)),
                        },
                    };
                }
                if (mode === 'links') {
                    const result = summarizeAtlasLinks(document, args);
                    return {
                        ok: true,
                        summary: `Matched ${result.count} atlas link(s); returned ${result.links.length}.`,
                        docType,
                        docId,
                        revision: record.revision,
                        count: result.count,
                        truncated: result.truncated,
                        nextOffset: result.nextOffset,
                        links: result.links,
                    };
                }
                if (mode === 'actors') {
                    const actorKey = normalizeActorKey(args.actorKey);
                    const actors = actorKey
                        ? document.actors.filter((actor) => actor.actorKey === actorKey)
                        : document.actors;
                    return {
                        ok: true,
                        summary: `Matched ${actors.length} atlas actor position(s).`,
                        docType,
                        docId,
                        revision: record.revision,
                        count: actors.length,
                        actors: actors.map((actor) => cloneJson(actor)),
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
                        summary: `Found ${patches.length} saved atlas patch transaction(s); returned ${page.length}.`,
                        docType,
                        docId,
                        revision: record.revision,
                        count: patches.length,
                        truncated: nextOffset > 0,
                        nextOffset,
                        patches: page,
                    };
                }
                return { ok: false, summary: `Unsupported atlas MapInspect mode: ${mode}`, docType, docId, error: 'state_read_mode_invalid' };
            }
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
            return { ok: false, summary: `Unsupported MapInspect mode: ${mode}`, docType, docId, error: 'state_read_mode_invalid' };
        }

        if (normalizedToolName === TAVERN_STATE_TOOL_NAMES.PATCH) {
            if (!Array.isArray(args.ops)) {
                return { ok: false, summary: 'MapPatch ops must be a real array.', docType, docId, error: 'state_patch_ops_must_be_array' };
            }
            const ops = args.ops as unknown[];
            const activate = args.activate === true;
            if (!ops.length && !activate) {
                return { ok: false, summary: 'MapPatch ops are required unless activate:true is used to switch active map.', docType, docId, error: 'state_patch_ops_required' };
            }
            if (docType === ATLAS_DOC_TYPE && activate) {
                return { ok: false, summary: 'Atlas has no activate:true operation. Move the player with move-actor(actorKey:"player").', docType, docId, error: 'atlas_activate_not_supported' };
            }
            if (docType === ATLAS_DOC_TYPE) {
                return await db.transaction(
                    'rw',
                    tavernStateDocumentsTable,
                    tavernStatePatchesTable,
                    tavernMessagesTable,
                    tavernSessionsTable,
                    async () => {
                        await options.beforeWriteGuard?.();
                        const existing = await getSeededAtlasDocumentRecord(id);
                        const currentRevision = Number(existing?.revision) || 0;
                        if (Number.isFinite(Number(args.baseRevision)) && Number(args.baseRevision) !== currentRevision) {
                            return {
                                ok: false,
                                summary: `Revision changed: current is ${currentRevision}, but this call was based on ${Number(args.baseRevision)}. Run MapInspect again before patching.`,
                                docType,
                                docId,
                                revision: currentRevision,
                                error: 'state_revision_conflict',
                            };
                        }
                        const currentDocument = normalizeAtlasDocumentFromRecord(existing);
                        const patch = applyAtlasOps(currentDocument, ops);
                        if (patch.failed.length) {
                            const failureSummary = summarizePatchFailures(patch.failed);
                            return {
                                ok: false,
                                summary: `Atlas patch was not saved: ${patch.failed.length} op(s) failed.${failureSummary ? ` ${failureSummary}` : ''}`,
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
                                summary: 'Atlas is already at the target result. No write was needed.',
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
                        const digest = createAtlasDigest(patch.document);
                        if (args.dryRun === true) {
                            return {
                                ok: true,
                                summary: `Dry run passed: ${docType}/${docId} would advance to revision ${nextRevision} with ${patch.appliedCount} applied op(s). Nothing was saved.`,
                                docType,
                                docId,
                                title: atlasTitle(patch.document),
                                revision: currentRevision,
                                digest,
                                changed: true,
                                appliedCount: patch.appliedCount,
                                satisfiedCount: patch.satisfiedCount,
                                failedCount: 0,
                                changedIds: patch.changedIds,
                                warnings: patch.warnings,
                                activeLocationKey: patch.document.activeLocationKey,
                                document: patch.document,
                            };
                        }
                        const timestamp = now();
                        const saved = await putTavernStructuredStateDocument({
                            sessionId: id,
                            docType,
                            docId,
                            title: atlasTitle(patch.document),
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
                            summary: normalizeText(args.desc || `AtlasPatch ${nextRevision}`, 400),
                            ops: patch.effectiveOps,
                            changedIds: patch.changedIds,
                            removedElements: [],
                        });
                        if (patch.syncedActiveMapDocId) {
                            await setActiveMapDocId(id, patch.syncedActiveMapDocId);
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
                            warnings: patch.warnings,
                            activeLocationKey: patch.document.activeLocationKey,
                            document: patch.document,
                        };
                    },
                );
            }
            return await db.transaction(
                'rw',
                tavernStateDocumentsTable,
                tavernStatePatchesTable,
                tavernMessagesTable,
                tavernSessionsTable,
                async () => {
                    await options.beforeWriteGuard?.();
                    const existing = await getTavernStructuredStateDocument(id, docType, docId);
                    const currentRevision = Number(existing?.revision) || 0;
                    if (Number.isFinite(Number(args.baseRevision)) && Number(args.baseRevision) !== currentRevision) {
                        return {
                            ok: false,
                            summary: `Revision changed: current is ${currentRevision}, but this call was based on ${Number(args.baseRevision)}. Run MapInspect again before patching.`,
                            docType,
                            docId,
                            revision: currentRevision,
                            error: 'state_revision_conflict',
                        };
                    }

                    if (!ops.length && activate) {
                        if (!existing) {
                            return { ok: false, summary: `${docType}/${docId} does not exist.`, docType, docId, error: 'state_document_not_found' };
                        }
                        const previousActiveDocId = await getActiveMapDocId(id);
                        const activeDocId = await setActiveMapDocId(id, docId);
                        const warnings = await buildMapAtlasMismatchWarning(id, docId);
                        return {
                            ok: true,
                            summary: `Activated ${docType}/${docId}.`,
                            docType,
                            docId,
                            title: existing.title,
                            revision: currentRevision,
                            digest: existing.digest,
                            changed: previousActiveDocId !== activeDocId,
                            appliedCount: 0,
                            satisfiedCount: 0,
                            failedCount: 0,
                            warnings,
                        };
                    }

                    const currentDocument = existing ? normalizeMapDocumentFromRecord(existing) : defaultMapDocument();
                    const patch = applyMapOps(currentDocument, ops);
                    if (patch.failed.length) {
                        const failureSummary = summarizePatchFailures(patch.failed);
                        return {
                            ok: false,
                            summary: `MapPatch was not saved: ${patch.failed.length} op(s) failed.${failureSummary ? ` ${failureSummary}` : ''}`,
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
                        let activeChanged = false;
                        if (activate && args.dryRun !== true) {
                            if (!existing) {
                                return { ok: false, summary: `${docType}/${docId} does not exist.`, docType, docId, error: 'state_document_not_found' };
                            }
                            const previousActiveDocId = await getActiveMapDocId(id);
                            const activeDocId = await setActiveMapDocId(id, docId);
                            activeChanged = previousActiveDocId !== activeDocId;
                        }
                        const activateWarnings = activate && args.dryRun !== true
                            ? await buildMapAtlasMismatchWarning(id, docId)
                            : [];
                        return {
                            ok: true,
                            summary: activeChanged
                                ? `Activated ${docType}/${docId}. State was already at the target result.`
                                : 'State is already at the target result. No write was needed.',
                            docType,
                            docId,
                            revision: currentRevision,
                            changed: activeChanged,
                            appliedCount: 0,
                            satisfiedCount: patch.satisfiedCount,
                            failedCount: 0,
                            warnings: [...patch.warnings, ...activateWarnings],
                        };
                    }

                    const nextRevision = currentRevision + 1;
                    const timestamp = now();
                    if (args.dryRun === true) {
                        const digest = createMapDigest(patch.document, nextRevision);
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

                    const actorDedupe = await dedupeActorElementsForSavedDocument({
                        sessionId: id,
                        docType,
                        docId,
                        document: patch.document,
                        timestamp,
                        managerRunId: options.managerRunId,
                        sourceUserOrder: options.sourceUserOrder,
                        sourceAssistantOrder: options.sourceAssistantOrder,
                    });
                    const nextDocument = actorDedupe.document;
                    const effectiveOps = [...patch.effectiveOps, ...actorDedupe.removedElements.map((element) => ({ op: 'remove' as const, id: element.id }))];
                    const removedElements = [...patch.removedElements, ...actorDedupe.removedElements];
                    const changedIds = [...new Set([
                        ...patch.changedIds,
                        ...actorDedupe.removedElements.map((element) => element.id),
                    ])];
                    const digest = createMapDigest(nextDocument, nextRevision);

                    const saved = await putTavernStructuredStateDocument({
                        sessionId: id,
                        docType,
                        docId,
                        title: mapTitle(nextDocument),
                        revision: nextRevision,
                        data: nextDocument,
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
                        summary: normalizeText(args.desc || `MapPatch ${nextRevision}`, 400),
                        ops: effectiveOps,
                        changedIds,
                        removedElements,
                    });
                    if (activate) {
                        await setActiveMapDocId(id, docId);
                    }
                    const activateWarnings = activate
                        ? await buildMapAtlasMismatchWarning(id, docId)
                        : [];
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
                        changedIds,
                        removedElements,
                        warnings: [...patch.warnings, ...activateWarnings],
                        meta: cloneJson(nextDocument.meta),
                        elementCount: nextDocument.elements.length,
                    };
                },
            );
        }

        return { ok: false, summary: `${toolName} is not available.`, error: 'state_tool_not_available' };
    } catch (error) {
        const name = error instanceof Error ? error.name : '';
        const message = error instanceof Error ? error.message : String(error || 'state_tool_failed');
        if (name === 'AbortError' || message === 'manager_source_messages_changed' || message === 'manager_epoch_expired' || message === 'manager_aborted') {
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
    documents: TavernMapStateDocumentItem[];
    activeDocId: string;
    activeDocument: TavernStructuredStateDocumentRecord | null;
    activePatches: TavernStructuredStatePatchRecord[];
}> {
    const resolved = await resolveTavernActiveMapDocument(sessionId);
    const activeDocId = resolved.activeDocId;
    const rows = resolved.documents;
    const visibleRows = rows.some((record) => !isUninitializedSeedMapRecord(record))
        ? rows.filter((record) => !isUninitializedSeedMapRecord(record))
        : rows;
    const documents = visibleRows
        .map((record) => {
            const normalized = normalizeMapDocumentFromRecord(record);
            return {
                ...record,
                data: normalized,
                docType: record.docType,
                docId: record.docId,
                title: mapTitle(normalized),
                revision: record.revision,
                digest: createMapDigest(normalized, record.revision),
                status: record.status,
                updatedAt: record.updatedAt,
                active: record.docId === activeDocId,
            };
        })
        .sort((left, right) => {
            if (!!left.active !== !!right.active) {return left.active ? -1 : 1;}
            return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0)
                || (Number(right.revision) || 0) - (Number(left.revision) || 0);
        });
    const record = resolved.record;
    const normalizedDocument = record ? normalizeMapDocumentFromRecord(record) : null;
    const activePatches = record
        ? await listTavernStructuredStatePatches({ sessionId, docType: MAP_DOC_TYPE, docId: record.docId, limit: 80 })
        : [];
    if (!record || !normalizedDocument) {
        return { documents, activeDocId, activeDocument: null, activePatches: [] };
    }
    return {
        documents,
        activeDocId,
        activeDocument: {
            ...record,
            data: normalizedDocument,
            title: mapTitle(normalizedDocument),
            digest: createMapDigest(normalizedDocument, record.revision),
        },
        activePatches,
    };
}

export async function getTavernAtlasStateForSession(sessionId = ''): Promise<{
    document: TavernStructuredStateDocumentRecord | null;
    patches: TavernStructuredStatePatchRecord[];
    activeLocationKey: string;
}> {
    const record = await getSeededAtlasDocumentRecord(sessionId);
    if (!record) {return { document: null, patches: [], activeLocationKey: '' };}
    const normalized = normalizeAtlasDocumentFromRecord(record);
    const patches = await listTavernStructuredStatePatches({
        sessionId,
        docType: ATLAS_DOC_TYPE,
        docId: DEFAULT_ATLAS_DOC_ID,
        limit: 80,
    });
    return {
        document: {
            ...record,
            data: normalized,
            title: atlasTitle(normalized),
            digest: createAtlasDigest(normalized),
        },
        patches,
        activeLocationKey: normalized.activeLocationKey || '',
    };
}

function atlasLocationLabel(location: TavernAtlasLocation | undefined): string {
    if (!location) {return '';}
    return location.brief
        ? `${location.name}（${location.brief}）`
        : location.name;
}

function mapDigestLabels(digest = ''): string {
    return String(digest || '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('标注：'))
        ?.replace(/^标注：/, '')
        .trim() || '';
}

export async function buildTavernSpatialStateDigest(sessionId = ''): Promise<string> {
    await ensureSeedStructuredStateDocument(sessionId, { touchSession: false });
    const atlasRecord = await getTavernStructuredStateDocument(sessionId, ATLAS_DOC_TYPE, DEFAULT_ATLAS_DOC_ID);
    const atlas = normalizeAtlasDocumentFromRecord(atlasRecord);
    const locations = new Map(atlas.locations.map((location) => [location.key, location]));
    const active = atlas.activeLocationKey ? locations.get(atlas.activeLocationKey) : undefined;
    if (!active) {return '';}
    const parent = active.parent ? locations.get(active.parent) : undefined;
    const adjacent = atlas.links
        .flatMap((link) => {
            if (link.from === active.key) {return [locations.get(link.to)];}
            if (link.bidirectional && link.to === active.key) {return [locations.get(link.from)];}
            return [];
        })
        .filter((location): location is TavernAtlasLocation => !!location);
    const visited = atlas.locations
        .filter((location) => location.status === 'visited')
        .map((location) => location.name)
        .filter(Boolean);
    const mentioned = atlas.locations
        .filter((location) => location.status === 'mentioned')
        .map((location) => location.name)
        .filter(Boolean);
    const actorLines = atlas.actors
        .map((actor) => {
            const location = locations.get(actor.locationKey);
            return location ? `${actor.actorKey === 'player' ? '玩家' : actor.actorKey}=${location.name}` : '';
        })
        .filter(Boolean);
    const mapRecord = active.mapDocId
        ? await getTavernStructuredStateDocument(sessionId, MAP_DOC_TYPE, active.mapDocId)
        : null;
    const mapDigest = mapRecord ? createMapDigest(normalizeMapDocumentFromRecord(mapRecord), mapRecord.revision) : '';
    const sceneLabels = mapDigestLabels(mapDigest);

    return [
        `当前地点：${atlasLocationLabel(active)}`,
        parent ? `上级地点：${parent.name}` : '',
        adjacent.length ? `相邻地点：${adjacent.map((location) => atlasLocationLabel(location)).join('、')}` : '',
        visited.length ? `已探索地点：${visited.join('、')}` : '',
        mentioned.length ? `已知但未到达：${mentioned.join('、')}` : '',
        actorLines.length ? `人物位置：${actorLines.join('，')}` : '',
        sceneLabels ? `当前场景标注：${sceneLabels}` : active.mapDocId ? '当前场景标注：暂无' : '当前地点暂无详细地图',
    ].filter(Boolean).join('\n');
}

export async function listTavernStructuredStateDigests(sessionId = '') {
    const { record } = await resolveTavernActiveMapDocument(sessionId);
    if (!record) {return [];}
    const normalized = normalizeMapDocumentFromRecord(record);
    if (normalized.meta.status !== 'active' || isUninitializedMapData(normalized)) {return [];}
    return [{
        docType: record.docType,
        docId: record.docId,
        title: mapTitle(normalized),
        revision: record.revision,
        digest: createMapDigest(normalized, record.revision),
    }];
}
