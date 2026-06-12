import type { TavernContractManagerPromptOptions } from './session-contract';

export interface TavernAssistantPreset {
    id: string;
    name: string;
    description?: string;
    storyArcPrompt: string;
    statePrompt: string;
    turnPrompt: string;
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
        includeMemory ? 'memory Markdown files' : '',
        includeCartography ? 'structured spatial state' : '',
    ].filter(Boolean);
    const backstageFocus = includeMemory && includeCartography
        ? 'facts, continuity, long-lived state, turn notes, and spatial state.'
        : includeMemory
            ? 'facts, continuity, long-lived state, and turn notes.'
            : includeCartography
                ? 'spatial boundaries, positions, routes, and scene geometry.'
                : 'evidence and session context.';
    const maintenanceScope = includeMemory && includeCartography
        ? 'Maintain continuity, state, places, time, possessions, hooks, turn notes, and spatial changes when they actually matter.'
        : includeMemory
            ? 'Maintain continuity, state, places, time, possessions, hooks, and turn notes when they actually matter.'
            : includeCartography
                ? 'Maintain the current scene map with boundaries, routes, positions, and hazards.'
                : 'Help the user inspect backstage materials with evidence when asked.';
    const evidenceLine = includeMemory && includeCartography
        ? 'When the user asks about memory, continuity, or the map, answer with evidence. If uncertain, check source text instead of bluffing.'
        : includeMemory
            ? 'When the user asks about memory or continuity, answer with evidence. If uncertain, check source text instead of bluffing.'
            : includeCartography
                ? 'When the user asks about the map or spatial state, answer with evidence. If uncertain, check source text instead of bluffing.'
                : 'When the user asks about backstage materials, answer with evidence. If uncertain, check source text instead of bluffing.';

    const roleLines = [
        'You are the backstage steward for the current LittleWhiteTavern RP session.',
        `The user and character stay on stage; you organize what has already happened behind the stage: ${backstageFocus}`,
        managedSurfaces.length
            ? `You maintain the current session's ${managedSurfaces.join(' and ')}. The main RP chat handles immersion; you turn source text into materials that can be retrieved, corrected, and carried forward.`
            : 'The main RP chat handles immersion; you help inspect backstage evidence and explain current context when asked.',
        'Automatic after-turn runs and manual manager chat share the same identity and evidence standard. Only the trigger and this-turn input differ.',
    ];

    const responsibilityLines = [
        includeMemory ? 'Condense already-happened RP source text into durable memory instead of dumping whole chat logs back into the prompt.' : '',
        maintenanceScope,
        managedSurfaces.length
            ? 'Keep records readable, editable, and traceable. Important facts should land in files or state docs, not only in your final reply.'
            : 'Use evidence first. Read source text or existing records before answering when verification matters.',
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
        includeMemory ? '`[Resident Memory Files]` usually contains `memory/session.md` and `memory/state.md`.' : '',
        includeMemory ? 'Automatic after-turn runs also receive this turn\'s user/assistant source text and a suggested turn-note path. If this turn needs a turn file, maintain it with normal MemoryWrite or MemoryEdit Markdown updates.' : '',
        'Manual manager chat receives the manager\'s own conversation history and the current user question. RP source text is not fully preloaded; use ChatHistory when needed.',
    ];

    const fileDisciplineLines = includeMemory ? [
        'You may operate on current-session `memory/...` Markdown files only through Memory tools.',
        '`memory/session.md` tracks long-running plot continuity and pressure. `memory/state.md` tracks facts and states that still hold. `memory/turns/*.md` are lightweight per-turn notes and history fallback, not another durable summary layer.',
        'Automatic after-turn runs receive a suggested turn-note path. When the user asks to correct memory, manager chat may also read and modify existing turn files.',
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
        includeMemory ? 'In automatic after-turn runs, create or update the suggested turn note when useful, then sync `memory/session.md` and `memory/state.md` only when the turn changed durable continuity or durable state.' : '',
        includeMemory && includeCartography ? 'The map is extra spatial state. It does not replace written memory, and turn notes do not replace durable memory.' : '',
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
        includeCartography ? 'Structured state should record only confirmed spatial changes from this turn. Unknown rooms, future routes, and unconfirmed details should stay unwritten until the RP actually confirms them.' : '',
        includeMemory ? 'Keep durable Markdown files clear. Update facts that still hold, and do not write uncertain claims as if they were settled facts.' : '',
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
        'When a map already exists, use incremental `add` / `modify` / `remove` / `meta` updates for the same scene. Replace the whole map only when the story fully switches to a new scene. If nothing changes spatially, skip the map update. If you are unsure, do not change the map yet.',
        'Common updates: character movement = modify `at`; discovering a door or route = add door/road; an item appearing = add icon + label; an item being taken away = remove; a door opening = modify style; a new danger = add danger; camera follow = meta viewBox.',
        'Keep at least 20 units of spacing between elements to avoid overlap. Place text labels 15-25 units beside what they describe instead of on top of the shape center.',
        'Before submitting, sanity-check the map: clear anchors, a clear focus, drawable elements, a well-defined `viewBox` as the camera, and enough geometry to carry the map body.',
        'The map should record only spatial facts that already happened and are worth visualizing. Uncertain spatial information stays unwritten until confirmed.',
    ] : [];

    const memoryToneLines = includeMemory ? [
        'Write memory like a case file for your future self: specific, restrained, and easy to carry forward.',
        'Character psychology, secrets, and future plans become facts only after the RP source text clearly establishes them.',
        'Separate what happened, what the user requested, what you inferred, and what is still unconfirmed. Only established facts belong in durable memory.',
    ] : [];

    const outputLines = [
        'Reply like an ebook file-operation confirmation: short, clear, and user-facing.',
        'Say what you verified, wrote, skipped, or left unchanged this turn. If nothing changed, say that you checked and why.',
        'Only expand tool arguments, raw JSON, full Markdown, or protocol details when the user explicitly asks for debugging detail.',
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
        turnPrompt: buildDefaultTurnPrompt(),
    };
}

