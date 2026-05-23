import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

const dbModule = await import('../shared/ebook-db.js');
const toolsModule = await import('../shared/book-tools.js');
const controllerModule = await import('../app-src/book-controller.js');
const conversationStoreModule = await import('../app-src/conversation-store.js');
const compactionModule = await import('../app-src/history-compaction.js');
const promptsModule = await import('../app-src/prompts.js');
const agentRunnerModule = await import('../app-src/agent-runner.js');
const rendererModule = await import('../app-src/renderer.js');
const uiBindingsModule = await import('../app-src/ui-bindings.js');
const messageMarkdownModule = await import('../../agent-core/ui/message-markdown.js');

const {
    default: db,
    createBook,
    deleteBook,
    getBook,
    getBookFile,
    getSelectedBookId,
    listBookFiles,
    listBooks,
    ebookMessagesTable,
    ebookSessionsTable,
    setSelectedBookId,
    upsertBookFile,
} = dbModule;
const {
    EBOOK_TOOL_NAMES,
    buildEbookToolFailureResult,
    createBookToolRuntime,
    getEbookToolDefinitions,
} = toolsModule;
const { createBookController } = controllerModule;
const { createEbookConversationStore } = conversationStoreModule;
const {
    EBOOK_DEFAULT_PRESERVED_TURNS,
    EBOOK_MAX_CONTEXT_TOKENS,
    EBOOK_MIN_PRESERVED_TURNS,
    EBOOK_SUMMARY_TRIGGER_TOKENS,
    createEbookHistoryCompactionController,
} = compactionModule;
const {
    EBOOK_DELEGATE_PROMPT,
    EBOOK_SUMMARY_SYSTEM_PROMPT,
    EBOOK_SYSTEM_PROMPT,
    buildActionPrompt,
    buildBookContextPrompt,
    buildDelegateBookContextPrompt,
} = promptsModule;
const { buildEbookProviderMessagesFromHistory, createEbookAgentRunner } = agentRunnerModule;
const { renderEbookShell } = rendererModule;
const { bindEbookEvents } = uiBindingsModule;
const { HTML_PREVIEW_SANDBOX, renderMarkdownToHtml } = messageMarkdownModule;

async function resetDb() {
    await db.delete();
    await db.open();
}

test('Book tools reject paths outside the current book namespace', async () => {
    await resetDb();
    const book = await createBook('安全边界测试');
    const runtime = createBookToolRuntime({ bookId: book.id });

    await assert.rejects(
        () => runtime.execute(EBOOK_TOOL_NAMES.READ, { filePath: 'local/a.md' }),
        /book_path_required/,
    );
    await assert.rejects(
        () => runtime.execute(EBOOK_TOOL_NAMES.READ, { filePath: '../x.md' }),
        /book_path_required/,
    );
    await assert.rejects(
        () => runtime.execute(EBOOK_TOOL_NAMES.WRITE, { path: 'scripts/x.md', content: 'bad' }),
        /book_path_required/,
    );

    const ok = await runtime.execute(EBOOK_TOOL_NAMES.READ, { filePath: 'book/outline.md', limit: 5 });
    assert.equal(ok.ok, true);
    assert.match(ok.content, /大纲/);

    const root = await runtime.execute(EBOOK_TOOL_NAMES.LS, { path: 'book/' });
    assert.equal(root.entries.some((entry) => entry.path === 'book/sources/'), true);
    assert.equal(root.entries.some((entry) => entry.path === 'book/reviews/'), true);
});

test('Book context budget defaults stay aligned with assistant', () => {
    assert.equal(EBOOK_MAX_CONTEXT_TOKENS, 188000);
    assert.equal(EBOOK_SUMMARY_TRIGGER_TOKENS, 158000);
    assert.equal(EBOOK_DEFAULT_PRESERVED_TURNS, 2);
    assert.equal(EBOOK_MIN_PRESERVED_TURNS, 1);
});

