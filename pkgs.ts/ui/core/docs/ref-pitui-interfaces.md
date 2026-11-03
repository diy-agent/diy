# pi-tui 接口参考
> 自动生成于 2026-05-12T15:34:51.754Z
> 来源: @mariozechner/pi-tui

## Component 接口
```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```


## Container

### 构造函数签名
```typescript
constructor()
```

### 公开方法签名
```typescript
addChild(component): void
clear(): void
invalidate(): void
removeChild(component): void
render(width): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ❌ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## TUI

### 构造函数签名
```typescript
constructor(terminal, showHardwareCursor)
```

### 公开方法签名
```typescript
addInputListener(listener): void
applyLineResets(lines): void
compositeLineAt(baseLine, overlayLine, startCol, overlayWidth, totalWidth): void
compositeOverlays(lines, termWidth, termHeight): void
doRender(): void
extractCursorPosition(lines, height): void
get fullRedraws()(...): unknown
getClearOnShrink(): void
getShowHardwareCursor(): void
getTopmostVisibleOverlay(): void
handleInput(data): void
hasOverlay(): void
hideOverlay(): void
invalidate(): void
isOverlayVisible(entry): void
parseCellSizeResponse(): void
positionHardwareCursor(cursorPos, totalLines): void
queryCellSize(): void
removeInputListener(listener): void
requestRender(force = false): void
resolveAnchorCol(anchor, width, availWidth, marginLeft): void
resolveAnchorRow(anchor, height, availHeight, marginTop): void
resolveOverlayLayout(options, overlayHeight, termWidth, termHeight): void
setClearOnShrink(enabled): void
setFocus(component): void
setShowHardwareCursor(enabled): void
showOverlay(component, options): void
start(): void
stop(): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ✅ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## Text

### 构造函数签名
```typescript
constructor(text = "", paddingX = 1, paddingY = 1, customBgFn)
```

### 公开方法签名
```typescript
invalidate(): void
render(width): void
setCustomBgFn(customBgFn): void
setText(text): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ❌ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## TruncatedText

### 构造函数签名
```typescript
constructor(text, paddingX = 0, paddingY = 0)
```

### 公开方法签名
```typescript
invalidate(): void
render(width): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ❌ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## Box

### 构造函数签名
```typescript
constructor(paddingX = 1, paddingY = 1, bgFn)
```

### 公开方法签名
```typescript
addChild(component): void
clear(): void
invalidate(): void
removeChild(component): void
render(width): void
setBgFn(bgFn): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ❌ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## Input

### 构造函数签名
```typescript
constructor()
```

### 公开方法签名
```typescript
deleteToLineEnd(): void
deleteToLineStart(): void
deleteWordBackwards(): void
deleteWordForward(): void
getValue(): void
handleBackspace(): void
handleForwardDelete(): void
handleInput(data): void
handlePaste(pastedText): void
insertCharacter(char): void
invalidate(): void
moveWordBackwards(): void
moveWordForwards(): void
pushUndo(): void
render(width): void
setValue(value): void
undo(): void
yank(): void
yankPop(): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ✅ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## Editor

### 构造函数签名
```typescript
constructor(tui, theme, options = {})
```

