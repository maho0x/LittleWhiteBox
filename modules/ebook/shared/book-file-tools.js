import { applyTextEdits } from '../../agent-core/tools/text-edit.js';
import {
    assertBookDirectoryPath,
    assertBookFilePath,
    getBookPathError,
    normalizeBookDirectoryPath,
    normalizeBookPath,
} from './book-paths.js';
import {
    deleteBookPath,
    getBookFile,
    replaceBookFiles,
    upsertBookFile,
} from './ebook-db.js';

const DEFAULT_READ_LIMIT = 1200;
const MAX_READ_LIMIT = 2000;
const MAX_GREP_RESULTS = 100;
const DEFAULT_BOOK_DIRECTORIES = ['book/sources/', 'book/chapters/', 'book/reviews/', 'book/notes/'];

function normalizeText(value = '', limit = 4000) {
    const text = String(value || '').trim();
    return text.length > limit ? text.slice(0, limit) : text;
}

function toLineNumber(value, fallback = 1) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampLimit(value, fallback = DEFAULT_READ_LIMIT, max = MAX_READ_LIMIT) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(max, number);
}

function splitLines(text = '') {
    return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

function numberLines(lines = [], startLine = 1) {
    return lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

export function collectDirectoryEntries(files = [], directoryPath = 'book/') {
    const dir = normalizeBookDirectoryPath(directoryPath) || 'book/';
    const entryMap = new Map();
    DEFAULT_BOOK_DIRECTORIES.forEach((directory) => {
        if (!directory.startsWith(dir) || directory === dir) return;
        const rest = directory.slice(dir.length);
        const [first] = rest.split('/');
        if (!first) return;
        const path = `${dir}${first}/`;
        entryMap.set(path, {
            name: first,
            path,
            type: 'directory',
        });
    });
    files.forEach((file) => {
        if (!file.path.startsWith(dir) || file.path === dir) return;
        const rest = file.path.slice(dir.length);
        if (!rest) return;
        const [first] = rest.split('/');
        if (!first) return;
        const isDirectory = rest.includes('/');
        const path = `${dir}${first}${isDirectory ? '/' : ''}`;
        entryMap.set(path, {
            name: first,
            path,
            type: isDirectory ? 'directory' : 'file',
        });
    });
    return Array.from(entryMap.values()).sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return left.path.localeCompare(right.path, 'zh-CN');
    });
}

function globToRegExp(pattern = '') {
    const normalized = normalizeBookPath(pattern || 'book/**');
    if (!normalized) throw new Error('book_path_required');
    let output = '^';
    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];
        const next = normalized[index + 1];
        const afterNext = normalized[index + 2];
        if (char === '*' && next === '*' && afterNext === '/') {
            output += '(?:.*/)?';
            index += 2;
        } else if (char === '*' && next === '*') {
            output += '.*';
            index += 1;
        } else if (char === '*') {
            output += '[^/]*';
        } else if (char === '?') {
            output += '[^/]';
        } else {
            output += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        }
    }
    output += '$';
    return new RegExp(output);
}

function buildIncludePredicate(include = '') {
    const text = String(include || '').trim();
    if (!text) return () => true;
    const pattern = text.startsWith('book/') ? text : `book/${text.replace(/^\/+/, '')}`;
    const regexp = globToRegExp(pattern);
    return (path) => regexp.test(path);
}

