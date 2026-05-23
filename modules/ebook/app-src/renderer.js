import { normalizeThoughtBlocks } from '../../agent-core/runtime/protocol.js';
import { renderMarkdownToHtml } from '../../agent-core/ui/message-markdown.js';
import { buildAgentSettingsPanelMarkup } from '../../agent-core/ui/settings-markup.js';
import { escapeHtml, trimInlineText } from './text-utils.js';
import { formatDraftMetrics, formatTextMetrics } from './text-metrics.js';
import { EBOOK_MAX_CONTEXT_TOKENS, estimateEbookTokens } from './history-compaction.js';
import { buildBookContextPrompt, EBOOK_SYSTEM_PROMPT } from './prompts.js';

const STUDIO_FILE_SECTIONS = [
    {
        key: 'chapters',
        title: '正文',
        description: '这本书的正式产出。阅读器只读取这里的章节。',
        badge: '阅读器',
        empty: '还没有正文。',
        matches: (path) => path.startsWith('book/chapters/'),
    },
    {
        key: 'settings',
        title: '设定草稿',
        description: '大纲、方案、设定、审稿和修订计划。它们是写作依据，不进阅读器。',
        badge: '草稿',
        empty: '还没有设定草稿。',
        matches: (path) => (
            ['book/outline.md', 'book/style.md', 'book/characters.md', 'book/world.md', 'book/state.md', 'book/review-rules.md'].includes(path)
            || path.startsWith('book/reviews/')
            || path.startsWith('book/notes/')
        ),
    },
    {
        key: 'sources',
        title: '导入资料',
        description: '从酒馆导入的当前聊天全部楼层、当前角色信息、小白X剧情总结和关联世界书，会放在这里。',
        badge: '素材',
        empty: '还没有导入资料。',
        matches: (path) => path.startsWith('book/sources/'),
    },
];

const FILE_ORDER = [
    'book/chapters/',
    'book/outline.md',
    'book/style.md',
    'book/characters.md',
    'book/world.md',
    'book/state.md',
    'book/review-rules.md',
    'book/reviews/',
    'book/notes/',
    'book/sources/',
];

function getFileOrder(path = '') {
    const index = FILE_ORDER.findIndex((prefix) => path === prefix || path.startsWith(prefix));
    return index >= 0 ? index : FILE_ORDER.length;
}

function sortBookFiles(files = []) {
    return [...files].sort((left, right) => {
        const leftOrder = getFileOrder(left.path);
        const rightOrder = getFileOrder(right.path);
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.path.localeCompare(right.path, 'zh-CN');
    });
}

function getChapterFiles(files = []) {
    return sortBookFiles(files).filter((file) => /^book\/chapters\/.+\.md$/.test(file.path));
}

function getActiveChapter(state = {}) {
    const chapters = getChapterFiles(state.files);
    const activePath = chapters.some((file) => file.path === state.readerPath)
        ? state.readerPath
        : chapters[0]?.path || '';
    return {
        chapters,
        activePath,
        active: chapters.find((file) => file.path === activePath) || null,
        index: Math.max(0, chapters.findIndex((file) => file.path === activePath)),
    };
}

function formatChapterLabel(path = '') {
    const match = path.match(/^book\/chapters\/(.+)\.md$/);
    if (!match) return '';
    const raw = match[1];
    if (/^\d+$/.test(raw)) return `第 ${Number(raw)} 章`;
    return raw;
}

