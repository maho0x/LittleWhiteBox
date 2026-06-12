import type { TavernContractManagerPromptOptions } from './session-contract';

export interface TavernAssistantPreset {
    id: string;
    name: string;
    description?: string;
    storyArcPrompt: string;
    statePrompt: string;
    episodePrompt: string;
    inboxPrompt: string;
    memoryManagerPrompt?: string;
    updatedAt?: number;
}

type AssistantPresetInput = Partial<TavernAssistantPreset> & {
    managerIdentityPrompt?: string;
    managerContextPrompt?: string;
    managerToolPrompt?: string;
    managerMemoryPrompt?: string;
    managerWorkflowPrompt?: string;
    managerOutputPrompt?: string;
};

export const DEFAULT_TAVERN_ASSISTANT_PRESET_ID = 'littlewhitebox-assistant-default';

interface TavernManagerPromptOptions extends Partial<TavernContractManagerPromptOptions> {
    includeMemory?: boolean;
    includeCartography?: boolean;
}

function normalizeManagerPromptOptions(options: TavernManagerPromptOptions = {}) {
    return {
        includeMemory: options.includeMemory !== false,
        includeCartography: options.includeCartography !== false,
    };
}

function joinSection(title: string, lines: string[] = []): string {
    const content = lines.map((line) => normalizeText(line)).filter(Boolean);
    return content.length ? ['## ' + title, content.join('\n')].join('\n') : '';
}

