function escapeHtml(text = '') {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function getAgentConfigSaveButtonState(configSave = {}) {
    const status = String(configSave?.status || 'idle');
    if (status === 'saving') {
        return {
            className: 'xb-assistant-save-button is-saving',
            title: '正在保存配置',
            html: '<span class="xb-assistant-save-spinner" aria-hidden="true"></span>保存中...',
        };
    }
    if (status === 'success') {
        return {
            className: 'xb-assistant-save-button is-success',
            title: '配置已保存',
            html: '已保存',
        };
    }
    if (status === 'error') {
        return {
            className: 'xb-assistant-save-button is-error',
            title: escapeHtml(configSave?.error || '保存失败'),
            html: '保存失败',
        };
    }
    return {
        className: 'xb-assistant-save-button',
        title: '保存配置',
        html: '保存配置',
    };
}

export function buildAgentSettingsPanelMarkup(options = {}) {
    const {
        configSave = {},
        runtimeText = '',
        inlineToastText = '',
        showInlineToast = true,
        showAssistantPermissions = true,
        showDelegateSettings = true,
        activePage = 'main',
        delegatePresetHint = 'DelegateRun 分身会使用这里的独立 API 配置；可以和主助手使用不同 Provider、Base URL、模型和 Tool 调用格式。',
        isBusy = false,
        canDeletePreset = true,
    } = options;
    const saveButton = getAgentConfigSaveButtonState(configSave);
    const saveDisabled = isBusy || String(configSave?.status || '') === 'saving' ? 'disabled' : '';
    const deleteDisabled = isBusy || !canDeletePreset ? 'disabled' : '';
    const normalizedPage = activePage === 'delegate' ? 'delegate' : 'main';
    const mainActive = normalizedPage === 'main';
    const delegateActive = normalizedPage === 'delegate';
    const assistantPermissionMarkup = showAssistantPermissions ? `
            <label>
                <span>斜杠命令权限</span>
                <select id="xb-assistant-permission-mode"></select>
            </label>
            <label>
                <span>JavaScript API 权限</span>
                <select id="xb-assistant-jsapi-permission"></select>
            </label>` : '';
    const tabsMarkup = showDelegateSettings ? `
            <div class="xb-assistant-config-tabs" role="tablist" aria-label="API 配置分页">
                <button id="xb-assistant-config-tab-main" type="button" class="xb-assistant-config-tab ${mainActive ? 'is-active' : ''}" data-config-page="main" role="tab" aria-selected="${mainActive ? 'true' : 'false'}">主助手 API</button>
                <button id="xb-assistant-config-tab-delegate" type="button" class="xb-assistant-config-tab ${delegateActive ? 'is-active' : ''}" data-config-page="delegate" role="tab" aria-selected="${delegateActive ? 'true' : 'false'}">分身 API</button>
            </div>` : '';
    const delegatePageMarkup = showDelegateSettings ? `
            <div class="xb-assistant-config-page" data-config-page-panel="delegate" ${delegateActive ? '' : 'hidden'}>
                <p class="xb-assistant-config-note">${escapeHtml(delegatePresetHint)}</p>
                <label>
                    <span>已存预设</span>
                    <select id="xb-assistant-delegate-preset-select"></select>
                </label>
                <label>
                    <span>Provider</span>
                    <select id="xb-assistant-delegate-provider">
                        <option value="openai-responses">OpenAI Responses</option>
                        <option value="openai-compatible">OpenAI-compatible</option>
                        <option value="sillytavern-openai-compatible">SillyTavern OpenAI-compatible</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="google">Google AI</option>
                    </select>
                </label>
                <label>
                    <span>Base URL</span>
                    <input id="xb-assistant-delegate-base-url" type="text" />
                </label>
                <label>
                    <span>API Key</span>
                    <div class="xb-assistant-inline-input">
                        <input id="xb-assistant-delegate-api-key" type="password" />
                        <button id="xb-assistant-delegate-toggle-key" type="button" class="secondary ghost">显示</button>
                    </div>
                </label>
                <label>
                    <span>Model</span>
                    <input id="xb-assistant-delegate-model" type="text" />
                </label>
                <div class="xb-assistant-inline-input xb-assistant-model-row">
                    <label class="xb-assistant-grow">
                        <span>已拉取模型</span>
                        <select id="xb-assistant-delegate-model-pulled">
                            <option value="">手动填写</option>
                        </select>
                    </label>
                    <button id="xb-assistant-delegate-pull-models" type="button" class="secondary" ${isBusy ? 'disabled' : ''}>拉取模型</button>
                </div>
                <div class="xb-assistant-inline-status" id="xb-assistant-delegate-model-pull-status" aria-live="polite" hidden></div>
                <label id="xb-assistant-delegate-tool-mode-wrap">
                    <span>Tool 调用格式</span>
                    <select id="xb-assistant-delegate-tool-mode"></select>
                </label>
                <label class="xb-assistant-checkbox-row">
                    <span>
                        Reasoning参数
                        <small>需 API 支持，否则报错</small>
                    </span>
                    <span class="xb-assistant-checkbox-control">
                        <input id="xb-assistant-delegate-reasoning-enabled" type="checkbox" />
                        <span>开启</span>
                    </span>
                </label>
                <label id="xb-assistant-delegate-reasoning-effort-wrap">
                    <span>思考强度</span>
                    <select id="xb-assistant-delegate-reasoning-effort"></select>
                </label>
            </div>` : '';

    return `
        <section class="xb-assistant-config">
            ${tabsMarkup}
            <div class="xb-assistant-config-page" data-config-page-panel="main" ${mainActive ? '' : 'hidden'}>
            <label>
                <span>已存预设</span>
                <select id="xb-assistant-preset-select"></select>
            </label>
            <label>
                <span>预设名称</span>
                <input id="xb-assistant-preset-name" type="text" placeholder="例如：OpenAI 测试号" />
            </label>
            <label>
                <span>Provider</span>
                <select id="xb-assistant-provider">
                    <option value="openai-responses">OpenAI Responses</option>
                    <option value="openai-compatible">OpenAI-compatible</option>
                    <option value="sillytavern-openai-compatible">SillyTavern OpenAI-compatible</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="google">Google AI</option>
                </select>
            </label>
            <label>
                <span>Base URL</span>
                <input id="xb-assistant-base-url" type="text" />
            </label>
            <label>
                <span>API Key</span>
                <div class="xb-assistant-inline-input">
                    <input id="xb-assistant-api-key" type="password" />
                    <button id="xb-assistant-toggle-key" type="button" class="secondary ghost">显示</button>
                </div>
            </label>
            <label>
                <span>Model</span>
                <input id="xb-assistant-model" type="text" />
            </label>
            <div class="xb-assistant-inline-input xb-assistant-model-row">
                <label class="xb-assistant-grow">
                    <span>已拉取模型</span>
                    <select id="xb-assistant-model-pulled">
                        <option value="">手动填写</option>
                    </select>
                </label>
                <button id="xb-assistant-pull-models" type="button" class="secondary" ${isBusy ? 'disabled' : ''}>拉取模型</button>
            </div>
            <div class="xb-assistant-inline-status" id="xb-assistant-model-pull-status" aria-live="polite" hidden></div>
            <label>
                <span>Tavily API Key（全局）</span>
                <div class="xb-assistant-inline-input">
                    <input id="xb-assistant-tavily-api-key" type="password" />
                    <button id="xb-assistant-toggle-tavily-key" type="button" class="secondary ghost">显示</button>
                </div>
            </label>
            <label id="xb-assistant-tool-mode-wrap">
                <span>Tool 调用格式</span>
                <select id="xb-assistant-tool-mode"></select>
            </label>
            ${assistantPermissionMarkup}
            <label class="xb-assistant-checkbox-row">
                <span>
                    Reasoning参数
                    <small>需 API 支持，否则报错</small>
                </span>
                <span class="xb-assistant-checkbox-control">
                    <input id="xb-assistant-reasoning-enabled" type="checkbox" />
                    <span>开启</span>
                </span>
            </label>
            <label id="xb-assistant-reasoning-effort-wrap">
                <span>思考强度</span>
                <select id="xb-assistant-reasoning-effort"></select>
            </label>
            </div>
            ${delegatePageMarkup}
            <div class="xb-assistant-actions">
                <button id="xb-assistant-save" type="button" class="${saveButton.className}" title="${saveButton.title}" ${saveDisabled}>${saveButton.html}</button>
                <button id="xb-assistant-delete-preset" type="button" class="secondary" ${deleteDisabled} ${delegateActive ? 'hidden' : ''}>删除配置</button>
            </div>
            <div class="xb-assistant-runtime" id="xb-assistant-runtime">${escapeHtml(runtimeText)}</div>
            ${showInlineToast ? `<div class="xb-assistant-toast xb-assistant-toast-inline" id="xb-assistant-toast" aria-live="polite">${escapeHtml(inlineToastText)}</div>` : ''}
        </section>
    `;
}