function formatFileTitle(path = '') {
    const known = {
        'book/outline.md': '大纲',
        'book/style.md': '文风规则',
        'book/characters.md': '角色设定',
        'book/world.md': '世界设定',
        'book/state.md': '状态追踪',
        'book/review-rules.md': '审稿规则',
        'book/notes/revision-plan.md': '修订计划',
        'book/sources/chat.md': '当前聊天资料',
        'book/sources/character.md': '角色资料',
        'book/sources/story-summary.md': '剧情总结资料',
        'book/sources/worldbook.md': '世界书资料',
    };
    if (known[path]) return known[path];
    const chapterLabel = formatChapterLabel(path);
    if (chapterLabel) return chapterLabel;
    if (path.startsWith('book/sources/')) return path.replace(/^book\/sources\//, '').replace(/\.md$/, '');
    if (path.startsWith('book/reviews/')) return `审稿 ${path.replace(/^book\/reviews\//, '').replace(/\.md$/, '')}`;
    return path.replace(/^book\//, '');
}

function formatBookDate(timestamp = 0) {
    const date = Number(timestamp) ? new Date(Number(timestamp)) : null;
    if (!date || Number.isNaN(date.getTime())) return '暂无更新时间';
    return date.toLocaleDateString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function renderProviderReadiness(providerConfig = {}) {
    const provider = String(providerConfig.provider || '');
    const missing = [];
    if (!String(providerConfig.model || '').trim()) missing.push('模型');
    if (provider !== 'sillytavern-openai-compatible' && !String(providerConfig.apiKey || '').trim()) missing.push('API Key');
    if (provider === 'openai-compatible' && !String(providerConfig.baseUrl || '').trim()) missing.push('URL');
    if (missing.length) {
        return {
            canRun: false,
            level: 'error',
            text: `还不能发送：请先补好 ${missing.join(' / ')}。`,
        };
    }
    if ((provider === 'openai-compatible' || provider === 'sillytavern-openai-compatible') && providerConfig.toolMode !== 'tagged-json') {
        return {
            canRun: true,
            level: 'warn',
            text: '这套模型有时不太稳定，写作过程中可能会中断。',
        };
    }
    return {
        canRun: true,
        level: 'ok',
        text: '写作助手只会读写这本书。',
    };
}

function formatContextMeterCount(tokens = 0) {
    return `${Math.max(0, Math.round((Number(tokens) || 0) / 1000))}k`;
}

function estimateConversationContextTokens(state = {}) {
    const contextPrompt = buildBookContextPrompt({
        book: state.book,
        files: state.files,
        selectedPath: state.selectedPath,
        historySummary: state.historySummary,
    });
    const lines = [];
    lines.push(`[System]\n${EBOOK_SYSTEM_PROMPT}`);
    lines.push(`[Current context]\n${contextPrompt}`);
    (state.messages || []).forEach((message) => {
        if (!message || !['user', 'assistant', 'tool'].includes(message.role)) return;
        const roleLabel = message.role === 'user'
            ? '用户'
            : message.role === 'tool'
                ? `工具:${message.toolName || message.toolCallId || ''}`
                : '电纸书';
        const toolCalls = message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length
            ? message.toolCalls.map((toolCall) => `${toolCall.name} ${toolCall.arguments || '{}'}`).join('\n')
            : '';
        lines.push(`${roleLabel}: ${[message.content || '', toolCalls].filter(Boolean).join('\n')}`);
    });
    return estimateEbookTokens(lines.join('\n\n'));
}

function renderConversationContextMeterLabel(state = {}) {
    const used = estimateConversationContextTokens(state);
    return `${formatContextMeterCount(used)}/${formatContextMeterCount(EBOOK_MAX_CONTEXT_TOKENS)}`;
}

function renderConversationContextMeterTitle(state = {}) {
    return state.historySummary?.trim()
        ? '当前实际送模上下文 / 188k（已整理较早创作记录）'
        : '当前实际送模上下文 / 188k';
}

function renderThoughtDetails(message = {}, options = {}) {
    const thoughts = normalizeThoughtBlocks(message.thoughts);
    if (!thoughts.length) return '';
    const thoughtKey = String(options.key || '').trim();
    const autoOpen = !!message.streaming;
    const isOpen = autoOpen
        || (thoughtKey && Array.isArray(options.openThoughtKeys) && options.openThoughtKeys.includes(thoughtKey));
    const label = thoughts.length > 1
        ? `${message.streaming ? '正在思考' : '展开思考块'}（${thoughts.length} 段）`
        : (message.streaming ? '正在思考' : '展开思考块');
    const thoughtKeyAttr = thoughtKey ? ` data-thought-key="${escapeHtml(thoughtKey)}"` : '';
    const autoOpenAttr = autoOpen ? ' data-auto-open-thought="true"' : '';
    const openAttr = isOpen ? ' open' : '';
    return `
        <details class="xb-thought-details"${thoughtKeyAttr}${autoOpenAttr}${openAttr}>
            <summary>${escapeHtml(label)}</summary>
            ${thoughts.map((item) => `
                <div class="xb-thought-block">
                    <div class="xb-thought-label">${escapeHtml(item.label)}</div>
                    <pre>${escapeHtml(item.text)}</pre>
                </div>
            `).join('')}
        </details>
    `;
}

function buildToolTurnKey(batches = [], fallbackIndex = 0) {
    const ids = [];
    batches.forEach((batch) => {
        (batch.assistantMessage?.toolCalls || []).forEach((toolCall) => {
            const id = String(toolCall?.id || '').trim();
            if (id) ids.push(id);
        });
    });
    return ids.length
        ? `tool-turn:${ids.join('|')}`
        : `tool-turn:fallback:${fallbackIndex}`;
}

function shouldAutoOpenActiveToolTurn(state = {}, startIndex = -1) {
    return !!(
        state.isBusy
        && Number.isInteger(state.activeTurnStartIndex)
        && state.activeTurnStartIndex >= 0
        && startIndex > state.activeTurnStartIndex
    );
}

function parseToolContent(content = '') {
    try {
        const parsed = JSON.parse(String(content || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function formatToolSummary(message = {}) {
    const parsed = parseToolContent(message.content);
    return trimInlineText(
        parsed.summary
        || parsed.message
        || parsed.error
        || String(message.content || ''),
        220,
    ) || '工具已返回结果。';
}

function formatElapsedMs(ms = 0) {
    const value = Number(ms) || 0;
    if (!value) return '';
    return `${(value / 1000).toFixed(1)}s`;
}

function renderLiveToolPayload(item = {}) {
    const payload = Array.isArray(item.payload) ? item.payload : [];
    if (!payload.length) return '';
    return `
        <div class="xb-tool-payload">
            ${payload.map((entry) => `
                <div class="xb-tool-payload-row">
                    <span>${escapeHtml(entry.label || '')}</span>
                    <p>${escapeHtml(trimInlineText(entry.text || '', 260))}</p>
                </div>
            `).join('')}
        </div>
    `;
}

function renderLiveToolTraceItem(item = {}) {
    const hasStatus = item.status === 'running' || item.status === 'resolved';
    const isRunning = item.status === 'running';
    const payloadHtml = renderLiveToolPayload(item);
    const hasPayload = !!payloadHtml;
    const statusText = !hasStatus
        ? ''
        : isRunning
        ? '运行中'
        : (item.ok === false ? '失败' : '已返回');
    const elapsed = hasStatus && !isRunning ? formatElapsedMs(item.elapsedMs) : '';
    const statusSuffix = elapsed ? ` · ${elapsed}` : '';
    const summary = trimInlineText(item.summary, 220) || (isRunning ? '工具已发起，等待返回。' : '工具已返回结果。');
    const classes = [
        'xb-tool',
        hasPayload ? 'has-payload' : '',
        hasStatus ? (isRunning ? 'is-running' : 'is-resolved') : '',
        item.ok === false ? 'is-error' : '',
    ].filter(Boolean).join(' ');
    const headHtml = `
        <div class="xb-tool-head">
            <span>${escapeHtml(item.title || item.name || '工具调用')}</span>
            ${statusText ? `<em>${escapeHtml(`${statusText}${statusSuffix}`)}</em>` : ''}
        </div>
    `;
    const resultHtml = `
        ${headHtml}
        <small>${escapeHtml(summary)}</small>
    `;
    return `
        <div class="${escapeHtml(classes)}">
            ${hasPayload ? `
                ${payloadHtml}
                <div class="xb-tool-result">${resultHtml}</div>
            ` : resultHtml}
        </div>
    `;
}

function renderStoredToolMessage(toolMessage = {}) {
    const parsed = parseToolContent(toolMessage.content);
    const display = toolMessage.toolDisplay && typeof toolMessage.toolDisplay === 'object'
        ? toolMessage.toolDisplay
        : null;
    if (!display) {
        return `
            <div class="xb-tool ${parsed.ok === false ? 'is-error' : ''}">
                <div class="xb-tool-plain-title">${escapeHtml(toolMessage.toolName || '工具结果')}</div>
                <small>${escapeHtml(formatToolSummary(toolMessage))}</small>
            </div>
        `;
    }
    return renderLiveToolTraceItem({
        name: toolMessage.toolName || '工具结果',
        title: display.title || toolMessage.toolName || '工具结果',
        ok: parsed.ok !== false,
        status: display.status || 'resolved',
        summary: formatToolSummary(toolMessage),
        payload: Array.isArray(display.payload) ? display.payload : [],
        elapsedMs: Number(display.elapsedMs) || 0,
    });
}

function renderMessageMarkdownHtml(text = '') {
    return renderMarkdownToHtml(String(text || '').trim());
}

function renderBookCards(state = {}) {
    if (!state.books.length) {
        return '<div class="xb-empty xb-library-empty">书架上还没有书。点“新建一本书”，先放上第一本书稿。</div>';
    }
    const deleteMode = !!state.isDeleteBookOpen;
    return state.books.map((book) => {
        const active = book.id === state.book?.id ? ' is-active' : '';
        const modeClass = deleteMode ? ' is-delete-target' : '';
        const dataAttr = deleteMode
            ? `data-delete-book-id="${escapeHtml(book.id)}"`
            : `data-book-id="${escapeHtml(book.id)}"`;
        return `
            <button class="xb-library-book${active}${modeClass}" ${dataAttr} ${state.isBusy ? 'disabled' : ''}>
                <span class="xb-book-spine"></span>
                <span class="xb-library-book-main">
                    <strong>${escapeHtml(book.title || '未命名书稿')}</strong>
                    <small>${deleteMode ? '点击删除这本书' : '打开后选择创作或阅读'}</small>
                </span>
                <span class="xb-library-book-foot">
                    <em>${deleteMode ? 'DELETE' : (active ? 'ACTIVE' : 'EBOOK')}</em>
                    <small>${escapeHtml(formatBookDate(book.updatedAt))}</small>
                </span>
            </button>
        `;
    }).join('');
}

function renderLibraryShell(options = {}) {
    const state = options.state || {};
    const bookCount = Array.isArray(state.books) ? state.books.length : 0;
    const themeClass = state.colorTheme === 'light' ? 'theme-light' : 'theme-dark';
    const themeToggleLabel = state.colorTheme === 'light' ? '深色' : '浅色';
    const themeToggleTitle = state.colorTheme === 'light' ? '切换为深色视觉' : '切换为白底黑字';
    return `
        <div class="xb-ebook-screen xb-library-screen ${escapeHtml(themeClass)}${state.isDeleteBookOpen ? ' is-delete-mode' : ''}">
            <div class="xb-ambient-aurora"></div>
            <header class="xb-archive-header">
                <div>
                    <h1>小白电纸书</h1>
                    <div class="xb-archive-meta">${bookCount ? `${bookCount} 本书稿 · 本地书架` : '本地书架 · 等待第一本书稿'}</div>
                </div>
                <div class="xb-global-actions">
                    <button id="xb-library-new-book" class="xb-glass-button" ${state.isBusy ? 'disabled' : ''}>＋ 新建</button>
                    ${state.isDeleteBookOpen ? `
                        <button id="xb-delete-book-close" class="xb-glass-button xb-danger-button">取消删除</button>
                    ` : `
                        <button id="xb-library-delete-book" class="xb-glass-button xb-danger-button" ${bookCount && !state.isBusy ? '' : 'disabled'}>删除</button>
                    `}
                    <button id="xb-theme-toggle" class="xb-glass-button xb-theme-button" type="button" title="${escapeHtml(themeToggleTitle)}" aria-label="${escapeHtml(themeToggleTitle)}">${escapeHtml(themeToggleLabel)}</button>
                    <button id="xb-close" class="xb-glass-button">退出</button>
                </div>
            </header>
            <main class="xb-shelf-container">
                ${state.isDeleteBookOpen ? '<div class="xb-delete-mode-note">删除模式：点击一本书会清除书稿内容和写作记录。</div>' : ''}
                <section class="xb-library-grid" aria-label="书籍列表">
                    ${renderBookCards(state)}
                </section>
            </main>
            ${state.toast ? `<div class="xb-toast">${escapeHtml(state.toast)}</div>` : ''}
        </div>
    `;
}

function renderBookEntryShell(options = {}) {
    const state = options.state || {};
    const themeClass = state.colorTheme === 'light' ? 'theme-light' : 'theme-dark';
    const themeToggleLabel = state.colorTheme === 'light' ? '深色' : '浅色';
    const themeToggleTitle = state.colorTheme === 'light' ? '切换为深色视觉' : '切换为白底黑字';
    return `
        <div class="xb-ebook-screen xb-entry-screen ${escapeHtml(themeClass)}">
            <div class="xb-ambient-aurora"></div>
            <button class="xb-portal-close" id="xb-library-link" title="返回书架" aria-label="返回书架">×</button>
            <button class="xb-portal-theme" id="xb-theme-toggle" type="button" title="${escapeHtml(themeToggleTitle)}" aria-label="${escapeHtml(themeToggleTitle)}">${escapeHtml(themeToggleLabel)}</button>
            <main class="xb-entry-portal" aria-label="书本入口">
                <section class="xb-entry-actions">
                    <button class="xb-entry-action is-studio" data-entry-action="studio">
                        <strong>创作台</strong>
                        <span>写正文、导入资料、整理设定，让写作助手审稿和修订。</span>
                    </button>
                    <button class="xb-entry-action is-reader" data-entry-action="reader">
                        <strong>阅读</strong>
                        <span>按章节沉浸阅读。这里不放 AI，只保留安静的阅读体验。</span>
                    </button>
                </section>
            </main>
            ${state.toast ? `<div class="xb-toast">${escapeHtml(state.toast)}</div>` : ''}
        </div>
    `;
}

function getFileGroup(path = '') {
    return STUDIO_FILE_SECTIONS.find((group) => group.matches(path)) || {
        key: 'other',
        title: '其他',
        description: '当前书里的其他文件',
        badge: '文件',
        empty: '没有其他文件。',
        matches: () => false,
    };
}

function renderSectionFiles(section = {}, files = [], state = {}) {
    if (!files.length) {
        return `<div class="xb-section-empty">${escapeHtml(section.empty || '这里还没有文件。')}</div>`;
    }
    return files.map((file) => {
        const active = file.path === state.selectedPath ? ' is-active' : '';
        return `
            <button class="xb-file${active}" data-path="${escapeHtml(file.path)}">
                <span class="xb-file-main">${escapeHtml(formatFileTitle(file.path))}</span>
            </button>
        `;
    }).join('');
}

function renderImportActions(disabledAttr = '') {
    return `
        <div class="xb-section-subtitle">可导入</div>
        <div class="xb-imports">
            <button data-import="chat" title="导入当前聊天的全部楼层" ${disabledAttr}>聊天记录</button>
            <button data-import="character" ${disabledAttr}>角色信息</button>
            <button data-import="summary" title="导入小白X剧情总结模块里的当前总结" ${disabledAttr}>剧情总结</button>
            <button data-import="worldbook" title="导入当前角色/聊天关联世界书的启用条目" ${disabledAttr}>世界书</button>
        </div>
    `;
}

function renderStudioFileSections(state = {}, options = {}) {
    const files = sortBookFiles(state.files);
    if (!files.length) return '<div class="xb-empty">还没有书稿文件</div>';
    const grouped = new Map();
    files.forEach((file) => {
        const group = getFileGroup(file.path);
        if (!grouped.has(group.key)) {
            grouped.set(group.key, {
                key: group.key,
                title: group.title,
                description: group.description,
                badge: group.badge,
                files: [],
            });
        }
        grouped.get(group.key).files.push(file);
    });

    const primarySections = STUDIO_FILE_SECTIONS.map((section) => ({
        ...section,
        files: grouped.get(section.key)?.files || [],
    }));
    const knownKeys = new Set(STUDIO_FILE_SECTIONS.map((section) => section.key));
    const otherSections = [...grouped.values()].filter((group) => !knownKeys.has(group.key));

    return [...primarySections, ...otherSections].map((group) => `
        <div class="xb-file-group">
            <div class="xb-file-group-title">
                <span>${escapeHtml(group.title)}</span>
                <em>${escapeHtml(group.badge)}</em>
            </div>
            <div class="xb-file-group-desc">${escapeHtml(group.description)}</div>
            ${group.key === 'sources' ? renderImportActions(options.writeActionAttr || '') : ''}
            ${group.key === 'sources' ? '<div class="xb-section-subtitle">已导入</div>' : ''}
            ${renderSectionFiles(group, group.files, state)}
        </div>
    `).join('');
}

function renderMessages(state = {}) {
    const memoryHint = state.historySummary
        ? '<div class="xb-agent-memory">已整理较早创作记录，后续写作会继续参考。</div>'
        : '';
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const units = [];

    const renderMessageActions = (message = {}, messageIndex = 0) => {
        const canAct = message.role === 'assistant'
            && !message.streaming
            && String(message.content || '').trim()
            && !(Array.isArray(message.toolCalls) && message.toolCalls.length);
        if (!canAct) return '';
        const isEditing = state.editingMessageIndex === messageIndex;
        const actionFeedback = state.messageActionFeedback || {};
        const actionDefs = isEditing
            ? [
                { action: 'save-edit', label: '✓', title: '保存这条消息的修改' },
                { action: 'cancel-edit', label: '✕', title: '取消本次修改' },
            ]
            : [
                {
                    action: 'copy',
                    label: actionFeedback[`copy:${messageIndex}`] === 'success'
                        ? '✓'
                        : actionFeedback[`copy:${messageIndex}`] === 'error'
                            ? '!'
                            : '⧉',
                    title: '复制整条消息',
                },
                { action: 'edit', label: '✎', title: '编辑这条消息' },
                { action: 'reroll', label: '↻', title: '从这里重新生成后续回复' },
                { action: 'delete', label: '🗑', title: '删除这条消息' },
            ];
        return `
            <div class="xb-msg-actions">
                ${actionDefs.map((item) => `
                    <button type="button" class="xb-msg-action" data-message-action="${escapeHtml(item.action)}" data-message-index="${messageIndex}" title="${escapeHtml(item.title)}" aria-label="${escapeHtml(item.title)}">${escapeHtml(item.label)}</button>
                `).join('')}
            </div>
        `;
    };

    const renderPlainMessage = (message = {}, messageIndex = 0) => {
        const isEditing = message.role === 'assistant' && state.editingMessageIndex === messageIndex;
        const content = String(message.content || '').trim();
        return `
            <div class="xb-msg xb-msg-${escapeHtml(message.role)}${message.error ? ' is-error' : ''}${message.streaming ? ' is-streaming' : ''}${isEditing ? ' is-editing' : ''}" data-message-index="${messageIndex}">
                <div class="xb-msg-head">
                    <div class="xb-msg-role">${message.role === 'user' ? '你' : '电纸书'}</div>
                    ${renderMessageActions(message, messageIndex)}
                </div>
                ${isEditing ? '' : renderThoughtDetails(message, {
                    key: `thought-message:${messageIndex}`,
                    openThoughtKeys: state.openThoughtKeys,
                })}
                ${isEditing ? `
                    <div class="xb-msg-editor-wrap">
                        <textarea class="xb-msg-editor" data-message-editor="${messageIndex}" rows="${Math.min(Math.max(content.split('\n').length, 4), 14)}">${escapeHtml(content)}</textarea>
                    </div>
                ` : (content ? `<div class="xb-msg-content xb-msg-markdown xb-assistant-markdown">${renderMessageMarkdownHtml(content)}</div>` : '')}
            </div>
        `;
    };

    const renderToolRun = (startIndex = 0) => {
        const batches = [];
        let index = startIndex;
        while (
            index < messages.length
            && messages[index]?.role === 'assistant'
            && Array.isArray(messages[index].toolCalls)
            && messages[index].toolCalls.length
        ) {
            const assistantMessage = messages[index];
            const toolMessages = [];
            let nextIndex = index + 1;
            while (nextIndex < messages.length && messages[nextIndex]?.role === 'tool') {
                toolMessages.push(messages[nextIndex]);
                nextIndex += 1;
            }
            batches.push({ assistantMessage, toolMessages });
            index = nextIndex;
        }
        const turnKey = buildToolTurnKey(batches, startIndex);
        const autoOpen = shouldAutoOpenActiveToolTurn(state, startIndex);
        const isOpen = autoOpen
            || (Array.isArray(state.openToolTurnKeys) && state.openToolTurnKeys.includes(turnKey));
        const autoOpenAttr = autoOpen ? ' data-auto-open-tool-turn="true"' : '';
        const openAttr = isOpen ? ' open' : '';
        const html = `
            <details class="xb-tool-trace xb-tool-turn" data-tool-turn-key="${escapeHtml(turnKey)}"${autoOpenAttr}${openAttr}>
                <summary><span>已创作 ${batches.length || 1} 轮</span><span class="xb-tool-fold-indicator" aria-hidden="true"></span></summary>
                <div class="xb-tool-trace-body">
                    ${batches.map((batch, batchIndex) => `
                        <div class="xb-tool-round">
                            <div class="xb-tool-round-title">第 ${batchIndex + 1} 轮 · ${batch.toolMessages.length || batch.assistantMessage.toolCalls.length} 个工具</div>
                            ${renderThoughtDetails(batch.assistantMessage, {
                                key: `${turnKey}:thought:${batchIndex + 1}`,
                                openThoughtKeys: state.openThoughtKeys,
                            })}
                            ${String(batch.assistantMessage.content || '').trim() ? `<div class="xb-tool-preface xb-tool-preface-markdown xb-assistant-markdown">${renderMessageMarkdownHtml(batch.assistantMessage.content)}</div>` : ''}
                            ${batch.toolMessages.map((toolMessage) => renderStoredToolMessage(toolMessage)).join('')}
                        </div>
                    `).join('')}
                </div>
            </details>
        `;
        return { html, nextIndex: index };
    };

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || !['user', 'assistant', 'tool'].includes(message.role)) continue;
        if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
            const unit = renderToolRun(index);
            units.push(unit.html);
            index = unit.nextIndex - 1;
            continue;
        }
        if (message.role === 'tool') continue;
        units.push(renderPlainMessage(message, index));
    }

    const liveToolTurnHtml = state.isBusy ? renderLiveToolTurn(state) : '';
    if (!units.length && !liveToolTurnHtml) {
        return `${memoryHint}<div class="xb-agent-empty">这里是写作助手记录。可以先导入资料，也可以直接说“帮我整理第一章开头”。</div>`;
    }
    return `${memoryHint}${units.join('')}${liveToolTurnHtml}`;
}

function renderLiveToolTurn(state = {}) {
    const traceItems = Array.isArray(state.toolTrace) ? state.toolTrace.slice(-8) : [];
    if (!traceItems.length) return '';
    const assistantMessage = state.liveToolTurn && typeof state.liveToolTurn === 'object'
        ? state.liveToolTurn
        : {
            role: 'assistant',
            content: '',
            thoughts: [],
            toolCalls: traceItems.map((item, index) => ({
                id: String(item.id || `live-tool-${index}`),
                name: String(item.name || ''),
                arguments: '{}',
            })),
        };
    const rounds = new Set(state.toolTrace.map((item) => Number(item.round) || 1)).size || 1;
    const turnKey = buildToolTurnKey([{ assistantMessage }], 'live');
    return `
        <details class="xb-tool-trace xb-tool-turn xb-tool-turn-live" data-tool-turn-key="${escapeHtml(turnKey)}" data-auto-open-tool-turn="true" open>
            <summary><span>正在创作 ${rounds} 轮</span><span class="xb-tool-fold-indicator" aria-hidden="true"></span></summary>
            <div class="xb-tool-trace-body">
                <div class="xb-tool-round">
                    <div class="xb-tool-round-title">当前工具轮</div>
                    ${renderThoughtDetails(assistantMessage, {
                        key: `${turnKey}:thought:live`,
                        openThoughtKeys: state.openThoughtKeys,
                    })}
                    ${String(assistantMessage.content || '').trim() ? `<div class="xb-tool-preface xb-tool-preface-markdown xb-assistant-markdown">${renderMessageMarkdownHtml(assistantMessage.content)}</div>` : ''}
                    ${traceItems.map((item) => renderLiveToolTraceItem(item)).join('')}
                </div>
            </div>
        </details>
    `;
}

function renderDraftStats(state = {}) {
    return formatDraftMetrics(state.editorContent || '');
}

function renderSettingsDialog(state = {}) {
    if (!state.isSettingsOpen) return '';
    return `
        <div class="xb-ebook-settings-overlay" id="xb-agent-settings-overlay">
            <div class="xb-ebook-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="xb-agent-settings-title">
                <div class="xb-ebook-settings-head">
                    <div>
                        <h2 id="xb-agent-settings-title">API配置</h2>
                        <p>在这里填写 API 和模型。</p>
                    </div>
                    <button id="xb-agent-settings-close" type="button" title="关闭配置" aria-label="关闭配置">关闭</button>
                </div>
                <div class="xb-ebook-settings-body">
                    ${buildAgentSettingsPanelMarkup({
                        configSave: state.configSave,
                        runtimeText: '',
                        showInlineToast: false,
                        showAssistantPermissions: false,
                        activePage: state.configPage,
                        delegatePresetHint: '电纸书审稿分身会使用这里的独立 API 配置；可以和主助手使用不同 Provider、Base URL、模型和 Tool 调用格式。',
                        isBusy: state.isBusy,
                        canDeletePreset: (state.config?.presetNames || []).length > 1,
                    })}
                </div>
            </div>
        </div>
    `;
}

function renderStudioShell(options = {}) {
    const state = options.state || {};
    const providerConfig = options.providerConfig || {};
    const dirty = !!options.dirty;
    const readiness = renderProviderReadiness(providerConfig);
    const writeActionAttr = state.isBusy ? 'disabled' : '';
    const agentActionAttr = (state.isBusy || !readiness.canRun) ? 'disabled' : '';
    const agentInputAttr = (!state.isBusy && !readiness.canRun) ? 'disabled' : '';
    const sendButtonAttr = (!state.isBusy && !readiness.canRun) ? 'disabled' : '';
    const canClearConversation = !!(state.messages?.length || state.historySummary?.trim());
    const layoutClass = ['focus-editor', 'focus-agent'].includes(state.studioLayout)
        ? state.studioLayout
        : 'balanced';
    const themeClass = state.colorTheme === 'light' ? 'theme-light' : 'theme-dark';
    const themeToggleLabel = state.colorTheme === 'light' ? '深色' : '浅色';
    const themeToggleTitle = state.colorTheme === 'light' ? '切换为深色视觉' : '切换为白底黑字';

    return `
        <div class="xb-ebook-shell xb-studio-shell ${escapeHtml(layoutClass)} ${escapeHtml(themeClass)}">
            <aside class="xb-sidebar">
                <div class="xb-brand">
                    <div class="xb-title-row">
                        <h1>${escapeHtml(state.book?.title || '未命名书稿')}</h1>
                        <button class="xb-icon-button" data-book-rename title="修改书名" aria-label="修改书名" ${state.isBusy ? 'disabled' : ''}>✎</button>
                        <button id="xb-entry-link" class="xb-icon-button" title="返回书本入口" aria-label="返回书本入口">↩</button>
                    </div>
                    <div class="xb-workspace-controller">
                        <button type="button" class="xb-layout-button${layoutClass === 'focus-editor' ? ' is-active' : ''}" data-studio-layout="focus-editor">编辑</button>
                        <button type="button" class="xb-layout-button${layoutClass === 'balanced' ? ' is-active' : ''}" data-studio-layout="balanced">平衡</button>
                        <button type="button" class="xb-layout-button${layoutClass === 'focus-agent' ? ' is-active' : ''}" data-studio-layout="focus-agent">助手</button>
                    </div>
                </div>
                <section class="xb-panel xb-files-panel">
                    <div class="xb-files">${renderStudioFileSections(state, { writeActionAttr })}</div>
                </section>
            </aside>
            <section class="xb-studio-workbench">
                <main class="xb-editor">
                    <header class="xb-editor-head">
                        <div class="xb-path">${escapeHtml(formatFileTitle(state.selectedPath || 'book/chapters/001.md'))}</div>
                        <div class="xb-editor-actions">
                            <button id="xb-reader-link">阅读器</button>
                            <button id="xb-library-link">书架</button>
                            <button id="xb-save" ${dirty && !state.isBusy ? '' : 'disabled'}>保存稿纸</button>
                        </div>
                    </header>
                    <div class="xb-editor-body">
                        <textarea id="xb-editor-text" spellcheck="false" ${state.isBusy ? 'disabled' : ''}>${escapeHtml(state.editorContent)}</textarea>
                    </div>
                    <footer class="xb-editor-foot">
                        <div class="xb-meta" id="xb-editor-meta">${dirty ? '有未保存修改' : '已保存到书库'} · ${renderDraftStats(state)}</div>
                    </footer>
                </main>
                <aside class="xb-agent">
                    <div class="xb-agent-aurora"></div>
                    <header class="xb-agent-head">
                        <div class="xb-agent-id"><span></span>写作助手</div>
                        <div class="xb-agent-toolbar">
                            <div class="xb-agent-context-meter" title="${escapeHtml(renderConversationContextMeterTitle(state))}">${escapeHtml(renderConversationContextMeterLabel(state))}</div>
                            <button id="xb-agent-clear" type="button" ${state.isBusy || !canClearConversation ? 'disabled' : ''}>清空对话</button>
                            <button id="xb-agent-open-settings" type="button">API配置</button>
                            <button id="xb-agent-close" type="button">退出</button>
                            <button id="xb-theme-toggle" type="button" title="${escapeHtml(themeToggleTitle)}" aria-label="${escapeHtml(themeToggleTitle)}">${escapeHtml(themeToggleLabel)}</button>
                        </div>
                    </header>
                    <div class="xb-agent-chat-wrap">
                        <div class="xb-agent-main${state.isBusy ? ' is-busy' : ''}">
                            <details class="xb-actions-panel">
                                <summary>快捷动作</summary>
                                <div class="xb-actions">
                                    <button data-action="outline" ${agentActionAttr}>草拟大纲</button>
                                    <button data-action="next-chapter" ${agentActionAttr}>续写草稿</button>
                                    <button data-action="review" ${agentActionAttr}>审一遍</button>
                                    <button data-action="revise" ${agentActionAttr}>按意见改稿</button>
                                    <button data-action="organize" ${agentActionAttr}>整理资料</button>
                                </div>
                            </details>
                            <div class="xb-agent-log">${renderMessages(state)}</div>
                        </div>
                        <div class="xb-agent-scroll-helpers" id="xb-agent-scroll-helpers">
                            <button id="xb-agent-scroll-top" type="button" class="xb-agent-scroll-btn" title="回到顶部" aria-label="回到顶部">▲</button>
                            <button id="xb-agent-scroll-bottom" type="button" class="xb-agent-scroll-btn" title="回到底部" aria-label="回到底部">▼</button>
                        </div>
                    </div>
                    <form id="xb-agent-form" class="xb-agent-form">
                        <div class="xb-agent-compose-row">
                            <div class="xb-agent-compose-main">
                                <textarea id="xb-agent-input" placeholder="${readiness.canRun ? '写作指令，例如：把当前段落改得更克制一点，或者先列三种开场方案' : '先补好 API 和模型信息'}" ${agentInputAttr}></textarea>
                                <div class="xb-compose-hint" id="xb-compose-hint">Enter 发送 · Shift+Enter 换行</div>
                            </div>
                            <div class="xb-agent-compose-actions">
                                <button type="submit" class="${state.isBusy ? 'is-busy' : ''}" title="${state.isBusy ? '停止' : '发送'}" aria-label="${state.isBusy ? '停止' : '发送'}" ${sendButtonAttr}>${state.isBusy ? '■' : '➤'}</button>
                            </div>
                        </div>
                    </form>
                </aside>
            </section>
            ${renderSettingsDialog(state)}
            ${state.toast ? `<div class="xb-toast">${escapeHtml(state.toast)}</div>` : ''}
        </div>
    `;
}

function renderReaderTextContent(content = '') {
    const normalized = String(content || '').trim();
    if (!normalized) return '';
    return normalized
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block, index) => `<p class="${index === 0 ? 'xb-reader-drop' : ''}">${escapeHtml(block)}</p>`)
        .join('');
}

function renderReaderShell(options = {}) {
    const state = options.state || {};
    const { chapters, active, activePath, index } = getActiveChapter(state);
    const hasChapters = chapters.length > 0;
    const previous = index > 0 ? chapters[index - 1] : null;
    const next = index < chapters.length - 1 ? chapters[index + 1] : null;
    const progress = hasChapters ? `第 ${index + 1} / ${chapters.length} 章` : '暂无章节';
    const content = active?.content || '';
    const chapterProgress = hasChapters ? Math.round(((index + 1) / chapters.length) * 100) : 0;
    const themeClass = state.colorTheme === 'light' ? 'theme-light' : 'theme-dark';
    const themeToggleLabel = state.colorTheme === 'light' ? '深色' : '浅色';
    const themeToggleTitle = state.colorTheme === 'light' ? '切换为深色视觉' : '切换为白底黑字';

    return `
        <div class="xb-ebook-screen xb-reader-screen ${escapeHtml(themeClass)}">
            <div class="xb-reader-backlight"></div>
            <nav class="xb-reader-edge" aria-label="阅读器操作">
                <div class="xb-reader-edge-actions">
                    <button class="xb-reader-edge-button" id="xb-entry-link" title="返回入口" aria-label="返回入口">←</button>
                    <button class="xb-reader-edge-button" id="xb-studio-link" title="去创作台" aria-label="去创作台">✎</button>
                    <button class="xb-reader-edge-button xb-reader-theme-toggle" id="xb-theme-toggle" type="button" title="${escapeHtml(themeToggleTitle)}" aria-label="${escapeHtml(themeToggleTitle)}">${escapeHtml(themeToggleLabel)}</button>
                </div>
                <div class="xb-reader-progress" title="${escapeHtml(progress)}" style="--xb-reader-progress:${chapterProgress}%"><span></span></div>
            </nav>
            <main class="xb-reader-main">
                <aside class="xb-reader-nav">
                    <div class="xb-reader-index-title">目录</div>
                    <div class="xb-reader-chapters">
                        ${hasChapters ? chapters.map((chapter, chapterIndex) => `
                            <button class="xb-reader-chapter${chapter.path === activePath ? ' is-active' : ''}" data-reader-path="${escapeHtml(chapter.path)}">
                                <span>${escapeHtml(formatFileTitle(chapter.path))}</span>
                                <small>${chapterIndex + 1}</small>
                            </button>
                        `).join('') : '<div class="xb-empty">还没有正文</div>'}
                    </div>
                </aside>
                <article class="xb-reader-paper">
                    ${hasChapters ? `
                        <header class="xb-reader-head">
                            <div>
                                <div class="xb-kicker">${escapeHtml(state.book?.title || '未命名书稿')} · ${escapeHtml(progress)}</div>
                                <h2>${escapeHtml(formatFileTitle(activePath))}</h2>
                                <p>${escapeHtml(formatTextMetrics(content))}</p>
                            </div>
                        </header>
                        <div class="xb-reader-content">${renderReaderTextContent(content)}</div>
                        <footer class="xb-reader-foot">
                            <button data-reader-path="${escapeHtml(previous?.path || '')}" ${previous ? '' : 'disabled'}>上一章</button>
                            <button data-reader-path="${escapeHtml(next?.path || '')}" ${next ? '' : 'disabled'}>下一章</button>
                        </footer>
                    ` : `
                        <div class="xb-reader-empty">
                            <h2>还没有正文</h2>
                            <p>去创作台写下第一章，再回来阅读。</p>
                            <button id="xb-studio-empty-link">去创作台</button>
                        </div>
                    `}
                </article>
            </main>
            ${state.toast ? `<div class="xb-toast">${escapeHtml(state.toast)}</div>` : ''}
        </div>
    `;
}

export function renderEbookShell(options = {}) {
    const state = options.state || {};
    switch (state.viewMode) {
        case 'book-entry':
            return renderBookEntryShell(options);
        case 'studio':
            return renderStudioShell(options);
        case 'reader':
            return renderReaderShell(options);
        case 'library':
        default:
            return renderLibraryShell(options);
    }
}
