import db, {
    appendTavernStructuredStatePatch,
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

export const TAVERN_STATE_TOOL_NAMES = {
    LIST: 'StateList',
    READ: 'StateRead',
    PATCH: 'StatePatch',
} as const;

export type TavernMapElementType = 'line' | 'curve' | 'rect' | 'circle' | 'arc' | 'icon' | 'fill' | 'text';
export type TavernMapElementCategory = 'wall' | 'road' | 'water' | 'terrain' | 'furniture' | 'door' | 'danger' | 'marker' | 'label' | 'grid' | 'magic' | 'secret';

export interface TavernMapDocument {
    meta: {
        name?: string;
        theme?: 'parchment' | 'paper' | 'dark' | 'blueprint' | 'grid';
        viewBox?: [number, number, number, number];
        [key: string]: unknown;
    };
    elements: TavernMapElement[];
}

export interface TavernMapElement {
    id: string;
    type: TavernMapElementType;
    cat?: TavernMapElementCategory;
    [key: string]: unknown;
}

export type TavernMapPatchOp =
    | { op: 'init'; document?: TavernMapDocument; meta?: TavernMapDocument['meta']; elements?: TavernMapElement[]; replaceDocument?: boolean }
    | { op: 'reset'; document?: TavernMapDocument; meta?: TavernMapDocument['meta']; elements?: TavernMapElement[] }
    | { op: 'add'; element: TavernMapElement }
    | { op: 'remove'; id: string }
    | { op: 'modify'; id: string; changes: Record<string, unknown> }
    | { op: 'replace'; id: string; element: TavernMapElement }
    | { op: 'meta'; changes: Record<string, unknown> };

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

const MAP_DOC_TYPE: TavernStructuredStateDocType = 'tavern.map';
const DEFAULT_DOC_ID = 'main';
const MAX_MAP_ELEMENTS = 500;
const MAX_STATE_PATCH_OPS = 80;
const MAX_STATE_READ_LIMIT = 100;

const MAP_ELEMENT_TYPES = new Set(['line', 'curve', 'rect', 'circle', 'arc', 'icon', 'fill', 'text']);
const MAP_ELEMENT_CATEGORIES = new Set(['wall', 'road', 'water', 'terrain', 'furniture', 'door', 'danger', 'marker', 'label', 'grid', 'magic', 'secret']);
const MAP_THEMES = new Set(['parchment', 'paper', 'dark', 'blueprint', 'grid']);

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
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit) : text;
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

function normalizeNumberTuple(value: unknown, fallback: [number, number, number, number]): [number, number, number, number] {
    if (!Array.isArray(value) || value.length !== 4) {return fallback;}
    const numbers = value.map((item) => Number(item));
    if (numbers.some((item) => !Number.isFinite(item))) {return fallback;}
    return numbers as [number, number, number, number];
}

function normalizeMapMeta(value: unknown = {}): TavernMapDocument['meta'] {
    const source = isPlainObject(value) ? value : {};
    const theme = String(source.theme || 'parchment').trim();
    return {
        ...cloneJson(source),
        name: normalizeText(source.name || '地图', 120) || '地图',
        theme: (MAP_THEMES.has(theme) ? theme : 'parchment') as TavernMapDocument['meta']['theme'],
        viewBox: normalizeNumberTuple(source.viewBox, [0, 0, 800, 600]),
    };
}

function normalizeMapElement(value: unknown): TavernMapElement {
    if (!isPlainObject(value)) {throw new Error('map_element_must_be_object');}
    const id = String(value.id || '').trim();
    const type = String(value.type || '').trim();
    if (!id || !/^[\w:.-]{1,120}$/i.test(id)) {throw new Error('map_element_id_invalid');}
    if (!MAP_ELEMENT_TYPES.has(type)) {throw new Error(`map_element_type_invalid:${id}`);}
    const cat = String(value.cat || 'wall').trim();
    if (cat && !MAP_ELEMENT_CATEGORIES.has(cat)) {throw new Error(`map_element_cat_invalid:${id}`);}
    return {
        ...cloneJson(value),
        id,
        type: type as TavernMapElementType,
        ...(cat ? { cat: cat as TavernMapElementCategory } : {}),
    };
}

