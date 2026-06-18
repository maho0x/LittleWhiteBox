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
    assert.doesNotMatch(appSource, /action === 'opened'/);
    assert.doesNotMatch(appSource, /postToHost\('xb-tavern:close'\);[\s\S]*return;[\s\S]*action === 'imported'/);
    assert.match(worldbookSource, /class="worldbook-section worldbook-global-enable"[\s\S]*<h3>已启用的全局世界书<\/h3>[\s\S]*class="worldbook-section worldbook-main-section"[\s\S]*<h3>世界书操作<\/h3>[\s\S]*class="preset-command-bar worldbook-command-bar"[\s\S]*class="preset-source-select worldbook-source-select"/);
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

test('tavern chat exposes local settings modals without leaving the session', () => {
    const cornerSource = readRepoFile('modules/tavern/app-src/components/TavernCornerActions.vue');
    const chatPageSource = readRepoFile('modules/tavern/app-src/components/chat/TavernChatPage.vue');
    const chatLayoutCss = readRepoFile('modules/tavern/app-src/styles/chat/layout.css');
    const chatQuickSettingsCss = readRepoFile('modules/tavern/app-src/styles/chat/quick-settings.css');
    const settingsControllerSource = readRepoFile('modules/tavern/app-src/components/settings/useTavernSettingsController.ts');
    const stylesSource = readRepoFile('modules/tavern/app-src/styles.css');

    assert.match(cornerSource, /includeApi\?: boolean/);
    assert.match(cornerSource, /includeChatPreset\?: boolean/);
    assert.match(cornerSource, /includeWorldbooks\?: boolean/);
    assert.match(cornerSource, /homeLast\?: boolean/);
    assert.match(cornerSource, /v-if="includeChatPreset"[\s\S]*class="home-icon-button page-chat-preset-button"[\s\S]*v-if="includeApi"[\s\S]*class="home-icon-button page-api-button"[\s\S]*v-if="includeWorldbooks"[\s\S]*class="home-icon-button page-worldbooks-button"[\s\S]*class="home-icon-button home-theme-button"[\s\S]*v-if="includeHome && homeLast"[\s\S]*class="home-icon-button page-home-button"/);
    assert.match(chatPageSource, /<TavernCornerActions[\s\S]*include-api[\s\S]*include-chat-preset[\s\S]*include-home[\s\S]*include-worldbooks[\s\S]*home-last[\s\S]*@api="openQuickSettingsModal\('api'\)"[\s\S]*@chat-preset="openQuickSettingsModal\('chatPreset'\)"[\s\S]*@worldbooks="openQuickSettingsModal\('worldbooks'\)"/);
    assert.match(chatPageSource, /class="chat-mobile-action-group"[\s\S]*title="聊天预设"[\s\S]*title="API 配置"[\s\S]*title="世界书"[\s\S]*title="首页"/);
    assert.match(chatPageSource, /const quickSettingsOpen = ref<'api' \| 'chatPreset' \| 'worldbooks' \| null>\(null\)/);
    assert.match(chatPageSource, /function openQuickSettingsModal\(workspace: 'api' \| 'chatPreset' \| 'worldbooks'\)[\s\S]*activeSettingsWorkspace\.value = workspace;[\s\S]*syncChatPresetFromHost\(\)[\s\S]*syncWorldbooksFromHost\(\{ keepSelection: true \}\)[\s\S]*syncGlobalWorldbooksFromHost\(\)/);
    assert.match(chatPageSource, /class="chat-quick-settings-overlay"[\s\S]*class="tavern-api-settings chat-quick-api-root"[\s\S]*class="settings-layout chat-quick-settings-layout"[\s\S]*<TavernChatPresetSettingsPanel \/>[\s\S]*<TavernWorldbooksSettingsPanel \/>/);
    assert.doesNotMatch(chatPageSource, /class="chat-quick-settings-overlay"[\s\S]*@click\.self="closeQuickSettingsModal"/);
    assert.match(chatPageSource, /class="chat-quick-settings-close"[\s\S]*@click="closeQuickSettingsModal"/);
    assert.match(chatPageSource, /function setChatApiSettingsRootRef[\s\S]*apiSettingsRootRef\.value = element instanceof HTMLElement \? element : null;/);
    assert.match(settingsControllerSource, /\(\) => apiSettingsRootRef\.value,[\s\S]*if \(apiSettingsRootRef\.value\) \{[\s\S]*nextTick\(renderApiSettingsPanel\)/);
    assert.match(chatLayoutCss, /\.chat-quick-settings-overlay \{[\s\S]*position: absolute;[\s\S]*backdrop-filter: blur\(16px\);/);
    assert.match(chatLayoutCss, /\.chat-quick-settings-dialog \{[\s\S]*max-height: min\(88vh, 900px\);/);
    assert.match(chatLayoutCss, /\.chat-quick-settings-dialog \{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\);/);
    assert.match(chatLayoutCss, /--xb-chat-scroll-padding: 34px 0 38px;/);
    assert.match(chatLayoutCss, /--xb-chat-scroll-padding: 22px 0 28px;/);
    assert.match(chatLayoutCss, /--xb-chat-scroll-padding: 18px 0 22px;/);
    assert.doesNotMatch(chatLayoutCss, /--xb-chat-scroll-padding:\s*\d+px\s+(?:8|10|12)px/);
    assert.match(stylesSource, /@import '\.\/styles\/settings\.css';\s*@import '\.\/styles\/chat\/quick-settings\.css';/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout \{[\s\S]*display: block;[\s\S]*grid-template-columns: none;[\s\S]*overflow: visible;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout \{[\s\S]*--xb-settings-control-bg: var\(--xb-bg-card\);[\s\S]*--xb-settings-sheet-bg: var\(--xb-chat-pop-bg\);/);
    assert.match(chatQuickSettingsCss, /\.xb-os-shell\.theme-light \.settings-layout\.chat-quick-settings-layout \{[\s\S]*--xb-settings-control-bg: var\(--xb-paper-plain\);[\s\S]*--xb-settings-control-focus-bg: #ffffff;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout \.xb-main \{[\s\S]*background: transparent;[\s\S]*padding: 0;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.prompt-edit-button \{[\s\S]*display: grid;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.preset-preview-panel \{[\s\S]*z-index: 1;[\s\S]*background: var\(--xb-settings-sheet-bg\);/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.prompt-detail-form \{[\s\S]*background: var\(--xb-settings-sheet-bg\);/);
    assert.match(chatQuickSettingsCss, /@media \(max-width: 760px\) \{[\s\S]*\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.preset-preview-panel\.prompt-editor-panel \{[\s\S]*position: fixed;[\s\S]*z-index: 180;[\s\S]*inset:[\s\S]*max\(10px, env\(safe-area-inset-top, 0px\)\)[\s\S]*overflow: hidden;[\s\S]*border-radius: 14px;/);
    assert.match(chatQuickSettingsCss, /@media \(max-width: 760px\) \{[\s\S]*\.settings-layout\.chat-quick-settings-layout\.is-chatPreset-workspace \.prompt-detail-form \{[\s\S]*flex: 1 1 auto;[\s\S]*overflow: auto;/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-worldbooks-workspace \.worldbook-entry-editor \{[\s\S]*z-index: 1;[\s\S]*background: var\(--xb-settings-sheet-bg\);/);
    assert.match(chatQuickSettingsCss, /\.settings-layout\.chat-quick-settings-layout\.is-worldbooks-workspace \.worldbook-entry-editor input\[type="text"\],[\s\S]*background-color: var\(--xb-settings-control-bg\);/);
    assert.doesNotMatch(settingsControllerSource, /activeView\.value !== 'settings' \|\| options\.activeSettingsWorkspace\.value !== 'worldbooks'/);
    assert.match(settingsControllerSource, /watch\(selectedWorldbookName, \(name\) => \{[\s\S]*activeSettingsWorkspace\.value !== 'worldbooks'[\s\S]*loadSelectedWorldbookPreview\(name\)/);
});

test('tavern map update badge stays collapsed until requested', () => {
    const mapPanelSource = readRepoFile('modules/tavern/app-src/components/TavernMapPanel.vue');
    const mapCss = readRepoFile('modules/tavern/app-src/styles/chat/map.css');

    assert.match(mapPanelSource, /const mapBadgeExpanded = ref\(false\)/);
    assert.doesNotMatch(mapPanelSource, /mapBadgeExpanded\.value = true/);
    assert.match(mapPanelSource, /function toggleMapBadge\(\) \{[\s\S]*mapBadgeExpanded\.value = !mapBadgeExpanded\.value/);
    assert.match(mapPanelSource, /const mapPanOffset = ref<\[number, number\]>\(\[0, 0\]\)/);
    assert.match(mapPanelSource, /function handleMapPointerDown\(event: PointerEvent\)/);
    assert.match(mapPanelSource, /@pointerdown="handleMapPointerDown"[\s\S]*@pointermove="handleMapPointerMove"[\s\S]*@pointerup="handleMapPointerEnd"[\s\S]*@pointercancel="handleMapPointerEnd"/);
    assert.match(mapCss, /\.tavern-chat\.xb-page \.tavern-map-canvas svg \{[\s\S]*cursor: grab;[\s\S]*touch-action: none;[\s\S]*user-select: none;/);
    assert.match(mapCss, /\.tavern-chat\.xb-page \.tavern-map-canvas\.is-panning svg \{[\s\S]*cursor: grabbing;/);
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
    const appSource = readRepoFile('modules/tavern/app-src/App.vue');
    const conversationPanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernConversationPanel.vue');
    const managerPanelSource = readRepoFile('modules/tavern/app-src/components/chat/TavernManagerPanel.vue');
    const contextSource = readRepoFile('modules/tavern/app-src/components/tavern-app-context.ts');
    const cssSource = readRepoFile('modules/tavern/app-src/styles/chat/messages.css');
    const composeCss = readRepoFile('modules/tavern/app-src/styles/chat/compose.css');
    const managerCss = readRepoFile('modules/tavern/app-src/styles/chat/manager.css');
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
    assert.match(conversationPanelSource, /@click="clearMessageActionTray"/);
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
    assert.match(managerPanelSource, /v-model="managerInputDraft"[\s\S]*rows="1"/);
    assert.match(composeCss, /--xb-compose-safe-space: 44px;/);
    assert.match(composeCss, /--xb-compose-safe-space: 40px;/);
    assert.match(composeCss, /\.chat-compose textarea \{[\s\S]*min-height: 32px;[\s\S]*max-height: 76px;[\s\S]*padding: 5px 10px 5px 14px;/);
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

    assert.match(appSource, /const selectedCharacterSessions = computed<TavernSessionRecord\[\]>/);
    assert.match(appSource, /:selected-character-sessions="selectedCharacterSessions"/);
    assert.match(appSource, /@open-session="selectSession"/);
    assert.match(characterSource, /selectedCharacterSessions: TavernCharacterSessionOption\[\]/);
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
    assert.match(previewCss, /\.dossier-title-actions \{[\s\S]*display: flex;[\s\S]*gap: 10px;/);
    assert.match(previewCss, /\.session-archive-button/);
    assert.match(previewCss, /\.character-session-archive \{[\s\S]*width: min\(520px, 100%\);/);
    assert.match(previewCss, /grid-template-columns: 42px minmax\(0, 1fr\) minmax\(0, 1fr\);/);
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
