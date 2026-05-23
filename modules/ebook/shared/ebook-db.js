import Dexie from '../../../libs/dexie.mjs';
import { normalizeBookFilePath } from './book-paths.js';
import { DEFAULT_BOOK_FILES } from './book-templates.js';

const db = new Dexie('LittleWhiteBox_Ebook');

db.version(1).stores({
    books: 'id, updatedAt, title',
    files: '[bookId+path], bookId, path, updatedAt',
    meta: 'key',
    plans: '[sessionId+id], sessionId, status, owner, priority, updatedAt, completedAt',
});

db.version(2).stores({
    books: 'id, updatedAt, title',
    files: '[bookId+path], bookId, path, updatedAt',
    meta: 'key',
    plans: '[sessionId+id], sessionId, status, owner, priority, updatedAt, completedAt',
    sessions: 'bookId, updatedAt',
    messages: '[bookId+order], bookId, order',
});

export const booksTable = db.books;
export const filesTable = db.files;
export const metaTable = db.meta;
export const ebookPlansTable = db.plans;
export const ebookSessionsTable = db.sessions;
export const ebookMessagesTable = db.messages;

function createId(prefix = 'book') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
    return Date.now();
}

function normalizeTitle(value = '', fallback = '未命名书稿') {
    const normalized = String(value || '').trim();
    return normalized.slice(0, 120) || fallback;
}

function cloneBook(book = {}) {
    return {
        id: String(book.id || ''),
        title: String(book.title || ''),
        createdAt: Number(book.createdAt) || 0,
        updatedAt: Number(book.updatedAt) || 0,
    };
}

function cloneFile(file = {}) {
    return {
        bookId: String(file.bookId || ''),
        path: String(file.path || ''),
        content: typeof file.content === 'string' ? file.content : '',
        createdAt: Number(file.createdAt) || 0,
        updatedAt: Number(file.updatedAt) || 0,
    };
}

export async function listBooks() {
    const books = await booksTable.orderBy('updatedAt').reverse().toArray();
    return books.map(cloneBook).filter((book) => book.id);
}

export async function getSelectedBookId() {
    const entry = await metaTable.get('selectedBookId');
    return String(entry?.value || '').trim();
}

export async function setSelectedBookId(bookId = '') {
    const value = String(bookId || '').trim();
    await metaTable.put({ key: 'selectedBookId', value, updatedAt: now() });
    return value;
}

export async function createBook(title = '') {
    const timestamp = now();
    const book = {
        id: createId('book'),
        title: normalizeTitle(title, '新书稿'),
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    await booksTable.put(book);
    await Promise.all(DEFAULT_BOOK_FILES.map((file) => upsertBookFile(book.id, file.path, file.content, {
        createdAt: timestamp,
        updatedAt: timestamp,
        touchBook: false,
    })));
    await setSelectedBookId(book.id);
    return cloneBook(book);
}

export async function ensureDefaultBook() {
    const books = await listBooks();
    const selectedBookId = await getSelectedBookId();
    const selected = books.find((book) => book.id === selectedBookId);
    if (selected) return selected;
    if (books[0]) {
        await setSelectedBookId(books[0].id);
        return books[0];
    }
    return await createBook('未命名书稿');
}

export async function getBook(bookId = '') {
    const book = await booksTable.get(String(bookId || '').trim());
    return book ? cloneBook(book) : null;
}

export async function renameBook(bookId = '', title = '') {
    const id = String(bookId || '').trim();
    if (!id) throw new Error('book_required');
    const nextTitle = normalizeTitle(title, '未命名书稿');
    const updatedAt = now();
    const changed = await booksTable.update(id, {
        title: nextTitle,
        updatedAt,
    });
    if (!changed) throw new Error('book_not_found');
    return cloneBook(await booksTable.get(id));
}

export async function touchBook(bookId = '') {
    const id = String(bookId || '').trim();
    if (!id) return;
    await booksTable.update(id, { updatedAt: now() });
}

export async function listBookFiles(bookId = '') {
    const id = String(bookId || '').trim();
    if (!id) return [];
    const files = await filesTable.where('bookId').equals(id).toArray();
    return files
        .map(cloneFile)
        .filter((file) => file.path)
        .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
}

export async function getBookFile(bookId = '', path = '') {
    const id = String(bookId || '').trim();
    const normalizedPath = normalizeBookFilePath(path);
    if (!id || !normalizedPath) return null;
    const file = await filesTable.get([id, normalizedPath]);
    return file ? cloneFile(file) : null;
}

export async function upsertBookFile(bookId = '', path = '', content = '', options = {}) {
    const id = String(bookId || '').trim();
    const normalizedPath = normalizeBookFilePath(path);
    if (!id || !normalizedPath) throw new Error('book_path_required');
    const previous = await filesTable.get([id, normalizedPath]);
    const timestamp = Number(options.updatedAt) || now();
    const file = {
        bookId: id,
        path: normalizedPath,
        content: typeof content === 'string' ? content : String(content ?? ''),
        createdAt: Number(previous?.createdAt || options.createdAt) || timestamp,
        updatedAt: timestamp,
    };
    await filesTable.put(file);
    if (options.touchBook !== false) {
        await touchBook(id);
    }
    return cloneFile(file);
}

export async function deleteBookPath(bookId = '', path = '') {
    const id = String(bookId || '').trim();
    if (!id) throw new Error('bookId_required');
    const normalizedPath = normalizeBookFilePath(path);
    if (!normalizedPath) throw new Error('invalid_path');
    await filesTable.delete([id, normalizedPath]);
    await touchBook(id);
}

export async function deleteBook(bookId = '') {
    const id = String(bookId || '').trim();
    if (!id) throw new Error('bookId_required');
    await db.transaction(
        'rw',
        booksTable,
        filesTable,
        metaTable,
        ebookPlansTable,
        ebookSessionsTable,
        ebookMessagesTable,
        async () => {
            await filesTable.where('bookId').equals(id).delete();
            await ebookPlansTable.where('sessionId').equals(id).delete();
            await ebookSessionsTable.where('bookId').equals(id).delete();
            await ebookMessagesTable.where('bookId').equals(id).delete();
            await booksTable.delete(id);
            const selectedId = String((await metaTable.get('selectedBookId'))?.value || '').trim();
            if (selectedId === id) {
                await metaTable.delete('selectedBookId');
            }
        },
    );
}

export async function replaceBookFiles(bookId = '', nextFiles = []) {
    const id = String(bookId || '').trim();
    if (!id) throw new Error('book_required');
    const timestamp = now();
    await db.transaction('rw', filesTable, booksTable, async () => {
        await filesTable.where('bookId').equals(id).delete();
        await Promise.all((Array.isArray(nextFiles) ? nextFiles : []).map(async (file) => {
            const normalizedPath = normalizeBookFilePath(file?.path);
            if (!normalizedPath) return;
            await filesTable.put({
                bookId: id,
                path: normalizedPath,
                content: typeof file.content === 'string' ? file.content : '',
                createdAt: Number(file.createdAt) || timestamp,
                updatedAt: timestamp,
            });
        }));
        await booksTable.update(id, { updatedAt: timestamp });
    });
}

export default db;