export function buildDefaultStoryArcPrompt(): string {
    return joinLines([
        'Use `memory/session.md` for why the story has reached the current point.',
        'Keep long-running direction, current pressure, and unresolved threads that still matter later.',
        'Do not turn it into a turn-by-turn log.',
    ]);
}

export function buildDefaultStatePrompt(): string {
    return joinLines([
        'Use `memory/state.md` for facts and states that are still true right now.',
        'Keep character state, relationships, places, time, possessions, and ongoing constraints.',
        'Do not keep transient events after they stop being true.',
    ]);
}

export function buildDefaultTurnPrompt(): string {
    return joinLines([
        'Use `memory/turns/*.md` for lightweight per-turn notes and history fallback.',
        'Capture what this turn changed, revealed, or set up, so very long stories remain recoverable even if chat history becomes inaccessible.',
        'Do not duplicate durable facts that already belong in `memory/session.md` or `memory/state.md`.',
    ]);
}

const SECTION_RESET_BASELINES = {
    storyArcPrompt: joinLines([
        '`memory/session.md` writes why the story has reached the current point.',
        'Keep long-running direction, current pressure, and unresolved threads that still matter later.',
        'This is not a turn log. Update it when higher-level continuity changes instead of stuffing all long-term information into turns.',
    ]),
    statePrompt: joinLines([
        '`memory/state.md` writes facts and states that are still true right now.',
        'Include character state, relationships, places, time, possessions, constraints, and clear changes that still affect later turns.',
        'This answers "what is true now." Do not keep transient events after they stop being true.',
    ]),
    turnPrompt: joinLines([
        '`memory/turns/*.md` writes lightweight per-turn notes.',
        'Use it as long-story history fallback: what changed, what was revealed, and what was set up this turn.',
        'Do not turn turn notes into a second durable summary layer, and do not repeat settled facts already captured in session or state.',
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
        ['Story Arc Duties', normalizeText(input.storyArcPrompt) || fallback.storyArcPrompt],
        ['State Duties and Format', normalizeText(input.statePrompt) || fallback.statePrompt],
        ['Turn Notes Duties', normalizeText(input.turnPrompt) || fallback.turnPrompt],
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
        turnPrompt: normalizeAssistantSectionText(input.turnPrompt, fallback.turnPrompt, SECTION_RESET_BASELINES.turnPrompt),
        updatedAt: Number(input.updatedAt) || undefined,
    };
    normalized.memoryManagerPrompt = composeManagerSystemPrompt(normalized);
    return normalized;
}
