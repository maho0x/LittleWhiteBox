import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dbModule = await import('../shared/ebook-db.js');
const toolsModule = await import('../shared/book-tools.js');
const bookTemplatesModule = await import('../shared/book-templates.js');
const controllerModule = await import('../app-src/book-controller.js');
const conversationStoreModule = await import('../app-src/conversation-store.js');
const compactionModule = await import('../app-src/history-compaction.js');
const promptsModule = await import('../app-src/prompts.js');
const agentRunnerModule = await import('../app-src/agent-runner.js');
const ebookAppModule = await import('../app-src/ebook-app.js');
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
const { DEFAULT_BOOK_FILES } = bookTemplatesModule;
const { createBookController, formatDrawProgress } = controllerModule;
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
const { captureScrollState, restoreScrollState } = ebookAppModule;
const { countMessageWindowUnits, renderEbookShell } = rendererModule;
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

test('Book runtime exposes Tavily web search only when configured', async () => {
    await resetDb();
    const book = await createBook('联网资料测试');
    const runtimeWithoutSearch = createBookToolRuntime({ bookId: book.id });
    assert.equal(
        runtimeWithoutSearch.getToolDefinitions().some((definition) => definition.function?.name === EBOOK_TOOL_NAMES.WEB_SEARCH),
        false,
    );

    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({
            url: String(url),
            body: options.body,
        });
        return {
            ok: true,
            status: 200,
            async json() {
                return {
                    results: [
                        {
                            title: 'Kyoto Machiya Guide',
                            url: 'https://example.com/machiya',
                            content: 'Traditional machiya usually have a narrow frontage and deep plan.',
                            score: 0.91,
                        },
                    ],
                };
            },
        };
    };

    try {
        const runtime = createBookToolRuntime({
            bookId: book.id,
            searchConfig: {
                tavilyApiKey: 'ebook-tavily-key',
                tavilyBaseUrl: 'https://api.tavily.com/',
            },
        });
        assert.equal(
            runtime.getToolDefinitions().some((definition) => definition.function?.name === EBOOK_TOOL_NAMES.WEB_SEARCH),
            true,
        );

        const result = await runtime.execute(EBOOK_TOOL_NAMES.WEB_SEARCH, {
            query: 'Kyoto machiya layout',
            maxResults: 3,
        });

        assert.equal(result.ok, true);
        assert.equal(result.query, 'Kyoto machiya layout');
        assert.equal(result.count, 1);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'https://api.tavily.com/search');

        const requestBody = JSON.parse(requests[0].body);
        assert.equal(requestBody.api_key, 'ebook-tavily-key');
        assert.equal(requestBody.query, 'Kyoto machiya layout');
        assert.equal(requestBody.max_results, 3);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Book context budget defaults stay aligned with assistant', () => {
    assert.equal(EBOOK_MAX_CONTEXT_TOKENS, 188000);
    assert.equal(EBOOK_SUMMARY_TRIGGER_TOKENS, 158000);
    assert.equal(EBOOK_DEFAULT_PRESERVED_TURNS, 2);
    assert.equal(EBOOK_MIN_PRESERVED_TURNS, 1);
});

