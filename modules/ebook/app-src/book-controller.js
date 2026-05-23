import {
    createBook,
    deleteBook,
    getBook,
    getSelectedBookId,
    listBookFiles,
    listBooks,
    renameBook,
    setSelectedBookId,
    upsertBookFile,
} from '../shared/ebook-db.js';
import { normalizeBookFilePath } from '../shared/book-paths.js';

const DEFAULT_DRAFT_PATH = 'book/chapters/001.md';

function suggestNextChapterPath(files = []) {
    const usedNumbers = new Set((Array.isArray(files) ? files : [])
        .map((file) => String(file?.path || '').match(/^book\/chapters\/(\d+)\.md$/))
        .filter(Boolean)
        .map((match) => Number(match[1]))
        .filter((number) => Number.isFinite(number) && number > 0));
    let next = 1;
    while (usedNumbers.has(next)) next += 1;
    return `book/chapters/${String(next).padStart(3, '0')}.md`;
}

export function createBookController(deps = {}) {
    const {
        state,
        render,
        requestHost,
        showToast,
        conversationStore,
    } = deps;

    async function refreshBooksAndFiles() {
        state.books = await listBooks();
        if (!state.books.length) {
            state.book = null;
            state.files = [];
            state.selectedPath = '';
            state.readerPath = '';
            state.editorContent = '';
            state.savedContent = '';
            state.isDeleteBookOpen = false;
            state.viewMode = 'library';
            return;
        }
        const selectedBookId = await getSelectedBookId();
        if (state.book?.id) {
            state.book = state.books.find((book) => book.id === state.book.id) || null;
        }
        if (!state.book) {
            state.book = state.books.find((book) => book.id === selectedBookId) || state.books[0];
        }
        if (state.book?.id && state.book.id !== selectedBookId) {
            await setSelectedBookId(state.book.id);
        }
        state.files = await listBookFiles(state.book.id);
        if (!state.selectedPath || !state.files.some((file) => file.path === state.selectedPath)) {
            state.selectedPath = state.files.find((file) => file.path === DEFAULT_DRAFT_PATH)?.path
                || state.files.find((file) => file.path === 'book/outline.md')?.path
                || state.files[0]?.path
                || '';
        }
        if (!state.readerPath || !state.files.some((file) => file.path === state.readerPath)) {
            state.readerPath = state.files.find((file) => /^book\/chapters\/.+\.md$/.test(file.path))?.path
                || '';
        }
        const selected = state.files.find((file) => file.path === state.selectedPath);
        state.editorContent = selected?.content || '';
        state.savedContent = state.editorContent;
    }

    function isEditorDirty() {
        return state.editorContent !== state.savedContent;
    }

    async function selectBook(bookId = '') {
        if (state.isBusy) return;
        const book = await getBook(bookId);
        if (!book) return;
        if (isEditorDirty() && !confirm('当前文件还没保存，确定切换书籍吗？')) return;
        await setSelectedBookId(book.id);
        state.book = book;
        state.selectedPath = '';
        state.readerPath = '';
        state.viewMode = 'book-entry';
        await refreshBooksAndFiles();
        await conversationStore?.restoreConversation?.(book.id);
        render();
    }

    async function selectFile(path = '') {
        if (isEditorDirty() && !confirm('当前文件还没保存，确定切换文件吗？')) return;
        const file = state.files.find((item) => item.path === path);
        if (!file) return;
        state.selectedPath = file.path;
        state.viewMode = 'studio';
        state.editorContent = file.content;
        state.savedContent = file.content;
        render();
    }

    async function showBookEntry() {
        if (!state.book) return;
        if (isEditorDirty() && !confirm('当前文件还没保存，确定回到书本入口吗？')) return;
        state.viewMode = 'book-entry';
        render();
    }

    async function showStudio() {
        if (!state.book) return;
        if (isEditorDirty() && state.viewMode !== 'studio' && !confirm('当前文件还没保存，确定进入创作台吗？')) return;
        state.viewMode = 'studio';
        render();
    }

    async function showReader() {
        if (!state.book) return;
        if (isEditorDirty() && !confirm('当前文件还没保存，确定进入阅读器吗？')) return;
        const chapter = state.files.find((file) => /^book\/chapters\/.+\.md$/.test(file.path));
        if (!state.readerPath && chapter) {
            state.readerPath = chapter.path;
        }
        state.viewMode = 'reader';
        render();
    }

    async function selectReaderChapter(path = '') {
        const chapter = state.files.find((file) => file.path === path && /^book\/chapters\/.+\.md$/.test(file.path));
        if (!chapter) return;
        state.readerPath = chapter.path;
        state.viewMode = 'reader';
        render();
    }

    async function showLibrary() {
        if (isEditorDirty() && !confirm('当前文件还没保存，确定回到书架吗？')) return;
        state.viewMode = 'library';
        render();
    }

    async function saveCurrentFile() {
        if (!state.book || !state.selectedPath || state.isBusy) return;
        await upsertBookFile(state.book.id, state.selectedPath, state.editorContent);
        await refreshBooksAndFiles();
        showToast('已保存');
    }

    async function createNewBook() {
        if (state.isBusy) return;
        const title = prompt('新书名', '新书稿');
        if (title === null) return;
        if (isEditorDirty() && !confirm('当前文件还没保存，确定新建书籍吗？')) return;
        state.book = await createBook(title);
        state.selectedPath = DEFAULT_DRAFT_PATH;
        state.readerPath = DEFAULT_DRAFT_PATH;
        state.viewMode = 'book-entry';
        await refreshBooksAndFiles();
        await conversationStore?.restoreConversation?.(state.book.id);
        render();
    }

    async function renameCurrentBook() {
        if (!state.book || state.isBusy) return;
        const title = prompt('书名', state.book.title || '未命名书稿');
        if (title === null) return;
        try {
            state.book = await renameBook(state.book.id, title);
            await refreshBooksAndFiles();
            showToast('书名已更新');
            render();
        } catch (error) {
            showToast(`改名失败：${error?.message || error}`);
        }
    }

    async function createNewFile() {
        if (!state.book || state.isBusy) return;
        if (isEditorDirty() && !confirm('当前文件还没保存，确定新建章节吗？')) return;
        const path = prompt('新章节路径（必须放在 book/chapters/ 下）', suggestNextChapterPath(state.files));
        if (path === null) return;
        try {
            const normalizedPath = normalizeBookFilePath(path);
            if (!normalizedPath || !normalizedPath.startsWith('book/chapters/')) {
                throw new Error('chapter_path_required');
            }
            if (state.files.some((file) => file.path === normalizedPath)) {
                throw new Error('chapter_already_exists');
            }
            await upsertBookFile(state.book.id, normalizedPath, '');
            await refreshBooksAndFiles();
            state.selectedPath = normalizedPath;
            state.viewMode = 'studio';
            await refreshBooksAndFiles();
            render();
        } catch (error) {
            showToast(`新建失败：${error?.message || error}`);
        }
    }

    async function importMaterial(kind = '') {
        if (!state.book || state.isBusy) return;
        if (isEditorDirty() && !confirm('当前文件还没保存，导入资料会切换到资料文件并放弃未保存修改，确定继续吗？')) return;
        state.status = '正在导入资料...';
        render();
        try {
            const result = await requestHost('xb-ebook:import-material', {
                kind,
                bookId: state.book.id,
            });
            if (!result?.ok) throw new Error(result?.error || 'import_failed');
            await upsertBookFile(state.book.id, result.path, result.content || '');
            await refreshBooksAndFiles();
            state.selectedPath = result.path;
            state.viewMode = 'studio';
            await refreshBooksAndFiles();
            showToast(`已导入：${result.label || result.path}`);
        } catch (error) {
            showToast(`导入失败：${error?.message || error}`);
        } finally {
            state.status = '就绪';
            render();
        }
    }

    async function initializeBook() {
        await refreshBooksAndFiles();
        await conversationStore?.restoreConversation?.(state.book?.id);
    }

    async function removeBook(bookId = '') {
        if (state.isBusy) return;
        const id = String(bookId || '').trim();
        if (!id) return;
        if (!confirm('确定要删除这本书吗？所有书稿内容和写作记录都将被清除，无法恢复。')) return;
        const activeBookId = state.book?.id || '';
        const deletingActiveBook = activeBookId === id;
        try {
            await deleteBook(id);
            if (deletingActiveBook) {
                state.book = null;
                state.selectedPath = '';
                state.readerPath = '';
            }
            await refreshBooksAndFiles();
            state.isDeleteBookOpen = false;
            state.viewMode = 'library';
            const nextActiveBookId = state.book?.id || '';
            if (deletingActiveBook || !activeBookId || nextActiveBookId !== activeBookId) {
                await conversationStore?.restoreConversation?.(nextActiveBookId);
            }
            showToast('书籍已删除');
            render();
        } catch (error) {
            showToast(`删除失败：${error?.message || error}`);
        }
    }

    return {
        createNewBook,
        createNewFile,
        importMaterial,
        initializeBook,
        isEditorDirty,
        refreshBooksAndFiles,
        removeBook,
        renameCurrentBook,
        saveCurrentFile,
        selectBook,
        selectFile,
        selectReaderChapter,
        showBookEntry,
        showLibrary,
        showReader,
        showStudio,
    };
}
