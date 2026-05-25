const CONTEXT_RADIUS = 24;

const NORMALIZE_CHAR_MAP = new Map([
    ['“', '"'],
    ['”', '"'],
    ['＂', '"'],
    ['「', '"'],
    ['」', '"'],
    ['『', '"'],
    ['』', '"'],
    ['‘', "'"],
    ['’', "'"],
    ['，', ','],
    ['。', '.'],
    ['：', ':'],
    ['；', ';'],
    ['？', '?'],
    ['！', '!'],
    ['（', '('],
    ['）', ')'],
]);

function normalizeEquivalentText(text = '') {
    return Array.from(String(text ?? ''), (char) => NORMALIZE_CHAR_MAP.get(char) || char).join('');
}

function findAllRanges(text = '', needle = '') {
    if (!needle) return [];
    const ranges = [];
    let index = 0;
    while (index <= text.length) {
        const found = text.indexOf(needle, index);
        if (found < 0) break;
        ranges.push({ start: found, end: found + needle.length, equivalent: false });
        index = found + Math.max(needle.length, 1);
    }
    return ranges;
}

function findEquivalentRanges(text = '', needle = '') {
    const normalizedText = normalizeEquivalentText(text);
    const normalizedNeedle = normalizeEquivalentText(needle);
    if (!normalizedNeedle || normalizedNeedle === needle && normalizedText === text) return [];
    return findAllRanges(normalizedText, normalizedNeedle).map((range) => ({
        ...range,
        equivalent: true,
    }));
}

function lineNumberAt(text = '', index = 0) {
    let line = 1;
    const limit = Math.max(0, Math.min(index, text.length));
    for (let cursor = 0; cursor < limit; cursor += 1) {
        if (text[cursor] === '\n') line += 1;
    }
    return line;
}

function contextForRange(text = '', range = {}) {
    const start = Math.max(0, Number(range.start) - CONTEXT_RADIUS);
    const end = Math.min(text.length, Number(range.end) + CONTEXT_RADIUS);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ')}${suffix}`;
}

function buildMatches(text = '', ranges = []) {
    return ranges.slice(0, 8).map((range) => ({
        line: lineNumberAt(text, range.start),
        context: contextForRange(text, range),
    }));
}

function convertAlternatingQuotes(text = '', quotePattern = /"/g, open = '“', close = '”') {
    let nextOpen = true;
    return text.replace(quotePattern, () => {
        const replacement = nextOpen ? open : close;
        nextOpen = !nextOpen;
        return replacement;
    });
}

function adaptReplacementStyle(replacement = '', matchedText = '') {
    let next = String(replacement ?? '');
    if (/[“”]/.test(matchedText)) next = convertAlternatingQuotes(next, /"/g, '“', '”');
    else if (/[「」]/.test(matchedText)) next = convertAlternatingQuotes(next, /"/g, '「', '」');
    else if (/[『』]/.test(matchedText)) next = convertAlternatingQuotes(next, /"/g, '『', '』');

    if (/[‘’]/.test(matchedText)) next = convertAlternatingQuotes(next, /'/g, '‘', '’');
    if (matchedText.includes('，')) next = next.replaceAll(',', '，');
    if (matchedText.includes('。')) next = next.replaceAll('.', '。');
    if (matchedText.includes('：')) next = next.replaceAll(':', '：');
    if (matchedText.includes('；')) next = next.replaceAll(';', '；');
    if (matchedText.includes('？')) next = next.replaceAll('?', '？');
    if (matchedText.includes('！')) next = next.replaceAll('!', '！');
    if (matchedText.includes('（')) next = next.replaceAll('(', '（');
    if (matchedText.includes('）')) next = next.replaceAll(')', '）');
    return next;
}

function findReplacementRanges(content = '', oldString = '') {
    const exact = findAllRanges(content, oldString);
    if (exact.length) return exact;
    return findEquivalentRanges(content, oldString);
}

function applyRanges(content = '', ranges = [], newString = '') {
    let nextContent = content;
    const replacements = [];
    ranges
        .slice()
        .sort((left, right) => right.start - left.start)
        .forEach((range) => {
            const matchedText = content.slice(range.start, range.end);
            const replacement = range.equivalent ? adaptReplacementStyle(newString, matchedText) : newString;
            replacements.push(replacement);
            nextContent = `${nextContent.slice(0, range.start)}${replacement}${nextContent.slice(range.end)}`;
        });
    return {
        content: nextContent,
        replacements,
    };
}

function buildFailure(error = '', message = '', extra = {}) {
    return {
        ok: false,
        error,
        message,
        ...extra,
    };
}

export function applyTextEdits(content = '', edits = []) {
    let nextContent = String(content ?? '');
    const editList = Array.isArray(edits) ? edits : [];
    const results = [];
    const previousNewStrings = [];
    let appliedCount = 0;

    if (!editList.length) {
        return {
            ok: false,
            content: nextContent,
            results: [buildFailure('invalid_edits', 'No edits provided')],
        };
    }

    editList.forEach((edit = {}, index) => {
        const oldString = typeof edit.oldString === 'string' ? edit.oldString : String(edit.oldString ?? '');
        const newString = typeof edit.newString === 'string' ? edit.newString : String(edit.newString ?? '');
        const replaceAll = !!edit.replaceAll;

        if (oldString === newString) {
            results.push(buildFailure('no_changes', 'No changes to make'));
            return;
        }

        const normalizedOldString = normalizeEquivalentText(oldString);
        if (oldString && previousNewStrings.some((previous) => (
            previous.includes(oldString)
            || normalizeEquivalentText(previous).includes(normalizedOldString)
        ))) {
            results.push(buildFailure(
                'old_string_matches_previous_new_string',
                'old_string is a substring of a new_string from a previous edit.',
            ));
            return;
        }

        if (!oldString) {
            if (nextContent) {
                results.push(buildFailure('empty_old_string', 'oldString is empty; provide text to replace'));
                return;
            }
            nextContent = newString;
            previousNewStrings.push(newString);
            appliedCount += 1;
            results.push({
                ok: true,
                index,
                replacements: 1,
                created: true,
            });
            return;
        }

        const ranges = findReplacementRanges(nextContent, oldString);
        if (!ranges.length) {
            results.push(buildFailure('not_found', 'String to replace not found in file'));
            return;
        }

        if (ranges.length > 1 && !replaceAll) {
            results.push(buildFailure(
                'multiple_matches',
                `找到 ${ranges.length} 处匹配，需要更多上下文或使用 replaceAll`,
                { matches: buildMatches(nextContent, ranges) },
            ));
            return;
        }

        const selectedRanges = replaceAll ? ranges : ranges.slice(0, 1);
        const applied = applyRanges(nextContent, selectedRanges, newString);
        nextContent = applied.content;
        previousNewStrings.push(...applied.replacements);
        appliedCount += 1;
        results.push({
            ok: true,
            index,
            replacements: selectedRanges.length,
        });
    });

    const failedCount = results.filter((result) => !result.ok).length;
    return {
        ok: failedCount === 0,
        partial: appliedCount > 0 && failedCount > 0 ? true : undefined,
        content: nextContent,
        results,
    };
}