test('Book context prompt continuously injects core story files', () => {
    const prompt = buildBookContextPrompt({
        book: { id: 'book-test', title: '提示词书稿' },
        files: [
            {
                path: 'book/outline.md',
                content: '# 大纲\n\n这是一个关于失忆侦探的悬疑故事。',
            },
            {
                path: 'book/style.md',
                content: '# 文风规则\n\n这里记录“怎么写”，供写作助手续写和修订时参考。\n\n- 叙事视角：\n- 语气节奏：\n- 句子长度：\n- 禁忌与边界：\n- 想保留的例句：\n',
            },
            {
                path: 'book/characters.md',
                content: '# 角色设定\n\n- 林栖：调查记者。\n- 沈照：前刑警。',
            },
            {
                path: 'book/world.md',
                content: '# 世界设定\n\n故事发生在海边旧城。',
            },
            {
                path: 'book/state.md',
                content: '# 状态追踪\n\n## 当前进度\n\n**已写到**：第一章末尾，林栖第一次看到旧信。',
            },
            {
                path: 'book/chapters/001.md',
                content: '# 第 1 章\n\n雨下了一整夜。',
            },
            {
                path: 'book/sources/chat.md',
                content: '这是导入的聊天资料。',
            },
        ],
    });

    assert.match(prompt, /\[作品概况\]/);
    assert.match(prompt, /已填写核心设定: 大纲、文风规则、角色设定、世界设定/);
    assert.match(prompt, /正文章节: 1/);
    assert.match(prompt, /已导入资料: chat.md/);
    assert.match(prompt, /\[作品核心设定\]/);
    assert.match(prompt, /## 大纲 \(book\/outline\.md\)/);
    assert.match(prompt, /这是一个关于失忆侦探的悬疑故事/);
    assert.match(prompt, /\[状态追踪\]/);
    assert.match(prompt, /林栖第一次看到旧信/);
    assert.match(prompt, /## 文风规则 \(book\/style\.md\)/);
    assert.match(prompt, /这里记录“怎么写”/);
    assert.doesNotMatch(prompt, /\[Book readiness\]|\[Core file digests\]/);
});

test('Delegate book context injects review rules and core story files', () => {
    const prompt = buildDelegateBookContextPrompt({
        book: { id: 'book-test', title: '审稿测试书' },
        files: [
            {
                path: 'book/outline.md',
                content: '# 大纲\n\n主线是调查海边旧城的失踪案。',
            },
            {
                path: 'book/review-rules.md',
                content: '# 审稿规则\n\n- 特别检查伏笔是否兑现。\n',
            },
            {
                path: 'book/state.md',
                content: '# 状态追踪\n\n## 伏笔与回收\n\n- 旧信已经露面，但还没人知道寄信人。',
            },
            {
                path: 'book/chapters/001.md',
                content: '# 第 1 章\n\n雨下了一整夜。',
            },
        ],
        historySummary: '第一章已经起草。',
    });

    assert.match(prompt, /\[审稿分身自动上下文\]/);
    assert.match(prompt, /title: 审稿测试书/);
    assert.match(prompt, /\[作品核心设定\]/);
    assert.match(prompt, /主线是调查海边旧城的失踪案/);
    assert.match(prompt, /\[状态追踪\]/);
    assert.match(prompt, /旧信已经露面/);
    assert.match(prompt, /\[审稿规则\]/);
    assert.match(prompt, /特别检查伏笔是否兑现/);
    assert.match(prompt, /\[创作记录\]/);
    assert.match(prompt, /第一章已经起草/);
});

test('Delegate book context keeps full injected review rules and core files', () => {
    const outlineTail = 'OUTLINE_FULL_CONTEXT_TAIL';
    const stateTail = 'STORY_STATE_FULL_CONTEXT_TAIL';
    const rulesTail = 'REVIEW_RULES_FULL_CONTEXT_TAIL';
    const prompt = buildDelegateBookContextPrompt({
        book: { id: 'book-long-context', title: '长上下文测试书' },
        files: [
            {
                path: 'book/outline.md',
                content: `# 大纲\n\n${'大纲内容'.repeat(1200)}\n${outlineTail}`,
            },
            {
                path: 'book/review-rules.md',
                content: `# 审稿规则\n\n${'审稿规则'.repeat(1200)}\n${rulesTail}`,
            },
            {
                path: 'book/state.md',
                content: `# 状态追踪\n\n${'状态追踪'.repeat(1200)}\n${stateTail}`,
            },
        ],
    });

    assert.match(prompt, new RegExp(outlineTail));
    assert.match(prompt, new RegExp(stateTail));
    assert.match(prompt, new RegExp(rulesTail));
    assert.doesNotMatch(prompt, /内容较长，这里只放前/);
});

test('Delegate prompt gives the reviewer a stable book-specific tool model', () => {
    assert.match(EBOOK_DELEGATE_PROMPT, /小白电纸书/);
    assert.match(EBOOK_DELEGATE_PROMPT, /SillyTavern/);
    assert.match(EBOOK_DELEGATE_PROMPT, /当前打开的这本书是唯一工作对象/);
    assert.match(EBOOK_DELEGATE_PROMPT, /book\/chapters\//);
    assert.match(EBOOK_DELEGATE_PROMPT, /\[审稿分身自动上下文\]/);
    assert.match(EBOOK_DELEGATE_PROMPT, /# 工具使用指导/);
    assert.match(EBOOK_DELEGATE_PROMPT, /不知道文件在哪时先 LS \/ Glob/);
    assert.match(EBOOK_DELEGATE_PROMPT, /审具体章节时，必须 Read/);
    assert.match(EBOOK_DELEGATE_PROMPT, /book\/review-rules\.md` 是本书的审稿标准/);
    assert.match(EBOOK_DELEGATE_PROMPT, /不要另起一套标准/);
    assert.match(EBOOK_DELEGATE_PROMPT, /审稿规则没有覆盖的地方/);
    assert.match(EBOOK_DELEGATE_PROMPT, /不能写文件、不能管理计划、不能委派其他分身/);
    assert.match(EBOOK_DELEGATE_PROMPT, /最终结果给主助手/);
    assert.doesNotMatch(EBOOK_DELEGATE_PROMPT, /重点检查结构、人物动机、关系连续性、节奏、设定一致性、时间线、伏笔、视角和文风/);
});

test('Book action prompts rely on injected core story files', () => {
    const outlinePrompt = buildActionPrompt('outline');
    const nextChapterPrompt = buildActionPrompt('next-chapter');
    const organizePrompt = buildActionPrompt('organize');

    assert.match(outlinePrompt, /\[作品核心设定\]/);
    assert.match(outlinePrompt, /不要硬写完整大纲/);
    assert.match(outlinePrompt, /不一次性生成全书细纲/);
    assert.match(outlinePrompt, /按卷或事件集团推进/);
    assert.match(outlinePrompt, /按需读取对应资料/);
    assert.match(nextChapterPrompt, /\[作品核心设定\]/);
    assert.match(nextChapterPrompt, /不要直接硬写长正文/);
    assert.match(nextChapterPrompt, /只读取目标章节或相邻章节/);
    assert.match(organizePrompt, /材料太少/);
    assert.doesNotMatch(outlinePrompt, /\[Book readiness\]|\[Core file digests\]|不要机械/);
});

test('Delegate book tool profile is read-only and excludes orchestration tools', async () => {
    const definitions = getEbookToolDefinitions({ readOnly: true });
    const names = definitions.map((definition) => definition.function.name);

    assert.equal(names.includes(EBOOK_TOOL_NAMES.READ), true);
    assert.equal(names.includes(EBOOK_TOOL_NAMES.GREP), true);
    assert.equal(names.includes(EBOOK_TOOL_NAMES.WRITE), false);
    assert.equal(names.includes(EBOOK_TOOL_NAMES.APPLY_PATCH), false);
    assert.equal(names.includes(EBOOK_TOOL_NAMES.PLAN_CREATE), false);
    assert.equal(names.includes(EBOOK_TOOL_NAMES.DELEGATE_RUN), false);
});

test('Book agent automatically passes review context into DelegateRun', async () => {
    const state = {
        book: { id: 'book-delegate-context', title: '分身上下文测试' },
        files: [
            {
                path: 'book/outline.md',
                content: '# 大纲\n\n主线是找回失踪的旧信。',
            },
            {
                path: 'book/review-rules.md',
                content: '# 审稿规则\n\n- 检查人物动机是否前后一致。\n',
            },
            {
                path: 'book/state.md',
                content: '# 状态追踪\n\n## 人物关系变化\n\n- 林栖和沈照暂时建立合作，但仍互相试探。',
            },
        ],
        historySummary: '已经写完第一章草稿。',
    };
    let seenUserPrompt = '';
    const runner = createEbookAgentRunner({
        state,
        refreshBooksAndFiles() {},
        render() {},
        showToast() {},
        persistConversation() {},
        isEditorDirty() {
            return false;
        },
        getActiveProviderConfig() {
            return {
                provider: 'test',
                temperature: 0.2,
                maxTokens: 1000,
                reasoningEnabled: false,
                reasoningEffort: 'medium',
            };
        },
        createAdapter() {
            return {
                async chat(task) {
                    seenUserPrompt = task.messages[1].content;
                    return {
                        text: '审稿完成。',
                        toolCalls: [],
                    };
                },
            };
        },
    });

    const result = await runner.runDelegate({
        task: '审第一章。',
        context: '本次重点看节奏。',
        deliverable: '列出问题和建议。',
    }, { controller: new AbortController(), bookId: state.book.id });

    assert.equal(result.ok, true);
    assert.match(seenUserPrompt, /\[审稿分身自动上下文\]/);
    assert.match(seenUserPrompt, /主线是找回失踪的旧信/);
    assert.match(seenUserPrompt, /\[状态追踪\]/);
    assert.match(seenUserPrompt, /暂时建立合作/);
    assert.match(seenUserPrompt, /\[审稿规则\]/);
    assert.match(seenUserPrompt, /人物动机是否前后一致/);
    assert.match(seenUserPrompt, /\[创作记录\]/);
    assert.match(seenUserPrompt, /已经写完第一章草稿/);
    assert.match(seenUserPrompt, /\[主助手本次补充\]/);
    assert.match(seenUserPrompt, /本次重点看节奏/);
});

test('Book agent shows DelegateRun dispatch before result and keeps task in history', async () => {
    await resetDb();
    const book = await createBook('分身发起显示测试');
    const state = {
        config: {},
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [],
        toolTrace: [],
        openToolTurnKeys: [],
        activeTurnStartIndex: -1,
        openThoughtKeys: [],
        historySummary: '',
        archivedTurnCount: 0,
        isBusy: false,
        activeController: null,
        status: '就绪',
        toast: '',
    };
    let chatCount = 0;
    let pendingHtml = '';
    let releaseDelegate;
    const delegateGate = new Promise((resolve) => {
        releaseDelegate = resolve;
    });

    const runner = createEbookAgentRunner({
        state,
        async refreshBooksAndFiles() {
            state.files = await listBookFiles(book.id);
        },
        render() {
            const pendingDelegate = state.toolTrace.find((item) => (
                item.name === EBOOK_TOOL_NAMES.DELEGATE_RUN
                && item.status === 'running'
            ));
            if (!pendingHtml && pendingDelegate) {
                pendingHtml = renderEbookShell({
                    state,
                    providerConfig: { provider: 'test', model: 'demo' },
                    dirty: false,
                });
                releaseDelegate();
            }
        },
        showToast() {},
        persistConversation() {},
        isEditorDirty() {
            return false;
        },
        getActiveProviderConfig() {
            return {
                provider: 'test',
                temperature: 0.2,
                maxTokens: 1000,
                reasoningEnabled: false,
                reasoningEffort: 'medium',
            };
        },
        createAdapter() {
            return {
                async chat() {
                    chatCount += 1;
                    if (chatCount === 1) {
                        return {
                            text: '第 1 章还是空壳，先让分身核对设定一致性。',
                            toolCalls: [{
                                id: 'delegate-review-1',
                                name: EBOOK_TOOL_NAMES.DELEGATE_RUN,
                                arguments: JSON.stringify({
                                    task: '审第一章节奏',
                                    context: '只看 book/chapters/001.md。',
                                    deliverable: '给通过/修改/打回结论。',
                                }),
                            }],
                        };
                    }
                    if (chatCount === 2) {
                        await delegateGate;
                        return {
                            text: '分身认为第一章节奏正常。',
                            toolCalls: [],
                        };
                    }
                    return {
                        text: '已收到分身意见。',
                        toolCalls: [],
                    };
                },
            };
        },
    });

    await runner.runAgent('请分身审第一章。');

    assert.match(pendingHtml, /审稿分身工作中，等待返回/);
    assert.match(pendingHtml, /第 1 章还是空壳，先让分身核对设定一致性/);
    assert.match(pendingHtml, /审第一章节奏/);
    assert.match(pendingHtml, /只看 book\/chapters\/001\.md/);
    assert.match(pendingHtml, /给通过\/修改\/打回结论/);
    assert.ok(
        pendingHtml.indexOf('给通过/修改/打回结论') < pendingHtml.indexOf('审稿分身工作中，等待返回'),
        'running delegate card should show dispatch payload before running status',
    );
    assert.ok(
        pendingHtml.indexOf('xb-agent-log') < pendingHtml.indexOf('审稿分身工作中，等待返回'),
        'running DelegateRun should render inside the chat log instead of above it',
    );
    assert.ok(
        pendingHtml.indexOf('第 1 章还是空壳，先让分身核对设定一致性') < pendingHtml.indexOf('审稿分身工作中，等待返回'),
        'assistant preface should stay visible before the running delegate block',
    );
    assert.equal(state.messages.find((message) => message.role === 'tool')?.toolDisplay?.payload?.length, 3);

    const finalHtml = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        dirty: false,
    });
    assert.match(finalHtml, /已返回/);
    assert.match(finalHtml, /第 1 章还是空壳，先让分身核对设定一致性/);
    assert.match(finalHtml, /审第一章节奏/);
    assert.match(finalHtml, /分身认为第一章节奏正常/);
    assert.ok(
        finalHtml.indexOf('给通过/修改/打回结论') < finalHtml.indexOf('已返回'),
        'resolved delegate card should show dispatch payload before returned status',
    );
});

test('Book Glob supports recursive patterns from book root', async () => {
    await resetDb();
    const book = await createBook('匹配测试');
    const runtime = createBookToolRuntime({ bookId: book.id });

    const result = await runtime.execute(EBOOK_TOOL_NAMES.GLOB, {
        pattern: 'book/**/*.md',
    });

    assert.equal(result.ok, true);
    assert.equal(result.files.includes('book/outline.md'), true);
    assert.equal(result.files.includes('book/chapters/001.md'), true);
});

test('Book plans are isolated by book id', async () => {
    await resetDb();
    const first = await createBook('第一本');
    const second = await createBook('第二本');
    const firstRuntime = createBookToolRuntime({ bookId: first.id });
    const secondRuntime = createBookToolRuntime({ bookId: second.id });

    const created = await firstRuntime.execute(EBOOK_TOOL_NAMES.PLAN_CREATE, {
        title: '只属于第一本',
    });
    assert.equal(created.ok, true);

    const firstList = await firstRuntime.execute(EBOOK_TOOL_NAMES.PLAN_LIST, {});
    const secondList = await secondRuntime.execute(EBOOK_TOOL_NAMES.PLAN_LIST, {});

    assert.equal(firstList.count, 1);
    assert.equal(firstList.plans[0].title, '只属于第一本');
    assert.equal(secondList.count, 0);
});

test('Book apply_patch edits only book files', async () => {
    await resetDb();
    const book = await createBook('补丁测试');
    await upsertBookFile(book.id, 'book/chapters/001.md', '# 第 1 章\n\n旧内容\n');
    const runtime = createBookToolRuntime({ bookId: book.id });

    const result = await runtime.execute(EBOOK_TOOL_NAMES.APPLY_PATCH, {
        patchText: [
            '*** Begin Patch',
            '*** Update File: book/chapters/001.md',
            '@@',
            ' # 第 1 章',
            ' ',
            '-旧内容',
            '+新内容',
            '*** End Patch',
        ].join('\n'),
    });

    assert.equal(result.ok, true);
    const read = await runtime.execute(EBOOK_TOOL_NAMES.READ, { filePath: 'book/chapters/001.md' });
    assert.match(read.content, /新内容/);
});

test('Book Move rejects moving the book root or a directory into itself', async () => {
    await resetDb();
    const book = await createBook('移动边界测试');
    const runtime = createBookToolRuntime({ bookId: book.id });

    await assert.rejects(
        () => runtime.execute(EBOOK_TOOL_NAMES.MOVE, {
            fromPath: 'book/',
            toPath: 'book/archive/',
        }),
        /book_root_move_forbidden/,
    );

    await assert.rejects(
        () => runtime.execute(EBOOK_TOOL_NAMES.MOVE, {
            fromPath: 'book/chapters/',
            toPath: 'book/chapters/archive/',
        }),
        /book_move_into_self_forbidden/,
    );
});

test('Book tool failures can be returned to the model as structured results', () => {
    const result = buildEbookToolFailureResult(EBOOK_TOOL_NAMES.READ, {
        filePath: 'book/missing.md',
    }, new Error('book_file_not_found'));

    assert.equal(result.ok, false);
    assert.equal(result.toolName, EBOOK_TOOL_NAMES.READ);
    assert.equal(result.path, 'book/missing.md');
    assert.equal(result.error, 'book_file_not_found');
    assert.match(result.message, /book_file_not_found/);
});

test('New chapter action does not overwrite dirty editor state or existing chapters', async () => {
    await resetDb();
    const book = await createBook('新章节保护测试');
    await upsertBookFile(book.id, 'book/chapters/002.md', '# 已有第二章\n');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '未保存内容',
        savedContent: '已保存内容',
        isBusy: false,
        toast: '',
    };
    const previousConfirm = globalThis.confirm;
    const previousPrompt = globalThis.prompt;
    const toasts = [];
    try {
        globalThis.confirm = () => false;
        globalThis.prompt = () => 'book/chapters/003.md';
        const controller = createBookController({
            state,
            render() {},
            requestHost() {},
            showToast(message) {
                toasts.push(message);
            },
        });
        await controller.createNewFile();
        assert.equal(await getBookFile(book.id, 'book/chapters/003.md'), null);

        state.savedContent = state.editorContent;
        globalThis.confirm = () => true;
        globalThis.prompt = () => 'book/chapters/002.md';
        await controller.createNewFile();
        const existing = await getBookFile(book.id, 'book/chapters/002.md');
        assert.match(existing.content, /已有第二章/);
        assert.match(toasts.at(-1), /chapter_already_exists/);
    } finally {
        globalThis.confirm = previousConfirm;
        globalThis.prompt = previousPrompt;
    }
});

test('Import material does not discard dirty editor content without confirmation', async () => {
    await resetDb();
    const book = await createBook('导入保护测试');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '还没保存的章节内容',
        savedContent: '已保存的章节内容',
        isBusy: false,
        status: '就绪',
        toast: '',
    };
    const previousConfirm = globalThis.confirm;
    let requested = false;
    try {
        globalThis.confirm = () => false;
        const controller = createBookController({
            state,
            render() {},
            requestHost() {
                requested = true;
                throw new Error('should_not_import');
            },
            showToast() {},
        });

        await controller.importMaterial('chat');

        assert.equal(requested, false);
        assert.equal(state.editorContent, '还没保存的章节内容');
        assert.equal(state.selectedPath, 'book/chapters/001.md');
    } finally {
        globalThis.confirm = previousConfirm;
    }
});

test('Book controller can rename the current book', async () => {
    await resetDb();
    const book = await createBook('旧书名');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        isBusy: false,
        toast: '',
    };
    const previousPrompt = globalThis.prompt;
    const toasts = [];
    try {
        globalThis.prompt = () => '新书名';
        const controller = createBookController({
            state,
            render() {},
            requestHost() {},
            showToast(message) {
                toasts.push(message);
            },
        });

        await controller.renameCurrentBook();

        assert.equal(state.book.title, '新书名');
        assert.equal((await getBook(book.id)).title, '新书名');
        assert.equal(state.books.some((item) => item.title === '新书名'), true);
        assert.equal(toasts.at(-1), '书名已更新');
    } finally {
        globalThis.prompt = previousPrompt;
    }
});

test('Deleting a non-current book keeps the active book and conversation state intact', async () => {
    await resetDb();
    const first = await createBook('第一本');
    const second = await createBook('第二本');
    const state = {
        book: second,
        books: await listBooks(),
        files: await listBookFiles(second.id),
        selectedPath: 'book/outline.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'library',
        editorContent: '',
        savedContent: '',
        messages: [{ role: 'assistant', content: '第二本的当前对话' }],
        historySummary: '第二本的创作记录',
        isBusy: false,
        toast: '',
        isDeleteBookOpen: true,
    };
    const previousConfirm = globalThis.confirm;
    const restored = [];
    let cleared = 0;
    try {
        globalThis.confirm = () => true;
        const controller = createBookController({
            state,
            render() {},
            requestHost() {},
            showToast() {},
            conversationStore: {
                clearConversation() {
                    cleared += 1;
                },
                async restoreConversation(bookId) {
                    restored.push(bookId);
                },
            },
        });

        await controller.removeBook(first.id);

        assert.equal(await getBook(first.id), null);
        assert.equal(state.book?.id, second.id);
        assert.equal(await getSelectedBookId(), second.id);
        assert.equal(state.messages[0].content, '第二本的当前对话');
        assert.equal(state.historySummary, '第二本的创作记录');
        assert.equal(state.isDeleteBookOpen, false);
        assert.equal(cleared, 0);
        assert.deepEqual(restored, []);
    } finally {
        globalThis.confirm = previousConfirm;
    }
});

test('Deleting the current book selects another remaining book without recreating a default one', async () => {
    await resetDb();
    const first = await createBook('第一本');
    const second = await createBook('第二本');
    await setSelectedBookId(first.id);
    const state = {
        book: first,
        books: await listBooks(),
        files: await listBookFiles(first.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'library',
        editorContent: '',
        savedContent: '',
        isBusy: false,
        toast: '',
        isDeleteBookOpen: true,
    };
    const previousConfirm = globalThis.confirm;
    const restored = [];
    const toasts = [];
    let cleared = 0;
    try {
        globalThis.confirm = () => true;
        const controller = createBookController({
            state,
            render() {},
            requestHost() {},
            showToast(message) {
                toasts.push(message);
            },
            conversationStore: {
                clearConversation() {
                    cleared += 1;
                },
                async restoreConversation(bookId) {
                    restored.push(bookId);
                },
            },
        });

        await controller.removeBook(first.id);

        assert.equal(await getBook(first.id), null);
        assert.equal(state.book?.id, second.id);
        assert.equal(await getSelectedBookId(), second.id);
        assert.equal(state.viewMode, 'library');
        assert.equal(state.isDeleteBookOpen, false);
        assert.equal(cleared, 0);
        assert.deepEqual(restored, [second.id]);
        assert.equal(toasts.at(-1), '书籍已删除');
    } finally {
        globalThis.confirm = previousConfirm;
    }
});

test('Deleting the last book leaves the shelf empty instead of recreating a default book', async () => {
    await resetDb();
    const book = await createBook('最后一本');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'library',
        editorContent: '',
        savedContent: '',
        isBusy: false,
        toast: '',
        isDeleteBookOpen: true,
    };
    const previousConfirm = globalThis.confirm;
    const restored = [];
    try {
        globalThis.confirm = () => true;
        const controller = createBookController({
            state,
            render() {},
            requestHost() {},
            showToast() {},
            conversationStore: {
                async restoreConversation(bookId) {
                    restored.push(bookId);
                },
            },
        });

        await controller.removeBook(book.id);

        assert.deepEqual(await listBooks(), []);
        assert.equal(await getSelectedBookId(), '');
        assert.equal(state.book, null);
        assert.deepEqual(state.books, []);
        assert.deepEqual(state.files, []);
        assert.equal(state.selectedPath, '');
        assert.equal(state.readerPath, '');
        assert.equal(state.viewMode, 'library');
        assert.equal(state.isDeleteBookOpen, false);
        assert.deepEqual(restored, ['']);

        await controller.refreshBooksAndFiles();

        assert.deepEqual(await listBooks(), []);
        assert.equal(state.book, null);
    } finally {
        globalThis.confirm = previousConfirm;
    }
});

test('Initializing on an empty database keeps the shelf empty', async () => {
    await resetDb();
    const state = {
        book: null,
        books: [],
        files: [{ path: 'book/outline.md', content: '旧内容' }],
        selectedPath: 'book/outline.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'library',
        editorContent: '旧内容',
        savedContent: '旧内容',
        isBusy: false,
        toast: '',
        isDeleteBookOpen: true,
    };
    const restored = [];
    const controller = createBookController({
        state,
        render() {},
        requestHost() {},
        showToast() {},
        conversationStore: {
            async restoreConversation(bookId) {
                restored.push(bookId);
            },
        },
    });

    await controller.initializeBook();

    assert.deepEqual(await listBooks(), []);
    assert.equal(state.book, null);
    assert.deepEqual(state.books, []);
    assert.deepEqual(state.files, []);
    assert.equal(state.selectedPath, '');
    assert.equal(state.readerPath, '');
    assert.equal(state.editorContent, '');
    assert.equal(state.savedContent, '');
    assert.equal(state.isDeleteBookOpen, false);
    assert.deepEqual(restored, [undefined]);
});

test('Deleting a book removes persisted conversation rows and stale selection metadata', async () => {
    await resetDb();
    const book = await createBook('删除会话测试');
    const state = {
        book,
        messages: [
            { role: 'user', content: '写第一章' },
            { role: 'assistant', content: '已经起草。' },
        ],
        toolTrace: [],
        openToolTurnKeys: [],
        openThoughtKeys: [],
        editingMessageIndex: -1,
        messageActionFeedback: {},
        historySummary: '删除前的摘要',
        archivedTurnCount: 0,
    };
    const store = createEbookConversationStore({ state });

    await store.persistConversation(book.id);
    await deleteBook(book.id);

    assert.equal(await ebookSessionsTable.get(book.id), undefined);
    assert.equal(await ebookMessagesTable.where('bookId').equals(book.id).count(), 0);
    assert.equal(await getSelectedBookId(), '');
});

test('Book tool runtime can rename the current book', async () => {
    await resetDb();
    const book = await createBook('旧书名');
    let filesChanged = 0;
    const runtime = createBookToolRuntime({
        bookId: book.id,
        onFilesChanged() {
            filesChanged += 1;
        },
    });

    const result = await runtime.execute(EBOOK_TOOL_NAMES.RENAME_BOOK, { title: ' 新标题 ' });

    assert.equal(result.ok, true);
    assert.equal(result.title, '新标题');
    assert.equal((await getBook(book.id)).title, '新标题');
    assert.equal(filesChanged, 1);
});

test('Book conversation history is restored per book', async () => {
    await resetDb();
    const first = await createBook('第一本');
    const second = await createBook('第二本');
    const state = {
        book: first,
        messages: [
            { role: 'user', content: '写第一章开头' },
            { role: 'assistant', content: '已经写入 book/chapters/001.md' },
        ],
        toolTrace: [{ name: 'Read' }],
        openToolTurnKeys: ['tool-turn:call-read'],
        openThoughtKeys: ['thought-message:1'],
        editingMessageIndex: 1,
        messageActionFeedback: { 'copy:1': 'success' },
        historySummary: '第一本的创作记录',
        archivedTurnCount: 0,
    };
    const store = createEbookConversationStore({ state });

    await store.persistConversation(first.id);
    state.book = second;
    await store.restoreConversation(second.id);
    assert.equal(state.messages.length, 0);
    assert.equal(state.historySummary, '');
    assert.equal(state.toolTrace.length, 0);
    assert.deepEqual(state.openToolTurnKeys, []);
    assert.deepEqual(state.openThoughtKeys, []);
    assert.equal(state.editingMessageIndex, -1);
    assert.deepEqual(state.messageActionFeedback, {});

    state.book = first;
    await store.restoreConversation(first.id);
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0].content, '写第一章开头');
    assert.equal(state.historySummary, '第一本的创作记录');
    assert.equal(state.toolTrace.length, 0);
    assert.deepEqual(state.openToolTurnKeys, []);
    assert.deepEqual(state.openThoughtKeys, []);
    assert.equal(state.editingMessageIndex, -1);
    assert.deepEqual(state.messageActionFeedback, {});
});

test('Book conversation preserves tool context separately from UI folding', async () => {
    await resetDb();
    const book = await createBook('工具上下文测试');
    const state = {
        book,
        messages: [
            { role: 'user', content: '读取第一章并修订。' },
            {
                role: 'assistant',
                content: '',
                thoughts: [{ label: '思考块', text: '先读取第一章。' }],
                toolCalls: [{
                    id: 'call-read',
                    name: EBOOK_TOOL_NAMES.READ,
                    arguments: '{"filePath":"book/chapters/001.md"}',
                }],
            },
            {
                role: 'tool',
                toolCallId: 'call-read',
                toolName: EBOOK_TOOL_NAMES.READ,
                content: '{"ok":true,"content":"1: # 第 1 章"}',
            },
            { role: 'assistant', content: '已读取第一章，准备修订。' },
        ],
        toolTrace: [{ name: 'Read' }],
        historySummary: '',
        archivedTurnCount: 0,
    };
    const store = createEbookConversationStore({ state });

    await store.persistConversation(book.id);
    state.messages = [];
    state.toolTrace = [];
    await store.restoreConversation(book.id);

    assert.equal(state.messages.length, 4);
    assert.equal(state.messages[1].thoughts[0].text, '先读取第一章。');
    assert.equal(state.messages[1].toolCalls[0].name, EBOOK_TOOL_NAMES.READ);
    assert.equal(state.messages[2].role, 'tool');
    assert.equal(state.messages[2].toolCallId, 'call-read');

    const providerMessages = buildEbookProviderMessagesFromHistory(state.messages);
    assert.equal(providerMessages[1].tool_calls[0].function.name, EBOOK_TOOL_NAMES.READ);
    assert.equal(providerMessages[2].role, 'tool');
    assert.equal(providerMessages[2].tool_call_id, 'call-read');
});

test('Book renderer shows thoughts while keeping tool batches folded', async () => {
    await resetDb();
    const book = await createBook('渲染思考测试');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [
            { role: 'user', content: '审一下第一章。' },
            {
                role: 'assistant',
                content: '',
                thoughts: [{ label: '思考块', text: '先查大纲和正文。' }],
                toolCalls: [{
                    id: 'call-read',
                    name: EBOOK_TOOL_NAMES.READ,
                    arguments: '{"filePath":"book/chapters/001.md"}',
                }],
            },
            {
                role: 'tool',
                toolCallId: 'call-read',
                toolName: EBOOK_TOOL_NAMES.READ,
                content: '{"ok":true,"summary":"读取第一章。"}',
            },
            {
                role: 'assistant',
                content: '第一章节奏正常。',
                thoughts: [{ label: '推理摘要', text: '结论来自正文和大纲。' }],
            },
        ],
        toolTrace: [],
        openToolTurnKeys: ['tool-turn:call-read'],
        openThoughtKeys: ['tool-turn:call-read:thought:1', 'thought-message:3'],
        historySummary: '',
        isBusy: false,
        status: '就绪',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        providerLabel: '测试',
        dirty: false,
    });

    assert.match(html, /已创作 1 轮/);
    assert.match(html, /<details class="xb-tool-trace xb-tool-turn" data-tool-turn-key="tool-turn:call-read" open>/);
    assert.match(html, /data-thought-key="tool-turn:call-read:thought:1" open/);
    assert.match(html, /data-thought-key="thought-message:3" open/);
    assert.match(html, /data-message-action="copy" data-message-index="3"/);
    assert.match(html, /data-message-action="edit" data-message-index="3"/);
    assert.match(html, /data-message-action="reroll" data-message-index="3"/);
    assert.match(html, /data-message-action="delete" data-message-index="3"/);
    assert.match(html, /展开思考块/);
    assert.match(html, /先查大纲和正文/);
    assert.match(html, /第一章节奏正常/);
});

test('Book renderer keeps the active tool turn expanded while the run is still in progress', async () => {
    await resetDb();
    const book = await createBook('运行中展开测试');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [
            { role: 'user', content: '继续检查第一章。' },
            {
                role: 'assistant',
                content: '',
                thoughts: [{ label: '思考块', text: '先读取正文。' }],
                toolCalls: [{
                    id: 'call-read-live',
                    name: EBOOK_TOOL_NAMES.READ,
                    arguments: '{"filePath":"book/chapters/001.md"}',
                }],
            },
            {
                role: 'tool',
                toolCallId: 'call-read-live',
                toolName: EBOOK_TOOL_NAMES.READ,
                content: '{"ok":true,"summary":"读取第一章。"}',
            },
        ],
        toolTrace: [{
            round: 1,
            ok: true,
            title: '读取第一章',
            name: EBOOK_TOOL_NAMES.READ,
            summary: '读取第一章。',
        }],
        openToolTurnKeys: [],
        activeTurnStartIndex: 0,
        openThoughtKeys: [],
        historySummary: '',
        isBusy: true,
        status: 'AI 正在处理工具结果（1/48）...',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        providerLabel: '测试',
        dirty: false,
    });

    assert.match(html, /<details class="xb-tool-trace xb-tool-turn" data-tool-turn-key="tool-turn:call-read-live" data-auto-open-tool-turn="true" open>/);
    assert.match(html, /xb-tool-turn-live/);
    assert.match(html, /正在创作 1 轮/);
    assert.doesNotMatch(html, /<details class="xb-tool-trace" open>/);
    assert.ok(
        html.indexOf('xb-agent-log') < html.indexOf('xb-tool-turn-live'),
        'live tool turn should render inside the chat log',
    );
    assert.match(html, /读取第一章/);
});

test('Book renderer folds the active tool turn after the final assistant message is delivered', async () => {
    await resetDb();
    const book = await createBook('交付后折叠测试');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [
            { role: 'user', content: '继续检查第一章。' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{
                    id: 'call-read-done',
                    name: EBOOK_TOOL_NAMES.READ,
                    arguments: '{"filePath":"book/chapters/001.md"}',
                }],
            },
            {
                role: 'tool',
                toolCallId: 'call-read-done',
                toolName: EBOOK_TOOL_NAMES.READ,
                content: '{"ok":true,"summary":"读取第一章。"}',
            },
            { role: 'assistant', content: '检查完成。' },
        ],
        toolTrace: [],
        openToolTurnKeys: [],
        activeTurnStartIndex: -1,
        openThoughtKeys: [],
        historySummary: '',
        isBusy: false,
        status: '就绪',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        providerLabel: '测试',
        dirty: false,
    });

    assert.match(html, /data-tool-turn-key="tool-turn:call-read-done"/);
    assert.doesNotMatch(html, /data-tool-turn-key="tool-turn:call-read-done"[^>]* open/);
    assert.doesNotMatch(html, /data-auto-open-tool-turn/);
});

test('Book tool turn auto-open does not persist as a manual fold state', () => {
    const state = {
        isBusy: true,
        openToolTurnKeys: [],
    };
    const details = {
        dataset: {
            toolTurnKey: 'tool-turn:call-read-live',
            autoOpenToolTurn: 'true',
        },
        open: true,
        addEventListener(_eventName, handler) {
            this.handler = handler;
        },
    };
    const root = {
        querySelectorAll(selector) {
            return selector === '.xb-tool-turn[data-tool-turn-key]' ? [details] : [];
        },
        querySelector() {
            return null;
        },
    };

    bindEbookEvents({
        root,
        state,
        render() {},
        postToHost() {},
        bookController: {},
        agentRunner: {},
        persistConversation() {},
        clearConversation() {},
        showToast() {},
    });

    details.handler();

    assert.deepEqual(state.openToolTurnKeys, []);
});

test('Book thought auto-open does not persist as a manual fold state', () => {
    const state = {
        isBusy: true,
        openThoughtKeys: [],
    };
    const details = {
        dataset: {
            thoughtKey: 'thought-message:live',
            autoOpenThought: 'true',
        },
        open: true,
        addEventListener(_eventName, handler) {
            this.handler = handler;
        },
    };
    const root = {
        querySelectorAll(selector) {
            return selector === '.xb-thought-details[data-thought-key]' ? [details] : [];
        },
        querySelector() {
            return null;
        },
    };

    bindEbookEvents({
        root,
        state,
        render() {},
        postToHost() {},
        bookController: {},
        agentRunner: {},
        persistConversation() {},
        clearConversation() {},
        showToast() {},
    });

    details.handler();

    assert.deepEqual(state.openThoughtKeys, []);
});

test('Book renderer keeps streaming assistant thoughts expanded before final delivery', async () => {
    await resetDb();
    const book = await createBook('流式思考展开测试');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [
            { role: 'user', content: '继续。' },
            {
                role: 'assistant',
                content: '正在整理结论...',
                thoughts: [{ label: '思考块', text: '先判断这一段怎么收。' }],
                streaming: true,
            },
        ],
        toolTrace: [],
        openToolTurnKeys: [],
        activeTurnStartIndex: 0,
        openThoughtKeys: [],
        historySummary: '',
        isBusy: true,
        status: 'AI 正在思考...',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        providerLabel: '测试',
        dirty: false,
    });

    assert.match(html, /<details class="xb-thought-details" data-thought-key="thought-message:1" data-auto-open-thought="true" open>/);
});

test('Book renderer keeps the active conversation window visible before compaction', async () => {
    await resetDb();
    const book = await createBook('聊天显示窗口测试');
    const messages = Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `第 ${index + 1} 条创作对话`,
    }));
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages,
        toolTrace: [],
        openToolTurnKeys: [],
        historySummary: '',
        isBusy: false,
        status: '就绪',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        providerLabel: '测试',
        dirty: false,
    });

    assert.match(html, /第 1 条创作对话/);
    assert.match(html, /第 10 条创作对话/);
});

test('Book renderer keeps assistant actions on error bubbles so failed turns can reroll', async () => {
    await resetDb();
    const book = await createBook('失败气泡操作测试');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/outline.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [
            {
                role: 'user',
                content: '继续写第一章',
            },
            {
                role: 'assistant',
                content: 'AI 操作失败：Connection error.',
                error: true,
            },
        ],
        toolTrace: [],
        openToolTurnKeys: [],
        openThoughtKeys: [],
        historySummary: '',
        isBusy: false,
        status: '就绪',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        providerLabel: '测试',
        dirty: false,
    });

    assert.match(html, /AI 操作失败：Connection error\./);
    assert.match(html, /data-message-action="copy" data-message-index="1"/);
    assert.match(html, /data-message-action="edit" data-message-index="1"/);
    assert.match(html, /data-message-action="reroll" data-message-index="1"/);
    assert.match(html, /data-message-action="delete" data-message-index="1"/);
});

test('Book message actions handle error bubbles instead of dropping the click', async () => {
    const state = {
        book: { id: 'book-error-action' },
        isBusy: false,
        messages: [
            { role: 'user', content: '继续写第一章' },
            {
                role: 'assistant',
                content: 'AI 操作失败：Connection error.',
                error: true,
            },
        ],
    };
    const button = {
        dataset: {
            messageAction: 'reroll',
            messageIndex: '1',
        },
        addEventListener(_eventName, handler) {
            this.handler = handler;
        },
    };
    const root = {
        querySelectorAll(selector) {
            return selector === '[data-message-action][data-message-index]' ? [button] : [];
        },
        querySelector() {
            return null;
        },
    };
    let rerunIndex = -1;

    bindEbookEvents({
        root,
        state,
        render() {},
        postToHost() {},
        bookController: {},
        agentRunner: {
            async rerunFromMessageIndex(messageIndex) {
                rerunIndex = messageIndex;
                return { ok: true };
            },
            cancelActiveRun() {},
            runAgent() {},
        },
        persistConversation() {},
        clearConversation() {},
        showToast() {},
    });

    await button.handler();

    assert.equal(rerunIndex, 1);
});

test('Book renderer uses a compact agent toolbar with shared config actions', async () => {
    await resetDb();
    const book = await createBook('顶部工具条测试');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [
            { role: 'user', content: '请继续写第一章。' },
            { role: 'assistant', content: '我先检查一下大纲和章节内容。' },
        ],
        toolTrace: [],
        openToolTurnKeys: [],
        openThoughtKeys: [],
        historySummary: '已整理较早创作记录。',
        isBusy: false,
        status: '就绪',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        dirty: false,
    });

    assert.match(html, /class="xb-agent-context-meter" title="当前实际送模上下文 \/ 188k（已整理较早创作记录）"/);
    assert.match(html, /id="xb-agent-clear"/);
    assert.match(html, /id="xb-agent-open-settings"/);
    assert.match(html, /id="xb-agent-close"/);
    assert.match(html, /\/188k/);
    assert.doesNotMatch(html, /模型：/);
    assert.doesNotMatch(html, /创作对话：约/);
});

test('Ebook settings open as an in-app shared config panel instead of jumping to assistant window', async () => {
    await resetDb();
    const book = await createBook('配置面板测试');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [],
        toolTrace: [],
        openToolTurnKeys: [],
        openThoughtKeys: [],
        historySummary: '',
        isBusy: false,
        isSettingsOpen: true,
        config: {
            currentPresetName: '默认',
            presetNames: ['默认'],
        },
        configSave: {
            status: 'idle',
            requestId: '',
            error: '',
        },
        status: '就绪',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'openai-compatible', model: '' },
        dirty: false,
    });

    assert.match(html, /id="xb-agent-settings-overlay"/);
    assert.match(html, /id="xb-agent-settings-title">API配置<\/h2>/);
    assert.match(html, /主助手 API/);
    assert.match(html, /分身 API/);
    assert.match(html, /id="xb-assistant-preset-select"/);
    assert.match(html, /id="xb-assistant-provider"/);
    assert.match(html, /id="xb-assistant-delegate-preset-select"/);
    assert.match(html, /id="xb-assistant-delegate-provider"/);
    assert.match(html, /id="xb-assistant-delegate-base-url"/);
    assert.match(html, /id="xb-assistant-delegate-model"/);
    assert.match(html, /id="xb-assistant-delegate-tool-mode"/);
    assert.match(html, /id="xb-assistant-delegate-pull-models"/);
    assert.match(html, /id="xb-assistant-save"/);
    assert.doesNotMatch(html, /斜杠命令权限/);
    assert.doesNotMatch(html, /JavaScript API 权限/);
    assert.doesNotMatch(html, /先到小白助手配置当前模型预设/);
    assert.doesNotMatch(html, /请先到小白助手补好/);
});

test('Book renderer reuses assistant markdown rendering for tables', async () => {
    await resetDb();
    const book = await createBook('Markdown 对齐测试');
    const previousShowdown = globalThis.showdown;
    const previousDOMPurify = globalThis.DOMPurify;
    globalThis.showdown = {
        Converter: class {
            makeHtml(text) {
                if (String(text).includes('| 列1 | 列2 |')) {
                    return '<table><thead><tr><th>列1</th><th>列2</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>';
                }
                return `<p>${String(text)}</p>`;
            }
        },
    };
    globalThis.DOMPurify = {
        sanitize(html) {
            return html;
        },
    };

    try {
        const state = {
            book,
            books: [book],
            files: await listBookFiles(book.id),
            selectedPath: 'book/chapters/001.md',
            readerPath: '',
            viewMode: 'studio',
            editorContent: '',
            savedContent: '',
            messages: [
                {
                    role: 'assistant',
                    content: '| 列1 | 列2 |\n| --- | --- |\n| A | B |',
                },
            ],
            toolTrace: [],
            openToolTurnKeys: [],
            openThoughtKeys: [],
            historySummary: '',
            isBusy: false,
            status: '就绪',
            toast: '',
        };

        const html = renderEbookShell({
            state,
            providerConfig: { provider: 'test', model: 'demo' },
            dirty: false,
        });

        assert.match(html, /<table>/);
        assert.match(html, /<th>列1<\/th>/);
        assert.match(html, /xb-assistant-markdown/);
    } finally {
        globalThis.showdown = previousShowdown;
        globalThis.DOMPurify = previousDOMPurify;
    }
});

test('Shared markdown renderer does not mount raw HTML directly', () => {
    const previousShowdown = globalThis.showdown;
    const previousDOMPurify = globalThis.DOMPurify;
    globalThis.showdown = {
        Converter: class {
            makeHtml(text) {
                return `<p>${String(text)}</p>`;
            }
        },
    };
    globalThis.DOMPurify = {
        sanitize(html) {
            return html;
        },
    };

    try {
        const html = renderMarkdownToHtml('<div class="demo">Hello</div>');
        assert.doesNotMatch(html, /<div class="demo">Hello<\/div>/);
        assert.match(html, /&lt;div class="demo"&gt;Hello&lt;\/div&gt;/);
    } finally {
        globalThis.showdown = previousShowdown;
        globalThis.DOMPurify = previousDOMPurify;
    }
});

test('Shared markdown renderer folds fenced HTML into a lightweight placeholder', () => {
    const previousShowdown = globalThis.showdown;
    const previousDOMPurify = globalThis.DOMPurify;
    globalThis.showdown = {
        Converter: class {
            makeHtml(text) {
                return `<p>${String(text)}</p>`;
            }
        },
    };
    globalThis.DOMPurify = {
        sanitize(html) {
            return html;
        },
    };

    try {
        const html = renderMarkdownToHtml([
            '```html',
            '<main><h1>Heavy UI</h1><section>...</section></main>',
            '```',
        ].join('\n'));
        assert.match(html, /xb-markdown-html-placeholder/);
        assert.doesNotMatch(html, /<main>/);
        assert.doesNotMatch(html, /Heavy UI/);
    } finally {
        globalThis.showdown = previousShowdown;
        globalThis.DOMPurify = previousDOMPurify;
    }
});

test('Shared HTML preview sandbox allows scripts while staying isolated from the host', () => {
    assert.equal(HTML_PREVIEW_SANDBOX, 'allow-scripts');
});

test('HTML preview placeholders stay in UI only and do not alter stored conversation text', async () => {
    await resetDb();
    const book = await createBook('HTML 上下文边界测试');
    const originalContent = [
        '```html',
        '<main><h1>Hello</h1><script>console.log("preview")</script></main>',
        '```',
    ].join('\n');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [
            {
                role: 'assistant',
                content: originalContent,
            },
        ],
        toolTrace: [],
        openToolTurnKeys: [],
        openThoughtKeys: [],
        historySummary: '',
        isBusy: false,
        status: '就绪',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        dirty: false,
    });
    assert.match(html, /xb-markdown-html-placeholder/);
    assert.equal(state.messages[0].content, originalContent);

    const store = createEbookConversationStore({ state });
    await store.persistConversation(book.id);
    state.messages = [];
    await store.restoreConversation(book.id);
    assert.equal(state.messages[0].content, originalContent);

    const providerMessages = buildEbookProviderMessagesFromHistory(state.messages);
    assert.equal(providerMessages[0].content, originalContent);
});

