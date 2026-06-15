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

test('tavern home only resumes an explicitly selected character session', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    assert.match(appSource, /const canResumeSelectedSession = computed/);
    assert.match(appSource, /String\(selectedSession\.value\.characterId \|\| ''\)\.trim\(\)/);
    assert.match(appSource, /:has-session="canResumeSelectedSession"/);
    assert.match(appSource, /if \(canResumeSelectedSession\.value\) \{\s*openChatView\(\);/);
    assert.doesNotMatch(appSource, /selectedSessionId\.value = sessions\.value\[0\]\.id/);
    assert.doesNotMatch(appSource, /setSelectedTavernSessionId\(selectedSessionId\.value\)/);
});

test('tavern mobile character archive keeps the card list as the scroll container', () => {
    const layoutSource = readRepoFile('modules/tavern/app-src/styles/characters/layout.css');
    const cardsSource = readRepoFile('modules/tavern/app-src/styles/characters/cards.css');
    assert.match(layoutSource, /\.character-index-panel \{[\s\S]*min-height: 0;/);
    assert.match(cardsSource, /\.character-card-grid \{[\s\S]*flex: 1 1 auto;[\s\S]*min-height: 0;[\s\S]*overflow-y: auto;[\s\S]*-webkit-overflow-scrolling: touch;/);
    assert.match(cardsSource, /@media \(max-width: 640px\) \{[\s\S]*\.character-card-grid \{[\s\S]*touch-action: pan-y;/);
    assert.match(cardsSource, /@media \(max-width: 640px\) \{[\s\S]*\.character-card-option \{[\s\S]*content-visibility: visible;/);
});

test('tavern split UI keeps App-owned DOM refs explicitly wired', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const settingsControllerSource = readRepoFile('modules/tavern/app-src/components/settings/useTavernSettingsController.ts');
    const conversationPanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernConversationPanel.vue');
    const managerPanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernManagerPanel.vue');
    const apiPanelSource = readRepoFile('modules/tavern/app-src/components/settings/TavernApiSettingsPanel.vue');
    for (const refName of [
        'chatScrollRef',
        'chatComposeTextareaRef',
        'managerScrollRef',
        'managerComposeTextareaRef',
    ]) {
        assert.match(appSource, new RegExp(`\\b${refName},`));
    }
    assert.match(settingsControllerSource, /\bapiSettingsRootRef,/);
    assert.match(apiPanelSource, /function setApiSettingsRootRef/);
    assert.match(apiPanelSource, /:ref="setApiSettingsRootRef"/);
    assert.match(conversationPanelSource, /function setChatScrollRef/);
    assert.match(conversationPanelSource, /function setChatComposeTextareaRef/);
    assert.match(managerPanelSource, /function setManagerScrollRef/);
    assert.match(managerPanelSource, /function setManagerComposeTextareaRef/);
    assert.doesNotMatch(`${conversationPanelSource}\n${managerPanelSource}\n${apiPanelSource}`, /ref="(?:apiSettingsRootRef|chatScrollRef|chatComposeTextareaRef|managerScrollRef|managerComposeTextareaRef)"/);
});

test('tavern UI context is grouped by page responsibility instead of one flat bag', () => {
    const contextSource = readRepoFile('modules/tavern/app-src/components/tavern-app-context.ts');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const chatPageSource = readRepoFile('modules/tavern/app-src/components/chat/TavernChatPage.vue');
    const conversationPanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernConversationPanel.vue');
    const managerPanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernManagerPanel.vue');
    const workspacePanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernWorkspacePanel.vue');
    const settingsPageSource = readRepoFile('modules/tavern/app-src/components/settings/TavernSettingsPage.vue');
    const settingsControllerSource = readRepoFile('modules/tavern/app-src/components/settings/useTavernSettingsController.ts');

    assert.doesNotMatch(contextSource, /TavernContextBucket/);
    assert.doesNotMatch(contextSource, /Record<string,\s*any>/);
    assert.doesNotMatch(contextSource, /\[key:\s*string\]:\s*any/);
    for (const bucket of ['Shell', 'Chat', 'Manager', 'Memory', 'Workspace', 'Settings']) {
        assert.match(contextSource, new RegExp(`interface Tavern${bucket}Context`));
    }
    for (const bucket of ['shell', 'chat', 'manager', 'memory', 'workspace']) {
        assert.match(contextSource, new RegExp(`${bucket}: Tavern${bucket[0].toUpperCase()}${bucket.slice(1)}Context`));
        assert.match(appSource, new RegExp(`${bucket}: \\{`));
    }
    assert.match(contextSource, /settings: TavernSettingsContext/);
    assert.match(appSource, /useTavernSettingsController/);
    assert.match(appSource, /settings: settingsContext/);
    assert.match(settingsControllerSource, /settingsContext = \{/);
    assert.doesNotMatch(`${chatPageSource}\n${conversationPanelSource}\n${managerPanelSource}\n${workspacePanelSource}\n${settingsPageSource}`, /useTavernAppUiContext\(/);
    assert.match(conversationPanelSource, /useTavernChatContext/);
    assert.match(managerPanelSource, /useTavernManagerContext/);
    assert.match(workspacePanelSource, /useTavernWorkspaceContext/);
    assert.doesNotMatch(workspacePanelSource, /useTavernChatContext/);
    assert.match(settingsPageSource, /useTavernSettingsContext/);
});

test('tavern settings controller owns settings page state and host sync', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const settingsControllerSource = readRepoFile('modules/tavern/app-src/components/settings/useTavernSettingsController.ts');

    assert.match(settingsControllerSource, /export function useTavernSettingsController/);
    for (const forbidden of [
        'function saveCurrentPreset',
        'function selectChatPresetFromHost',
        'function syncWorldbooksFromHost',
        'function refreshRegexFromHost',
        'function saveCurrentAssistantPreset',
        'function renderApiSettingsPanel',
    ]) {
        assert.doesNotMatch(appSource, new RegExp(forbidden));
        assert.match(settingsControllerSource, new RegExp(forbidden));
    }
    assert.match(appSource, /applyHostChatPreset\(payload\)/);
    assert.doesNotMatch(appSource, /chatPresetList\.value/);
    assert.doesNotMatch(appSource, /apiSettingsPanelState/);
});

test('tavern manager display projection stays out of the app controller', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const managerDisplaySource = readRepoFile('modules/tavern/app-src/components/chat/useTavernManagerDisplay.ts');

    assert.match(appSource, /useTavernManagerDisplay/);
    for (const helper of [
        'formatRunActivityLine',
        'formatRunIssueLine',
        'formatRunInputLine',
        'formatRunMapLine',
        'formatRunMemoryLine',
        'formatRunModelLine',
        'managerRunTone',
        'managerToolTraceItems',
        'toolTraceSummary',
    ]) {
        assert.doesNotMatch(appSource, new RegExp(`function ${helper}`));
        assert.match(managerDisplaySource, new RegExp(`function ${helper}`));
    }
    assert.doesNotMatch(managerDisplaySource, /thoughtBlocks/);
    assert.doesNotMatch(managerDisplaySource, /managerStatusLine/);
});

test('tavern markdown enhancement lives outside the app controller', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const markdownToolsSource = readRepoFile('modules/tavern/app-src/components/chat/useTavernMarkdownTools.ts');
    assert.match(appSource, /useTavernMarkdownTools/);
    assert.doesNotMatch(appSource, /function renderChatMarkdown/);
    assert.doesNotMatch(appSource, /function enhanceChatMarkdown/);
    assert.match(markdownToolsSource, /function renderChatMarkdown/);
    assert.match(markdownToolsSource, /function enhanceChatMarkdown/);
    assert.match(markdownToolsSource, /function enhanceActionCheckMarkers/);
    assert.match(markdownToolsSource, /function enhanceTavernImageMarkers/);
});

test('tavern memory editor actions live outside the app controller', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const memoryWorkspaceSource = readRepoFile('modules/tavern/app-src/components/chat/useTavernMemoryWorkspace.ts');
    assert.match(appSource, /useTavernMemoryWorkspace/);
    assert.doesNotMatch(appSource, /async function saveSelectedMemoryFile/);
    assert.doesNotMatch(appSource, /async function loadSelectedMemoryFileRecord/);
    assert.doesNotMatch(appSource, /function enterMemoryEditMode/);
    assert.match(memoryWorkspaceSource, /async function saveSelectedMemoryFile/);
    assert.match(memoryWorkspaceSource, /async function loadSelectedMemoryFileRecord/);
    assert.match(memoryWorkspaceSource, /function enterMemoryEditMode/);
});

test('tavern streaming action-check UI renders from live runtime events and keeps dark card styling aligned', () => {
    const conversationPanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernConversationPanel.vue');
    const cssSource = readRepoFile('modules/tavern/app-src/styles/chat/messages.css');
    assert.match(conversationPanelSource, /hasRenderableLiveAssistantContent/);
    assert.match(conversationPanelSource, /hasRenderableLiveAssistantMarkdown/);
    assert.match(conversationPanelSource, /runtimeActionCheckEvents/);
    assert.match(cssSource, /\.xb-os-shell\.theme-dark \.action-check-card-grid>span/);
    assert.doesNotMatch(cssSource, /\.xb-os-shell\.theme-dark \.action-check-card-grid>div/);
});

test('tavern keeps the app exit button on home only', () => {
    const homeSource = readRepoFile('modules/tavern/app-src/components/TavernHomePage.vue');
    const aboutSource = readRepoFile('modules/tavern/app-src/components/TavernAboutPage.vue');
    const characterSource = readRepoFile('modules/tavern/app-src/components/TavernCharacterSelectPage.vue');
    const chatSource = readRepoFile('modules/tavern/app-src/components/chat/TavernChatPage.vue');
    const settingsSource = readRepoFile('modules/tavern/app-src/components/settings/TavernSettingsPage.vue');

    assert.match(homeSource, /include-exit/);
    for (const source of [aboutSource, characterSource, chatSource, settingsSource]) {
        assert.doesNotMatch(source, /@exit=/);
        assert.doesNotMatch(source, /xb-tavern:close/);
        assert.doesNotMatch(source, /aria-label="退出"/);
    }
});

test('tavern memory sidebar keeps session-scoped lazy file loading and index-backed search text', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const memoryWorkspaceSource = readRepoFile('modules/tavern/app-src/components/chat/useTavernMemoryWorkspace.ts');
    assert.match(appSource, /selectedMemoryFileRecord\.value\?\.sessionId === selectedSessionId\.value/);
    assert.match(memoryWorkspaceSource, /function invalidateMemoryFileRecordLoad/);
    assert.match(appSource, /file\.searchText \|\| file\.preview \|\| ''/);
});

test('tavern worldbook preview keeps summary lean and expanded content ephemeral', () => {
    const helperSource = readRepoFile('modules/tavern/app-src/components/useTavernEphemeralDisclosureScope.ts');
    const worldbookSource = readRepoFile('modules/tavern/app-src/components/settings/TavernWorldbooksSettingsPanel.vue');
    const worldbookCss = readRepoFile('modules/tavern/app-src/styles/settings/worldbooks.css');
    const worldbookHost = readRepoFile('modules/tavern/host/worldbooks.ts');
    const mobileCss = readRepoFile('modules/tavern/app-src/styles/settings/mobile.css');

    assert.match(helperSource, /export function useTavernEphemeralDisclosureScope/);
    assert.match(worldbookSource, /useTavernEphemeralDisclosureScope/);
    assert.match(worldbookSource, /aria-label="筛选世界书"/);
    assert.doesNotMatch(worldbookSource, />检索世界书</);
    const worldbookSummaries = [...worldbookSource.matchAll(/<summary>[\s\S]*?<\/summary>/g)].map((match) => match[0]);
    assert.ok(worldbookSummaries.length > 0);
    for (const summary of worldbookSummaries) {
        assert.doesNotMatch(summary, /entry\.(?:keys|secondaryKeys)/);
    }
    assert.match(worldbookSource, /v-if="worldbookDisclosure\.isOpen[\s\S]*class="worldbook-entry-body"/);
    assert.match(worldbookCss, /\.worldbook-entry-body \{[\s\S]*max-height: 560px;[\s\S]*overflow: auto;/);
    assert.match(worldbookCss, /\.worldbook-entry-content \{[\s\S]*white-space: pre-wrap;/);
    assert.doesNotMatch(worldbookHost, /truncatePreview/);
    assert.match(mobileCss, /\.settings-layout\.is-worldbooks-workspace \.worldbook-entry-preview summary \{[\s\S]*min-height: 42px;/);
});

test('tavern heavy disclosure details bind to ephemeral state instead of keeping bodies mounted', () => {
    const detailFiles = sourceFiles
        .filter((path) => path.includes(`${join('modules', 'tavern', 'app-src', 'components')}`))
        .map((path) => ({
            path: relative(root, path).replace(/\\/g, '/'),
            source: readFileSync(path, 'utf8'),
        }));
    const unboundDetails = detailFiles.flatMap(({ path, source }) => (
        [...source.matchAll(/<details\b[\s\S]*?>/g)]
            .filter((match) => !match[0].includes(':open='))
            .map((match) => ({ path, tag: match[0].replace(/\s+/g, ' ').trim() }))
    ));

    assert.deepEqual(unboundDetails, []);

    const characterSource = readRepoFile('modules/tavern/app-src/components/TavernCharacterSelectPage.vue');
    const conversationSource = readRepoFile('modules/tavern/app-src/components/chat/TavernConversationPanel.vue');
    const managerSource = readRepoFile('modules/tavern/app-src/components/chat/TavernManagerPanel.vue');
    assert.match(characterSource, /useTavernEphemeralDisclosureScope/);
    assert.match(characterSource, /<template\s+v-if="advancedDefinitionDisclosure\.isOpen/);
    assert.match(conversationSource, /useTavernEphemeralDisclosureScope/);
    assert.match(conversationSource, /class="tavern-thought-details"[\s\S]*:open="thoughtDisclosure\.isOpen/);
    assert.match(conversationSource, /v-if="thoughtDisclosure\.isOpen\(messageThoughtDisclosureId\(message\)\)"/);
    assert.match(managerSource, /useTavernEphemeralDisclosureScope/);
    assert.match(managerSource, /v-if="managerDisclosure\.isOpen[\s\S]*class="manager-tool-turn-body"/);
    assert.match(managerSource, /class="manager-work-drawer"[\s\S]*:open="managerDisclosure\.isOpen/);
});

test('tavern settings and chat pages reset ephemeral expanded DOM on scope changes', () => {
    const worldbookSource = readRepoFile('modules/tavern/app-src/components/settings/TavernWorldbooksSettingsPanel.vue');
    const chatPresetSource = readRepoFile('modules/tavern/app-src/components/settings/TavernChatPresetSettingsPanel.vue');
    const regexSource = readRepoFile('modules/tavern/app-src/components/settings/TavernRegexSettingsPanel.vue');
    const conversationSource = readRepoFile('modules/tavern/app-src/components/chat/TavernConversationPanel.vue');
    const managerSource = readRepoFile('modules/tavern/app-src/components/chat/TavernManagerPanel.vue');

    assert.match(worldbookSource, /watch\(\s*\[\s*activeSettingsWorkspace,\s*selectedWorldbookName/);
    assert.match(chatPresetSource, /const shouldMountPromptEditor = computed/);
    assert.match(chatPresetSource, /v-if="shouldMountPromptEditor"/);
    assert.match(chatPresetSource, /watch\(activeSettingsWorkspace[\s\S]*workspace !== 'chatPreset'[\s\S]*mobileEditorOpen\.value = false/);
    assert.match(regexSource, /const shouldMountRegexEditor = computed/);
    assert.match(regexSource, /v-if="shouldMountRegexEditor"/);
    assert.match(regexSource, /watch\(activeSettingsWorkspace[\s\S]*workspace !== 'regex'[\s\S]*mobileRegexEditorOpen\.value = false/);
    assert.match(conversationSource, /watch\(\s*\[\s*activeView,\s*chatFocus,\s*selectedSessionId\s*\][\s\S]*thoughtDisclosure\.reset\(\)/);
    assert.match(managerSource, /watch\(\s*\[\s*activeView,\s*chatFocus\s*\][\s\S]*managerDisclosure\.reset\(\)/);
});

test('tavern edited RP messages use native macro substitution before saving', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    assert.match(appSource, /function buildUiSubstituteParamsOptions/);
    assert.match(appSource, /async function substituteEditedMessageContent/);
    assert.match(appSource, /applyTavernSubstituteParams\(\[\{\s*id: `edit:\$\{message\.sessionId\}:\$\{message\.order\}`,[\s\S]*buildUiSubstituteParamsOptions/);
    assert.match(appSource, /const substitutedContent = await substituteEditedMessageContent\(message, content\);[\s\S]*const regexedContent = await applyEditRegexToMessageContent\(message, substitutedContent\);[\s\S]*updateTavernMessage\(message\.sessionId, message\.order, \{\s*content: regexedContent,/);
});

test('tavern RP display and edit save use native regex phases without slash command placement', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const contextSource = readRepoFile('modules/tavern/app-src/components/tavern-app-context.ts');
    const conversationSource = readRepoFile('modules/tavern/app-src/components/chat/TavernConversationPanel.vue');
    const sharedRegexSource = readRepoFile('modules/tavern/shared/regex.ts');

    assert.match(contextSource, /displayMessageContent: TavernCommand/);
    assert.match(contextSource, /displayMessageRenderProjection: TavernCommand/);
    assert.match(contextSource, /displayMessageThoughtBlocks: TavernCommand/);
    assert.match(contextSource, /displayRuntimeContent: TavernCommand/);
    assert.match(contextSource, /displayRuntimeRenderProjection: TavernCommand/);
    assert.match(contextSource, /displayRuntimeThoughtBlocks: TavernCommand/);
    assert.match(conversationSource, /const projection = displayMessageRenderProjection\(message\);/);
    assert.match(conversationSource, /buildAssistantRenderState\(projection\.text, projection\.actionCheckEvents\)/);
    assert.match(conversationSource, /v-for="rawThoughts in \[thoughtBlocks\(message\)\]"/);
    assert.match(conversationSource, /v-for="displayThoughts in \[displayMessageThoughtBlocks\(message\)\]"/);
    assert.match(conversationSource, /v-for="\(thought, thoughtIndex\) in displayThoughts"/);
    assert.match(conversationSource, /displayRuntimeRenderProjection\(\s*runtimeText\.value,[\s\S]*runtimeActionCheckEvents\.value/);
    assert.match(conversationSource, /v-for="rawRuntimeThoughts in \[thoughtBlocks\(runtimeThoughts\)\]"/);
    assert.match(conversationSource, /v-for="displayRuntimeThoughts in \[displayRuntimeThoughtBlocks\(rawRuntimeThoughts\)\]"/);
    assert.doesNotMatch(conversationSource, /displayMessageThoughtBlocks\(message\)\.length/);
    assert.doesNotMatch(conversationSource, /displayRuntimeThoughtBlocks\(runtimeThoughts\)\.length/);
    assert.match(appSource, /function displayMessageContent\(message: TavernMessageRecord\): string/);
    assert.match(appSource, /function displayMessageRenderProjection\(message: TavernMessageRecord\): DisplayRegexProjection/);
    assert.match(appSource, /function displayRuntimeContent\(textInput = ''\): string/);
    assert.match(appSource, /function displayRuntimeRenderProjection\([\s\S]*events: TavernActionCheckRuntimeEvent\[\] = \[\],[\s\S]*\): DisplayRegexProjection/);
    assert.match(appSource, /const actionCheckEvents = getActionCheckEvents\(events\);[\s\S]*if \(!text && !actionCheckEvents\.length\) \{return \{ text: '', actionCheckEvents: \[\] \};\}[\s\S]*if \(!text\) \{return \{ text: '', actionCheckEvents \};\}/);
    assert.match(appSource, /injectActionCheckRegexMarkers\(text, actionCheckEvents\)/);
    assert.match(appSource, /toDisplayRegexProjection\(cached, request\)/);
    assert.match(appSource, /runtimeDisplayRegexStableProjection\.get\('runtime:message'\) \?\? \{ text: '', actionCheckEvents: \[\] \}/);
    assert.match(appSource, /const RUNTIME_DISPLAY_REGEX_THROTTLE_MS = 200/);
    assert.match(appSource, /function clearRuntimeDisplayRegexRequests\(\)[\s\S]*pendingRuntimeDisplayRegexRequests\.forEach\(\(request\) => window\.clearTimeout\(request\.timer\)\)/);
    assert.match(appSource, /function clearDisplayRegexCache\(\)[\s\S]*clearRuntimeDisplayRegexRequests\(\)/);
    assert.match(appSource, /function clearRuntimeAssistantLiveState\(\) \{[\s\S]*clearRuntimeDisplayRegexRequests\(\)/);
    assert.match(appSource, /function scheduleRuntimeDisplayRegexText\(slot: string, input: DisplayRegexTextRequest\)/);
    assert.match(appSource, /current\.key = input\.key;[\s\S]*current\.input = input;[\s\S]*return;/);
    assert.doesNotMatch(appSource, /function scheduleRuntimeDisplayRegexText[\s\S]{0,260}window\.clearTimeout\(current\.timer\)/);
    assert.match(appSource, /latestRuntimeDisplayRegexKeys\.get\(slot\) !== input\.key/);
    assert.match(appSource, /const runtimeDisplayRegexStableProjection = new Map<string, DisplayRegexProjection>\(\)/);
    assert.match(appSource, /function rememberRuntimeDisplayRegexProjection\(slot: string, key: string, text: string, input: DisplayRegexTextRequest\)/);
    assert.match(appSource, /catch \(error\) \{[\s\S]*生成中显示正则应用失败[\s\S]*latestRuntimeDisplayRegexKeys\.get\(slot\) === input\.key[\s\S]*rememberRuntimeDisplayRegexProjection\(slot, input\.key, input\.text, input\)/);
    assert.doesNotMatch(appSource, /scheduleRuntimeDisplayRegexText\('runtime:message', request\);\s*return text;/);
    assert.match(appSource, /placement: 'reasoning'[\s\S]*options: \{\s*isMarkdown: true,\s*depth,/);
    assert.match(appSource, /options: \{\s*isMarkdown: true,\s*depth,\s*characterOverride,/);
    assert.match(appSource, /const sorted = \[\.\.\.sessionMessages\.value\]\s*\.filter\(\(message\) => isNormalRoleplayDisplayMessage\(message\)\)/);
    assert.match(appSource, /function isNormalRoleplayDisplayMessage\(message: TavernMessageRecord\): boolean[\s\S]*&& !message\.error[\s\S]*String\(message\.content \|\| ''\)\.trim\(\)/);
    assert.doesNotMatch(appSource, /catch \(error\) \{[\s\S]{0,160}rememberDisplayRegexText\(input\.key, input\.text\)/);
    assert.match(appSource, /async function applyEditRegexToMessageContent/);
    assert.match(appSource, /options: \{\s*isEdit: true,\s*characterOverride: messageCharacterOverride\(message\),\s*\}/);
    assert.doesNotMatch(sharedRegexSource, /slash/i);
});
