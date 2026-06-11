export type TavernContractTier = 'silent-operations' | 'fate-arbitration' | 'narrative-orchestration';

export type TavernContractPermissionKey =
    | 'memoryArchiving'
    | 'cartographyEngine'
    | 'actionChecks'
    | 'randomEncounters'
    | 'questOrchestration';

export interface TavernSessionContract {
    memoryArchiving: boolean;
    cartographyEngine: boolean;
    actionChecks: boolean;
    randomEncounters: boolean;
    questOrchestration: boolean;
}

export interface TavernContractManagerPromptOptions {
    includeMemory: boolean;
    includeCartography: boolean;
}

export interface TavernContractRuntimeCapability {
    includeMemoryFiles?: boolean;
    includeStructuredStates?: boolean;
    includeRandomEncounters?: boolean;
    automaticManagerWork?: boolean;
    managerPromptMemory?: boolean;
    managerPromptCartography?: boolean;
}

export interface TavernSessionContractRuntime {
    contract: TavernSessionContract;
    enabledKeys: TavernContractPermissionKey[];
    includeMemoryFiles: boolean;
    includeStructuredStates: boolean;
    includeRandomEncounters: boolean;
    hasAutomaticManagerWork: boolean;
    managerPromptOptions: TavernContractManagerPromptOptions;
}

export interface TavernContractMandateDefinition {
    key: TavernContractPermissionKey;
    tier: TavernContractTier;
    icon: string;
    title: string;
    summary: string;
    description: string;
}

export const DEFAULT_TAVERN_SESSION_CONTRACT: TavernSessionContract = {
    memoryArchiving: true,
    cartographyEngine: true,
    actionChecks: true,
    randomEncounters: false,
    questOrchestration: false,
};

export const TAVERN_SESSION_CONTRACT_KEYS: TavernContractPermissionKey[] = [
    'memoryArchiving',
    'cartographyEngine',
    'actionChecks',
    'randomEncounters',
    'questOrchestration',
];

export const TAVERN_CONTRACT_TIER_LABELS: Record<TavernContractTier, string> = {
    'silent-operations': 'Silent Operations',
    'fate-arbitration': 'Fate Arbitration',
    'narrative-orchestration': 'Narrative Orchestration',
};

export const TAVERN_CONTRACT_MANDATES: TavernContractMandateDefinition[] = [
    {
        key: 'memoryArchiving',
        tier: 'silent-operations',
        icon: '🧠',
        title: 'Memory Archiving',
        summary: '',
        description: 'Grant the Agent authority over your session\'s long-term memory. It will silently maintain, compress, and recall context on your behalf — ensuring the story never forgets.',
    },
    {
        key: 'cartographyEngine',
        tier: 'silent-operations',
        icon: '🗺️',
        title: 'Cartography Engine',
        summary: '',
        description: 'Allow the Agent to generate, update, and render spatial data as you explore. Regions, landmarks, and points of interest will materialize in the Appendix panel as the narrative unfolds.',
    },
    {
        key: 'actionChecks',
        tier: 'fate-arbitration',
        icon: '🎲',
        title: 'Action Checks',
        summary: '',
        description: 'When you attempt something uncertain — persuading a stranger, scaling a wall, deciphering a rune — the dice decide, not the AI. A true random roll arbitrates the outcome, and the story bends to fate.',
    },
    {
        key: 'randomEncounters',
        tier: 'fate-arbitration',
        icon: '⚔️',
        title: 'Random Encounters',
        summary: '',
        description: 'Permit the world to surprise you. At intervals, an unseen die rolls in the background. When it lands, the unexpected arrives — an ambush on the road, a strange omen in the sky, a letter slipped under your door.',
    },
    {
        key: 'questOrchestration',
        tier: 'narrative-orchestration',
        icon: '📜',
        title: 'Quest Orchestration',
        summary: '',
        description: 'Allow the Agent to weave structured quest arcs into the narrative. Objectives are tracked, updated, and resolved as the story progresses. A living quest log appears in the Appendix, evolving with your choices.',
    },
];