test('Book agent stores a multi-tool batch only after all tool results exist', async () => {
    await resetDb();
    const book = await createBook('工具批次测试');
    const state = {
        config: {},
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [],
        toolTrace: [],
        historySummary: '',
        archivedTurnCount: 0,
        isBusy: false,
        activeController: null,
        status: '就绪',
        toast: '',
    };
    let round = 0;
    let persisted = 0;
    let sawUnsafePartialHistory = false;
    const runner = createEbookAgentRunner({
        state,
        async refreshBooksAndFiles() {
            state.files = await listBookFiles(book.id);
        },
        render() {
            if (
                state.toolTrace.length === 1
                && state.messages.some((message) => Array.isArray(message.toolCalls) && message.toolCalls.length)
            ) {
                sawUnsafePartialHistory = true;
            }
        },
        showToast() {},
        persistConversation() {
            persisted += 1;
        },
        isEditorDirty() {
            return false;
        },
        getActiveProviderConfig() {
            return {
                provider: 'test',
                temperature: 0.2,
                maxTokens: 1000,
                reasoningEnabled: false,
                reasoningEffort: 'medium',
            };
        },
        createAdapter() {
            return {
                async chat(task) {
                    round += 1;
                    if (round === 1) {
                        return {
                            text: '',
                            thoughts: [{ label: '思考块', text: '同时读取两个文件。' }],
                            toolCalls: [
                                {
                                    id: 'call-read-1',
                                    name: EBOOK_TOOL_NAMES.READ,
                                    arguments: '{"filePath":"book/outline.md","limit":2}',
                                },
                                {
                                    id: 'call-read-2',
                                    name: EBOOK_TOOL_NAMES.READ,
                                    arguments: '{"filePath":"book/chapters/001.md","limit":2}',
                                },
                            ],
                        };
                    }
                    assert.equal(task.messages.filter((message) => message.role === 'tool').length, 2);
                    return {
                        text: '两个读取都完成。',
                        toolCalls: [],
                    };
                },
            };
        },
    });

    await runner.runAgent('同时读取大纲和第一章。');

    assert.equal(sawUnsafePartialHistory, false);
    assert.equal(persisted >= 2, true);
    assert.deepEqual(state.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'tool', 'assistant']);
    assert.equal(state.messages[1].toolCalls.length, 2);
    assert.equal(state.messages[1].thoughts[0].text, '同时读取两个文件。');
    assert.equal(state.messages.filter((message) => message.role === 'tool').length, 2);
    assert.equal(state.toolTrace.length, 0);
    assert.equal(state.activeTurnStartIndex, -1);
});

