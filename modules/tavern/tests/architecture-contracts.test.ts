import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const tavernRoot = resolve(root, 'modules/tavern');
const sourceExtensions = new Set(['.ts', '.vue']);
const ignoredPathParts = new Set(['dist', 'tests']);

function collectSourceFiles(dir: string): string[] {
    return readdirSync(dir)
        .flatMap((name) => {
            const path = join(dir, name);
            const stat = statSync(path);
            if (stat.isDirectory()) {
                return ignoredPathParts.has(name) ? [] : collectSourceFiles(path);
            }
            return sourceExtensions.has(path.slice(path.lastIndexOf('.'))) ? [path] : [];
        });
}

function readRepoFile(path: string): string {
    return readFileSync(resolve(root, path), 'utf8');
}

const sourceFiles = collectSourceFiles(tavernRoot);

function sourceMatches(pattern: RegExp): Array<{ path: string; line: number; text: string }> {
    return sourceFiles.flatMap((path) => {
        const text = readFileSync(path, 'utf8');
        return text.split(/\r?\n/).flatMap((line, index) => (
            pattern.test(line)
                ? [{ path: relative(root, path).replace(/\\/g, '/'), line: index + 1, text: line.trim() }]
                : []
        ));
    });
}

test('tavern source keeps cross-frame messages behind clone-safe wrappers', () => {
    const directPostMessages = sourceMatches(/postMessage\(/);
    assert.deepEqual(directPostMessages, [
        {
            path: 'modules/tavern/app-src/App.vue',
            line: directPostMessages[0]?.line,
            text: "window.parent?.postMessage({ source: SOURCE_APP, type, payload: safePayload }, window.location.origin);",
        },
    ]);
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const hostSource = readRepoFile('modules/tavern/tavern.ts');
    assert.match(appSource, /function postToHost[\s\S]*const safePayload = clonePostMessagePayload\(payload\);[\s\S]*postMessage/);
    assert.match(hostSource, /function postToFrame[\s\S]*const message = cloneFramePayload\(\{ type, payload \}\);[\s\S]*postToIframe/);
});

test('tavern worldbook bridge stays on the native runtime boundary', () => {
    const badSplits = sourceMatches(/split\(\s*\/\\r\?\\n\|,\//);
    assert.deepEqual(badSplits, []);
    const hostSource = readRepoFile('modules/tavern/host/worldbooks.ts');
    assert.match(hostSource, /export async function listTavernWorldbookSources/);
    assert.match(hostSource, /export async function getTavernWorldbookPreview/);
    assert.match(hostSource, /await loadWorldInfo\(name\)/);
    assert.match(hostSource, /export async function getTavernWorldbookRuntime/);
    assert.match(hostSource, /await checkWorldInfo\(chatLines, maxContext, false, globalScanData\)/);
    assert.match(hostSource, /openWorldInfoEditor/);
    assert.doesNotMatch(hostSource, /saveWorldInfo/);
    assert.doesNotMatch(hostSource, /createWorldInfoEntry/);
    assert.doesNotMatch(hostSource, /updateWorldInfoSettings/);
});

test('tavern chat preset bridge only writes native prompt fields, never API parameters', () => {
    const hostSource = readRepoFile('modules/tavern/host/chat-presets.ts');
    assert.match(hostSource, /function pickPromptManagerRuntimeFields/);
    for (const forbidden of [
        'api_key',
        'reverse_proxy',
        'temperature',
        'top_p',
        'top_k',
        'max_tokens',
        'model',
        'streaming',
    ]) {
        assert.doesNotMatch(hostSource, new RegExp(`\\b${forbidden}\\b`));
    }
});

test('tavern request log is sourced from runtime request snapshots', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const runtimeSource = readRepoFile('modules/tavern/app-src/runtime/run-once.ts');
    assert.match(appSource, /lastRequestSnapshot\.value\?\.rawRequestJson \|\| lastRequestSnapshot\.value\?\.rawMessagesJson/);
    assert.match(appSource, /simulateRequestJson\.value = result\.requestSnapshot\.rawRequestJson \|\| result\.requestSnapshot\.rawMessagesJson/);
    assert.match(runtimeSource, /rawRequestJson: JSON\.stringify\(requestForJson, null, 2\)/);
    assert.match(runtimeSource, /requestSnapshot = \(await inspectTavernRequest\(/);
});

test('tavern split UI keeps App-owned DOM refs explicitly wired', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const chatPageSource = readRepoFile('modules/tavern/app-src/components/chat/TavernChatPage.vue');
    const apiPanelSource = readRepoFile('modules/tavern/app-src/components/settings/TavernApiSettingsPanel.vue');
    for (const refName of [
        'apiSettingsRootRef',
        'chatScrollRef',
        'chatComposeTextareaRef',
        'managerScrollRef',
        'managerComposeTextareaRef',
    ]) {
        assert.match(appSource, new RegExp(`\\b${refName},`));
    }
    assert.match(apiPanelSource, /function setApiSettingsRootRef/);
    assert.match(apiPanelSource, /:ref="setApiSettingsRootRef"/);
    assert.match(chatPageSource, /function setChatScrollRef/);
    assert.match(chatPageSource, /function setChatComposeTextareaRef/);
    assert.match(chatPageSource, /function setManagerScrollRef/);
    assert.match(chatPageSource, /function setManagerComposeTextareaRef/);
    assert.doesNotMatch(`${chatPageSource}\n${apiPanelSource}`, /ref="(?:apiSettingsRootRef|chatScrollRef|chatComposeTextareaRef|managerScrollRef|managerComposeTextareaRef)"/);
});

test('tavern streaming action-check UI renders from live runtime events and keeps dark card styling aligned', () => {
    const chatPageSource = readRepoFile('modules/tavern/app-src/components/chat/TavernChatPage.vue');
    const cssSource = readRepoFile('modules/tavern/app-src/styles/chat/messages.css');
    assert.match(chatPageSource, /hasRenderableLiveAssistantContent/);
    assert.match(chatPageSource, /hasRenderableLiveAssistantMarkdown/);
    assert.match(chatPageSource, /runtimeActionCheckEvents/);
    assert.match(cssSource, /\.xb-os-shell\.theme-dark \.action-check-card-grid>span/);
    assert.doesNotMatch(cssSource, /\.xb-os-shell\.theme-dark \.action-check-card-grid>div/);
});

test('tavern memory sidebar keeps session-scoped lazy file loading and index-backed search text', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    assert.match(appSource, /selectedMemoryFileRecord\.value\?\.sessionId === selectedSessionId\.value/);
    assert.match(appSource, /function invalidateMemoryFileRecordLoad/);
    assert.match(appSource, /file\.searchText \|\| file\.preview \|\| ''/);
});