function normalizeMapDocument(value: unknown = {}): TavernMapDocument {
    const source = isPlainObject(value) ? value : {};
    const elements = Array.isArray(source.elements)
        ? source.elements.map((element) => normalizeMapElement(element))
        : [];
    if (elements.length > MAX_MAP_ELEMENTS) {throw new Error('map_elements_limit_exceeded');}
    const ids = new Set<string>();
    elements.forEach((element) => {
        if (ids.has(element.id)) {throw new Error(`map_element_duplicate:${element.id}`);}
        ids.add(element.id);
    });
    return {
        meta: normalizeMapMeta(source.meta),
        elements,
    };
}

function defaultMapDocument(): TavernMapDocument {
    return normalizeMapDocument({
        meta: { name: '地图', theme: 'parchment', viewBox: [0, 0, 800, 600] },
        elements: [],
    });
}

function stableStringify(value: unknown): string {
    return JSON.stringify(value ?? null);
}

function deepEqual(left: unknown, right: unknown): boolean {
    return stableStringify(left) === stableStringify(right);
}

function mergeObject(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const next = { ...target };
    Object.entries(patch).forEach(([key, value]) => {
        if (value === null) {
            delete next[key];
            return;
        }
        if (isPlainObject(value) && isPlainObject(next[key])) {
            next[key] = mergeObject(next[key] as Record<string, unknown>, value);
            return;
        }
        next[key] = cloneJson(value);
    });
    return next;
}

function createMapDigest(document: TavernMapDocument, revision = 0): string {
    const title = normalizeText(document.meta.name || '地图', 80);
    const byCat = new Map<string, TavernMapElement[]>();
    document.elements.forEach((element) => {
        const cat = String(element.cat || 'wall');
        const group = byCat.get(cat) || [];
        group.push(element);
        byCat.set(cat, group);
    });
    const labelTexts = document.elements
        .filter((element) => element.type === 'text')
        .map((element) => normalizeText(element.content, 40))
        .filter(Boolean)
        .slice(0, 8);
    const dangerIds = (byCat.get('danger') || []).map((element) => element.id).slice(0, 8);
    const doorIds = (byCat.get('door') || []).map((element) => element.id).slice(0, 8);
    const lines = [
        `地图：${title}（revision ${revision}，${document.elements.length} 个元素）`,
        labelTexts.length ? `标注：${labelTexts.join('、')}` : '',
        doorIds.length ? `门路：${doorIds.join('、')}` : '',
        dangerIds.length ? `危险/标记：${dangerIds.join('、')}` : '',
    ].filter(Boolean);
    return lines.join('\n');
}

function mapTitle(document: TavernMapDocument): string {
    return normalizeText(document.meta.name || '地图', 120) || '地图';
}

function mapElementSummary(element: TavernMapElement): TavernMapElement {
    return cloneJson(element);
}

function patchOpName(value: unknown): string {
    return isPlainObject(value) ? String(value.op || '').trim() : '';
}

function hasBaseRevision(value: unknown): boolean {
    return Number.isFinite(Number(value));
}

function requiresBaseRevision(op = ''): boolean {
    return ['init', 'reset', 'remove', 'modify', 'replace', 'meta'].includes(op);
}