test('Book agent uses Google-style session tool loop without rebuilding replay history', async () => {
    await resetDb();
    const book = await createBook('Google 会话工具测试');
    const state = {
        config: {},
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [],
        toolTrace: [],
        openToolTurnKeys: [],
        historySummary: '',
        archivedTurnCount: 0,
        isBusy: false,
        activeController: null,
        status: '就绪',
        toast: '',
    };
    let round = 0;
    const seenTasks = [];
    const runner = createEbookAgentRunner({
        state,
        async refreshBooksAndFiles() {
            state.files = await listBookFiles(book.id);
        },
        render() {},
        showToast() {},
        persistConversation() {},
        isEditorDirty() {
            return false;
        },
        getActiveProviderConfig() {
            return {
                provider: 'google',
                temperature: 0.2,
                maxTokens: 1000,
                reasoningEnabled: true,
                reasoningEffort: 'medium',
            };
        },
        createAdapter() {
            return {
                supportsSessionToolLoop: true,
                async chat(task) {
                    seenTasks.push(task);
                    round += 1;
                    if (round === 1) {
                        task.onStreamProgress?.({
                            thoughts: [{ label: '思考块', text: '先读大纲。' }],
                        });
                        return {
                            text: '',
                            provider: 'google',
                            providerPayload: {
                                googleContent: {
                                    role: 'model',
                                    parts: [{
                                        functionCall: {
                                            id: 'google-read-outline',
                                            name: EBOOK_TOOL_NAMES.READ,
                                            args: {
                                                filePath: 'book/outline.md',
                                                limit: 2,
                                            },
                                        },
                                    }],
                                },
                            },
                        };
                    }
                    if (round === 2) {
                        assert.equal(Object.hasOwn(task, 'messages'), false);
                        assert.deepEqual(task.toolResponses.map((item) => ({
                            id: item.id,
                            name: item.name,
                            ok: item.response.ok,
                        })), [{
                            id: 'google-read-outline',
                            name: EBOOK_TOOL_NAMES.READ,
                            ok: true,
                        }]);
                        return {
                            text: '',
                            toolCalls: [],
                        };
                    }
                    assert.equal(Object.hasOwn(task, 'messages'), false);
                    assert.match(task.finalAnswerReminderText, /直接给出电纸书操作结论/);
                    return {
                        text: '已经读取大纲并整合。',
                        thoughts: [
                            { label: '思考块', text: '先读大纲。' },
                            { label: '推理摘要', text: '大纲可用。' },
                        ],
                        toolCalls: [],
                        provider: 'google',
                    };
                },
            };
        },
    });

    await runner.runAgent('读取大纲后给我结论。');

    assert.equal(seenTasks.length, 3);
    assert.deepEqual(state.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(state.messages[1].toolCalls[0].id, 'google-read-outline');
    assert.equal(state.messages[1].thoughts.length, 1);
    assert.equal(state.messages[3].thoughts.length, 1);
    assert.equal(state.messages[3].thoughts[0].text, '大纲可用。');
    assert.equal(state.toolTrace.length, 0);
});

test('Book agent keeps streamed thoughts in the final assistant message', async () => {
    await resetDb();
    const book = await createBook('流式思考测试');
    const state = {
        config: {},
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [],
        toolTrace: [],
        historySummary: '',
        archivedTurnCount: 0,
        isBusy: false,
        activeController: null,
        status: '就绪',
        toast: '',
    };
    const runner = createEbookAgentRunner({
        state,
        async refreshBooksAndFiles() {
            state.files = await listBookFiles(book.id);
        },
        render() {},
        showToast() {},
        persistConversation() {},
        isEditorDirty() {
            return false;
        },
        getActiveProviderConfig() {
            return {
                provider: 'test',
                temperature: 0.2,
                maxTokens: 1000,
                reasoningEnabled: false,
                reasoningEffort: 'medium',
            };
        },
        createAdapter() {
            return {
                async chat(task) {
                    task.onStreamProgress?.({
                        text: '正在整理结论...',
                        thoughts: [{ label: '思考块', text: '先判断是否需要工具。' }],
                    });
                    return {
                        text: '可以直接回答。',
                        thoughts: [{ label: '推理摘要', text: '无需读取文件。' }],
                        toolCalls: [],
                    };
                },
            };
        },
    });

    await runner.runAgent('简单判断一下。');

    assert.deepEqual(state.messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(state.messages[1].streaming, false);
    assert.equal(state.messages[1].thoughts.length, 2);
    assert.equal(state.messages[1].thoughts[0].text, '先判断是否需要工具。');
    assert.equal(state.messages[1].thoughts[1].text, '无需读取文件。');
    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        providerLabel: '测试',
        dirty: false,
    });
    assert.match(html, /data-thought-key="thought-message:1"/);
    assert.doesNotMatch(html, /data-thought-key="thought-message:1"[^>]* open/);
});

