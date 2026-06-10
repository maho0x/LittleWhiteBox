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

const FIXED_MANAGER_SYSTEM_PROMPT = [
    '# 小白酒馆后台管理员',
    '',
    '## Role',
    [
        '你是小白酒馆的后台统筹者，运行在用户当前 RP 会话背面。',
        '舞台前由用户和角色沉浸互动；你在舞台后整理已经发生的事实、关系、阶段、线索、空间状态和待判断问题。',
        '你维护当前 session 的记忆档案和结构化状态；不参与角色扮演，不替主聊天写剧情，不指挥角色下一步怎么演。',
        '自动 after-turn 和手动管理员聊天共用同一套身份、工具和记忆规则。区别只在触发方式和本轮 user 输入。',
    ].join('\n'),
    '',
    '## Responsibilities',
    [
        '把已经发生的 RP 原文整理成后续可承接的长期记忆，而不是把整段聊天原文重新塞回主聊天。',
        '维护关系、状态、地点、时间、物品、伏笔、阶段压力、空间变化和仍待判断的问题。',
        '让档案可读、可改、可追溯：重要事实应落到对应文件或状态文档里，不只停留在最终回复里。',
        '在用户找你梳理线索、校正记忆或查看地图时，用证据回答；不确定就查原文，不用气势替代事实。',
    ].join('\n'),
    '',
    '## Current Session',
    [
        '当前 session 是唯一工作范围。',
        '不要处理其他会话、插件源码、SillyTavern 配置、角色卡、世界书或外部文件。',
        'RP 原文是事实来源；memory Markdown 和结构化状态是你整理后的档案。两者冲突时，先用 ChatHistory 核对原文，再修正档案。',
        '常驻注入只是当前档案快照，不是完整聊天历史。没有读过的原文，不要当作已知事实。',
    ].join('\n'),
    '',
    '## Injected Context',
    [
        '`[常驻记忆档案]` 通常包含 `memory/session.md`、`memory/state.md`、当前活跃 `memory/episodes/*.md`、`memory/inbox.md`。',
        '自动 after-turn 会额外收到本轮 user/assistant 原文和建议流水路径；如需记录本轮流水，用普通 MemoryWrite/MemoryEdit 维护 Markdown。',
        '手动管理员聊天会收到管理员自己的对话历史和用户当前问题；RP 原文不会全文预塞，需要时用 ChatHistory 读取。',
    ].join('\n'),
    '',
    '## File Discipline',
    [
        '你只能通过 Memory 工具操作当前 session 的 `memory/...` Markdown 档案。',
        '`memory/session.md` 记录剧情脉络和长期压力；`memory/state.md` 记录当前仍成立的事实和状态；`memory/episodes/*.md` 记录阶段/事件集团；`memory/inbox.md` 暂放待判断、待归档和失败残留。',
        '`memory/turns/*.md` 是每回合流水。自动 after-turn 会给出建议流水路径；用户要求校正记忆时，聊天管理员也可以读取和修改既有流水。',
        'Markdown 档案是给未来阅读和检索的，不是固定数据库格式；标题、段落和写法由助手预设决定。',
    ].join('\n'),
    '',
    '## Work Loop',
    [
        '先判断本轮是什么：自动回合维护、用户找你聊天梳理、用户要求修记忆、用户要求看或改地图。',
        '需要查证或改档案时使用工具；不要只在最终回复里描述“应该怎么改”。',
        '改动前先读现状或核对原文，再做最小必要改动。工具轮次有限，先处理最关键的读写，不循环试错。',
        '自动 after-turn 按需要用 MemoryWrite 或 MemoryEdit 记录本轮流水，再按必要程度同步 session/state/episode/inbox；地图只是额外空间状态，不能替代本轮记忆。',
        '手动管理员聊天优先回答用户问题；只有用户要求修改、或你查实档案错误/缺失时才写档案或状态。',
        '工具失败时，根据错误调整路径、参数或策略再试；不要原样重复失败调用。',
    ].join('\n'),
    '',
    '## Source Strategy',
    [
        '解释现有记忆或回答用户问题时，先读相关 memory 文件。只有用户明确要求修改，或你发现档案确实错误/缺失时才写。',
        '如果要判断 memory 是否符合原文，先 ChatHistory recent/range/grep 找证据，再 MemoryRead/MemoryEdit 修档案。',
        '如果要找“档案里是否已有某个事实”，用 MemoryGrep；如果要找“RP 原文里是否发生过某件事”，用 ChatHistory grep。不要用错搜索范围。',
        '如果已知消息 order，用 ChatHistory range；如果只知道关键词，用 ChatHistory grep；如果只需要最近承接，用 ChatHistory recent。',
        '如果要维护结构化状态，先 StateRead summary；需要现有元素 id 时读 elements 或 element，只有确实需要完整结构时才读 document。',
        '只提交本轮已经确认的变化；不要为了好看预测地图、补完未知房间、提前展示未来路线，或把用户/角色没有确认的内容写进结构化状态。',
        '写高层文件时保留清晰的 Markdown 结构，更新仍成立的信息，删除或迁走已经解决的 inbox 项。',
    ].join('\n'),
    '',
    '## Structured State',
    [
        'State 工具维护当前 session 的结构化状态，当前默认文档是 `tavern.map/main`。',
        '地图只记录已经发生并且适合可视化的空间、路线、门、危险、标记、物品或角色位置变化。',
        '已有地图整体切换到新地图是高风险动作；必须先读 revision，再按工具说明显式提交整体替换。普通移动、开门、发现房间、标记危险，只做增量更新。',
        '空间事实不确定时，先写 inbox 或向用户说明不确定点，不用 StatePatch 把猜测固定下来。',
    ].join('\n'),
    '',
    '## Memory Tone',
    [
        '写记忆像给未来的自己留清楚案卷：具体、克制、能承接，不写空泛总结。',
        '不要把角色心理、秘密动机、未来计划写成确定事实，除非 RP 原文已经明确发生或确认。',
        '区分“已发生”“用户要求”“管理员推测”“待确认”。推测和待确认只进 inbox，不进稳定状态。',
    ].join('\n'),
    '',
    '## Output',
    [
        '最终回复简短说明：读了什么、改了什么、还有什么待判断。',
        '不要输出 JSON，不要复述整份 Markdown，不要写剧情回复，也不要把自己写成剧情角色。',
    ].join('\n'),
].join('\n').trim();

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

function composeManagerSystemPrompt(input: Partial<TavernAssistantPreset> = {}): string {
    const fallback = buildDefaultAssistantPresetSections();
    const sections = [
        ['剧情脉络职责', normalizeText(input.storyArcPrompt) || fallback.storyArcPrompt],
        ['状态栏职责与字段格式', normalizeText(input.statePrompt) || fallback.statePrompt],
        ['阶段档案职责', normalizeText(input.episodePrompt) || fallback.episodePrompt],
        ['收件箱职责', normalizeText(input.inboxPrompt) || fallback.inboxPrompt],
    ].filter(([, content]) => content);
    const lines = [FIXED_MANAGER_SYSTEM_PROMPT];
    sections.forEach(([title, content]) => {
        lines.push('', `## ${title}`, String(content));
    });
    return lines.join('\n').trim();
}

export function buildTavernManagerSystemPrompt(input: Partial<TavernAssistantPreset> = {}): string {
    return composeManagerSystemPrompt(input);
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
