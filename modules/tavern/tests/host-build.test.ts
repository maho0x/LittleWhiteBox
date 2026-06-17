import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

test('tavern host build script compiles shared runtime modules imported by host modules', () => {
    const buildSource = readRepoFile('scripts/build-tavern-host.mjs');
    const hostSources = readdirSync(resolve(root, 'modules/tavern/host'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => readRepoFile(`modules/tavern/host/${name}`));
    const sharedImports = hostSources.flatMap((source) => [...source.matchAll(/^\s*import\s+(?!type)[^;]*?from ['"]\.\.\/shared\/([^'"]+)\.js['"];?/gm)]
        .map((match) => `modules/tavern/shared/${match[1]}.ts`))
        .sort();
    const entryPoints = [...buildSource.matchAll(/['"](modules\/tavern\/(?:host|shared)\/[^'"]+\.ts)['"]/g)]
        .map((match) => match[1])
        .sort();

    assert.deepEqual(
        sharedImports.filter((path) => !entryPoints.includes(path)),
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
    const markdownSource = readRepoFile('modules/agent-core/ui/message-markdown.js');
    const baseCss = readRepoFile('modules/tavern/app-src/styles/base.css');
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
    assert.match(markdownCss, /\.xb-tavern-markdown pre \{[\s\S]*background: rgba\(26, 26, 26, 0\.035\);/);
    assert.match(markdownCss, /\.xb-tavern-markdown pre \{[\s\S]*padding: 7px 8px;/);
    assert.doesNotMatch(markdownCss, /\.xb-tavern-markdown pre \{[\s\S]*background: rgba\(10, 12, 18, 0\.28\);/);
    assert.doesNotMatch(baseCss, /\.xb-tavern-codeblock pre \{[\s\S]*padding-top: 34px;/);
    assert.match(baseCss, /\.xb-tavern-code-copy \{[\s\S]*width: 24px;[\s\S]*height: 24px;[\s\S]*min-height: 24px;[\s\S]*border-radius: 7px;/);
    assert.match(baseCss, /\.xb-tavern-code-copy\.is-copied \{[\s\S]*color: var\(--xb-ok\);/);
    assert.match(baseCss, /\.xb-tavern-code-copy\.is-failed \{[\s\S]*color: var\(--xb-danger\);/);
    assert.match(markdownSource, /async function copyText\(text = '', ownerDocument = null\)/);
    assert.match(markdownSource, /const doc = ownerDocument\?\.createElement \? ownerDocument : globalThis\.document;/);
    assert.match(markdownSource, /const copied = await copyText\(codeText, doc\);/);
    assert.match(markdownSource, /copyButton\.classList\.toggle\('is-copied', copied\);/);
    assert.match(messagesCss, /\.chat-bubble>\.message-actions \{[\s\S]*position: absolute;[\s\S]*top: -1px;[\s\S]*right: -1px;[\s\S]*border-radius: 0 10px 0 8px;[\s\S]*opacity: 0;/);
    assert.match(messagesCss, /\.chat-bubble>\.message-actions button \{[\s\S]*width: 30px;[\s\S]*min-width: 30px;[\s\S]*height: 30px;[\s\S]*min-height: 30px;[\s\S]*padding: 0;/);
    assert.match(messagesCss, /@media \(max-width: 760px\) \{[\s\S]*\.chat-bubble>\.message-actions \{[\s\S]*opacity: 0;[\s\S]*pointer-events: none;[\s\S]*\.chat-bubble\.is-action-tray-open>\.message-actions[\s\S]*opacity: 1;[\s\S]*pointer-events: auto;/);
    assert.doesNotMatch(messagesCss, /\.message-actions \{[\s\S]*border-top: 1px solid rgba\(120, 112, 98, 0\.16\);/);
    assert.doesNotMatch(messagesCss, /\.message-actions \{[\s\S]*border-bottom: 1px solid rgba\(120, 112, 98, 0\.14\);/);
    assert.match(composeCss, /line-height: var\(--xb-host-prose-line-height, 23px\);/);
    assert.match(messagesCss, /font-size: var\(--xb-host-main-font-size, 15px\);/);
    assert.match(memoryCss, /line-height: var\(--xb-host-prose-line-height, 23px\);/);
});

test('tavern markdown blockquotes do not render showdown formatting whitespace as blank lines', () => {
    const markdownCss = readRepoFile('modules/tavern/app-src/styles/chat/markdown.css');

    assert.match(markdownCss, /\.xb-tavern-markdown p,\r?\n\.xb-tavern-markdown li \{\r?\n\s+white-space: pre-wrap;/);
    assert.doesNotMatch(markdownCss, /\.xb-tavern-markdown blockquote[^{]*\{[^}]*white-space:\s*pre-wrap/);
    assert.match(markdownCss, /\.xb-tavern-markdown blockquote \{[\s\S]*?white-space: normal;[\s\S]*?\n\}/);
});

test('tavern worldbook settings page edits existing named entries without whole-book endpoints', () => {
    const panelSource = readRepoFile('modules/tavern/app-src/components/settings/TavernWorldbooksSettingsPanel.vue');
    assert.doesNotMatch(panelSource, /打开酒馆编辑器/);
    assert.doesNotMatch(panelSource, /openSelectedWorldbookEditor/);
    assert.match(panelSource, /worldbook-entry-preview-list/);
    assert.match(panelSource, /showMoreWorldbookPreviewEntries/);
    assert.match(panelSource, /startWorldbookEntryEdit/);
    assert.match(panelSource, /saveWorldbookEntryDraft/);
    assert.match(panelSource, /worldbookPreview\.entryCount/);
    assert.doesNotMatch(panelSource, /secondary_keys: listFromLines/);
    assert.doesNotMatch(panelSource, /酒馆世界书/);
    assert.doesNotMatch(panelSource, /xb-tavern:save-worldbook['"]/);
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
    const contextSource = readRepoFile('modules/tavern/host/sillytavern-context.ts');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    assert.match(
        settingsControllerSource,
        /requestHost\('xb-tavern:list-worldbook-sources', \{\s*payload: \{\s*context: options\.effectiveContext\.value,/,
    );
    assert.match(settingsControllerSource, /requestHost\('xb-tavern:get-worldbook-preview'/);
    assert.match(settingsControllerSource, /requestHost\('xb-tavern:get-worldbook-entry'/);
    assert.match(settingsControllerSource, /requestHost\('xb-tavern:save-worldbook-entry'/);
    assert.match(settingsControllerSource, /worldbookEntryLoadRequestSerial/);
    assert.match(settingsControllerSource, /worldbookEntryLoadRequestKey !== requestToken/);
    assert.match(settingsControllerSource, /limit: worldbookPreviewVisibleLimit\.value/);
    assert.match(settingsControllerSource, /function showMoreWorldbookPreviewEntries/);
    assert.doesNotMatch(settingsControllerSource, /async function openSelectedWorldbookEditor/);
    assert.doesNotMatch(settingsControllerSource, /requestHost\('xb-tavern:open-worldbook-editor'/);
    assert.match(contextSource, /const worldbookSources = collectWorldbookSources\(ctx, options\);/);
    assert.match(contextSource, /worldbookSources,/);
    assert.match(contextSource, /worldbookSourcesSynced: true/);
    assert.match(appSource, /syncSessionCharacterContext\(\{ sessionId: targetSessionId, force: true \}\)/);
});

test('tavern worldbook host bridge exposes named entry edit endpoints and native runtime result', () => {
    const hostSource = readRepoFile('modules/tavern/host/worldbooks.ts');
    const tavernSource = readRepoFile('modules/tavern/tavern.ts');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    assert.match(hostSource, /export async function listTavernWorldbookSources/);
    assert.match(hostSource, /export async function getTavernWorldbookPreview/);
    assert.match(hostSource, /await loadWorldInfo\(name\)/);
    assert.match(hostSource, /Number\(payload\.limit\)/);
    assert.match(hostSource, /export async function getTavernWorldbookEntry/);
    assert.match(hostSource, /export async function saveTavernWorldbookEntry/);
    assert.match(hostSource, /export async function getTavernCharacterWorldbookState/);
    assert.match(hostSource, /export async function activateTavernCharacterWorldbook/);
    assert.match(hostSource, /export async function bindTavernCharacterWorldbook/);
    assert.match(hostSource, /export async function getTavernGlobalWorldbooks/);
    assert.match(hostSource, /export async function setTavernGlobalWorldbooks/);
    assert.match(hostSource, /function normalizeIdText/);
    assert.match(hostSource, /function syncWorldbookOriginalDataEntry/);
    assert.match(hostSource, /'secondary_keys' in entry && \('secondary_keys' in draft \|\| 'secondaryKeys' in draft\)/);
    assert.match(hostSource, /const keysecondary = normalizeStringList\(draft\.keysecondary\);[\s\S]*entry\.secondary_keys = keysecondary\.length \? keysecondary : normalizeStringList\(draft\.secondary_keys \?\? draft\.secondaryKeys\)/);
    assert.match(hostSource, /await saveWorldInfo\(name, data, true\)/);
    assert.doesNotMatch(hostSource, /not_current_character|只能给当前酒馆角色/);
    assert.match(hostSource, /function prepareCharacterEditorForWorldbookBinding/);
    assert.match(hostSource, /getOneCharacter/);
    assert.match(hostSource, /unshallowCharacter/);
    assert.match(hostSource, /await hydrateCharacterRecordById\(requestedId\)/);
    assert.match(hostSource, /select_selected_character\(numericId, \{ switchMenu: false \}\);/);
    assert.match(hostSource, /const character = await hydrateCharacterRecordById\(state\.characterId\);[\s\S]*const book = readCharacterBook\(character\);/);
    assert.match(hostSource, /state\.worldbookOptions\.includes\(name\) && payload\.confirmed !== true[\s\S]*action: 'needs_import_confirmation'/);
    assert.match(hostSource, /function captureCharacterEditorSnapshot/);
    assert.match(hostSource, /function captureCharacterEditorJQueryData/);
    assert.match(hostSource, /function restoreCharacterEditorSnapshot/);
    assert.match(hostSource, /\.open_alternate_greetings/);
    assert.match(hostSource, /#set_character_world/);
    assert.match(hostSource, /function isCharacterEditorFocusedOn/);
    assert.match(hostSource, /return worldEditorId === targetId && greetingsEditorId === targetId;/);
    assert.match(hostSource, /async function bindCharacterWorldbookThroughEditor/);
    assert.match(hostSource, /const shouldPrepareEditor = !isCharacterEditorFocusedOn\(characterId\);[\s\S]*if \(shouldPrepareEditor\) \{[\s\S]*await prepareCharacterEditorForWorldbookBinding\(characterId\);[\s\S]*finally \{[\s\S]*restoreCharacterEditorSnapshot\(snapshot\);/);
    assert.match(hostSource, /const state = await readCharacterWorldbookState\(characterId\);[\s\S]*state\.boundWorldbookName !== name \|\| state\.boundExists !== true[\s\S]*throw new Error\(`角色世界书绑定未保存成功：\$\{name\}`\);/);
    assert.match(hostSource, /const convertedBook = convertCharacterBook\(book\);[\s\S]*await saveWorldInfo\(name, convertedBook, true\);[\s\S]*await updateWorldInfoList\(\);[\s\S]*const boundState = await bindCharacterWorldbookThroughEditor\(state\.characterId, name\);/);
    assert.match(hostSource, /if \(!name\) \{[\s\S]*throw new Error\('缺少要绑定的世界书名称。'\);[\s\S]*if \(!state\.worldbookOptions\.includes\(name\)\)/);
    assert.match(hostSource, /await prepareCharacterEditorForWorldbookBinding\(characterId\);[\s\S]*await charUpdatePrimaryWorld\(name\);/);
    assert.match(hostSource, /return bindCharacterWorldbookThroughEditor\(characterId, name\);/);
    assert.match(hostSource, /updateWorldInfoSettings\(settings, selected\);[\s\S]*await updateWorldInfoList\(\);/);
    assert.doesNotMatch(hostSource, /importEmbeddedWorldInfo/);
    assert.doesNotMatch(hostSource, /createWorldInfoEntry/);
    assert.match(hostSource, /export async function getTavernWorldbookRuntime/);
    assert.doesNotMatch(hostSource, /export function openTavernWorldbookEditor/);
    assert.match(hostSource, /sessionMeta\.worldbookSources/);
    assert.match(hostSource, /sessionMeta\.worldbookNames/);
    assert.match(hostSource, /function isNativeRuntimeSource/);
    assert.match(hostSource, /sourceType\) !== 'embedded'/);
    assert.match(hostSource, /runTavernWorldbookStateExclusive\(async \(\) => \{[\s\S]*await checkWorldInfo\(chatLines, maxContext, false, globalScanData\)/);
    assert.match(hostSource, /tavernWorldbookStateQueue = new Promise<void>/);
    assert.match(hostSource, /worldInfoBefore:/);
    assert.match(hostSource, /worldInfoAfter:/);
    assert.match(hostSource, /worldInfoExamples:/);
    assert.match(hostSource, /worldInfoDepth:/);
    assert.match(hostSource, /anBefore:/);
    assert.match(hostSource, /anAfter:/);
    assert.match(hostSource, /outlets:/);
    assert.match(tavernSource, /case 'xb-tavern:list-worldbook-sources':/);
    assert.match(tavernSource, /case 'xb-tavern:get-worldbook-preview':/);
    assert.match(tavernSource, /case 'xb-tavern:get-worldbook-entry':/);
    assert.match(tavernSource, /case 'xb-tavern:save-worldbook-entry':/);
    assert.match(tavernSource, /case 'xb-tavern:get-character-worldbook-state':/);
    assert.match(tavernSource, /case 'xb-tavern:activate-character-worldbook':/);
    assert.match(tavernSource, /case 'xb-tavern:bind-character-worldbook':/);
    assert.match(tavernSource, /case 'xb-tavern:get-global-worldbooks':/);
    assert.match(tavernSource, /case 'xb-tavern:set-global-worldbooks':/);
    assert.match(tavernSource, /case 'xb-tavern:get-worldbook-runtime':/);
    assert.match(appSource, /action === 'needs_import_confirmation'/);
    assert.match(appSource, /window\.confirm\(`世界书「\$\{name\}」已存在，导入角色内嵌世界书会覆盖它。继续？`\)/);
    assert.match(appSource, /payload: \{ characterId: targetId, confirmed: true \}/);
    assert.doesNotMatch(tavernSource, /case 'xb-tavern:open-worldbook-editor':/);
    assert.doesNotMatch(tavernSource, /case 'xb-tavern:list-worldbooks':/);
    assert.doesNotMatch(tavernSource, /case 'xb-tavern:get-worldbook':/);
    assert.doesNotMatch(tavernSource, /case 'xb-tavern:save-worldbook':/);
    assert.doesNotMatch(tavernSource, /chat-worldbook/);
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
    assert.match(assemblerSource, /allWorldEntries\.filter\(\(entry\) => normalizeText\(entry\.worldSourceType\) === 'embedded'\)/);
    assert.match(assemblerSource, /\.\.\.nativeWorldEntries,[\s\S]*\.\.\.localActivatedWorldEntries/);
});