test('Book agent reroll trims to the previous user message without duplicating it', async () => {
    await resetDb();
    const book = await createBook('重生成测试');
    const state = {
        config: {},
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '',
        savedContent: '',
        messages: [
            { role: 'user', content: '重写第一章。' },
            { role: 'assistant', content: '旧版本。' },
        ],
        toolTrace: [],
        openToolTurnKeys: [],
        openThoughtKeys: [],
        historySummary: '',
        archivedTurnCount: 0,
        isBusy: false,
        activeController: null,
        status: '就绪',
        toast: '',
    };
    let requestMessages = [];
    const runner = createEbookAgentRunner({
        state,
        async refreshBooksAndFiles() {
            state.files = await listBookFiles(book.id);
        },
        render() {},
        showToast() {},
        persistConversation() {},
        isEditorDirty() {
            return false;
        },
        getActiveProviderConfig() {
            return {
                provider: 'test',
                temperature: 0.2,
                maxTokens: 1000,
                reasoningEnabled: false,
                reasoningEffort: 'medium',
            };
        },
        createAdapter() {
            return {
                async chat(task) {
                    requestMessages = task.messages;
                    return {
                        text: '新版本。',
                        toolCalls: [],
                    };
                },
            };
        },
    });

    const result = await runner.rerunFromMessageIndex(1);

    assert.equal(result.ok, true);
    assert.deepEqual(state.messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(state.messages[0].content, '重写第一章。');
    assert.equal(state.messages[1].content, '新版本。');
    assert.equal(requestMessages.filter((message) => message.role === 'user' && message.content === '重写第一章。').length, 1);
});

test('Book history compaction writes creative record and releases archived turns', async () => {
    assert.match(EBOOK_SUMMARY_SYSTEM_PROMPT, /创作记录/);
    assert.match(EBOOK_SUMMARY_SYSTEM_PROMPT, /不超过 10000 tokens/);

    const state = {
        messages: [
            { role: 'user', content: '设定女主叫林栖。' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{
                    id: 'call-read-settings',
                    name: EBOOK_TOOL_NAMES.READ,
                    arguments: '{"filePath":"book/characters.md"}',
                }],
            },
            {
                role: 'tool',
                toolCallId: 'call-read-settings',
                toolName: EBOOK_TOOL_NAMES.READ,
                content: '{"ok":true,"content":"1: # 角色设定"}',
            },
            { role: 'assistant', content: '已记录林栖。' },
            { role: 'user', content: '继续写下一章。' },
            { role: 'assistant', content: '已写到 book/chapters/002.md。' },
        ],
        historySummary: '旧记录：男主叫沈照。',
        status: '就绪',
        archivedTurnCount: 0,
    };
    let persisted = false;
    let summarySource = '';
    const controller = createEbookHistoryCompactionController({
        state,
        render() {},
        showToast() {},
        persistConversation() {
            persisted = true;
        },
        getActiveProviderConfig() {
            return { temperature: 0.7, maxTokens: 12000 };
        },
        buildProviderMessages() {
            return [{ role: 'system', content: state.historySummary }, ...state.messages];
        },
        summaryTriggerTokens: 1,
        defaultPreservedTurns: 1,
        minPreservedTurns: 1,
    });

    await controller.ensureContextBudget({
        async chat(request) {
            summarySource = request.messages[0].content;
            assert.equal(request.maxTokens, 10000);
            assert.match(summarySource, /工具调用: Read/);
            assert.match(summarySource, /工具结果: Read/);
            return { text: '创作记录：沈照与林栖；下一章已写到 book/chapters/002.md。' };
        },
    }, new AbortController().signal);

    assert.equal(persisted, true);
    assert.match(summarySource, /已有创作记录/);
    assert.match(summarySource, /林栖/);
    assert.match(state.historySummary, /沈照与林栖/);
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0].content, '继续写下一章。');
});

