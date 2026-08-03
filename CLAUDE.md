# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Surfingkeys 是一个浏览器扩展，为 Chrome/Chromium、Firefox 和 Safari 提供键盘导航和控制功能，灵感来自 Vim 编辑器。通过 JavaScript 配置所有设置和快捷键映射。

## 开发命令

### 构建

```bash
npm run build              # 完整构建：清理 + 测试 + 文档 + 生产构建
npm run build:dev          # 开发版本构建
npm run build:prod         # 生产版本构建
npm run clean              # 清理 dist 目录
npm run build:doc          # 生成 API 文档（输出到 docs/api.md）
```

### 浏览器特定构建

```bash
browser=firefox npm run build:prod   # Firefox 构建
browser=firefox npm run build:dev    # Firefox 开发构建
browser=safari npm run build:prod    # Safari 构建
# 默认为 Chrome/Chromium 构建
```

### 测试

```bash
npm test                              # 运行所有测试
npm test -- tests/content_scripts/    # 运行特定目录下的测试
npm test -- --testPathPattern=trie    # 按文件名模式匹配运行测试
npm test -- tests/nvim/               # Neovim 集成测试
```

Jest 配置：jsdom 环境，全部为单元测试，无端到端测试。`config/jest/afterEnv.js`
为 jsdom 补上 `TextEncoder`/`TextDecoder`（`src/background` 的依赖在导入期就会用到）。

### 加载扩展到浏览器

1. `npm run build:dev`
2. 打开 `chrome://extensions`（或对应浏览器扩展页面）
3. 启用开发者模式，加载 `dist/development/<browser>` 目录

## 核心架构

### 三层消息传递机制

整个系统的通信骨架由三层消息机制组成，适用场景各不相同：

**1. RUNTIME() — Content Scripts ↔ Background**

`RUNTIME()`（`src/content_scripts/common/runtime.js`）封装 `chrome.runtime.sendMessage()`。消息格式为 `{action, ...args, needResponse}`，background 端由 `src/background/start.js` 的 `handleMessage()` 通过 `self[action]()` 分发；action 同步返回真值即作为响应，否则稍后经 `sendResponse` 异步应答。MV3 用户脚本世界的消息走 `chrome.runtime.onUserScriptMessage`，同样交给 `handleMessage()`。

```
Content Script → chrome.runtime.sendMessage({action, args}) → Background handleMessage()
```

**2. dispatchSKEvent() — 同文档内组件间通信**

`dispatchSKEvent()`（`src/content_scripts/common/runtime.js`）基于 DOM CustomEvent，默认 target 为 `document`。事件名为 `surfingkeys:<scope>:<type>`，scope 按文档随机生成，防止页面脚本监听或伪造内部通道；扩展自身页面（options、markdown、neovim）scope 为空，事件名退化为 `surfingkeys:<type>`。接收端一律用 `skEventName(type)` 取事件名监听。`src/content_scripts/common/utils.js` 的 `initSKFunctionListener()` 提供按名分发与一次性回调。

MV3 用户脚本世界与 content script 同文档但不共享模块状态，经 background 的 `getChannelScope` 取得 scope 后调用 `setChannelScope()`，在此之前不收发任何事件。

**3. postMessage() — Content Window ↔ Frontend iframe**

跨 iframe 通信，由 UIHost（`src/content_scripts/uiframe.js` 的 `createUiHost()`）中转路由。三种消息信封：
- `{surfingkeys_uihost_data}` — content/frontend → UIHost
- `{surfingkeys_frontend_data}` — UIHost → frontend iframe
- `{surfingkeys_content_data}` — UIHost → content window

UIHost 跟踪 `activeContent`（当前活跃的内容窗口），只有活跃窗口才会接收 frontend 的响应消息。切换时发送 `activated`/`deactivated` 通知。

### UI 架构：Shadow DOM + iframe 隔离

Frontend UI 采用懒加载的 Shadow DOM + iframe 隔离方案：

- **front.js**（`src/content_scripts/front.js`）：运行在内容窗口中的轻量代理，注释明确说明 "a front stub to talk with pages/frontend.html"。所有 UI 操作通过 `self.command()` 转发。
- **uiframe.js**（`src/content_scripts/uiframe.js`）：创建 Shadow DOM 容器（`attachShadow({mode: 'open'})`），在其中注入 iframe 加载 `frontend.html`。iframe 固定定位在页面底部，z-index 为 `2147483647`。
- **frontend.js**（`src/content_scripts/ui/frontend.js`）：iframe 内的实际 UI 逻辑，处理 Omnibar、状态栏、编辑器、弹窗等所有 UI 渲染。

**懒初始化**：`frontendPromise` 在首次需要 UI 时才创建（`newFrontEnd()`），通过 Promise 确保后续命令等待 iframe 就绪。`hideKeystroke` 与内容全空的 `showStatus` 不触发创建；`document.body` 就绪前发出的命令排队，body 出现后重放。启用状态的顶层 frame 在空闲时预热一次 frontend（`content.js` 的 `applyRuntimeConf()` 派发 `ensureFrontEnd`）。`frontendDestroyed` 消息会重置 promise，允许重新创建。

### Mode 系统：栈式设计与 Trie 键匹配

**Mode 栈**（`src/content_scripts/common/mode.js`）：

`mode_stack` 数组按优先级排序。`enter()` 将模式 `unshift` 到栈顶后按 priority 排序；`exit()` 支持 peek（仅移除自身）和完全退出（移除自身及其上所有模式）。`Mode.getCurrent()` 返回 `mode_stack[0]`。

**事件传播**（`mode.js` 的 `handleStack()`）：

