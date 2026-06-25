import type { Ref } from 'vue';
import { enhanceMarkdownContent, renderMarkdownToHtml } from '../../../../agent-core/ui/message-markdown.js';
import { postToIframe } from '../../../../../core/iframe-messaging.js';
import { getIframeBaseScript, getWrapperScript } from '../../../../../core/wrapper-inline.js';
import {
    normalizeActionCheckRenderGroups,
    type TavernActionCheckRenderGroup,
    type TavernActionCheckRuntimeEvent,
} from '../../../shared/runtime-events';

const TAVERN_IMAGE_MARKER_REGEX = /\[tavern-image:([a-z0-9\-_]+)\]/gi;
const TAVERN_INLINE_IMAGE_TOKEN_REGEX = /\[(?:img|图片)\s*:\s*([^\]]+)\]/gi;
export const TAVERN_INLINE_IMAGE_PROGRESS_EVENT = 'xb-tavern:inline-image-progress';

export interface TavernMarkdownToolsOptions {
    chatScrollRef: Ref<HTMLElement | null>;
    managerScrollRef: Ref<HTMLElement | null>;
    managerWorkRef?: Ref<HTMLElement | null>;
    htmlRenderEnabled: Ref<boolean>;
    htmlThemeDark: Ref<boolean>;
    alertDialog: (options: { title?: string; message?: string; confirmText?: string; tone?: 'default' | 'danger' | 'warning' } | string) => Promise<void>;
    confirmDialog: (options: { title?: string; message?: string; confirmText?: string; cancelText?: string; tone?: 'default' | 'danger' | 'warning' } | string) => Promise<boolean>;
    requestHost: (type: string, payload?: { payload?: object }) => Promise<{ result?: unknown } & Record<string, unknown>>;
    getHtmlFrameAvatarUrls?: () => { user?: string; char?: string };
    showToast?: (message: string, options?: { tone?: 'info' | 'warning' | 'danger'; durationMs?: number }) => void;
}

export interface TavernRoleplayMarkdownOptions {
    roleplay?: boolean;
    userName?: string;
    characterName?: string;
}

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

export function preprocessTavernRoleplayMarkdown(text = '', options: TavernRoleplayMarkdownOptions = {}) {
    return replaceRoleplayMacros(text, options);
}

const TAVERN_HTML_IFRAME_SELECTOR = 'iframe.xb-tavern-html-iframe';
const TAVERN_HTML_PRE_SELECTOR = 'pre[data-xb-tavern-html-final="true"]';
const TAVERN_HTML_GENERATE_RELAY_TIMEOUT_MS = 300_000;
const TAVERN_HTML_CODE_LANGUAGES = new Set(['html', 'htm', 'xhtml', 'xml', 'svg', 'vue', 'svelte']);
const TAVERN_HTML_FRAGMENT_START_REGEX = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:style|link|meta|svg|iframe|canvas|img|video|audio|picture|div|section|main|article|header|footer|nav|aside|p|span|button|input|textarea|select|label|ul|ol|li|table|thead|tbody|tr|td|th|form|figure|figcaption|details|summary|dialog|h[1-6])\b/i;
const TAVERN_HTML_GENERATE_RESPONSE_TYPES = new Set([
    'generatePromptPreview',
    'generateStreamStart',
    'generateStreamChunk',
    'generateStreamComplete',
    'generateStreamError',
    'generateResult',
    'generateError',
]);

function extractTavernExternalHtmlUrl(content = '') {
    const trimmed = String(content || '').trim();
    if (!trimmed) {return null;}
    if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {return trimmed;}
    const match = trimmed.match(/<!--\s*xb-src:\s*(https?:\/\/[^\s>]+)\s*-->/i);
    return match ? match[1] : null;
}

function djb2(text = '') {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
    }
    return (hash >>> 0).toString(16);
}

function looksLikeTavernHtmlFrameContent(html = '') {
    const text = String(html || '').trim();
    if (!text) {return false;}
    if (extractTavernExternalHtmlUrl(text)) {return true;}
    const lower = text.toLowerCase();
    return lower.includes('<!doctype')
        || lower.includes('<html')
        || lower.includes('<script')
        || TAVERN_HTML_FRAGMENT_START_REGEX.test(text);
}

