import type { Ref } from 'vue';
import { enhanceMarkdownContent, renderMarkdownToHtml } from '../../../../agent-core/ui/message-markdown.js';
import {
    normalizeActionCheckRenderGroups,
    type TavernActionCheckRenderGroup,
    type TavernActionCheckRuntimeEvent,
} from '../../../shared/runtime-events';

const TAVERN_IMAGE_MARKER_REGEX = /\[tavern-image:([a-z0-9\-_]+)\]/gi;

export interface TavernMarkdownToolsOptions {
    chatScrollRef: Ref<HTMLElement | null>;
    managerScrollRef: Ref<HTMLElement | null>;
    requestHost: (type: string, payload?: { payload?: object }) => Promise<{ result?: unknown } & Record<string, unknown>>;
}

export interface TavernRoleplayMarkdownOptions {
    roleplay?: boolean;
    userName?: string;
    characterName?: string;
}

const ROLEPLAY_FORMAT_TAGS = new Set(['details', 'summary']);

function normalizeDisplayName(value = '', fallback = '') {
    return String(value || '').trim() || fallback;
}

function replaceRoleplayMacros(text = '', options: TavernRoleplayMarkdownOptions = {}) {
    const userName = normalizeDisplayName(options.userName, 'User');
    const characterName = normalizeDisplayName(options.characterName, '角色');
    return String(text || '')
        .replace(/<\s*user\s*>/gi, userName)
        .replace(/<\s*(?:char|bot)\s*>/gi, characterName)
        .replace(/\{\{\s*user\s*\}\}/gi, userName)
        .replace(/\{\{\s*(?:char|bot)\s*\}\}/gi, characterName);
}

function stripRoleplayXmlTags(text = '') {
    return String(text || '').replace(/<\/?([a-z][\w:-]*)(?:\s[^<>]*)?>/gi, (match, tagName) => {
        const normalized = String(tagName || '').toLowerCase();
        return ROLEPLAY_FORMAT_TAGS.has(normalized) ? match : '';
    });
}