function patchPreconditionError(input: {
    existing: boolean;
    currentRevision: number;
    docType: TavernStructuredStateDocType;
    docId: string;
    baseRevision: unknown;
    ops: unknown[];
}): TavernStateToolResult | null {
    const opNames = input.ops.map(patchOpName);
    const hasBase = hasBaseRevision(input.baseRevision);
    const hasExistingInit = input.existing && opNames.includes('init');
    const hasReset = opNames.includes('reset');
    const hasInitReplace = input.existing && input.ops.some((op) => isPlainObject(op) && patchOpName(op) === 'init' && op.replaceDocument === true);
    if (!input.existing && hasReset) {
        return {
            ok: false,
            summary: '当前地图还不存在；第一次创建请使用 init，不要使用 reset。',
            docType: input.docType,
            docId: input.docId,
            revision: input.currentRevision,
            error: 'state_reset_document_not_found',
        };
    }
    if (hasExistingInit) {
        if (!hasInitReplace) {
            return {
                ok: false,
                summary: '当前地图已存在。init 只用于第一次建图；如果剧情确实切到新地图，请先 StateRead summary 获取 revision，然后用 reset，或 init + replaceDocument:true。',
                docType: input.docType,
                docId: input.docId,
                revision: input.currentRevision,
                error: 'state_init_existing_document_requires_reset',
            };
        }
    }
    if ((hasReset || hasInitReplace) && input.ops.length > 1) {
        return {
            ok: false,
            summary: '整体换图必须单独提交一次 StatePatch；请把新地图的全部元素放进 reset/init-replace 的 document.elements 里，不要和 add/modify/remove 混在同一批。',
            docType: input.docType,
            docId: input.docId,
            revision: input.currentRevision,
            error: 'state_whole_document_replace_must_be_single_op',
        };
    }
    if (input.existing && opNames.some(requiresBaseRevision) && !hasBase) {
        return {
            ok: false,
            summary: '这次 StatePatch 会修改、删除或整体替换已有地图。请先 StateRead summary/document 获取当前 revision，并带上 baseRevision 后再写。',
            docType: input.docType,
            docId: input.docId,
            revision: input.currentRevision,
            error: 'state_base_revision_required',
        };
    }
    return null;
}

