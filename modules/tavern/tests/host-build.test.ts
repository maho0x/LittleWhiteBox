import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');

function readRepoFile(path: string): string {
    return readFileSync(resolve(root, path), 'utf8');
}

test('tavern host build script compiles every host module imported by tavern.ts', () => {
    const tavernSource = readRepoFile('modules/tavern/tavern.ts');
    const buildSource = readRepoFile('scripts/build-tavern-host.mjs');
    const hostImports = [...tavernSource.matchAll(/from ['"]\.\/host\/([^'"]+)\.js['"]/g)]
        .map((match) => `modules/tavern/host/${match[1]}.ts`)
        .sort();
    const entryPoints = [...buildSource.matchAll(/['"](modules\/tavern\/host\/[^'"]+\.ts)['"]/g)]
        .map((match) => match[1])
        .sort();

    assert.deepEqual(
        hostImports.filter((path) => !entryPoints.includes(path)),
        [],
    );
});

test('tavern host replies sanitize payload before postMessage', () => {
    const tavernSource = readRepoFile('modules/tavern/tavern.ts');
    assert.match(tavernSource, /function cloneFramePayload/);
    assert.match(tavernSource, /const message = cloneFramePayload\(\{ type, payload \}\);/);
});

test('tavern host can return a fresh live context on demand', () => {
    const tavernSource = readRepoFile('modules/tavern/tavern.ts');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    assert.match(tavernSource, /async function handleContextRequest/);
    assert.match(tavernSource, /case 'xb-tavern:get-context':/);
    assert.match(tavernSource, /case 'xb-tavern:run-slash-command':/);
    assert.match(appSource, /requestHost\('xb-tavern:get-context'/);
    assert.match(appSource, /requestHost\('xb-tavern:run-slash-command'/);
});

test('tavern app requests sanitize payload before postMessage', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    assert.match(appSource, /function clonePostMessagePayload/);
    assert.match(appSource, /const safePayload = clonePostMessagePayload\(payload\);/);
});

test('tavern chat typography follows host SillyTavern font metrics inside the iframe', () => {
    const hostSource = readRepoFile('modules/tavern/host/sillytavern-context.ts');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const markdownCss = readRepoFile('modules/tavern/app-src/styles/chat/markdown.css');
    const composeCss = readRepoFile('modules/tavern/app-src/styles/chat/compose.css');
    const messagesCss = readRepoFile('modules/tavern/app-src/styles/chat/messages.css');
    const memoryCss = readRepoFile('modules/tavern/app-src/styles/chat/memory-editor.css');

    assert.match(hostSource, /function getHostTypographyMetrics/);
    assert.match(hostSource, /hostMainFontSizePx/);
    assert.match(hostSource, /hostProseLineHeightPx/);
    assert.match(appSource, /const hostMainFontSizePx = ref\('15px'\);/);
    assert.match(appSource, /const hostProseLineHeightPx = ref\('23px'\);/);
    assert.match(appSource, /--xb-host-main-font-size/);
    assert.match(appSource, /--xb-host-prose-line-height/);
    assert.match(markdownCss, /font-size: var\(--xb-host-main-font-size, 15px\);/);
    assert.match(composeCss, /line-height: var\(--xb-host-prose-line-height, 23px\);/);
    assert.match(messagesCss, /font-size: var\(--xb-host-main-font-size, 15px\);/);
    assert.match(memoryCss, /line-height: var\(--xb-host-prose-line-height, 23px\);/);
});

test('tavern worldbook settings page is a native overview instead of a custom editor', () => {
    const panelSource = readRepoFile('modules/tavern/app-src/components/settings/TavernWorldbooksSettingsPanel.vue');
    assert.match(panelSource, /打开酒馆编辑器/);
    assert.match(panelSource, /worldbook-entry-preview-list/);
    assert.match(panelSource, /showMoreWorldbookPreviewEntries/);
    assert.match(panelSource, /worldbookPreview\.entryCount/);
    assert.doesNotMatch(panelSource, /酒馆世界书/);
    assert.doesNotMatch(panelSource, /xb-tavern:save-worldbook/);
    assert.doesNotMatch(panelSource, /xb-tavern:create-worldbook-entry/);
    assert.doesNotMatch(panelSource, /xb-tavern:save-worldbook-settings/);
    assert.doesNotMatch(panelSource, /xb-tavern:set-worldbook-active/);
});

test('tavern character select page keeps a dense index and selected-card preview', () => {
    const panelSource = readRepoFile('modules/tavern/app-src/components/TavernCharacterSelectPage.vue');
    const layoutCss = readRepoFile('modules/tavern/app-src/styles/characters/layout.css');
    const cardsCss = readRepoFile('modules/tavern/app-src/styles/characters/cards.css');
    const previewCss = readRepoFile('modules/tavern/app-src/styles/characters/preview.css');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    assert.match(panelSource, /class="character-index-panel"/);
    assert.match(panelSource, /character-preview-panel dossier-view/);
    assert.match(panelSource, /class="character-preview-panel dossier-empty"/);
    assert.match(panelSource, /class="os-search-bar"/);
    assert.match(panelSource, /class="card-focus-indicator"/);
    assert.match(panelSource, /class="dossier-header"/);
    assert.match(panelSource, /class="greeting-choice-list"/);
    assert.match(panelSource, /备用 \$\{index\}/);
    assert.match(cardsCss, /content-visibility: auto/);
    assert.match(layoutCss, /width: 360px/);
    assert.match(previewCss, /\.dossier-header/);
    assert.match(appSource, /activeView === 'home' \|\| activeView === 'about'/);
    assert.match(appSource, /const previewId = String\(selectedCharacterPreviewId\.value \|\| ''\)\.trim\(\);/);
    assert.match(appSource, /async function selectCharacterForPreview/);
    assert.match(appSource, /getHostContext\(\s*\{\s*characterId: targetId,\s*includeHistory: false,\s*includeWorldbooks: false\s*\}/);
    assert.match(appSource, /timeoutMs: CHARACTER_CONTEXT_TIMEOUT_MS/);
    assert.match(appSource, /function hasCharacterPreviewDetails/);
    assert.match(appSource, /pendingCharacterPreviewId/);
    assert.doesNotMatch(panelSource, /刷新列表/);
    assert.doesNotMatch(panelSource, /这里不重写角色卡/);
    assert.doesNotMatch(panelSource, /archive-toolbar/);
    assert.doesNotMatch(panelSource, /character-archive-browser/);
    assert.doesNotMatch(layoutCss, /linear-gradient\(90deg, transparent 50%, var\(--xb-theme-split-bg\) 50%\)/);
});

test('tavern character list merges native character records when extension context is sparse', () => {
    const hostSource = readRepoFile('modules/tavern/host/sillytavern-context.ts');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    assert.match(hostSource, /characters as sillyTavernCharacters/);
    assert.match(hostSource, /getOneCharacter/);
    assert.match(hostSource, /unshallowCharacter/);
    assert.match(hostSource, /shallow: boolean/);
    assert.match(hostSource, /shallow: character\.shallow === true/);
    assert.match(hostSource, /function hydrateCharacterAt/);
    assert.match(hostSource, /normalizeText\(character\.json_data\)/);
    assert.match(hostSource, /await hydrateSelectedCharacter\(ctx, options\);/);
    assert.doesNotMatch(hostSource, /hydrateAvailableCharacters/);
    assert.match(hostSource, /function mergeCharacterRecord/);
    assert.match(hostSource, /const runtimeCharacters = asArray<Record<string, unknown>>\(sillyTavernCharacters\);/);
    assert.match(hostSource, /Math\.max\(contextCharacters\.length, runtimeCharacters\.length\)/);
    assert.match(hostSource, /mergeCharacterRecord\(asRecord\(runtimeCharacters\[index\]\), asRecord\(contextCharacters\[index\]\)\)/);
    assert.match(appSource, /current && current\.shallow !== true && hasCharacterPreviewDetails\(current\)/);
});

test('tavern chat creation waits for hydrated character context before adding greetings', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const assemblerSource = readRepoFile('modules/tavern/shared/message-assembler.ts');
    assert.match(appSource, /async function selectCharacterAndCreateSession\(characterId: string\)/);
    assert.match(appSource, /pendingCharacterSessionId\.value = targetId/);
    assert.match(appSource, /postToHost\('xb-tavern:refresh-context', \{ characterId: targetId, includeHistory: false \}\)/);
    assert.match(appSource, /function applyHostPayload/);
    assert.match(appSource, /finishPendingCharacterSession\(\)/);
    assert.match(appSource, /await createSessionAndOpenChat\(\{ greetingIndex \}\)/);
    assert.match(appSource, /function getCharacterGreetingOptions/);
    assert.match(appSource, /character\.firstMessage \|\| character\.first_mes/);
    assert.match(appSource, /character\.alternateGreetings \|\| character\.alternate_greetings/);
    assert.match(appSource, /await appendFirstMessageIfPresent\(session\.id, snapshotContext, options\.greetingIndex\)/);
    assert.match(assemblerSource, /\['Description', character\.description/);
    assert.match(assemblerSource, /\['Personality', character\.personality/);
});

test('tavern worldbook sync uses native source overview with current context', () => {
    const settingsControllerSource = readRepoFile('modules/tavern/app-src/components/settings/useTavernSettingsController.ts');
    assert.match(
        settingsControllerSource,
        /requestHost\('xb-tavern:list-worldbook-sources', \{\s*payload: \{\s*context: options\.effectiveContext\.value,/,
    );
    assert.match(settingsControllerSource, /requestHost\('xb-tavern:get-worldbook-preview'/);
    assert.match(settingsControllerSource, /limit: worldbookPreviewVisibleLimit\.value/);
    assert.match(settingsControllerSource, /function showMoreWorldbookPreviewEntries/);
    assert.match(settingsControllerSource, /async function openSelectedWorldbookEditor/);
    assert.match(settingsControllerSource, /requestHost\('xb-tavern:open-worldbook-editor'/);
    assert.match(settingsControllerSource, /postToHost\('xb-tavern:close'\)/);
});

test('tavern worldbook host bridge exposes native runtime result instead of edit endpoints', () => {
    const hostSource = readRepoFile('modules/tavern/host/worldbooks.ts');
    const tavernSource = readRepoFile('modules/tavern/tavern.ts');
    assert.match(hostSource, /export async function listTavernWorldbookSources/);
    assert.match(hostSource, /export async function getTavernWorldbookPreview/);
    assert.match(hostSource, /await loadWorldInfo\(name\)/);
    assert.match(hostSource, /Number\(payload\.limit\)/);
    assert.match(hostSource, /export async function getTavernWorldbookRuntime/);
    assert.match(hostSource, /export function openTavernWorldbookEditor/);
    assert.match(hostSource, /await checkWorldInfo\(chatLines, maxContext, false, globalScanData\)/);
    assert.match(hostSource, /worldInfoBefore:/);
    assert.match(hostSource, /worldInfoAfter:/);
    assert.match(hostSource, /worldInfoExamples:/);
    assert.match(hostSource, /worldInfoDepth:/);
    assert.match(hostSource, /anBefore:/);
    assert.match(hostSource, /anAfter:/);
    assert.match(hostSource, /outlets:/);
    assert.match(tavernSource, /case 'xb-tavern:list-worldbook-sources':/);
    assert.match(tavernSource, /case 'xb-tavern:get-worldbook-preview':/);
    assert.match(tavernSource, /case 'xb-tavern:get-worldbook-runtime':/);
    assert.match(tavernSource, /case 'xb-tavern:open-worldbook-editor':/);
    assert.doesNotMatch(tavernSource, /case 'xb-tavern:list-worldbooks':/);
    assert.doesNotMatch(tavernSource, /case 'xb-tavern:get-worldbook':/);
    assert.doesNotMatch(tavernSource, /case 'xb-tavern:save-worldbook':/);
});

test('tavern slash command bridge executes through native SillyTavern STscript', () => {
    const tavernSource = readRepoFile('modules/tavern/tavern.ts');
    const slashSource = readRepoFile('modules/tavern/host/slash-commands.ts');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');

    assert.match(tavernSource, /runTavernSlashCommand/);
    assert.match(slashSource, /executeSlashCommandsWithOptions/);
    assert.match(slashSource, /source: 'littlewhitebox-tavern'/);
    assert.match(slashSource, /pipe/);
    assert.match(appSource, /function shouldRunTavernSlashCommand/);
    assert.match(appSource, /async function resolveSlashCommandMessageText/);
    assert.match(appSource, /messageText = await resolveSlashCommandMessageText\(messageText, options\);/);
    assert.match(appSource, /reuseUserMessageOrder/);
});

test('tavern message assembler can render native worldbook prompt blocks directly', () => {
    const assemblerSource = readRepoFile('modules/tavern/shared/message-assembler.ts');
    assert.match(assemblerSource, /function buildNativePromptEntries/);
    assert.match(assemblerSource, /worldInfoBefore\?: string;/);
    assert.match(assemblerSource, /worldInfoAfter\?: string;/);
    assert.match(assemblerSource, /worldInfoExamples\?: Array/);
    assert.match(assemblerSource, /worldInfoDepth\?: Array/);
    assert.match(assemblerSource, /anBefore\?: string\[\];/);
    assert.match(assemblerSource, /anAfter\?: string\[\];/);
    assert.match(assemblerSource, /outlets\?: Record<string, string\[\]>;/);
    assert.match(assemblerSource, /activatedWorldEntries: nativePromptEntries\.length \? nativePromptEntries : nativeActivatedEntries/);
});