export function preprocessTavernRoleplayMarkdown(text = '', options: TavernRoleplayMarkdownOptions = {}) {
    const withMacros = replaceRoleplayMacros(text, options);
    const fenceRegex = /(^|\n)(`{3,}|~{3,})[ \t]*([^\n]*)\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;
    let result = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null = null;

    while ((match = fenceRegex.exec(withMacros)) !== null) {
        const leadingBreak = match[1] || '';
        const blockStart = match.index + leadingBreak.length;
        const fenceEnd = fenceRegex.lastIndex;
        result += stripRoleplayXmlTags(withMacros.slice(lastIndex, blockStart));
        result += withMacros.slice(blockStart, fenceEnd);
        lastIndex = fenceEnd;
    }

    result += stripRoleplayXmlTags(withMacros.slice(lastIndex));
    return result;
}

export function useTavernMarkdownTools(options: TavernMarkdownToolsOptions) {
    const markdownHtmlCache = new Map<string, string>();

    function markdownSignature(text = '') {
        const raw = String(text || '');
        let hash = 0;
        for (let index = 0; index < raw.length; index += 1) {
            hash = ((hash * 31) + raw.charCodeAt(index)) >>> 0;
        }
        return `${raw.length}:${hash.toString(36)}`;
    }

    function renderChatMarkdown(text = '', renderOptions: TavernRoleplayMarkdownOptions = {}) {
        // renderMarkdownToHtml keeps executable HTML fenced into iframe previews and
        // sanitizes ordinary Markdown before Vue inserts it into the chat DOM.
        const raw = renderOptions.roleplay
            ? preprocessTavernRoleplayMarkdown(text, renderOptions)
            : String(text || '');
        const canCache = !/(^|\n)(`{3,}|~{3,})[ \t]*(html|htm|xhtml|xml|svg|vue|svelte)?\b/i.test(raw)
            && !/^<!doctype\s+html/i.test(raw.trim())
            && !/^<html[\s>]/i.test(raw.trim());
        const cacheKey = markdownSignature(raw);
        if (canCache && markdownHtmlCache.has(cacheKey)) {
            return markdownHtmlCache.get(cacheKey) || '';
        }
        const html = renderMarkdownToHtml(raw);
        if (canCache && !html.includes('xb-markdown-html-placeholder')) {
            markdownHtmlCache.set(cacheKey, html);
            if (markdownHtmlCache.size > 160) {
                const firstKey = markdownHtmlCache.keys().next().value;
                if (firstKey) {markdownHtmlCache.delete(firstKey);}
            }
        }
        return html;
    }

    function stripTavernImageMarkers(text = '') {
        return String(text || '').replace(TAVERN_IMAGE_MARKER_REGEX, '').trim();
    }

    function clearMarkdownCache() {
        markdownHtmlCache.clear();
    }

    const dialogueQuotePairs: { [key: string]: string } = {
        '"': '"',
        '“': '”',
        '「': '」',
        '『': '』',
    };

    const dialogueQuoteOpeners = new Set(Object.keys(dialogueQuotePairs));
    const dialogueSkipTags = new Set(['A', 'BUTTON', 'CODE', 'KBD', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);
    const maxInlineDialogueLength = 600;

    function shouldSkipDialogueTextNode(node: Text) {
        let parent = node.parentElement;
        while (parent) {
            if (dialogueSkipTags.has(parent.tagName) || parent.classList.contains('xb-rp-dialogue')) {
                return true;
            }
            parent = parent.parentElement;
        }
        return false;
    }

    function collectDialogueRanges(text: string) {
        const ranges: Array<{ start: number; end: number }> = [];
        let cursor = 0;
        while (cursor < text.length) {
            const opener = text[cursor];
            if (!dialogueQuoteOpeners.has(opener)) {
                cursor += 1;
                continue;
            }
            const closer = dialogueQuotePairs[opener];
            let end = text.indexOf(closer, cursor + 1);
            if (end < 0 || end === cursor + 1 || end - cursor > maxInlineDialogueLength) {
                cursor += 1;
                continue;
            }
            const segment = text.slice(cursor + 1, end);
            if (segment.includes('\n') || !segment.trim()) {
                cursor += 1;
                continue;
            }
            ranges.push({ start: cursor, end: end + 1 });
            cursor = end + 1;
        }
        return ranges;
    }

    function enhanceRoleplayDialogue(root: HTMLElement) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const textNode = node as Text;
                if (!textNode.data || shouldSkipDialogueTextNode(textNode)) {
                    return NodeFilter.FILTER_REJECT;
                }
                return collectDialogueRanges(textNode.data).length
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_SKIP;
            },
        });
        const nodes: Text[] = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode as Text);
        }
        nodes.forEach((textNode) => {
            const ranges = collectDialogueRanges(textNode.data);
            if (!ranges.length) {return;}
            const fragment = document.createDocumentFragment();
            let cursor = 0;
            ranges.forEach((range) => {
                if (range.start > cursor) {
                    fragment.append(document.createTextNode(textNode.data.slice(cursor, range.start)));
                }
                const span = document.createElement('span');
                span.className = 'xb-rp-dialogue';
                span.textContent = textNode.data.slice(range.start, range.end);
                fragment.append(span);
                cursor = range.end;
            });
            if (cursor < textNode.data.length) {
                fragment.append(document.createTextNode(textNode.data.slice(cursor)));
            }
            textNode.replaceWith(fragment);
        });
    }

    function canHydrateTavernFigure(figure: HTMLElement, slotId = '') {
        return !!(
            figure
            && figure.isConnected !== false
            && String(figure.dataset.tavernImageSlot || '').trim() === slotId
        );
    }

    function hydrateTavernImageFigure(figure: HTMLElement) {
        const slotId = String(figure.dataset.tavernImageSlot || '').trim();
        if (!slotId || figure.dataset.tavernImageHydrating === 'true' || figure.dataset.tavernImageLoaded === 'true') {
            return;
        }
        figure.dataset.tavernImageHydrating = 'true';
        void options.requestHost('xb-tavern:draw-image', {
            payload: { slotId },
        })
            .then((response) => {
                if (!canHydrateTavernFigure(figure, slotId)) {return;}
                const result = (response.result || response) as Record<string, unknown>;
                figure.dataset.tavernImageHydrating = 'false';
                if (!result.hasData || !result.url) {
                    figure.classList.add('is-failed');
                    const placeholder = document.createElement('span');
                    placeholder.className = 'xb-tavern-image-placeholder';
                    placeholder.textContent = result.isFailed
                        ? String(result.errorMessage || '配图生成失败')
                        : '配图未找到';
                    figure.replaceChildren(placeholder);
                    return;
                }
                figure.classList.add('is-loaded');
                figure.dataset.tavernImageLoaded = 'true';
                const image = document.createElement('img');
                image.src = String(result.url || '');
                image.alt = result.tags ? `配图：${String(result.tags)}` : '配图';
                image.loading = 'lazy';
                figure.replaceChildren(image);
            })
            .catch(() => {
                if (!canHydrateTavernFigure(figure, slotId)) {return;}
                figure.dataset.tavernImageHydrating = 'false';
                figure.classList.add('is-failed');
                const placeholder = document.createElement('span');
                placeholder.className = 'xb-tavern-image-placeholder';
                placeholder.textContent = '配图加载失败';
                figure.replaceChildren(placeholder);
            });
    }

    function createTavernImageFigure(slotId = '') {
        const figure = document.createElement('span');
        figure.className = 'xb-tavern-image';
        figure.dataset.tavernImageSlot = slotId;
        const placeholder = document.createElement('span');
        placeholder.className = 'xb-tavern-image-placeholder';
        placeholder.textContent = '配图加载中';
        figure.append(placeholder);
        return figure;
    }

    function enhanceTavernImageMarkers(root: HTMLElement) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const textNode = node as Text;
                if (!textNode.data || !TAVERN_IMAGE_MARKER_REGEX.test(textNode.data)) {
                    TAVERN_IMAGE_MARKER_REGEX.lastIndex = 0;
                    return NodeFilter.FILTER_SKIP;
                }
                TAVERN_IMAGE_MARKER_REGEX.lastIndex = 0;
                const parent = textNode.parentElement;
                if (parent?.closest?.('a, button, code, kbd, pre, script, style, textarea, .xb-tavern-image')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const nodes: Text[] = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode as Text);
        }
        nodes.forEach((textNode) => {
            const text = textNode.data;
            TAVERN_IMAGE_MARKER_REGEX.lastIndex = 0;
            let match: RegExpExecArray | null;
            let lastIndex = 0;
            let replaced = false;
            const fragment = document.createDocumentFragment();
            while ((match = TAVERN_IMAGE_MARKER_REGEX.exec(text)) !== null) {
                replaced = true;
                if (match.index > lastIndex) {
                    fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
                }
                fragment.append(createTavernImageFigure(match[1] || ''));
                lastIndex = TAVERN_IMAGE_MARKER_REGEX.lastIndex;
            }
            if (!replaced) {return;}
            if (lastIndex < text.length) {
                fragment.append(document.createTextNode(text.slice(lastIndex)));
            }
            textNode.replaceWith(fragment);
        });
        root.querySelectorAll<HTMLElement>('[data-tavern-image-slot]').forEach((figure) => hydrateTavernImageFigure(figure));
    }

    function buildActionCheckAriaLabel(event: TavernActionCheckRuntimeEvent) {
        const outcome = event.success ? '判定成功' : '判定失败';
        const action = String(event.action || '').trim();
        return [
            `行动判定：${event.stat}。`,
            `掷骰 ${event.roll} 对抗难度 ${event.difficulty}。`,
            `${outcome}.`,
            action ? `行动意图：${action}。` : '',
        ].filter(Boolean).join(' ');
    }

    function createActionCheckCard(event: TavernActionCheckRuntimeEvent) {
        const card = document.createElement('span');
        card.className = `action-check-card ${event.success ? 'is-success' : 'is-failure'}`;
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', buildActionCheckAriaLabel(event));

        const head = document.createElement('span');
        head.className = 'action-check-card-head';

        const title = document.createElement('strong');
        title.textContent = event.stat;
        head.append(title);

        const outcome = document.createElement('span');
        outcome.className = 'action-check-card-outcome';
        outcome.textContent = event.success ? '判定成功' : '判定失败';
        head.append(outcome);

        const grid = document.createElement('span');
        grid.className = 'action-check-card-grid';
        [{
            className: 'action-check-card-roll',
            label: '掷骰',
            value: String(event.roll),
        }, {
            className: 'action-check-card-dc',
            label: '难度',
            value: String(event.difficulty),
        }].forEach((item) => {
            const cell = document.createElement('span');
            cell.className = item.className;
            const label = document.createElement('small');
            label.textContent = item.label;
            const value = document.createElement('strong');
            value.textContent = item.value;
            cell.append(label, value);
            grid.append(cell);
        });

        const copy = document.createElement('span');
        copy.className = 'action-check-card-copy';
        copy.textContent = event.action;

        card.append(head, grid, copy);
        return card;
    }

    function createActionCheckStack(events: TavernActionCheckRuntimeEvent[] = []) {
        const stack = document.createElement('span');
        stack.className = 'assistant-runtime-event-stack';
        stack.setAttribute('role', 'group');
        stack.setAttribute('aria-label', events.length > 1 ? `${events.length} action check results.` : 'Action check result.');
        events.forEach((event) => {
            stack.append(createActionCheckCard(event));
        });
        return stack;
    }

    function readActionCheckRenderGroups(value: unknown): TavernActionCheckRenderGroup[] {
        try {
            return normalizeActionCheckRenderGroups(JSON.parse(String(value || '[]')));
        } catch {
            return [];
        }
    }

    function enhanceActionCheckMarkers(root: HTMLElement) {
        const groups = readActionCheckRenderGroups(root.dataset.actionCheckGroups);
        if (!groups.length) {return;}
        const byMarker = new Map(groups.map((group) => [group.marker, group.events]));
        const markers = new Set(groups.map((group) => group.marker));
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const textNode = node as Text;
                if (!textNode.data) {
                    return NodeFilter.FILTER_SKIP;
                }
                const parent = textNode.parentElement;
                if (parent?.closest?.('a, button, code, kbd, pre, script, style, textarea, .assistant-runtime-event-stack')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return [...textNode.data].some((char) => markers.has(char))
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_SKIP;
            },
        });
        const nodes: Text[] = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode as Text);
        }
        nodes.forEach((textNode) => {
            const fragment = document.createDocumentFragment();
            let replaced = false;
            [...textNode.data].forEach((char) => {
                const events = byMarker.get(char);
                if (events?.length) {
                    fragment.append(createActionCheckStack(events));
                    replaced = true;
                    return;
                }
                fragment.append(document.createTextNode(char));
            });
            if (replaced) {
                textNode.replaceWith(fragment);
            }
        });
    }

    function enhanceChatMarkdown() {
        const root = options.chatScrollRef.value;
        if (!root?.querySelectorAll) {return;}
        root.querySelectorAll<HTMLElement>('.xb-tavern-markdown').forEach((node) => {
            const signature = node.dataset.markdownSignature || '';
            if (node.dataset.markdownEnhanced === signature) {return;}
            enhanceMarkdownContent(node, {
                codeBlockClassName: 'xb-tavern-codeblock',
                codeCopyClassName: 'xb-tavern-code-copy',
                flattenPreCode: true,
                htmlBlockMode: 'preview',
            });
            enhanceTavernImageMarkers(node);
            enhanceRoleplayDialogue(node);
            enhanceActionCheckMarkers(node);
            node.dataset.markdownEnhanced = signature;
        });
    }

    function enhanceManagerMarkdown() {
        const root = options.managerScrollRef.value;
        if (!root?.querySelectorAll) {return;}
        root.querySelectorAll<HTMLElement>('.xb-tavern-markdown').forEach((node) => {
            const signature = node.dataset.markdownSignature || '';
            if (node.dataset.markdownEnhanced === signature) {return;}
            enhanceMarkdownContent(node, {
                codeBlockClassName: 'xb-tavern-codeblock',
                codeCopyClassName: 'xb-tavern-code-copy',
                flattenPreCode: true,
            });
            node.dataset.markdownEnhanced = signature;
        });
    }

    return {
        clearMarkdownCache,
        enhanceChatMarkdown,
        enhanceManagerMarkdown,
        markdownSignature,
        renderChatMarkdown,
        stripTavernImageMarkers,
    };
}