`handleStack()` 遍历 `mode_stack`，每个模式的 handler 可设置 `event.sk_stopPropagation = true` 来阻止向低优先级模式传播，同时触发 `stopImmediatePropagation()` 和 `preventDefault()`。`Disabled` 模式会直接 break 循环。

**Trie 键序列匹配**（`src/content_scripts/common/trie.js`）：

每个模式维护 `mappings`（Trie 根节点）和 `map_node`（当前遍历位置）。`Mode.handleMapKey()`（`mode.js`）中的状态机：
1. Esc → `Mode.finish()` 重置 `map_node` 到根
2. `pendingMap` 存在 → 执行带参数的绑定函数
3. 数字键且在根节点 → 累积 `repeats` 前缀（如 `5j` 中的 `5`）
4. `map_node.find(key)` 导航 Trie：找到叶节点（有 `meta`）则执行，中间节点则继续等待，无匹配则重置

**Sentinel 事件复活机制**（`mode.js` 的 `Mode.checkEventListener()`）：

SPA 页面切换可能清除事件监听器。`Mode.checkEventListener()` 发送 `sentinel` CustomEvent，检查 `eventListenerBeats` 计数器是否递增。如果未递增说明监听器丢失，调用 `init()` 重新绑定所有事件，并重新初始化模块。background 在 tab 的 title 或 url 变化时发送 `titleChanged`，`content.js` 的 `start()` 收到后触发检测。

| 模式 | 说明 | API 映射函数 |
|------|------|-------------|
| Normal | 默认模式 | `api.mapkey()` |
| Visual | 文本选择（Caret/Range） | `api.vmapkey()` |
| Insert | 可编辑元素聚焦时 | `api.imapkey()` |
| Hints | 链接提示（`f`、`cf`、`af`） | - |
| PassThrough | 暂时禁用（`Alt-i`） | - |
| Lurk | 仅响应 `Alt-i`/`p` | `api.lmap()` |
| Omnibar | 命令模式 | `api.cmap()` |

### Settings 传播流程

设置从存储到生效的完整链路：

**1. Background 加载**（`src/background/start.js` 的 `loadSettings()`）：各浏览器的 `loadRawSettings()` 都委托给 `start.js` 的 `loadRawSettingsFromStorage()`；Chrome 与 Safari 启用 sync，比较 `local.savedAt` 与 `sync.savedAt`，较新的覆盖较旧的，解决同步冲突。结果缓存在内存 `_cachedSet` 中，并发加载合并为一次读取；`chrome.storage.onChanged` 对本机写入打补丁，对其他设备的 sync 变更或键删除则丢弃缓存。设置了 `localPath` 时，先用已持久化的 snippets 应答，再在后台从 `localPath` 刷新。

**2. 广播到内容脚本**（`start.js` 的 `_broadcastSettings()`）：经 `sendTabMessage()` 向所有标签页所有 frame 发送 `settingsUpdated` 消息。

**3. 内容脚本应用**（`src/content_scripts/content.js` 的 `applySettings()`）：更新 `runtime.conf`，`showAdvanced` 关闭时应用 basicMappings；开启且非 MV3 时用 `new Function()` 执行 snippets；最后调用 `applyRuntimeConf()` 同步状态。MV3 下 background 不向网页 frame 下发 snippets。

**4. 用户 Snippets 执行（MV3）**（`start.js` 的 `registerUserScript()`）：通过 `chrome.userScripts.register()` 在 USER_SCRIPT 世界以 `document_start` 注册。生成的代码动态 import `api.js` 模块，在 `(api, settings) => { /* 用户代码 */ }` 回调中执行。用户脚本拿到 channel scope 后派发 `userScriptListening`，content script 等到自身 settings 应用完毕再派发 `runUserScript` 启动 snippets（`content.js` 的 `maybeStartUserScript()`）。Snippets 产生的设置通过 `RUNTIME('updateSettings', {scope: "snippets"})` 回传 background，但 scope 为 `snippets` 时不持久化。

### 构建系统

Webpack 配置（`config/webpack.config.js`）生成两套输出：

**标准 bundle**：background、content、pages/frontend、pages/start、pages/ace 等，默认 IIFE 格式。

**ES module bundle**：pages/options、pages/neovim_lib（TypeScript，Chrome 与 Firefox）、api（用户脚本入口，仅 Chrome），使用 `libraryTarget: 'module'` + `experiments.outputModule`。ES module 格式使 MV3 的 userScripts API 能通过 `import()` 加载 api.js。

**浏览器差异**：入口点按浏览器分离（`src/background/${browser}.js`、`src/content_scripts/${browser}.js`）。`modifyManifest()` 函数动态修改 manifest：

| | Chrome | Firefox | Safari |
|---|--------|---------|--------|
| Manifest 版本 | v3 | v2 | v2 |
| Background | Service Worker | Scripts | Scripts (non-persistent) |
| 额外权限 | proxy, tts, downloads.shelf, favicon, userScripts, tabGroups | cookies, contextualIdentities, tabGroups | - |
| Neovim 支持 | 有 | 有 | 无 |

开发模式下 Chrome 构建固定 `manifest.key`（RSA 公钥），确保 extension ID 跨构建稳定，使 `chrome-extension://` URL、storage、消息传递等依赖固定 ID 的功能正常工作。

构建输出：`dist/<development|production>/<chrome|firefox|safari>/`

## 重要约定

- TypeScript 用于 Neovim 集成（`src/nvim/`），JavaScript 用于其余部分
- 浏览器特定代码分离在各自文件中（chrome.js/firefox.js/safari.js）
- 用户配置文件：`~/.surfingkeys.js`
- API 文档从 JSDoc 自动生成，主要定义在 `src/content_scripts/common/api.js`