### 公开方法签名
```typescript
addNewLine(): void
addToHistory(text): void
buildVisualLineMap(width): void
cancelAutocomplete(): void
computeVerticalMoveColumn(currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol): void
deleteToEndOfLine(): void
deleteToStartOfLine(): void
deleteWordBackwards(): void
deleteWordForward(): void
deleteYankedText(): void
findCurrentVisualLine(visualLines): void
forceFileAutocomplete(explicitTab = false): void
getAutocompleteMaxVisible(): void
getBestAutocompleteMatchIndex(items, prefix): void
getCursor(): void
getExpandedText(): void
getLines(): void
getPaddingX(): void
getText(): void
handleBackspace(): void
handleForwardDelete(): void
handleInput(data): void
handlePaste(pastedText): void
handleSlashCommandCompletion(): void
handleTabCompletion(): void
insertCharacter(char, skipUndoCoalescing): void
insertTextAtCursor(text): void
insertTextAtCursorInternal(text): void
insertYankedText(text): void
invalidate(): void
isAtStartOfMessage(): void
isBareCompletedSlashCommandAtCursor(): void
isEditorEmpty(): void
isInSlashCommandContext(textBeforeCursor): void
isOnFirstVisualLine(): void
isOnLastVisualLine(): void
isShowingAutocomplete(): void
isSlashMenuAllowed(): void
jumpToChar(char, direction): void
layoutText(contentWidth): void
moveCursor(deltaLine, deltaCol): void
moveToLineEnd(): void
moveToLineStart(): void
moveToVisualLine(visualLines, currentVisualLine, targetVisualLine): void
moveWordBackwards(): void
moveWordForwards(): void
navigateHistory(direction): void
pageScroll(direction): void
pushUndoSnapshot(): void
render(width): void
setAutocompleteMaxVisible(maxVisible): void
setAutocompleteProvider(provider): void
setCursorCol(col): void
setPaddingX(padding): void
setText(text): void
setTextInternal(text): void
shouldChainSlashArgumentAutocompleteOnTabSelection(): void
shouldSubmitOnBackslashEnter(data, kb): void
submitValue(): void
tryTriggerAutocomplete(explicitTab = false): void
undo(): void
updateAutocomplete(): void
yank(): void
yankPop(): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ✅ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## SelectList

### 构造函数签名
```typescript
constructor(items, maxVisible, theme)
```

### 公开方法签名
```typescript
getSelectedItem(): void
handleInput(keyData): void
invalidate(): void
notifySelectionChange(): void
render(width): void
setFilter(filter): void
setSelectedIndex(index): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ✅ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## SettingsList

### 构造函数签名
```typescript
constructor(items, maxVisible, theme, onChange, onCancel, options = {})
```

### 公开方法签名
```typescript
activateItem(): void
addHintLine(lines, width): void
applyFilter(query): void
closeSubmenu(): void
handleInput(data): void
invalidate(): void
render(width): void
renderMainList(width): void
updateValue(id, newValue): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ✅ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## Spacer

### 构造函数签名
```typescript
constructor(lines = 1)
```

### 公开方法签名
```typescript
invalidate(): void
render(_width): void
setLines(lines): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ❌ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## Markdown

### 构造函数签名
```typescript
constructor(text, paddingX, paddingY, theme, defaultTextStyle)
```

### 公开方法签名
```typescript
applyDefaultStyle(text): void
getDefaultInlineStyleContext(): void
getDefaultStylePrefix(): void
getLongestWordWidth(text, maxWidth): void
getStylePrefix(styleFn): void
invalidate(): void
render(width): void
renderInlineTokens(tokens, styleContext): void
renderList(token, depth, styleContext): void
renderListItem(tokens, parentDepth, styleContext): void
renderTable(token, availableWidth, styleContext): void
renderToken(token, width, nextTokenType, styleContext): void
setText(text): void
wrapCellText(text, maxWidth): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ❌ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## Image

### 构造函数签名
```typescript
constructor(base64Data, mimeType, theme, options = {}, dimensions)
```

### 公开方法签名
```typescript
getImageId(): void
invalidate(): void
render(width): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ❌ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## Loader

### 构造函数签名
```typescript
constructor(ui, spinnerColorFn, messageColorFn, message = "Loading...")
```

### 公开方法签名
```typescript
render(width): void
setMessage(message): void
start(): void
stop(): void
updateDisplay(): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ❌ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |


## CancellableLoader

### 构造函数签名
```typescript
constructor()
```

### 公开方法签名
```typescript
get aborted()(...): unknown
get signal()(...): unknown
handleInput(data): void
```

### Component 接口
| 方法 | 实现 |
|------|------|
| `render` | ✅ |
| `handleInput` | ✅ |
| `wantsKeyRelease` | ❌ |
| `invalidate` | ✅ |
| `focused` (Focusable) | - |

