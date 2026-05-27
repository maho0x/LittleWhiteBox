const CONTEXT_RADIUS = 24;
const MIN_FLEXIBLE_WHITESPACE_CHARS = 24;

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

function buildCompactWhitespaceIndex(text = '') {
    let compact = '';
    const positions = [];
    let offset = 0;
    for (const char of String(text ?? '')) {
        const start = offset;
        offset += char.length;
        if (/\s/u.test(char)) continue;
        compact += normalizeEquivalentText(char);
        positions.push({ start, end: offset });
    }
    return { compact, positions };
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

function findFlexibleWhitespaceRanges(text = '', needle = '') {
    const haystack = buildCompactWhitespaceIndex(text);
    const target = buildCompactWhitespaceIndex(needle);
    if (target.compact.length < MIN_FLEXIBLE_WHITESPACE_CHARS) return [];
    if (!target.compact || target.compact === needle && haystack.compact === text) return [];
    return findAllRanges(haystack.compact, target.compact)
        .map((range) => {
            const first = haystack.positions[range.start];
            const last = haystack.positions[range.end - 1];
            if (!first || !last) return null;
            return {
                start: first.start,
                end: last.end,
                equivalent: true,
                flexibleWhitespace: true,
            };
        })
        .filter(Boolean);
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

function numberPreviewLines(lines = [], startLine = 1, limit = 8) {
    const selected = lines.slice(0, limit);
    const suffix = lines.length > limit ? '\n...' : '';
    return `${selected.map((line, index) => `${startLine + index}: ${line}`).join('\n')}${suffix}`;
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
    const equivalent = findEquivalentRanges(content, oldString);
    if (equivalent.length) return equivalent;
    return findFlexibleWhitespaceRanges(content, oldString);
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
        matchedBy: ranges.some((range) => range.flexibleWhitespace)
            ? 'flexible_whitespace'
            : ranges.some((range) => range.equivalent)
                ? 'punctuation_equivalent'
                : 'exact',
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

function buildEditFailure(error = '', message = '', suggestion = '', extra = {}) {
    return buildFailure(error, message, suggestion ? { suggestion, ...extra } : extra);
}

function hasActiveModeField(edit = {}, key = '') {
    if (!Object.hasOwn(edit, key)) return false;
    const value = edit[key];
    return value !== undefined && value !== null && value !== '';
}

function hasOldStringMode(edit = {}) {
    return hasActiveModeField(edit, 'oldString');
}

function hasLineRange(edit = {}) {
    return hasActiveModeField(edit, 'startLine') || hasActiveModeField(edit, 'endLine');
}

function hasInsertLine(edit = {}) {
    return hasActiveModeField(edit, 'insertAtLine');
}

function toPositiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : 0;
}

function splitFileLines(text = '') {
    return String(text ?? '').replace(/\r\n/g, '\n').split('\n');
}

function splitReplacementLines(text = '') {
    if (text === '') return [];
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const nonEmpty = lines.filter((line) => line.trim());
    const hasReadLineNumbers = nonEmpty.length > 0
        && nonEmpty.every((line) => /^\s*\d+:\s?/.test(line));
    return hasReadLineNumbers
        ? lines.map((line) => (line.trim() ? line.replace(/^\s*\d+:\s?/, '') : line))
        : lines;
}

function applyLineRangeEdits(content = '', editList = []) {
    const originalLines = splitFileLines(content);
    const results = new Array(editList.length);
    const normalized = editList.map((edit = {}, index) => {
        const startLine = toPositiveInteger(edit.startLine);
        const endLine = toPositiveInteger(edit.endLine);
        const newString = typeof edit.newString === 'string' ? edit.newString : String(edit.newString ?? '');
        const replacementLines = splitReplacementLines(newString);
        return {
            edit,
            index,
            startLine,
            endLine,
            newString,
            replacementLines,
        };
    });

    normalized.forEach((item) => {
        if (!item.startLine || !item.endLine) {
            results[item.index] = buildEditFailure(
                'invalid_line_range',
                'startLine and endLine must be positive integers',
                'Use line numbers from the latest Read result, with startLine <= endLine.',
            );
            return;
        }
        if (item.endLine < item.startLine) {
            results[item.index] = buildEditFailure(
                'invalid_line_range',
                'endLine must be greater than or equal to startLine',
                'Use an inclusive line range from the latest Read result.',
            );
            return;
        }
        if (item.endLine > originalLines.length) {
            results[item.index] = buildEditFailure(
                'line_range_out_of_bounds',
                `Line range ${item.startLine}-${item.endLine} is outside the file`,
                `Read the current file again. This file has ${originalLines.length} lines.`,
            );
        }
    });

    const sorted = normalized
        .slice()
        .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
    sorted.forEach((item, sortedIndex) => {
        if (results[item.index]) return;
        const previous = sorted[sortedIndex - 1];
        if (previous && !results[previous.index] && item.startLine <= previous.endLine) {
            results[previous.index] = buildEditFailure(
                'overlapping_line_ranges',
                `Line range ${previous.startLine}-${previous.endLine} overlaps ${item.startLine}-${item.endLine}`,
                'Merge overlapping line edits into one larger startLine/endLine replacement.',
            );
            results[item.index] = buildEditFailure(
                'overlapping_line_ranges',
                `Line range ${item.startLine}-${item.endLine} overlaps ${previous.startLine}-${previous.endLine}`,
                'Merge overlapping line edits into one larger startLine/endLine replacement.',
            );
        }
    });

    const nextLines = originalLines.slice();
    normalized
        .slice()
        .sort((left, right) => right.startLine - left.startLine || right.endLine - left.endLine)
        .forEach((item) => {
            if (results[item.index]) return;
            const oldLines = originalLines.slice(item.startLine - 1, item.endLine);
            nextLines.splice(item.startLine - 1, item.endLine - item.startLine + 1, ...item.replacementLines);
            results[item.index] = {
                ok: true,
                index: item.index,
                startLine: item.startLine,
                endLine: item.endLine,
                replacements: 1,
                matchedBy: 'line_range',
                oldPreview: numberPreviewLines(oldLines, item.startLine),
                newPreview: numberPreviewLines(item.replacementLines, item.startLine),
            };
        });

    const failedCount = results.filter((result) => result && !result.ok).length;
    const appliedCount = results.filter((result) => result && result.ok).length;
    return {
        ok: failedCount === 0,
        partial: appliedCount > 0 && failedCount > 0 ? true : undefined,
        content: nextLines.join('\n'),
        results,
    };
}

function getInsertableLineCount(content = '') {
    return content === '' ? 0 : splitFileLines(content).length;
}

function applyLineInsertEdits(content = '', editList = []) {
    const originalLines = content === '' ? [] : splitFileLines(content);
    const lineCount = getInsertableLineCount(content);
    const results = new Array(editList.length);
    const normalized = editList.map((edit = {}, index) => {
        const insertAtLine = toPositiveInteger(edit.insertAtLine);
        const newString = typeof edit.newString === 'string' ? edit.newString : String(edit.newString ?? '');
        const insertionLines = splitReplacementLines(newString);
        return {
            edit,
            index,
            insertAtLine,
            newString,
            insertionLines,
        };
    });

    normalized.forEach((item) => {
        if (!item.insertAtLine) {
            results[item.index] = buildEditFailure(
                'invalid_insert_line',
                'insertAtLine must be a positive integer',
                'Use a line number from the latest Read result. insertAtLine inserts before that line; totalLines + 1 appends to the end.',
            );
            return;
        }
        if (item.insertAtLine > lineCount + 1) {
            results[item.index] = buildEditFailure(
                'insert_line_out_of_bounds',
                `Insert line ${item.insertAtLine} is outside the file`,
                `Read the current file again. This file has ${lineCount} lines, so valid insertAtLine values are 1-${lineCount + 1}.`,
            );
            return;
        }
        if (!item.newString) {
            results[item.index] = buildEditFailure(
                'no_changes',
                'No changes to make',
                'Provide non-empty newString text to insert.',
            );
        }
    });

    const nextLines = originalLines.slice();
    normalized
        .slice()
        .sort((left, right) => right.insertAtLine - left.insertAtLine || right.index - left.index)
        .forEach((item) => {
            if (results[item.index]) return;
            nextLines.splice(item.insertAtLine - 1, 0, ...item.insertionLines);
            results[item.index] = {
                ok: true,
                index: item.index,
                insertAtLine: item.insertAtLine,
                replacements: 0,
                matchedBy: 'line_insert',
                newPreview: numberPreviewLines(item.insertionLines, item.insertAtLine),
            };
        });

    const failedCount = results.filter((result) => result && !result.ok).length;
    const appliedCount = results.filter((result) => result && result.ok).length;
    return {
        ok: failedCount === 0,
        partial: appliedCount > 0 && failedCount > 0 ? true : undefined,
        content: nextLines.join('\n'),
        results,
    };
}

function normalizeEditsInput(edits) {
    if (Array.isArray(edits)) {
        return { ok: true, edits, parsedFromString: false };
    }
    if (typeof edits === 'string') {
        const raw = edits.trim();
        if (!raw) {
            return {
                ok: false,
                error: 'edits_must_be_array',
                message: 'edits must be a JSON array, but received an empty string',
                suggestion: 'Pass edits as an array, not a quoted JSON string. Correct: "edits":[{"oldString":"old","newString":"new"}].',
            };
        }
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return {
                    ok: true,
                    edits: parsed,
                    parsedFromString: true,
                    warning: 'edits was provided as a JSON string and was parsed for compatibility. Pass edits as an array, not a quoted JSON string.',
                };
            }
            return {
                ok: false,
                error: 'edits_must_be_array',
                message: `edits must be a JSON array, but the JSON string parsed to ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
                suggestion: 'Pass edits directly as an array. Correct: "edits":[{"startLine":10,"endLine":50,"newString":"..."}]. Wrong: "edits":"[{\\"startLine\\":10,...}]".',
            };
        } catch (error) {
            return {
                ok: false,
                error: 'invalid_edits_json_string',
                message: `edits must be a JSON array, but received a string that is not valid JSON: ${error?.message || 'parse failed'}`,
                suggestion: 'Do not JSON-stringify edits. Pass an array value: "edits":[{"oldString":"old","newString":"new"}].',
            };
        }
    }
    if (edits === undefined || edits === null) {
        return {
            ok: false,
            error: 'missing_edits_array',
            message: 'edits is required and must be a JSON array, but it was missing',
            suggestion: 'Include an edits array with at least one item. Correct: "edits":[{"startLine":10,"endLine":50,"newString":"..."}].',
        };
    }
    return {
        ok: false,
        error: 'edits_must_be_array',
        message: `edits must be a JSON array, but received ${typeof edits}`,
        suggestion: 'Pass edits as an array, not an object/string. Correct: "edits":[{"oldString":"old","newString":"new"}].',
    };
}

export function applyTextEdits(content = '', edits) {
    let nextContent = String(content ?? '');
    const normalizedInput = normalizeEditsInput(edits);
    if (!normalizedInput.ok) {
        return {
            ok: false,
            content: nextContent,
            results: [buildEditFailure(
                normalizedInput.error,
                normalizedInput.message,
                normalizedInput.suggestion,
            )],
        };
    }
    const editList = normalizedInput.edits;
    const results = [];
    const previousNewStrings = [];
    let appliedCount = 0;

    if (!editList.length) {
        return {
            ok: false,
            content: nextContent,
            results: [buildEditFailure(
                'invalid_edits',
                'No edits provided',
                'Provide a non-empty edits array. For same-file multi-spot changes, put all replacements in this one Edit call.',
            )],
        };
    }

    const lineRangeCount = editList.filter((edit) => hasLineRange(edit)).length;
    const insertLineCount = editList.filter((edit) => hasInsertLine(edit)).length;
    const positionedEditCount = lineRangeCount + insertLineCount;
    if (positionedEditCount && editList.some((edit) => (
        hasOldStringMode(edit)
        || (hasLineRange(edit) && hasInsertLine(edit))
    ))) {
        return {
            ok: false,
            content: nextContent,
            results: [buildEditFailure(
                'mixed_edit_modes',
                'Do not mix oldString, line-range, and insertion fields in one edit item',
                'Use exactly one Edit mode per call: oldString/newString, startLine/endLine/newString, or insertAtLine/newString.',
            )],
        };
    }
    if (positionedEditCount && positionedEditCount !== editList.length) {
        return {
            ok: false,
            content: nextContent,
            results: [buildEditFailure(
                'mixed_edit_modes',
                'Do not mix Edit modes in one Edit call',
                'Use separate Edit calls for oldString replacements, line-range replacements, and insertAtLine insertions.',
            )],
        };
    }
    if (lineRangeCount && insertLineCount) {
        return {
            ok: false,
            content: nextContent,
            results: [buildEditFailure(
                'mixed_edit_modes',
                'Do not mix line-range edits with insertions in one Edit call',
                'Use one Edit call for startLine/endLine replacements, then a separate Edit call for insertAtLine insertions if needed.',
            )],
        };
    }
    if (lineRangeCount) {
        const result = applyLineRangeEdits(nextContent, editList);
        if (normalizedInput.warning) result.warning = normalizedInput.warning;
        return result;
    }
    if (insertLineCount) {
        const result = applyLineInsertEdits(nextContent, editList);
        if (normalizedInput.warning) result.warning = normalizedInput.warning;
        return result;
    }

    editList.forEach((edit = {}, index) => {
        const oldString = typeof edit.oldString === 'string' ? edit.oldString : String(edit.oldString ?? '');
        const newString = typeof edit.newString === 'string' ? edit.newString : String(edit.newString ?? '');
        const replaceAll = !!edit.replaceAll;

        if (oldString === newString) {
            results.push(buildEditFailure(
                'no_changes',
                'No changes to make',
                'Change newString or remove this edit item.',
            ));
            return;
        }

        const normalizedOldString = normalizeEquivalentText(oldString);
        if (oldString && previousNewStrings.some((previous) => (
            previous.includes(oldString)
            || normalizeEquivalentText(previous).includes(normalizedOldString)
        ))) {
            results.push(buildEditFailure(
                'old_string_matches_previous_new_string',
                'old_string is a substring of a new_string from a previous edit.',
                'This edit may match text inserted earlier in the same Edit call. Merge overlapping changes into one larger replacement, or read the updated file and run a later Edit.',
            ));
            return;
        }

        if (!oldString) {
            results.push(buildEditFailure(
                'empty_old_string',
                'oldString is empty; provide text to replace',
                'Use Write to create files. For Edit, provide the exact current fragment to replace, or use Write for a full rewrite.',
            ));
            return;
        }

        const ranges = findReplacementRanges(nextContent, oldString);
        if (!ranges.length) {
            results.push(buildEditFailure(
                'not_found',
                'String to replace not found in file',
                'Edit already retries long oldString values with common punctuation and whitespace differences ignored. If it still fails, Read the current file and copy the exact current text into oldString. If this overlaps another same-file edit, merge them into one larger replacement; for very large rewrites, use Write.',
            ));
            return;
        }

        if (ranges.length > 1 && !replaceAll) {
            results.push(buildEditFailure(
                'multiple_matches',
                `找到 ${ranges.length} 处匹配，需要更多上下文或使用 replaceAll`,
                'Use the returned line contexts to expand oldString with unique surrounding text, or set replaceAll: true only if every match should change.',
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
            matchedBy: applied.matchedBy,
        });
    });

    const failedCount = results.filter((result) => !result.ok).length;
    return {
        ok: failedCount === 0,
        partial: appliedCount > 0 && failedCount > 0 ? true : undefined,
        content: nextContent,
        results,
        warning: normalizedInput.warning,
    };
}
