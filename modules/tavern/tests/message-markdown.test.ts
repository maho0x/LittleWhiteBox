import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HTML_PREVIEW_SANDBOX, renderMarkdownToHtml } from '../../agent-core/ui/message-markdown.js';

function withParentDomPurify(
    sanitize: (html: string, config: Record<string, unknown>) => string,
    run: () => void,
) {
    const host = globalThis as Record<string, unknown>;
    const previousParent = host.parent;
    host.parent = {
        DOMPurify: { sanitize },
    };
    try {
        run();
    } finally {
        if (previousParent === undefined) {
            delete host.parent;
        } else {
            host.parent = previousParent;
        }
    }
}

test('tavern markdown renders emphasis from the bundled parser without global libraries', () => {
    const html = renderMarkdownToHtml('*文字*');

    assert.match(html, /<em>文字<\/em>/);
});

test('tavern markdown lets ordinary message HTML reach the ST message sanitizer', () => {
    const calls: Array<{ html: string; config: Record<string, unknown> }> = [];

    withParentDomPurify((html, config) => {
        calls.push({ html, config });
        return html.replace(/<script[\s\S]*?<\/script>/gi, '');
    }, () => {
        const html = renderMarkdownToHtml([
            '<details><summary>abc</summary>',
            '<div class="panel"><span>$1 内容</span></div>',
            '<table><tbody><tr><td>Seraphina</td></tr></tbody></table>',
            '<script>alert(1)</script>',
            '</details>',
            '',
            '正文在折叠后',
        ].join('\n'));

        assert.match(html, /<details><summary>abc<\/summary>/);
        assert.match(html, /<div class="panel"><span>\$1 内容<\/span><\/div>/);
        assert.match(html, /<table><tbody><tr><td>Seraphina<\/td><\/tr><\/tbody><\/table>/);
        assert.match(html, /正文在折叠后/);
        assert.doesNotMatch(html, /<script/i);
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].config.MESSAGE_SANITIZE, true);
    assert.deepEqual(calls[0].config.ADD_TAGS, ['custom-style']);
});

test('tavern markdown keeps guidance details boundaries around markdown content', () => {
    const html = renderMarkdownToHtml([
        '<details><summary><div>状态</div></summary><div>',
        '## 指引标题',
        '',
        '- 第一条',
        '- 第二条',
        '</div></details>',
        '',
        '正文在折叠后',
    ].join('\n'));

    assert.match(html, /<details><summary><div>状态<\/div><\/summary><div>/);
    assert.match(html, /<h2 id="">指引标题<\/h2>/);
    assert.match(html, /<ul>\s*<li>第一条<\/li>\s*<li>第二条<\/li>\s*<\/ul>\s*<\/div><\/details>/);
    assert.match(html, /<\/details>\s*<p>正文在折叠后<\/p>/);
    assert.doesNotMatch(html, /<\/details>\s*<\/li>/);
    assert.doesNotMatch(html, /<\/details>\s*<\/p>/);
});

test('tavern markdown protects nested inline HTML structure lines without breaking markdown ownership', () => {
    const html = renderMarkdownToHtml([
        '<details>',
        '  <summary>',
        '    <span class="guide-title">状态</span>',
        '  </summary>',
        '  <div>',
        '## 指引标题',
        '',
        '- 第一条',
        '- 第二条',
        '  </div>',
        '</details>',
        '',
        '正文在折叠后',
    ].join('\n'));

    assert.match(html, /<details>\s*<summary>\s*<span class="custom-guide-title">状态<\/span>\s*<\/summary>\s*<div>/);
    assert.match(html, /<h2 id="">指引标题<\/h2>/);
    assert.match(html, /<ul>\s*<li>第一条<\/li>\s*<li>第二条<\/li>\s*<\/ul>\s*<\/div>\s*<\/details>/);
    assert.match(html, /<\/details>\s*<p>正文在折叠后<\/p>/);
    assert.doesNotMatch(html, /<\/details>\s*<\/li>/);
    assert.doesNotMatch(html, /<\/summary>\s*<\/p>/);
});

test('tavern markdown protects generic HTML container boundaries around markdown lists', () => {
    const html = renderMarkdownToHtml([
        '<section class="panel"><div>',
        '### 面板标题',
        '',
        '1. 第一项',
        '2. 第二项',
        '</div></section>',
        '',
        '外部正文',
    ].join('\n'));

    assert.match(html, /<section class="custom-panel"><div>/);
    assert.match(html, /<h3 id="">面板标题<\/h3>/);
    assert.match(html, /<ol>\s*<li>第一项<\/li>\s*<li>第二项<\/li>\s*<\/ol>\s*<\/div><\/section>/);
    assert.match(html, /<\/section>\s*<p>外部正文<\/p>/);
    assert.doesNotMatch(html, /<\/section>\s*<\/li>/);
    assert.doesNotMatch(html, /<\/section>\s*<\/p>/);
});

test('tavern markdown sanitizes ordinary chat HTML without disabling html code block previews', () => {
    const html = renderMarkdownToHtml([
        '<script>alert(1)</script>',
        '[bad](javascript:alert(2))',
        '<details ontoggle=alert(3) open><summary onclick=alert(4)>abc</summary>正文</details>',
    ].join('\n'));

    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.match(html, /<details open><summary>abc<\/summary>/);
});

test('tavern markdown decodes style tags as scoped ST-style message CSS', () => {
    const html = renderMarkdownToHtml([
        '<style>.foo{color:red}</style>',
        '<span class="foo">红字</span>',
    ].join('\n'));

    assert.match(html, /<style>[\s\S]*\.xb-tavern-markdown \.custom-foo, \.xb-assistant-markdown \.custom-foo\{color:red\}[\s\S]*<\/style>/);
    assert.match(html, /<span class="custom-foo">红字<\/span>/);
    assert.doesNotMatch(html, /<p>\.foo\{color:red\}<\/p>/);
    assert.doesNotMatch(html, /<custom-style/i);
});

test('tavern markdown does not turn ordinary standalone HTML documents into iframe previews', () => {
    const html = renderMarkdownToHtml([
        '<!doctype html>',
        '<html><body><div>普通正文 HTML</div></body></html>',
    ].join('\n'));

    assert.doesNotMatch(html, /xb-markdown-html-placeholder/);
    assert.doesNotMatch(html, /@@XBHTMLBLOCK/);
    assert.match(html, /普通正文 HTML/);
});

test('tavern markdown only folds fenced html code into iframe preview placeholders', () => {
    const html = renderMarkdownToHtml([
        '```html',
        '<main><script>window.__preview = true</script></main>',
        '```',
    ].join('\n'));

    assert.match(html, /xb-markdown-html-placeholder/);
    assert.doesNotMatch(html, /<script/i);
    assert.equal(HTML_PREVIEW_SANDBOX, 'allow-scripts');
});