function buildFixedManagerSystemPrompt(options: TavernManagerPromptOptions = {}): string {
    const { includeMemory, includeCartography } = normalizeManagerPromptOptions(options);
    const managedSurfaces = [
        includeMemory ? '记忆档案' : '',
        includeCartography ? '结构化空间状态' : '',
    ].filter(Boolean);
    const backstageFocus = includeMemory && includeCartography
        ? '事实、关系、阶段、线索、空间状态和待判断问题。'
        : includeMemory
            ? '事实、关系、阶段、线索和待判断问题。'
            : includeCartography
                ? '事实、空间边界、位置关系和待判断问题。'
                : '证据、上下文和待判断问题。';
    const maintenanceScope = includeMemory && includeCartography
        ? '维护关系、状态、地点、时间、物品、伏笔、阶段压力、空间变化和仍待判断的问题。'
        : includeMemory
            ? '维护关系、状态、地点、时间、物品、伏笔、阶段压力和仍待判断的问题。'
            : includeCartography
                ? '维护当前场景的空间边界、路线、位置、危险和仍待判断的问题。'
                : '需要时帮助用户核对后台资料、解释现状并指出仍待判断的问题。';
    const evidenceLine = includeMemory && includeCartography
        ? '在用户找你梳理线索、校正记忆或查看地图时，用证据回答；不确定就查原文，不用气势替代事实。'
        : includeMemory
            ? '在用户找你梳理线索或校正记忆时，用证据回答；不确定就查原文，不用气势替代事实。'
            : includeCartography
                ? '在用户找你查看地图或核对空间状态时，用证据回答；不确定就查原文，不用气势替代事实。'
                : '在用户找你核对后台资料时，用证据回答；不确定就查原文，不用气势替代事实。';

    const roleLines = [
        '你是小白酒馆的后台统筹者，运行在用户当前 RP 会话背面。',
        `舞台前由用户和角色沉浸互动；你在舞台后整理已经发生的${backstageFocus}`,
        managedSurfaces.length
            ? `你维护当前 session 的${managedSurfaces.join('和')}；主聊天负责沉浸互动，你负责把原文沉淀成可检索、可修正、可承接的后台资料。`
            : '主聊天负责沉浸互动；你在后台核对证据、梳理上下文，并在用户明确要求时协助查看既有资料。',
        '自动 after-turn 和手动管理员聊天共用同一套身份与证据标准。区别只在触发方式和本轮 user 输入。',
    ];

    const responsibilityLines = [
        includeMemory ? '把已经发生的 RP 原文整理成后续可承接的长期记忆，而不是把整段聊天原文重新塞回主聊天。' : '',
        maintenanceScope,
        managedSurfaces.length
            ? '让档案可读、可改、可追溯：重要事实应落到对应文件或状态文档里，不只停留在最终回复里。'
            : '回答时以证据为准：需要核对时先读原文或既有档案，不用气势替代事实。',
        evidenceLine,
    ];

    const currentSessionLines = [
        'The current session is the only work scope.',
        [
            includeMemory ? 'current-session `memory/...` files' : '',
            includeCartography ? 'structured state' : '',
            'manager chat',
            'RP source evidence',
        ].filter(Boolean).join(', ') + ' all belong to this work scope.',
        managedSurfaces.length
            ? 'RP source text is the factual source. Background memory and structured state are derived materials. If they conflict, verify with ChatHistory first and then repair the derived materials.'
            : 'RP source text is the factual source. Existing files are only supporting materials, and source text wins when they conflict.',
        'Resident injections are only a snapshot of current materials, not the full chat history. Treat any source text you have not read as unverified until you check it.',
    ];

    const injectedContextLines = [
        includeMemory ? '`[Resident Memory Files]` usually contains `memory/session.md`, `memory/state.md`, active `memory/episodes/*.md`, and `memory/inbox.md`.' : '',
        includeMemory ? 'Automatic after-turn runs also receive this turn\'s user/assistant source text and a suggested turn-file path. If this turn needs a turn file, maintain it with normal MemoryWrite or MemoryEdit Markdown updates.' : '',
        'Manual manager chat receives the manager\'s own conversation history and the current user question. RP source text is not fully preloaded; use ChatHistory when needed.',
    ];

    const fileDisciplineLines = includeMemory ? [
        'You may operate on current-session `memory/...` Markdown files only through Memory tools.',
        '`memory/session.md` tracks long-running plot continuity and pressure. `memory/state.md` tracks facts and states that still hold. `memory/episodes/*.md` tracks phase/event clusters. `memory/inbox.md` is for pending judgments, pending archival, and failed leftovers.',
        '`memory/turns/*.md` are per-turn logs. Automatic after-turn runs receive a suggested path. When the user asks to correct memory, manager chat may also read and modify existing turn files.',
        'These Markdown files are for future reading and retrieval, not a fixed database schema. Headings, paragraphs, and style are controlled by the assistant preset.',
    ] : [];

    const workLoopLines = [
        [
            'First decide what this turn is: automatic after-turn maintenance, a user asking for manager help',
            includeMemory ? ', a user asking to correct memory' : '',
            includeCartography ? ', or a user asking to inspect or change the map' : '',
            '.',
        ].join(''),
        'Use tools when you need evidence or need to change stored materials. Save only through the tools that are currently available.',
        'Read the current state or the source RP first, then make the smallest necessary change. Do not blindly repeat a failed tool call.',
        includeMemory ? 'In automatic after-turn runs, use MemoryWrite or MemoryEdit when this turn needs a turn file, then sync session/state/episode/inbox only as needed.' : '',
        includeMemory && includeCartography ? 'The map is extra spatial state. It does not replace this turn\'s written memory.' : '',
        includeCartography ? 'For automatic map maintenance, always start with StateRead summary and inspect `meta.status`. If it is still `uninitialized`, initialize as soon as this turn establishes a clear current scene. If it is already `active`, apply incremental map changes only for confirmed spatial changes this turn.' : '',
        'In manual manager chat, answer the user question first. Write memory or state only when the user asks for a change, or when you verified a real error or omission.',
        'When a tool fails, adjust the path, arguments, or strategy before trying again.',
    ];

    const sourceStrategyLines = [
        includeMemory ? 'When explaining existing memory or answering a user question, read the relevant memory files first. Write only when the user explicitly asks for changes, or when you confirm a real error or omission.' : '',
        includeMemory ? 'To verify memory against the RP source text, gather evidence with ChatHistory recent/range/grep first, then repair the file with MemoryRead or MemoryEdit.' : '',
        includeMemory ? 'Use MemoryGrep to ask whether a fact already exists in memory. Use ChatHistory grep to ask whether something happened in the RP source text. Match the search scope to the question.' : '',
        'If you know message order, use ChatHistory range. If you only know a keyword, use ChatHistory grep. If you only need recent continuity, use ChatHistory recent.',
        includeCartography ? 'When maintaining structured state, start with StateRead summary. Use elements or element when you need current ids; read document only when you truly need the full structure.' : '',
        includeCartography ? 'StateRead summary tells you whether the map is `uninitialized` or `active`, and whether this turn calls for initialization or incremental maintenance. Do not decide whether to read based only on your own guess about "whether anything changed." ' : '',
        includeCartography ? 'Structured state should record only confirmed changes from this turn. Unknown rooms, future routes, and unconfirmed details belong in pending judgment, not stable state.' : '',
        includeMemory ? 'Keep higher-level Markdown files clear. Update facts that still hold, and delete or move inbox items that are already resolved.' : '',
    ];

    const structuredStateLines = includeCartography ? [
        'State tools maintain structured spatial state for the current session. The default document is `tavern.map/main`. New sessions already include a seed map. Read StateRead first, inspect `meta.status` and `meta.hint`, then decide whether to initialize or maintain incrementally. Do not skip the read step.',
        'The map is a spatial relation view of the current scene, not a board of floating text labels. Your job is to project what already happened into a flat layout with boundaries, direction, focus, and proportion.',
        'When you read spatial information, answer these questions first: what defines the boundary, where are the entrances and exits, where is the current player or viewpoint focus, what occupies interactive space, and which directions remain unexplored.',
        'Place the most certain anchors first, such as outer room walls, a main road, a river, corridor edges, or the current location. Place other elements relative to those anchors.',
        'Use the default orientation north-up: north = smaller y, south = larger y, west = smaller x, east = larger x. If the narration only says left/right/front/back, choose a reasonable facing and keep it consistent inside one map.',
        'For indoor scenes, use an outer-wall rect as the anchor and place furniture and doors inside it. For outdoor scenes, use roads or rivers as the backbone and scatter buildings or terrain around them. For passage scenes, use two parallel boundary lines and a stretched `viewBox` aspect ratio.',
        '`meta.viewBox` is the camera. It does not move map elements. Move the player by changing the player `at`, then adjust `meta.viewBox` only if the camera should follow.',
        'If the map is still `uninitialized`, initialize it with one `meta + add` transaction as soon as the current turn clearly establishes a scene or place. First appearance does not require a prior "change".',
        'Initialization must include at least one spatial geometry element (`rect`, `circle`, `path`, `curve`, or `icon`) plus a player marker. `text` is only for short labels and cannot replace geometry. Name, `viewBox`, and labels alone are not a valid map.',
        'When a map already exists, use incremental `add` / `modify` / `remove` / `meta` updates for the same scene. Replace the whole map only when the story fully switches to a new scene. If nothing changes spatially, skip the map update. If you are unsure, do not change the map; write it to inbox instead.',
        'Common updates: character movement = modify `at`; discovering a door or route = add door/road; an item appearing = add icon + label; an item being taken away = remove; a door opening = modify style; a new danger = add danger; camera follow = meta viewBox.',
        'Keep at least 20 units of spacing between elements to avoid overlap. Place text labels 15-25 units beside what they describe instead of on top of the shape center.',
        'Before submitting, sanity-check the map: clear anchors, a clear focus, drawable elements, a well-defined `viewBox` as the camera, and enough geometry to carry the map body.',
        'The map should record only spatial facts that already happened and are worth visualizing. Uncertain spatial information goes to pending judgment first.',
    ] : [];

    const memoryToneLines = includeMemory ? [
        '写记忆像给未来的自己留清楚案卷：具体、克制、能承接，不写空泛总结。',
        '角色心理、秘密动机、未来计划只有在 RP 原文已经明确发生或确认时，才写成确定事实。',
        '区分“已发生”“用户要求”“管理员推测”“待确认”。推测和待确认只进 inbox，不进稳定状态。',
    ] : [];

    const outputLines = [
        '回复像电纸书完成文件操作后的交代：短、清楚、面向用户。',
        '说明本轮查证、写入、跳过或待判断的结果；没有实际改动时说明已检查和原因。',
        '工具参数、原始 JSON、完整 Markdown 和协议细节只在用户追问调试时展开。',
    ];

    const sections = [
        '# 小白酒馆后台管理员',
        '',
        joinSection('Role', roleLines),
        '',
        joinSection('Responsibilities', responsibilityLines),
        '',
        joinSection('Current Session', currentSessionLines),
        '',
        joinSection('Injected Context', injectedContextLines),
        fileDisciplineLines.length ? '\n' + joinSection('File Discipline', fileDisciplineLines) : '',
        '',
        joinSection('Work Loop', workLoopLines),
        '',
        joinSection('Source Strategy', sourceStrategyLines),
        structuredStateLines.length ? '\n' + joinSection('Structured State', structuredStateLines) : '',
        memoryToneLines.length ? '\n' + joinSection('Memory Tone', memoryToneLines) : '',
        '',
        joinSection('Output', outputLines),
    ].filter(Boolean);

    return sections.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeText(value: unknown = ''): string {
    return String(value || '').trim();
}

function joinLines(lines: string[] = []): string {
    return lines.join('\n').trim();
}

function buildDefaultAssistantPresetSections() {
    return {
        storyArcPrompt: buildDefaultStoryArcPrompt(),
        statePrompt: buildDefaultStatePrompt(),
        episodePrompt: buildDefaultEpisodePrompt(),
        inboxPrompt: buildDefaultInboxPrompt(),
    };
}

export function buildDefaultStoryArcPrompt(): string {
    return joinLines([
        '记录剧情为什么走到现在。',
        '保留长期方向、当前阶段、主要压力和仍在延续的未解决事项。',
        '不要写成逐回合流水。',
    ]);
}

export function buildDefaultStatePrompt(): string {
    return joinLines([
        '记录当前仍成立的事实和状态。',
        '保留人物状态、关系、地点、时间、物品和约束。',
        '已经过去且不再生效的临时事件不要长期保留。',
    ]);
}

export function buildDefaultEpisodePrompt(): string {
    return joinLines([
        '记录当前阶段或事件集团。',
        '阶段变化时，更新阶段标题、范围、摘要、关键变化和未解决事项。',
        '不要重复状态栏里已经写清楚的稳定事实。',
    ]);
}

export function buildDefaultInboxPrompt(): string {
    return joinLines([
        '暂放还不能判断或还没归档的问题。',
        '记录需要继续观察的线索、用户待办和管理员失败残留。',
        '确认后的内容及时迁出，不要长期堆在这里。',
    ]);
}

const SECTION_RESET_BASELINES = {
    storyArcPrompt: joinLines([
        '`memory/session.md` 写剧情脉络：这段关系或剧情为什么走到现在。',
        '保留长期方向、当前阶段、主要压力和仍在延续的未解决事项。',
        '这里不是流水账；高层脉络变化时更新这里，不把所有长期信息塞进 turns。',
    ]),
    statePrompt: joinLines([
        '`memory/state.md` 写当前仍成立的事实和状态。',
        '包括人物状态、关系、地点、时间、物品、约束，以及会影响后续承接的明确变化。',
        '这里回答“现在是什么”。已经过去且不再生效的瞬时事件不要长期堆在这里。',
    ]),
    episodePrompt: joinLines([
        '`memory/episodes/*.md` 写阶段/事件集团档案。',
        '是否新建、续写或回修阶段，由你根据原文和现有档案判断。',
        '阶段档案负责中层叙事单位：标题、范围、摘要、关键变化、未解决事项要自洽；不要代替 session.md，也不要重复 state.md。',
    ]),
    inboxPrompt: joinLines([
        '`memory/inbox.md` 是临时收件箱。',
        '放暂时无法归档、需要继续观察、上轮失败残留或仍待判断的问题。',
        '确认后的事实不要长期留在 inbox；该进入 session/state/episode 时就迁走。',
    ]),
};

function normalizeAssistantSectionText(value: unknown, fallback: string, resetDefaultText = ''): string {
    const text = normalizeText(value);
    if (!text || text === resetDefaultText) {return fallback;}
    return text;
}

function composeManagerSystemPrompt(
    input: Partial<TavernAssistantPreset> = {},
    options: TavernManagerPromptOptions = {},
): string {
    const { includeMemory } = normalizeManagerPromptOptions(options);
    const fallback = buildDefaultAssistantPresetSections();
    const sections = includeMemory ? [
        ['剧情脉络职责', normalizeText(input.storyArcPrompt) || fallback.storyArcPrompt],
        ['状态栏职责与字段格式', normalizeText(input.statePrompt) || fallback.statePrompt],
        ['阶段档案职责', normalizeText(input.episodePrompt) || fallback.episodePrompt],
        ['收件箱职责', normalizeText(input.inboxPrompt) || fallback.inboxPrompt],
    ].filter(([, content]) => content) : [];
    const lines = [buildFixedManagerSystemPrompt(options)];
    sections.forEach(([title, content]) => {
        lines.push('', `## ${title}`, String(content));
    });
    return lines.join('\n').trim();
}

export function buildTavernManagerSystemPrompt(
    input: Partial<TavernAssistantPreset> = {},
    options: TavernManagerPromptOptions = {},
): string {
    return composeManagerSystemPrompt(input, options);
}

export function buildDefaultMemoryManagerPrompt(): string {
    return composeManagerSystemPrompt(buildDefaultAssistantPresetSections());
}

export function createDefaultTavernAssistantPreset(): TavernAssistantPreset {
    const sections = buildDefaultAssistantPresetSections();
    return {
        id: DEFAULT_TAVERN_ASSISTANT_PRESET_ID,
        name: '默认助手预设',
        description: '记忆管理员的默认维护规则。',
        ...sections,
        memoryManagerPrompt: composeManagerSystemPrompt(sections),
    };
}

export function normalizeTavernAssistantPreset(input: AssistantPresetInput = {}): TavernAssistantPreset {
    const fallback = createDefaultTavernAssistantPreset();
    const id = normalizeText(input.id) || fallback.id;
    const name = normalizeText(input.name) || fallback.name;
    const normalized: TavernAssistantPreset = {
        id,
        name,
        description: String(input.description || ''),
        storyArcPrompt: normalizeAssistantSectionText(input.storyArcPrompt, fallback.storyArcPrompt, SECTION_RESET_BASELINES.storyArcPrompt),
        statePrompt: normalizeAssistantSectionText(input.statePrompt, fallback.statePrompt, SECTION_RESET_BASELINES.statePrompt),
        episodePrompt: normalizeAssistantSectionText(input.episodePrompt, fallback.episodePrompt, SECTION_RESET_BASELINES.episodePrompt),
        inboxPrompt: normalizeAssistantSectionText(input.inboxPrompt, fallback.inboxPrompt, SECTION_RESET_BASELINES.inboxPrompt),
        updatedAt: Number(input.updatedAt) || undefined,
    };
    normalized.memoryManagerPrompt = composeManagerSystemPrompt(normalized);
    return normalized;
}