function buildTavernHtmlResourceHints(html = '') {
    const urls = Array.from(new Set((String(html || '').match(/https?:\/\/[^"'()\s]+/gi) || [])
        .map((url) => {
            try {
                return new URL(url).origin;
            } catch {
                return '';
            }
        })
        .filter(Boolean)));
    let hints = '';
    urls.slice(0, 6).forEach((origin) => {
        hints += `<link rel="dns-prefetch" href="${origin}">`;
        hints += `<link rel="preconnect" href="${origin}" crossorigin>`;
    });
    const font = (String(html || '').match(/https?:\/\/[^"'()\s]+\.(?:woff2|woff|ttf|otf)/i) || [])[0];
    if (font) {
        const type = font.endsWith('.woff2') ? 'font/woff2' : font.endsWith('.woff') ? 'font/woff' : font.endsWith('.ttf') ? 'font/ttf' : 'font/otf';
        hints += `<link rel="preload" as="font" href="${font}" type="${type}" crossorigin fetchpriority="high">`;
    }
    const css = (String(html || '').match(/https?:\/\/[^"'()\s]+\.css/i) || [])[0];
    if (css) {
        hints += `<link rel="preload" as="style" href="${css}" crossorigin fetchpriority="high">`;
    }
    const image = (String(html || '').match(/https?:\/\/[^"'()\s]+\.(?:png|jpg|jpeg|webp|gif|svg)/i) || [])[0];
    if (image) {
        hints += `<link rel="preload" as="image" href="${image}" crossorigin fetchpriority="high">`;
    }
    return hints;
}

function getTavernHtmlTheme(themeDark = false) {
    return themeDark ? 'dark' : 'light';
}

function buildTavernHtmlThemeBootstrap(theme: 'dark' | 'light') {
    return `<meta name="color-scheme" content="${theme}"><style id="xb-tavern-html-theme">:root{color-scheme:${theme}}</style><script>(function(){try{var r=document.documentElement;r.dataset.xbTavernTheme='${theme}';r.classList.add('xb-tavern-theme-${theme}');r.style.colorScheme='${theme}';}catch(_){}})();</script>`;
}

function buildTavernHtmlOpeningTag(theme: 'dark' | 'light') {
    return `<html data-xb-tavern-theme="${theme}" class="xb-tavern-theme-${theme}" style="color-scheme:${theme}">`;
}

function applyTavernHtmlThemeAttributes(documentHtml = '', theme: 'dark' | 'light') {
    const themedClass = `xb-tavern-theme-${theme}`;
    return String(documentHtml || '').replace(/<html\b([^>]*)>/i, (_match, rawAttributes = '') => {
        let attributes = String(rawAttributes || '').replace(/\sdata-xb-tavern-theme=(?:"[^"]*"|'[^']*'|[^\s>]*)/i, '');
        if (/\sclass\s*=/.test(attributes)) {
            attributes = attributes.replace(/(\sclass\s*=\s*)(["'])(.*?)\2/i, (_classMatch, prefix, quote, value) => `${prefix}${quote}${String(value || '').trim()} ${themedClass}${quote}`);
        } else {
            attributes += ` class="${themedClass}"`;
        }
        if (/\sstyle\s*=/.test(attributes)) {
            attributes = attributes.replace(/(\sstyle\s*=\s*)(["'])(.*?)\2/i, (_styleMatch, prefix, quote, value) => `${prefix}${quote}${String(value || '').replace(/;\s*$/, '')};color-scheme:${theme}${quote}`);
        } else {
            attributes += ` style="color-scheme:${theme}"`;
        }
        attributes += ` data-xb-tavern-theme="${theme}"`;
        return `<html${attributes}>`;
    });
}

function buildTavernWrappedHtml(html = '', themeDark = false) {
    const source = String(html || '');
    const scripts = `<script>${getWrapperScript()}${getIframeBaseScript()}</script>`;
    const headHints = buildTavernHtmlResourceHints(source);
    const theme = getTavernHtmlTheme(themeDark);
    const themeBootstrap = buildTavernHtmlThemeBootstrap(theme);
    const vhFix = '<style>html,body{height:auto!important;min-height:0!important;max-height:none!important}.profile-container,[style*="100vh"]{height:auto!important;min-height:600px!important}[style*="height:100%"]{height:auto!important;min-height:100%!important}</style>';
    const injection = `${themeBootstrap}${scripts}${headHints}${vhFix}`;
    if (source.includes('<html') && source.includes('</html')) {
        const themedSource = applyTavernHtmlThemeAttributes(source, theme);
        if (themedSource.includes('<head>')) {
            return themedSource.replace('<head>', `<head>${injection}`);
        }
        if (themedSource.includes('</head>')) {
            return themedSource.replace('</head>', `${injection}</head>`);
        }
        return themedSource.replace('<body', `<head>${injection}</head><body`);
    }
    return `<!DOCTYPE html>
${buildTavernHtmlOpeningTag(theme)}
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${injection}
<style>html,body{margin:0;padding:0;background:transparent}</style>
</head>
<body>${source}</body></html>`;
}

export function useTavernMarkdownTools(options: TavernMarkdownToolsOptions) {
    const markdownHtmlCache = new Map<string, string>();
    const htmlGenerateRelays = new Map<string, { iframe: HTMLIFrameElement; targetOrigin: string; timeoutId: number }>();
    const htmlIframeHeights = new WeakMap<HTMLIFrameElement, number>();
    const htmlIframeHeightFrames = new WeakMap<HTMLIFrameElement, number>();

    function isHiddenMarkdownNode(node: Element | null) {
        return !node || !!node.closest('[hidden], [aria-hidden="true"]');
    }

    function canEnhanceMarkdownRoot(node: Element | null): node is HTMLElement {
        return !!node && !isHiddenMarkdownNode(node);
    }

    function canAutoLoadInlineImageSlot(slot: HTMLElement | null): slot is HTMLElement {
        return !!(
            slot
            && slot.isConnected !== false
            && !isHiddenMarkdownNode(slot)
            && !slot.closest('.streaming, .pending-user')
        );
    }

    function markdownSignature(text = '') {
        const raw = String(text || '');
        let hash = 0;
        for (let index = 0; index < raw.length; index += 1) {
            hash = ((hash * 31) + raw.charCodeAt(index)) >>> 0;
        }
        return `${raw.length}:${hash.toString(36)}`;
    }

    function renderChatMarkdown(text = '', renderOptions: TavernRoleplayMarkdownOptions = {}) {
        const raw = renderOptions.roleplay
            ? preprocessTavernRoleplayMarkdown(text, renderOptions)
            : String(text || '');
        const markdownOptions = renderOptions.roleplay ? { htmlFenceMode: 'code', protectRawHtmlBoundaries: false } : {};
        const canCache = !/(^|\n)(`{3,}|~{3,})[ \t]*(html|htm|xhtml|xml|svg|vue|svelte)?\b/i.test(raw)
            && !renderOptions.roleplay;
        const cacheKey = markdownSignature(raw);
        if (canCache && markdownHtmlCache.has(cacheKey)) {
            return markdownHtmlCache.get(cacheKey) || '';
        }
        const html = renderMarkdownToHtml(raw, markdownOptions);
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
        return String(text || '')
            .replace(TAVERN_IMAGE_MARKER_REGEX, '')
            .replace(TAVERN_INLINE_IMAGE_TOKEN_REGEX, '')
            .trim();
    }

    function clearMarkdownCache() {
        markdownHtmlCache.clear();
    }

    function getTavernHtmlIframeForSource(source: MessageEventSource | null): HTMLIFrameElement | null {
        if (!source) {return null;}
        const roots = [options.chatScrollRef.value, options.managerScrollRef.value, options.managerWorkRef?.value].filter(Boolean) as HTMLElement[];
        for (const root of roots) {
            const frames = Array.from(root.querySelectorAll<HTMLIFrameElement>(TAVERN_HTML_IFRAME_SELECTOR));
            const match = frames.find((iframe) => iframe.contentWindow === source);
            if (match) {return match;}
        }
        return null;
    }

    function getTavernHtmlMessageTargetOrigin(origin: string | null | undefined) {
        const value = String(origin || '').trim();
        return value && value !== 'null' ? value : '*';
    }

    function cloneTavernHtmlMessagePayload<T>(payload: T): T {
        try {
            return JSON.parse(JSON.stringify(payload)) as T;
        } catch {
            return payload;
        }
    }

    function postToTavernHtmlIframe(iframe: HTMLIFrameElement, payload: Record<string, unknown>, targetOrigin = window.location.origin) {
        postToIframe(iframe, payload, undefined, getTavernHtmlMessageTargetOrigin(targetOrigin));
    }

    function postToParentGenerateService(payload: Record<string, unknown>) {
        const safePayload = cloneTavernHtmlMessagePayload(payload);
        // eslint-disable-next-line no-restricted-syntax -- Tavern HTML iframe callGenerate relay to the top-level service.
        window.parent?.postMessage(safePayload, window.location.origin);
    }

    function deleteTavernHtmlGenerateRelay(id: string) {
        const relay = htmlGenerateRelays.get(id);
        if (!relay) {return false;}
        window.clearTimeout(relay.timeoutId);
        htmlGenerateRelays.delete(id);
        return true;
    }

    function clearTavernHtmlGenerateRelaysForIframe(iframe: HTMLIFrameElement) {
        Array.from(htmlGenerateRelays.entries()).forEach(([id, relay]) => {
            if (relay.iframe === iframe) {
                deleteTavernHtmlGenerateRelay(id);
            }
        });
    }

    function clearAllTavernHtmlGenerateRelays() {
        Array.from(htmlGenerateRelays.keys()).forEach((id) => {
            deleteTavernHtmlGenerateRelay(id);
        });
    }

    function isTavernGenerateRelayResponse(data: Record<string, unknown>) {
        return data.source === 'xiaobaix-host'
            && typeof data.id === 'string'
            && TAVERN_HTML_GENERATE_RESPONSE_TYPES.has(String(data.type || ''));
    }

    function handleTavernGenerateRelayResponse(data: Record<string, unknown>) {
        const id = String(data.id || '');
        const relay = htmlGenerateRelays.get(id);
        if (!relay) {return false;}
        postToTavernHtmlIframe(relay.iframe, data, relay.targetOrigin);
        const type = String(data.type || '');
        if (type === 'generateResult'
            || type === 'generateError'
            || type === 'generateStreamComplete'
            || type === 'generateStreamError') {
            deleteTavernHtmlGenerateRelay(id);
        }
        return true;
    }

    function rememberTavernHtmlGenerateRelay(id: string, iframe: HTMLIFrameElement, targetOrigin: string) {
        deleteTavernHtmlGenerateRelay(id);
        const timeoutId = window.setTimeout(() => {
            const relay = htmlGenerateRelays.get(id);
            if (relay?.iframe === iframe) {
                htmlGenerateRelays.delete(id);
            }
        }, TAVERN_HTML_GENERATE_RELAY_TIMEOUT_MS);
        htmlGenerateRelays.set(id, { iframe, targetOrigin, timeoutId });
    }

    function removeTavernHtmlWrapper(wrapper: Element | null | undefined) {
        if (!wrapper?.classList.contains('xb-tavern-html-wrapper')) {return;}
        const iframe = wrapper.querySelector<HTMLIFrameElement>(TAVERN_HTML_IFRAME_SELECTOR);
        if (iframe) {
            clearTavernHtmlGenerateRelaysForIframe(iframe);
            const frameId = htmlIframeHeightFrames.get(iframe);
            if (frameId) {
                window.cancelAnimationFrame(frameId);
                htmlIframeHeightFrames.delete(iframe);
            }
            htmlIframeHeights.delete(iframe);
        }
        wrapper.remove();
    }

    function applyTavernHtmlIframeHeight(iframe: HTMLIFrameElement, height: unknown, force = false) {
        const next = Math.max(0, Number(height) || 0);
        if (next < 1) {return;}
        const rounded = Math.ceil(next);
        const previous = htmlIframeHeights.get(iframe) || 0;
        if (!force && Math.abs(rounded - previous) < 1) {return;}
        htmlIframeHeights.set(iframe, rounded);
        const previousFrame = htmlIframeHeightFrames.get(iframe);
        if (previousFrame) {
            window.cancelAnimationFrame(previousFrame);
        }
        const frameId = window.requestAnimationFrame(() => {
            htmlIframeHeightFrames.delete(iframe);
            if (!iframe.isConnected) {return;}
            iframe.style.height = `${rounded}px`;
        });
        htmlIframeHeightFrames.set(iframe, frameId);
    }

    function probeTavernHtmlIframe(iframe: HTMLIFrameElement, delay = 0) {
        const send = () => {
            try {
                postToIframe(iframe, { type: 'probe' }, undefined, window.location.origin);
            } catch {
                // Height probes are best effort; the iframe base script also reports on load/resize.
            }
        };
        if (delay > 0) {
            window.setTimeout(send, delay);
            return;
        }
        send();
    }

    function handleTavernHtmlIframeMessage(event: MessageEvent) {
        const topData = event.data && typeof event.data === 'object'
            ? event.data as Record<string, unknown>
            : {};
        if (event.source === window.parent && isTavernGenerateRelayResponse(topData)) {
            handleTavernGenerateRelayResponse(topData);
            return;
        }
        const iframe = getTavernHtmlIframeForSource(event.source);
        if (!iframe) {return;}
        const replyOrigin = getTavernHtmlMessageTargetOrigin(event.origin);
        const data = event.data && typeof event.data === 'object'
            ? event.data as Record<string, unknown>
            : {};
        if (typeof data.height === 'number') {
            applyTavernHtmlIframeHeight(iframe, data.height, !!data.force);
            return;
        }
        if (data.type === 'getAvatars') {
            const urls = options.getHtmlFrameAvatarUrls?.() || {};
            postToTavernHtmlIframe(iframe, {
                source: 'xiaobaix-host',
                type: 'avatars',
                urls: {
                    user: String(urls.user || ''),
                    char: String(urls.char || ''),
                },
            }, replyOrigin);
            return;
        }
        if (data.type === 'runCommand') {
            const id = String(data.id || '');
            const command = String(data.command || '');
            void options.requestHost('xb-tavern:run-slash-command', { payload: { command } })
                .then((response) => {
                    const result = (response.result || response) as Record<string, unknown>;
                    postToTavernHtmlIframe(iframe, {
                        source: 'xiaobaix-host',
                        type: 'commandResult',
                        id,
                        result,
                    }, replyOrigin);
                })
                .catch((error) => {
                    postToTavernHtmlIframe(iframe, {
                        source: 'xiaobaix-host',
                        type: 'commandError',
                        id,
                        error: error instanceof Error ? error.message : String(error || 'slash_command_failed'),
                    }, replyOrigin);
                });
            return;
        }
        if (data.type === 'generateRequest') {
            const id = String(data.id || '');
            if (!id) {return;}
            rememberTavernHtmlGenerateRelay(id, iframe, replyOrigin);
            postToParentGenerateService({
                type: 'generateRequest',
                id,
                options: data.options && typeof data.options === 'object' ? data.options : {},
            });
        }
    }

    function cleanupTavernHtmlPre(pre: HTMLPreElement) {
        const previous = pre.previousElementSibling;
        removeTavernHtmlWrapper(previous);
        pre.style.display = '';
        delete pre.dataset.xbTavernHtmlFinal;
        delete pre.dataset.xbTavernHtmlHash;
        delete pre.dataset.xbTavernHtmlPending;
    }

    async function fetchTavernExternalHtml(url: string) {
        try {
            const response = await fetch(url, { mode: 'cors' });
            if (response.ok) {return await response.text();}
        } catch {
            // Match the body renderer: CORS fetch failure falls back to direct iframe navigation.
        }
        return null;
    }

    async function replaceTavernHtmlRenderVariables(html = '') {
        const source = String(html || '');
        if (!source.includes('{{xbgetvar::')) {return source;}
        try {
            const response = await options.requestHost('xb-tavern:replace-html-render-vars', { payload: { html: source } });
            const result = response.result && typeof response.result === 'object'
                ? response.result as Record<string, unknown>
                : response as Record<string, unknown>;
            return typeof result.html === 'string' ? result.html : source;
        } catch (error) {
            console.warn('[LittleWhiteBox Tavern] xbgetvar macro replacement failed:', error);
            return source;
        }
    }

    async function loadTavernExternalHtmlUrl(iframe: HTMLIFrameElement, url: string) {
        try {
            iframe.srcdoc = '<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100px;color:#888;font-family:sans-serif;background:transparent">加载中...</body></html>';

            let html = await fetchTavernExternalHtml(url);
            if (html) {
                html = await replaceTavernHtmlRenderVariables(html);
                iframe.srcdoc = buildTavernWrappedHtml(html, options.htmlThemeDark.value);
                probeTavernHtmlIframe(iframe, 100);
                return;
            }

            iframe.removeAttribute('srcdoc');
            iframe.src = url;
            iframe.style.minHeight = '800px';
            iframe.setAttribute('scrolling', 'auto');
        } catch (error) {
            console.error('[LittleWhiteBox Tavern] external HTML preview failed:', error);
            iframe.removeAttribute('srcdoc');
            iframe.src = url;
            iframe.style.minHeight = '800px';
            iframe.setAttribute('scrolling', 'auto');
        }
    }

    async function loadTavernHtmlIframeContent(iframe: HTMLIFrameElement, html = '') {
        const source = String(html || '');
        const externalUrl = extractTavernExternalHtmlUrl(source);
        if (externalUrl) {
            await loadTavernExternalHtmlUrl(iframe, externalUrl);
            return;
        }
        const replaced = await replaceTavernHtmlRenderVariables(source);
        iframe.srcdoc = buildTavernWrappedHtml(replaced, options.htmlThemeDark.value);
        probeTavernHtmlIframe(iframe);
    }

    function renderTavernHtmlPre(pre: HTMLPreElement, html = '', hash = '') {
        const previous = pre.previousElementSibling;
        removeTavernHtmlWrapper(previous);
        const wrapper = document.createElement('div');
        wrapper.className = 'xb-tavern-html-wrapper';
        const iframe = document.createElement('iframe');
        iframe.className = 'xb-tavern-html-iframe';
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('scrolling', 'no');
        iframe.loading = 'eager';
        iframe.style.cssText = 'width:100%;border:none;background:transparent;overflow:hidden;height:0;margin:0;padding:0;display:block;contain:layout paint style;will-change:height;min-height:50px';
        wrapper.append(iframe);
        pre.parentNode?.insertBefore(wrapper, pre);
        pre.style.display = 'none';
        pre.dataset.xbTavernHtmlFinal = 'true';
        pre.dataset.xbTavernHtmlHash = hash;
        delete pre.dataset.xbTavernHtmlPending;
        void loadTavernHtmlIframeContent(iframe, html);
    }

    function hidePendingTavernHtmlPreviews(root: HTMLElement) {
        if (!options.htmlRenderEnabled.value) {return;}
        root.querySelectorAll<HTMLElement>('pre > code').forEach((codeBlock) => {
            const pre = codeBlock.parentElement as HTMLPreElement | null;
            if (!pre || pre.dataset.xbTavernHtmlFinal === 'true') {return;}
            if (!isExplicitTavernHtmlCodeBlock(codeBlock)) {return;}
            pre.style.display = 'none';
            pre.dataset.xbTavernHtmlPending = 'true';
        });
    }

    function enhanceTavernHtmlCodeBlocks(root: HTMLElement) {
        if (!canEnhanceMarkdownRoot(root)) {return;}
        root.querySelectorAll<HTMLPreElement>(TAVERN_HTML_PRE_SELECTOR).forEach((pre) => {
            if (!options.htmlRenderEnabled.value) {
                cleanupTavernHtmlPre(pre);
            }
        });
        root.querySelectorAll<HTMLElement>('pre > code').forEach((codeBlock) => {
            const pre = codeBlock.parentElement as HTMLPreElement | null;
            if (!pre) {return;}
            if (!isExplicitTavernHtmlCodeBlock(codeBlock)) {
                cleanupTavernHtmlPre(pre);
                return;
            }
            const html = codeBlock.textContent || '';
            if (!looksLikeTavernHtmlFrameContent(html)) {
                cleanupTavernHtmlPre(pre);
                return;
            }
            if (!options.htmlRenderEnabled.value) {
                cleanupTavernHtmlPre(pre);
                return;
            }
            const hash = djb2(html);
            const externalUrl = extractTavernExternalHtmlUrl(html);
            const wrapper = pre.previousElementSibling;
            const same = pre.dataset.xbTavernHtmlFinal === 'true'
                && pre.dataset.xbTavernHtmlHash === hash
                && wrapper?.classList.contains('xb-tavern-html-wrapper')
                && !!wrapper.querySelector(TAVERN_HTML_IFRAME_SELECTOR);
            if (!externalUrl && same) {return;}
            renderTavernHtmlPre(pre, html, hash);
        });
    }

    function isExplicitTavernHtmlCodeBlock(codeBlock: HTMLElement) {
        return Array.from(codeBlock.classList).some((className) => {
            const normalized = String(className || '').replace(/^custom-/, '').replace(/^language-/, '').toLowerCase();
            return TAVERN_HTML_CODE_LANGUAGES.has(normalized);
        });
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
            && !isHiddenMarkdownNode(figure)
            && String(figure.dataset.tavernImageSlot || '').trim() === slotId
        );
    }

    function toTavernImageResult(response: Record<string, unknown>) {
        return (response.result || response) as Record<string, unknown>;
    }

    function getTavernImageCharacterPrompts(result: Record<string, unknown>): Array<Record<string, unknown>> {
        return Array.isArray(result.characterPrompts)
            ? result.characterPrompts.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
            : [];
    }

    function appendTavernImageEditGroup(
        container: HTMLElement,
        options: { label: string; value: string; type: string; index?: number },
    ): HTMLTextAreaElement {
        const group = document.createElement('span');
        group.className = 'xb-tavern-image-edit-group';

        const label = document.createElement('span');
        label.className = 'xb-tavern-image-edit-group-label';
        label.textContent = options.label;
        group.append(label);

        const textarea = document.createElement('textarea');
        textarea.className = 'xb-tavern-image-edit-input';
        textarea.dataset.type = options.type;
        if (typeof options.index === 'number') {
            textarea.dataset.index = String(options.index);
        }
        textarea.value = options.value;
        group.append(textarea);

        container.append(group);
        return textarea;
    }

    function renderTavernImageEditFields(editScroll: HTMLElement, result: Record<string, unknown>): HTMLTextAreaElement {
        editScroll.replaceChildren();
        const sceneInput = appendTavernImageEditGroup(editScroll, {
            label: '场景',
            value: String(result.tags || ''),
            type: 'scene',
        });

        getTavernImageCharacterPrompts(result).forEach((character, index) => {
            appendTavernImageEditGroup(editScroll, {
                label: String(character.name || `角色 ${index + 1}`),
                value: String(character.prompt || ''),
                type: 'char',
                index,
            });
        });

        return sceneInput;
    }

    function buildTavernImageEditPanel(
        figure: HTMLElement,
        slotId: string,
        result: Record<string, unknown>,
        panelOptions: { inline?: boolean; saveLabel?: string; retryAfterSave?: boolean; onToggle?: (open: boolean) => void } = {},
    ) {
        const editPanel = document.createElement('span');
        editPanel.className = 'xb-tavern-image-edit';
        if (panelOptions.inline) {
            editPanel.classList.add('is-inline');
        }
        editPanel.style.display = 'none';

        const editLabel = document.createElement('span');
        editLabel.className = 'xb-tavern-image-edit-label';
        editLabel.textContent = '编辑 TAG（场景描述）';

        const editScroll = document.createElement('span');
        editScroll.className = 'xb-tavern-image-edit-scroll';

        const editActions = document.createElement('span');
        editActions.className = 'xb-tavern-image-edit-actions';
        [
            { action: 'save-tags', label: panelOptions.saveLabel || '保存 TAG' },
            { action: 'cancel-edit', label: '取消' },
        ].forEach((item) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.action = item.action;
            button.textContent = item.label;
            editActions.append(button);
        });
        editPanel.append(editLabel, editScroll, editActions);

        const setOpen = (open: boolean) => {
            editPanel.style.display = open ? 'block' : 'none';
            panelOptions.onToggle?.(open);
        };

        const openEditor = () => {
            const sceneInput = renderTavernImageEditFields(editScroll, result);
            setOpen(true);
            sceneInput.focus();
        };

        editPanel.addEventListener('click', (event) => {
            const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-action]');
            if (!target) {return;}
            event.preventDefault();
            event.stopPropagation();
            const action = target.dataset.action || '';
            if (action === 'cancel-edit') {
                setOpen(false);
                editScroll.replaceChildren();
                return;
            }
            if (action === 'save-tags') {
                void (async () => {
                    const sceneInput = editPanel.querySelector<HTMLTextAreaElement>('textarea[data-type="scene"]');
                    const tags = String(sceneInput?.value || '').trim();
                    if (!tags) {
                        await options.alertDialog({
                            title: '缺少场景 TAG',
                            message: '场景 TAG 不能为空',
                        });
                        return;
                    }
                    const characterPrompts = collectTavernImageEditCharacterPrompts(editPanel, result);
                    setTavernImageBusy(figure, true);
                    const runSave = async () => {
                        const editResponse = await options.requestHost('xb-tavern:draw-image-edit', {
                            payload: { slotId, tags, characterPrompts },
                        });
                        if (panelOptions.retryAfterSave) {
                            // Mirrors the main body's failed-state "save-tags-retry": persist the
                            // edited tags first, then regenerate. The host writes a new failed
                            // placeholder on regeneration failure, so a rejected refresh is the
                            // transport-level fallback — re-render with the edited tags regardless.
                            try {
                                const refreshResponse = await options.requestHost('xb-tavern:draw-image-refresh', {
                                    payload: { slotId },
                                });
                                await refreshTavernImageFigure(figure, slotId, refreshResponse);
                            } catch {
                                await refreshTavernImageFigure(figure, slotId, editResponse);
                            }
                            return;
                        }
                        await refreshTavernImageFigure(figure, slotId, editResponse);
                    };
                    void runSave().catch(() => setTavernImageBusy(figure, false));
                })();
            }
        });

        return { editPanel, openEditor };
    }

    function collectTavernImageEditCharacterPrompts(
        editPanel: HTMLElement,
        result: Record<string, unknown>,
    ): Array<Record<string, unknown>> | null {
        const original = getTavernImageCharacterPrompts(result);
        const charInputs = Array.from(editPanel.querySelectorAll<HTMLTextAreaElement>('textarea[data-type="char"]'));
        if (!charInputs.length || !original.length) {return null;}

        const nextPrompts: Array<Record<string, unknown>> = [];
        charInputs.forEach((input) => {
            const index = Math.floor(Number(input.dataset.index));
            const source = Number.isFinite(index) ? original[index] : null;
            if (source) {
                nextPrompts.push({ ...source, prompt: input.value.trim() });
            }
        });
        return nextPrompts;
    }

    function setTavernImageBusy(figure: HTMLElement, busy: boolean) {
        figure.classList.toggle('is-busy', busy);
        figure.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
            button.disabled = busy
                || button.dataset.navDisabled === 'true'
                || button.dataset.editDisabled === 'true';
        });
    }

    function describeTavernImageRefreshError(error: unknown) {
        const raw = error instanceof Error ? error.message : String(error || 'unknown_error');
        return raw.replace(/^xb-tavern:draw-image-refresh:\s*/, '').trim() || 'unknown_error';
    }

    function showTavernImageRefreshError(error: unknown) {
        options.showToast?.(`重绘失败：${describeTavernImageRefreshError(error)}`, {
            tone: 'warning',
            durationMs: 4200,
        });
    }

    function closeTavernImageMenus(root: ParentNode = document) {
        root.querySelectorAll<HTMLElement>('.xb-tavern-image-menu.is-open').forEach((menu) => menu.classList.remove('is-open'));
    }

    function closeTavernImageGallery() {
        document.getElementById('xb-tavern-image-gallery-overlay')?.remove();
    }

    async function refreshTavernImageFigure(figure: HTMLElement, slotId = '', response: Record<string, unknown>) {
        if (!canHydrateTavernFigure(figure, slotId)) {return;}
        const next = toTavernImageResult(response);
        if (next.hasData && next.url) {
            renderLoadedTavernImageFigure(figure, next);
        } else {
            renderUnavailableTavernImageFigure(figure, next);
        }
    }

    async function selectTavernImageVersion(slotId = '', index = 0, figure?: HTMLElement | null) {
        const response = await options.requestHost('xb-tavern:draw-image-select', {
            payload: { slotId, index },
        });
        if (figure) {
            await refreshTavernImageFigure(figure, slotId, response);
        }
        return toTavernImageResult(response);
    }

    async function openTavernImageGallery(slotId = '', figure?: HTMLElement | null) {
        const response = await options.requestHost('xb-tavern:draw-image-gallery', { payload: { slotId } });
        const data = toTavernImageResult(response);
        const previews = Array.isArray(data.previews) ? data.previews as Array<Record<string, unknown>> : [];
        if (!previews.length) {return;}
        closeTavernImageGallery();

        let currentIndex = Math.max(0, Math.min(previews.length - 1, Math.floor(Number(data.currentIndex) || 0)));
        const overlay = document.createElement('div');
        overlay.id = 'xb-tavern-image-gallery-overlay';
        overlay.className = 'xb-tavern-image-gallery-overlay visible';

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'xb-tavern-image-gallery-close';
        closeButton.textContent = '×';

        const main = document.createElement('div');
        main.className = 'xb-tavern-image-gallery-main';
        const prevButton = document.createElement('button');
        prevButton.type = 'button';
        prevButton.className = 'xb-tavern-image-gallery-nav';
        prevButton.textContent = '‹';
        const imageWrap = document.createElement('div');
        imageWrap.className = 'xb-tavern-image-gallery-img-wrap';
        const image = document.createElement('img');
        image.className = 'xb-tavern-image-gallery-img';
        const savedBadge = document.createElement('div');
        savedBadge.className = 'xb-tavern-image-gallery-saved-badge';
        savedBadge.textContent = '已保存';
        imageWrap.append(image, savedBadge);
        const nextButton = document.createElement('button');
        nextButton.type = 'button';
        nextButton.className = 'xb-tavern-image-gallery-nav';
        nextButton.textContent = '›';
        main.append(prevButton, imageWrap, nextButton);

        const thumbs = document.createElement('div');
        thumbs.className = 'xb-tavern-image-gallery-thumbs';
        const actions = document.createElement('div');
        actions.className = 'xb-tavern-image-gallery-actions';
        const useButton = document.createElement('button');
        useButton.type = 'button';
        useButton.className = 'xb-tavern-image-gallery-btn primary';
        useButton.textContent = '使用此图';
        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'xb-tavern-image-gallery-btn';
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'xb-tavern-image-gallery-btn danger';
        deleteButton.textContent = '删除';
        actions.append(useButton, saveButton, deleteButton);
        const info = document.createElement('div');
        info.className = 'xb-tavern-image-gallery-info';
        overlay.append(closeButton, main, thumbs, actions, info);
        document.body.append(overlay);

        const render = () => {
            const current = previews[currentIndex] || previews[0];
            image.src = String(current.url || '');
            savedBadge.style.display = current.saved ? 'block' : 'none';
            prevButton.disabled = currentIndex >= previews.length - 1;
            nextButton.disabled = currentIndex <= 0;
            saveButton.textContent = current.saved ? '✓ 已保存' : '保存到服务器';
            saveButton.disabled = !!current.saved;
            info.textContent = `版本 ${previews.length - currentIndex} / ${previews.length}${current.timestamp ? ` · ${new Date(Number(current.timestamp)).toLocaleString()}` : ''}`;
            thumbs.querySelectorAll<HTMLImageElement>('.xb-tavern-image-gallery-thumb').forEach((thumb) => {
                thumb.classList.toggle('active', Number(thumb.dataset.index) === currentIndex);
            });
        };

        previews.slice().reverse().forEach((preview, reverseIndex) => {
            const index = previews.length - 1 - reverseIndex;
            const thumb = document.createElement('img');
            thumb.className = `xb-tavern-image-gallery-thumb${preview.saved ? ' saved' : ''}`;
            thumb.src = String(preview.url || '');
            thumb.dataset.index = String(index);
            thumb.loading = 'lazy';
            thumb.addEventListener('click', () => {
                currentIndex = index;
                render();
            });
            thumbs.append(thumb);
        });

        closeButton.addEventListener('click', closeTavernImageGallery);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                closeTavernImageGallery();
            }
        });
        prevButton.addEventListener('click', () => {
            currentIndex = Math.min(previews.length - 1, currentIndex + 1);
            render();
        });
        nextButton.addEventListener('click', () => {
            currentIndex = Math.max(0, currentIndex - 1);
            render();
        });
        useButton.addEventListener('click', () => {
            void selectTavernImageVersion(slotId, currentIndex, figure).then(closeTavernImageGallery);
        });
        saveButton.addEventListener('click', () => {
            const current = previews[currentIndex] || previews[0];
            const imgId = String(current?.imgId || '').trim();
            if (!imgId) {return;}
            saveButton.disabled = true;
            void options.requestHost('xb-tavern:draw-image-save', { payload: { slotId, imgId } })
                .then((saveResponse) => {
                    current.saved = true;
                    render();
                    return refreshTavernImageFigure(figure as HTMLElement, slotId, saveResponse);
                })
                .catch(() => { saveButton.disabled = false; });
        });
        deleteButton.addEventListener('click', () => {
            void (async () => {
                if (!await options.confirmDialog({
                    title: '删除图片',
                    message: '确定删除这张图片吗？',
                    confirmText: '删除',
                    tone: 'danger',
                })) {return;}
                const current = previews[currentIndex] || previews[0];
                const imgId = String(current?.imgId || '').trim();
                if (!imgId) {return;}
                void options.requestHost('xb-tavern:draw-image-delete', { payload: { slotId, imgId } })
                    .then((deleteResponse) => refreshTavernImageFigure(figure as HTMLElement, slotId, deleteResponse))
                    .then(() => {
                        previews.splice(currentIndex, 1);
                        if (!previews.length) {
                            closeTavernImageGallery();
                            return;
                        }
                        currentIndex = Math.max(0, Math.min(previews.length - 1, currentIndex));
                        thumbs.querySelectorAll<HTMLImageElement>('.xb-tavern-image-gallery-thumb').forEach((thumb) => {
                            if (Number(thumb.dataset.index) === currentIndex) {
                                thumb.remove();
                            }
                        });
                        closeTavernImageGallery();
                        void openTavernImageGallery(slotId, figure);
                    });
            })();
        });
        render();
    }

    function renderUnavailableTavernImageFigure(figure: HTMLElement, result: Record<string, unknown> = {}) {
        figure.classList.add('is-failed');
        figure.classList.remove('is-loaded', 'is-busy');
        figure.dataset.tavernImageSlot = String(result.slotId || figure.dataset.tavernImageSlot || '').trim();
        figure.dataset.tavernImageHydrating = 'false';
        figure.dataset.tavernImageLoaded = 'false';
        figure.dataset.state = 'failed';

        const slotId = String(result.slotId || figure.dataset.tavernImageSlot || '').trim();
        const isFailed = !!result.isFailed;
        const errorType = String(result.errorType || '').trim();
        const errorMessage = String(result.errorMessage || '').trim();

        const wrap = document.createElement('span');
        wrap.className = 'xb-tavern-image-wrap xb-tavern-image-failed-wrap';

        const icon = document.createElement('span');
        icon.className = 'xb-tavern-image-failed-icon';
        icon.textContent = isFailed ? '⚠️' : '🌫️';
        wrap.append(icon);

        const title = document.createElement('span');
        title.className = 'xb-tavern-image-failed-title';
        title.textContent = errorType || (isFailed ? '生成失败' : '配图未找到');
        wrap.append(title);

        const desc = document.createElement('span');
        desc.className = 'xb-tavern-image-failed-desc';
        desc.textContent = errorMessage || (isFailed ? '点击重试' : '');
        if (desc.textContent) {
            wrap.append(desc);
        }

        if (isFailed && slotId) {
            const actions = document.createElement('span');
            actions.className = 'xb-tavern-image-failed-actions';

            const retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.dataset.action = 'refresh-image';
            retryButton.textContent = '⟳ 重新生成';

            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.dataset.action = 'edit-tags';
            editButton.textContent = '✐ 编辑TAG';
            actions.append(retryButton, editButton);
            wrap.append(actions);

            const { editPanel, openEditor } = buildTavernImageEditPanel(figure, slotId, result, {
                inline: true,
                saveLabel: '保存并重试',
                retryAfterSave: true,
                onToggle: (open) => {
                    actions.style.opacity = open ? '0.3' : '';
                    actions.style.pointerEvents = open ? 'none' : '';
                    actions.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
                        button.dataset.editDisabled = open ? 'true' : 'false';
                        button.disabled = open
                            || figure.classList.contains('is-busy')
                            || button.dataset.navDisabled === 'true';
                    });
                },
            });
            wrap.append(editPanel);

            actions.addEventListener('click', (event) => {
                const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-action]');
                if (!target) {return;}
                event.preventDefault();
                event.stopPropagation();
                const action = target.dataset.action || '';
                if (action === 'refresh-image') {
                    setTavernImageBusy(figure, true);
                    void options.requestHost('xb-tavern:draw-image-refresh', { payload: { slotId } })
                        .then((response) => refreshTavernImageFigure(figure, slotId, response))
                        .catch(() => setTavernImageBusy(figure, false));
                    return;
                }
                if (action === 'edit-tags') {
                    openEditor();
                }
            });
        }

        figure.replaceChildren(wrap);
    }

    function renderLoadedTavernImageFigure(figure: HTMLElement, result: Record<string, unknown>) {
        const slotId = String(result.slotId || figure.dataset.tavernImageSlot || '').trim();
        const url = String(result.url || '').trim();
        const historyCount = Math.max(1, Math.floor(Number(result.historyCount) || 1));
        const currentIndex = Math.max(0, Math.min(historyCount - 1, Math.floor(Number(result.currentIndex) || 0)));
        const displayVersion = historyCount - currentIndex;
        figure.classList.add('is-loaded');
        figure.classList.remove('is-failed', 'is-busy');
        figure.dataset.tavernImageSlot = slotId;
        figure.dataset.tavernImageLoaded = 'true';
        figure.dataset.tavernImageIndex = String(currentIndex);
        figure.dataset.tavernImageHistory = String(historyCount);
        figure.dataset.tavernImageImgId = String(result.imgId || '');
        figure.dataset.state = result.saved ? 'saved' : 'preview';

        const wrap = document.createElement('span');
        wrap.className = 'xb-tavern-image-wrap';

        const image = document.createElement('img');
        image.src = url;
        image.alt = result.tags ? `配图：${String(result.tags)}` : '配图';
        image.loading = 'lazy';
        image.addEventListener('click', () => {
            void openTavernImageGallery(slotId, figure);
        });
        wrap.append(image);

        const nav = document.createElement('span');
        nav.className = 'xb-tavern-image-nav';

        const olderButton = document.createElement('button');
        olderButton.type = 'button';
        olderButton.className = 'xb-tavern-image-nav-button';
        olderButton.dataset.action = 'older';
        olderButton.title = '上一版本';
        olderButton.textContent = '‹';
        olderButton.disabled = currentIndex >= historyCount - 1;
        olderButton.dataset.navDisabled = olderButton.disabled ? 'true' : 'false';

        const version = document.createElement('span');
        version.className = 'xb-tavern-image-nav-text';
        version.textContent = `${displayVersion} / ${historyCount}`;

        const newerButton = document.createElement('button');
        newerButton.type = 'button';
        newerButton.className = 'xb-tavern-image-nav-button';
        newerButton.dataset.action = 'newer';
        newerButton.title = currentIndex === 0 ? '重新生成' : '下一版本';
        newerButton.textContent = '›';
        newerButton.disabled = false;
        newerButton.dataset.navDisabled = 'false';
        nav.append(olderButton, version, newerButton);
        wrap.append(nav);

        const menu = document.createElement('span');
        menu.className = 'xb-tavern-image-menu';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'xb-tavern-image-menu-trigger';
        trigger.title = '操作';
        trigger.textContent = '⋮';
        const dropdown = document.createElement('span');
        dropdown.className = 'xb-tavern-image-dropdown';
        const menuItems = [
            ...(!result.saved ? [{ action: 'save-image', title: '保存到服务器', label: '⬇' }] : []),
            { action: 'refresh-image', title: '重新生成', label: '⟳' },
            { action: 'edit-tags', title: '编辑TAG', label: '✐' },
            { action: 'delete-image', title: '删除', label: '✕' },
        ];
        menuItems.forEach((item) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.action = item.action;
            button.title = item.title;
            button.textContent = item.label;
            dropdown.append(button);
        });
        menu.append(trigger, dropdown);
        wrap.append(menu);

        const { editPanel, openEditor } = buildTavernImageEditPanel(figure, slotId, result);
        wrap.append(editPanel);

        figure.replaceChildren(wrap);

        const selectIndex = async (index: number) => {
            setTavernImageBusy(figure, true);
            try {
                const response = await options.requestHost('xb-tavern:draw-image-select', {
                    payload: { slotId, index },
                });
                if (!canHydrateTavernFigure(figure, slotId)) {return;}
                renderLoadedTavernImageFigure(figure, toTavernImageResult(response));
            } catch {
                setTavernImageBusy(figure, false);
            }
        };

        const refreshImage = async () => {
            setTavernImageBusy(figure, true);
            try {
                const response = await options.requestHost('xb-tavern:draw-image-refresh', { payload: { slotId } });
                await refreshTavernImageFigure(figure, slotId, response);
            } catch (error) {
                setTavernImageBusy(figure, false);
                showTavernImageRefreshError(error);
            }
        };

        olderButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (currentIndex < historyCount - 1) {
                void selectIndex(currentIndex + 1);
            }
        });
        newerButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (currentIndex > 0) {
                void selectIndex(currentIndex - 1);
                return;
            }
            void refreshImage();
        });
        trigger.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const willOpen = !menu.classList.contains('is-open');
            closeTavernImageMenus();
            menu.classList.toggle('is-open', willOpen);
        });
        dropdown.addEventListener('click', (event) => {
            const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-action]');
            if (!target) {return;}
            event.preventDefault();
            event.stopPropagation();
            closeTavernImageMenus();
            const action = target.dataset.action || '';
            if (action === 'save-image') {
                setTavernImageBusy(figure, true);
                void options.requestHost('xb-tavern:draw-image-save', { payload: { slotId } })
                    .then((response) => {
                        if (canHydrateTavernFigure(figure, slotId)) {
                            renderLoadedTavernImageFigure(figure, toTavernImageResult(response));
                        }
                    })
                    .catch(() => setTavernImageBusy(figure, false));
            } else if (action === 'refresh-image') {
                void refreshImage();
            } else if (action === 'edit-tags') {
                openEditor();
            } else if (action === 'delete-image') {
                void (async () => {
                    if (!await options.confirmDialog({
                        title: '删除图片',
                        message: '确定删除这张图片吗？',
                        confirmText: '删除',
                        tone: 'danger',
                    })) {return;}
                    setTavernImageBusy(figure, true);
                    void options.requestHost('xb-tavern:draw-image-delete', { payload: { slotId } })
                        .then((response) => refreshTavernImageFigure(figure, slotId, response))
                        .catch(() => setTavernImageBusy(figure, false));
                })();
            }
        });
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
                    renderUnavailableTavernImageFigure(figure, result);
                    return;
                }
                renderLoadedTavernImageFigure(figure, result);
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

    function removeAdjacentImageLineBreaks(figure: HTMLElement) {
        const parent = figure.parentNode;
        if (!parent) {return;}

        const pruneSide = (direction: 'previousSibling' | 'nextSibling') => {
            let node = figure[direction];
            while (node?.nodeType === Node.TEXT_NODE && !String(node.textContent || '').trim()) {
                const next = node[direction];
                parent.removeChild(node);
                node = next;
            }
            if (node instanceof HTMLBRElement) {
                const next = node[direction];
                parent.removeChild(node);
                node = next;
                while (node?.nodeType === Node.TEXT_NODE && !String(node.textContent || '').trim()) {
                    const after = node[direction];
                    parent.removeChild(node);
                    node = after;
                }
            }
        };

        pruneSide('previousSibling');
        pruneSide('nextSibling');
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
                    const before = text.slice(lastIndex, match.index);
                    fragment.append(document.createTextNode(before.endsWith('\n') ? before.slice(0, -1) : before));
                }
                fragment.append(createTavernImageFigure(match[1] || ''));
                lastIndex = TAVERN_IMAGE_MARKER_REGEX.lastIndex;
                if (text[lastIndex] === '\n') {
                    lastIndex += 1;
                }
            }
            if (!replaced) {return;}
            if (lastIndex < text.length) {
                fragment.append(document.createTextNode(text.slice(lastIndex)));
            }
            textNode.replaceWith(fragment);
        });
        root.querySelectorAll<HTMLElement>('[data-tavern-image-slot]').forEach((figure) => {
            removeAdjacentImageLineBreaks(figure);
            hydrateTavernImageFigure(figure);
        });
    }

    function normalizeInlineImageTags(raw = '') {
        let text = String(raw || '').trim();
        text = text.replace(/^(nsfw|sketchy)\s*:\s*/i, 'nsfw, ');
        return text.split(',').map((part) => part.trim()).filter(Boolean).join(', ');
    }

    function encodeInlineImageTags(raw = '') {
        return encodeURIComponent(normalizeInlineImageTags(raw));
    }

    function toInlineImageDataUrl(base64 = '') {
        const value = String(base64 || '').trim();
        if (!value) {return '';}
        return /^data:[^;]+;base64,/i.test(value) ? value : `data:image/png;base64,${value}`;
    }

    function setInlineImageSlotStatus(slot: HTMLElement, text: string, state = 'loading') {
        slot.dataset.state = state;
        const placeholder = document.createElement('span');
        placeholder.className = `xb-tavern-inline-image-placeholder is-${state}`;
        placeholder.textContent = text;
        slot.replaceChildren(placeholder);
    }

    function renderInlineImageSlot(slot: HTMLElement, base64 = '') {
        const src = toInlineImageDataUrl(base64);
        if (!src) {
            throw new Error('image_data_missing');
        }
        slot.dataset.loaded = '1';
        slot.dataset.loading = '';
        slot.dataset.state = 'loaded';
        const image = document.createElement('img');
        image.className = 'xb-tavern-inline-image-img';
        image.src = src;
        image.loading = 'lazy';
        image.addEventListener('click', () => window.open(src, '_blank'));
        slot.replaceChildren(image);
    }

    function renderInlineImageError(slot: HTMLElement, tags = '', error: unknown) {
        slot.dataset.loaded = '1';
        slot.dataset.loading = '';
        slot.dataset.state = 'error';
        const wrap = document.createElement('span');
        wrap.className = 'xb-tavern-inline-image-error';
        const label = document.createElement('span');
        label.textContent = error instanceof Error ? error.message : String(error || '生成失败');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重试';
        retry.addEventListener('click', (event) => {
            event.stopPropagation();
            slot.dataset.loaded = '';
            void loadInlineImageSlot(slot, tags);
        });
        wrap.append(label, retry);
        slot.replaceChildren(wrap);
    }

    function formatInlineImageProgress(status = '', payload: Record<string, unknown> = {}) {
        const queuePosition = Math.max(0, Math.floor(Number(payload.position) || 0));
        const cooldownSeconds = Math.max(0, Math.floor(Number(payload.delay) || 0));
        if (status === 'queued') {
            const ahead = Math.max(0, queuePosition - 1);
            return ahead > 0 ? `排队中，前面还有 ${ahead} 张` : '排队中';
        }
        if (status === 'generating') {
            return '正在生成';
        }
        if (status === 'waiting') {
            return cooldownSeconds > 0 ? `等待冷却 ${cooldownSeconds}s` : '等待冷却';
        }
        return '检查缓存...';
    }

    function updateInlineImageProgress(payload: Record<string, unknown> = {}) {
        const tags = normalizeInlineImageTags(String(payload.tags || ''));
        if (!tags) {return;}
        const encodedTags = encodeInlineImageTags(tags);
        const status = String(payload.status || '').trim();
        const text = formatInlineImageProgress(status, payload);
        document.querySelectorAll<HTMLElement>('.xb-tavern-inline-image[data-loading="1"]').forEach((slot) => {
            if (String(slot.dataset.tags || '') !== encodedTags) {return;}
            if (!canAutoLoadInlineImageSlot(slot)) {return;}
            setInlineImageSlotStatus(slot, text, 'loading');
        });
    }

    async function loadInlineImageSlot(slot: HTMLElement, tags = '') {
        const normalizedTags = normalizeInlineImageTags(tags || decodeURIComponent(slot.dataset.tags || ''));
        if (!normalizedTags || slot.dataset.loading === '1' || slot.dataset.loaded === '1' || !canAutoLoadInlineImageSlot(slot)) {return;}
        slot.dataset.tags = encodeInlineImageTags(normalizedTags);
        slot.dataset.loading = '1';
        slot.dataset.loaded = '';
        setInlineImageSlotStatus(slot, '检查缓存...', 'loading');
        try {
            const response = await options.requestHost('xb-tavern:inline-image-generate', {
                payload: { tags: normalizedTags },
            });
            const result = response.result && typeof response.result === 'object'
                ? response.result as Record<string, unknown>
                : response;
            renderInlineImageSlot(slot, String(result.base64 || ''));
        } catch (error) {
            renderInlineImageError(slot, normalizedTags, error);
        }
    }

    let inlineImageObserver: IntersectionObserver | null = null;

    function ensureInlineImageObserver() {
        if (inlineImageObserver || typeof IntersectionObserver === 'undefined') {return inlineImageObserver;}
        inlineImageObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) {return;}
                const slot = entry.target as HTMLElement;
                if (!canAutoLoadInlineImageSlot(slot)) {return;}
                inlineImageObserver?.unobserve(slot);
                void loadInlineImageSlot(slot);
            });
        }, { rootMargin: '200px 0px', threshold: 0.01 });
        return inlineImageObserver;
    }

    function createInlineImageSlot(tags = '') {
        const slot = document.createElement('span');
        slot.className = 'xb-tavern-inline-image';
        slot.dataset.tags = encodeInlineImageTags(tags);
        setInlineImageSlotStatus(slot, '滚动加载', 'idle');
        return slot;
    }

    function hydrateInlineImageSlots(root: HTMLElement) {
        if (!canEnhanceMarkdownRoot(root)) {return;}
        root.querySelectorAll<HTMLElement>('.xb-tavern-inline-image').forEach((slot) => {
            if (slot.dataset.observed === '1' || slot.dataset.loaded === '1' || slot.dataset.loading === '1') {return;}
            if (!canAutoLoadInlineImageSlot(slot)) {return;}
            slot.dataset.observed = '1';
            const observer = ensureInlineImageObserver();
            if (observer) {
                observer.observe(slot);
                return;
            }
            void loadInlineImageSlot(slot);
        });
    }

    function enhanceInlineImageTokens(root: HTMLElement) {
        if (!canEnhanceMarkdownRoot(root) || root.closest('.streaming, .pending-user')) {return;}
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const textNode = node as Text;
                if (!textNode.data || !TAVERN_INLINE_IMAGE_TOKEN_REGEX.test(textNode.data)) {
                    TAVERN_INLINE_IMAGE_TOKEN_REGEX.lastIndex = 0;
                    return NodeFilter.FILTER_SKIP;
                }
                TAVERN_INLINE_IMAGE_TOKEN_REGEX.lastIndex = 0;
                const parent = textNode.parentElement;
                if (parent?.closest?.('a, button, code, kbd, pre, script, style, textarea, .xb-tavern-image, .xb-tavern-inline-image')) {
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
            TAVERN_INLINE_IMAGE_TOKEN_REGEX.lastIndex = 0;
            let match: RegExpExecArray | null;
            let lastIndex = 0;
            let replaced = false;
            const fragment = document.createDocumentFragment();
            while ((match = TAVERN_INLINE_IMAGE_TOKEN_REGEX.exec(text)) !== null) {
                replaced = true;
                if (match.index > lastIndex) {
                    const before = text.slice(lastIndex, match.index);
                    fragment.append(document.createTextNode(before.endsWith('\n') ? before.slice(0, -1) : before));
                }
                const tags = normalizeInlineImageTags(match[1] || '');
                fragment.append(createInlineImageSlot(tags));
                lastIndex = TAVERN_INLINE_IMAGE_TOKEN_REGEX.lastIndex;
                if (text[lastIndex] === '\n') {
                    lastIndex += 1;
                }
            }
            if (!replaced) {return;}
            if (lastIndex < text.length) {
                fragment.append(document.createTextNode(text.slice(lastIndex)));
            }
            textNode.replaceWith(fragment);
        });
        root.querySelectorAll<HTMLElement>('.xb-tavern-inline-image').forEach((slot) => {
            removeAdjacentImageLineBreaks(slot);
        });
        hydrateInlineImageSlots(root);
    }

    function handleInlineImageProgressEvent(event: Event) {
        const payload = event instanceof CustomEvent && event.detail && typeof event.detail === 'object'
            ? event.detail as Record<string, unknown>
            : {};
        updateInlineImageProgress(payload);
    }

    if (typeof window !== 'undefined') {
        window.addEventListener(TAVERN_INLINE_IMAGE_PROGRESS_EVENT, handleInlineImageProgressEvent as EventListener);
        // eslint-disable-next-line no-restricted-syntax -- source is validated by matching event.source to a Tavern HTML iframe.
        window.addEventListener('message', handleTavernHtmlIframeMessage as EventListener);
    }

    function actionCheckOutcomeLabel(event: TavernActionCheckRuntimeEvent) {
        if (event.outcome === 'criticalSuccess') {return '大成功';}
        if (event.outcome === 'criticalFailure') {return '大失败';}
        return event.success ? '判定成功' : '判定失败';
    }

    function actionCheckOutcomeClass(event: TavernActionCheckRuntimeEvent) {
        if (event.outcome === 'criticalSuccess') {return 'is-success is-critical-success';}
        if (event.outcome === 'criticalFailure') {return 'is-failure is-critical-failure';}
        return event.success ? 'is-success' : 'is-failure';
    }

    function buildActionCheckAriaLabel(event: TavernActionCheckRuntimeEvent) {
        const outcome = actionCheckOutcomeLabel(event);
        const action = String(event.action || '').trim();
        const stakes = String(event.stakes || '').trim();
        return [
            `行动判定：${event.stat}。`,
            `掷骰 ${event.roll} 对抗难度 ${event.difficulty}。`,
            `${outcome}。`,
            action ? `行动意图：${action}。` : '',
            stakes ? `风险：${stakes}。` : '',
        ].filter(Boolean).join(' ');
    }

    function createActionCheckCard(event: TavernActionCheckRuntimeEvent) {
        const card = document.createElement('span');
        card.className = `action-check-card ${actionCheckOutcomeClass(event)}`;
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', buildActionCheckAriaLabel(event));

        const head = document.createElement('span');
        head.className = 'action-check-card-head';

        const title = document.createElement('strong');
        title.textContent = event.stat;
        head.append(title);

        const outcome = document.createElement('span');
        outcome.className = 'action-check-card-outcome';
        outcome.textContent = actionCheckOutcomeLabel(event);
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

        const children: HTMLElement[] = [head, grid, copy];

        if (event.stakes) {
            const stakes = document.createElement('span');
            stakes.className = 'action-check-card-stakes';
            stakes.textContent = event.stakes;
            children.push(stakes);
        }

        card.append(...children);
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
            if (!canEnhanceMarkdownRoot(node)) {return;}
            const signature = node.dataset.markdownSignature || '';
            if (node.dataset.markdownEnhanced === signature) {return;}
            enhanceTavernHtmlCodeBlocks(node);
            enhanceMarkdownContent(node, {
                codeBlockClassName: 'xb-tavern-codeblock',
                codeCopyClassName: 'xb-tavern-code-copy',
                flattenPreCode: true,
                htmlBlockMode: options.htmlRenderEnabled.value ? 'preview' : 'code',
                skipPreSelector: TAVERN_HTML_PRE_SELECTOR,
            });
            enhanceTavernImageMarkers(node);
            enhanceInlineImageTokens(node);
            enhanceRoleplayDialogue(node);
            enhanceActionCheckMarkers(node);
            node.dataset.markdownEnhanced = signature;
        });
    }

    function enhanceLiveChatMarkdown() {
        const root = options.chatScrollRef.value;
        if (!root?.querySelectorAll) {return;}
        root.querySelectorAll<HTMLElement>('.chat-bubble.streaming .xb-tavern-markdown').forEach((node) => {
            if (!canEnhanceMarkdownRoot(node)) {return;}
            // Match the native renderer: streamed DOM is unstable, so HTML iframes wait for the final message.
            hidePendingTavernHtmlPreviews(node);
            enhanceActionCheckMarkers(node);
        });
    }

    function enhanceManagerMarkdown() {
        const roots = [options.managerScrollRef.value, options.managerWorkRef?.value].filter(Boolean) as HTMLElement[];
        roots.forEach((root) => {
            if (!root?.querySelectorAll) {return;}
            root.querySelectorAll<HTMLElement>('.xb-tavern-markdown').forEach((node) => {
                if (!canEnhanceMarkdownRoot(node)) {return;}
                const signature = node.dataset.markdownSignature || '';
                if (node.dataset.markdownEnhanced === signature) {return;}
                enhanceTavernHtmlCodeBlocks(node);
                enhanceMarkdownContent(node, {
                    codeBlockClassName: 'xb-tavern-codeblock',
                    codeCopyClassName: 'xb-tavern-code-copy',
                    flattenPreCode: true,
                    htmlBlockMode: options.htmlRenderEnabled.value ? undefined : 'code',
                    skipPreSelector: TAVERN_HTML_PRE_SELECTOR,
                });
                node.dataset.markdownEnhanced = signature;
            });
        });
    }

    return {
        clearMarkdownCache,
        disposeMarkdownTools() {
            inlineImageObserver?.disconnect();
            inlineImageObserver = null;
            clearAllTavernHtmlGenerateRelays();
            if (typeof window !== 'undefined') {
                window.removeEventListener(TAVERN_INLINE_IMAGE_PROGRESS_EVENT, handleInlineImageProgressEvent as EventListener);
                window.removeEventListener('message', handleTavernHtmlIframeMessage as EventListener);
            }
        },
        enhanceChatMarkdown,
        enhanceLiveChatMarkdown,
        enhanceManagerMarkdown,
        markdownSignature,
        renderChatMarkdown,
        stripTavernImageMarkers,
    };
}
