export function injectEbookStyles(rootId = 'xb-ebook-root') {
    if (document.getElementById('xb-ebook-styles')) return;
    const style = document.createElement('style');
    style.id = 'xb-ebook-styles';
    style.textContent = `
        :root {
            color-scheme: dark;
            --xb-bg-deep: #171922;
            --xb-bg-editor: #1c1f2a;
            --xb-bg-agent: #20232d;
            --xb-bg-card: #242834;
            --xb-bg-glass: rgba(255, 255, 255, 0.045);
            --xb-text-main: #ebe7dd;
            --xb-text-body: #ddd7ca;
            --xb-text-muted: #b9b4ab;
            --xb-text-dim: #928f89;
            --xb-line: rgba(235, 231, 221, 0.13);
            --xb-line-strong: rgba(235, 231, 221, 0.22);
            --xb-cyan: #8fb4bd;
            --xb-indigo: #b3adca;
            --xb-gold: #ebe7dd;
            --xb-danger: #d88490;
            --xb-ok: #96b8b2;
            --xb-shadow: 0 16px 34px rgba(0, 0, 0, 0.26);
            --xb-font-ui: "Inter", "Segoe UI", "Microsoft YaHei", sans-serif;
            --xb-font-serif: "Lora", "LXGW WenKai", "Noto Serif SC", "Microsoft YaHei", serif;
            --xb-font-mono: "JetBrains Mono", "Cascadia Code", "Consolas", monospace;
            --xb-fluid: cubic-bezier(0.16, 1, 0.3, 1);
        }

        *, *::before, *::after { box-sizing: border-box; }
        html, body, #${rootId} { width: 100%; height: 100%; margin: 0; overflow: hidden; }
        body {
            background: var(--xb-bg-deep);
            color: var(--xb-text-main);
            font-family: var(--xb-font-ui);
            -webkit-font-smoothing: subpixel-antialiased;
            text-rendering: auto;
        }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(100, 116, 139, 0.42); border-radius: 999px; }

        button, input, select, textarea { font: inherit; }
        button {
            border: 1px solid var(--xb-line);
            border-radius: 12px;
            background: var(--xb-bg-glass);
            color: var(--xb-text-main);
            cursor: pointer;
            transition: transform 0.22s ease, background 0.22s ease, border-color 0.22s ease, color 0.22s ease, box-shadow 0.22s ease, opacity 0.22s ease;
        }
        button:hover:not(:disabled) {
            transform: translateY(-1px);
            border-color: var(--xb-line-strong);
            background: rgba(255, 255, 255, 0.07);
            box-shadow: none;
        }
        button:disabled { opacity: 0.56; cursor: not-allowed; }
        h1, h2, h3, p { margin: 0; }

        .xb-ebook-screen {
            position: relative;
            width: 100%;
            height: 100%;
            min-height: 0;
            overflow: hidden;
            background: var(--xb-bg-deep);
            color: var(--xb-text-main);
        }
        .xb-ebook-screen.theme-light,
        .xb-ebook-shell.theme-light {
            color-scheme: light;
            --xb-bg-deep: #fffaf0;
            --xb-bg-editor: #fffdf8;
            --xb-bg-agent: #fff8ec;
            --xb-bg-card: rgba(255, 253, 248, 0.96);
            --xb-bg-glass: rgba(87, 70, 48, 0.045);
            --xb-text-main: #24201b;
            --xb-text-body: #2e2922;
            --xb-text-muted: #665f54;
            --xb-text-dim: #867d70;
            --xb-line: rgba(87, 70, 48, 0.15);
            --xb-line-strong: rgba(87, 70, 48, 0.25);
            --xb-cyan: #3d7c83;
            --xb-indigo: #686283;
            --xb-gold: #3a3329;
            --xb-danger: #b64d5d;
            --xb-ok: #32766d;
            --xb-shadow: 0 18px 44px rgba(87, 70, 48, 0.12);
            background: var(--xb-bg-deep);
            color: var(--xb-text-main);
        }
        .theme-light button:hover:not(:disabled) {
            border-color: var(--xb-line-strong);
            background: rgba(87, 70, 48, 0.07);
            box-shadow: 0 12px 28px rgba(87, 70, 48, 0.12);
        }
        .xb-ambient-aurora {
            position: absolute;
            top: -24vh;
            left: 24vw;
            width: 68vw;
            height: 64vh;
            pointer-events: none;
            z-index: 0;
            background: radial-gradient(ellipse, rgba(166, 171, 200, 0.045), rgba(143, 183, 202, 0.018), transparent 62%);
            filter: blur(86px);
            animation: xb-aurora-drift 15s infinite alternate ease-in-out;
        }
        .theme-light .xb-ambient-aurora,
        .theme-light .xb-agent-aurora,
        .theme-light .xb-reader-backlight {
            display: none;
        }
        @keyframes xb-aurora-drift {
            100% { transform: translateY(48px) scale(1.08); }
        }
        .xb-toast {
            position: fixed;
            left: 50%;
            bottom: 32px;
            z-index: 200;
            transform: translateX(-50%);
            max-width: min(520px, calc(100vw - 32px));
            padding: 12px 20px;
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 999px;
            background: rgba(241, 245, 249, 0.92);
            color: #111216;
            box-shadow: var(--xb-shadow);
            font-size: 13px;
            font-weight: 600;
        }
        .xb-empty {
            color: var(--xb-text-muted);
            line-height: 1.7;
        }
        .xb-kicker {
            color: var(--xb-gold);
            font-family: var(--xb-font-mono);
            font-size: 11px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
        }

        /* Archive */
        .xb-archive-header {
            position: relative;
            z-index: 2;
            height: 150px;
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            gap: 28px;
            padding: 38px 60px;
        }
        .xb-archive-header h1 {
            font-family: var(--xb-font-serif);
            font-size: clamp(34px, 4vw, 52px);
            font-weight: 400;
            letter-spacing: 0;
        }
        .xb-archive-meta {
            margin-top: 9px;
            color: var(--xb-text-muted);
            font-family: var(--xb-font-mono);
            font-size: 12px;
            letter-spacing: 0.22em;
            text-transform: uppercase;
        }
        .xb-global-actions,
        .xb-home-actions {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: flex-end;
            gap: 12px;
        }
        .xb-glass-button,
        .xb-home-actions button,
        #xb-close {
            min-height: 40px;
            padding: 0 18px;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.045);
            color: var(--xb-text-main);
            font-size: 13px;
            font-weight: 600;
        }
        .xb-danger-button { color: var(--xb-danger); }
        .xb-danger-button:hover:not(:disabled) {
            border-color: rgba(244, 63, 94, 0.34);
            background: rgba(244, 63, 94, 0.12);
        }
        .xb-shelf-container {
            position: relative;
            z-index: 2;
            height: calc(100vh - 150px);
            overflow: auto;
            padding: 18px 60px 96px;
        }
        .xb-library-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
            gap: 34px;
        }
        .xb-library-empty {
            min-height: 220px;
            display: grid;
            place-items: center;
            border: 1px dashed rgba(255, 255, 255, 0.12);
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.035);
            text-align: center;
        }
        .xb-delete-mode-note {
            margin: 0 0 18px;
            color: var(--xb-danger);
            font-size: 13px;
            letter-spacing: 0.06em;
        }
        .xb-library-book {
            position: relative;
            min-height: 330px;
            aspect-ratio: 3 / 4;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            overflow: hidden;
            padding: 30px 24px 24px;
            border: 1px solid rgba(255, 255, 255, 0.045);
            border-radius: 12px;
            background: var(--xb-bg-card);
            text-align: left;
            box-shadow: 0 18px 46px rgba(0, 0, 0, 0.24);
            transition: transform 0.42s var(--xb-fluid), border-color 0.3s ease, box-shadow 0.3s ease, background 0.3s ease;
        }
        .xb-library-book::before {
            content: "";
            position: absolute;
            inset: 0 auto 0 -80%;
            width: 48%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.035), transparent);
            transform: skewX(-18deg);
            transition: left 0.7s ease;
        }
        .xb-library-book:hover:not(:disabled) {
            transform: translateY(-8px);
            border-color: rgba(255, 255, 255, 0.16);
            box-shadow: 0 24px 58px rgba(0, 0, 0, 0.34);
        }
        .xb-library-book:hover::before { left: 140%; }
        .xb-library-book.is-active {
            border-color: rgba(143, 183, 202, 0.34);
            box-shadow: 0 20px 54px rgba(0, 0, 0, 0.30);
        }
        .xb-library-book.is-delete-target {
            border-color: rgba(244, 63, 94, 0.34);
            animation: xb-delete-vibrate 0.34s infinite alternate ease-in-out;
        }
        .xb-library-book.is-delete-target:hover:not(:disabled) {
            background: rgba(244, 63, 94, 0.10);
            border-color: rgba(244, 63, 94, 0.72);
            box-shadow: 0 20px 48px rgba(0, 0, 0, 0.30);
        }
        @keyframes xb-delete-vibrate {
            0% { transform: rotate(-0.42deg); }
            100% { transform: rotate(0.42deg); }
        }
        .xb-book-spine {
            position: absolute;
            left: 0;
            top: 24px;
            bottom: 24px;
            width: 3px;
            border-radius: 999px;
            background: linear-gradient(var(--xb-indigo), var(--xb-cyan));
            opacity: 0.76;
        }
        .xb-library-book-main {
            display: grid;
            gap: 12px;
            min-width: 0;
        }
        .xb-library-book strong {
            color: var(--xb-text-main);
            font-family: var(--xb-font-serif);
            font-size: 25px;
            font-weight: 400;
            line-height: 1.25;
        }
        .xb-library-book small {
            color: var(--xb-text-muted);
            font-size: 13px;
            line-height: 1.6;
        }
        .xb-library-book-foot {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding-top: 22px;
            border-top: 1px solid rgba(255, 255, 255, 0.045);
        }
        .xb-library-book-foot em {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 5px 9px;
            border-radius: 5px;
            background: rgba(143, 183, 202, 0.14);
            color: var(--xb-cyan);
            font-family: var(--xb-font-mono);
            font-size: 10px;
            font-style: normal;
            letter-spacing: 0.08em;
        }
        .xb-library-book-foot em::before {
            content: "";
            width: 6px;
            height: 6px;
            border-radius: 999px;
            background: currentColor;
        }
        .is-delete-target .xb-library-book-foot em {
            background: rgba(244, 63, 94, 0.12);
            color: var(--xb-danger);
        }

        /* Entry portal */
        .xb-entry-screen {
            display: grid;
            place-items: center;
        }
        .xb-portal-close {
            position: absolute;
            z-index: 5;
            width: 42px;
            height: 42px;
            padding: 0;
            border-radius: 999px;
            background: transparent;
            color: rgba(241, 245, 249, 0.58);
            font-size: 26px;
        }
        .xb-portal-close { top: 34px; left: 50%; transform: translateX(-50%); }
        .xb-portal-close:hover:not(:disabled) { transform: translateX(-50%) translateY(-1px); }
        .xb-portal-theme {
            position: absolute;
            top: 36px;
            right: 42px;
            z-index: 5;
            min-width: 62px;
            height: 36px;
            padding: 0 14px;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.06);
            color: var(--xb-text-main);
            font-size: 13px;
            font-weight: 700;
        }
        .xb-entry-portal {
            position: relative;
            z-index: 2;
            width: 100%;
            height: 100%;
        }
        .xb-entry-actions {
            display: flex;
            width: 100%;
            height: 100%;
        }
        .xb-entry-action {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 18px;
            border: 0;
            border-right: 1px solid rgba(255, 255, 255, 0.03);
            border-radius: 0;
            background: transparent;
            text-align: center;
            transition: flex 0.62s var(--xb-fluid), background 0.3s ease;
        }
        .xb-entry-action strong {
            color: rgba(241, 245, 249, 0.70);
            font-family: var(--xb-font-serif);
            font-size: clamp(42px, 6vw, 78px);
            font-weight: 400;
            letter-spacing: 0;
            transition: transform 0.36s ease, color 0.36s ease;
        }
        .xb-entry-action span {
            max-width: 360px;
            color: var(--xb-text-muted);
            font-family: var(--xb-font-mono);
            font-size: 12px;
            letter-spacing: 0.18em;
            line-height: 1.8;
        }
        .xb-entry-action:hover:not(:disabled) {
            flex: 1.25;
            transform: none;
            box-shadow: none;
        }
        .xb-entry-action:hover strong {
            color: var(--xb-text-main);
            transform: scale(1.08);
        }
        .xb-entry-action.is-studio:hover {
            background: radial-gradient(circle at center, rgba(166, 171, 200, 0.07), transparent 54%);
        }
        .xb-entry-action.is-studio:hover strong {
            color: var(--xb-text-main);
        }
        .xb-entry-action.is-reader:hover {
            background: radial-gradient(circle at center, rgba(233, 231, 227, 0.055), transparent 54%);
        }
        .xb-entry-action.is-reader:hover strong {
            color: var(--xb-text-main);
        }

        /* Studio */
        .xb-ebook-shell {
            width: 100%;
            height: 100%;
            min-height: 0;
            display: flex;
            overflow: hidden;
            background: var(--xb-bg-deep);
            color: var(--xb-text-main);
        }
        .xb-sidebar { 
            position: relative;
            z-index: 3;
            width: 250px;
            flex: 0 0 250px;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 20px;
            padding: 24px 16px;
            border-right: 1px solid rgba(255, 255, 255, 0.04);
            background: var(--xb-bg-deep);
        }
        .xb-brand {
            min-width: 0;
            display: grid;
            gap: 12px;
        }
        .xb-title-row {
            min-width: 0;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .xb-title-row h1,
        .xb-title-row h2 {
            flex: 1 1 auto;
            min-width: 0;
            overflow: hidden;
            color: var(--xb-text-main);
            text-overflow: ellipsis;
            white-space: nowrap;
            font-family: var(--xb-font-serif);
            font-size: 22px;
            font-weight: 400;
        }
        .xb-icon-button {
            width: 34px;
            height: 34px;
            min-width: 34px;
            padding: 0;
            display: inline-grid;
            place-items: center;
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.04);
            color: var(--xb-text-muted);
            font-size: 16px;
            line-height: 1;
        }
        .xb-panel,
        .xb-files-panel {
            min-height: 0;
            display: flex;
            flex-direction: column;
        }
        .xb-files {
            min-height: 0;
            overflow: auto;
            display: grid;
            align-content: start;
            gap: 20px;
            padding-right: 2px;
        }
        .xb-file-group {
            display: grid;
            gap: 8px;
        }
        .xb-file-group-title {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            color: var(--xb-text-main);
            font-family: var(--xb-font-ui);
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.02em;
        }
        .xb-file-group-title span {
            color: inherit;
            font-size: inherit;
            font-weight: inherit;
        }
        .xb-file-group-title em {
            padding: 3px 8px;
            border-radius: 999px;
            background: rgba(143, 183, 202, 0.12);
            color: var(--xb-cyan);
            font-family: var(--xb-font-ui);
            font-size: 13px;
            font-weight: 700;
            font-style: normal;
            letter-spacing: 0.02em;
        }
        .xb-file-group-desc {
            color: var(--xb-text-muted);
            font-size: 12px;
            line-height: 1.55;
        }
        .xb-section-subtitle {
            color: var(--xb-text-main);
            font-family: var(--xb-font-ui);
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.04em;
        }
        .xb-file,
        .xb-imports button,
        .xb-actions button {
            width: 100%;
            min-width: 0;
            min-height: 36px;
            padding: 9px 10px;
            border-radius: 8px;
            background: transparent;
            color: var(--xb-text-muted);
            text-align: left;
            font-size: 13px;
        }
        .xb-file {
            display: grid;
            gap: 2px;
        }
        .xb-file.is-active {
            border-color: rgba(255, 255, 255, 0.07);
            background: rgba(255, 255, 255, 0.045);
            color: var(--xb-text-main);
            box-shadow: inset 2px 0 0 var(--xb-cyan);
        }
        .xb-file-main {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .xb-section-empty {
            padding: 10px;
            border: 1px dashed rgba(255, 255, 255, 0.08);
            border-radius: 10px;
            color: var(--xb-text-muted);
            font-size: 12px;
            line-height: 1.55;
        }
        .xb-imports {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 7px;
        }
        .xb-imports button {
            text-align: center;
            color: var(--xb-cyan);
            background: rgba(143, 183, 202, 0.10);
        }
        .xb-studio-workbench {
            position: relative;
            flex: 1;
            min-width: 0;
            min-height: 0;
            display: flex;
            overflow: hidden;
            background: var(--xb-bg-editor);
        }
        .xb-workspace-controller {
            display: flex;
            gap: 4px;
            padding: 4px;
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 999px;
            background: rgba(0, 0, 0, 0.58);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
            backdrop-filter: blur(14px);
        }
        .xb-layout-button {
            flex: 1;
            min-height: 28px;
            padding: 0 14px;
            border: 0;
            border-radius: 999px;
            background: transparent;
            color: var(--xb-text-muted);
            font-size: 12px;
        }
        .xb-layout-button.is-active {
            background: rgba(255, 255, 255, 0.12);
            color: var(--xb-text-main);
        }
        .xb-editor,
        .xb-agent {
            min-width: 280px;
            min-height: 0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            transition: flex-grow 0.72s var(--xb-fluid), opacity 0.4s ease, filter 0.4s ease, box-shadow 0.4s ease;
        }
        .xb-editor {
            flex: 1 1 0;
            background: var(--xb-bg-editor);
            border-right: 1px solid rgba(255, 255, 255, 0.025);
        }
        .xb-agent {
            position: relative;
            flex: 1.08 1 0;
            background: var(--xb-bg-agent);
            border-left: 1px solid rgba(0, 0, 0, 0.48);
            box-shadow: -14px 0 36px rgba(0, 0, 0, 0.22);
        }
        .xb-studio-shell.focus-editor .xb-editor { flex-grow: 2.35; }
        .xb-studio-shell.focus-editor .xb-agent { flex-grow: 0.72; opacity: 0.72; }
        .xb-studio-shell.focus-editor .xb-agent:hover { opacity: 1; }
        .xb-studio-shell.focus-agent .xb-editor { flex-grow: 0.55; filter: brightness(0.74); }
        .xb-studio-shell.focus-agent .xb-agent { flex-grow: 2.05; box-shadow: -22px 0 58px rgba(0, 0, 0, 0.48); }
        .xb-editor-head {
            min-height: 70px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 14px;
            padding: 20px 34px;
            background: linear-gradient(180deg, rgba(9, 11, 15, 1), rgba(9, 11, 15, 0.70), transparent);
            color: var(--xb-text-muted);
            font-family: var(--xb-font-mono);
            font-size: 12px;
        }
        .xb-path {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .xb-editor-actions {
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-end;
            gap: 8px;
        }
        .xb-editor-actions button,
        .xb-agent-toolbar button,
        #xb-agent-settings-close {
            min-height: 32px;
            padding: 0 12px;
            border-radius: 999px;
            color: var(--xb-text-muted);
            font-size: 12px;
        }
        #xb-save:not(:disabled) {
            color: var(--xb-cyan);
            border-color: rgba(143, 183, 202, 0.32);
            background: rgba(143, 183, 202, 0.12);
        }
        .xb-editor-body {
            min-height: 0;
            flex: 1;
            overflow: hidden;
            padding: 12px 58px 28px;
        }
        #xb-editor-text {
            width: 100%;
            height: 100%;
            min-height: 0;
            resize: none;
            outline: none;
            border: 0;
            background: transparent;
            color: var(--xb-text-body);
            font: 17px/1.85 var(--xb-font-serif);
        }
        #xb-editor-text:disabled { opacity: 0.62; }
        .xb-editor-foot {
            min-height: 36px;
            padding: 8px 34px 14px;
            color: var(--xb-text-dim);
            font-family: var(--xb-font-mono);
            font-size: 11px;
        }
        .xb-agent-aurora {
            position: absolute;
            top: -170px;
            left: -120px;
            width: 520px;
            height: 520px;
            pointer-events: none;
            background: radial-gradient(circle, rgba(166, 171, 200, 0.18), rgba(143, 183, 202, 0.08), transparent 62%);
            filter: blur(86px);
            opacity: 0.052;
            animation: xb-agent-flow 10s infinite alternate ease-in-out;
        }
        @keyframes xb-agent-flow {
            100% { transform: scale(1.18) translate(52px, -18px); opacity: 0.09; }
        }
        .xb-agent-head {
            position: relative;
            z-index: 2;
            display: grid;
            gap: 14px;
            padding: 22px 30px 16px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.035);
        }
        .xb-agent-id {
            display: flex;
            align-items: center;
            gap: 10px;
            color: var(--xb-text-main);
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.10em;
        }
        .xb-agent-id span {
            width: 8px;
            height: 8px;
            border-radius: 999px;
            background: var(--xb-cyan);
            animation: xb-agent-heart 2s infinite ease-in-out;
        }
        @keyframes xb-agent-heart {
            50% { opacity: 1; }
            0%, 100% { opacity: 0.48; }
        }
        .xb-agent-toolbar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
        }
        .xb-agent-context-meter {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 86px;
            min-height: 32px;
            padding: 0 12px;
            border: 1px solid rgba(143, 183, 202, 0.26);
            border-radius: 999px;
            background: rgba(143, 183, 202, 0.12);
            color: var(--xb-cyan);
            font-family: var(--xb-font-mono);
            font-size: 11px;
        }
        .xb-agent-toolbar #xb-theme-toggle {
            min-width: 48px;
            margin-left: auto;
            color: var(--xb-text-main);
            border-color: rgba(143, 183, 202, 0.24);
            background: rgba(143, 183, 202, 0.12);
        }
        #xb-agent-close { margin-left: 0; }
        .xb-agent-chat-wrap {
            position: relative;
            z-index: 2;
            min-height: 0;
            flex: 1;
            overflow: hidden;
        }
        .xb-agent-main {
            height: 100%;
            min-height: 0;
            overflow: auto;
            display: flex;
            flex-direction: column;
            gap: 18px;
            padding: 26px 30px;
        }
        .xb-agent-log {
            min-height: 0;
            display: flex;
            flex-direction: column;
            gap: 18px;
        }
        .xb-agent-empty,
        .xb-agent-memory {
            color: var(--xb-text-muted);
            font-size: 13px;
            line-height: 1.7;
        }
        .xb-agent-memory {
            padding: 0 0 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.045);
        }
        .xb-actions-panel {
            border: 1px solid rgba(255, 255, 255, 0.055);
            border-radius: 12px;
            background: rgba(0, 0, 0, 0.22);
            color: var(--xb-text-muted);
            font-size: 12px;
        }
        .xb-actions-panel summary {
            padding: 10px 12px;
            cursor: pointer;
            color: var(--xb-cyan);
            font-weight: 700;
            list-style: none;
        }
        .xb-actions-panel summary::-webkit-details-marker { display: none; }
        .xb-actions-panel[open] { padding-bottom: 12px; }
        .xb-actions {
            display: grid;
            grid-template-columns: repeat(5, minmax(0, 1fr));
            gap: 8px;
            padding: 0 12px;
        }
        .xb-actions button {
            text-align: center;
            color: var(--xb-text-main);
            background: rgba(255, 255, 255, 0.05);
        }
        .xb-msg {
            position: relative;
            max-width: 92%;
            padding: 14px 16px;
            border: 1px solid rgba(255, 255, 255, 0.055);
            border-radius: 14px;
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.045), transparent);
            color: var(--xb-text-main);
            line-height: 1.65;
        }
        .xb-msg.is-editing {
            width: min(92%, 760px);
            max-width: min(92%, 760px);
        }
        .xb-msg-user {
            align-self: flex-end;
            border-bottom-right-radius: 4px;
            background: rgba(255, 255, 255, 0.075);
        }
        .xb-msg-assistant {
            align-self: flex-start;
            border-top-left-radius: 4px;
            border-left: 2px solid var(--xb-indigo);
        }
        .xb-msg.is-error {
            border-color: rgba(244, 63, 94, 0.34);
            color: #fecdd3;
        }
        .xb-msg.is-streaming {
            border-color: rgba(143, 183, 202, 0.34);
        }
        .xb-msg-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-bottom: 8px;
        }
        .xb-msg-role {
            color: var(--xb-cyan);
            font-family: var(--xb-font-mono);
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.10em;
        }
        .xb-msg-user .xb-msg-role { color: var(--xb-gold); }
        .xb-msg-actions {
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .xb-msg-action {
            width: 24px;
            height: 24px;
            min-width: 24px;
            padding: 0;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.05);
            color: var(--xb-text-muted);
            font-size: 12px;
        }
        .xb-agent-main.is-busy .xb-msg-action:not([data-message-action="cancel-edit"]) {
            opacity: 0.5;
            pointer-events: none;
        }
        .xb-msg-content,
        .xb-assistant-markdown {
            min-width: 0;
            max-width: 100%;
            overflow-wrap: anywhere;
        }
        .xb-assistant-markdown { line-height: 1.72; white-space: normal; }
        .xb-assistant-markdown > *:first-child { margin-top: 0; }
        .xb-assistant-markdown > *:last-child { margin-bottom: 0; }
        .xb-assistant-markdown p,
        .xb-assistant-markdown ul,
        .xb-assistant-markdown ol,
        .xb-assistant-markdown pre,
        .xb-assistant-markdown blockquote,
        .xb-assistant-markdown table,
        .xb-assistant-markdown h1,
        .xb-assistant-markdown h2,
        .xb-assistant-markdown h3,
        .xb-assistant-markdown h4 {
            margin: 0 0 0.85em;
        }
        .xb-assistant-markdown code {
            padding: 0.12em 0.36em;
            border-radius: 7px;
            background: rgba(148, 163, 184, 0.12);
            color: #d8dde2;
            font-family: var(--xb-font-mono);
            font-size: 0.94em;
        }
        .xb-assistant-markdown pre {
            overflow-x: hidden;
            padding: 12px 14px;
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 10px;
            background: rgba(0, 0, 0, 0.30);
            white-space: pre-wrap;
            word-break: break-word;
        }
        .xb-assistant-codeblock {
            position: relative;
            min-width: 0;
            max-width: 100%;
        }
        .xb-assistant-codeblock .xb-assistant-code-copy {
            position: absolute;
            top: 8px;
            right: 8px;
            width: 24px;
            height: 24px;
            border: 0;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.10);
            color: var(--xb-text-main);
            cursor: pointer;
            font-size: 12px;
            opacity: 0.82;
        }
        .xb-assistant-codeblock pre { padding-top: 34px; }
        .xb-markdown-html-block {
            display: grid;
            gap: 10px;
            margin: 0 0 0.8em;
            padding: 12px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            background: rgba(0, 0, 0, 0.20);
        }
        .xb-markdown-html-head,
        .xb-markdown-html-actions {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .xb-markdown-html-actions { flex-wrap: wrap; justify-content: flex-end; }
        .xb-markdown-html-title {
            display: grid;
            gap: 2px;
            color: var(--xb-cyan);
            font-size: 12px;
            font-weight: 700;
        }
        .xb-markdown-html-title span {
            color: var(--xb-text-muted);
            font-size: 11px;
            font-weight: 500;
        }
        .xb-markdown-html-actions button {
            padding: 5px 9px;
            border-radius: 999px;
            font-size: 12px;
        }
        .xb-markdown-html-actions button.is-active { background: rgba(143, 183, 202, 0.16); }
        .xb-markdown-html-code {
            max-height: 320px;
            overflow: auto;
            margin: 0;
            padding: 12px 14px;
            border-radius: 10px;
            background: rgba(0, 0, 0, 0.30);
            white-space: pre-wrap;
            word-break: break-all;
            font: 12px/1.55 var(--xb-font-mono);
        }
        .xb-markdown-html-preview {
            width: 100%;
            height: 320px;
            border: 1px solid rgba(255, 255, 255, 0.10);
            border-radius: 10px;
            background: #fff;
        }
        .xb-assistant-markdown pre code {
            padding: 0;
            background: transparent;
        }
        .xb-assistant-markdown blockquote {
            padding-left: 14px;
            border-left: 2px solid rgba(233, 231, 227, 0.22);
            color: #c4bda9;
        }
        .xb-assistant-markdown table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.95em;
        }
        .xb-assistant-markdown th,
        .xb-assistant-markdown td {
            border: 1px solid rgba(255, 255, 255, 0.10);
            padding: 6px 10px;
            text-align: left;
            vertical-align: top;
        }
        .xb-assistant-markdown th {
            background: rgba(255, 255, 255, 0.055);
            font-weight: 600;
        }
        .xb-assistant-markdown a { color: var(--xb-cyan); }
        .xb-assistant-markdown ul,
        .xb-assistant-markdown ol { padding-left: 1.4em; }
        .xb-msg-editor-wrap {
            width: 100%;
            min-width: 0;
        }
        .xb-msg-editor {
            display: block;
            width: 100%;
            min-height: 112px;
            resize: vertical;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            padding: 11px 12px;
            outline: none;
            background: rgba(0, 0, 0, 0.28);
            color: var(--xb-text-main);
            font: 13px/1.65 var(--xb-font-ui);
        }
        .xb-thought-details,
        .xb-tool-trace {
            color: var(--xb-text-muted);
            font-size: 12px;
        }
        .xb-thought-details { margin: 4px 0 8px; }
        .xb-thought-details summary,
        .xb-tool-trace summary {
            cursor: pointer;
            list-style: none;
            color: var(--xb-cyan);
            font-weight: 700;
        }
        .xb-thought-details summary::-webkit-details-marker,
        .xb-tool-trace summary::-webkit-details-marker { display: none; }
        .xb-thought-details[open],
        .xb-tool-trace[open] {
            display: grid;
            gap: 7px;
        }
        .xb-thought-block,
        .xb-tool-preface,
        .xb-tool {
            border: 1px solid rgba(255, 255, 255, 0.055);
            border-left: 2px solid var(--xb-cyan);
            border-radius: 10px;
            background: rgba(0, 0, 0, 0.25);
            padding: 9px 11px;
        }
        .xb-thought-label,
        .xb-tool-round-title {
            color: var(--xb-cyan);
            font-family: var(--xb-font-mono);
            font-size: 11px;
            font-weight: 700;
            margin-bottom: 5px;
        }
        .xb-thought-block pre {
            margin: 0;
            white-space: pre-wrap;
            color: var(--xb-text-muted);
            font: 12px/1.55 var(--xb-font-ui);
        }
        .xb-tool-trace {
            border: 0;
            border-radius: 0;
            padding: 0;
            background: transparent;
        }
        .xb-tool-trace summary {
            display: grid;
            grid-template-columns: auto auto 1fr;
            align-items: center;
            gap: 8px;
            padding: 2px 0;
        }
        .xb-tool-trace summary::after {
            content: "";
            height: 1px;
            background: rgba(143, 183, 202, 0.28);
        }
        .xb-tool-fold-indicator::before { content: ">"; }
        .xb-tool-trace[open] .xb-tool-fold-indicator::before { content: "v"; }
        .xb-tool-trace-body {
            display: grid;
            gap: 8px;
        }
        .xb-tool-round {
            display: grid;
            gap: 8px;
        }
        .xb-tool-round + .xb-tool-round {
            padding-top: 8px;
            border-top: 1px solid rgba(255, 255, 255, 0.055);
        }
        .xb-tool {
            border-left-color: var(--xb-text-dim);
            font-family: var(--xb-font-mono);
            font-size: 12px;
        }
        .xb-tool.is-running {
            border-left-color: var(--xb-cyan);
        }
        .xb-tool > .xb-tool-plain-title,
        .xb-tool > .xb-tool-head {
            color: var(--xb-cyan);
            margin-bottom: 5px;
        }
        .xb-tool-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .xb-tool-head span {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .xb-tool-head em {
            flex: 0 0 auto;
            color: var(--xb-text-muted);
            font-size: 11px;
            font-style: normal;
            font-weight: 600;
        }
        .xb-tool.is-running .xb-tool-head em {
            color: var(--xb-cyan);
        }
        .xb-tool-result {
            display: grid;
            gap: 5px;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid rgba(255, 255, 255, 0.055);
        }
        .xb-tool-result .xb-tool-head {
            margin-bottom: 0;
            color: var(--xb-cyan);
        }
        .xb-tool-payload {
            display: grid;
            gap: 6px;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid rgba(255, 255, 255, 0.055);
            color: var(--xb-text-muted);
        }
        .xb-tool.has-payload .xb-tool-payload {
            margin-top: 0;
            padding-top: 0;
            border-top: 0;
        }
        .xb-tool-payload-row {
            display: grid;
            gap: 3px;
        }
        .xb-tool-payload-row span {
            color: var(--xb-text-dim);
            font-size: 11px;
            font-weight: 700;
        }
        .xb-tool-payload-row p {
            margin: 0;
            color: var(--xb-text-muted);
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            line-height: 1.55;
        }
        .xb-tool small,
        .xb-meta {
            color: var(--xb-text-muted);
            font-size: 12px;
            line-height: 1.55;
        }
        .xb-tool.is-error { border-left-color: var(--xb-danger); }
        .xb-agent-scroll-helpers {
            position: absolute;
            top: 12%;
            right: 10px;
            bottom: 12%;
            z-index: 5;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.25s ease;
        }
        .xb-agent-scroll-helpers.active { opacity: 1; }
        .xb-agent-scroll-btn {
            width: 30px;
            height: 30px;
            padding: 0;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.10);
            color: var(--xb-text-main);
            pointer-events: none;
            opacity: 0;
            transform: scale(0.82) translateX(8px);
            font-size: 11px;
        }
        .xb-agent-scroll-btn.visible {
            opacity: 1;
            pointer-events: auto;
            transform: scale(1) translateX(0);
        }
        .xb-agent-form {
            position: relative;
            z-index: 2;
            padding: 18px 30px 24px;
            border-top: 1px solid rgba(255, 255, 255, 0.025);
            background: linear-gradient(0deg, var(--xb-bg-agent) 74%, transparent);
        }
        .xb-agent-compose-row {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 8px 14px;
            border: 1px solid rgba(255, 255, 255, 0.09);
            border-radius: 14px;
            background: rgba(0, 0, 0, 0.42);
            transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
        }
        .xb-agent-compose-row:focus-within {
            border-color: rgba(143, 183, 202, 0.46);
            background: rgba(0, 0, 0, 0.58);
        }
        .xb-agent-compose-main {
            flex: 1;
            min-width: 0;
            display: grid;
            gap: 4px;
        }
        #xb-agent-input {
            width: 100%;
            min-height: 46px;
            max-height: 150px;
            resize: vertical;
            border: 0;
            outline: none;
            background: transparent;
            color: var(--xb-text-main);
            font: 14px/1.5 var(--xb-font-ui);
        }
        .xb-compose-hint {
            color: var(--xb-text-dim);
            font-size: 11px;
        }
        .xb-agent-compose-actions {
            width: 40px;
            display: grid;
            place-items: center;
        }
        .xb-agent-form button[type="submit"] {
            width: 38px;
            height: 38px;
            padding: 0;
            border: 0;
            border-radius: 12px;
            background: transparent;
            color: var(--xb-cyan);
            font-size: 20px;
        }
        .xb-agent-form button[type="submit"].is-busy {
            color: var(--xb-danger);
        }

        /* Settings and delete dialogs */
        .xb-ebook-settings-overlay,
        .xb-ebook-delete-overlay {
            position: absolute;
            inset: 0;
            z-index: 80;
            display: grid;
            place-items: center;
            padding: 28px;
            background: rgba(0, 0, 0, 0.62);
            backdrop-filter: blur(16px);
        }
        .xb-ebook-settings-dialog,
        .xb-ebook-delete-dialog {
            width: min(820px, 100%);
            max-height: min(88vh, 920px);
            display: grid;
            grid-template-rows: auto minmax(0, 1fr);
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.10);
            border-radius: 18px;
            background: rgba(14, 17, 23, 0.96);
            box-shadow: var(--xb-shadow);
        }
        .xb-ebook-delete-dialog {
            width: min(480px, 100%);
            grid-template-rows: auto auto minmax(0, 1fr);
        }
        .xb-ebook-settings-head,
        .xb-ebook-delete-head {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 18px;
            padding: 22px 24px 16px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .xb-ebook-settings-head h2,
        .xb-ebook-delete-head h2 {
            color: var(--xb-text-main);
            font-size: 22px;
            font-weight: 600;
        }
        .xb-ebook-settings-head p,
        .xb-ebook-delete-note {
            color: var(--xb-text-muted);
            font-size: 13px;
            line-height: 1.65;
        }
        .xb-ebook-settings-head p { margin-top: 6px; }
        .xb-ebook-delete-note {
            margin: 0;
            padding: 13px 24px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }
        .xb-ebook-settings-body {
            min-height: 0;
            overflow: auto;
            padding: 22px 24px 26px;
        }
        .xb-ebook-delete-list {
            min-height: 0;
            overflow: auto;
            display: grid;
            align-content: start;
            gap: 8px;
            padding: 14px;
        }
        .xb-delete-book-item {
            display: grid;
            gap: 4px;
            padding: 13px 14px;
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.045);
            text-align: left;
        }
        .xb-delete-book-item strong { color: var(--xb-text-main); font-size: 14px; }
        .xb-delete-book-item small { color: var(--xb-text-muted); font-size: 11px; }
        .xb-ebook-settings-body .xb-assistant-config {
            display: grid;
            gap: 12px;
        }
        .xb-ebook-settings-body .xb-assistant-config-tabs {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            padding: 4px;
            border-radius: 14px;
            background: rgba(255, 255, 255, 0.055);
        }
        .xb-ebook-settings-body .xb-assistant-config-tab {
            min-height: 34px;
            border: 0;
            border-radius: 10px;
            background: transparent;
            color: var(--xb-text-muted);
            font-weight: 700;
        }
        .xb-ebook-settings-body .xb-assistant-config-tab.is-active {
            background: rgba(255, 255, 255, 0.13);
            color: var(--xb-text-main);
        }
        .xb-ebook-settings-body .xb-assistant-config-page {
            display: grid;
            gap: 12px;
        }
        .xb-ebook-settings-body .xb-assistant-config-page[hidden] { display: none; }
        .xb-ebook-settings-body .xb-assistant-config-note,
        .xb-ebook-settings-body .xb-assistant-runtime,
        .xb-ebook-settings-body .xb-assistant-inline-status {
            color: var(--xb-text-muted);
            font-size: 12px;
            line-height: 1.55;
        }
        .xb-ebook-settings-body .xb-assistant-inline-status.is-success { color: #86efac; }
        .xb-ebook-settings-body .xb-assistant-inline-status.is-error { color: #fda4af; }
        .xb-ebook-settings-body .xb-assistant-inline-status.is-loading { color: var(--xb-cyan); }
        .xb-ebook-settings-body .xb-assistant-config label {
            display: grid;
            gap: 6px;
            color: var(--xb-text-main);
            font-size: 13px;
        }
        .xb-ebook-settings-body .xb-assistant-config input,
        .xb-ebook-settings-body .xb-assistant-config select {
            width: 100%;
            border: 1px solid rgba(255, 255, 255, 0.10);
            border-radius: 12px;
            padding: 11px 12px;
            outline: none;
            background: rgba(0, 0, 0, 0.26);
            color: var(--xb-text-main);
        }
        .xb-ebook-settings-body .xb-assistant-inline-input,
        .xb-ebook-settings-body .xb-assistant-checkbox-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 8px;
            align-items: center;
        }
        .xb-ebook-settings-body .xb-assistant-grow { min-width: 0; }
        .xb-ebook-settings-body .xb-assistant-model-row { align-items: end; }
        .xb-ebook-settings-body .xb-assistant-checkbox-control {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            color: var(--xb-text-main);
        }
        .xb-ebook-settings-body .xb-assistant-checkbox-control input {
            width: 16px;
            height: 16px;
            accent-color: var(--xb-cyan);
        }
        .xb-ebook-settings-body .xb-assistant-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .xb-ebook-settings-body .xb-assistant-actions button {
            min-height: 38px;
            padding: 0 14px;
            border-radius: 999px;
        }
        .xb-assistant-save-button.is-success {
            background: rgba(34, 197, 94, 0.22);
            color: #bbf7d0;
            border-color: rgba(34, 197, 94, 0.34);
        }
        .xb-assistant-save-button.is-error {
            background: rgba(244, 63, 94, 0.18);
            color: #fecdd3;
            border-color: rgba(244, 63, 94, 0.36);
        }
        .xb-assistant-save-spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            margin-right: 6px;
            border: 2px solid rgba(255, 255, 255, 0.32);
            border-top-color: currentColor;
            border-radius: 50%;
            vertical-align: -2px;
            animation: xb-spin 0.8s linear infinite;
        }
        @keyframes xb-spin { to { transform: rotate(360deg); } }

        /* Reader */
        .xb-reader-screen {
            background: #151311;
            color: var(--xb-text-body);
        }
        .xb-reader-backlight {
            position: fixed;
            top: -20vh;
            left: 8vw;
            width: 84vw;
            height: 62vh;
            pointer-events: none;
            background: radial-gradient(ellipse, rgba(233, 231, 227, 0.022), transparent 62%);
            filter: blur(84px);
            animation: xb-reader-pulse 10s infinite alternate ease-in-out;
        }
        @keyframes xb-reader-pulse {
            0% { opacity: 0.55; transform: scale(0.92); }
            100% { opacity: 1; transform: scale(1.08); }
        }
        .xb-reader-edge {
            position: fixed;
            top: 0;
            left: 0;
            z-index: 20;
            width: 62px;
            height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: space-between;
            padding: 38px 0;
            border-right: 1px solid rgba(255, 255, 255, 0.025);
            background: rgba(9, 8, 7, 0.55);
            backdrop-filter: blur(8px);
        }
        .xb-reader-edge-actions {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px;
        }
        .xb-reader-edge-button {
            width: 44px;
            height: 44px;
            padding: 0;
            border: 0;
            background: transparent;
            color: var(--xb-text-muted);
            font-size: 20px;
        }
        .xb-reader-theme-toggle {
            width: auto;
            min-width: 44px;
            height: 32px;
            padding: 0 10px;
            border: 1px solid var(--xb-line);
            border-radius: 999px;
            background: var(--xb-bg-glass);
            color: var(--xb-text-main);
            font-size: 12px;
            font-weight: 700;
        }
        .xb-reader-edge-button:hover:not(:disabled) {
            color: var(--xb-text-main);
            box-shadow: none;
            background: transparent;
        }
        .xb-reader-theme-toggle:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.07);
        }
        .xb-reader-progress {
            position: relative;
            width: 2px;
            height: 112px;
            overflow: hidden;
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.07);
        }
        .xb-reader-progress span {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: var(--xb-reader-progress, 0%);
            border-radius: inherit;
            background: var(--xb-text-main);
        }
        .xb-reader-main {
            position: relative;
            z-index: 2;
            height: 100vh;
            margin-left: 62px;
            display: grid;
            grid-template-columns: 320px minmax(0, 1fr);
            overflow: hidden;
        }
        .xb-reader-nav {
            min-width: 0;
            min-height: 0;
            overflow: auto;
            padding: 56px 34px;
            border-right: 1px solid rgba(233, 231, 227, 0.10);
            background: rgba(15, 14, 12, 0.62);
            backdrop-filter: blur(18px);
            box-shadow: 20px 0 48px rgba(0, 0, 0, 0.26);
        }
        .xb-reader-index-title {
            margin-bottom: 34px;
            padding-bottom: 18px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.055);
            color: var(--xb-text-muted);
            font-family: var(--xb-font-mono);
            font-size: 12px;
            letter-spacing: 0.22em;
            text-transform: uppercase;
        }
        .xb-reader-chapters {
            display: grid;
            gap: 14px;
        }
        .xb-reader-chapter {
            position: relative;
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            align-items: center;
            gap: 12px;
            padding: 4px 0 4px 16px;
            border: 0;
            border-radius: 0;
            background: transparent;
            color: var(--xb-text-muted);
            text-align: left;
            font-family: var(--xb-font-serif);
            font-size: 15px;
        }
        .xb-reader-chapter::before {
            content: "";
            position: absolute;
            left: 0;
            top: 50%;
            width: 5px;
            height: 5px;
            border-radius: 999px;
            background: var(--xb-text-main);
            opacity: 0;
            transform: translateY(-50%);
        }
        .xb-reader-chapter:hover:not(:disabled) {
            color: var(--xb-text-body);
            transform: translateX(4px);
            background: transparent;
            box-shadow: none;
        }
        .xb-reader-chapter.is-active {
            color: var(--xb-text-main);
            transform: translateX(8px);
        }
        .xb-reader-chapter.is-active::before { opacity: 1; }
        .xb-reader-chapter small {
            color: inherit;
            font-family: var(--xb-font-mono);
            font-size: 11px;
            opacity: 0.65;
        }
        .xb-reader-paper {
            min-width: 0;
            min-height: 0;
            overflow: auto;
            padding: 11vh max(40px, calc((100% - 760px) / 2)) 18vh;
            background: transparent;
        }
        .xb-reader-head {
            margin-bottom: 72px;
            text-align: center;
        }
        .xb-reader-head h2 {
            margin: 14px 0 12px;
            color: var(--xb-text-main);
            font-family: var(--xb-font-serif);
            font-size: clamp(34px, 5vw, 54px);
            font-weight: 400;
            line-height: 1.15;
        }
        .xb-reader-head p {
            color: var(--xb-text-muted);
            font-family: var(--xb-font-mono);
            font-size: 12px;
            letter-spacing: 0.16em;
            text-transform: uppercase;
        }
        .xb-reader-content {
            max-width: 720px;
            margin: 0 auto;
        }
        .xb-reader-content p {
            margin: 0 0 2rem;
            color: var(--xb-text-body);
            font: 20px/2.05 var(--xb-font-serif);
            text-align: justify;
            white-space: pre-wrap;
        }
        .xb-reader-content p.xb-reader-drop::first-letter {
            float: left;
            padding-top: 5px;
            padding-right: 12px;
            color: var(--xb-text-main);
            font-size: 4.3rem;
            line-height: 0.82;
        }
        .xb-reader-foot {
            max-width: 720px;
            margin: 60px auto 0;
            padding-top: 24px;
            border-top: 1px solid rgba(233, 231, 227, 0.14);
            display: flex;
            justify-content: space-between;
            gap: 12px;
        }
        .xb-reader-foot button,
        .xb-reader-empty button {
            min-height: 40px;
            padding: 0 18px;
            border-radius: 999px;
            color: var(--xb-text-main);
        }
        .xb-reader-empty {
            min-height: 100%;
            display: grid;
            place-content: center;
            justify-items: center;
            gap: 14px;
            color: var(--xb-text-muted);
            text-align: center;
        }
        .xb-reader-empty h2 {
            color: var(--xb-text-main);
            font-family: var(--xb-font-serif);
            font-size: 42px;
            font-weight: 400;
        }

        /* Light theme */
        /* Dark clarity pass */
        .theme-dark .xb-ambient-aurora,
        .theme-dark .xb-agent-aurora,
        .theme-dark .xb-reader-backlight {
            display: none;
        }
        .theme-dark .xb-library-book,
        .theme-dark .xb-agent,
        .theme-dark .xb-reader-nav {
            box-shadow: none;
        }
        .theme-dark .xb-workspace-controller,
        .theme-dark .xb-reader-edge,
        .theme-dark .xb-reader-nav,
        .theme-dark .xb-topbar {
            backdrop-filter: none;
        }
        .theme-dark .xb-sidebar {
            background: #171922;
            border-right-color: rgba(235, 231, 221, 0.08);
        }
        .theme-dark .xb-studio-workbench,
        .theme-dark .xb-editor {
            background: #1c1f2a;
        }
        .theme-dark .xb-agent {
            background: #20232d;
            border-left-color: rgba(235, 231, 221, 0.09);
        }
        .theme-dark.xb-studio-shell.focus-editor .xb-agent {
            opacity: 1;
        }
        .theme-dark.xb-studio-shell.focus-agent .xb-editor {
            filter: none;
        }
        .theme-dark.xb-studio-shell.focus-agent .xb-agent {
            box-shadow: none;
        }
        .theme-dark .xb-workspace-controller {
            background: #222631;
            border-color: rgba(235, 231, 221, 0.12);
            box-shadow: none;
        }
        .theme-dark .xb-editor-head {
            background: #1c1f2a;
            border-bottom: 1px solid rgba(235, 231, 221, 0.08);
        }
        .theme-dark .xb-agent-head,
        .theme-dark .xb-agent-form,
        .theme-dark .xb-agent-memory,
        .theme-dark .xb-reader-nav,
        .theme-dark .xb-reader-foot {
            border-color: rgba(235, 231, 221, 0.09);
        }
        .theme-dark .xb-agent-form {
            background: #20232d;
        }
        .theme-dark .xb-agent-compose-row,
        .theme-dark .xb-actions-panel,
        .theme-dark .xb-msg,
        .theme-dark .xb-msg-user,
        .theme-dark .xb-actions button,
        .theme-dark .xb-markdown-html-block,
        .theme-dark .xb-msg-editor,
        .theme-dark .xb-thought-block,
        .theme-dark .xb-tool-preface,
        .theme-dark .xb-tool {
            border-color: rgba(235, 231, 221, 0.11);
            background: #282c38;
            color: var(--xb-text-main);
        }
        .theme-dark .xb-tool-payload {
            border-top-color: rgba(235, 231, 221, 0.10);
        }
        .theme-dark .xb-agent-compose-row:focus-within {
            border-color: rgba(143, 180, 189, 0.40);
            background: #2b3040;
            box-shadow: none;
        }
        .theme-dark .xb-msg-assistant {
            border-left-color: var(--xb-indigo);
            background: #272b38;
        }
        .theme-dark .xb-msg-user {
            background: #303342;
        }
        .theme-dark .xb-assistant-markdown pre,
        .theme-dark .xb-markdown-html-code {
            border-color: rgba(235, 231, 221, 0.10);
            background: #191c25;
            color: var(--xb-text-body);
        }
        .theme-dark .xb-assistant-markdown code {
            background: rgba(255, 255, 255, 0.075);
            color: #e0dacd;
        }
        .theme-dark .xb-file.is-active {
            border-color: rgba(235, 231, 221, 0.12);
            background: #242834;
        }
        .theme-dark .xb-library-book,
        .theme-dark .xb-entry-action {
            border-color: rgba(235, 231, 221, 0.08);
            background: #242834;
        }
        .theme-dark .xb-library-book:hover:not(:disabled) {
            border-color: rgba(235, 231, 221, 0.16);
            box-shadow: none;
        }
        .theme-dark .xb-entry-action strong,
        .theme-dark .xb-portal-theme {
            color: var(--xb-text-main);
        }
        .theme-dark .xb-entry-action.is-studio:hover,
        .theme-dark .xb-entry-action.is-reader:hover {
            background: #2b3040;
        }
        .theme-dark .xb-entry-action:hover strong {
            transform: none;
        }
        .theme-dark .xb-portal-close,
        .theme-dark .xb-portal-theme {
            color: var(--xb-text-muted);
        }
        .theme-dark .xb-reader-screen,
        .theme-dark.xb-reader-screen {
            background: #171922;
        }
        .theme-dark .xb-reader-edge,
        .theme-dark .xb-reader-nav {
            background: #1c1f2a;
        }
        .theme-dark .xb-reader-paper {
            background: transparent;
        }

        .theme-light .xb-archive-header,
        .theme-light .xb-shelf-container,
        .theme-light .xb-entry-portal,
        .theme-light .xb-studio-workbench,
        .theme-light .xb-editor,
        .theme-light .xb-agent,
        .theme-light .xb-reader-screen,
        .xb-reader-screen.theme-light {
            background: var(--xb-bg-deep);
            color: var(--xb-text-main);
        }
        .theme-light .xb-sidebar {
            border-right-color: rgba(87, 70, 48, 0.12);
            background: #fff3df;
        }
        .theme-light .xb-icon-button,
        .theme-light .xb-glass-button,
        .theme-light .xb-home-actions button,
        .theme-light #xb-close {
            border-color: var(--xb-line);
            background: rgba(255, 253, 248, 0.82);
            color: var(--xb-text-main);
        }
        .theme-light .xb-workspace-controller {
            border-color: var(--xb-line);
            background: rgba(255, 253, 248, 0.86);
            box-shadow: 0 8px 22px rgba(87, 70, 48, 0.08);
        }
        .theme-light .xb-layout-button.is-active {
            background: rgba(87, 70, 48, 0.10);
        }
        .theme-light .xb-file.is-active,
        .theme-light .xb-library-empty,
        .theme-light .xb-section-empty,
        .theme-light .xb-actions-panel,
        .theme-light .xb-delete-book-item {
            border-color: var(--xb-line);
            background: rgba(255, 253, 248, 0.78);
        }
        .theme-light .xb-library-book {
            border-color: rgba(87, 70, 48, 0.12);
            background: #fffdf8;
            box-shadow: 0 18px 38px rgba(87, 70, 48, 0.10);
        }
        .theme-light .xb-library-book:hover:not(:disabled) {
            border-color: rgba(87, 70, 48, 0.20);
            box-shadow: 0 24px 46px rgba(87, 70, 48, 0.13);
        }
        .theme-light .xb-entry-action {
            border-color: rgba(87, 70, 48, 0.12);
            background: #fffdf8;
        }
        .theme-light .xb-entry-action:hover:not(:disabled) {
            background: #f7fbfa;
        }
        .theme-light .xb-portal-close,
        .theme-light .xb-portal-theme {
            border-color: var(--xb-line);
            background: rgba(255, 253, 248, 0.84);
            color: var(--xb-text-main);
        }
        .theme-light .xb-editor {
            background: #fffdf8;
            border-right-color: rgba(87, 70, 48, 0.10);
        }
        .theme-light .xb-agent {
            background: #fff8ec;
            border-left-color: rgba(87, 70, 48, 0.11);
            box-shadow: -12px 0 30px rgba(87, 70, 48, 0.08);
        }
        .theme-light.xb-studio-shell.focus-agent .xb-agent {
            box-shadow: -18px 0 42px rgba(87, 70, 48, 0.12);
        }
        .theme-light .xb-editor-head {
            background: linear-gradient(180deg, rgba(255, 253, 248, 0.96), rgba(255, 253, 248, 0.78), transparent);
        }
        .theme-light .xb-agent-head,
        .theme-light .xb-agent-memory,
        .theme-light .xb-agent-form,
        .theme-light .xb-reader-nav,
        .theme-light .xb-reader-foot,
        .theme-light .xb-ebook-settings-head,
        .theme-light .xb-ebook-delete-head,
        .theme-light .xb-ebook-delete-note {
            border-color: var(--xb-line);
        }
        .theme-light .xb-agent-form {
            background: linear-gradient(0deg, var(--xb-bg-agent) 74%, transparent);
        }
        .theme-light .xb-agent-compose-row,
        .theme-light .xb-msg,
        .theme-light .xb-msg-user,
        .theme-light .xb-actions button,
        .theme-light .xb-markdown-html-block,
        .theme-light .xb-msg-editor,
        .theme-light .xb-thought-block,
        .theme-light .xb-tool-preface,
        .theme-light .xb-tool {
            border-color: var(--xb-line);
            background: #fffdf8;
            color: var(--xb-text-main);
        }
        .theme-light .xb-tool-payload {
            border-top-color: rgba(87, 70, 48, 0.12);
        }
        .theme-light .xb-agent-compose-row:focus-within {
            border-color: rgba(61, 124, 131, 0.42);
            background: #fffdf8;
            box-shadow: 0 0 0 3px rgba(61, 124, 131, 0.10);
        }
        .theme-light .xb-msg-assistant {
            border-left-color: var(--xb-indigo);
        }
        .theme-light .xb-msg.is-error {
            border-color: rgba(182, 77, 93, 0.35);
            color: #8d2338;
            background: #fff5f6;
        }
        .theme-light .xb-assistant-markdown code {
            background: rgba(87, 70, 48, 0.08);
            color: #352d24;
        }
        .theme-light .xb-assistant-markdown pre,
        .theme-light .xb-markdown-html-code {
            border-color: var(--xb-line);
            background: #f8f2e8;
            color: var(--xb-text-main);
        }
        .theme-light .xb-assistant-markdown blockquote {
            border-left-color: rgba(61, 124, 131, 0.28);
            color: var(--xb-text-muted);
        }
        .theme-light .xb-assistant-markdown th,
        .theme-light .xb-assistant-markdown td,
        .theme-light .xb-markdown-html-preview {
            border-color: var(--xb-line);
        }
        .theme-light .xb-assistant-markdown th {
            background: rgba(87, 70, 48, 0.06);
        }
        .theme-light .xb-ebook-settings-overlay,
        .theme-light .xb-ebook-delete-overlay {
            background: rgba(255, 250, 240, 0.78);
        }
        .theme-light .xb-ebook-settings-dialog,
        .theme-light .xb-ebook-delete-dialog {
            border-color: var(--xb-line);
            background: rgba(255, 253, 248, 0.98);
        }
        .theme-light .xb-ebook-settings-body .xb-assistant-config-tabs {
            background: rgba(87, 70, 48, 0.06);
        }
        .theme-light .xb-ebook-settings-body .xb-assistant-config-tab.is-active {
            background: #fffdf8;
            box-shadow: 0 1px 6px rgba(87, 70, 48, 0.08);
        }
        .theme-light .xb-ebook-settings-body .xb-assistant-config input,
        .theme-light .xb-ebook-settings-body .xb-assistant-config select {
            border-color: var(--xb-line);
            background: #fffdf8;
            color: var(--xb-text-main);
        }
        .theme-light .xb-ebook-settings-body .xb-assistant-inline-status.is-success,
        .theme-light .xb-assistant-save-button.is-success {
            color: #176b35;
        }
        .theme-light .xb-ebook-settings-body .xb-assistant-inline-status.is-error,
        .theme-light .xb-assistant-save-button.is-error {
            color: #9f233d;
        }
        .theme-light .xb-reader-edge {
            border-right-color: rgba(87, 70, 48, 0.12);
            background: rgba(255, 253, 248, 0.84);
        }
        .theme-light .xb-reader-nav {
            background: rgba(255, 248, 236, 0.76);
            box-shadow: 20px 0 42px rgba(87, 70, 48, 0.08);
        }
        .theme-light .xb-reader-progress {
            background: rgba(87, 70, 48, 0.14);
        }
        .theme-light .xb-reader-chapter:hover:not(:disabled) {
            color: var(--xb-text-main);
        }
        .theme-light .xb-reader-paper {
            background: transparent;
        }

        /* Legacy shell pieces still used by tests or fallback markup */
        .xb-topbar {
            height: 88px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 18px;
            padding: 20px 28px;
            border-bottom: 1px solid var(--xb-line);
            background: rgba(5, 5, 7, 0.82);
            backdrop-filter: blur(18px);
        }
        .xb-topbar h1 {
            color: var(--xb-text-main);
            font-family: var(--xb-font-serif);
            font-size: 28px;
            font-weight: 400;
        }
        .xb-topbar p {
            margin-top: 6px;
            color: var(--xb-text-muted);
            font-size: 13px;
        }
        .xb-library-main,
        .xb-entry-main {
            height: calc(100% - 88px);
            overflow: auto;
            padding: 28px;
        }
        .xb-back-link {
            padding: 8px 12px;
            border-radius: 999px;
            color: var(--xb-text-muted);
        }
        .xb-book-cover { display: none; }

        @media (max-width: 980px) {
            .xb-archive-header {
                height: 132px;
                align-items: flex-start;
                flex-direction: column;
                padding: 34px 24px 16px;
            }
            .xb-global-actions { justify-content: flex-start; }
            .xb-shelf-container {
                height: calc(100vh - 132px);
                padding: 10px 24px 92px;
            }
            .xb-library-grid {
                grid-template-columns: 1fr;
                gap: 16px;
            }
            .xb-library-book {
                min-height: 170px;
                aspect-ratio: auto;
                border-radius: 16px;
                padding: 22px;
            }
            .xb-entry-actions {
                flex-direction: column;
            }
            .xb-entry-action {
                min-height: 50vh;
                border-right: 0;
                border-top: 1px solid rgba(255, 255, 255, 0.045);
            }
            .xb-entry-action strong { font-size: 48px; }
            .xb-portal-theme {
                top: 22px;
                right: 24px;
            }
            .xb-ebook-shell {
                display: grid;
                grid-template-rows: minmax(178px, 28vh) minmax(0, 1fr);
                overflow: hidden;
            }
            .xb-sidebar {
                position: relative;
                left: auto;
                top: auto;
                bottom: auto;
                width: 100%;
                min-height: 0;
                transform: none;
                flex: none;
                padding: 16px 18px;
                border-right: 0;
                border-bottom: 1px solid rgba(255, 255, 255, 0.04);
                overflow: hidden;
            }
            .xb-sidebar .xb-title-row h1 {
                font-size: 20px;
            }
            .xb-files {
                grid-auto-flow: column;
                grid-auto-columns: minmax(190px, 240px);
                grid-template-rows: 1fr;
                overflow-x: auto;
                overflow-y: hidden;
            }
            .xb-file-group {
                min-width: 0;
            }
            .xb-studio-workbench {
                width: 200vw;
                height: 100%;
                display: flex;
                transition: transform 0.5s var(--xb-fluid);
            }
            .xb-studio-shell.focus-agent .xb-studio-workbench {
                transform: translateX(-50%);
            }
            .xb-editor,
            .xb-agent,
            .xb-studio-shell.focus-editor .xb-editor,
            .xb-studio-shell.focus-editor .xb-agent,
            .xb-studio-shell.focus-agent .xb-editor,
            .xb-studio-shell.focus-agent .xb-agent {
                width: 100vw;
                min-width: 100vw;
                flex: 0 0 100vw;
                opacity: 1;
                filter: none;
            }
            .xb-studio-shell.balanced .xb-studio-workbench,
            .xb-studio-shell.focus-editor .xb-studio-workbench {
                transform: translateX(0);
            }
            .xb-editor-head {
                padding: 18px 20px 12px;
                align-items: flex-start;
                flex-direction: column;
            }
            .xb-editor-body {
                padding: 10px 22px 22px;
            }
            #xb-editor-text {
                font-size: 16px;
            }
            .xb-agent-head {
                padding: 18px 20px 14px;
            }
            .xb-agent-main {
                padding: 20px 20px 118px;
            }
            .xb-actions {
                grid-template-columns: 1fr 1fr;
            }
            .xb-agent-form {
                position: absolute;
                left: 0;
                right: 0;
                bottom: 0;
                padding: 14px 20px 22px;
            }
            .xb-reader-edge {
                top: auto;
                bottom: 0;
                width: 100%;
                height: 78px;
                flex-direction: row;
                padding: 10px 24px 18px;
                border-right: 0;
                border-top: 1px solid rgba(255, 255, 255, 0.05);
            }
            .xb-reader-edge-actions {
                flex-direction: row;
                gap: 12px;
            }
            .xb-reader-progress {
                position: absolute;
                top: -1px;
                left: 0;
                width: 100%;
                height: 2px;
            }
            .xb-reader-progress span {
                width: var(--xb-reader-progress, 0%);
                height: 100% !important;
                right: auto;
            }
            .xb-reader-main {
                margin-left: 0;
                grid-template-columns: 1fr;
            }
            .xb-reader-nav {
                display: none;
            }
            .xb-reader-paper {
                padding: 72px 24px 120px;
            }
            .xb-reader-head {
                margin-bottom: 42px;
            }
            .xb-reader-content p {
                font-size: 18px;
                line-height: 1.95;
            }
        }

        @media (max-width: 560px) {
            .xb-archive-header h1 { font-size: 32px; }
            .xb-archive-meta { font-size: 10px; }
            .xb-glass-button,
            .xb-home-actions button,
            #xb-close {
                min-height: 36px;
                padding: 0 12px;
            }
            .xb-global-actions {
                width: 100%;
                display: grid;
                grid-template-columns: 1fr 1fr 1fr;
            }
            .xb-global-actions button {
                width: 100%;
            }
            .xb-library-book strong { font-size: 22px; }
            .xb-entry-action span {
                max-width: 280px;
                font-size: 11px;
            }
            .xb-editor-actions,
            .xb-agent-toolbar {
                width: 100%;
                justify-content: flex-start;
            }
            #xb-agent-close { margin-left: 0; }
            .xb-msg {
                max-width: 100%;
            }
            .xb-msg.is-editing {
                width: 100%;
                max-width: 100%;
            }
            .xb-ebook-settings-overlay {
                padding: 12px;
            }
            .xb-ebook-settings-dialog {
                max-height: calc(100vh - 24px);
                border-radius: 16px;
            }
        }
    `;
    document.head.appendChild(style);
}