export const TAVERN_CONTRACT_RUNTIME_CAPABILITIES: Record<TavernContractPermissionKey, TavernContractRuntimeCapability> = {
    memoryArchiving: {
        includeMemoryFiles: true,
        automaticManagerWork: true,
        managerPromptMemory: true,
    },
    cartographyEngine: {
        includeStructuredStates: true,
        automaticManagerWork: true,
        managerPromptCartography: true,
    },
    actionChecks: {},
    randomEncounters: {
        includeRandomEncounters: true,
    },
    questOrchestration: {},
};

export function normalizeTavernSessionContract(value: unknown): TavernSessionContract {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
        memoryArchiving: 'memoryArchiving' in source ? Boolean(source.memoryArchiving) : DEFAULT_TAVERN_SESSION_CONTRACT.memoryArchiving,
        cartographyEngine: 'cartographyEngine' in source ? Boolean(source.cartographyEngine) : DEFAULT_TAVERN_SESSION_CONTRACT.cartographyEngine,
        actionChecks: 'actionChecks' in source ? Boolean(source.actionChecks) : DEFAULT_TAVERN_SESSION_CONTRACT.actionChecks,
        randomEncounters: 'randomEncounters' in source ? Boolean(source.randomEncounters) : DEFAULT_TAVERN_SESSION_CONTRACT.randomEncounters,
        questOrchestration: 'questOrchestration' in source ? Boolean(source.questOrchestration) : DEFAULT_TAVERN_SESSION_CONTRACT.questOrchestration,
    };
}

export function hasTavernSessionContractOverride(value: unknown): value is Partial<TavernSessionContract> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return false;}
    return TAVERN_SESSION_CONTRACT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function mergeTavernSessionContract(
    current: Partial<TavernSessionContract> | null | undefined,
    override: Partial<TavernSessionContract> | null | undefined,
): TavernSessionContract {
    return normalizeTavernSessionContract({
        ...normalizeTavernSessionContract(current),
        ...(hasTavernSessionContractOverride(override) ? override : {}),
    });
}

export function countActiveTavernSessionContract(value: Partial<TavernSessionContract> | null | undefined): number {
    const contract = normalizeTavernSessionContract(value);
    return Object.values(contract).filter(Boolean).length;
}

export function getTavernContractMandateDefinition(key: TavernContractPermissionKey): TavernContractMandateDefinition | undefined {
    return TAVERN_CONTRACT_MANDATES.find((mandate) => mandate.key === key);
}

export function resolveTavernSessionContractRuntime(
    value: Partial<TavernSessionContract> | null | undefined,
): TavernSessionContractRuntime {
    const contract = normalizeTavernSessionContract(value);
    const enabledKeys = TAVERN_SESSION_CONTRACT_KEYS.filter((key) => contract[key]);
    const runtime = enabledKeys.reduce<TavernSessionContractRuntime>((current, key) => {
        const capability = TAVERN_CONTRACT_RUNTIME_CAPABILITIES[key];
        if (!capability) {return current;}
        return {
            ...current,
            includeMemoryFiles: current.includeMemoryFiles || capability.includeMemoryFiles === true,
            includeStructuredStates: current.includeStructuredStates || capability.includeStructuredStates === true,
            includeRandomEncounters: current.includeRandomEncounters || capability.includeRandomEncounters === true,
            hasAutomaticManagerWork: current.hasAutomaticManagerWork || capability.automaticManagerWork === true,
            managerPromptOptions: {
                includeMemory: current.managerPromptOptions.includeMemory || capability.managerPromptMemory === true,
                includeCartography: current.managerPromptOptions.includeCartography || capability.managerPromptCartography === true,
            },
        };
    }, {
        contract,
        enabledKeys,
        includeMemoryFiles: false,
        includeStructuredStates: false,
        includeRandomEncounters: false,
        hasAutomaticManagerWork: false,
        managerPromptOptions: {
            includeMemory: false,
            includeCartography: false,
        },
    });
    return runtime;
}