function buildSearchRegExp(pattern = '', useRegex = true) {
    const text = String(pattern || '');
    if (!text) throw new Error('grep_pattern_required');
    if (useRegex === false) {
        return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    return new RegExp(text, 'i');
}

export function createBookFileToolHandlers(options = {}) {
    const currentBookId = typeof options.currentBookId === 'function' ? options.currentBookId : async () => options.bookId;
    const getFiles = typeof options.getFiles === 'function' ? options.getFiles : async () => [];
    const onFilesChanged = typeof options.onFilesChanged === 'function' ? options.onFilesChanged : null;
    const readOnly = !!options.readOnly;

    function assertWritable() {
        if (readOnly) throw new Error('book_tool_read_only');
    }

    async function executeLs(args = {}) {
        const directory = assertBookDirectoryPath(args.path || 'book/');
        const files = await getFiles();
        const entries = collectDirectoryEntries(files, directory);
        const offset = toLineNumber(args.offset, 1);
        const limit = Math.min(300, Math.max(1, Math.floor(Number(args.limit) || 100)));
        const page = entries.slice(offset - 1, offset - 1 + limit);
        return {
            ok: true,
            path: directory,
            count: entries.length,
            entries: page,
            truncated: offset - 1 + limit < entries.length,
            nextOffset: offset - 1 + limit < entries.length ? offset + limit : 0,
            summary: `${directory} 下有 ${entries.length} 项，返回 ${page.length} 项。`,
        };
    }

    async function executeGlob(args = {}) {
        const pattern = normalizeText(args.pattern || 'book/**', 1000);
        const pathScope = args.path ? assertBookDirectoryPath(args.path) : '';
        const regexp = globToRegExp(pattern);
        const files = await getFiles();
        let paths = files.map((file) => file.path).filter((path) => regexp.test(path));
        if (pathScope) paths = paths.filter((path) => path.startsWith(pathScope));
        paths.sort((left, right) => left.localeCompare(right, 'zh-CN'));
        return {
            ok: true,
            pattern,
            path: pathScope,
            count: paths.length,
            files: paths.slice(0, 300),
            truncated: paths.length > 300,
            summary: `匹配到 ${paths.length} 个文件。`,
        };
    }

    async function executeGrep(args = {}) {
        const regexp = buildSearchRegExp(args.pattern, args.useRegex !== false);
        const directory = args.path ? assertBookDirectoryPath(args.path) : '';
        const include = buildIncludePredicate(args.include || '');
        const outputMode = ['content', 'files_with_matches', 'count'].includes(args.outputMode) ? args.outputMode : 'content';
        const limit = Math.min(MAX_GREP_RESULTS, Math.max(1, Math.floor(Number(args.limit) || MAX_GREP_RESULTS)));
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const contextLines = Math.min(5, Math.max(0, Math.floor(Number(args.contextLines) || 0)));
        const files = (await getFiles()).filter((file) => (!directory || file.path.startsWith(directory)) && include(file.path));
        const rows = [];
        files.forEach((file) => {
            const lines = splitLines(file.content);
            let matchCount = 0;
            lines.forEach((line, index) => {
                regexp.lastIndex = 0;
                if (!regexp.test(line)) return;
                matchCount += 1;
                if (outputMode === 'content') {
                    const start = Math.max(0, index - contextLines);
                    const end = Math.min(lines.length, index + contextLines + 1);
                    rows.push({
                        path: file.path,
                        lineNumber: index + 1,
                        line,
                        context: numberLines(lines.slice(start, end), start + 1),
                    });
                }
            });
            if (outputMode === 'files_with_matches' && matchCount > 0) {
                rows.push({ path: file.path });
            } else if (outputMode === 'count' && matchCount > 0) {
                rows.push({ path: file.path, count: matchCount });
            }
        });
        const page = rows.slice(offset, offset + limit);
        return {
            ok: true,
            pattern: String(args.pattern || ''),
            outputMode,
            count: rows.length,
            results: page,
            truncated: offset + limit < rows.length,
            nextOffset: offset + limit < rows.length ? offset + limit : 0,
            summary: `搜索到 ${rows.length} 项，返回 ${page.length} 项。`,
        };
    }

    async function executeRead(args = {}) {
        const rawPath = String(args.filePath || '').trim();
        if (!rawPath) throw new Error('book_path_required');
        const path = normalizeBookPath(rawPath);
        if (!path) throw new Error(getBookPathError(rawPath, { directory: true }) || 'book_path_required');
        if (path.endsWith('/')) {
            return await executeLs({ path, offset: args.offset, limit: args.limit });
        }
        const filePath = assertBookFilePath(path);
        const file = await getBookFile(await currentBookId(), filePath);
        if (!file) throw new Error('book_file_not_found');
        const lines = splitLines(file.content);
        const tail = Math.floor(Number(args.tail) || 0);
        let startLine = toLineNumber(args.offset, 1);
        let limit = clampLimit(args.limit);
        if (tail > 0) {
            limit = Math.min(MAX_READ_LIMIT, tail);
            startLine = Math.max(1, lines.length - limit + 1);
        }
        const startIndex = Math.max(0, startLine - 1);
        const selected = lines.slice(startIndex, startIndex + limit);
        const nextOffset = startIndex + limit < lines.length ? startIndex + limit + 1 : 0;
        return {
            ok: true,
            path: filePath,
            lineStart: startIndex + 1,
            lineEnd: startIndex + selected.length,
            totalLines: lines.length,
            content: numberLines(selected, startIndex + 1),
            truncated: nextOffset > 0,
            nextOffset,
            summary: `读取 ${filePath} 第 ${startIndex + 1}-${startIndex + selected.length} 行，共 ${lines.length} 行。`,
        };
    }

    async function executeWrite(args = {}) {
        assertWritable();
        const path = assertBookFilePath(args.path || args.filePath);
        const file = await upsertBookFile(await currentBookId(), path, typeof args.content === 'string' ? args.content : String(args.content ?? ''));
        await onFilesChanged?.();
        return {
            ok: true,
            path: file.path,
            bytes: new TextEncoder().encode(file.content).length,
            summary: `已写入 ${file.path}。`,
        };
    }

    async function executeEdit(args = {}) {
        assertWritable();
        const path = assertBookFilePath(args.filePath);
        const edits = Array.isArray(args.edits) ? args.edits : [];
        const file = await getBookFile(await currentBookId(), path);
        if (!file) {
            const canCreate = edits.length === 1 && String(edits[0]?.oldString ?? '') === '';
            if (!canCreate) {
                return {
                    ok: false,
                    path,
                    error: 'file_not_found',
                    message: 'File does not exist',
                    results: [{
                        ok: false,
                        error: 'file_not_found',
                        message: 'File does not exist',
                    }],
                    summary: `未找到 ${path}。`,
                };
            }
        }

        const result = applyTextEdits(file?.content || '', edits);
        const appliedCount = result.results.filter((item) => item.ok).length;
        const failedCount = result.results.length - appliedCount;
        if (appliedCount > 0) {
            await upsertBookFile(await currentBookId(), path, result.content || '');
            await onFilesChanged?.();
        }
        return {
            ok: result.ok,
            partial: result.partial,
            path,
            error: result.ok ? undefined : result.results.find((item) => !item.ok)?.error,
            message: result.ok ? undefined : result.results.find((item) => !item.ok)?.message,
            editCount: result.results.length,
            appliedCount,
            failedCount,
            results: result.results,
            summary: result.ok
                ? `已修改 ${path}，应用 ${appliedCount} 项。`
                : result.partial
                    ? `已部分修改 ${path}：成功 ${appliedCount} 项，失败 ${failedCount} 项。`
                    : `未修改 ${path}：${result.results[0]?.message || result.results[0]?.error || 'Edit failed'}。`,
        };
    }

    async function executeDelete(args = {}) {
        assertWritable();
        const rawPath = String(args.path || '').trim();
        const path = rawPath.endsWith('/')
            ? assertBookDirectoryPath(rawPath)
            : assertBookFilePath(rawPath);
        const deleted = await deleteBookPath(await currentBookId(), path);
        await onFilesChanged?.();
        return {
            ok: true,
            path: deleted.path,
            deletedCount: deleted.deletedCount,
            summary: `已删除 ${deleted.deletedCount} 个文件。`,
        };
    }

    async function executeMove(args = {}) {
        assertWritable();
        const fromRaw = String(args.fromPath || '').trim();
        const toRaw = String(args.toPath || '').trim();
        const files = await getFiles();
        const fromIsDirectory = fromRaw.endsWith('/') || files.some((file) => file.path.startsWith(normalizeBookDirectoryPath(fromRaw)));
        const fromPath = fromIsDirectory ? assertBookDirectoryPath(fromRaw) : assertBookFilePath(fromRaw);
        const toPath = fromIsDirectory ? assertBookDirectoryPath(toRaw) : assertBookFilePath(toRaw);
        if (fromPath === 'book/') throw new Error('book_root_move_forbidden');
        if (fromIsDirectory && toPath !== fromPath && toPath.startsWith(fromPath)) {
            throw new Error('book_move_into_self_forbidden');
        }
        const overwrite = !!args.overwrite;
        const targets = fromIsDirectory
            ? files.filter((file) => file.path.startsWith(fromPath))
            : files.filter((file) => file.path === fromPath);
        if (!targets.length) throw new Error('book_path_not_found');
        const destinationPaths = targets.map((file) => fromIsDirectory ? `${toPath}${file.path.slice(fromPath.length)}` : toPath);
        if (!overwrite) {
            const existing = files.find((file) => destinationPaths.includes(file.path) && !targets.some((target) => target.path === file.path));
            if (existing) throw new Error('book_destination_exists');
        }
        const targetSet = new Set(targets.map((file) => file.path));
        const destinationSet = new Set(destinationPaths);
        const nextFiles = files
            .filter((file) => !targetSet.has(file.path) && (overwrite || !destinationSet.has(file.path)))
            .concat(targets.map((file, index) => ({
                ...file,
                path: destinationPaths[index],
            })));
        await replaceBookFiles(await currentBookId(), nextFiles);
        await onFilesChanged?.();
        return {
            ok: true,
            fromPath,
            toPath,
            movedCount: targets.length,
            summary: `已移动 ${targets.length} 个文件。`,
        };
    }

    return {
        executeLs,
        executeGlob,
        executeGrep,
        executeRead,
        executeWrite,
        executeEdit,
        executeDelete,
        executeMove,
    };
}
