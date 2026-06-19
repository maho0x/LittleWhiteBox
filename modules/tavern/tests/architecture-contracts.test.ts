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

test('tavern startup posts frame-ready before heavy app tasks and prewarms host config', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const hostSource = readRepoFile('modules/tavern/tavern.ts');
    const mountedIndex = appSource.indexOf('onMounted(async () => {');
    const readyIndex = appSource.indexOf("postToHost('xb-tavern:frame-ready');", mountedIndex);
    assert.notEqual(mountedIndex, -1);
    assert.notEqual(readyIndex, -1);
    const beforeReady = appSource.slice(mountedIndex, readyIndex);
    assert.doesNotMatch(beforeReady, /refreshPresets\(\)|refreshSessions\(\)|warmupMemoryTokenizer\(\)|preloadXbTavernMemoryTokenizer\(\)/);
    assert.match(appSource, /await nextTick\(\);\s*postToHost\('xb-tavern:frame-ready'\);/);
    assert.doesNotMatch(appSource.slice(readyIndex, appSource.indexOf('onUnmounted', readyIndex)), /void runPostReadyStartupTasks\(\);/);
    assert.match(appSource, /if \(data\.type === 'xb-tavern:config'\) \{[\s\S]*applyHostPayload\(data\.payload \|\| \{\}\);[\s\S]*initialConfigApplied = true;[\s\S]*startPostReadyStartupTasksAfterInitialConfig\(\);/);
    assert.match(appSource, /function startPostReadyStartupTasksAfterInitialConfig\(\) \{[\s\S]*postReadyStartupStarted = true;[\s\S]*void runPostReadyStartupTasks\(\);/);
    assert.match(appSource, /async function runPostReadyStartupTasks\(\) \{[\s\S]*Promise\.allSettled\(\[\s*refreshPresets\(\),\s*refreshSessions\(\),\s*\]\)/);
    assert.doesNotMatch(appSource, /scheduleMemoryTokenizerWarmup|promoteMemoryTokenizerWarmup|preloadXbTavernMemoryTokenizer|getXbTavernMemoryTokenizerStatus/);
    assert.match(appSource, /async function runOnce[\s\S]*const controller = new AbortController\(\);[\s\S]*isRunning\.value = true;[\s\S]*const runtimeContext = await resolveRuntimeContextForSession/);
    assert.match(appSource, /async function handleManagerSubmit\(\) \{[\s\S]*isManagerAssistantRunning\.value = true;[\s\S]*managerInputStatus\.value = '准备中';[\s\S]*await sendManagerQuestion\(managerSessionId, text\);/);
    assert.match(hostSource, /let initialConfigPromise: Promise<Record<string, unknown>> \| null = null;/);
    assert.match(hostSource, /function prepareInitialConfig\(\): void \{[\s\S]*initialConfigPromise = promise;/);
    assert.match(hostSource, /async function sendInitialConfigToFrame\(\): Promise<void> \{[\s\S]*const promise = initialConfigPromise \|\| buildFrameConfigPayload\(\);[\s\S]*postToFrame\('xb-tavern:config', await promise\);/);
    assert.match(hostSource, /async function openTavern\(\): Promise<void> \{[\s\S]*prepareInitialConfig\(\);[\s\S]*await createOverlay\(\);/);
    assert.match(hostSource, /case 'xb-tavern:frame-ready':[\s\S]*void sendInitialConfigToFrame\(\)\.catch\(\(error\) => \{[\s\S]*failed to send initial config[\s\S]*\}\)\.finally\(flushPendingMessages\);/);
});

test('tavern assistant preset settings expose state and character memory rules', () => {
    const controllerSource = readRepoFile('modules/tavern/app-src/components/settings/useTavernSettingsController.ts');
    const sectionMatch = controllerSource.match(/const assistantPresetSections:[\s\S]*?];/);
    assert.ok(sectionMatch);
    const sectionSource = sectionMatch[0];
    assert.match(sectionSource, /key: 'statePrompt'/);
    assert.match(sectionSource, /key: 'characterPrompt'/);
    assert.equal((sectionSource.match(/key:/g) || []).length, 2);
});

test('tavern worldbook bridge edits named entries through native save boundary', () => {
    const badSplits = sourceMatches(/split\(\s*\/\\r\?\\n\|,\//);
    assert.deepEqual(badSplits, []);
    const hostSource = readRepoFile('modules/tavern/host/worldbooks.ts');
    assert.match(hostSource, /export async function listTavernWorldbookSources/);
    assert.match(hostSource, /export async function getTavernWorldbookPreview/);
    assert.match(hostSource, /await loadWorldInfo\(name\)/);
    assert.match(hostSource, /export async function getTavernWorldbookEntry/);
    assert.match(hostSource, /export async function saveTavernWorldbookEntry/);
    assert.match(hostSource, /function normalizeIdText/);
    assert.match(hostSource, /uid: normalizeIdText\(entry\.uid \?\? entry\.id \?\? slot\.index\)/);
    assert.match(hostSource, /buildWorldbookEntryHash/);
    assert.match(hostSource, /patchWorldbookEntry/);
    assert.doesNotMatch(hostSource, /if \('name' in draft\)|if \('title' in draft\)|name: asEditableText\(entry\.name\)|title: asEditableText\(entry\.title\)/);
    assert.match(hostSource, /function syncWorldbookOriginalDataEntry/);
    assert.match(hostSource, /syncWorldbookOriginalDataEntry\(asRecord\(data\), uid, slot\.entry\);[\s\S]*await saveWorldInfo\(name, data, true\)/);
    assert.match(hostSource, /if \('secondary_keys' in entry && \('secondary_keys' in draft \|\| 'secondaryKeys' in draft\)\)/);
    assert.match(hostSource, /const keysecondary = normalizeStringList\(draft\.keysecondary\);[\s\S]*entry\.secondary_keys = keysecondary\.length \? keysecondary : normalizeStringList\(draft\.secondary_keys \?\? draft\.secondaryKeys\)/);
    assert.match(hostSource, /await saveWorldInfo\(name, data, true\)/);
    assert.match(hostSource, /export async function getTavernWorldbookRuntime/);
    assert.match(hostSource, /let tavernWorldbookStateQueue: Promise<void> = Promise\.resolve\(\);/);
    assert.match(hostSource, /function runTavernWorldbookStateExclusive/);
    assert.match(hostSource, /function isLittleWhiteBoxRuntimeWorldbookSource[\s\S]*sourceType === 'character' \|\| sourceType === 'global'/);
    assert.match(hostSource, /dedupeSources\(\[\.{3}metaSources, \.{3}legacyMetaSources, \.{3}bookSources\]\)[\s\S]*\.filter\(isLittleWhiteBoxRuntimeWorldbookSource\)/);
    assert.match(hostSource, /return runTavernWorldbookStateExclusive\(async \(\) => \{[\s\S]*await checkWorldInfo\(chatLines, maxContext, false, globalScanData\)[\s\S]*restoreRuntimeState\(snapshot\);/);
    assert.match(hostSource, /export async function saveTavernWorldbookEntry[\s\S]*return runTavernWorldbookStateExclusive\(async \(\) => \{/);
    assert.match(hostSource, /export async function getTavernGlobalWorldbooks[\s\S]*return runTavernWorldbookStateExclusive\(\(\) => readGlobalWorldbooksState\(\)\);/);
    assert.match(hostSource, /characterDepthPrompt: normalizeText\([\s\S]*characterRecord\.characterDepthPrompt[\s\S]*depthPrompt\.prompt[\s\S]*legacyDepthPrompt\.prompt/);
    assert.doesNotMatch(hostSource, /openWorldInfoEditor/);
    assert.doesNotMatch(hostSource, /createWorldInfoEntry/);
    assert.match(hostSource, /export async function setTavernGlobalWorldbooks/);
    assert.match(hostSource, /updateWorldInfoSettings\(settings, selected\)/);
});

test('tavern mobile worldbook entry rows stay compact', () => {
    const worldbookSource = readRepoFile('modules/tavern/app-src/components/settings/TavernWorldbooksSettingsPanel.vue');
    const worldbookCss = readRepoFile('modules/tavern/app-src/styles/settings/worldbooks.css');
    const mobileCss = readRepoFile('modules/tavern/app-src/styles/settings/mobile.css');

    assert.match(worldbookSource, /function worldbookEntryStateLabel[\s\S]*return '×';[\s\S]*return '🔵';[\s\S]*return '🔗';[\s\S]*return '🟢';/);
    assert.doesNotMatch(worldbookSource, /return '🔵 常驻'|return '🔗 向量'|return '🟢 普通'/);
    assert.match(worldbookSource, /class="worldbook-entry-editor-actions"[\s\S]*class="worldbook-row-open"[\s\S]*取消[\s\S]*class="primary-action"[\s\S]*保存[\s\S]*<\/div>\s*<\/div>\s*<div class="worldbook-entry-core-grid">/);
    assert.match(worldbookSource, /class="worldbook-entry-title-row"[\s\S]*>条目名<[\s\S]*class="worldbook-entry-active-toggle"[\s\S]*>启用</);
    assert.doesNotMatch(worldbookCss, /\.worldbook-entry-position\s*\{[^}]*grid-row:\s*2;/);
    assert.doesNotMatch(mobileCss, /\.worldbook-entry-position\s*\{[^}]*grid-row:\s*2;/);
    assert.doesNotMatch(worldbookCss, /padding: 2px 0 calc\(82px \+ env\(safe-area-inset-bottom, 0px\)\);/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-preview summary \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto auto 12px;/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-editor-head \{[\s\S]*display: contents;/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-editor-actions \{[\s\S]*position: sticky;[\s\S]*bottom: calc\(8px \+ env\(safe-area-inset-bottom, 0px\)\);[\s\S]*order: 100;[\s\S]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-active-toggle \{[\s\S]*grid-template-rows: 14px var\(--worldbook-entry-control-height\);[\s\S]*padding-top: 0;/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-core-grid \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*align-items: stretch;/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-title-row \{[\s\S]*order: 1;[\s\S]*grid-column: 1 \/ -1;/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-position-field \{[\s\S]*order: 2;[\s\S]*\.worldbook-entry-state-field \{[\s\S]*order: 3;[\s\S]*\.worldbook-entry-depth-field \{[\s\S]*order: 4;/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-order-field \{[\s\S]*order: 5;[\s\S]*grid-column: 1;[\s\S]*\.worldbook-entry-probability-field \{[\s\S]*order: 6;[\s\S]*grid-column: 2;[\s\S]*\.worldbook-entry-scan-depth-field \{[\s\S]*order: 7;[\s\S]*grid-column: 3;/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-core-grid > label,[\s\S]*\.worldbook-entry-title-row > label:not\(\.worldbook-entry-active-toggle\),[\s\S]*\.worldbook-entry-key-grid > label,[\s\S]*\.worldbook-entry-key-grid \.worldbook-entry-logic-field,[\s\S]*\.worldbook-entry-advanced-grid > label \{[\s\S]*grid-template-rows: 14px var\(--worldbook-entry-control-height\);[\s\S]*align-self: stretch;/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-core-grid > label > span,[\s\S]*\.worldbook-entry-title-row > label:not\(\.worldbook-entry-active-toggle\) > span,[\s\S]*\.worldbook-entry-key-grid > label > span,[\s\S]*\.worldbook-entry-key-grid \.worldbook-entry-logic-field > span,[\s\S]*\.worldbook-entry-advanced-grid > label > span \{[\s\S]*height: 14px;[\s\S]*white-space: nowrap;/);
    assert.match(mobileCss, /\.settings-layout\.is-worldbooks-workspace \.worldbook-entry-preview summary \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto auto 12px;/);
    assert.match(mobileCss, /\.settings-layout\.is-worldbooks-workspace \.worldbook-entry-preview\[open\] \{[\s\S]*margin: 6px 0;[\s\S]*padding: 0 8px 8px;/);
    assert.match(mobileCss, /\.settings-layout\.is-worldbooks-workspace \.worldbook-entry-body \{[\s\S]*max-height: none;[\s\S]*overflow: visible;/);
});

test('tavern desktop worldbook editor keeps dense readable rows', () => {
    const worldbookSource = readRepoFile('modules/tavern/app-src/components/settings/TavernWorldbooksSettingsPanel.vue');
    const worldbookCss = readRepoFile('modules/tavern/app-src/styles/settings/worldbooks.css');

    assert.match(worldbookSource, /class="worldbook-entry-core-grid"[\s\S]*>条目名<[\s\S]*>状态<[\s\S]*>注入位置<[\s\S]*>触发概率<[\s\S]*>扫描深度<[\s\S]*<\/div>\s*<div class="worldbook-entry-key-grid">/);
    assert.match(worldbookSource, />关键词<[\s\S]*class="worldbook-entry-filter-controls"[\s\S]*>过滤逻辑<[\s\S]*<option value="off">[\s\S]*关闭[\s\S]*>可选过滤</);
    assert.match(worldbookSource, /function worldbookFilterLogicValue[\s\S]*return draft\.selective \? String\(Number\(draft\.selectiveLogic\) \|\| 0\) : 'off';/);
    assert.match(worldbookSource, /function updateWorldbookFilterLogic[\s\S]*value === 'off'[\s\S]*selective: false[\s\S]*selective: true/);
    assert.doesNotMatch(worldbookSource, /worldbook-entry-inline-check|worldbook-entry-filter-toggle|>启用过滤</);
    assert.doesNotMatch(worldbookSource, />Selective</);
    assert.doesNotMatch(worldbookSource, />Outlet Name<|>Scan Depth<|>Case-Sensitive<|>Whole Words<|>Group Scoring<|>Automation ID<|>Inclusion Group<|>Group Weight<|>Sticky<|>Cooldown<|>Delay<|>Use Probability<|>Ignore Budget<|>Exclude Recursion<|>Prevent Recursion<|>Prioritize Group<|>Delay Until Recursion<|>Recursion Level<|>Generation Triggers</);
    assert.match(worldbookSource, />注入出口<[\s\S]*>区分大小写<[\s\S]*>全词匹配<[\s\S]*>分组评分/);
    assert.doesNotMatch(worldbookSource, />注入出口<[\s\S]*>扫描深度<[\s\S]*>区分大小写/);
    assert.match(worldbookSource, />跟随全局<[\s\S]*>启用概率<[\s\S]*>忽略预算<[\s\S]*>生成触发</);
    assert.match(worldbookCss, /\.worldbook-entry-core-grid \{[\s\S]*grid-template-columns:[\s\S]*minmax\(180px, 220px\)[\s\S]*repeat\(4, minmax\(72px, 0\.38fr\)\);/);
    assert.match(worldbookCss, /\.worldbook-entry-core-grid > label,[\s\S]*\.worldbook-entry-title-row > label:not\(\.worldbook-entry-active-toggle\),[\s\S]*\.worldbook-entry-key-grid > label,[\s\S]*\.worldbook-entry-key-grid \.worldbook-entry-logic-field,[\s\S]*\.worldbook-entry-advanced-grid > label \{[\s\S]*grid-template-rows: 14px var\(--worldbook-entry-control-height\);[\s\S]*min-height: calc\(14px \+ 6px \+ var\(--worldbook-entry-control-height\)\);[\s\S]*align-self: stretch;/);
    assert.match(worldbookCss, /\.worldbook-entry-core-grid > label > span,[\s\S]*\.worldbook-entry-title-row > label:not\(\.worldbook-entry-active-toggle\) > span,[\s\S]*\.worldbook-entry-key-grid > label > span,[\s\S]*\.worldbook-entry-key-grid \.worldbook-entry-logic-field > span,[\s\S]*\.worldbook-entry-advanced-grid > label > span \{[\s\S]*height: 14px;[\s\S]*line-height: 14px;[\s\S]*white-space: nowrap;/);
    assert.match(worldbookCss, /\.worldbook-entry-key-grid \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) minmax\(132px, 170px\) minmax\(0, 1fr\);/);
    assert.match(worldbookCss, /\.worldbook-entry-filter-controls \{[\s\S]*display: contents;/);
    assert.match(worldbookCss, /\.worldbook-entry-logic-field \{[\s\S]*align-self: end;[\s\S]*width: 100%;/);
    assert.match(worldbookCss, /\.worldbook-entry-editor \{[\s\S]*--worldbook-entry-control-height: 38px;/);
    assert.match(worldbookCss, /\.worldbook-entry-editor input\[type="text"\],[\s\S]*\.worldbook-entry-editor input\[type="number"\],[\s\S]*\.worldbook-entry-editor select \{[\s\S]*height: var\(--worldbook-entry-control-height\);[\s\S]*min-height: var\(--worldbook-entry-control-height\);/);
    assert.match(worldbookCss, /\.worldbook-entry-editor input\[type="text"\],[\s\S]*\.worldbook-entry-editor input\[type="number"\],[\s\S]*\.worldbook-entry-editor select \{[\s\S]*appearance: none;[\s\S]*height: var\(--worldbook-entry-control-height\);/);
    assert.match(worldbookCss, /\.worldbook-entry-editor select \{[\s\S]*padding-right: 24px;[\s\S]*background-image:[\s\S]*linear-gradient\(45deg, transparent 50%, var\(--xb-text-muted\) 50%\)/);
    assert.match(worldbookSource, /class="worldbook-entry-editor-lines worldbook-entry-keywords-field"[\s\S]*<input[\s\S]*type="text"[\s\S]*listFromCommaText\(\(\$event\.target as HTMLInputElement\)\.value\)/);
    assert.match(worldbookSource, /class="worldbook-entry-editor-lines worldbook-entry-triggers-field"[\s\S]*<input[\s\S]*type="text"[\s\S]*listFromCommaText\(\(\$event\.target as HTMLInputElement\)\.value\)/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-editor \{[\s\S]*--worldbook-entry-control-height: 34px;/);
    assert.match(worldbookCss, /\.worldbook-entry-preview\[open\] \{[\s\S]*border-left: 3px solid var\(--xb-cyan\);[\s\S]*background:[\s\S]*box-shadow:/);
    assert.match(worldbookCss, /\.worldbook-entry-preview\[open\] summary \{[\s\S]*border-bottom: 1px solid var\(--xb-line\);/);
    assert.match(worldbookCss, /\.worldbook-entry-body \{[\s\S]*background: rgba\(0, 0, 0, 0\.08\);/);
    assert.match(worldbookCss, /@media \(max-width: 560px\) \{[\s\S]*\.worldbook-entry-body \{[\s\S]*max-height: none;[\s\S]*overflow: visible;/);
});

test('tavern character and global worldbook actions stay on native ST boundaries', () => {
    const hostSource = readRepoFile('modules/tavern/host/worldbooks.ts');
    const tavernSource = readRepoFile('modules/tavern/tavern.ts');
    const characterSource = readRepoFile('modules/tavern/app-src/components/TavernCharacterSelectPage.vue');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const worldbookSource = readRepoFile('modules/tavern/app-src/components/settings/TavernWorldbooksSettingsPanel.vue');
    const settingsControllerSource = readRepoFile('modules/tavern/app-src/components/settings/useTavernSettingsController.ts');

    assert.match(hostSource, /export async function getTavernCharacterWorldbookState/);
    assert.match(hostSource, /export async function activateTavernCharacterWorldbook/);
    assert.match(hostSource, /export async function bindTavernCharacterWorldbook/);
    assert.match(hostSource, /export async function getTavernGlobalWorldbooks/);
    assert.match(hostSource, /export async function setTavernGlobalWorldbooks/);
    assert.doesNotMatch(hostSource, /importEmbeddedWorldInfo/);
    assert.doesNotMatch(hostSource, /openWorldInfoEditor/);
    assert.doesNotMatch(`${hostSource}\n${appSource}\n${characterSource}`, /not_current_character|只能给当前酒馆角色|请先切到当前角色/);
    assert.doesNotMatch(characterSource, /isCurrentCharacter === false/);
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
    assert.match(hostSource, /export async function bindTavernCharacterWorldbook[\s\S]*return runTavernWorldbookStateExclusive\(async \(\) => \{[\s\S]*return bindCharacterWorldbookThroughEditor\(characterId, name\);/);
    assert.match(hostSource, /export async function activateTavernCharacterWorldbook[\s\S]*return runTavernWorldbookStateExclusive\(async \(\) => \{[\s\S]*const boundState = await bindCharacterWorldbookThroughEditor/);
    assert.match(hostSource, /updateWorldInfoSettings\(settings, selected\);[\s\S]*await updateWorldInfoList\(\);/);
    assert.match(tavernSource, /case 'xb-tavern:get-character-worldbook-state':/);
    assert.match(tavernSource, /case 'xb-tavern:activate-character-worldbook':/);
    assert.match(tavernSource, /case 'xb-tavern:bind-character-worldbook':/);
    assert.match(tavernSource, /case 'xb-tavern:get-global-worldbooks':/);
    assert.match(tavernSource, /case 'xb-tavern:set-global-worldbooks':/);
    assert.doesNotMatch(tavernSource, /chat-worldbook/);
    assert.match(characterSource, /const characterWorldbookBound = computed/);
    assert.match(characterSource, /class="dossier-title-row"[\s\S]*<h3>\{\{ selectedCharacter\.name \}\}<\/h3>[\s\S]*'is-bound': characterWorldbookBound[\s\S]*open-character-worldbook[\s\S]*会话档案[\s\S]*新建聊天/);
    assert.match(appSource, /requestHost\('xb-tavern:get-character-worldbook-state'/);
    assert.match(appSource, /requestHost\('xb-tavern:activate-character-worldbook'/);
    assert.match(appSource, /requestHost\('xb-tavern:bind-character-worldbook'/);
    assert.match(appSource, /action === 'needs_import_confirmation'/);
    assert.match(appSource, /payload: \{ characterId: targetId, confirmed: true \}/);
    assert.match(settingsControllerSource, /function openWorldbookWorkspace\(name = ''\)/);
    assert.match(settingsControllerSource, /selectedWorldbookName\.value = targetName/);
    assert.match(settingsControllerSource, /openSettingsWorkspace\('worldbooks'\)/);
    assert.match(appSource, /openWorldbookWorkspace\(String\(payload\.name \|\| ''\)\)/);
    assert.match(appSource, /openWorldbookWorkspace\(targetName\)/);
    assert.match(appSource, /const currentWorldbookCharacterId = computed\(\(\) => \([\s\S]*selectedSession\.value\?\.characterId[\s\S]*effectiveContext\.value\.character\?\.id/);
    assert.match(appSource, /useTavernSettingsController\(\{[\s\S]*effectiveContext,[\s\S]*currentWorldbookCharacterId,/);
    assert.match(settingsControllerSource, /async function syncWorldbooksForCurrentCharacter\(\)[\s\S]*const requestSerial = \+\+worldbookSyncRequestSerial;[\s\S]*options\.currentWorldbookCharacterId\.value[\s\S]*requestHost\('xb-tavern:get-character-worldbook-state'[\s\S]*requestSerial !== worldbookSyncRequestSerial[\s\S]*boundName && payload\.boundExists === true[\s\S]*syncWorldbooksFromHost\(\{ preferredName: boundName, requestSerial \}\)/);
    assert.match(settingsControllerSource, /async function syncWorldbooksFromHost\(syncOptions: TavernWorldbookSyncOptions = \{\}\)[\s\S]*const requestSerial = syncOptions\.requestSerial \|\| \+\+worldbookSyncRequestSerial;[\s\S]*if \(requestSerial !== worldbookSyncRequestSerial\) \{return;\}/);
    assert.match(settingsControllerSource, /const fallbackName = syncOptions\.selectFirst[\s\S]*: '';/);
    assert.doesNotMatch(settingsControllerSource, /worldbookOptions\.value\[0\]\?\.name[\s\S]*selectedWorldbookName\.value = syncOptions\.keepSelection/);
    assert.doesNotMatch(appSource, /action === 'opened'/);
    assert.doesNotMatch(appSource, /postToHost\('xb-tavern:close'\);[\s\S]*return;[\s\S]*action === 'imported'/);
    assert.match(worldbookSource, /class="worldbook-section worldbook-global-enable"[\s\S]*<h3>已启用的全局世界书<\/h3>[\s\S]*class="worldbook-section worldbook-main-section"[\s\S]*<h3>世界书操作<\/h3>[\s\S]*class="preset-command-bar worldbook-command-bar"[\s\S]*class="preset-source-select worldbook-source-select"/);
    assert.match(worldbookSource, /<option value="">\s*未选择\s*<\/option>/);
    assert.doesNotMatch(worldbookSource, /worldbook-section-kicker|全局区|操作区/);
    assert.match(worldbookSource, /:disabled="globalWorldbookSaving"/);
    assert.doesNotMatch(worldbookSource, /打开酒馆编辑器/);
    assert.doesNotMatch(worldbookSource, /worldbookSourceSummary/);
    assert.doesNotMatch(worldbookSource, /worldbookGlobalCount/);
    assert.doesNotMatch(worldbookSource, /聊天世界书/);
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
    const hostSource = readRepoFile('modules/tavern/tavern.ts');
    const nativePromptSource = readRepoFile('modules/tavern/host/native-prompt.ts');
    const conversationSource = readRepoFile('modules/tavern/app-src/components/chat/TavernConversationPanel.vue');
    assert.match(appSource, /lastRequestSnapshot\.value\?\.rawRequestJson \|\| lastRequestSnapshot\.value\?\.rawMessagesJson/);
    assert.match(appSource, /simulateRequestJson\.value = result\.requestSnapshot\.rawRequestJson \|\| result\.requestSnapshot\.rawMessagesJson/);
    assert.match(appSource, /simulateXbTavernRequest\(\{[\s\S]*chatPreset: runtimeChatPreset\.value/);
    assert.match(appSource, /runXbTavernTurn\(\{[\s\S]*chatPreset: runtimeChatPreset\.value/);
    assert.doesNotMatch(appSource, /simulateXbTavernRequest\(\{[\s\S]*chatPreset: activeChatPreset\.value/);
    assert.doesNotMatch(appSource, /runXbTavernTurn\(\{[\s\S]*chatPreset: activeChatPreset\.value/);
    assert.match(appSource, /runXbTavernTurn\(\{[\s\S]*buildNativeChatPrompt,/);
    assert.match(appSource, /xb-tavern:build-native-chat-prompt[\s\S]*signal: input\.signal/);
    assert.doesNotMatch(appSource, /host_request_timeout|HOST_REQUEST_TIMEOUT_MS|const timeoutMs =/);
    assert.match(appSource, /postToHost\('xb-tavern:cancel-request', \{ requestId \}\);/);
    assert.match(appSource, /runtimePendingUserMessage\.value = messageText/);
    assert.match(conversationSource, /class="chat-bubble from-user pending-user"/);
    assert.match(runtimeSource, /async function applyNativeChatPromptBuild/);
    assert.match(runtimeSource, /stage: 'simulate_native_prompt_build'/);
    assert.match(runtimeSource, /stage: 'turn_native_prompt_build'/);
    assert.match(runtimeSource, /debugStage: input\.stage/);
    assert.match(runtimeSource, /signal: input\.signal/);
    assert.match(runtimeSource, /turn stage start/);
    assert.match(runtimeSource, /turn stage end/);
    assert.match(nativePromptSource, /nativePromptAbortControllers/);
    assert.match(nativePromptSource, /export function cancelTavernNativeChatPrompt/);
    assert.match(hostSource, /cancelTavernNativeChatPrompt\(requestId\)/);
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
    const chatPageSource = readRepoFile('modules/tavern/app-src/components/chat/TavernChatPage.vue');
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
    assert.match(chatPageSource, /function setChatApiSettingsRootRef/);
    assert.match(chatPageSource, /:ref="setChatApiSettingsRootRef"/);
    assert.match(conversationPanelSource, /function setChatScrollRef/);
    assert.match(conversationPanelSource, /function setChatComposeTextareaRef/);
    assert.match(managerPanelSource, /function setManagerScrollRef/);
    assert.match(managerPanelSource, /function setManagerComposeTextareaRef/);
    assert.doesNotMatch(`${chatPageSource}\n${conversationPanelSource}\n${managerPanelSource}\n${apiPanelSource}`, /ref="(?:apiSettingsRootRef|chatScrollRef|chatComposeTextareaRef|managerScrollRef|managerComposeTextareaRef)"/);
});

test('agent API settings keep preset actions compact and model controls before temperature', () => {
    const markupSource = readRepoFile('modules/agent-core/ui/settings-markup.js');
    const panelSource = readRepoFile('modules/agent-core/ui/settings-panel.js');
    const apiCss = readRepoFile('modules/tavern/app-src/styles/settings/api.css');
    assert.match(markupSource, /function buildPresetActionIcon/);
    assert.match(markupSource, /function getAgentConfigSaveIconName/);
    assert.match(markupSource, /saving: '<path class="xb-assistant-save-spinner"/);
    assert.match(markupSource, /success: '<path d="M20 6 9 17l-5-5"/);
    assert.match(markupSource, /error: '<path d="M18 6 6 18"/);
    assert.match(markupSource, /class="xb-assistant-preset-row"[\s\S]*<select id="xb-assistant-preset-select" class="xb-assistant-preset-field" aria-label="已存预设"><\/select>[\s\S]*id="xb-assistant-new-preset"[\s\S]*buildPresetActionIcon\('add'\)[\s\S]*id="xb-assistant-rename-preset"[\s\S]*buildPresetActionIcon\('rename'\)[\s\S]*id="xb-assistant-save"[\s\S]*buildPresetActionIcon\(saveIcon\)[\s\S]*id="xb-assistant-delete-preset"[\s\S]*buildPresetActionIcon\('delete'\)/);
    assert.match(markupSource, /id="xb-assistant-delegate-preset-select"[\s\S]*id="xb-assistant-delegate-save"[\s\S]*buildPresetActionIcon\(saveIcon\)/);
    assert.doesNotMatch(markupSource, /<span>已存预设<\/span>/);
    assert.doesNotMatch(markupSource, />(?:➕|✏|💾|🗑)/u);
    assert.match(markupSource, /id="xb-assistant-model"[\s\S]*id="xb-assistant-model-pulled"[\s\S]*id="xb-assistant-temperature"/);
    assert.match(markupSource, /id="xb-assistant-delegate-model"[\s\S]*id="xb-assistant-delegate-model-pulled"[\s\S]*id="xb-assistant-delegate-temperature"/);
    assert.doesNotMatch(markupSource, /<span>预设名称<\/span>/);
    assert.doesNotMatch(markupSource, /class="xb-assistant-actions"/);
    assert.match(panelSource, /function createPresetFromForm/);
    assert.match(panelSource, /function renameCurrentPreset/);
    assert.match(panelSource, /#xb-assistant-new-preset/);
    assert.match(panelSource, /#xb-assistant-rename-preset/);
    assert.match(panelSource, /#xb-assistant-delegate-save/);
    assert.match(apiCss, /\.tavern-api-settings \.xb-assistant-preset-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
    assert.match(apiCss, /xb-tavern-api-save-spin/);
    assert.doesNotMatch(apiCss, /\.tavern-api-settings \.xb-assistant-preset-row \{[^}]*grid-template-rows:/);
    assert.match(apiCss, /\.tavern-api-settings \.xb-assistant-preset-tools \{[^}]*grid-template-columns: repeat\(4, 40px\);/);
    assert.match(apiCss, /\.tavern-api-settings \.xb-assistant-icon-button \{[^}]*height: 40px;/);
    assert.match(apiCss, /\.tavern-api-settings \.xb-assistant-icon-button svg \{[\s\S]*stroke: currentColor;/);
});

test('tavern chat exposes local settings modals without leaving the session', () => {
    const cornerSource = readRepoFile('modules/tavern/app-src/components/TavernCornerActions.vue');
    const chatPageSource = readRepoFile('modules/tavern/app-src/components/chat/TavernChatPage.vue');
    const settingsPageSource = readRepoFile('modules/tavern/app-src/components/settings/TavernSettingsPage.vue');
    const chatLayoutCss = readRepoFile('modules/tavern/app-src/styles/chat/layout.css');
    const chatQuickSettingsCss = readRepoFile('modules/tavern/app-src/styles/chat/quick-settings.css');
    const settingsControllerSource = readRepoFile('modules/tavern/app-src/components/settings/useTavernSettingsController.ts');
    const assistantPresetPanelSource = readRepoFile('modules/tavern/app-src/components/settings/TavernAssistantPresetSettingsPanel.vue');
    const stylesSource = readRepoFile('modules/tavern/app-src/styles.css');

    assert.match(cornerSource, /includeApi\?: boolean/);
    assert.match(cornerSource, /includeChatPreset\?: boolean/);
    assert.match(cornerSource, /includeWorldbooks\?: boolean/);
    assert.match(cornerSource, /homeLast\?: boolean/);
    assert.match(cornerSource, /v-if="includeChatPreset"[\s\S]*class="home-icon-button page-chat-preset-button"[\s\S]*v-if="includeApi"[\s\S]*class="home-icon-button page-api-button"[\s\S]*v-if="includeWorldbooks"[\s\S]*class="home-icon-button page-worldbooks-button"[\s\S]*class="home-icon-button home-theme-button"[\s\S]*v-if="includeHome && homeLast"[\s\S]*class="home-icon-button page-home-button"/);
    assert.match(chatPageSource, /<TavernCornerActions[\s\S]*include-api[\s\S]*include-chat-preset[\s\S]*include-home[\s\S]*include-worldbooks[\s\S]*home-last[\s\S]*@api="openQuickSettingsModal\('api'\)"[\s\S]*@chat-preset="openQuickSettingsModal\('chatPreset'\)"[\s\S]*@worldbooks="openQuickSettingsModal\('worldbooks'\)"/);
    assert.match(settingsPageSource, /<TavernCornerActions[\s\S]*include-home[\s\S]*home-last[\s\S]*@home="activeView = 'home'"[\s\S]*@toggle-theme="homeThemeDark = !homeThemeDark"/);
    assert.match(chatPageSource, /class="chat-mobile-action-group"[\s\S]*title="聊天预设"[\s\S]*title="API 配置"[\s\S]*title="世界书"[\s\S]*title="首页"/);
    assert.match(chatPageSource, /const quickSettingsOpen = ref<'api' \| 'chatPreset' \| 'worldbooks' \| null>\(null\)/);
    assert.match(chatPageSource, /function openQuickSettingsModal\(workspace: 'api' \| 'chatPreset' \| 'worldbooks'\)[\s\S]*activeSettingsWorkspace\.value = workspace;[\s\S]*syncChatPresetFromHost\(\)[\s\S]*syncWorldbooksForCurrentCharacter\(\)[\s\S]*syncGlobalWorldbooksFromHost\(\)/);
    assert.doesNotMatch(chatPageSource, /syncWorldbooksFromHost\(\{ keepSelection: true \}\)/);
    assert.match(chatPageSource, /class="chat-quick-settings-overlay"[\s\S]*class="tavern-api-settings chat-quick-api-root"[\s\S]*class="settings-layout chat-quick-settings-layout"[\s\S]*<TavernChatPresetSettingsPanel \/>[\s\S]*<TavernWorldbooksSettingsPanel \/>/);
    assert.match(chatPageSource, /class="chat-quick-settings-body"[\s\S]*:class="quickSettingsLayoutClass"/);
    assert.doesNotMatch(chatPageSource, /class="chat-quick-settings-overlay"[\s\S]*@click\.self="closeQuickSettingsModal"/);
    assert.match(chatPageSource, /class="chat-quick-settings-close"[\s\S]*@click="closeQuickSettingsModal"/);
    assert.match(chatPageSource, /function setChatApiSettingsRootRef[\s\S]*apiSettingsRootRef\.value = element instanceof HTMLElement \? element : null;/);
    assert.match(settingsControllerSource, /\(\) => apiSettingsRootRef\.value,[\s\S]*if \(apiSettingsRootRef\.value\) \{[\s\S]*nextTick\(renderApiSettingsPanel\)/);
    assert.match(chatLayoutCss, /\.chat-quick-settings-overlay \{[\s\S]*position: absolute;[\s\S]*backdrop-filter: blur\(16px\);/);
    assert.match(chatLayoutCss, /\.chat-quick-settings-dialog \{[\s\S]*max-height: min\(88vh, 900px\);/);
    assert.match(chatLayoutCss, /\.chat-quick-settings-dialog \{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\);/);
    assert.match(chatLayoutCss, /--xb-chat-scroll-padding: 34px 0 0;/);
    assert.match(chatLayoutCss, /--xb-chat-scroll-padding: 22px 0 0;/);
    assert.match(chatLayoutCss, /--xb-chat-scroll-padding: 18px 0 0;/);
    assert.doesNotMatch(chatLayoutCss, /--xb-chat-scroll-padding:\s*\d+px\s+(?:8|10|12)px/);
    assert.match(stylesSource, /@import '\.\/styles\/settings\.css';\s*@import '\.\/styles\/chat\/quick-settings\.css';/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout \{[\s\S]*display: block;[\s\S]*grid-template-columns: none;[\s\S]*overflow: visible;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout \{[\s\S]*--xb-settings-control-bg: var\(--xb-bg-card\);[\s\S]*--xb-settings-sheet-bg: var\(--xb-chat-pop-bg\);/);
    assert.match(chatQuickSettingsCss, /\.xb-os-shell\.theme-light \.settings-layout\.chat-quick-settings-layout \{[\s\S]*--xb-settings-control-bg: var\(--xb-paper-plain\);[\s\S]*--xb-settings-control-focus-bg: #ffffff;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout \.xb-main \{[\s\S]*background: transparent;[\s\S]*padding: 0;/);
    assert.match(chatQuickSettingsCss, /\.chat-quick-settings-body\.is-chatPreset-workspace \{[\s\S]*height: 100%;[\s\S]*display: grid;[\s\S]*overflow: hidden;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace,[\s\S]*\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.xb-main,[\s\S]*\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.step-panel \{[\s\S]*height: 100%;[\s\S]*overflow: hidden;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.preset-workspace \{[\s\S]*height: 100%;[\s\S]*display: flex;[\s\S]*overflow: hidden;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.preset-studio \{[\s\S]*flex: 1 1 auto;[\s\S]*height: 100%;[\s\S]*overflow: hidden;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.prompt-sequence-panel \{[\s\S]*height: 100%;[\s\S]*overflow: hidden;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.prompt-manager-list \{[\s\S]*flex: 1 1 auto;[\s\S]*overflow: auto;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.prompt-edit-button \{[\s\S]*display: grid;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.preset-preview-panel \{[\s\S]*z-index: 1;[\s\S]*background: var\(--xb-settings-sheet-bg\);/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.prompt-detail-form \{[\s\S]*flex: 1 1 auto;[\s\S]*overflow: auto;[\s\S]*background: var\(--xb-settings-sheet-bg\);/);
    assert.match(chatQuickSettingsCss, /@media \(max-width: 760px\) \{[\s\S]*\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.preset-preview-panel\.prompt-editor-panel \{[\s\S]*position: fixed;[\s\S]*z-index: 180;[\s\S]*inset:[\s\S]*max\(10px, env\(safe-area-inset-top, 0px\)\)[\s\S]*overflow: hidden;[\s\S]*border-radius: 14px;/);
    assert.match(chatQuickSettingsCss, /@media \(max-width: 760px\) \{[\s\S]*\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.prompt-detail-form \{[\s\S]*flex: 1 1 auto;[\s\S]*overflow: auto;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-worldbooks-workspace \.worldbook-entry-editor \{[\s\S]*z-index: 1;[\s\S]*background: var\(--xb-settings-sheet-bg\);/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-worldbooks-workspace \.worldbook-entry-editor input\[type="text"\],[\s\S]*background-color: var\(--xb-settings-control-bg\);/);
    assert.doesNotMatch(settingsControllerSource, /activeView\.value !== 'settings' \|\| options\.activeSettingsWorkspace\.value !== 'worldbooks'/);
    assert.match(settingsControllerSource, /watch\(selectedWorldbookName, \(name\) => \{[\s\S]*activeSettingsWorkspace\.value !== 'worldbooks'[\s\S]*loadSelectedWorldbookPreview\(name\)/);
    assert.match(settingsControllerSource, /workspace === 'assistantPreset'[\s\S]*void refreshPresets\(\);/);
    assert.match(assistantPresetPanelSource, />维护规则</);
    assert.doesNotMatch(assistantPresetPanelSource, />记忆档案</);
});

test('tavern map update badge stays collapsed until requested', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const contextSource = readRepoFile('modules/tavern/app-src/components/tavern-app-context.ts');
    const mapPanelSource = readRepoFile('modules/tavern/app-src/components/TavernMapPanel.vue');
    const mapCss = readRepoFile('modules/tavern/app-src/styles/chat/map.css');

    assert.match(mapPanelSource, /const mapBadgeExpanded = ref\(false\)/);
    assert.doesNotMatch(mapPanelSource, /mapBadgeExpanded\.value = true/);
    assert.match(mapPanelSource, /function toggleMapBadge\(\) \{[\s\S]*mapBadgeExpanded\.value = !mapBadgeExpanded\.value/);
    assert.match(mapPanelSource, /const mapPanOffset = ref<\[number, number\]>\(\[0, 0\]\)/);
    assert.match(mapPanelSource, /function handleMapPointerDown\(event: PointerEvent\)/);
    assert.match(mapPanelSource, /@pointerdown="handleMapPointerDown"[\s\S]*@pointermove="handleMapPointerMove"[\s\S]*@pointerup="handleMapPointerEnd"[\s\S]*@pointercancel="handleMapPointerEnd"/);
    assert.doesNotMatch(mapPanelSource, /tavern-map-active-button|设为当前|activate-document/);
    assert.doesNotMatch(appSource, /activateMapDocument/);
    assert.doesNotMatch(contextSource, /activateMapDocument/);
    assert.match(mapCss, /\.tavern-chat\.xb-page \.tavern-map-canvas svg \{[\s\S]*cursor: grab;[\s\S]*touch-action: none;[\s\S]*user-select: none;/);
    assert.match(mapCss, /\.tavern-chat\.xb-page \.tavern-map-canvas\.is-panning svg \{[\s\S]*cursor: grabbing;/);
    assert.doesNotMatch(mapCss, /tavern-map-active-button/);
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
    const baseCss = readRepoFile('modules/tavern/app-src/styles/settings/base.css');

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
    assert.match(baseCss, /\.base-settings-section \{[\s\S]*border-bottom: 2px solid var\(--xb-line-strong\);/);
    assert.match(baseCss, /\.base-setting-row input \{[\s\S]*text-align: center;/);
});

test('tavern settings pages let main workspace content fill the page width', () => {
    const layoutCss = readRepoFile('modules/tavern/app-src/styles/settings/layout.css');

    assert.match(layoutCss, /\.settings-layout \.xb-main \{[\s\S]*padding: 0;/);
});

test('tavern-only settings normalization stays out of agent core', () => {
    const agentCoreConfigSource = readRepoFile('modules/agent-core/config.js');
    const tavernSettingsSource = readRepoFile('modules/tavern/shared/settings.ts');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const settingsControllerSource = readRepoFile('modules/tavern/app-src/components/settings/useTavernSettingsController.ts');
    const hostAgentConfigSource = readRepoFile('modules/tavern/host/agent-config.ts');
    const hostDisplaySettingsSource = readRepoFile('modules/tavern/host/display-settings.ts');

    assert.doesNotMatch(agentCoreConfigSource, /normalizeTavernDisplaySettings|normalizeTavernUserSettings|normalizeTavernSettings/);
    assert.match(tavernSettingsSource, /export function normalizeTavernDisplaySettings/);
    assert.doesNotMatch(tavernSettingsSource, /normalizeTavernAgentConfig|normalizeTavernAgentSettings|mergeTavernSettings/);
    assert.match(appSource, /from '\.\.\/shared\/settings'/);
    assert.match(settingsControllerSource, /from '\.\.\/\.\.\/\.\.\/shared\/settings'/);
    assert.doesNotMatch(hostAgentConfigSource, /from '\.\.\/shared\/settings\.js'/);
    assert.match(hostDisplaySettingsSource, /tavern-display-settings/);
});

test('tavern base settings panel exposes a three-segment chat font size control that saves via display settings', () => {
    const panelSource = readRepoFile('modules/tavern/app-src/components/settings/TavernBaseSettingsPanel.vue');
    const settingsSource = readRepoFile('modules/tavern/shared/settings.ts');

    assert.match(settingsSource, /export type TavernChatFontSize = 'small' \| 'medium' \| 'large';/);
    assert.match(settingsSource, /export const TAVERN_CHAT_FONT_SIZES/);

    assert.match(panelSource, /<h3>字体<\/h3>/);
    assert.match(panelSource, /class="xb-workspace-controller chat-font-size-controller"/);
    assert.match(panelSource, /v-for="size in TAVERN_CHAT_FONT_SIZES"/);
    assert.match(panelSource, /:class="\{ 'is-active': displaySettings\.chatFontSize === size \}"/);
    assert.match(panelSource, /selectChatFontSize\(size\)/);

    for (const label of ['小', '中', '大']) {
        assert.ok(panelSource.includes(`'${label}'`), `panel must render chat font size label ${label}`);
    }

    assert.match(panelSource, /updateDisplaySettingsPatch\(\{ chatFontSize: size \}\)/);
    assert.doesNotMatch(panelSource, /saveCurrentPreset|requestHost\(|postToHost\(/);
});

test('tavern user host bridge stays separate from context assembly', () => {
    const contextSource = readRepoFile('modules/tavern/host/sillytavern-context.ts');
    const usersSource = readRepoFile('modules/tavern/host/users.ts');
    const tavernSource = readRepoFile('modules/tavern/tavern.ts');

    assert.doesNotMatch(contextSource, /getUserAvatars|setUserAvatar|listTavernUsers|switchTavernUser/);
    assert.match(usersSource, /getUserAvatars/);
    assert.match(usersSource, /setUserAvatar/);
    assert.match(usersSource, /typeof rawDescription === 'string'/);
    assert.match(usersSource, /export async function listTavernUsers/);
    assert.match(usersSource, /export async function switchTavernUser/);
    assert.match(contextSource, /import \{ user_avatar \} from/);
    assert.match(contextSource, /function readPersonaDescription/);
    assert.match(contextSource, /const personaId = normalizeText\(user_avatar\);/);
    assert.match(contextSource, /persona: readPersonaDescription\(personaId\) \|\| normalizeText\(ctx\.userPersona \|\| ctx\.persona\)/);
    assert.match(tavernSource, /from '\.\/host\/users\.js'/);
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
    const contextSource = readRepoFile('modules/tavern/app-src/components/tavern-app-context.ts');
    const conversationSource = readRepoFile('modules/tavern/app-src/components/chat/TavernConversationPanel.vue');
    const managerSource = readRepoFile('modules/tavern/app-src/components/chat/TavernManagerPanel.vue');
    const hostSource = readRepoFile('modules/tavern/host/sillytavern-context.ts');
    const tavernHostSource = readRepoFile('modules/tavern/tavern.ts');
    const indexSource = readRepoFile('index.js');
    const markdownSource = readRepoFile('modules/agent-core/ui/message-markdown.js');
    const sdDrawSource = readRepoFile('modules/draw/providers/sd-webui/sd-draw.js');
    const novelDrawSource = readRepoFile('modules/draw/providers/novelai/novel-draw.js');
    const comfyDrawSource = readRepoFile('modules/draw/providers/comfyui/comfy-draw.js');
    const fourthWallImageSource = readRepoFile('modules/fourth-wall/fw-image.js');
    assert.match(appSource, /useTavernMarkdownTools/);
    assert.doesNotMatch(appSource, /function renderChatMarkdown/);
    assert.doesNotMatch(appSource, /function enhanceChatMarkdown/);
    assert.match(markdownToolsSource, /function renderChatMarkdown/);
    assert.match(markdownToolsSource, /function enhanceChatMarkdown/);
    assert.match(markdownToolsSource, /function enhanceActionCheckMarkers/);
    assert.match(markdownToolsSource, /function enhanceTavernImageMarkers/);
    assert.match(markdownToolsSource, /function enhanceInlineImageTokens/);
    assert.match(markdownToolsSource, /function loadInlineImageSlot/);
    assert.match(markdownToolsSource, /xb-tavern:inline-image-generate/);
    assert.match(markdownToolsSource, /export const TAVERN_INLINE_IMAGE_PROGRESS_EVENT = 'xb-tavern:inline-image-progress';/);
    assert.match(markdownToolsSource, /TAVERN_INLINE_IMAGE_TOKEN_REGEX/);
    assert.match(markdownToolsSource, /function canEnhanceMarkdownRoot/);
    assert.match(markdownToolsSource, /function canAutoLoadInlineImageSlot/);
    assert.match(markdownToolsSource, /closest\('\[hidden\], \[aria-hidden="true"\]'\)/);
    assert.match(markdownToolsSource, /function renderLoadedTavernImageFigure/);
    assert.match(markdownToolsSource, /function renderUnavailableTavernImageFigure/);
    assert.match(markdownToolsSource, /function buildTavernImageEditPanel/);
    assert.match(markdownToolsSource, /xb-tavern:draw-image-select/);
    assert.match(markdownToolsSource, /xb-tavern:draw-image-gallery/);
    assert.match(markdownToolsSource, /xb-tavern:draw-image-save/);
    assert.match(markdownToolsSource, /xb-tavern:draw-image-delete/);
    assert.match(markdownToolsSource, /xb-tavern:draw-image-refresh/);
    assert.match(markdownToolsSource, /xb-tavern:draw-image-edit/);
    assert.match(markdownToolsSource, /function removeAdjacentImageLineBreaks/);
    assert.match(markdownToolsSource, /node instanceof HTMLBRElement/);
    assert.match(markdownToolsSource, /xb-tavern-image-failed-actions/);
    assert.match(markdownToolsSource, /payload: \{ slotId, imgId \}/);
    assert.match(markdownToolsSource, /textarea\[data-type="scene"\]/);
    assert.match(markdownToolsSource, /textarea\[data-type="char"\]/);
    assert.match(markdownToolsSource, /characterPrompts/);
    assert.match(markdownToolsSource, /xb-tavern-image-gallery-overlay/);
    assert.match(markdownToolsSource, /xb-tavern-image-nav/);
    assert.match(markdownToolsSource, /xb-tavern-image-menu/);
    assert.match(markdownToolsSource, /newerButton\.title = currentIndex === 0 \? '重新生成' : '下一版本';/);
    assert.match(markdownToolsSource, /newerButton\.disabled = false;/);
    assert.match(markdownToolsSource, /if \(currentIndex > 0\) \{[\s\S]*void selectIndex\(currentIndex - 1\);[\s\S]*return;[\s\S]*\}[\s\S]*void refreshImage\(\);/);
    assert.match(markdownToolsSource, /removeAdjacentImageLineBreaks\(figure\)/);
    assert.match(tavernHostSource, /case 'xb-tavern:draw-image-select':/);
    assert.match(tavernHostSource, /case 'xb-tavern:draw-image-gallery':/);
    assert.match(tavernHostSource, /case 'xb-tavern:draw-image-save':/);
    assert.match(tavernHostSource, /case 'xb-tavern:draw-image-delete':/);
    assert.match(tavernHostSource, /case 'xb-tavern:draw-image-refresh':/);
    assert.match(tavernHostSource, /case 'xb-tavern:draw-image-edit':/);
    assert.match(tavernHostSource, /case 'xb-tavern:inline-image-generate':/);
    assert.match(tavernHostSource, /import\('\.\.\/fourth-wall\/fw-image\.js'\)/);
    assert.match(tavernHostSource, /generateImage\(tags/);
    assert.match(tavernHostSource, /tags,\s*status: state,\s*position,\s*delay:/);
    assert.match(tavernHostSource, /buildPromptData/);
    assert.match(tavernHostSource, /getDrawPromptNegativeInput/);
    assert.match(tavernHostSource, /syncDrawSavedFromPreview/);
    assert.match(tavernHostSource, /syncDrawSavedAfterDeletion/);
    assert.match(tavernHostSource, /clearDrawSavedEntry/);
    assert.match(tavernHostSource, /storeFailedPlaceholder/);
    assert.match(tavernHostSource, /clearSlotSelection/);
    assert.match(tavernHostSource, /function getDrawPreviewStorageMessageId/);
    assert.match(tavernHostSource, /function buildDeletedDrawPlaceholder/);
    assert.match(tavernHostSource, /TAVERN_DRAW_DELETED_ERROR_MESSAGE/);
    assert.match(tavernHostSource, /preview\.source \|\| ''\)\.trim\(\) === 'tavern'/);
    assert.match(tavernHostSource, /messageId: getDrawPreviewStorageMessageId\(preview, slotId\)/);
    assert.doesNotMatch(tavernHostSource, /messageId:\s*Number\(preview\.messageId\)\s*\|\|\s*0/);
    assert.doesNotMatch(tavernHostSource, /messageId:\s*Number\(preview\.messageId\)/);
    assert.match(tavernHostSource, /characterPrompts/);
    assert.match(tavernHostSource, /deletedCurrentImage && !nextImgId/);
    assert.match(tavernHostSource, /await storeFailedPlaceholder\(buildDeletedDrawPlaceholder\(slotId, deletedPreview \|\| \{\}, current\)\);/);
    assert.match(indexSource, /buildDrawPromptData/);
    assert.match(indexSource, /characterPrompts: promptData\.characterPrompts/);
    assert.match(fourthWallImageSource, /const inflightGenerations = new Map\(\);/);
    assert.match(fourthWallImageSource, /if \(inflight\) \{[\s\S]*inflight\.progressListeners\.add\(onProgress\);[\s\S]*return inflight\.promise;/);
    assert.match(fourthWallImageSource, /inflightGenerations\.set\(hash, \{ promise, progressListeners \}\);/);
    assert.match(appSource, /TAVERN_INLINE_IMAGE_PROGRESS_EVENT/);
    assert.match(appSource, /window\.dispatchEvent\(new CustomEvent\(TAVERN_INLINE_IMAGE_PROGRESS_EVENT/);
    assert.doesNotMatch(tavernHostSource, /openGallery/);
    assert.match(sdDrawSource, /if \(source === 'tavern'\) \{/);
    assert.match(novelDrawSource, /if \(source === 'tavern'\) \{/);
    assert.match(comfyDrawSource, /if \(source === 'tavern'\) \{/);
    assert.match(sdDrawSource, /messageId: sessionId[\s\S]*`tavern:/);
    assert.match(novelDrawSource, /messageId: sessionId[\s\S]*`tavern:/);
    assert.match(comfyDrawSource, /messageId: sessionId[\s\S]*`tavern:/);
    assert.match(hostSource, /htmlRenderEnabled: isHtmlRenderEnabled\(\)/);
    assert.match(appSource, /const htmlRenderEnabled = ref\(true\);/);
    assert.match(appSource, /if \('context' in payload\) \{[\s\S]*context\.value = payload\.context as XbTavernContext \|\| \{\};[\s\S]*\}/);
    assert.match(appSource, /htmlRenderEnabled\.value = payload\.htmlRenderEnabled !== false;/);
    assert.match(appSource, /htmlRenderEnabled,\s*requestHost,/);
    assert.match(contextSource, /htmlRenderEnabled: Ref<boolean>;/);
    assert.match(conversationSource, /htmlRenderEnabled\.value \? 'html-render:on' : 'html-render:off'/);
    assert.match(conversationSource, /pending-user:\$\{pendingUserRenderState\.signature\}/);
    assert.match(conversationSource, /live-assistant:\$\{liveAssistantRenderState\.signature\}/);
    assert.match(managerSource, /function managerMarkdownSignature/);
    assert.match(managerSource, /htmlRenderEnabled\.value \? 'html-render:on' : 'html-render:off'/);
    assert.match(managerSource, /history-message:\$\{item\.key\}:\$\{managerMarkdownSignature\(item\.message\.content\)\}/);
    assert.match(managerSource, /live-message:\$\{item\.key\}:\$\{managerMarkdownSignature\(item\.message\.content\)\}/);
    assert.match(appSource, /visibleManagerMarkdownSignature[\s\S]*htmlRenderEnabled\.value \? 'html-render:on' : 'html-render:off'/);
    assert.match(markdownToolsSource, /htmlBlockMode: options\.htmlRenderEnabled\.value \? 'preview' : 'code'/);
    assert.match(markdownToolsSource, /htmlBlockMode: options\.htmlRenderEnabled\.value \? undefined : 'code'/);
    assert.match(markdownToolsSource, /window\.addEventListener\(TAVERN_INLINE_IMAGE_PROGRESS_EVENT/);
    assert.match(markdownToolsSource, /window\.removeEventListener\(TAVERN_INLINE_IMAGE_PROGRESS_EVENT/);
    assert.match(markdownToolsSource, /if \(!canEnhanceMarkdownRoot\(node\)\) \{return;\}/);
    assert.match(markdownSource, /if \(options\.htmlBlockMode === 'code'\) \{[\s\S]*return buildHtmlCodeView\(doc, code\);/);
    assert.match(tavernHostSource, /refreshRenderSettings: \(\) => void;/);
    assert.match(tavernHostSource, /function refreshRenderSettings\(\): void \{[\s\S]*htmlRenderEnabled: isHtmlRenderEnabled\(\),[\s\S]*\}/);
    assert.match(indexSource, /window\.xiaobaixTavern\?\.refreshRenderSettings\?\.\(\);/);
    assert.doesNotMatch(indexSource, /refreshContext\?\.\(\{ includeWorldbooks: false \}\)/);
});

test('tavern draw progress keeps a local cooldown ticker instead of freezing the first frame', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    assert.match(appSource, /let drawCooldownTimer: number \| null = null;/);
    assert.match(appSource, /const DRAW_COOLDOWN_TICK_MS = 100;/);
    assert.match(appSource, /function clearDrawCooldownTimer\(\) \{[\s\S]*window\.clearInterval\(drawCooldownTimer\);/);
    assert.match(appSource, /function startDrawCooldownCountdown\(messageKeyValue: string, data: Record<string, unknown> = \{\}\) \{[\s\S]*const endsAt = Date\.now\(\) \+ duration;[\s\S]*remainingMs[\s\S]*formatDrawProgress\('cooldown'/);
    assert.match(appSource, /if \(payload\.state === 'cooldown'\) \{[\s\S]*startDrawCooldownCountdown\(drawingMessageKey\.value, payload\.data \|\| \{\}\);[\s\S]*\} else \{[\s\S]*clearDrawCooldownTimer\(\);[\s\S]*drawProgressText\.value = formatDrawProgress/);
    assert.match(appSource, /function showDrawMessageStatus\([\s\S]*clearDrawCooldownTimer\(\);[\s\S]*drawStatusMessageKey\.value = messageKey\(message\);/);
    assert.match(appSource, /onUnmounted\(\(\) => \{[\s\S]*clearDrawCooldownTimer\(\);/);
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
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const chatPageSource = readRepoFile('modules/tavern/app-src/components/chat/TavernChatPage.vue');
    const conversationPanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernConversationPanel.vue');
    const managerPanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernManagerPanel.vue');
    const workspacePanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernWorkspacePanel.vue');
    const contextSource = readRepoFile('modules/tavern/app-src/components/tavern-app-context.ts');
    const cssSource = readRepoFile('modules/tavern/app-src/styles/chat/messages.css');
    const composeCss = readRepoFile('modules/tavern/app-src/styles/chat/compose.css');
    const memoryCss = readRepoFile('modules/tavern/app-src/styles/chat/memory-editor.css');
    const managerCss = readRepoFile('modules/tavern/app-src/styles/chat/manager.css');
    const sidebarCss = readRepoFile('modules/tavern/app-src/styles/chat/sidebar.css');
    assert.match(conversationPanelSource, /hasRenderableLiveAssistantContent/);
    assert.match(conversationPanelSource, /hasRenderableLiveAssistantMarkdown/);
    assert.match(conversationPanelSource, /runtimeActionCheckEvents/);
    assert.match(contextSource, /runtimeUserMessageVisible: Ref<boolean>/);
    assert.match(appSource, /const runtimeUserMessageVisible = ref\(false\)/);
    assert.match(appSource, /function clearRuntimeAssistantLiveState\(\) \{[\s\S]*runtimeText\.value = '';[\s\S]*runtimeThoughts\.value = \[\];[\s\S]*runtimeActionCheckEvents\.value = \[\];[\s\S]*runtimeUserMessageVisible\.value = false;/);
    assert.match(appSource, /runtimeUserMessageVisible\.value = false;[\s\S]*runtimeProvider\.value = ''/);
    assert.match(appSource, /sessionMessages\.value = existingIndex >= 0[\s\S]*runtimeUserMessageVisible\.value = true;/);
    assert.match(appSource, /onUserMessageSaved: async \(sessionId, message\) => \{[\s\S]*sessionMessages\.value = existingIndex >= 0[\s\S]*runtimePendingUserMessage\.value = '';[\s\S]*await setSelectedTavernSessionId\(sessionId\)/);
    assert.match(appSource, /onAssistantMessageSaved: async \(sessionId, message\) => \{[\s\S]*sessionMessages\.value = existingIndex >= 0[\s\S]*clearRuntimeAssistantLiveState\(\);/);
    assert.match(conversationPanelSource, /const liveAssistantCanRender = computed\(\(\) => isRunning\.value && runtimeUserMessageVisible\.value\)/);
    assert.match(conversationPanelSource, /v-if="liveAssistantCanRender && liveAssistantVisible"[\s\S]*data-chat-anchor-key="streaming:content"/);
    assert.match(conversationPanelSource, /v-if="liveAssistantCanRender && !liveAssistantVisible"[\s\S]*data-chat-anchor-key="streaming:empty"/);
    assert.doesNotMatch(conversationPanelSource, /v-if="isRunning && (?:!?)liveAssistantVisible"/);
    assert.match(conversationPanelSource, /useTavernMediaQuery\('\(max-width: 760px\)'\)/);
    assert.match(conversationPanelSource, /@click="handleChatMainClick"/);
    assert.match(conversationPanelSource, /'is-action-tray-open': isMessageActionTrayOpen\(message\)/);
    assert.match(conversationPanelSource, /class="bubble-identity"[\s\S]*class="bubble-nameplate"[\s\S]*class="message-floor-label"[\s\S]*class="bubble-time-tag"[\s\S]*v-if="!isEditingMessage\(message\)"[\s\S]*class="message-actions"/);
    assert.match(conversationPanelSource, /class="message-actions"[\s\S]*isDrawingMessage\(message\) \? '■' : '🎨'[\s\S]*<svg[\s\S]*viewBox="0 0 24 24"/);
    assert.doesNotMatch(conversationPanelSource, /actionFeedback\(message, 'copy'\)|copyMessage\(message\)/);
    assert.match(conversationPanelSource, /<\/div>\s*<div\s+v-for="\(\s*event, eventIndex\s*\) in \(message\.role === 'user'/);
    assert.doesNotMatch(conversationPanelSource, /inline-runtime-event/);
    assert.doesNotMatch(cssSource, /\.chat-bubble \.chat-runtime-event/);
    assert.match(cssSource, /\.bubble-identity \{[\s\S]*display: grid;[\s\S]*justify-items: start;/);
    assert.match(cssSource, /\.chat-bubble>\.message-actions \{[\s\S]*position: absolute;[\s\S]*top: -1px;[\s\S]*right: -1px;[\s\S]*border-radius: 0 10px 0 8px;[\s\S]*opacity: 0;/);
    assert.match(cssSource, /\.bubble-meta-line \{[\s\S]*display: inline-flex;[\s\S]*gap: 6px;/);
    assert.match(cssSource, /\.message-floor-label \{[\s\S]*padding: 3px 8px;/);
    assert.match(cssSource, /\.chat-bubble>\.message-actions button \{[\s\S]*width: 30px;[\s\S]*min-width: 30px;[\s\S]*height: 30px;[\s\S]*min-height: 30px;[\s\S]*border: 0;[\s\S]*padding: 0;/);
    assert.match(cssSource, /@media \(max-width: 760px\) \{[\s\S]*\.chat-bubble>\.message-actions \{[\s\S]*opacity: 0;[\s\S]*pointer-events: none;[\s\S]*\.chat-bubble\.is-action-tray-open>\.message-actions[\s\S]*opacity: 1;[\s\S]*pointer-events: auto;/);
    assert.doesNotMatch(cssSource, /\.message-actions \{[\s\S]*border-top: 1px solid rgba\(120, 112, 98, 0\.16\);/);
    assert.doesNotMatch(cssSource, /\.message-actions \{[\s\S]*border-bottom: 1px solid rgba\(120, 112, 98, 0\.14\);/);
    assert.match(cssSource, /\.tavern-chat\.xb-page \.chat-scroll \{[\s\S]*scrollbar-width: none;[\s\S]*-ms-overflow-style: none;/);
    assert.match(cssSource, /\.tavern-chat\.xb-page \.chat-scroll::-webkit-scrollbar \{[\s\S]*width: 0;[\s\S]*height: 0;/);
    assert.match(conversationPanelSource, /v-model="currentUserMessage"[\s\S]*rows="1"/);
    assert.match(contextSource, /createNewChatSession: TavernCommand<\[\], Promise<void>>/);
    assert.match(appSource, /async function createNewChatSession\(\) \{[\s\S]*resolveRuntimeContextForSession\(selectedSessionId\.value\)[\s\S]*resetSessionPreviewState\(\);[\s\S]*await createSessionAndOpenChat\(\{ contextSnapshot: snapshotContext \}\);/);
    assert.match(chatPageSource, /function openMobileSessionsPanel\(\) \{[\s\S]*chatSidePanel\.value = 'sessions';[\s\S]*mobileChatPanel\.value = 'directory';/);
    assert.match(chatPageSource, /class="chat-mobile-context-row"[\s\S]*title="地图"[\s\S]*title="记忆"[\s\S]*title="契约"[\s\S]*title="请求日志"/);
    assert.doesNotMatch(chatPageSource, /class="chat-mobile-context-row"[\s\S]*>\s*会话\s*</);
    assert.match(chatPageSource, /:class="\{ 'is-active': mobileChatPanel === 'workspace' && chatWorkspacePanel === 'state' \}"/);
    assert.match(chatPageSource, /:class="\{ 'is-active': mobileChatPanel === 'workspace' && chatWorkspacePanel === 'memory' \}"/);
    assert.match(chatPageSource, /<TavernConversationPanel[\s\S]*@open-session-archive="openMobileSessionsPanel"/);
    assert.match(conversationPanelSource, /createNewChatSession,[\s\S]*const composeMenuOpen = ref\(false\)/);
    assert.match(conversationPanelSource, /defineEmits<\{[\s\S]*\(event: 'open-session-archive'\): void;/);
    assert.match(conversationPanelSource, /class="chat-compose-dock"[\s\S]*class="chat-compose-shell"[\s\S]*class="compose-menu-shell"[\s\S]*<form\s+class="chat-compose"/);
    assert.doesNotMatch(conversationPanelSource, /<form\s+class="chat-compose"[\s\S]*class="compose-menu-shell"/);
    assert.match(conversationPanelSource, /class="compose-menu-button"[\s\S]*aria-label="聊天操作"[\s\S]*aria-controls="xb-tavern-compose-menu"[\s\S]*@click\.stop="toggleComposeMenu"/);
    assert.match(conversationPanelSource, /class="compose-menu-button"[\s\S]*<svg[\s\S]*viewBox="0 0 24 24"[\s\S]*<path d="M4 6h16"/);
    assert.match(conversationPanelSource, /id="xb-tavern-compose-menu"[\s\S]*role="menu"[\s\S]*class="compose-menu-item"[\s\S]*新建会话[\s\S]*class="compose-menu-item"[\s\S]*会话档案[\s\S]*class="compose-menu-item"[\s\S]*玩家便签/);
    assert.match(conversationPanelSource, /defineEmits<\{[\s\S]*\(event: 'open-author-note'\): void;/);
    assert.match(conversationPanelSource, /function openAuthorNoteFromComposeMenu\(\) \{[\s\S]*closeComposeMenu\(\);[\s\S]*emit\('open-author-note'\);[\s\S]*\}/);
    assert.doesNotMatch(conversationPanelSource, /composeMenuView|isMobileAuthorNoteViewport|compose-author-note-panel|authorNoteDraft/);
    assert.match(chatPageSource, /<TavernConversationPanel[\s\S]*@open-author-note="openAuthorNoteModal"/);
    assert.match(chatPageSource, /function openAuthorNoteModal\(\) \{[\s\S]*authorNoteDraft\.value = normalizeXbTavernAuthorNote\(currentAuthorNote\.value\);[\s\S]*authorNoteModalOpen\.value = true;/);
    assert.match(chatPageSource, /v-if="authorNoteModalOpen"[\s\S]*class="compose-author-note-overlay"[\s\S]*role="dialog"[\s\S]*aria-modal="true"[\s\S]*class="compose-author-note-dialog compose-author-note-panel"/);
    assert.match(chatPageSource, /class="compose-author-note-dialog compose-author-note-panel"[\s\S]*玩家便签[\s\S]*只对当前会话生效。[\s\S]*class="compose-author-note-body"/);
    assert.match(chatPageSource, /便签内容/);
    assert.match(chatPageSource, /主提示词后[\s\S]*主提示词前[\s\S]*聊天内 @ Depth/);
    assert.match(chatPageSource, /Depth[\s\S]*插入频率[\s\S]*Role/);
    assert.match(chatPageSource, /System[\s\S]*User[\s\S]*Assistant/);
    assert.match(chatPageSource, /参与世界书扫描/);
    assert.match(chatPageSource, /v-model="authorNoteDraft\.prompt"/);
    assert.match(chatPageSource, /v-model\.number="authorNoteDraft\.depth"/);
    assert.match(chatPageSource, /v-model\.number="authorNoteDraft\.interval"/);
    assert.doesNotMatch(chatPageSource, /@input="updateAuthorNote(?:Prompt|Depth|Interval)"/);
    assert.match(contextSource, /currentAuthorNote: TavernReadable<XbTavernAuthorNote>/);
    assert.match(contextSource, /saveCurrentAuthorNote: TavernCommand<\[note: XbTavernAuthorNote\], Promise<void>>/);
    assert.match(appSource, /const currentAuthorNote = computed<XbTavernAuthorNote>\(\(\) => normalizeXbTavernAuthorNote\(selectedSession\.value\?\.contextSnapshot\?\.authorNote\)\)/);
    assert.match(appSource, /const contextBase = selectedSessionId\.value === sessionId[\s\S]*\? \(context\.value \|\| session\.contextSnapshot \|\| \{\}\)/);
    assert.match(appSource, /async function saveCurrentAuthorNote\(note: XbTavernAuthorNote\)[\s\S]*authorNote: normalized/);
    assert.match(appSource, /async function saveCurrentAuthorNote\(note: XbTavernAuthorNote\)[\s\S]*contextSnapshot: nextContext/);
    assert.match(appSource, /if \(selectedSessionId\.value !== sessionId\) \{return;\}[\s\S]*context\.value = nextContext/);
    assert.match(conversationPanelSource, /function openSessionArchiveFromComposeMenu\(\) \{[\s\S]*emit\('open-session-archive'\);/);
    assert.match(managerPanelSource, /v-model="managerInputDraft"[\s\S]*rows="1"/);
    assert.match(workspacePanelSource, /<button[\s\S]*chatWorkspacePanel === 'state'[\s\S]*>\s*地图\s*<\/button>/);
    assert.match(workspacePanelSource, /class="tavern-map-info"/);
    assert.doesNotMatch(workspacePanelSource, /tavern-current-state|stateMemoryFile|renderChatMarkdown\(currentState/);
    assert.match(composeCss, /--xb-compose-safe-space: 44px;/);
    assert.match(composeCss, /--xb-compose-safe-space: 40px;/);
    assert.match(composeCss, /\.tavern-chat\.xb-page \.chat-compose-shell \{[\s\S]*grid-template-columns: 48px minmax\(0, 1fr\);[\s\S]*border: 1px solid var\(--xb-rule\);[\s\S]*border-radius: 14px;[\s\S]*background: var\(--xb-chat-pop-bg\);/);
    assert.match(composeCss, /\.tavern-chat\.xb-page \.chat-compose \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) 36px;/);
    assert.match(composeCss, /\.compose-menu-button \{[\s\S]*min-height: 100%;[\s\S]*border: 0;[\s\S]*border-radius: 14px 0 0 14px;[\s\S]*background: transparent;/);
    assert.doesNotMatch(composeCss, /\.compose-menu-button \{[^}]*border-right:/);
    assert.match(composeCss, /\.compose-menu-button svg \{[\s\S]*width: 22px;[\s\S]*height: 22px;[\s\S]*stroke-width: 2;/);
    assert.match(composeCss, /\.compose-menu-popover \{[\s\S]*bottom: calc\(100% \+ 10px\);[\s\S]*min-width: 142px;/);
    assert.match(composeCss, /@media \(max-width: 980px\) \{[\s\S]*\.compose-menu-popover \{[\s\S]*position: absolute;[\s\S]*right: auto;[\s\S]*bottom: calc\(100% \+ 8px\);[\s\S]*left: 0;[\s\S]*width: min\(280px, calc\(100vw - 20px\)\);[\s\S]*max-height: calc\(100dvh - 82px - env\(safe-area-inset-top, 0px\) - env\(safe-area-inset-bottom, 0px\)\);/);
    assert.doesNotMatch(composeCss, /\.compose-menu-popover\.is-author-note/);
    assert.match(composeCss, /\.compose-author-note-overlay \{[\s\S]*position: absolute;[\s\S]*inset: 0;[\s\S]*z-index: 98;[\s\S]*place-items: center;/);
    assert.match(composeCss, /\.compose-author-note-dialog \{[\s\S]*width: min\(420px, 100%\);[\s\S]*max-height: min\(86vh, 680px\);[\s\S]*overflow: hidden;/);
    assert.match(composeCss, /\.compose-author-note-panel \{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\) auto;[\s\S]*min-height: 0;/);
    assert.match(composeCss, /\.compose-author-note-body \{[\s\S]*display: grid;[\s\S]*min-height: 0;/);
    assert.match(composeCss, /@media \(max-width: 980px\) \{[\s\S]*\.compose-author-note-field textarea \{[\s\S]*resize: none;[\s\S]*max-height: min\(190px, 34vh\);/);
    assert.match(composeCss, /@media \(max-width: 980px\) \{[\s\S]*\.compose-author-note-overlay \{[\s\S]*inset: 0;[\s\S]*padding: 0;/);
    assert.match(composeCss, /@media \(max-width: 980px\) \{[\s\S]*\.compose-author-note-dialog \{[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*max-height: none;[\s\S]*border-radius: 0;[\s\S]*env\(safe-area-inset-top, 0px\)[\s\S]*env\(safe-area-inset-bottom, 0px\)/);
    assert.match(composeCss, /@media \(max-width: 980px\) \{[\s\S]*\.compose-author-note-dialog \.compose-author-note-body \{[\s\S]*min-height: 0;[\s\S]*overflow: auto;[\s\S]*overscroll-behavior: contain;/);
    assert.doesNotMatch(composeCss, /left: max\(-8px, calc\(48px - 100vw\)\)/);
    assert.match(composeCss, /\.compose-author-note-segments \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    assert.match(composeCss, /\.compose-author-note-actions \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/);
    assert.match(composeCss, /\.chat-compose textarea \{[\s\S]*min-height: 32px;[\s\S]*max-height: 76px;[\s\S]*padding: 5px 6px 5px 12px;/);
    assert.match(composeCss, /\.chat-compose>button \{[\s\S]*justify-self: center;[\s\S]*width: 32px;[\s\S]*min-width: 32px;[\s\S]*height: 32px;[\s\S]*border: 0;[\s\S]*border-radius: 999px;/);
    assert.doesNotMatch(composeCss, /\.chat-compose>button \{[^}]*border-left:/);
    assert.match(sidebarCss, /@media \(max-width: 760px\) \{[\s\S]*\.tavern-chat\.xb-page \.chat-side \{[\s\S]*top: calc\(86px \+ env\(safe-area-inset-top, 0px\)\);[\s\S]*bottom: 0;[\s\S]*height: auto;[\s\S]*border-radius: 0;/);
    assert.doesNotMatch(sidebarCss, /height: min\(72vh, 620px\);/);
    assert.match(memoryCss, /@media \(max-width: 760px\) \{[\s\S]*\.tavern-chat\.xb-page \.tavern-workspace-tabs \{[\s\S]*display: none;/);
    assert.match(managerCss, /\.tavern-chat\.xb-page \.manager-compose button\.primary-action \{[\s\S]*min-height: 32px;/);
    assert.doesNotMatch(managerCss, /\.tavern-chat\.xb-page \.manager-compose button\.primary-action \{[\s\S]*min-height: 58px;/);
    assert.doesNotMatch(cssSource, /\.chat-bubble\.from-assistant\s*\{[^}]*border-left:/);
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
    const settingsControllerSource = readRepoFile('modules/tavern/app-src/components/settings/useTavernSettingsController.ts');
    const mobileCss = readRepoFile('modules/tavern/app-src/styles/settings/mobile.css');

    assert.match(helperSource, /export function useTavernEphemeralDisclosureScope/);
    assert.match(worldbookSource, /useTavernEphemeralDisclosureScope/);
    assert.match(worldbookSource, /aria-label="选择世界书"/);
    assert.doesNotMatch(worldbookSource, /筛选世界书|worldbookSearchText|worldbook-search-field/);
    assert.match(worldbookSource, />条目名</);
    assert.match(worldbookSource, />状态</);
    assert.match(worldbookSource, />注入位置</);
    assert.match(worldbookSource, />触发概率</);
    assert.match(worldbookSource, />可选过滤</);
    assert.match(worldbookSource, /worldbookEntryStateValue/);
    assert.match(worldbookSource, /worldbookPositionValue/);
    assert.match(worldbookSource, /depth: nextPosition === 4 \? worldbookEntryDraft\.value\?\.depth \?\? 4 : null/);
    assert.match(worldbookSource, /function listFromCommaText/);
    assert.match(worldbookSource, /key: listFromCommaText/);
    assert.match(worldbookSource, /keysecondary: listFromCommaText/);
    assert.match(worldbookSource, /triggers', listFromCommaText/);
    assert.doesNotMatch(worldbookSource, /key: listFromLines/);
    assert.doesNotMatch(worldbookSource, /keysecondary: listFromLines/);
    assert.doesNotMatch(worldbookSource, /triggers', listFromLines/);
    assert.doesNotMatch(worldbookSource, />次级关键词</);
    assert.doesNotMatch(worldbookSource, /worldbookEntryDraft\.(?:name|title)|updateWorldbookEntryDraftPatch\(\{ (?:name|title):|>名称<\/span>|>标题<\/span>/);
    assert.doesNotMatch(worldbookSource, />检索世界书</);
    const worldbookSummaries = [...worldbookSource.matchAll(/<summary>[\s\S]*?<\/summary>/g)].map((match) => match[0]);
    assert.ok(worldbookSummaries.length > 0);
    for (const summary of worldbookSummaries) {
        assert.doesNotMatch(summary, /entry\.(?:keys|secondaryKeys)/);
    }
    assert.match(worldbookSource, /v-if="worldbookDisclosure\.isOpen[\s\S]*class="worldbook-entry-body"/);
    assert.match(worldbookSource, /worldbookDisclosure\.isOpen\(worldbookAdvancedDisclosureId/);
    assert.match(worldbookCss, /\.worldbook-entry-body \{[\s\S]*max-height: 560px;[\s\S]*overflow: auto;/);
    assert.match(worldbookCss, /\.worldbook-entry-content \{[\s\S]*white-space: pre-wrap;/);
    assert.doesNotMatch(worldbookHost, /truncatePreview/);
    assert.match(worldbookHost, /\['extensions\.position', normalizeWorldbookPosition\(entry\.position\)\]/);
    assert.match(worldbookHost, /function normalizeWorldbookDepth\(position: unknown, depth: unknown\): number \| null/);
    assert.match(worldbookHost, /return normalizeWorldbookPosition\(position\) === 4 \? normalizeNullableNumber\(depth\) \?\? 4 : null;/);
    assert.match(worldbookHost, /\['extensions\.depth', normalizeWorldbookDepth\(entry\.position, entry\.depth\)\]/);
    assert.match(settingsControllerSource, /depth: Number\(record\.position\) === 4 \? normalizeNullableNumber\(record\.depth\) \?\? 4 : null/);
    assert.match(worldbookHost, /\['extensions\.vectorized', entry\.vectorized === true\]/);
    assert.match(worldbookHost, /\['selectiveLogic', Math\.floor\(normalizeFiniteNumber\(entry\.selectiveLogic, 0\)\)\]/);
    assert.match(mobileCss, /\.settings-layout\.is-worldbooks-workspace \.worldbook-entry-preview summary \{[\s\S]*min-height: 42px;/);
});

test('tavern character archive separates new chat from existing session selection', () => {
    const characterSource = readRepoFile('modules/tavern/app-src/components/TavernCharacterSelectPage.vue');
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const previewCss = readRepoFile('modules/tavern/app-src/styles/characters/preview.css');
    const sessionDbSource = readRepoFile('modules/tavern/shared/session-db.ts');

    assert.match(appSource, /const selectedCharacterSessions = computed<TavernSessionRecord\[\]>/);
    assert.match(appSource, /:selected-character-sessions="selectedCharacterSessions"/);
    assert.match(appSource, /:session-floor-label="sessionFloorLabel"/);
    assert.match(appSource, /function sessionFloorLabel\(session\?: TavernSessionRecord \| null\)[\s\S]*return '统计中'/);
    assert.match(appSource, /async function refreshSessionMessageCountsForSessions\(targetSessions: TavernSessionRecord\[\] = \[\]\)/);
    assert.match(appSource, /watch\(\(\) => selectedCharacterSessions\.value\.map\(\(session\) => session\.id\)\.join\('\|'\)[\s\S]*refreshSessionMessageCountsForSessions\(selectedCharacterSessions\.value\)/);
    assert.match(sessionDbSource, /export async function countTavernMessages[\s\S]*\.where\('sessionId'\)\.equals\(id\)\.count\(\)/);
    assert.doesNotMatch(sessionDbSource, /countTavernMessages[\s\S]*toArray\(\)\)\.length/);
    assert.match(appSource, /@open-session="selectSession"/);
    assert.match(characterSource, /selectedCharacterSessions: TavernCharacterSessionOption\[\]/);
    assert.match(characterSource, /sessionFloorLabel: \(session: TavernCharacterSessionOption\) => string;/);
    assert.match(characterSource, /function sessionArchiveMeta\(session: TavernCharacterSessionOption\)[\s\S]*props\.sessionFloorLabel\(session\)/);
    assert.doesNotMatch(characterSource, /sessionArchiveMeta[\s\S]*chatPresetName|sessionArchiveMeta[\s\S]*presetName/);
    assert.match(characterSource, /class="dossier-summary"[\s\S]*selectedCharacter\.description[\s\S]*selectedCharacter\.personality[\s\S]*selectedCharacter\.scenario/);
    assert.doesNotMatch(characterSource, /class="data-section-title"/);
    assert.doesNotMatch(characterSource, /class="character-data-list"/);
    assert.match(characterSource, /class="os-system-act-btn character-definition-button"[\s\S]*aria-label="角色卡详情"[\s\S]*class="os-system-act-btn character-worldbook-button"/);
    assert.match(characterSource, /const characterDefinitionFields = computed[\s\S]*label: '性格摘要'[\s\S]*personality/);
    assert.match(characterSource, /const characterDefinitionFields = computed[\s\S]*label: '情景'[\s\S]*scenario/);
    assert.match(characterSource, /const characterDefinitionFields = computed[\s\S]*label: '角色备注'[\s\S]*characterDepthPrompt/);
    assert.match(characterSource, /const characterDefinitionFields = computed[\s\S]*label: '制作者备注'[\s\S]*creatorNotes/);
    assert.match(characterSource, /const characterDefinitionFields = computed[\s\S]*label: '示例对话'[\s\S]*mesExample/);
    assert.match(characterSource, /class="character-definition-overlay"[\s\S]*aria-label="角色卡详情"/);
    assert.match(characterSource, /v-for="field in characterDefinitionFields"/);
    assert.match(characterSource, />\s*会话档案\s*</);
    assert.match(characterSource, /新建中\.\.\.' : '新建聊天/);
    assert.match(characterSource, /class="character-session-archive-overlay"/);
    assert.match(characterSource, /class="session-archive-close"[\s\S]*aria-label="关闭会话档案"[\s\S]*\/>/);
    assert.doesNotMatch(characterSource, /class="session-archive-close"[\s\S]*×[\s\S]*<\/button>/);
    assert.match(appSource, /class="worldbook-picker-close"[\s\S]*aria-label="关闭"[\s\S]*\/>/);
    assert.match(characterSource, /v-for="session in selectedCharacterSessions"/);
    assert.match(characterSource, /@click="openSession\(session\.id\)"/);
    assert.match(characterSource, /@click="\$emit\('enter-selected'\)"/);
    assert.match(characterSource, /<main\s+v-if="!selectedCharacter"\s+class="character-preview-panel dossier-empty"/);
    assert.doesNotMatch(characterSource, /@dblclick="\$emit\('enter-character'/);
    assert.match(previewCss, /\.dossier-title-actions \{[\s\S]*display: flex;[\s\S]*gap: 8px;/);
    assert.match(previewCss, /\.character-definition-button,\n\.character-worldbook-button/);
    assert.match(previewCss, /\.session-archive-button/);
    assert.match(previewCss, /\.dossier-title-actions \.session-archive-button,\n\.dossier-title-actions \.enter-chat-button \{[\s\S]*padding-left: 16px;[\s\S]*padding-right: 16px;/);
    assert.match(previewCss, /\.character-definition-dialog \{[\s\S]*width: min\(560px, 100%\);/);
    assert.match(previewCss, /\.character-definition-section dd \{[\s\S]*white-space: pre-wrap;/);
    assert.match(previewCss, /\.character-session-archive \{[\s\S]*width: min\(520px, 100%\);/);
    assert.match(previewCss, /grid-template-columns: 42px 42px minmax\(0, 1fr\) minmax\(0, 1fr\);/);
});

test('tavern deleting a selected chat never falls through to another character session', () => {
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');

    assert.match(appSource, /const deletedCharacterId = String\(session\?\.characterId \|\| ''\)\.trim\(\);/);
    assert.match(appSource, /const nextSameCharacterSession = deletedCharacterId[\s\S]*\.filter\(\(item\) => item\.id !== id && String\(item\.characterId \|\| ''\)\.trim\(\) === deletedCharacterId\)/);
    assert.match(appSource, /if \(nextSameCharacterSession\?\.id\) \{[\s\S]*await setSelectedTavernSessionId\(nextSameCharacterSession\.id\);[\s\S]*activeView\.value = 'chat';/);
    assert.match(appSource, /selectedSessionId\.value = '';[\s\S]*await setSelectedTavernSessionId\(''\);[\s\S]*selectedCharacterPreviewId\.value = deletedCharacterId;[\s\S]*activeView\.value = deletedCharacterId \? 'characters' : 'home';/);
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
    assert.match(characterSource, /:open="advancedDefinitionDisclosure\.isOpen[\s\S]*class="data-section greeting-picker"/);
    assert.match(characterSource, /v-if="hasMultipleGreetings && advancedDefinitionDisclosure\.isOpen/);
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
    assert.match(chatPresetSource, /class="prompt-editor-close"[\s\S]*v-if="isMobileSettingsViewport"|v-if="isMobileSettingsViewport"[\s\S]*class="prompt-editor-close"/);
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

test('tavern native regex writes refresh SillyTavern regex UI and cache', () => {
    const hostSource = readRepoFile('modules/tavern/host/regex.ts');
    assert.match(hostSource, /RegexProvider/);
    assert.match(hostSource, /function syncNativeRegexUiAfterWrite/);
    assert.match(hostSource, /RegexProvider\.instance\.clear\(\)/);
    assert.match(hostSource, /saveSettingsDebounced\?\.\(\)/);
    assert.match(hostSource, /event_types\?\.CHAT_CHANGED/);
    assert.match(hostSource, /await eventSource\.emit\(chatChangedEvent, chatId\)/);
    assert.doesNotMatch(hostSource, /reloadCurrentChat/);
    assert.match(hostSource, /export async function saveTavernRegexScript[\s\S]*await syncNativeRegexUiAfterWrite\(\)/);
    assert.match(hostSource, /export async function deleteTavernRegexScript[\s\S]*await syncNativeRegexUiAfterWrite\(\)/);
});