test('Book prompt keeps assistant-style tool layers and recovery rules', () => {
    assert.match(EBOOK_SYSTEM_PROMPT, /# 工具使用指导/);
    assert.match(EBOOK_SYSTEM_PROMPT, /## 工具层级/);
    assert.match(EBOOK_SYSTEM_PROMPT, /## 选择策略/);
    assert.match(EBOOK_SYSTEM_PROMPT, /工具返回错误时/);
    assert.match(EBOOK_SYSTEM_PROMPT, /RenameBook/);
    assert.match(EBOOK_SYSTEM_PROMPT, /DelegateRun/);
    assert.doesNotMatch(EBOOK_SYSTEM_PROMPT, /不要尝试 `local/);
    assert.doesNotMatch(EBOOK_SYSTEM_PROMPT, /插件源码|JS API|斜杠命令/);

    const delegateDefinition = getEbookToolDefinitions()
        .find((definition) => definition.function?.name === EBOOK_TOOL_NAMES.DELEGATE_RUN);
    assert.match(String(delegateDefinition.function.description), /任务、背景和交付要求/);
    assert.doesNotMatch(String(delegateDefinition.function.description), /task\/context\/deliverable/i);

    const planCreate = getEbookToolDefinitions()
        .find((definition) => definition.function?.name === EBOOK_TOOL_NAMES.PLAN_CREATE);
    assert.equal(planCreate.function.parameters.properties.blockedBy.type, 'array');
});
