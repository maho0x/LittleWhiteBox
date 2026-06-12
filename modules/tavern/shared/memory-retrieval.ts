import type {
    XbTavernContext,
    XbTavernMemoryContext,
} from './message-assembler';
import { extensionFolderPath } from '../../../core/constants.js';
import { getTavernMemoryIndex, rebuildTavernMemoryDerivedIndex } from './memory-files';
import { listTavernStructuredStateDigests } from './structured-state';
import * as stopwordsBase from '../../story-summary/vector/utils/stopwords-base.js';
import * as stopwordsPatch from '../../story-summary/vector/utils/stopwords-patch.js';
import {
    type TavernMemoryFileRecord,
    type TavernMemoryIndexFileEntry,
} from './session-db';

export interface XbTavernMemorySelectionInput {
    memoryFiles?: Array<TavernMemoryIndexFileEntry | TavernMemoryFileRecord>;
    queryText?: string;
    ignoredTerms?: string[];
}

interface MemoryDocument {
    id: string;
    text: string;
    tokens: Set<string>;
    termWeights: Map<string, number>;
    weightedLength: number;
}

interface WeightedMemoryField {
    text: string;
    weight: number;
}

type JiebaModule = {
    default?: (options?: Record<string, unknown>) => Promise<unknown>;
    cut?: (text: string, hmm?: boolean) => unknown[];
};

type TinySegmenterInstance = {
    segment: (text: string) => string[];
};

type MemoryTokenizerStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'unavailable';

const STOP_WORDS = new Set<string>([
    ...(((stopwordsBase as { BASE_STOP_WORDS?: string[] }).BASE_STOP_WORDS) || []),
    ...(((stopwordsPatch as { DOMAIN_STOP_WORDS?: string[] }).DOMAIN_STOP_WORDS) || []),
].map((word) => normalizeText(word)).filter(Boolean));
const KEEP_WORDS = new Set<string>((((stopwordsPatch as { KEEP_WORDS?: string[] }).KEEP_WORDS) || [])
    .map((word) => normalizeText(word))
    .filter(Boolean));
let jiebaCut: ((text: string, hmm?: boolean) => unknown[]) | null = null;
let tinySegmenter: TinySegmenterInstance | null = null;
let tokenizerPreload: Promise<boolean> | null = null;
let tokenizerStatus: MemoryTokenizerStatus = 'idle';
let tokenizerError = '';
const MEMORY_QUERY_CONTEXT_MESSAGE_COUNT = 2;
const MEMORY_RECALL_MIN_SCORE = 3.2;

export function getXbTavernMemoryTokenizerStatus(): { status: MemoryTokenizerStatus; error: string } {
    return {
        status: tokenizerStatus,
        error: tokenizerError,
    };
}

export function isXbTavernMemoryTokenizerReady(): boolean {
    return tokenizerStatus === 'ready' && !!jiebaCut && !!tinySegmenter;
}

function formatTokenizerError(error: unknown): string {
    if (error instanceof Error) {return error.message;}
    return String(error || 'memory_tokenizer_failed');
}

function makeTokenizerError(code: string, reason = ''): Error {
    const message = reason ? `${code}: ${reason}` : code;
    const error = new Error(message) as Error & { code?: string };
    error.code = code;
    return error;
}

