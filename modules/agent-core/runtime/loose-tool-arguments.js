function stripLooseJsonValue(value = '') {
    let text = String(value ?? '').trim();
    if (text.endsWith(',')) text = text.slice(0, -1).trimEnd();
    if (text.startsWith('\\"')) text = text.slice(2);
    if (text.endsWith('\\"')) text = text.slice(0, -2);
    if (text.startsWith('"')) text = text.slice(1);
    if (text.endsWith('"')) text = text.slice(0, -1);
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

function escapeRegExp(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findLooseKeyMatch(text = '', key = '', fromIndex = 0) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])(?:\\\\?")?${escapeRegExp(key)}(?:\\\\?")?\\s*:`, 'i');
    const slice = String(text || '').slice(Math.max(0, fromIndex));
    const match = slice.match(pattern);
    if (!match || match.index === undefined) return null;
    const index = Math.max(0, fromIndex) + match.index;
    return {
        key,
        index,
        end: index + match[0].length,
    };
}

function findNextLooseKeyMatch(text = '', keys = [], fromIndex = 0) {
    return keys
        .map((key) => findLooseKeyMatch(text, key, fromIndex))
        .filter(Boolean)
        .sort((left, right) => left.index - right.index)[0] || null;
}

export function extractLooseField(text = '', key = '', nextKeys = []) {
    const source = String(text || '');
    const match = findLooseKeyMatch(source, key);
    if (!match) return undefined;
    let valueStart = match.end;
    while (/\s/.test(source[valueStart] || '')) valueStart += 1;
    const quoted = source[valueStart] === '"';
    if (quoted) valueStart += 1;
    const nextMatch = findNextLooseKeyMatch(source, nextKeys.filter((item) => item !== key), valueStart);
    let valueEnd = nextMatch ? nextMatch.index : source.length;
    if (nextMatch) {
        const commaBeforeNextKey = source.lastIndexOf(',', nextMatch.index);
        if (commaBeforeNextKey >= valueStart) valueEnd = commaBeforeNextKey;
    }
    let rawValue = source.slice(valueStart, valueEnd).trim();
    if (!nextMatch) {
        rawValue = rawValue.replace(/\}\s*$/, '').trimEnd();
    }
    return stripLooseJsonValue(rawValue);
}

function parseLoosePrimitive(value = '') {
    const text = String(value ?? '').trim();
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
    if (/^true$/i.test(text)) return true;
    if (/^false$/i.test(text)) return false;
    if (/^null$/i.test(text)) return null;
    return stripLooseJsonValue(text);
}

const LOOSE_ARGUMENT_KEYS_BY_TOOL = {
    Read: ['filePath', 'path', 'scope', 'fromLine', 'toLine', 'tail', 'outputMode', 'contentFormat'],
    Write: ['filePath', 'path', 'content'],
    Edit: ['filePath', 'path', 'edits'],
    Delete: ['filePath', 'path'],
    Move: ['fromPath', 'toPath', 'filePath', 'path'],
    RenameBook: ['title', 'name'],
    ImportMaterial: ['title', 'content', 'source'],
    Glob: ['pattern', 'path', 'scope'],
    Grep: ['pattern', 'path', 'scope', 'outputMode'],
    WebSearch: ['query', 'maxResults'],
    DelegateRun: ['task'],
    PlanCreate: ['title', 'details', 'priority', 'owner', 'blockedBy'],
    PlanUpdate: ['id', 'status', 'details', 'priority', 'owner', 'blockedBy'],
    PlanList: ['status'],
    apply_patch: ['patchText'],
};

const GENERIC_LOOSE_ARGUMENT_KEYS = [
    'filePath',
    'path',
    'fromPath',
    'toPath',
    'content',
    'edits',
    'patchText',
    'query',
    'task',
    'title',
    'details',
    'pattern',
    'scope',
    'status',
    'priority',
    'owner',
    'blockedBy',
    'fromLine',
    'toLine',
    'tail',
    'maxResults',
    'outputMode',
    'contentFormat',
];

function extractFirstLooseField(source = '', keys = [], nextKeys = []) {
    for (const key of keys) {
        const value = extractLooseField(source, key, nextKeys);
        if (value !== undefined) return value;
    }
    return undefined;
}

function parseKnownLooseArgumentsObject(source = '', toolName = '') {
    if (toolName === 'Write') {
        const args = {};
        const filePath = extractFirstLooseField(source, ['filePath', 'path'], ['content']);
        const content = extractLooseField(source, 'content', []);
        if (filePath !== undefined) args.filePath = parseLoosePrimitive(filePath);
        if (content !== undefined) args.content = parseLoosePrimitive(content);
        return Object.keys(args).length ? args : null;
    }

    if (toolName === 'Edit') {
        const args = {};
        const filePath = extractFirstLooseField(source, ['filePath', 'path'], ['edits']);
        const edits = extractLooseField(source, 'edits', []);
        if (filePath !== undefined) args.filePath = parseLoosePrimitive(filePath);
        if (edits !== undefined) args.edits = parseLoosePrimitive(edits);
        return Object.keys(args).length ? args : null;
    }

    return null;
}

export function parseLooseArgumentsObject(text = '', toolName = '') {
    const source = String(text || '').trim();
    if (!source) return null;
    try {
        const parsed = JSON.parse(source);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
        // Fall through to key-based recovery.
    }
    const knownParsed = parseKnownLooseArgumentsObject(source, toolName);
    if (knownParsed) return knownParsed;
    const keys = LOOSE_ARGUMENT_KEYS_BY_TOOL[toolName] || GENERIC_LOOSE_ARGUMENT_KEYS;
    const args = {};
    keys.forEach((key, index) => {
        const value = extractLooseField(source, key, keys.slice(index + 1));
        if (value === undefined) return;
        args[key] = parseLoosePrimitive(value);
    });
    return Object.keys(args).length ? args : null;
}

export function repairLooseToolArguments(text = '', toolName = '') {
    const parsed = parseLooseArgumentsObject(text, toolName);
    return parsed ? JSON.stringify(parsed) : '';
}
