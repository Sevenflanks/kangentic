/**
 * Unit tests for the pure helpers in src/main/ipc/handlers/browser-payload.ts.
 *
 * All functions are deterministic, have no I/O, and can be tested in Node
 * without Electron or a browser. The test runs in vitest against the compiled
 * TypeScript source via ts-node/esbuild transform.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPromptPayload,
  formatPickedElementXml,
  formatAncestors,
  formatStyles,
  isMeaningfulStyle,
  isTrivialWrapper,
  isValidSessionId,
  isCrossDrivePath,
  SELECTION_INLINE_LIMIT,
} from '../../src/main/ipc/handlers/browser-payload';
import { escapeXml } from '../../src/main/agent/shared';
import type { BrowserCaptureInput, BrowserPickedElement } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeElement(overrides: Partial<BrowserPickedElement> = {}): BrowserPickedElement {
  return {
    selector: 'button.primary',
    tagName: 'BUTTON',
    id: undefined,
    classes: [],
    testId: undefined,
    ariaLabel: undefined,
    role: 'button',
    accessibleName: 'Submit',
    text: 'Submit',
    rect: { x: 10, y: 20, width: 100, height: 40 },
    computedStyles: {},
    outerHTML: '<button class="primary">Submit</button>',
    ancestors: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<BrowserCaptureInput> = {}): BrowserCaptureInput {
  return {
    projectId: 'project-1',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    taskId: 'task-1',
    cwd: '/projects/myapp',
    url: 'https://example.com',
    pngBase64: 'abc123',
    pickedElement: null,
    selectedText: '',
    note: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// escapeXml
// ---------------------------------------------------------------------------

describe('escapeXml', () => {
  it('escapes ampersand', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quote', () => {
    expect(escapeXml('a "b" c')).toBe('a &quot;b&quot; c');
  });

  it('escapes all special chars in one string', () => {
    expect(escapeXml('<a href="x&y">z</a>')).toBe('&lt;a href=&quot;x&amp;y&quot;&gt;z&lt;/a&gt;');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// isMeaningfulStyle
// ---------------------------------------------------------------------------

describe('isMeaningfulStyle', () => {
  it('returns false for empty value', () => {
    expect(isMeaningfulStyle('color', '')).toBe(false);
  });

  it('returns false for STYLE_KEYS_TO_DROP: width', () => {
    expect(isMeaningfulStyle('width', '100px')).toBe(false);
  });

  it('returns false for STYLE_KEYS_TO_DROP: height', () => {
    expect(isMeaningfulStyle('height', '50px')).toBe(false);
  });

  it('returns false for STYLE_KEYS_TO_DROP: display', () => {
    expect(isMeaningfulStyle('display', 'block')).toBe(false);
  });

  it('returns false for STYLE_DEFAULT_DROPS: "none"', () => {
    expect(isMeaningfulStyle('outline', 'none')).toBe(false);
  });

  it('returns false for STYLE_DEFAULT_DROPS: "auto"', () => {
    expect(isMeaningfulStyle('overflow', 'auto')).toBe(false);
  });

  it('returns false for STYLE_DEFAULT_DROPS: "0px"', () => {
    expect(isMeaningfulStyle('margin', '0px')).toBe(false);
  });

  it('returns false for STYLE_DEFAULT_DROPS: "1"', () => {
    expect(isMeaningfulStyle('font-weight', '1')).toBe(false);
  });

  it('returns false for STYLE_DEFAULT_DROPS: "transparent"', () => {
    expect(isMeaningfulStyle('background', 'transparent')).toBe(false);
  });

  it('returns false for four-zero box shorthand', () => {
    expect(isMeaningfulStyle('padding', '0px 0px 0px 0px')).toBe(false);
  });

  it('returns false for border starting with 0px', () => {
    expect(isMeaningfulStyle('border', '0px solid red')).toBe(false);
  });

  it('returns false for border exactly "0px"', () => {
    expect(isMeaningfulStyle('border', '0px')).toBe(false);
  });

  it('returns false for opacity: 1', () => {
    expect(isMeaningfulStyle('opacity', '1')).toBe(false);
  });

  it('returns true for meaningful color', () => {
    expect(isMeaningfulStyle('color', 'rgb(255, 0, 0)')).toBe(true);
  });

  it('returns true for non-trivial font-size', () => {
    expect(isMeaningfulStyle('font-size', '16px')).toBe(true);
  });

  it('returns true for border with non-zero width', () => {
    expect(isMeaningfulStyle('border', '1px solid black')).toBe(true);
  });

  it('returns true for opacity other than 1', () => {
    expect(isMeaningfulStyle('opacity', '0.5')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatStyles
// ---------------------------------------------------------------------------

describe('formatStyles', () => {
  it('returns ["(defaults)"] when all styles are default', () => {
    expect(formatStyles({ width: '100px', height: '50px' })).toEqual(['(defaults)']);
  });

  it('returns ["(defaults)"] for empty object', () => {
    expect(formatStyles({})).toEqual(['(defaults)']);
  });

  it('returns meaningful styles formatted as "key: value"', () => {
    const result = formatStyles({ color: 'red', width: '100px' });
    expect(result).toEqual(['color: red']);
  });

  it('includes multiple meaningful styles', () => {
    const result = formatStyles({ color: 'red', 'font-size': '16px' });
    expect(result).toContain('color: red');
    expect(result).toContain('font-size: 16px');
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// formatAncestors
// ---------------------------------------------------------------------------

describe('formatAncestors', () => {
  it('returns "(none)" for empty ancestors array', () => {
    expect(formatAncestors([])).toBe('(none)');
  });

  it('formats a single ancestor with tag only', () => {
    expect(formatAncestors([
      { tagName: 'DIV', classes: [] },
    ])).toBe('div');
  });

  it('includes id when present', () => {
    expect(formatAncestors([
      { tagName: 'SECTION', id: 'main', classes: [] },
    ])).toBe('section#main');
  });

  it('includes testId when present', () => {
    expect(formatAncestors([
      { tagName: 'DIV', testId: 'my-container', classes: [] },
    ])).toBe('div[data-testid="my-container"]');
  });

  it('includes up to 3 classes', () => {
    expect(formatAncestors([
      { tagName: 'DIV', classes: ['a', 'b', 'c', 'd'] },
    ])).toBe('div.a.b.c');
  });

  it('includes role when present', () => {
    expect(formatAncestors([
      { tagName: 'NAV', classes: [], role: 'navigation' },
    ])).toBe('nav[role="navigation"]');
  });

  it('joins multiple ancestors with " > "', () => {
    const result = formatAncestors([
      { tagName: 'MAIN', classes: [] },
      { tagName: 'DIV', id: 'sidebar', classes: [] },
    ]);
    expect(result).toBe('main > div#sidebar');
  });
});

// ---------------------------------------------------------------------------
// isTrivialWrapper
// ---------------------------------------------------------------------------

describe('isTrivialWrapper', () => {
  it('returns true for <tag>text</tag>', () => {
    expect(isTrivialWrapper('<button>Submit</button>')).toBe(true);
  });

  it('returns true for self-closing with no inner content', () => {
    expect(isTrivialWrapper('<input />')).toBe(true);
  });

  it('returns false when inner HTML contains a child element', () => {
    expect(isTrivialWrapper('<div><span>hello</span></div>')).toBe(false);
  });

  it('returns false for nested elements regardless of depth', () => {
    expect(isTrivialWrapper('<div><a href="#"><strong>text</strong></a></div>')).toBe(false);
  });

  it('returns true for whitespace-only inner content', () => {
    expect(isTrivialWrapper('<p>   </p>')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatPickedElementXml
// ---------------------------------------------------------------------------

describe('formatPickedElementXml', () => {
  it('wraps output in <picked_element> tags', () => {
    const lines = formatPickedElementXml(makeElement());
    expect(lines[0]).toBe('<picked_element>');
    expect(lines[lines.length - 1]).toBe('</picked_element>');
  });

  it('always includes <selector>', () => {
    const lines = formatPickedElementXml(makeElement({ selector: 'div.foo' }));
    expect(lines.some((line) => line.includes('<selector>div.foo</selector>'))).toBe(true);
  });

  it('emits <testid> when testId is present', () => {
    const lines = formatPickedElementXml(makeElement({ testId: 'submit-btn' }));
    expect(lines.some((line) => line.includes('<testid>submit-btn</testid>'))).toBe(true);
  });

  it('omits <testid> when testId is absent', () => {
    const lines = formatPickedElementXml(makeElement({ testId: undefined }));
    expect(lines.some((line) => line.includes('<testid>'))).toBe(false);
  });

  it('omits <text> when text matches accessibleName', () => {
    // makeElement defaults: accessibleName='Submit', text='Submit' - they match
    const lines = formatPickedElementXml(makeElement());
    expect(lines.some((line) => line.includes('<text>'))).toBe(false);
  });

  it('emits <text> when it differs from accessibleName', () => {
    const lines = formatPickedElementXml(makeElement({
      accessibleName: 'Submit form',
      text: 'Submit',
    }));
    expect(lines.some((line) => line.includes('<text>Submit</text>'))).toBe(true);
  });

  it('omits <text> when text is empty', () => {
    const lines = formatPickedElementXml(makeElement({ text: '', accessibleName: '' }));
    expect(lines.some((line) => line.includes('<text>'))).toBe(false);
  });

  it('emits <styles /> self-closing when computedStyles are all defaults', () => {
    const lines = formatPickedElementXml(makeElement({ computedStyles: {} }));
    expect(lines.some((line) => line.trim() === '<styles />')).toBe(true);
  });

  it('emits <styles> block when meaningful styles are present', () => {
    const lines = formatPickedElementXml(makeElement({
      computedStyles: { color: 'red' },
    }));
    expect(lines.some((line) => line.includes('<styles>'))).toBe(true);
    expect(lines.some((line) => line.includes('color: red'))).toBe(true);
  });

  it('emits <outer_html> when outerHTML has nested elements', () => {
    const lines = formatPickedElementXml(makeElement({
      outerHTML: '<div><span>nested</span></div>',
    }));
    expect(lines.some((line) => line.includes('<outer_html>'))).toBe(true);
  });

  it('omits <outer_html> when outerHTML is a trivial wrapper', () => {
    const lines = formatPickedElementXml(makeElement({
      outerHTML: '<button>Submit</button>',
    }));
    expect(lines.some((line) => line.includes('<outer_html>'))).toBe(false);
  });

  it('omits <ancestors> block when ancestors array is empty', () => {
    const lines = formatPickedElementXml(makeElement({ ancestors: [] }));
    expect(lines.some((line) => line.includes('<ancestors>'))).toBe(false);
  });

  it('emits <ancestors> when ancestors are present', () => {
    const lines = formatPickedElementXml(makeElement({
      ancestors: [{ tagName: 'DIV', classes: [] }],
    }));
    expect(lines.some((line) => line.includes('<ancestors>'))).toBe(true);
  });

  it('escapes XML special chars in selector', () => {
    const lines = formatPickedElementXml(makeElement({
      selector: 'div[data-name="a&b"]',
    }));
    const selectorLine = lines.find((line) => line.includes('<selector>'));
    expect(selectorLine).toContain('&amp;');
    expect(selectorLine).toContain('&quot;');
  });
});

// ---------------------------------------------------------------------------
// buildPromptPayload
// ---------------------------------------------------------------------------

describe('buildPromptPayload', () => {
  it('uses default copy when note is empty', () => {
    const result = buildPromptPayload(makeInput({ note: '' }), 'relative/path.png');
    expect(result).toContain('Look at this browser capture and tell me what you see.');
  });

  it('uses custom note when provided', () => {
    const result = buildPromptPayload(makeInput({ note: 'Check the button styles.' }), 'path.png');
    expect(result).toContain('Check the button styles.');
    expect(result).not.toContain('Look at this browser capture');
  });

  it('trims whitespace from note before using it', () => {
    const result = buildPromptPayload(makeInput({ note: '  Is this correct?  ' }), 'path.png');
    expect(result).toContain('Is this correct?');
    expect(result).not.toContain('Look at this browser capture');
  });

  it('includes @-mention to the relative PNG path', () => {
    const result = buildPromptPayload(makeInput(), 'captures/capture-123.png');
    expect(result).toContain('Screenshot: @captures/capture-123.png');
  });

  it('converts backslash separators to forward slashes in PNG path', () => {
    // On Windows, relativePngPath may contain backslashes. The function must
    // POSIX-ify them so the @-mention works on all platforms.
    const windowsPath = '.kangentic\\sessions\\abc\\captures\\capture-1.png';
    const result = buildPromptPayload(makeInput(), windowsPath);
    expect(result).toContain('Screenshot: @.kangentic/sessions/abc/captures/capture-1.png');
    expect(result).not.toContain('\\');
  });

  it('wraps output in <browser_context> block', () => {
    const result = buildPromptPayload(makeInput(), 'path.png');
    expect(result).toContain('<browser_context>');
    expect(result).toContain('</browser_context>');
  });

  it('includes <url> inside browser_context', () => {
    const result = buildPromptPayload(makeInput({ url: 'https://example.com/page' }), 'p.png');
    expect(result).toContain('<url>https://example.com/page</url>');
  });

  it('omits <selected_text> when selectedText is empty', () => {
    const result = buildPromptPayload(makeInput({ selectedText: '' }), 'p.png');
    expect(result).not.toContain('<selected_text>');
  });

  it('includes inline <selected_text> when within SELECTION_INLINE_LIMIT', () => {
    const selection = 'a'.repeat(SELECTION_INLINE_LIMIT);
    const result = buildPromptPayload(makeInput({ selectedText: selection }), 'p.png');
    expect(result).toContain('<selected_text>');
    expect(result).not.toContain('truncated="true"');
  });

  it('truncates <selected_text> with truncated="true" when over limit', () => {
    const selection = 'x'.repeat(SELECTION_INLINE_LIMIT + 1);
    const result = buildPromptPayload(makeInput({ selectedText: selection }), 'p.png');
    expect(result).toContain('<selected_text truncated="true">');
    expect(result).toContain('...');
    // Content should be exactly SELECTION_INLINE_LIMIT chars from the original
    const expectedTruncated = 'x'.repeat(SELECTION_INLINE_LIMIT);
    expect(result).toContain(expectedTruncated);
  });

  it('omits picked_element block when pickedElement is null', () => {
    const result = buildPromptPayload(makeInput({ pickedElement: null }), 'p.png');
    expect(result).not.toContain('<picked_element>');
  });

  it('includes picked_element block when pickedElement is provided', () => {
    const result = buildPromptPayload(makeInput({ pickedElement: makeElement() }), 'p.png');
    expect(result).toContain('<picked_element>');
    expect(result).toContain('</picked_element>');
  });
});

// ---------------------------------------------------------------------------
// isValidSessionId
// ---------------------------------------------------------------------------

describe('isValidSessionId', () => {
  it('accepts a well-formed UUID v4', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('accepts uppercase UUID', () => {
    expect(isValidSessionId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('accepts mixed-case UUID', () => {
    expect(isValidSessionId('aaaaaaaa-BBBB-cccc-DDDD-eeeeeeeeeeee')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidSessionId('')).toBe(false);
  });

  it('rejects path traversal attempt', () => {
    expect(isValidSessionId('../../../etc/passwd')).toBe(false);
  });

  it('rejects UUID with too few segments', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716')).toBe(false);
  });

  it('rejects UUID with wrong segment lengths', () => {
    expect(isValidSessionId('550e84-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('rejects non-hex characters in UUID', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716-44665544000g')).toBe(false);
  });

  it('rejects a plain string', () => {
    expect(isValidSessionId('not-a-uuid')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCrossDrivePath
// ---------------------------------------------------------------------------

describe('isCrossDrivePath', () => {
  it('returns true for Windows absolute path with drive letter and backslash', () => {
    expect(isCrossDrivePath('D:\\some\\path')).toBe(true);
  });

  it('returns true for Windows absolute path with drive letter and forward slash', () => {
    expect(isCrossDrivePath('D:/some/path')).toBe(true);
  });

  it('returns true for uppercase drive letter', () => {
    expect(isCrossDrivePath('C:\\Users\\dev\\file.png')).toBe(true);
  });

  it('returns false for a relative path starting with ..', () => {
    expect(isCrossDrivePath('../captures/file.png')).toBe(false);
  });

  it('returns false for a POSIX absolute path', () => {
    expect(isCrossDrivePath('/home/dev/captures/file.png')).toBe(false);
  });

  it('returns false for a plain relative path', () => {
    expect(isCrossDrivePath('captures/file.png')).toBe(false);
  });
});