function normalizeText(value: unknown = ''): string {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function compactText(value: unknown = ''): string {
    return normalizeText(value).replace(/\s+/g, '');
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTerm(value: unknown = ''): string {
    return compactText(value);
}

function normalizeIgnoredTerms(values: unknown[] = []): Set<string> {
    return new Set(values
        .map((value) => normalizeTerm(value))
        .filter((value) => value.length >= 2));
}

function stripIgnoredTerms(text: string, ignoredTerms: Set<string>): string {
    let result = String(text || '');
    ignoredTerms.forEach((term) => {
        if (!term) {return;}
        result = result.replace(new RegExp(escapeRegex(term), 'gi'), ' ');
    });
    return result;
}

function stripSpeakerPrefixes(text: string, names: string[] = []): string {
    const labels = [
        ...names,
        'user',
        'assistant',
        '用户',
        '角色',
        '玩家',
        '旁白',
    ].map((name) => String(name || '').trim()).filter(Boolean);
    if (!labels.length) {return text;}
    const labelPattern = labels.map(escapeRegex).join('|');
    return String(text || '').split(/\r?\n/).map((line) => (
        line.replace(new RegExp(`^\\s*(?:${labelPattern})\\s*[:：]\\s*`, 'i'), '')
    )).join('\n');
}

function cleanMemoryText(value: unknown = ''): string {
    return String(value || '')
        .replace(/\[tts:[^\]]*]/gi, ' ')
        .replace(/<state>[\s\S]*?<\/state>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isKana(code: number): boolean {
    return (code >= 0x3040 && code <= 0x309F)
        || (code >= 0x30A0 && code <= 0x30FF)
        || (code >= 0x31F0 && code <= 0x31FF)
        || (code >= 0xFF65 && code <= 0xFF9F);
}

function isCjk(code: number): boolean {
    return (code >= 0x4E00 && code <= 0x9FFF)
        || (code >= 0x3400 && code <= 0x4DBF)
        || (code >= 0xF900 && code <= 0xFAFF)
        || (code >= 0x20000 && code <= 0x2A6DF);
}

function isAsian(code: number): boolean {
    return isCjk(code) || isKana(code);
}

function isLatin(code: number): boolean {
    return (code >= 0x41 && code <= 0x5A)
        || (code >= 0x61 && code <= 0x7A)
        || (code >= 0x30 && code <= 0x39)
        || (code >= 0xC0 && code <= 0x024F);
}

function detectAsianLanguage(text: string): 'zh' | 'ja' | 'other' {
    let kanaCount = 0;
    let cjkCount = 0;
    for (const char of text) {
        const code = char.codePointAt(0) || 0;
        if (isKana(code)) {kanaCount += 1;}
        else if (isCjk(code)) {cjkCount += 1;}
    }
    const total = kanaCount + cjkCount;
    if (!total) {return 'other';}
    return kanaCount / total > 0.3 ? 'ja' : 'zh';
}

function tokenizeLatin(text: string): string[] {
    return String(text || '')
        .split(/[\s\-_.,;:!?'"()[\]{}<>/\\|@#$%^&*+=~`]+/)
        .map((word) => normalizeText(word))
        .filter((word) => word.length >= 3);
}

function tokenizeAsian(text: string): string[] {
    const language = detectAsianLanguage(text);
    if (language === 'ja') {
        if (!tinySegmenter) {
            throw makeTokenizerError('memory_tokenizer_not_ready', 'tiny_segmenter_not_ready');
        }
        try {
            return tinySegmenter.segment(text)
                .map((word) => normalizeText(word))
                .filter((word) => word.length >= 2);
        } catch (error) {
            throw makeTokenizerError('memory_tokenizer_failed', formatTokenizerError(error));
        }
    }
    if (language === 'other') {return [];}
    if (jiebaCut) {
        try {
            return Array.from(jiebaCut(text, true))
                .map((word) => normalizeText(word))
                .filter((word) => word.length >= 2);
        } catch (error) {
            throw makeTokenizerError('memory_tokenizer_failed', formatTokenizerError(error));
        }
    }
    throw makeTokenizerError('memory_tokenizer_not_ready', 'jieba_wasm_not_ready');
}

function tokenizeByScript(text: string): string[] {
    const tokens: string[] = [];
    let currentType: 'asian' | 'latin' | 'other' | null = null;
    let current = '';
    const flush = () => {
        if (!current) {return;}
        if (currentType === 'asian') {tokens.push(...tokenizeAsian(current));}
        else if (currentType === 'latin') {tokens.push(...tokenizeLatin(current));}
        current = '';
    };

    for (const char of String(text || '')) {
        const code = char.codePointAt(0) || 0;
        const type = isAsian(code) ? 'asian' : isLatin(code) ? 'latin' : 'other';
        if (type !== currentType) {
            flush();
            currentType = type;
        }
        if (type !== 'other') {current += char;}
    }
    flush();
    return tokens;
}

function tokenizeForMemoryIndex(text: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    tokenizeByScript(text).forEach((token) => {
        const normalized = normalizeText(token);
        if (!normalized || normalized.length < 2) {return;}
        if (STOP_WORDS.has(normalized) && !KEEP_WORDS.has(normalized)) {return;}
        if (/^[\s\x00-\x1F\p{P}\p{S}]+$/u.test(normalized)) {return;}
        if (seen.has(normalized)) {return;}
        seen.add(normalized);
        result.push(normalized);
    });
    return result;
}

export async function preloadXbTavernMemoryTokenizer(): Promise<boolean> {
    if (typeof window === 'undefined') {
        tokenizerStatus = 'unavailable';
        tokenizerError = 'browser_required';
        return false;
    }
    if (isXbTavernMemoryTokenizerReady()) {return true;}
    if (tokenizerPreload) {return await tokenizerPreload;}
    tokenizerStatus = 'loading';
    tokenizerError = '';
    tokenizerPreload = (async () => {
        let nextTinySegmenter: TinySegmenterInstance | null = null;
        let nextJiebaCut: ((text: string, hmm?: boolean) => unknown[]) | null = null;
        try {
            // eslint-disable-next-line no-unsanitized/method
            const tinyModule = await import(
                /* @vite-ignore */
                `/${extensionFolderPath}/libs/tiny-segmenter.js`
            ) as { TinySegmenter?: new () => TinySegmenterInstance; default?: new () => TinySegmenterInstance };
            const TinySegmenter = tinyModule.TinySegmenter || tinyModule.default;
            if (!TinySegmenter) {
                throw new Error('TinySegmenter constructor missing');
            }
            nextTinySegmenter = new TinySegmenter();
        } catch (error) {
            tokenizerStatus = 'failed';
            tokenizerError = `tiny_segmenter_load_failed: ${formatTokenizerError(error)}`;
            tinySegmenter = null;
            jiebaCut = null;
            return false;
        }
        try {
            const wasmPath = `/${extensionFolderPath}/libs/jieba-wasm/jieba_rs_wasm_bg.wasm`;
            // eslint-disable-next-line no-unsanitized/method
            const jiebaModule = await import(
                /* @vite-ignore */
                `/${extensionFolderPath}/libs/jieba-wasm/jieba_rs_wasm.js`
            ) as JiebaModule;
            if (typeof jiebaModule.default === 'function') {
                await jiebaModule.default({ module_or_path: wasmPath });
            }
            if (typeof jiebaModule.cut !== 'function') {
                throw new Error('jieba cut function missing');
            }
            nextJiebaCut = jiebaModule.cut;
        } catch (error) {
            tokenizerStatus = 'failed';
            tokenizerError = `jieba_wasm_load_failed: ${formatTokenizerError(error)}`;
            jiebaCut = null;
            tinySegmenter = null;
            return false;
        }
        tinySegmenter = nextTinySegmenter;
        jiebaCut = nextJiebaCut;
        tokenizerStatus = 'ready';
        tokenizerError = '';
        return true;
    })();
    try {
        return await tokenizerPreload;
    } finally {
        tokenizerPreload = null;
    }
}

export function setXbTavernMemoryTokenizerForTest(input: {
    jiebaCut?: ((text: string, hmm?: boolean) => unknown[]) | null;
    tinySegmenter?: TinySegmenterInstance | null;
} = {}): void {
    jiebaCut = input.jiebaCut || null;
    tinySegmenter = input.tinySegmenter || null;
    tokenizerPreload = null;
    tokenizerError = '';
    tokenizerStatus = jiebaCut && tinySegmenter ? 'ready' : 'idle';
}

async function ensureXbTavernMemoryTokenizerReady(): Promise<void> {
    if (typeof window === 'undefined') {return;}
    const ready = await preloadXbTavernMemoryTokenizer();
    if (!ready) {
        throw makeTokenizerError('memory_tokenizer_not_ready', tokenizerError || 'preload_failed');
    }
}

function tokenizeMemoryText(value: unknown = '', ignoredTerms: Set<string> = new Set()): string[] {
    const cleaned = stripIgnoredTerms(cleanMemoryText(value), ignoredTerms);
    const tokens = new Set<string>();

    tokenizeForMemoryIndex(cleaned)
        .map((token) => normalizeTerm(token))
        .filter(Boolean)
        .forEach((token) => tokens.add(token));

    return [...tokens].filter((token) => {
        if (token.length < 2) {return false;}
        for (const ignored of ignoredTerms) {
            if (token === ignored || token.includes(ignored) || ignored.includes(token)) {
                return false;
            }
        }
        return true;
    });
}

function buildMemoryDocuments<T>(
    records: T[],
    getFields: (record: T) => WeightedMemoryField[],
    getId: (record: T) => string,
): MemoryDocument[] {
    return records.map((record) => {
        const fields = getFields(record);
        const text = fields.map((field) => field.text).join('\n');
        const termWeights = new Map<string, number>();
        let weightedLength = 0;
        fields.forEach((field) => {
            const weight = Math.max(0.1, Number(field.weight) || 1);
            const tokens = tokenizeMemoryText(field.text);
            weightedLength += tokens.length * weight;
            tokens.forEach((token) => {
                termWeights.set(token, (termWeights.get(token) || 0) + weight);
            });
        });
        return {
            id: getId(record),
            text,
            tokens: new Set(termWeights.keys()),
            termWeights,
            weightedLength,
        };
    });
}

function buildIdf(documents: MemoryDocument[]): Map<string, number> {
    const df = new Map<string, number>();
    documents.forEach((document) => {
        document.tokens.forEach((token) => {
            df.set(token, (df.get(token) || 0) + 1);
        });
    });
    const total = Math.max(1, documents.length);
    const idf = new Map<string, number>();
    df.forEach((count, token) => {
        idf.set(token, Math.log((total + 1) / (count + 1)) + 1);
    });
    return idf;
}

function tokenWeight(token: string, idf: Map<string, number>): number {
    const lengthWeight = token.length <= 2 ? 0.55 : token.length === 3 ? 0.9 : 1.25;
    return lengthWeight * (idf.get(token) || 1);
}

function averageWeightedLength(documents: MemoryDocument[]): number {
    if (!documents.length) {return 1;}
    return Math.max(1, documents.reduce((sum, document) => sum + Math.max(1, document.weightedLength), 0) / documents.length);
}

function scoreDocument(
    document: MemoryDocument | undefined,
    queryTokens: string[] = [],
    idf: Map<string, number>,
    averageLength = 1,
): number {
    if (!document) {return 0;}
    if (!queryTokens.length) {return 0;}
    const k1 = 1.2;
    const b = 0.2;
    const lengthNorm = k1 * (1 - b + b * (Math.max(1, document.weightedLength) / Math.max(1, averageLength)));
    return queryTokens.reduce((score, token) => {
        const termFrequency = document.termWeights.get(token) || 0;
        if (termFrequency <= 0) {return score;}
        const bm25Like = (termFrequency * (k1 + 1)) / (termFrequency + lengthNorm);
        return score + tokenWeight(token, idf) * bm25Like;
    }, 0);
}

function weightedField(text: unknown, weight: number): WeightedMemoryField {
    return {
        text: String(text || ''),
        weight,
    };
}

function memoryFileTitle(file: TavernMemoryIndexFileEntry | TavernMemoryFileRecord): string {
    if ('title' in file && file.title) {return String(file.title || '').trim();}
    const heading = 'content' in file ? String(file.content || '').match(/^\s*#\s+(.+?)\s*$/m)?.[1] : '';
    return String(heading || file.path.split('/').pop() || file.path).trim();
}

function memoryFileFields(file: TavernMemoryIndexFileEntry | TavernMemoryFileRecord): WeightedMemoryField[] {
    const path = String(file.path || '');
    const pathWeight = path === 'memory/state.md' ? 2.2
        : path === 'memory/session.md' ? 2.0
            : path.startsWith('memory/turns/') ? 1.6
                : 1.4;
    return [
        weightedField(file.path, pathWeight),
        weightedField(memoryFileTitle(file), pathWeight),
        weightedField(
            ('searchText' in file && file.searchText) || ('preview' in file && file.preview) || ('content' in file ? file.content : ''),
            1.0,
        ),
    ];
}

function isRecallMemoryFile(file: Pick<TavernMemoryIndexFileEntry, 'path' | 'status'> | Pick<TavernMemoryFileRecord, 'path' | 'status'>): boolean {
    const path = String(file.path || '');
    if (file.status === 'stale') {return false;}
    return ['memory/session.md', 'memory/state.md'].includes(path)
        || path.startsWith('memory/turns/');
}

export function buildXbTavernMemoryIgnoredTerms(context: XbTavernContext = {}): string[] {
    return [
        context.character?.name,
        context.user?.name,
    ].map((value) => String(value || '').trim()).filter((value) => value.length >= 2);
}

export function buildXbTavernMemoryQuery(context: XbTavernContext = {}, currentUserMessage = ''): string {
    const history = Array.isArray(context.history) ? context.history.slice(-MEMORY_QUERY_CONTEXT_MESSAGE_COUNT) : [];
    const names = buildXbTavernMemoryIgnoredTerms(context);
    const cleanLine = (value: unknown) => stripSpeakerPrefixes(cleanMemoryText(value), names);
    return [
        cleanLine(currentUserMessage),
        ...history.map((message) => cleanLine(message.content || message.mes || message.message || '')),
    ].filter(Boolean).join('\n');
}

export function selectXbTavernMemoryContext(input: XbTavernMemorySelectionInput = {}): XbTavernMemoryContext {
    const memoryFiles = [...(input.memoryFiles || [])]
        .filter(isRecallMemoryFile)
        .sort((left, right) => left.path.localeCompare(right.path));
    const ignoredTerms = normalizeIgnoredTerms(input.ignoredTerms || []);
    const queryTokens = tokenizeMemoryText(input.queryText, ignoredTerms);
    const memoryFileDocuments = buildMemoryDocuments(
        memoryFiles,
        (record) => memoryFileFields(record),
        (record) => record.path,
    );
    const allDocuments = [...memoryFileDocuments];
    const idf = buildIdf(allDocuments);
    const averageLength = averageWeightedLength(allDocuments);
    const memoryFileDocumentById = new Map(memoryFileDocuments.map((document) => [document.id, document]));

    const alwaysKeepMemoryPaths = new Set(['memory/session.md', 'memory/state.md']);
    const selectedMemoryFiles = memoryFiles
        .map((file) => ({
            file,
            id: file.path,
            score: scoreDocument(memoryFileDocumentById.get(file.path), queryTokens, idf, averageLength),
        }))
        .filter((item) => alwaysKeepMemoryPaths.has(item.file.path) || item.score >= MEMORY_RECALL_MIN_SCORE)
        .sort((left, right) => left.file.path.localeCompare(right.file.path))
        .map((item) => ({
            ...item.file,
            recallReason: alwaysKeepMemoryPaths.has(item.file.path)
                ? 'fixed'
                : 'matched',
            recallScore: item.score,
        }));

    return {
        memoryFiles: selectedMemoryFiles.map((file) => ({
            path: file.path,
            title: memoryFileTitle(file),
            content: String(('preview' in file && file.preview) || ('content' in file ? file.content : '') || '').slice(0, 2400),
            recallReason: file.recallReason,
            recallScore: file.recallScore,
        })),
    };
}

export async function retrieveXbTavernMemoryContext(input: {
    sessionId: string;
    queryText?: string;
    ignoredTerms?: string[];
    includeMemoryFiles?: boolean;
    includeStructuredStates?: boolean;
}): Promise<XbTavernMemoryContext> {
    const sessionId = String(input.sessionId || '').trim();
    if (!sessionId) {return {};}
    const includeMemoryFiles = input.includeMemoryFiles !== false;
    const includeStructuredStates = input.includeStructuredStates !== false;
    const [memoryIndex, structuredStates] = await Promise.all([
        includeMemoryFiles ? getTavernMemoryIndex(sessionId) : Promise.resolve(null),
        includeStructuredStates ? listTavernStructuredStateDigests(sessionId) : Promise.resolve([]),
    ]);
    const readyMemoryIndex = includeMemoryFiles && memoryIndex?.status === 'ready' && Array.isArray(memoryIndex.files)
        ? memoryIndex
        : includeMemoryFiles && memoryIndex?.status === 'stale' && memoryIndex.error && Array.isArray(memoryIndex.files)
            ? memoryIndex
            : includeMemoryFiles
                ? await rebuildTavernMemoryDerivedIndex(sessionId)
                : null;
    const memoryFiles = Array.isArray(readyMemoryIndex?.files) ? readyMemoryIndex.files : [];
    const hasRecallMemory = memoryFiles.some(isRecallMemoryFile);
    if (!hasRecallMemory && !structuredStates.length) {return {};}
    if (hasRecallMemory) {
        await ensureXbTavernMemoryTokenizerReady();
    }
    return {
        ...(hasRecallMemory ? selectXbTavernMemoryContext({
            memoryFiles,
            queryText: input.queryText,
            ignoredTerms: input.ignoredTerms,
        }) : {}),
        structuredStates,
    };
}