test('Default outline template pushes volume-level planning before chapter drafting', () => {
    const outline = DEFAULT_BOOK_FILES.find((file) => file.path === 'book/outline.md')?.content || '';

    assert.match(outline, /大纲推进原则/);
    assert.match(outline, /大概有几卷/);
    assert.match(outline, /当前卷必须有可执行的卷内细纲/);
    assert.match(outline, /卷内细纲制定好后，直接推进写完卷内章节/);
    assert.match(outline, /## 当前卷细纲/);
    assert.match(outline, /章节功能表/);
    assert.match(outline, /章末位移/);
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
    assert.match(EBOOK_DELEGATE_PROMPT, /\[ebook-image:slotId\]/);
    assert.match(EBOOK_DELEGATE_PROMPT, /\[审稿分身自动上下文\]/);
    assert.match(EBOOK_DELEGATE_PROMPT, /# 工具使用指导/);
    assert.match(EBOOK_DELEGATE_PROMPT, /不知道文件在哪时先 LS \/ Glob/);
    assert.match(EBOOK_DELEGATE_PROMPT, /审具体章节时，必须 Read/);
    assert.match(EBOOK_DELEGATE_PROMPT, /book\/review-rules\.md` 是本书的审稿标准/);
    assert.match(EBOOK_DELEGATE_PROMPT, /不要另起一套标准/);
    assert.match(EBOOK_DELEGATE_PROMPT, /审稿规则没有覆盖的地方/);
    assert.match(EBOOK_DELEGATE_PROMPT, /不能写文件、不能管理计划、不能委派其他分身/);
    assert.match(EBOOK_DELEGATE_PROMPT, /最终结果给主助手/);
    assert.doesNotMatch(EBOOK_DELEGATE_PROMPT, /web_search|Tavily|联网查资料/);
    assert.doesNotMatch(EBOOK_DELEGATE_PROMPT, /重点检查结构、人物动机、关系连续性、节奏、设定一致性、时间线、伏笔、视角和文风/);
});

test('Book action prompts rely on injected core story files', () => {
    const startBookPrompt = buildActionPrompt('start-book');
    const spinePrompt = buildActionPrompt('spine');
    const outlinePrompt = buildActionPrompt('outline');
    const nextChapterPrompt = buildActionPrompt('next-chapter');
    const openingOptionsPrompt = buildActionPrompt('opening-options');
    const organizePrompt = buildActionPrompt('organize');

    assert.match(startBookPrompt, /我想试试写一本书/);
    assert.match(startBookPrompt, /不要立刻写正文/);
    assert.match(startBookPrompt, /只问最核心的 3 到 5 个问题/);
    assert.match(spinePrompt, /书脊/);
    assert.match(spinePrompt, /不要直接写完整大纲/);
    assert.match(EBOOK_SYSTEM_PROMPT, /长篇推进要有卷级心智/);
    assert.match(EBOOK_SYSTEM_PROMPT, /当前卷缺少可执行细纲/);
    assert.match(EBOOK_SYSTEM_PROMPT, /不要每章都问用户/);
    assert.match(outlinePrompt, /\[作品核心设定\]/);
    assert.match(outlinePrompt, /不要硬写完整大纲/);
    assert.match(outlinePrompt, /不要只写“下一章”/);
    assert.match(outlinePrompt, /不一次性生成全书每章细纲/);
    assert.match(outlinePrompt, /当前卷要写出可执行的卷内细纲/);
    assert.match(outlinePrompt, /章节功能表/);
    assert.match(outlinePrompt, /按卷或事件集团推进/);
    assert.match(outlinePrompt, /少问多执行/);
    assert.match(outlinePrompt, /按需读取对应资料/);
    assert.match(nextChapterPrompt, /\[作品核心设定\]/);
    assert.match(nextChapterPrompt, /不要直接硬写长正文/);
    assert.match(nextChapterPrompt, /当前卷没有可执行的卷内细纲/);
    assert.match(nextChapterPrompt, /不要变成写一章问一章/);
    assert.match(nextChapterPrompt, /直接按章节功能表推进下一章/);
    assert.match(nextChapterPrompt, /只读取目标章节或相邻章节/);
    assert.match(openingOptionsPrompt, /不要直接写入文件/);
    assert.match(openingOptionsPrompt, /给 2 到 3 个不同开场方案/);
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

test('Book tool definitions expose filePath consistently for Read and Write', () => {
    const definitions = getEbookToolDefinitions();
    const readDefinition = definitions.find((definition) => definition.function.name === EBOOK_TOOL_NAMES.READ);
    const writeDefinition = definitions.find((definition) => definition.function.name === EBOOK_TOOL_NAMES.WRITE);

    assert.equal(Object.hasOwn(readDefinition.function.parameters.properties, 'filePath'), true);
    assert.equal(Object.hasOwn(readDefinition.function.parameters.properties, 'path'), false);
    assert.equal(Object.hasOwn(writeDefinition.function.parameters.properties, 'filePath'), true);
    assert.equal(Object.hasOwn(writeDefinition.function.parameters.properties, 'path'), false);
    assert.deepEqual(writeDefinition.function.parameters.required, ['filePath', 'content']);
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

test('Book Delete removes a single file and returns a deleted count', async () => {
    await resetDb();
    const book = await createBook('删除单文件测试');
    await upsertBookFile(book.id, 'book/notes/temp.md', '待删内容');
    const runtime = createBookToolRuntime({ bookId: book.id });

    const result = await runtime.execute(EBOOK_TOOL_NAMES.DELETE, { path: 'book/notes/temp.md' });

    assert.equal(result.ok, true);
    assert.equal(result.path, 'book/notes/temp.md');
    assert.equal(result.deletedCount, 1);
    assert.equal(await getBookFile(book.id, 'book/notes/temp.md'), null);
    assert.notEqual(await getBookFile(book.id, 'book/outline.md'), null);
});

test('Book Delete removes a directory tree and returns a deleted count', async () => {
    await resetDb();
    const book = await createBook('删除目录测试');
    await upsertBookFile(book.id, 'book/reviews/001.md', '第一条意见');
    await upsertBookFile(book.id, 'book/reviews/archive/002.md', '第二条意见');
    const runtime = createBookToolRuntime({ bookId: book.id });

    const result = await runtime.execute(EBOOK_TOOL_NAMES.DELETE, { path: 'book/reviews/' });

    assert.equal(result.ok, true);
    assert.equal(result.path, 'book/reviews/');
    assert.equal(result.deletedCount, 2);
    assert.equal(await getBookFile(book.id, 'book/reviews/001.md'), null);
    assert.equal(await getBookFile(book.id, 'book/reviews/archive/002.md'), null);
    assert.notEqual(await getBookFile(book.id, 'book/outline.md'), null);
});

test('Book Read rejects path while Write uses filePath and still tolerates hidden path calls', async () => {
    await resetDb();
    const book = await createBook('工具字段测试');
    const runtime = createBookToolRuntime({ bookId: book.id });

    await assert.rejects(
        () => runtime.execute(EBOOK_TOOL_NAMES.READ, { path: 'book/outline.md' }),
        /book_path_required/,
    );
    const written = await runtime.execute(EBOOK_TOOL_NAMES.WRITE, { filePath: 'book/notes/temp.md', content: 'x' });
    assert.equal(written.ok, true);
    assert.equal(written.path, 'book/notes/temp.md');
    assert.equal((await getBookFile(book.id, 'book/notes/temp.md')).content, 'x');

    const hiddenAlias = await runtime.execute(EBOOK_TOOL_NAMES.WRITE, { path: 'book/notes/path-alias.md', content: 'y' });
    assert.equal(hiddenAlias.ok, true);
    assert.equal(hiddenAlias.path, 'book/notes/path-alias.md');
    assert.equal((await getBookFile(book.id, 'book/notes/path-alias.md')).content, 'y');
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

    const html = renderEbookShell({ state });
    assert.match(html, /xb-library-grid is-empty/);
    assert.match(html, /xb-library-empty/);
    assert.match(html, /Agent 沉浸式创作与阅读平台/);
    assert.match(html, /class="xb-shelf-actions"/);
    assert.match(html, /id="xb-library-new-book"/);
    assert.match(html, /id="xb-library-delete-book"[^>]*disabled/);
    const headerHtml = html.slice(html.indexOf('<header'), html.indexOf('<main'));
    assert.doesNotMatch(headerHtml, /xb-library-new-book|xb-library-delete-book|xb-delete-book-close/);
});

test('Library shelf actions stay inside the shelf after the rendered books', () => {
    const state = {
        book: { id: 'book-1', title: '测试书', updatedAt: 1716039600000 },
        books: [
            { id: 'book-1', title: '测试书', updatedAt: 1716039600000 },
        ],
        files: [],
        selectedPath: '',
        readerPath: '',
        viewMode: 'library',
        editorContent: '',
        savedContent: '',
        isBusy: false,
        toast: '',
        isDeleteBookOpen: false,
        colorTheme: 'dark',
    };

    const html = renderEbookShell({ state });
    const bookIndex = html.indexOf('data-book-id="book-1"');
    const shelfActionIndex = html.indexOf('class="xb-shelf-actions"');
    const headerHtml = html.slice(html.indexOf('<header'), html.indexOf('<main'));
    assert.ok(bookIndex >= 0);
    assert.ok(shelfActionIndex > bookIndex);
    assert.match(headerHtml, /class="xb-archive-subtitle">Agent 沉浸式创作与阅读平台/);
    assert.match(html, /id="xb-library-new-book"/);
    assert.match(html, /id="xb-library-delete-book"/);
    assert.match(html, /xb-shelf-action-ring/);
    assert.match(headerHtml, /id="xb-close"[^>]*aria-label="退出电纸书"/);
    assert.match(headerHtml, /class="xb-exit-icon"/);
    assert.doesNotMatch(headerHtml, /xb-library-new-book|xb-library-delete-book|xb-delete-book-close/);
});

test('Studio renders mobile workspace switching and file drawer hooks', () => {
    const state = {
        book: { id: 'book-mobile-studio', title: '移动工作台' },
        books: [],
        files: [
            { path: 'book/chapters/001.md', content: '# 第 1 章\n\n正文' },
            { path: 'book/outline.md', content: '# 大纲' },
        ],
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'studio',
        editorContent: '# 第 1 章\n\n正文',
        savedContent: '# 第 1 章\n\n正文',
        messages: [],
        toolTrace: [],
        openToolTurnKeys: [],
        openThoughtKeys: [],
        historySummary: '',
        isBusy: false,
        drawStatus: { provider: 'novelai', enabled: true, ready: true },
        colorTheme: 'dark',
        status: '就绪',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        dirty: false,
    });

    assert.match(html, /class="xb-mobile-studio-topbar"/);
    assert.match(html, /class="xb-mobile-segment"/);
    assert.match(html, /data-studio-layout="focus-editor"/);
    assert.match(html, /data-studio-layout="focus-agent"/);
    assert.match(html, /id="xb-mobile-file-picker"/);
    assert.match(html, /class="xb-mobile-file-drawer-scrim"/);
    assert.match(html, /data-mobile-file-drawer-close/);
    assert.match(html, /id="xb-save"[^>]*>保存<\/button>/);
    assert.match(html, /这里是写作助手记录。可以先导入资料，也可以直接说“我想试试写一本书”。/);
    assert.match(html, /<summary>创作入口<\/summary>/);
    assert.match(html, />聊新书<\/button>/);
    assert.match(html, />建书脊<\/button>/);
    assert.match(html, />搭大纲<\/button>/);
    assert.match(html, />试写开场<\/button>/);
    assert.doesNotMatch(html, /续写草稿|审一遍|按意见改稿/);
    assert.doesNotMatch(html, /保存稿纸/);
});

test('Reader renders a mobile table-of-contents drawer', () => {
    const state = {
        book: { id: 'book-reader-toc', title: '目录测试' },
        books: [],
        files: [
            { path: 'book/chapters/001.md', content: '# 第 1 章\n\n第一章正文' },
            { path: 'book/chapters/002.md', content: '# 第 2 章\n\n第二章正文' },
        ],
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'reader',
        editorContent: '',
        savedContent: '',
        messages: [],
        isBusy: false,
        colorTheme: 'dark',
        toast: '',
    };

    const html = renderEbookShell({ state });
    const actionsHtml = html.match(/<div class="xb-reader-edge-actions">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.match(html, /id="xb-reader-index-toggle"/);
    assert.match(html, /id="xb-reader-tts-toggle"/);
    assert.match(html, /id="xb-reader-tts-toggle"[^>]*disabled/);
    assert.match(html, /id="xb-reader-index-scrim"/);
    assert.match(html, /class="xb-reader-toc-sheet"/);
    assert.match(html, /id="xb-reader-index-close"/);
    assert.doesNotMatch(actionsHtml, /id="xb-studio-link"/);
    assert(
        actionsHtml.indexOf('id="xb-entry-link"') < actionsHtml.indexOf('id="xb-reader-index-toggle"'),
        'reader entry button should stay before the toc button',
    );
    assert(
        actionsHtml.indexOf('id="xb-reader-index-toggle"') < actionsHtml.indexOf('id="xb-reader-tts-toggle"'),
        'reader toc button should stay before the tts button',
    );
    assert(
        actionsHtml.indexOf('id="xb-reader-tts-toggle"') < actionsHtml.indexOf('id="xb-theme-toggle"'),
        'reader tts button should stay before the theme button',
    );
    assert.equal((html.match(/data-reader-path="book\/chapters\/001\.md"/g) || []).length, 2);

    const readyHtml = renderEbookShell({
        state: {
            ...state,
            readerTtsStatus: { enabled: true, ready: true },
        },
    });
    assert.match(readyHtml, /id="xb-reader-tts-toggle"[^>]*>▶<\/button>/);
    assert.doesNotMatch(readyHtml, /id="xb-reader-tts-toggle"[^>]*disabled/);

    const activeHtml = renderEbookShell({
        state: {
            ...state,
            readerTtsStatus: { enabled: true, ready: true },
            readerTtsPlayback: {
                status: 'playing',
                playbackId: 'reader-playback-1',
                chapterPath: 'book/chapters/001.md',
                error: '',
            },
        },
    });
    assert.match(activeHtml, /class="[^"]*xb-reader-tts-toggle[^"]*is-active[^"]*" id="xb-reader-tts-toggle"/);
    assert.match(activeHtml, /id="xb-reader-tts-toggle"[^>]*>■<\/button>/);
    assert.doesNotMatch(activeHtml, /id="xb-reader-tts-toggle"[^>]*disabled/);

    const activeDisabledStatusHtml = renderEbookShell({
        state: {
            ...state,
            readerTtsStatus: { enabled: false, ready: false },
            readerTtsPlayback: {
                status: 'playing',
                playbackId: 'reader-playback-2',
                chapterPath: 'book/chapters/001.md',
                error: '',
            },
        },
    });
    assert.match(activeDisabledStatusHtml, /id="xb-reader-tts-toggle"[^>]*>■<\/button>/);
    assert.doesNotMatch(activeDisabledStatusHtml, /id="xb-reader-tts-toggle"[^>]*disabled/);
});

test('Book entry uses concise studio and reader descriptions', () => {
    const html = renderEbookShell({
        state: {
            book: { id: 'book-entry-copy', title: '入口文案测试' },
            books: [],
            files: [],
            viewMode: 'book-entry',
            colorTheme: 'dark',
            toast: '',
        },
    });

    assert.match(html, /agent写作平台/);
    assert.match(html, /沉浸式阅读器/);
    assert.doesNotMatch(html, /这里不放 AI/);
});

test('Book entry keeps desktop portal actions hover-highlight only', () => {
    const styles = readFileSync(new URL('../app-src/styles.js', import.meta.url), 'utf8');

    assert.doesNotMatch(
        styles,
        /\.theme-dark\s+\.xb-library-book,\s*\.theme-dark\s+\.xb-entry-action\s*\{/,
        'entry actions must not inherit the always-lit book-card background on desktop',
    );
    assert.match(
        styles,
        /\.theme-dark\s+\.xb-entry-action\s*\{[^}]*background:\s*transparent;/s,
        'dark desktop entry actions should stay muted until hover',
    );
    assert.match(
        styles,
        /\.theme-light\s+\.xb-entry-action\s*\{[^}]*background:\s*transparent;/s,
        'light desktop entry actions should stay muted until hover',
    );
    assert.doesNotMatch(
        styles,
        /@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*\.xb-entry-action/,
        'touch-only active styling should not be broad enough to hit desktop touch hardware',
    );
    assert.match(
        styles,
        /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*\.theme-dark\s+\.xb-entry-action\.is-studio\s*\{[\s\S]*#2b3040/,
        'small-screen entry actions should remain visibly active for touch users',
    );
});

test('Book controller initialization does not request draw status before frame ready', async () => {
    await resetDb();
    const state = {
        book: null,
        books: [],
        files: [],
        selectedPath: '',
        readerPath: '',
        viewMode: 'library',
        editorContent: '',
        savedContent: '',
        isBusy: false,
        toast: '',
    };
    const requests = [];
    const controller = createBookController({
        state,
        render() {},
        requestHost(type) {
            requests.push(type);
        },
        showToast() {},
    });

    await controller.initializeBook();

    assert.deepEqual(requests, []);
});

test('Studio draw button is only active for drawable chapters', () => {
    const baseState = {
        book: { id: 'book-draw-render', title: '配图按钮测试' },
        books: [],
        files: [],
        selectedPath: 'book/chapters/001.md',
        readerPath: '',
        viewMode: 'studio',
        editorContent: '她推开门。',
        savedContent: '她推开门。',
        messages: [],
        toolTrace: [],
        openToolTurnKeys: [],
        openThoughtKeys: [],
        historySummary: '',
        isBusy: false,
        isDrawingChapter: false,
        drawStatus: { provider: 'novelai', enabled: true, ready: true },
        colorTheme: 'dark',
        status: '就绪',
        toast: '',
    };

    const enabledHtml = renderEbookShell({
        state: baseState,
        providerConfig: { provider: 'test', model: 'demo' },
        dirty: false,
    });
    assert.match(enabledHtml, /id="xb-draw-chapter"[^>]*>配图<\/button>/);
    assert.doesNotMatch(enabledHtml, /id="xb-draw-chapter"[^>]*disabled/);

    const drawingHtml = renderEbookShell({
        state: { ...baseState, isDrawingChapter: true, editorContent: '' },
        providerConfig: { provider: 'test', model: 'demo' },
        dirty: false,
    });
    assert.match(drawingHtml, /id="xb-draw-chapter"[^>]*>停止<\/button>/);
    assert.doesNotMatch(drawingHtml, /id="xb-draw-chapter"[^>]*disabled/);

    const nonChapterHtml = renderEbookShell({
        state: { ...baseState, selectedPath: 'book/outline.md' },
        providerConfig: { provider: 'test', model: 'demo' },
        dirty: false,
    });
    assert.match(nonChapterHtml, /id="xb-draw-chapter"[^>]*disabled/);

    const disabledBackendHtml = renderEbookShell({
        state: { ...baseState, drawStatus: { provider: 'disabled', enabled: false, ready: false } },
        providerConfig: { provider: 'test', model: 'demo' },
        dirty: false,
    });
    assert.match(disabledBackendHtml, /id="xb-draw-chapter"[^>]*disabled/);
});

test('Book draw cooldown progress includes a countdown', () => {
    assert.equal(
        formatDrawProgress('cooldown', { duration: 18500, nextIndex: 3, total: 4 }),
        '等待下一张配图 3/4，剩余 18.5s',
    );
});

test('Book controller draws current chapter and inserts ebook image markers by anchor', async () => {
    await resetDb();
    const book = await createBook('章节配图测试');
    const originalContent = '她推开门。\n\n夜色涌进来。';
    await upsertBookFile(book.id, 'book/chapters/001.md', originalContent);
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'studio',
        editorContent: originalContent,
        savedContent: originalContent,
        isBusy: false,
        isDrawingChapter: false,
        drawStatus: { provider: 'novelai', enabled: true, ready: true },
        drawProgressText: '',
        toast: '',
    };
    const seenRequests = [];
    const controller = createBookController({
        state,
        render() {},
        async requestHost(type, payload) {
            seenRequests.push({ type, payload });
            if (type === 'xb-ebook:draw-status') {
                return { ok: true, provider: 'novelai', enabled: true, ready: true };
            }
            if (type === 'xb-ebook:draw-generate') {
                return {
                    ok: true,
                    success: 2,
                    total: 2,
                    images: [
                        { slotId: 'slot-anchor', anchor: '她推开门', success: true },
                        { slotId: 'slot-tail', anchor: '不存在的锚点', success: true },
                    ],
                };
            }
            throw new Error('unexpected_request');
        },
        showToast() {},
    });

    await controller.drawCurrentChapter();

    const updated = await getBookFile(book.id, 'book/chapters/001.md');
    assert.match(updated.content, /她推开门。\n\[ebook-image:slot-anchor\]/);
    assert.match(updated.content, /夜色涌进来。\n\[ebook-image:slot-tail\]$/);
    assert.equal(state.savedContent, updated.content);
    assert.equal(seenRequests.some((item) => item.type === 'xb-ebook:draw-generate'), true);
    const drawPayload = seenRequests.find((item) => item.type === 'xb-ebook:draw-generate')?.payload || {};
    assert.equal(drawPayload.source, 'ebook');
    assert.equal(drawPayload.bookId, book.id);
    assert.equal(drawPayload.chapterPath, 'book/chapters/001.md');
    assert.equal(state.drawProgressText, '占位符已插入，请去阅读器查看');
});

test('Book drawing can be cancelled by clicking the chapter draw button again', async () => {
    await resetDb();
    const book = await createBook('取消配图测试');
    const originalContent = '她推开门。';
    await upsertBookFile(book.id, 'book/chapters/001.md', originalContent);
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'studio',
        editorContent: originalContent,
        savedContent: originalContent,
        isBusy: false,
        isDrawingChapter: false,
        drawStatus: { provider: 'novelai', enabled: true, ready: true },
        drawProgressText: '',
        toast: '',
    };
    const toasts = [];
    let drawSignal = null;
    let startDraw = null;
    const drawStarted = new Promise((resolve) => {
        startDraw = resolve;
    });
    const controller = createBookController({
        state,
        render() {},
        async requestHost(type, _payload, options = {}) {
            if (type === 'xb-ebook:draw-status') {
                return { ok: true, provider: 'novelai', enabled: true, ready: true };
            }
            if (type === 'xb-ebook:draw-generate') {
                drawSignal = options.signal;
                startDraw();
                return new Promise((resolve, reject) => {
                    options.signal?.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
                    setTimeout(() => resolve({
                        ok: true,
                        success: 1,
                        total: 1,
                        images: [{ slotId: 'slot-should-not-write', anchor: '她推开门', success: true }],
                    }), 1000).unref?.();
                });
            }
            throw new Error('unexpected_request');
        },
        showToast(message) {
            toasts.push(message);
        },
    });

    const runningDraw = controller.drawCurrentChapter();
    await drawStarted;
    assert.equal(state.isDrawingChapter, true);
    assert.equal(drawSignal?.aborted, false);

    await controller.drawCurrentChapter();
    assert.equal(drawSignal.aborted, true);
    assert.equal(state.drawProgressText, '正在停止配图...');

    await runningDraw;
    assert.equal(state.isDrawingChapter, false);
    assert.equal(toasts.at(-1), '配图已取消');
    const updated = await getBookFile(book.id, 'book/chapters/001.md');
    assert.equal(updated.content, originalContent);
});

test('Book drawing saves the original chapter if the user switches files while generation runs', async () => {
    await resetDb();
    const book = await createBook('切换文件配图测试');
    const chapterContent = '她推开门。';
    await upsertBookFile(book.id, 'book/chapters/001.md', chapterContent);
    await upsertBookFile(book.id, 'book/outline.md', '旧大纲');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'studio',
        editorContent: chapterContent,
        savedContent: chapterContent,
        isBusy: false,
        isDrawingChapter: false,
        drawStatus: { provider: 'novelai', enabled: true, ready: true },
        drawProgressText: '',
        toast: '',
    };
    const controller = createBookController({
        state,
        render() {},
        async requestHost(type) {
            if (type === 'xb-ebook:draw-status') {
                return { ok: true, provider: 'novelai', enabled: true, ready: true };
            }
            if (type === 'xb-ebook:draw-generate') {
                state.selectedPath = 'book/outline.md';
                state.editorContent = '未保存的新大纲';
                state.savedContent = '旧大纲';
                return {
                    ok: true,
                    success: 1,
                    total: 1,
                    images: [{ slotId: 'slot-switch', anchor: '她推开门', success: true }],
                };
            }
            throw new Error('unexpected_request');
        },
        showToast() {},
    });

    await controller.drawCurrentChapter();

    const updatedChapter = await getBookFile(book.id, 'book/chapters/001.md');
    assert.match(updatedChapter.content, /她推开门。\n\[ebook-image:slot-switch\]/);
    assert.equal(state.selectedPath, 'book/outline.md');
    assert.equal(state.editorContent, '未保存的新大纲');
    assert.equal(state.savedContent, '旧大纲');
});

test('Book drawing does not recreate files when the original book is deleted mid-generation', async () => {
    await resetDb();
    const book = await createBook('删除中配图测试');
    await upsertBookFile(book.id, 'book/chapters/001.md', '她推开门。');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'studio',
        editorContent: '她推开门。',
        savedContent: '她推开门。',
        isBusy: false,
        isDrawingChapter: false,
        drawStatus: { provider: 'novelai', enabled: true, ready: true },
        drawProgressText: '',
        toast: '',
    };
    const toasts = [];
    const controller = createBookController({
        state,
        render() {},
        async requestHost(type) {
            if (type === 'xb-ebook:draw-status') {
                return { ok: true, provider: 'novelai', enabled: true, ready: true };
            }
            if (type === 'xb-ebook:draw-generate') {
                await deleteBook(book.id);
                state.book = null;
                return {
                    ok: true,
                    success: 1,
                    total: 1,
                    images: [{ slotId: 'slot-deleted-book', anchor: '她推开门', success: true }],
                };
            }
            throw new Error('unexpected_request');
        },
        showToast(message) {
            toasts.push(message);
        },
    });

    await controller.drawCurrentChapter();

    assert.equal(await getBook(book.id), null);
    assert.equal(await getBookFile(book.id, 'book/chapters/001.md'), null);
    assert.match(toasts.at(-1), /原书已删除/);
});

test('Reader renders ebook image markers as loadable image slots', () => {
    const state = {
        book: { id: 'book-reader-image', title: '阅读配图测试' },
        books: [],
        files: [{
            path: 'book/chapters/001.md',
            content: '第一段。\n\n[ebook-image:slot-reader]\n\n第二段。',
        }],
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'reader',
        messages: [],
        toolTrace: [],
        isBusy: false,
        colorTheme: 'dark',
        toast: '',
    };

    const html = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        dirty: false,
    });

    assert.match(html, /data-ebook-image-slot="slot-reader"/);
    assert.match(html, /配图加载中/);
    assert.doesNotMatch(html, /\[ebook-image:slot-reader\]/);
});

test('Reader TTS plays the active chapter text and stops when switching chapters', async () => {
    await resetDb();
    const book = await createBook('朗读测试');
    await upsertBookFile(
        book.id,
        'book/chapters/001.md',
        '# 第 1 章\n\n第一段。\n\n[ebook-image:slot-voice]\n\n第二段。',
    );
    await upsertBookFile(book.id, 'book/chapters/002.md', '下一章。');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'reader',
        editorContent: '',
        savedContent: '',
        isBusy: false,
        readerTtsStatus: { enabled: true, ready: true },
        readerTtsPlayback: { status: 'idle', playbackId: '', chapterPath: '', error: '' },
        toast: '',
    };
    const requests = [];
    const controller = createBookController({
        state,
        render() {},
        async requestHost(type, payload = {}) {
            requests.push({ type, payload });
            if (type === 'xb-ebook:tts-status') return { ok: true, enabled: true, ready: true };
            if (type === 'xb-ebook:tts-play') return { ok: true, playbackId: payload.playbackId };
            if (type === 'xb-ebook:tts-stop') return { ok: true };
            throw new Error(`unexpected_request:${type}`);
        },
        showToast() {},
    });

    await controller.toggleReaderTts();

    const playRequest = requests.find((item) => item.type === 'xb-ebook:tts-play');
    assert.ok(playRequest);
    assert.equal(playRequest.payload.chapterPath, 'book/chapters/001.md');
    assert.match(playRequest.payload.text, /第一段。/);
    assert.match(playRequest.payload.text, /第二段。/);
    assert.doesNotMatch(playRequest.payload.text, /\[ebook-image:/);
    assert.doesNotMatch(playRequest.payload.text, /^#/m);
    assert.equal(state.readerTtsPlayback.status, 'loading');

    controller.handleTtsState({ playbackId: playRequest.payload.playbackId, state: 'playing' });
    assert.equal(state.readerTtsPlayback.status, 'playing');

    await controller.selectReaderChapter('book/chapters/002.md');

    const stopRequest = requests.find((item) => item.type === 'xb-ebook:tts-stop');
    assert.ok(stopRequest);
    assert.equal(stopRequest.payload.playbackId, playRequest.payload.playbackId);
    assert.equal(state.readerPath, 'book/chapters/002.md');
    assert.equal(state.readerTtsPlayback.status, 'idle');
});

test('Reader chapter switching does not wait for the host stop request before navigating', async () => {
    await resetDb();
    const book = await createBook('朗读切章不卡顿测试');
    await upsertBookFile(book.id, 'book/chapters/001.md', '第一章。');
    await upsertBookFile(book.id, 'book/chapters/002.md', '第二章。');
    const state = {
        book,
        books: [book],
        files: await listBookFiles(book.id),
        selectedPath: 'book/chapters/001.md',
        readerPath: 'book/chapters/001.md',
        viewMode: 'reader',
        editorContent: '',
        savedContent: '',
        isBusy: false,
        readerTtsStatus: { enabled: true, ready: true },
        readerTtsPlayback: {
            status: 'playing',
            playbackId: 'reader-playback-slow-stop',
            chapterPath: 'book/chapters/001.md',
            error: '',
        },
        toast: '',
    };
    let releaseStop = null;
    const stopPending = new Promise((resolve) => {
        releaseStop = resolve;
    });
    const controller = createBookController({
        state,
        render() {},
        async requestHost(type) {
            if (type === 'xb-ebook:tts-stop') return stopPending;
            throw new Error(`unexpected_request:${type}`);
        },
        showToast() {},
    });

    const switchPromise = controller.selectReaderChapter('book/chapters/002.md');

    assert.equal(state.readerPath, 'book/chapters/002.md');
    assert.equal(state.viewMode, 'reader');
    assert.equal(state.readerTtsPlayback.status, 'idle');

    releaseStop({ ok: true });
    await switchPromise;
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

test('Book renderer keeps only the recent agent history mounted by default', async () => {
    await resetDb();
    const book = await createBook('UI窗口测试');
    const messages = Array.from({ length: 9 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `窗口消息_${index}`,
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

    assert.match(html, /较早记录 4 条/);
    assert.doesNotMatch(html, /窗口消息_0/);
    assert.doesNotMatch(html, /窗口消息_3/);
    assert.match(html, /窗口消息_4/);
    assert.match(html, /窗口消息_8/);
    assert.equal(state.messages.length, 9);
});

test('Book message window counts consecutive tool rounds as one mounted unit', () => {
    const messages = [
        { role: 'user', content: '跑工具。' },
        { role: 'assistant', toolCalls: [{ id: 'a', name: EBOOK_TOOL_NAMES.READ, arguments: '{}' }] },
        { role: 'tool', toolCallId: 'a', toolName: EBOOK_TOOL_NAMES.READ, content: '{}' },
        { role: 'assistant', toolCalls: [{ id: 'b', name: EBOOK_TOOL_NAMES.GREP, arguments: '{}' }] },
        { role: 'tool', toolCallId: 'b', toolName: EBOOK_TOOL_NAMES.GREP, content: '{}' },
        { role: 'assistant', content: '完成。' },
    ];

    assert.equal(countMessageWindowUnits(messages), 3);
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

test('Book renderer defers stored tool round details while keeping folded previews', async () => {
    await resetDb();
    const book = await createBook('折叠工具懒渲染测试');
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
            { role: 'user', content: '检查章节。' },
            {
                role: 'assistant',
                content: 'UNIQUE_LAZY_PREFACE',
                thoughts: [{ label: 'thinking', text: 'UNIQUE_LAZY_THOUGHT' }],
                toolCalls: [{
                    id: 'call-lazy-tool',
                    name: EBOOK_TOOL_NAMES.READ,
                    arguments: '{"filePath":"book/chapters/001.md"}',
                }],
            },
            {
                role: 'tool',
                toolCallId: 'call-lazy-tool',
                toolName: EBOOK_TOOL_NAMES.READ,
                content: '{"ok":true,"summary":"UNIQUE_LAZY_TOOL_DETAIL"}',
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

    const foldedHtml = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        providerLabel: '测试',
        dirty: false,
    });

    assert.match(foldedHtml, /data-lazy-tool-turn="true"/);
    assert.match(foldedHtml, /展开查看思考、说明和完整工具轮次/);
    assert.match(foldedHtml, /UNIQUE_LAZY_TOOL_DETAIL/);
    assert.match(foldedHtml, /UNIQUE_LAZY_PREFACE/);
    assert.doesNotMatch(foldedHtml, /UNIQUE_LAZY_THOUGHT/);

    state.openToolTurnKeys = ['tool-turn:call-lazy-tool'];
    const openHtml = renderEbookShell({
        state,
        providerConfig: { provider: 'test', model: 'demo' },
        providerLabel: '测试',
        dirty: false,
    });

    assert.doesNotMatch(openHtml, /data-lazy-tool-turn="true"/);
    assert.match(openHtml, /UNIQUE_LAZY_TOOL_DETAIL/);
    assert.match(openHtml, /UNIQUE_LAZY_PREFACE/);
    assert.match(openHtml, /UNIQUE_LAZY_THOUGHT/);
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

test('Book lazy tool turns request rerender when opened or closed', () => {
    const state = {
        isBusy: false,
        openToolTurnKeys: [],
    };
    let renderCount = 0;
    const details = {
        dataset: {
            toolTurnKey: 'tool-turn:call-read-lazy',
            lazyToolTurn: 'true',
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
        render() {
            renderCount += 1;
        },
        postToHost() {},
        bookController: {},
        agentRunner: {},
        persistConversation() {},
        clearConversation() {},
        showToast() {},
    });

    details.handler();

    assert.deepEqual(state.openToolTurnKeys, ['tool-turn:call-read-lazy']);
    assert.equal(renderCount, 1);

    details.dataset.lazyToolTurn = '';
    details.open = false;
    details.handler();

    assert.deepEqual(state.openToolTurnKeys, []);
    assert.equal(renderCount, 2);
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

test('Book bind events wires both desktop and mobile agent close buttons', () => {
    const closeEvents = [];
    const desktopClose = {
        addEventListener(eventName, handler) {
            closeEvents.push({ target: 'desktop', eventName, handler });
        },
    };
    const mobileClose = {
        addEventListener(eventName, handler) {
            closeEvents.push({ target: 'mobile', eventName, handler });
        },
    };
    const root = {
        querySelector() {
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '#xb-agent-close, #xb-agent-close-mobile') return [desktopClose, mobileClose];
            return [];
        },
    };
    const postedTypes = [];

    bindEbookEvents({
        root,
        state: {},
        render() {},
        postToHost(type) {
            postedTypes.push(type);
        },
        bookController: {},
        agentRunner: {},
        persistConversation() {},
        clearConversation() {},
        showToast() {},
    });

    assert.equal(closeEvents.length, 2);
    assert.deepEqual(closeEvents.map((item) => item.target), ['desktop', 'mobile']);

    closeEvents[0].handler();
    closeEvents[1].handler();

    assert.deepEqual(postedTypes, ['xb-ebook:close', 'xb-ebook:close']);
});

test('Book agent composer keeps Enter as newline on mobile and send on desktop', () => {
    const previousMatchMedia = globalThis.matchMedia;
    const previousBowser = globalThis.Bowser;
    const listeners = {};
    const input = {
        addEventListener(eventName, handler) {
            listeners[`input:${eventName}`] = handler;
        },
        value: '',
    };
    const hint = {
        textContent: '',
    };
    let submitCount = 0;
    const form = {
        addEventListener(eventName, handler) {
            listeners[`form:${eventName}`] = handler;
        },
        requestSubmit() {
            submitCount += 1;
        },
    };
    const root = {
        querySelector(selector) {
            if (selector === '#xb-agent-input') return input;
            if (selector === '#xb-agent-form') return form;
            if (selector === '#xb-compose-hint') return hint;
            return null;
        },
        querySelectorAll() {
            return [];
        },
    };

    try {
        globalThis.Bowser = undefined;
        globalThis.matchMedia = (query) => ({
            matches: String(query).includes('pointer: coarse') || String(query).includes('max-width: 900px'),
        });
        bindEbookEvents({
            root,
            state: { isBusy: false },
            render() {},
            postToHost() {},
            bookController: {},
            agentRunner: {
                cancelActiveRun() {},
                runAgent() {},
            },
            persistConversation() {},
            clearConversation() {},
            showToast() {},
        });

        let prevented = false;
        listeners['input:keydown']({
            key: 'Enter',
            isComposing: false,
            shiftKey: false,
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            preventDefault() {
                prevented = true;
            },
        });

        assert.equal(prevented, false);
        assert.equal(submitCount, 0);
        assert.equal(hint.textContent, 'Enter 换行 · 点击发送');

        globalThis.matchMedia = () => ({ matches: false });
        submitCount = 0;
        prevented = false;
        listeners['input:keydown']({
            key: 'Enter',
            isComposing: false,
            shiftKey: false,
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            preventDefault() {
                prevented = true;
            },
        });

        assert.equal(prevented, true);
        assert.equal(submitCount, 1);
    } finally {
        globalThis.matchMedia = previousMatchMedia;
        globalThis.Bowser = previousBowser;
    }
});

test('Book agent chat scroll toggles auto-scroll like assistant', () => {
    const listeners = {};
    const makeClassList = () => ({
        values: new Set(),
        add(name) {
            this.values.add(name);
        },
        remove(name) {
            this.values.delete(name);
        },
        toggle(name, force) {
            if (force) this.values.add(name);
            else this.values.delete(name);
        },
    });
    const agentMain = {
        scrollTop: 680,
        scrollHeight: 1000,
        clientHeight: 300,
        addEventListener(eventName, handler) {
            listeners[`main:${eventName}`] = handler;
        },
        scrollTo({ top }) {
            this.scrollTop = top;
        },
    };
    const topButton = {
        classList: makeClassList(),
        addEventListener(eventName, handler) {
            listeners[`top:${eventName}`] = handler;
        },
    };
    const bottomButton = {
        classList: makeClassList(),
        addEventListener(eventName, handler) {
            listeners[`bottom:${eventName}`] = handler;
        },
    };
    const helpers = {
        classList: makeClassList(),
    };
    const state = { agentAutoScroll: true };
    const root = {
        querySelector(selector) {
            if (selector === '.xb-agent-main') return agentMain;
            if (selector === '#xb-agent-scroll-top') return topButton;
            if (selector === '#xb-agent-scroll-bottom') return bottomButton;
            if (selector === '#xb-agent-scroll-helpers') return helpers;
            return null;
        },
        querySelectorAll() {
            return [];
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

    listeners['main:scroll']();
    assert.equal(state.agentAutoScroll, true);

    agentMain.scrollTop = 120;
    listeners['main:scroll']();
    assert.equal(state.agentAutoScroll, false);

    listeners['top:click']();
    assert.equal(state.agentAutoScroll, false);
    assert.equal(agentMain.scrollTop, 0);

    listeners['bottom:click']();
    assert.equal(state.agentAutoScroll, true);
    assert.equal(agentMain.scrollTop, agentMain.scrollHeight);
});

test('Book agent chat disables streaming auto-scroll on manual upward intent', () => {
    const listeners = {};
    const agentMain = {
        scrollTop: 680,
        scrollHeight: 1000,
        clientHeight: 300,
        addEventListener(eventName, handler) {
            listeners[`main:${eventName}`] = handler;
        },
    };
    const inertButton = {
        classList: { toggle() {} },
        addEventListener() {},
    };
    const state = { agentAutoScroll: true };
    const root = {
        querySelector(selector) {
            if (selector === '.xb-agent-main') return agentMain;
            if (selector === '#xb-agent-scroll-top') return inertButton;
            if (selector === '#xb-agent-scroll-bottom') return inertButton;
            if (selector === '#xb-agent-scroll-helpers') return { classList: { add() {}, remove() {} } };
            return null;
        },
        querySelectorAll() {
            return [];
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

    listeners['main:wheel']({ deltaY: -24 });
    assert.equal(state.agentAutoScroll, false);

    agentMain.scrollTop = 656;
    listeners['main:scroll']();
    assert.equal(state.agentAutoScroll, false);

    agentMain.scrollTop = 700;
    listeners['main:scroll']();
    assert.equal(state.agentAutoScroll, true);

    state.agentAutoScroll = true;
    listeners['main:wheel']({ deltaY: 24 });
    assert.equal(state.agentAutoScroll, true);

    listeners['main:touchstart']({ touches: [{ clientY: 120 }] });
    listeners['main:touchmove']({ touches: [{ clientY: 136 }] });
    assert.equal(state.agentAutoScroll, false);
});

test('Book agent chat loads older mounted history when scrolled to the top', () => {
    const listeners = {};
    const agentMain = {
        scrollTop: 0,
        scrollHeight: 1000,
        clientHeight: 300,
        addEventListener(eventName, handler) {
            listeners[`main:${eventName}`] = handler;
        },
    };
    const inertButton = {
        classList: { toggle() {} },
        addEventListener() {},
    };
    const state = {
        agentAutoScroll: true,
        uiMessageWindowLimit: 5,
        messages: Array.from({ length: 9 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `消息_${index}`,
        })),
    };
    let renderCount = 0;
    const root = {
        querySelector(selector) {
            if (selector === '.xb-agent-main') return agentMain;
            if (selector === '#xb-agent-scroll-top') return inertButton;
            if (selector === '#xb-agent-scroll-bottom') return inertButton;
            if (selector === '#xb-agent-scroll-helpers') return { classList: { add() {}, remove() {} } };
            return null;
        },
        querySelectorAll() {
            return [];
        },
    };

    bindEbookEvents({
        root,
        state,
        render() {
            renderCount += 1;
        },
        postToHost() {},
        bookController: {},
        agentRunner: {},
        persistConversation() {},
        clearConversation() {},
        showToast() {},
    });

    listeners['main:scroll']();

    assert.equal(state.uiMessageWindowLimit, 9);
    assert.equal(state.agentAutoScroll, false);
    assert.equal(renderCount, 1);
});

test('Book app preserves manual agent scroll even when previous position was near bottom', () => {
    const agentMain = {
        scrollTop: 680,
        scrollHeight: 1000,
        clientHeight: 300,
    };
    const root = {
        querySelector(selector) {
            return selector === '.xb-agent-main' ? agentMain : null;
        },
    };
    const snapshot = captureScrollState(root, '.xb-agent-main');
    assert.equal(snapshot.nearBottom, true);

    agentMain.scrollTop = 0;
    agentMain.scrollHeight = 1200;
    restoreScrollState(root, snapshot, '.xb-agent-main', {
        defaultToBottom: false,
        preserveScrollTop: true,
    });
    assert.equal(agentMain.scrollTop, 680);

    restoreScrollState(root, snapshot, '.xb-agent-main', {
        forceBottom: true,
    });
    assert.equal(agentMain.scrollTop, 1200);
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

test('Book renderer keeps recent conversation mounted before compaction without dropping history', async () => {
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

    assert.match(html, /较早记录 5 条/);
    assert.doesNotMatch(html, /第 1 条创作对话/);
    assert.match(html, /第 6 条创作对话/);
    assert.match(html, /第 10 条创作对话/);
    assert.equal(state.messages.length, 10);
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
    assert.match(html, /class="xb-agent-head-main"/);
    assert.match(html, /class="xb-agent-global-actions"/);
    assert.match(html, /data-entry-link title="返回书本入口"/);
    assert.match(html, /id="xb-agent-close"[^>]*aria-label="退出电纸书"/);
    assert.match(html, /class="xb-exit-icon"/);
    const globalActionsHtml = html.match(/<div class="xb-agent-global-actions">([\s\S]*?)<\/div>/)?.[1] || '';
    assert(
        globalActionsHtml.indexOf('id="xb-theme-toggle"') < globalActionsHtml.indexOf('data-entry-link'),
        'entry button should sit after the theme toggle in the agent global actions',
    );
    assert(
        globalActionsHtml.indexOf('data-entry-link') < globalActionsHtml.indexOf('id="xb-agent-close"'),
        'entry button should sit before exit in the agent global actions',
    );
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
    assert.match(html, /id="xb-assistant-tavily-api-key"/);
    assert.match(html, /id="xb-assistant-delegate-preset-select"/);
    assert.match(html, /id="xb-assistant-delegate-provider"/);
    assert.match(html, /id="xb-assistant-delegate-base-url"/);
    assert.match(html, /id="xb-assistant-delegate-model"/);
    assert.match(html, /id="xb-assistant-delegate-tool-mode"/);
    assert.match(html, /id="xb-assistant-delegate-pull-models"/);
    assert.match(html, /id="xb-assistant-save"/);
    assert.match(html, /Tavily API Key（全局）/);
    assert.doesNotMatch(html, /id="xb-assistant-tavily-base-url"/);
    assert.doesNotMatch(html, /id="xb-assistant-delegate-tavily-api-key"/);
    assert.doesNotMatch(html, /id="xb-assistant-delegate-tavily-base-url"/);
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

test('Book agent keeps streamed text when a model request fails', async () => {
    await resetDb();
    const book = await createBook('流式错误测试');
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
                provider: 'openai-compatible',
                model: 'test-model',
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
                        text: '已经流出来的半截内容。',
                        thoughts: [{ label: '思考块', text: '先组织答案。' }],
                    });
                    throw new Error('Connection error.');
                },
            };
        },
    });

    await runner.runAgent('开始聊一个会报错的问题。');

    assert.deepEqual(state.messages.map((message) => message.role), ['user', 'assistant', 'assistant']);
    assert.equal(state.messages[1].streaming, false);
    assert.equal(state.messages[1].content, '已经流出来的半截内容。');
    assert.equal(state.messages[1].thoughts[0].text, '先组织答案。');
    assert.equal(state.messages[2].error, true);
    assert.match(state.messages[2].content, /AI 操作失败：Connection error\./);
});

test('Book agent injects a light brake after repeated tool failures', async () => {
    await resetDb();
    const book = await createBook('工具刹车测试');
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
    let sawLightBrake = false;
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
                    round += 1;
                    if (round <= 3) {
                        return {
                            text: '',
                            toolCalls: [{
                                id: `read-missing-${round}`,
                                name: EBOOK_TOOL_NAMES.READ,
                                arguments: '{"filePath":"book/chapters/missing.md","limit":2}',
                            }],
                        };
                    }
                    sawLightBrake = task.messages.some((message) => (
                        message.role === 'system'
                        && /工具失败提示/.test(message.content)
                        && /Read/.test(message.content)
                        && /book_file_not_found/.test(message.content)
                    ));
                    return {
                        text: '已停止重复读取不存在的章节。',
                        toolCalls: [],
                    };
                },
            };
        },
    });

    await runner.runAgent('故意连续读不存在的章节。');

    assert.equal(sawLightBrake, true);
    assert.equal(state.messages.at(-1).content, '已停止重复读取不存在的章节。');
    assert.equal(state.messages.filter((message) => message.role === 'tool' && /book_file_not_found/.test(message.content)).length, 3);
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
        uiMessageWindowLimit: 100,
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
    assert.equal(state.uiMessageWindowLimit, 5);
});

test('Book prompt keeps assistant-style tool layers and recovery rules', () => {
    assert.match(EBOOK_SYSTEM_PROMPT, /# 工具使用指导/);
    assert.match(EBOOK_SYSTEM_PROMPT, /## 工具层级/);
    assert.match(EBOOK_SYSTEM_PROMPT, /## 选择策略/);
    assert.match(EBOOK_SYSTEM_PROMPT, /工具返回错误时/);
    assert.match(EBOOK_SYSTEM_PROMPT, /小范围且能稳定匹配原文时用 apply_patch/);
    assert.match(EBOOK_SYSTEM_PROMPT, /大段重写或整章重写用 Write/);
    assert.match(EBOOK_SYSTEM_PROMPT, /RenameBook/);
    assert.match(EBOOK_SYSTEM_PROMPT, /DelegateRun/);
    assert.match(EBOOK_SYSTEM_PROMPT, /\[ebook-image:slotId\]/);
    assert.doesNotMatch(EBOOK_SYSTEM_PROMPT, /## 工具参数速记|## apply_patch 格式/);
    assert.doesNotMatch(EBOOK_SYSTEM_PROMPT, /\*\*\* Update File: book\/example\.md/);
    assert.doesNotMatch(EBOOK_SYSTEM_PROMPT, /web_search|Tavily|联网查资料/);
    assert.doesNotMatch(EBOOK_SYSTEM_PROMPT, /不要尝试 `local/);
    assert.doesNotMatch(EBOOK_SYSTEM_PROMPT, /插件源码|JS API|斜杠命令/);

    const delegateDefinition = getEbookToolDefinitions()
        .find((definition) => definition.function?.name === EBOOK_TOOL_NAMES.DELEGATE_RUN);
    assert.match(String(delegateDefinition.function.description), /任务、背景和交付要求/);
    assert.doesNotMatch(String(delegateDefinition.function.description), /task\/context\/deliverable/i);

    const planCreate = getEbookToolDefinitions()
        .find((definition) => definition.function?.name === EBOOK_TOOL_NAMES.PLAN_CREATE);
    assert.equal(planCreate.function.parameters.properties.blockedBy.type, 'array');

    const applyPatch = getEbookToolDefinitions()
        .find((definition) => definition.function?.name === EBOOK_TOOL_NAMES.APPLY_PATCH);
    assert.match(String(applyPatch.function.description), /\*\*\* Update File: book\/example\.md/);
    assert.match(String(applyPatch.function.description), /不适合大段正文或整章重写/);
    assert.match(String(applyPatch.function.description), /\*\*\* Move to: book\/\.\.\./);
    assert.match(String(applyPatch.function.description), /Hunk headers support plain `@@`/);
    assert.match(String(applyPatch.function.parameters.properties.patchText.description), /Update\/Add\/Delete File: book\/\.\.\./);

    const webSearchDefinitions = getEbookToolDefinitions({ webSearchEnabled: true });
    const webSearch = webSearchDefinitions.find((definition) => definition.function?.name === EBOOK_TOOL_NAMES.WEB_SEARCH);
    assert.match(String(webSearch.function.description), /当前书稿和资料区无法提供/);
    assert.match(String(webSearch.function.description), /优先用 LS \/ Glob \/ Grep \/ Read/);
    assert.equal(
        getEbookToolDefinitions({ webSearchEnabled: false })
            .some((definition) => definition.function?.name === EBOOK_TOOL_NAMES.WEB_SEARCH),
        false,
    );
});

test('Book tool definitions teach exact parameters like assistant tools', () => {
    const definitions = new Map(
        getEbookToolDefinitions({ webSearchEnabled: true })
            .map((definition) => [definition.function?.name, definition.function]),
    );

    const ls = definitions.get(EBOOK_TOOL_NAMES.LS);
    assert.match(String(ls.description), /目录路径必须写成 `book\/\.\.\.\/`/);
    assert.match(String(ls.parameters.properties.path.description), /不要传 filePath/);

    const glob = definitions.get(EBOOK_TOOL_NAMES.GLOB);
    assert.match(String(glob.description), /`path` 只是可选目录范围，不能替代 pattern/);

    const grep = definitions.get(EBOOK_TOOL_NAMES.GREP);
    assert.match(String(grep.description), /useRegex: false/);
    assert.match(String(grep.parameters.properties.outputMode.description), /files_with_matches/);

    const read = definitions.get(EBOOK_TOOL_NAMES.READ);
    assert.match(String(read.description), /参数名是 `filePath`，不是 `path`/);
    assert.match(String(read.parameters.properties.filePath.description), /不要传 path/);

    const write = definitions.get(EBOOK_TOOL_NAMES.WRITE);
    assert.match(String(write.description), /参数名是 `filePath` 和 `content`/);
    assert.match(String(write.description), /大段正文、整节、整章重写/);
    assert.match(String(write.description), /保留原文时要把完整内容写回/);
    assert.equal(Object.hasOwn(write.parameters.properties, 'path'), false);
    assert.match(String(write.parameters.properties.filePath.description), /目标文件路径/);

    const deleteTool = definitions.get(EBOOK_TOOL_NAMES.DELETE);
    assert.match(String(deleteTool.description), /删除目录时路径要以 `\/` 结尾/);

    const move = definitions.get(EBOOK_TOOL_NAMES.MOVE);
    assert.match(String(move.description), /参数名是 `fromPath` 和 `toPath`/);

    const planUpdate = definitions.get(EBOOK_TOOL_NAMES.PLAN_UPDATE);
    assert.match(String(planUpdate.description), /不要自己编一个看起来像 id 的值/);

    const renameBook = definitions.get(EBOOK_TOOL_NAMES.RENAME_BOOK);
    assert.match(String(renameBook.description), /参数只有 `title`/);

    const delegateRun = definitions.get(EBOOK_TOOL_NAMES.DELEGATE_RUN);
    assert.match(String(delegateRun.description), /`task` 必填/);
    assert.match(String(delegateRun.description), /不要把它当成写作或修改工具/);
});