function summarizeMapElements(document: TavernMapDocument, args: Record<string, unknown> = {}): {
    elements: TavernMapElement[];
    count: number;
    truncated: boolean;
    nextOffset: number;
} {
    const query = normalizeText(args.query, 120).toLowerCase();
    const type = String(args.elementType || args.type || '').trim();
    const category = String(args.category || args.cat || '').trim();
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Math.min(MAX_STATE_READ_LIMIT, Number(args.limit) || 30));
    const matches = document.elements.filter((element) => {
        if (type && element.type !== type) {return false;}
        if (category && String(element.cat || '') !== category) {return false;}
        if (!query) {return true;}
        const haystack = [
            element.id,
            element.type,
            element.cat,
            element.content,
            element.label,
            element.name,
            element.note,
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

function applyMapOps(source: TavernMapDocument, ops: unknown[]): {
    document: TavernMapDocument;
    appliedCount: number;
    satisfiedCount: number;
    failed: Array<{ index: number; error: string }>;
    warnings: string[];
    changedIds: string[];
    removedElements: TavernMapElement[];
    changed: boolean;
} {
    if (!Array.isArray(ops)) {throw new Error('state_patch_ops_must_be_array');}
    if (!ops.length) {throw new Error('state_patch_ops_required');}
    if (ops.length > MAX_STATE_PATCH_OPS) {throw new Error('state_patch_ops_limit_exceeded');}
    let document = normalizeMapDocument(source);
    let appliedCount = 0;
    let satisfiedCount = 0;
    const failed: Array<{ index: number; error: string }> = [];
    const warnings: string[] = [];
    const changedIds = new Set<string>();
    const removedElements: TavernMapElement[] = [];
    let changed = false;

    const elementIndex = () => new Map(document.elements.map((element, index) => [element.id, { element, index }]));

    ops.forEach((rawOp, index) => {
        try {
            if (!isPlainObject(rawOp)) {throw new Error('op_must_be_object');}
            const op = String(rawOp.op || '').trim();
            if (op === 'init' || op === 'reset') {
                const nextDocument = normalizeMapDocument(rawOp.document || {
                    meta: rawOp.meta,
                    elements: rawOp.elements,
                });
                if (deepEqual(document, nextDocument)) {
                    satisfiedCount += 1;
                    return;
                }
                document = nextDocument;
                changed = true;
                appliedCount += 1;
                document.elements.forEach((element) => changedIds.add(element.id));
                return;
            }
            if (op === 'add') {
                const element = normalizeMapElement(rawOp.element);
                const current = elementIndex().get(element.id);
                if (current) {
                    if (deepEqual(current.element, element)) {
                        satisfiedCount += 1;
                        return;
                    }
                    throw new Error(`map_element_already_exists:${element.id}`);
                }
                document.elements.push(element);
                changed = true;
                appliedCount += 1;
                changedIds.add(element.id);
                return;
            }
            if (op === 'remove') {
                const id = String(rawOp.id || '').trim();
                if (!id) {throw new Error('map_element_id_required');}
                const current = elementIndex().get(id);
                if (!current) {
                    warnings.push(`remove skipped; ${id} 不存在`);
                    satisfiedCount += 1;
                    return;
                }
                removedElements.push(cloneJson(current.element));
                document.elements.splice(current.index, 1);
                changed = true;
                appliedCount += 1;
                changedIds.add(id);
                return;
            }
            if (op === 'modify') {
                const id = String(rawOp.id || '').trim();
                if (!id) {throw new Error('map_element_id_required');}
                if (!isPlainObject(rawOp.changes)) {throw new Error(`map_element_changes_required:${id}`);}
                const current = elementIndex().get(id);
                if (!current) {throw new Error(`map_element_not_found:${id}`);}
                const nextElement = normalizeMapElement(mergeObject(current.element, rawOp.changes));
                if (nextElement.id !== id) {throw new Error(`map_element_id_cannot_change:${id}`);}
                if (deepEqual(current.element, nextElement)) {
                    satisfiedCount += 1;
                    return;
                }
                document.elements[current.index] = nextElement;
                changed = true;
                appliedCount += 1;
                changedIds.add(id);
                return;
            }
            if (op === 'replace') {
                const id = String(rawOp.id || '').trim();
                if (!id) {throw new Error('map_element_id_required');}
                const nextElement = normalizeMapElement(rawOp.element);
                if (nextElement.id !== id) {throw new Error(`map_element_id_mismatch:${id}`);}
                const current = elementIndex().get(id);
                if (!current) {throw new Error(`map_element_not_found:${id}`);}
                if (deepEqual(current.element, nextElement)) {
                    satisfiedCount += 1;
                    return;
                }
                document.elements[current.index] = nextElement;
                changed = true;
                appliedCount += 1;
                changedIds.add(id);
                return;
            }
            if (op === 'meta') {
                if (!isPlainObject(rawOp.changes)) {throw new Error('map_meta_changes_required');}
                const nextMeta = normalizeMapMeta(mergeObject(document.meta, rawOp.changes));
                if (deepEqual(document.meta, nextMeta)) {
                    satisfiedCount += 1;
                    return;
                }
                document.meta = nextMeta;
                changed = true;
                appliedCount += 1;
                changedIds.add('meta');
                return;
            }
            throw new Error(`map_op_not_supported:${op || 'empty'}`);
        } catch (error) {
            failed.push({ index, error: error instanceof Error ? error.message : String(error || 'map_op_failed') });
        }
    });

    if (document.elements.length > MAX_MAP_ELEMENTS) {
        failed.push({ index: -1, error: 'map_elements_limit_exceeded' });
    }

    return {
        document,
        appliedCount,
        satisfiedCount,
        failed,
        warnings,
        changedIds: [...changedIds],
        removedElements,
        changed,
    };
}

export function getTavernStateToolDefinitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    return [
        {
            type: 'function',
            function: {
                name: TAVERN_STATE_TOOL_NAMES.LIST,
                description: [
                    'List structured state documents in the current session.',
                    'Structured state is session-scoped JSON-like state maintained by tools, not raw RP text and not memory Markdown.',
                    'Use this before reading or patching visual/session state such as `tavern.map`, especially when you do not know whether a document exists.',
                    'Returns docType, docId, title, revision, digest, status, and timestamps only; it does not expose raw JSON.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        docType: { type: 'string', enum: [MAP_DOC_TYPE], description: 'Optional state kind. Currently supports tavern.map.' },
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
                    'Read structured state for the current session.',
                    'Use summary for a compact digest, elements to locate map ids, element for one stable id, document for the full current JSON, and history for applied patch records.',
                    'For maps, read summary first to get title, revision, and digest. Then use elements with category/type/query to find ids. Read document only when you truly need the full structure before StatePatch.',
                    'history returns applied patch records only. It supports offset/limit and tail. Rolled-back patches are hidden from normal history.',
                    'StateRead never replaces ChatHistory or MemoryRead: use ChatHistory for original RP facts and MemoryRead for Markdown memory files.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        docType: { type: 'string', enum: [MAP_DOC_TYPE], description: 'State kind. Currently supports tavern.map.' },
                        docId: { type: 'string', description: 'Document id. Defaults to main.' },
                        mode: { type: 'string', enum: ['summary', 'elements', 'document', 'element', 'history'], description: 'Read mode. Defaults to summary.' },
                        elementId: { type: 'string', description: 'Map element id for element mode.' },
                        elementType: { type: 'string', enum: [...MAP_ELEMENT_TYPES], description: 'Optional element type filter for elements mode.' },
                        category: { type: 'string', enum: [...MAP_ELEMENT_CATEGORIES], description: 'Optional category filter for elements mode.' },
                        query: { type: 'string', description: 'Optional text filter for elements mode. Searches id/type/category/content/label/name/note.' },
                        offset: { type: 'number', minimum: 0, description: 'Pagination offset for history mode.' },
                        limit: { type: 'number', minimum: 1, maximum: MAX_STATE_READ_LIMIT, description: 'Maximum history or element records to return.' },
                        tail: { type: 'number', minimum: 1, maximum: MAX_STATE_READ_LIMIT, description: 'Return final N history records.' },
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
                    'Apply semantic ops to a structured state document in the current session.',
                    'This is not raw JSON Patch; use stable map element ids and map ops: init, add, remove, modify, replace, meta, reset.',
                    '`ops` must be a real JSON array, not a quoted string. The patch is atomic: if any op fails, nothing is saved.',
                    'Use dryRun:true to validate ops before saving. dryRun reports the would-be digest/revision but does not save the document, patch history, or snapshots.',
                    'Read StateRead summary/elements first when you need revision or existing ids.',
                    'init creates the first map only. To switch to a genuinely new whole map when one already exists, use reset or init + replaceDocument:true as a single-op patch, include baseRevision, and put every new element in document.elements.',
                    'Existing-map remove/modify/replace/meta/reset/init-replace require baseRevision. add can be used without baseRevision for incremental new elements, but include baseRevision when you are coordinating with other recent edits.',
                    'add with an existing identical element is satisfied; add with the same id but different content fails. remove of a missing id is satisfied with a warning. modify/replace require an existing id.',
                    'Do not update the map for guesses, future plans, or events that did not happen in RP.',
                    'Map updates are auxiliary; automatic after-turn managers must still write the readable per-exchange memory file with MemoryWrite or MemoryEdit.',
                ].join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        docType: { type: 'string', enum: [MAP_DOC_TYPE], description: 'State kind. Currently supports tavern.map.' },
                        docId: { type: 'string', description: 'Document id. Defaults to main.' },
                        baseRevision: { type: 'number', description: 'Revision from StateRead summary/document. Required for remove/modify/replace/meta/reset or replacing an existing map.' },
                        dryRun: { type: 'boolean', description: 'Validate and preview this patch without saving document, patch history, or snapshots.' },
                        desc: { type: 'string', description: 'Short human summary of what changed this turn.' },
                        ops: {
                            type: 'array',
                            description: 'Semantic map ops. Use init only for a missing map; add requires element; remove/modify/replace require id; modify requires changes; reset/init-replace replaces the whole map, must be the only op in that patch, and requires baseRevision.',
                            items: {
                                type: 'object',
                                properties: {
                                    op: { type: 'string', enum: ['init', 'add', 'remove', 'modify', 'replace', 'meta', 'reset'] },
                                    id: { type: 'string' },
                                    element: { type: 'object' },
                                    document: { type: 'object' },
                                    meta: { type: 'object' },
                                    elements: { type: 'array', items: { type: 'object' } },
                                    changes: { type: 'object' },
                                    replaceDocument: { type: 'boolean' },
                                },
                                required: ['op'],
                                additionalProperties: true,
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
    if (!id) {return { ok: false, summary: '缺少 sessionId。', error: 'state_session_required' };}
    try {
        const docType = normalizeDocType(args.docType || MAP_DOC_TYPE);
        const docId = normalizeDocId(args.docId || DEFAULT_DOC_ID);

        if (toolName === TAVERN_STATE_TOOL_NAMES.LIST) {
            const documents = await listTavernStructuredStateDocuments(id, { docType, includeStale: true });
            return {
                ok: true,
                summary: `找到 ${documents.length} 份结构化状态。`,
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
            const document = await getTavernStructuredStateDocument(id, docType, docId);
            if (!document) {
                return { ok: false, summary: `${docType}/${docId} 不存在。`, docType, docId, error: 'state_document_not_found' };
            }
            if (mode === 'summary') {
                return {
                    ok: true,
                    summary: `读取 ${document.title || docId} 摘要，revision ${document.revision}。`,
                    docType,
                    docId,
                    title: document.title,
                    revision: document.revision,
                    digest: document.digest,
                };
            }
            if (mode === 'document') {
                return {
                    ok: true,
                    summary: `读取 ${document.title || docId} 完整状态，revision ${document.revision}。`,
                    docType,
                    docId,
                    title: document.title,
                    revision: document.revision,
                    digest: document.digest,
                    document: document.data,
                };
            }
            if (mode === 'element') {
                const elementId = String(args.elementId || '').trim();
                if (!elementId) {return { ok: false, summary: '缺少 elementId。', docType, docId, error: 'state_element_id_required' };}
                const map = normalizeMapDocument(document.data);
                const element = map.elements.find((item) => item.id === elementId);
                if (!element) {return { ok: false, summary: `${elementId} 不存在。`, docType, docId, revision: document.revision, error: 'state_element_not_found' };}
                return {
                    ok: true,
                    summary: `读取元素 ${elementId}。`,
                    docType,
                    docId,
                    revision: document.revision,
                    element: mapElementSummary(element),
                };
            }
            if (mode === 'elements') {
                const map = normalizeMapDocument(document.data);
                const result = summarizeMapElements(map, args);
                return {
                    ok: true,
                    summary: `匹配 ${result.count} 个地图元素，返回 ${result.elements.length} 个。`,
                    docType,
                    docId,
                    revision: document.revision,
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
                    summary: `共有 ${patches.length} 条状态补丁，返回 ${page.length} 条。`,
                    docType,
                    docId,
                    revision: document.revision,
                    count: patches.length,
                    truncated: nextOffset > 0,
                    nextOffset,
                    patches: page,
                };
            }
            return { ok: false, summary: `不支持的 StateRead 模式：${mode}`, docType, docId, error: 'state_read_mode_invalid' };
        }

        if (toolName === TAVERN_STATE_TOOL_NAMES.PATCH) {
            if (!Array.isArray(args.ops)) {
                return { ok: false, summary: 'StatePatch ops 必须是真正的数组。', docType, docId, error: 'state_patch_ops_must_be_array' };
            }
            const ops = args.ops;
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
                    const preconditionError = patchPreconditionError({
                        existing: !!existing,
                        currentRevision,
                        docType,
                        docId,
                        baseRevision: args.baseRevision,
                        ops,
                    });
                    if (preconditionError) {return preconditionError;}
                    if (Number.isFinite(Number(args.baseRevision)) && Number(args.baseRevision) !== currentRevision) {
                        return {
                            ok: false,
                            summary: `revision 已变化：当前 ${currentRevision}，调用基于 ${Number(args.baseRevision)}。请重新 StateRead 后再改。`,
                            docType,
                            docId,
                            revision: currentRevision,
                            error: 'state_revision_conflict',
                        };
                    }
                    const currentDocument = existing ? normalizeMapDocument(existing.data) : defaultMapDocument();
                    const patch = applyMapOps(currentDocument, ops);
                    if (patch.failed.length) {
                        return {
                            ok: false,
                            summary: `StatePatch 未保存：${patch.failed.length} 项失败。`,
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
                            summary: `状态已是目标结果，无需重复写入。`,
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
                    if (args.dryRun === true) {
                        const nextRevision = currentRevision + 1;
                        const digest = createMapDigest(patch.document, nextRevision);
                        return {
                            ok: true,
                            summary: `dryRun 通过：将更新 ${docType}/${docId} 到 revision ${nextRevision}，应用 ${patch.appliedCount} 项；未保存。`,
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
                        };
                    }
                    if (options.managerRunId) {
                        await ensureTavernManagerStateSnapshot({ managerRunId: options.managerRunId, sessionId: id, docType, docId });
                    }
                    const nextRevision = currentRevision + 1;
                    const digest = createMapDigest(patch.document, nextRevision);
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
                        source: 'manager',
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
                        ops,
                        changedIds: patch.changedIds,
                        removedElements: patch.removedElements,
                    });
                    if (options.managerRunId) {
                        await updateTavernManagerStateSnapshotAfter({ managerRunId: options.managerRunId, sessionId: id, docType, docId });
                    }
                    return {
                        ok: true,
                        summary: `已更新 ${docType}/${docId} 到 revision ${saved.revision}，应用 ${patch.appliedCount} 项。`,
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
                    };
                },
            );
        }
        return { ok: false, summary: `${toolName} 不可用。`, error: 'state_tool_not_available' };
    } catch (error) {
        const name = error instanceof Error ? error.name : '';
        const message = error instanceof Error ? error.message : String(error || 'state_tool_failed');
        if (name === 'AbortError' || message === 'manager_source_messages_changed' || message === 'manager_aborted') {
            throw error;
        }
        return {
            ok: false,
            summary: message,
            error: message,
        };
    }
}

export async function getTavernMapStateForSession(sessionId = ''): Promise<{
    document: TavernStructuredStateDocumentRecord | null;
    patches: TavernStructuredStatePatchRecord[];
}> {
    const document = await getTavernStructuredStateDocument(sessionId, MAP_DOC_TYPE, DEFAULT_DOC_ID);
    const patches = document
        ? await listTavernStructuredStatePatches({ sessionId, docType: MAP_DOC_TYPE, docId: DEFAULT_DOC_ID, limit: 80 })
        : [];
    return { document, patches };
}

export async function listTavernStructuredStateDigests(sessionId = '') {
    const documents = await listTavernStructuredStateDocuments(sessionId, { includeStale: false });
    return documents.map((document) => ({
        docType: document.docType,
        docId: document.docId,
        title: document.title,
        revision: document.revision,
        digest: document.digest,
    }));
}
