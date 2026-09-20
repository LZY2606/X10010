# `yaml` v3.0.0-2 解析/序列化链路分析

行号全部对应当前工作区（仓库根目录）里的代码。文中“标量”一词按 YAML 术语使用；CST 指具体语法树（`src/parse/cst.ts` 里的 `Token`），AST 指 `Document` + `Scalar`/`YAMLMap`/`YAMLSeq`/`Alias`/`Pair` 节点。

## 一、主干调用链：`YAML.parse(src)` 到返回值

### 0. 入口：`parse`

- `src/public-api.ts:113-144` 是 `YAML.parse` 的实现（重载签名在 `:113-128`）。入参：源字符串 `src`、可选 `reviver`、options；出参：JS 值。
  1. 规整 reviver/options（`src/public-api.ts:129-134`）。
  2. 调 `parseDocument(src, options)` 拿到 `Document.Parsed`（`src/public-api.ts:136`）。**文档结构在这一跳已经全部定稿**：AST、range、errors、warnings 都在 doc 上。
  3. warnings 经 `warn(logLevel, …)` 按级别输出（`src/public-api.ts:138` → `src/log.ts:7-18`）。
  4. errors 非空时：`logLevel !== 'silent'` 直接 `throw doc.errors[0]`；`'silent'` 则把 `doc.errors = []` 清空后继续（`src/public-api.ts:139-142`）。
  5. `doc.toJS({ reviver, ...options })` 产出 JS 值并返回（`src/public-api.ts:143` → `src/doc/Document.ts:335-344`）。
- `parseDocument`（`src/public-api.ts:64-98`）每次都 `new Parser(...)` + `new Composer(options)`，并用 `composer.compose(parser.parse(source), true, source.length)` 强制至少产出一篇文档（`src/public-api.ts:69-79`）；发现第二篇文档时，非 silent 会补一条 `MULTIPLE_DOCS` 错误（`src/public-api.ts:81-90`）。

### 1. 词法切分：`lex()`

- `Parser.parse(source)` 内部直接调用 `lex(source)`：`src/parse/parser.ts:187-191`（`for (const lexeme of lex(source)) this.next(lexeme)`，最后 `return this.end()`）。
- `lex` 本体：`src/parse/lexer.ts:59-78`。入参是源字符串；出参是 `string[]`（词素数组）。它驱动一个三态状态机：`stream`/`document`/`flow`（`src/parse/lexer.ts:63-76`）。
  - `stream()` 在遇到第一段非指令、非注释、非空行的内容时压入控制字符 `DOCUMENT`（`\x02`）并转入行首处理（`src/parse/lexer.ts:168-169`）；`%TAG`/`%YAML` 指令、BOM、注释、空行在 `:137-166` 原样切出。
  - `lineStart()` 处理 `---`/`...` 文档标记（`src/parse/lexer.ts:172-190`）、行首缩进和连续的 `-`/`?`/`:` 指示符（`:192-219`）。
  - `document()` 按首字符分派：`{`/`[` 进 flow（`:234-239`），`*` 切 alias（`:245-247`），引号走 `quotedScalar`（`:248-251`），`|`/`>` 走 `blockScalar`（`:252-255`），其余走 `plainScalar`（`:262-264`）。
  - `plainScalar()` 扫描到值尾后压入控制字符 `SCALAR`（`\x1f`），再用 `toIndex(end+1, true)` 压入值文本；`true` 允许空标量（`src/parse/lexer.ts:500-536`，关键在 `:534-535`）。块标量同理：先切 header，再压 `SCALAR` + 块内容（`src/parse/lexer.ts:423-498`，`:496-497`）。
  - 控制字符的含义写在 `src/parse/lexer.ts:45-58`，类型判定在 `src/parse/cst.ts:191-248` 的 `tokenType()`。
- **这一跳定下来的**：每一片文本的词法类型（普通切片 vs `SCALAR`/`DOCUMENT`/`FLOW_END`）、缩进追踪所需的原始形态。词法器不做任何语法归属（不知道谁是谁的 key/value）。

### 2. 词素进 Parser：`Parser.next()` 与 CST token 的交出时机

- `Parser.next(source)`：`src/parse/parser.ts:196-241`。入参是一个词素字符串，没有返回值（直接改内部 `stack`/`tokens`）。
  - 上一个词素是 `SCALAR` 时：置回 `atScalar`，先 `this.step()` 再累加 offset 返回（`src/parse/parser.ts:200-205`）。也就是说 `SCALAR` 本身只负责“预告下一个词素是标量值”，真正的值文本在下一次 `next()` 才被消费。
  - 否则先 `tokenType(source)` 判型（`:207`，实现见 `src/parse/cst.ts:191-248`）；`scalar` 型只设 `atScalar=true` 暂不 step（`:212-215`）；其余立即 `this.step()`（`:218`），然后按类型更新 `atNewLine`/`indent`/行计数回调（`:219-239`）。
  - 每个词素进入时 `this.offset` 是它的起始偏移，离开时 `offset += source.length`（`:203`、`:239`）。`sourceToken` getter（`:249-257`）据此造 `{ type, offset, indent, source }`。
- `step()`（`src/parse/parser.ts:259-296`）按栈顶 token 类型分派到 `document()`/`scalar()`/`blockScalar()`/`blockMap()`/`blockSequence()`/`flowCollection()`/`documentEnd()`。
- **完整 CST token 交出去的时刻是 `pop()` 把栈弹空**：`src/parse/parser.ts:302-396`，其中 `:313-314` `else if (this.stack.length === 0) { this.tokens.push(token) }`。典型触发点：
  - 顶层文档值在遇到 `doc-end` 或行终结符时弹出（`:261-269` 会先清空栈再压 `doc-end`；`:970-991` 的 `lineEnd()` 在 newline/`,`/`]`/`}`/`...` 时 `this.pop()`）。
  - 块集合在缩进回退（`blockMap()` 末尾 `:729-730`、`blockSequence()` 末尾 `:780-781`）时弹出，弹出时还会修正块标量/顶层 flow 的 indent（`:317-323`）和 flow seq 配对项（`:324` `fixFlowSeqItems`，定义在 `:97-116`）。
  - 输入结束时 `end()` 把栈全部弹空（`src/parse/parser.ts:244-247`）。
- 弹栈时 token 被挂到父节点上：document 的 `value`（`:326-328`）、block-map 条目的 `key`/`value`（`:332-348`）、block-seq item 的 `value`（`:349-354`）、flow item 的 key/value（`:355-365`）。
- 新集合 token 的诞生在 `startBlockValue()`：`src/parse/parser.ts:897-954`（block-scalar header、flow 起始括号、`-`、`?`、`:` 分别造 `block-scalar`/`flow-collection`/`block-seq`/`block-map`）。
- 产出的 CST 数据结构：`src/parse/cst.ts:49-128`（`Document`/`FlowScalar`/`BlockScalar`/`BlockMap`/`BlockSequence`/`FlowCollection`），每个都带 `offset`，叶子带 `source`。

### 3. 从 token 流切出一篇 Document：`Composer.compose()`

- `Composer.compose(tokens, forceDoc, endOffset)`：`src/compose/composer.ts:156-164`。入参是可迭代的 CST token 流；出参是 `Document.Parsed[]`。它逐个调 `this.next(token)`（`:162`），最后 `this.end(forceDoc, endOffset)`（`:163`）。
- `Composer.next(token)`：`src/compose/composer.ts:167-250`，按 token 类型分流：
  - `'directive'`：交给流级 `Directives.add()` 解析 `%YAML`/`%TAG`，并把原文压进 prelude（`:170-178`；指令逻辑在 `src/doc/directives.ts:77-118`）。
  - `'document'`：**一篇文档在这里被完整 compose**——`composeDoc(this.options, this.directives, token, this.onError)`（`src/compose/composer.ts:179-197`，调用在 `:180-185`）；随后把上一篇 `this.doc` 推进 `this.docs`（`:193`）、当前 doc 暂存（`:194`）。
  - `'doc-end'`：用 `resolveEnd()` 收尾注释并把 `doc.range[2]` 钉到文档尾偏移（`:218-239`，`:238`）。
  - `'error'` CST 错误 token 在此转成 `YAMLParseError`（`:205-217`）；token 流间隙的 comment/newline 进 `prelude`（`:198-204`），由 `decorate()`（`:99-129`）决定挂成文档注释还是首个条目的前置注释。
- 流末尾 `end()`：`src/compose/composer.ts:258-277`。还有未交付的 doc 就 decorate 后入队（`:259-262`）；若一篇都没有但 `forceDoc=true`（`parseDocument` 的情形），就构造一篇值为 `undefined` 的空文档，range 设为 `[0, endOffset, endOffset]`（`:263-275`，`:272`）。
- **这一跳定下来的**：CST 文档 token ↔ AST `Document` 的一一对应、文档级错误/警告的归集（`onError` 在 `:93-97` 按第 4 参数 `warning` 分流到 `this.errors`/`this.warnings`）、以及文档边界。

### 4. `composeDoc` → `composeNode` 的分派

- `composeDoc()`：`src/compose/compose-doc.ts:18-63`。
  1. 新建 `Document`，从流 directives 复制本文档的 directives（`:24-25`）。
  2. 组装 `ComposeContext { atKey:false, atRoot:true, directives, options, schema }`（`:26-32`）。
  3. `resolveProps(start, …)` 扫描文档起始的 anchor/tag/注释/`---`（`:33-40`；`resolveProps` 本体在 `src/compose/resolve-props.ts:14-209`，anchor 在 `:110-129`、tag 在 `:130-139`、指示符在 `:140-158`，末尾返回 props 结束偏移 `end`，`:175`）。
  4. 有值走 `composeNode(ctx, value, props, onError)`；没值走 `composeEmptyNode(...)`（`:54-56`）。
  5. 以 `doc.value.range[2]` 为 contentEnd，经 `resolveEnd()` 处理尾注释，最终 `doc.range = [offset, contentEnd, re.offset]`（`:58-61`）。
- `composeNode()`：`src/compose/compose-node.ts:37-106`，按 CST token.type 分派：
  - `'alias'` → `composeAlias()`（`:48-56`，别名定义在 `:136-156`）。
  - 四种标量（`'scalar'`/`'single-quoted-scalar'`/`'double-quoted-scalar'`/`'block-scalar'`）→ `composeScalar(ctx, token, tag, onError)`，并在之后挂 anchor（`:57-63`）。
  - `'block-map'`/`'block-seq'`/`'flow-collection'` → `composeCollection()`（`:64-75`；`src/compose/compose-collection.ts:54-146` 再分派给 `resolveBlockMap`/`resolveBlockSeq`/`resolveFlowCollection`，三者分别在 `src/compose/resolve-block-map.ts:14-159`、`src/compose/resolve-block-seq.ts:9-57`、`src/compose/resolve-flow-collection.ts:18-238` 里递归回调 `CN.composeNode`，如 `src/compose/resolve-block-map.ts:73-75`（key）、`:112-114`（value））。栈溢出在这里被捕获成 `RESOURCE_EXHAUSTION`（`src/compose/compose-node.ts:67-74`）。
  - 分派后统一处理：anchor 空串错误（`:86-87`）、`stringKeys` 键校验（`:88-97`）、`spaceBefore`/`commentBefore`（`:98-102`）、可选 `srcToken`（`:103-104`）。
- 集合里的递归次序固定为“先 key 后 value”：`resolveBlockMap` 先 `ctx.atKey=true` compose key（`src/compose/resolve-block-map.ts:71-77`），再 `resolveProps(sep,…)`（`:83-90`）后 compose value（`:111-116`），最后 `new Pair(keyNode, valueNode)` + `map.set(pair)`（`:128-132`）。flow 集合同构：`src/compose/resolve-flow-collection.ts:122-129`（key）、`:131-186`（value）、`:194-209`（组 Pair）。

### 5. `composeScalar`：词法形态、tag 选择、`resolve()` 的关系

- 入口：`src/compose/compose-scalar.ts:10-57`。顺序严格是：
  1. **先把 CST 叶子解析成字符串值与形态**：block-scalar 走 `resolveBlockScalar(ctx, token, onError)`（`:17-18`，`src/compose/resolve-block-scalar.ts:7-133`，header `|`/`>` 决定 `BLOCK_LITERAL`/`BLOCK_FOLDED`，`:21`），其余三种走 `resolveFlowScalar(token, strict, onError)`（`:19`，`src/compose/resolve-flow-scalar.ts:14-68`；PLAIN/QUOTE_SINGLE/QUOTE_DOUBLE 在 `:29-43` 分派，值在 `plainValue`/`singleQuotedValue`/`doubleQuotedValue` `:70-201` 中做折行/去引号/转义）。两个 resolve 都返回 `{ value, type, comment, range }`（`src/compose/resolve-flow-scalar.ts:60-67`、`src/compose/resolve-block-scalar.ts:131-132`）。
  2. **再解析显式 tag 名**：仅当存在 tag token 时，`ctx.directives.tagName(tagToken.source, …)` 把 `!!str`、`!local`、`!<verbatim>` 解析成全限定名（`:21-25`；`src/doc/directives.ts:126-160`）。
  3. **然后选 ScalarTag**（`:27-34`）：
     - `stringKeys && atKey`：直接用字符串 tag `ctx.schema.scalar`（`:28-29`），显式 tag 在这一分支失效（只影响 `scalar.tag` 字段，见下文不变量）。
     - 有 `tagName`：`findScalarTagByName`（`:30-31`，`:59-89`）。`!` 非特指 tag 直接落字符串（`:66`）；否则按 `schema.tags` 的排列次序找同 tag（`:68-74`），找不到再查 `schema.knownTags`（`:75-81`），还找不到就发 `TAG_RESOLVE_FAILED` 并回退字符串 tag（`:82-88`）。
     - 无显式 tag 且是**纯 plain**（`token.type === 'scalar'`）：`findScalarTagByTest`（`:32-33`，`:93-127`）——只在 `schema.tags` 中筛选带 `test` 且 `default === true`（或键位置下 `default === 'key'`）的 tag，按数组顺序 `find` 第一个 `test(value)` 为真的（`:99-112`）；若配置了 `schema.compat`，再用 compat 表验一次，分歧时发警告（`:114-124`）。
     - 无显式 tag 且是 quoted/block 形态：直接用字符串 tag（`:34`）。**引号和块形态在词法层就已决定“按字符串解析”，不跑 `test`。**
  4. **最后调 tag.resolve**：`tag.resolve(value, onError, ctx.options)`（`:38-42`），返回非 Scalar 时包成 `new Scalar(res)`（`:43`），抛错则降级为字符串 Scalar 并发 `TAG_RESOLVE_FAILED`（`:44-48`）。随后把 range/source/type/tag/format/comment 写回（`:49-54`）。
- **这一跳定下来的**：标量的 JS 初值（由 tag.resolve 决定）、标量形态 `scalar.type`（由词法 token 决定）、`scalar.tag`、`scalar.range`。

### 6. `Document.toJS` 与 `ToJSContext`

- `Document.toJS(opt)`：`src/doc/Document.ts:335-344`。入参 ToJSOptions（`mapAsMap`/`reviver`/`onAnchor`/`maxAliasCount` 等）；做的事：
  1. `new ToJSContext(opt)`（`:337`；`src/nodes/toJS.ts:8-70`）。
  2. `this.value.toJS(this, ctx)` 递归产 JS 值（`:338`）。
  3. 对每个 anchor 节点回调 `onAnchor(res, count)`（`:339-340`）。
  4. 有 reviver 则走 ECMA-262 同款的 `applyReviver`（`:341-343`；`src/doc/applyReviver.ts:22-62`）。
- `ToJSContext`（`src/nodes/toJS.ts:8-69`）的角色：
  - `anchors: Map<Node, {aliasCount, count, res}>`（`:9-10`）：AST 节点 → 已物化 JS 值与计数。`setAnchor`（`:22-26`）在 `Scalar.toJS`（`src/nodes/Scalar.ts:98-103`，`:99-101`）、`YAMLMap.toJS`（`src/nodes/YAMLMap.ts:243`）、`YAMLSeq.toJS`（`src/nodes/YAMLSeq.ts:187-192`）、`YAMLSet.toJS`（`src/nodes/YAMLSet.ts:142`）里登记。
  - `resolveAlias(doc, source)`（`src/nodes/toJS.ts:28-49`）：alias 物化时先查 anchors，anchor 节点尚未物化就**就地触发 `source.toJS(doc, this)`**（`:30-33`）——因此前向 alias 只要在文档顺序上 anchor 在后面就永远找不到（见不变量三）。然后做计数检查（`:39-47`）。
  - `aliasResolveCache?: Node[]`（`:12`）：只缓存 `Alias.resolve()` 的“按文档顺序的 anchor/alias 节点列表”，防止每次 alias 都全树 visit（`src/nodes/Alias.ts:69-80`）。
  - `maxAliasCount`（`:15`、`:19`，默认 100）：资源耗尽阈值，`count * aliasCount > maxAliasCount` 即抛错（`:42-46`），负数关闭计数；`Alias.resolve()` 对 0 还会直接拒（`src/nodes/Alias.ts:66-67`）。
  - `mapAsMap`（`:13`、`:18`）决定 map 物化成 `Map` 还是普通对象；`mapKeyWarned`（`:14`）保证集合键字符串化警告只发一次（`src/nodes/addPairToJSMap.ts:62-68`）。
- 各节点 toJS：
  - `Scalar.toJS`：`src/nodes/Scalar.ts:98-103`——有 anchor 先登记，直接返回 `this.value`。
  - `YAMLMap.toJS`：`src/nodes/YAMLMap.ts:226-247`——按 `Type`/`mapAsMap`/普通对象建容器（`:233-242`），有 anchor 先登记空容器（`:243`，这是循环引用能成环的关键），再按 pair 顺序逐个 `addPairToJSMap`（`:244-245`）。
  - `YAMLSeq.toJS`：`src/nodes/YAMLSeq.ts:185-195`（anchor 情形先建空数组并登记再 push，`:187-191`）。
  - `Alias.toJS`：`src/nodes/Alias.ts:92-103`——`this.resolve(doc, ctx)` 找 anchor 节点（`:96`），找不到抛 `ReferenceError`（`:97-100`），找到交给 `ctx.resolveAlias`（`:102`）。
- **`addPairToJSMap` 写键值那一步**：`src/nodes/addPairToJSMap.ts:10-45`。每个 Pair 进入：
  1. 若 key 自带 `addToJSMap`（merge tag resolve 出来的 `Symbol('<<')` Scalar 就是这样），调用它（`:17`；定义方 `src/schema/yaml-1.1/merge.ts:28-31,42-55`）。
  2. 否则若 `isMergeKey(doc, key)`（裸 `<<` 字符串的兼容路径，`:19-20`；判定在 `src/schema/yaml-1.1/merge.ts:35-40`，要求 schema 里 merge tag 是 default），走 `addMergeToJSMap`。
  3. 否则普通键：`key.toJS` 得 jsKey（`:22`）；`Map` 容器 `map.set(jsKey, value?.toJS())`（`:23-24`），`Set` 用 `add`（`:25-26`），普通对象先 `stringifyKey`（`:28`，`:47-69`，对象/数组键会被 YAML 序列化成字符串并告警），再处理 `__proto__`/`constructor`/已有键的原型污染面（`:30-41`，用 `Object.defineProperty`），最后普通赋值 `map[stringKey] = jsValue`（`:41`）。

## 二、不变量清单（每条都可对着代码核对）

### 不变量 1：CST 的 `offset`/`source` 与 AST 的 `[start, value-end, node-end]` 三元组严格对齐

- 约定写在 `src/nodes/types.ts` 里 `Range` 的注释（三个位置都遵循左闭右开）以及 `src/doc/Document.ts:61-67`。
- Flow/叶子标量：CST `FlowScalar.offset` 就是词素起点，`source` 是完整词素（含引号）。AST range 在 `src/compose/resolve-flow-scalar.ts:60-67` 组装：`[offset, offset + source.length, re.offset]`，其中 `re.offset` 是 `resolveEnd()` 吃掉尾部空格/注释/换行后的位置（`src/compose/resolve-end.ts:4-44`，它对每个 end token 做 `offset += source.length`，`:40`）。实测 `foo: "bar"\n`：value range `[5,10,10]`，`src.slice(5,10) === '"bar"'`。
- Alias：`src/compose/compose-node.ts:151-154`：`[offset, offset+source.length, re.offset]`。
- Block scalar：CST `offset` 指向 `|`/`>` header 起点，`source` 只含内容行（`src/parse/parser.ts:904-911` 创建时 `source:''`，`:489-490` 填入）。AST range 的 end = `start + header.length + scalar.source.length`，`src/compose/resolve-block-scalar.ts:131-132`（空内容捷径在 `:33-41`）。实测 `a: |\n  x\n  y\n`：range `[3,13,13]`，切片正好是 `|\n  x\n  y\n`。注意块标量的 CST `indent` 在弹栈时被改成父节点 indent（`src/parse/parser.ts:317-319`），这是内容缩进推导的输入，不影响 offset 对齐。
- 集合：block-map 的 range = `[bm.offset, offset, commentEnd ?? offset]`（`src/compose/resolve-block-map.ts:157`），其中 `offset` 逐项推进为“最后一个 value 的 range[2]”（`:91`、`:116`）；block-seq 同理（`src/compose/resolve-block-seq.ts:52,55`）；flow 集合以结束括号 token 之后为 cePos（`src/compose/resolve-flow-collection.ts:214-235`），range `[fc.offset, cePos, end.offset]`。
- Document：`[CST document.offset, 根值 range[2], resolveEnd 后的尾偏移]`（`src/compose/compose-doc.ts:58-61`），遇到 `...` 时 node-end 还会被 composer 改写（`src/compose/composer.ts:238`）。
- **没有源文本的空节点**（`a:` 后空着、空文档值、flow 里空 item）走 `composeEmptyNode()`：`src/compose/compose-node.ts:108-134`。它造一个 `{ type:'scalar', offset: emptyScalarPosition(...), indent:-1, source:'' }` 的虚拟 CST（`:116-121`），因此 range 起点不是 0 长度地“贴”在 key 后面，而是经 `emptyScalarPosition()`（`src/compose/util-empty-scalar-position.ts:3-31`）从 `offset`（即 value props 的结束偏移）里**回退掉尾部的 space/comment/newline，再跳过随后的 space**（`:8-28`）——即把空标量定位在“最后一个非空 prop 之后的空白处”。range 三元组里 `[start,start]` 等值（value 为空串）；若空节点带行内注释，node-end 会被推到 props.end（`src/compose/compose-node.ts:129-132`）。实测 `a:\n\nb: 2\n` 的空 value range 为 `[2,2,2]`。

### 不变量 2：tag 解析优先级——显式 tag > `schema.tags` 排列次序 > `knownTags` > 报错；`schema.compat` 只发警告；`stringKeys` 在更前面短路

介入时刻从前到后：

1. **`stringKeys`（选项级，最先）**：`src/compose/compose-scalar.ts:28-29`，仅键位置，直接钉死为字符串 tag，连显式 tag 都绕不过（显式 `!!int 42` 的键会得到字符串 `"42"` 外加一条 `NON_STRING_KEY` 警告/错误，检查在 `src/compose/compose-node.ts:88-97`）。
2. **显式 tag（词法 prop）**：tag token 在 `resolveProps` 中被收集（`src/compose/resolve-props.ts:130-139`，多 tag 报错 `:131-132`，与 anchor 顺序错误报 `BAD_PROP_ORDER` `:142-147`），在 `composeScalar` 里经 `Directives.tagName` 展开（`src/compose/compose-scalar.ts:21-25`）。随后 `findScalarTagByName` 先在 `schema.tags` 中按**数组次序**找同名 tag（`:68-74`）：遇到非 default 或无 test 的立即返回；`default && test` 的收集到 `matchWithTest`，再用值过 test（`:70,74`）——这保证显式 `!!int` 下仍能按 format 选 OCT/HEX 等具体实现。
3. **`schema.tags` 排列次序（隐式 plain 才参与）**：`findScalarTagByTest` 过滤出带 `test` 且 `default:true`（键位置额外接受 `default:'key'`）的 tag，`Array.find` 取第一个 test 命中者（`src/compose/compose-scalar.ts:99-112`）。次序由 `getTags()` 决定（`src/schema/tags.ts:92-137`）：基础 schema 数组（core 见 `src/schema/core/schema.ts:10-22`，yaml-1.1 见 `src/schema/yaml-1.1/schema.ts:16-38`）在前，`customTags` 拼接在后（`:118-123`），merge tag 在 yaml-1.1 下追加（`Schema` 构造时 `merge` 传入，`src/schema/Schema.ts:43`）。
4. **`knownTags`（兜底显式 tag）**：只有显式 tag 在 `schema.tags` 中没找到时才查 `schema.knownTags[tagName]`（`src/compose/compose-scalar.ts:75-81`），命中时把该 tag 以 `{default:false, test:undefined}` **push 进当前 schema 实例的 tags**（`:79`，让后续 stringify 可用）。`knownTags` 内容由 `resolveKnownTags` 控制：1.2 core 为 `coreKnownTags`（`src/schema/Schema.ts:42`，`src/schema/tags.ts:74-90`；1.1 走 `resolveKnownTags:false`，`src/doc/Document.ts:302-312`）。
5. **失败兜底**：显式 tag 无法解析时发 `TAG_RESOLVE_FAILED`（对非 str tag 是**警告**，`:82-87` 第 4 参），返回字符串 tag；隐式匹配全部落空时也回 `schema.scalar`（`:88`、`:107-112`）。
6. **`schema.compat` 不能改变结果，只能发警告**：`findScalarTagByTest` 选定 tag 后，再用 compat 表找一遍，仅当两者 tag 不同时发警告（`src/compose/compose-scalar.ts:114-124`）。compat 表在 `Schema` 构造里由选项生成（`src/schema/Schema.ts:35-39`）。
7. 非特指 `!` 与 quoted/block 形态永远落到 `schema.scalar`（`src/compose/compose-scalar.ts:34,66`），`test` 对它们完全失效。

### 不变量 3：anchor 必须先于 alias；计数三件套各防一层；循环引用只在“别名引用”路径成环

- **顺序保证来自文档顺序扫描，而不是符号表**：`Alias.resolve()`（`src/nodes/Alias.ts:62-89`）先拿到按文档顺序排列的 anchor/alias 节点列表（有缓存用缓存，否则 `visit(doc, …)` 全树走一遍，`:69-80`），然后从前往后遍历，`if (node === this) break`，在此之前只记录同名 anchor（`:82-86`）。因此：
  - alias 之后才出现的同名 anchor 永远不会被看到；`Alias.toJS` 随即抛 `Unresolved alias (the anchor must be set before the alias)`（`src/nodes/Alias.ts:96-100`）。
  - anchor 重名时“最近的前一个”胜出（`:85` 是赋值而不是首次命中即停）。实测 `a:&x 1 / b:*x / c:&x 2 / d:*x` → b=1、d=2。
  - 另有语法层护栏：空 alias 名（`src/compose/compose-node.ts:142-143`）、alias 带属性（`:50-55` `ALIAS_PROPS`）、anchor/alias 以 `:` 结尾（警告，`src/compose/compose-node.ts:144-150`、`src/compose/resolve-props.ts:117-123`）。
- **`ToJSContext.anchors`（`src/nodes/toJS.ts:9-10,22-26`）防“重复物化”**：把 AST 节点映射到唯一的 JS 结果。`resolveAlias` 命中已物化 anchor 时直接复用 `data.res`（`:28-34,48`），所以同一 anchor 的多个 alias 在 JS 里是同一引用；集合 anchor 在递归填充**之前**就把空容器登记进去（`src/nodes/YAMLMap.ts:243-245`、`src/nodes/YAMLSeq.ts:187-191`），于是 `a: &a [*a]`、`a: &a {x: *a}` 这种合法自引用在 toJS 阶段产生真正的 JS 循环（实测 `v.a[0] === v.a`）。
- **`aliasResolveCache`（`src/nodes/toJS.ts:12`；`src/nodes/Alias.ts:69-80`）防“每个别名全树 visit”**：只是性能缓存，不影响解析结果（缓存内容是同一份文档顺序节点列表）。
- **`maxAliasCount`（`src/nodes/toJS.ts:15,19,39-47`）防 billion-laughs 式资源耗尽**：每次解析别名 `count += 1`，再乘以该 anchor 节点子树里 alias 扇出的递归估算 `#getAliasCount`（`:51-69`），超过阈值抛 `Excessive alias count indicates a resource exhaustion attack`（`:42-46`）。`Alias.resolve` 对 `maxAliasCount === 0` 直接抛 “Alias resolution is disabled”（`src/nodes/Alias.ts:66-67`）；负数关闭检查（`src/nodes/toJS.ts:39`）。
- **循环在哪里不被挡住 / 挡不住时的表现**：
  - CST→AST 阶段没有“引用图”概念，合法自引用能 compose 成功；但深层嵌套结构（不是别名，是真实递归嵌套如 `[[[[…]]]]`）会在 `composeCollection` 里爆栈，被捕获为 `RESOURCE_EXHAUSTION` 解析错误（`src/compose/compose-node.ts:67-74`），不会让进程崩。
  - toJS 阶段的循环是 alias 机制刻意支持的；但 `YAML.parse(…, reviver)` 会在 `applyReviver` 里无环保护地递归（`src/doc/applyReviver.ts:28-61`），循环文档 + reviver 会以原生 `RangeError: Maximum call stack size exceeded` 逃出（见风险点 2）。
  - 序列化侧：`stringify()` 用 `ctx.resolvedAliases` 检测“无 alias 节点的循环结构”（`src/stringify/stringify.ts:167-177`，`:169-172` 抛 `Cannot stringify circular structure without alias nodes`）；有 alias 的循环则在 `Alias.toString` 里用 `ctx.anchors.has(name)` + `verifyAliasOrder` 保证 anchor 先输出（`src/nodes/Alias.ts:111-117`）。

### 不变量 4：错误与警告的分界

- **`onError` 的第四个参数 `warning?: boolean` 是唯一分流开关**：类型签名 `src/compose/composer.ts:20-25`，实现 `:93-97`：truthy → `new YAMLWarning` 进 `this.warnings`；否则 `new YAMLParseError` 进 `this.errors`。`YAMLParseError`/`YAMLWarning` 只是 `YAMLError` 的两个 `name`（`src/errors.ts:30-61`，`:51-60`），都带 `code` 与 `pos:[start,end]`。位置归一化在 `getErrorPos`（`src/compose/composer.ts:27-32`）；prettyErrors 打开时由 `prettifyError` 附加行列与源码片段（`src/errors.ts:63-102`）。
- 典型“警告”调用：compat 分歧（`src/compose/compose-scalar.ts:122`）、未解析的非 str 显式 tag（`:82-87`）、anchor/alias 以 `:` 结尾（`src/compose/resolve-props.ts:117-123`）、flow 结束缩进（`src/compose/util-flow-indent-check.ts:18`）、已知 tag 但集合类型不符（`src/compose/compose-collection.ts:113-119`）。
- **`doc.errors` 非空时两个入口行为不同**：
  - `YAML.parse`（`src/public-api.ts:139-143`）：`logLevel !== 'silent'` 直接 **throw `doc.errors[0]`**（不返回值）；`'silent'` 时**清空 errors 继续 toJS**（`:141-142`）。warnings 始终先按 logLevel 经 `warn()` 输出（`:138`；`src/log.ts:7-18`：仅 `'warn'`/`'debug'` 输出）。
  - `YAML.parseDocument`：不抛错，原样返回 doc，由调用方读 `doc.errors`/`doc.warnings`；只有“多文档”这一条错误本身受 `logLevel !== 'silent'` 控制（`src/public-api.ts:81-90`）。
  - `Document.toString()` 对含错误的文档直接 throw `Document with errors cannot be stringified`（`src/doc/Document.ts:352-354`）。
- **`logLevel` 的位置**：它是 `DocumentOptions`（`src/options.ts:66-72`），默认 `'warn'`（`src/doc/Document.ts:107-118`，`:111`）。它不影响错误的**产生与分类**，只影响是否 throw（`src/public-api.ts:140`）、是否 console 输出（`src/log.ts:8`）和多文档检测（`src/public-api.ts:81`）。注意 toJS 阶段 alias/merge 抛的 `ReferenceError`/`Error` 不受 `'silent'` 影响，仍会逃出（见风险点 1/2）。

### 不变量 5：序列化时四种标量形态的选择，以及什么会推翻 `Scalar.type`

- 宽度传递：`stringifyString` 的各形态函数都通过 `getFoldOptions(ctx, isBlock)`（`src/stringify/stringifyString.ts:18-25`）把 `ctx.options.lineWidth`（默认 80）与 `minContentWidth`（默认 20；默认值见 `src/stringify/stringify.ts:31-51`，`:42-43`）传进 `foldFlowLines`；block 用 `ctx.indent.length` 作 `indentAtStart`，flow 用累计的 `ctx.indentAtStart`（props 长度在 `src/stringify/stringify.ts:183-185` 累加）。`foldFlowLines`（`src/stringify/foldFlowLines.ts:41-150`）在 `lineWidth<=0` 时完全不折（`:53`），`lineWidth<minContentWidth` 时把后者降为 0（`:54`），用 `endStep=max(1+minContentWidth, 1+lineWidth-indent)` 决定首个折点（`:55-56`），折不到但超长时通过 `onOverflow` 回调（`:129-136`）。
- 形态分派入口：`stringifyString()`（`src/stringify/stringifyString.ts:343-388`）先看 `item.type`，但有一个**无条件覆盖**：值含 C0/C1 控制字符或孤立代理项时强制 `QUOTE_DOUBLE`（`:355-360`）。随后 `_stringify(type)`（`:362-378`）分派：
  - `BLOCK_*`：implicitKey 或 inFlow 时**改成引号形态**（块不能进 flow/隐式键，`:364-368`），否则 `blockString`。
  - `QUOTE_DOUBLE` → `doubleQuotedString`；`QUOTE_SINGLE` → `singleQuotedString`；`PLAIN` → `plainString`；`undefined` → 再用 `defaultKeyType`（仅 implicitKey）/`defaultStringType`（`:380-386`）。
- **节点上写好的 `Scalar.type` 会被哪些情况推翻**：
  - 控制字符 → 双引号（`src/stringify/stringifyString.ts:356-360`）。
  - 块形态在 flow/implicitKey 下 → `quotedString`（`:366-368`；`blockString` 内部还会因 `blockQuote:false` 或值末空白落到引号形态，`:189-191`；folded 折叠后行仍超长时 `onOverflow` 触发 literal 回退，`:262-275,278-279`）。
  - 单引号形态在 `singleQuote===false`、implicitKey 含换行、或换行两侧有空白时 → 双引号（`singleQuotedString`，`:141-147`）。
  - `quotedString` 按引号出现情况选具体引号：有双无单选单、有单无双选双、其余听 `singleQuote` 选项（`:157-169`）。
  - PLAIN 不是“免死金牌”：implicitKey 含换行、flow 中含 flow 指示符（`,[]{}:` 相关）→ 引号（`plainString`，`:290-295`）；命中 plain 非法字符正则（行首指示符、`#`、结尾冒号/空白等）→ 引号或块（`:296-310`）；多行且 `type` 未显式钉成 PLAIN → 优先块（`:311-319`）；文档起始标记 `%`/`---`/`...` → 块或引号（`:320-327`，判据正则在 `:29`）；最后一道防线是 actualString 回读测试（`:332-337`）。
- **actualString 回读测试**：仅当走 string tag 的 `stringify()` 时 ctx 带 `actualString:true`（`src/schema/common/string.ts:4-12`，`:10`）。在 plain 文本产出后、折行之前，用 schema（及 compat）中所有 `default && tag!==str && test(str)` 判定它是否会被解析成非字符串；是就改走 `quotedString`（`src/stringify/stringifyString.ts:329-337`）。这是 `"42"`、`"true"`、长数字串被加引号的原因；用户自己 `new Scalar(42)` 等非字符串值不带 actualString，不会触发。

### 不变量 6：序列化形态选择/折行/回读验证三者的调用次序

见下文“次序问题 2”。

## 三、三个次序问题（答案来自代码执行路径，不是注释）

### 次序问题 1：一个 plain 标量在变成 `Scalar` 之前，依次经过哪些“它算什么”的判断

实际发生次序（每一跳都有代码位置）：

1. **词法层形态判定**：`lexer.document()` 按首字符分派（`src/parse/lexer.ts:222-265`），默认走 `plainScalar()`（`:262-264`）。这一跳只回答“这是一片 plain 词素”，不回答类型。引号（`:248-251`）、块标量（`:252-255`）在这里就分流到不同 token 类型，以后再无机会走隐式 `test`。
2. **Parser 层 CST 归类**：`Parser.next()` 把 `SCALAR`+值组装成 `{type:'scalar', offset, indent, source}`（`src/parse/parser.ts:212-215` 预告、`:200-205` 消费；对象由 `flowScalar()` 造，`:879-895`），并由 `blockMap`/`flowCollection` 状态机决定它是 key 还是 value（`:681-698`、`:820-832`）。**`ctx.atKey`（键/值位置）在这一层被结构确定**，compose 时由 `resolveBlockMap.ts:71,77` / `resolve-flow-collection.ts:123,129` 显式置位。
3. **props 收集**：`resolveProps()` 扫描该节点的 anchor/tag/`?`/注释（`src/compose/resolve-props.ts:52-174`）。这一跳确定有没有显式 tag、有没有 anchor、是不是 explicit key（`found`）。
4. **composeNode 分派**：`src/compose/compose-node.ts:47-84`，plain token 落到 `composeScalar`（`:57-63`）。
5. **文本归一化**：`resolveFlowScalar` 先做 fold-lines/去空白等，产出逻辑字符串 `value` 和 `type=PLAIN`（`src/compose/resolve-flow-scalar.ts:30-33,70-155`）。此时“值的字符串长相”定稿。
6. **tag 选择**（顺序见不变量 2）：`stringKeys` 短路 → 显式 tag `findScalarTagByName`（含 schema.tags 次序、knownTags 兜底）→ **仅 plain** 走 `findScalarTagByTest`，按 `schema.tags` 数组顺序找第一个 `default`/`'key'` 且 `test(value)` 命中的 tag（`src/compose/compose-scalar.ts:27-34,93-127`）。
7. **tag.resolve() 物化 JS 值**：`src/compose/compose-scalar.ts:38-48`，例如 int/float/bool/null 的 `resolve`（`src/schema/core/int.ts:57-74`、`src/schema/core/float.ts` 等）。

**至少两对交换会解析错（均已实测变异验证）：**

- **交换第 1 跳与第 6 跳**（让 quoted/block 形态也走 `findScalarTagByTest`：把 `src/compose/compose-scalar.ts:32-34` 的 `else if (token.type === 'scalar') … else tag = ctx.schema.scalar` 改成无条件 `findScalarTagByTest`）：双引号 `"42"` 会被 int tag 的 `test` 命中、resolve 成数字 `42`；`'0o17'` 变成数字 `15`；`"true"` 变成布尔。错误形态：**引号的“强制字符串”语义整体失效**，所有长得像数字/布尔/空值的标量都被强类型化。
- **交换第 6 跳里 schema.tags 的排列**（YAML 1.1 下把 `int` 挪到 `intOct` 之前，即交换 `src/schema/yaml-1.1/schema.ts:24-25` 中 `intOct` 与 `int` 的先后）：plain `017` 先命中十进制 int 的 `test`（`/^[-+]?[0-9][0-9_]*$/`，`src/schema/yaml-1.1/int.ts:72`），被解析成十进制 `17`，而规范要求八进制 `15`（原结果 15，变异后实测 17）。同类输入：`0777`（应 511）、带正号的 `+010` 都会错成十进制。反过来在 core schema 交换 `intOct`/`int` 无影响，因为 `0o17` 不匹配纯十进制 test——**这正说明“排列次序”这一跳的结果依赖具体 schema 内容，交换必须放在真实 schema 里讨论**。
- 附带第三对可证的交换：**第 2 跳的 atKey 置位与第 6 跳交换**会让 `default:'key'` 的 merge tag（`src/schema/yaml-1.1/merge.ts:25`）在值位置也参与 `test` 匹配，普通值 `x: <<` 会被解析成 merge 符号而不是字符串（实测当前是字符串 `<<`）。

### 次序问题 2：`stringifyString` 链上“选形态 / 折行 / 回读验证”的实际先后

实际次序（以一个真正的 string Scalar 走 plain 分支为例）：

1. **选形态（含回读验证）**：`stringifyString()`（`src/stringify/stringifyString.ts:343-388`）先按 `Scalar.type`（可能被控制字符规则覆盖，`:355-360`）选到 `plainString`。在 `plainString` 内部依次是：implicitKey/flow 硬约束（`:290-295`）→ plain 非法字符正则（`:296-310`）→ 多行块偏好（`:311-319`）→ 文档标记检查（`:320-327`）→ **回读验证**：用未折行的逻辑文本 `str` 过一遍 schema/compat 的 `test`，会解析成非字符串就立刻改走 `quotedString`（`:329-337`）。
2. **折行最后**：plain 通过全部检查后才 `foldFlowLines(str, indent, FOLD_FLOW, getFoldOptions(ctx,false))`（`src/stringify/stringifyString.ts:338-340`）。引号形态内部同样是“先定引号/转义、后 foldFlowLines”：双引号 `doubleQuotedString` 先做 JSON 转义和 `\n` 改写（`:50-135`），再 `foldFlowLines(…, FOLD_QUOTED, …)`（`:136-139`）；单引号 `:149-155`（FOLD_FLOW）；块是先构造 header/折叠内容再 `foldFlowLines(…, FOLD_BLOCK, …)`（`:256-279`）。

即：**形态选择（其中嵌着回读验证）→ foldFlowLines**。

**哪一对不能交换，为什么：**

- **回读验证不能挪到 foldFlowLines 之后**（在概念上必须用“逻辑文本”而不是“排好版的物理文本”去问 schema）。原因有两层：
  1. fold 依赖形态：三种形态用三种折叠模式（`FOLD_FLOW`/`FOLD_QUOTED`/`FOLD_BLOCK`，`src/stringify/stringifyString.ts:138,154,272`），折行是“形态已定稿之后”的排版动作；先折行就得在还没决定 plain/quote/block 时猜一种模式，plain 的折点空格处理与双引号的转义换行（`src/stringify/foldFlowLines.ts:75-91,114-128`）互不相容。
  2. 回读验证的问题是“**这段逻辑内容**会不会被解析成数字/布尔”，答案只取决于内容本身。内置 tag 的 `test` 都是锚定整段文本的（例如 int 是逐字符判断 `src/schema/core/int.ts:31-41`，float 用 `^…$` 正则 `src/schema/core/float.ts:31-32`），而 fold 只在词间空格处插入 `\n`+缩进。因此**在当前内置 tag 集合下**，把检查挪到折行后实测结果相同（我做过变异：把 `:332-340` 改成“先 fold 再对 folded text 跑 test”，全量 965 个测试仍全绿）——这是经验事实，不是设计许可。它之所以不能交换，是因为该检查的输入必须是语义文本：任何能在单行匹配的非锚定/含空格 `test`（自定义 tag 即可提供），折行引入的 `\n` 都会改变判定，产生“明明回读是数字却以 plain 输出、解析回来类型改变”的错误输出。把检查放在折行前，用未排版文本一锤定音，正确性与排版解耦。
- **形态选择与折行同样不能交换**：plain 根本不该出现未转义的 `\n` 之外的引号语义；若先按某种模式折行再决定形态，plain 会拿到双引号专属的转义折行（FOLD_QUOTED 会产出行尾 `\`，`src/stringify/foldFlowLines.ts:114-128,145`），回读即坏；块形态的更缩进行保护（`consumeMoreIndentedLines`，`:70-73,152-173`）也是 blockString 选定后才有意义。
- 实证“检查必须存在”的简单例子：把 `:332-337` 的整段 actualString 检查删掉，`YAML.stringify('42')` 输出裸 `42`，`YAML.parse` 回来变成 number——类型在往返中改变。

### 次序问题 3：同一 map 里 `<<` 合并键与普通键写入结果对象的先后

- Pair 物化的顺序 = CST block-map items 的顺序 = `YAMLMap.values` 这个内部 Map 的插入顺序：`resolveBlockMap` 逐个 item 组 Pair 并 `map.set(pair)`（`src/compose/resolve-block-map.ts:27,129-132`；flow 在 `src/compose/resolve-flow-collection.ts:194-209`）。`YAMLMap.toJS` 再按这个顺序迭代 `this.values.values()`（`src/nodes/YAMLMap.ts:244-245`），每个 pair 进 `addPairToJSMap`（`src/nodes/addPairToJSMap.ts:10-45`）。
- 因此“合并写键”和“普通写键”谁先谁后，**完全由源文档中该 pair 出现的行序决定**，没有第二处重排。合并动作本身在 `addMergeToJSMap`/`mergeValue`（`src/schema/yaml-1.1/merge.ts:42-87`）：
  - 合并对已有键“只补不覆盖”：`Map` 用 `if (!map.has(key)) map.set(...)`（`:69-70`），普通对象用 `!Object.prototype.hasOwnProperty.call(map, key)`（`:73-84`）。
  - 普通键对已有键无条件覆盖（`map.set`/`map[k]=v`，`src/nodes/addPairToJSMap.ts:23-41`）。
- 组合效应（实测验证）：
  - `x: 1` 在前、`<<: {x:2}` 在后：合并看到 `x` 已存在，跳过 → `x=1`（`merge1` 实测）。
  - `<<: {x:2}` 在前、`x: 1` 在后：普通键直接覆盖 → `x=1`。
  - 所以普通键永远赢；多个合并源之间则按序列顺序“先到先得”：`<<: [{b:1},{b:2}]` → `b=1`（序列分支就是 `for (const it of source) mergeValue(...)`，`src/schema/yaml-1.1/merge.ts:50-51`）。

**把次序颠倒过来，哪一类输入结果会变**（已实测变异）：把 `src/schema/yaml-1.1/merge.ts:51` 的正向迭代 `for (const it of source) mergeValue(...)` 改成反向 `for (const it of source.slice().reverse()) …`，则 `<<: [{a:1,b:1},{b:2,c:2}]` 的结果从 `{a:1,b:1,c:2}` 变成 `{a:1,b:2,c:2}`——**受影响的是“一个 `<<` 的值是序列、且序列中多个 map 存在同键冲突”的输入**（含 alias 序列 `<<: [*first,*second]`）。YAML merge 规范要求序列中靠前的 map 胜出，颠倒后变成靠后的胜出。单个 map 的 merge 与普通键之间的先后则不受这行影响（普通键的无条件覆盖保证结果与行序无关）。

## 四、三个风险点（分布在三个不同文件）

### 风险点 1（`src/parse/lexer.ts`）：不支持“孤立 CR”作为换行，但词法器静默把它当普通字符，结构被悄悄改坏

- **现象**：YAML 1.2 规定换行可以是 LF / CR / CRLF 三种。本库只把 LF 和 CRLF 当换行：`newline()` 仅认 `\n` 与 `\r\n`（`src/parse/lexer.ts:567-572`）；孤立 `\r` 只在 `isEmptyChar` 里被当“空白字符”（`:23-31`），既不推进缩进状态也不触发行首逻辑。
- **触发条件**：输入含不紧跟 LF 的 `\r`（老式 Mac 换行、拼接/截断产生的 CR、被网关规范化过一半的文档）。
- **最小复现**（在仓库根目录直接跑，无需写文件）：
  ```bash
  node -e "import('./src/index.ts').then(Y => {
    console.log(JSON.stringify(Y.parse('- a\r- b\r')))   // 期望 ['a','b']
    console.log(JSON.stringify(Y.parse('[1,\r2]')))      // 期望 [1,2]
    console.log(JSON.stringify(Y.parse('a: b\rc\n')))    // 期望 {a:'b', ... }
  })"
  ```
  实测输出：`["a\r- b\r"]`（两个 seq 项被吃成一个标量）、`[1,"\r2"]`（flow seq 第二项变成字符串）、`{a:"b\rc"}`（`c` 没有成为第二个键）。错误数组为空——不是“报错拒绝”，而是静默产出结构不同的 AST。
- **判断：设计取舍而非缺陷，但取舍的实现方式有缺陷。** 不支持孤立 CR 本身可以接受（性能与实现简单），合理的做法应是像 tab 缩进那样发解析错误（对比 `resolve-props.ts:66-70,190-196` 的 `TAB_AS_INDENT`），让调用方在 `doc.errors` 里看到；现状是词法器把 CR 当空白、parser 无法感知断行，用户拿到的是“无错误但错误”的结果。依据：`src/parse/lexer.ts:23-31` 主动把 CR 列入空白集合却没有任何告警路径；同文件 `:567-572` 明确只处理两种换行。

### 风险点 2（`src/doc/applyReviver.ts`）：循环 YAML + reviver 无法被短路，必爆原生栈溢出

- **现象**：库完整支持 alias 表达的循环结构（`ToJSContext.anchors` 让 map/seq 成环，见不变量 3）。但 `YAML.parse(src, reviver)` 在 toJS 之后还要用 `applyReviver` 对结果做一次 ECMA-262 reviver 行走（`src/doc/Document.ts:341-343`），而 `applyReviver` 对数组/Map/Set/普通对象都是无“已访问”集合的递归（`src/doc/applyReviver.ts:28-61`）。循环结果上它无限递归，最终抛裸的 `RangeError: Maximum call stack size exceeded`，这个错误既不是 `YAMLParseError`，也不受 `logLevel` 控制，reviver 想用“把循环容器替换成别的值”来规避也没机会（父对象在递归子值时就先爆了，替换逻辑在 `:61`，根本到不了）。
- **触发条件**：文档含自引用 alias（`a: &a [*a]` 或 `a: &a {x: *a}`）且调用 `YAML.parse` 时传了函数 reviver。
- **最小复现**：
  ```bash
  node -e "import('./src/index.ts').then(Y => {
    console.log(Y.parse('a: &a [*a]\n', (k,v) => Array.isArray(v) ? {fixed:true} : v))
  })"
  ```
  不带 reviver 时同输入能正常返回自引用数组；带 reviver 即 `RangeError`。
- **判断：缺陷。** JSON.parse 的 reviver 契约里不存在循环输入，无法直接对照；但本库既然把“循环别名”作为一等能力支持（stringify 侧还专门能再序列化循环），parse 侧在最常用的 `YAML.parse(src, reviver)` 入口对合法输入给出不可捕获为库错误类型的原生栈溢出，属于能力组合上的漏洞。最小修复方向（本次不改）：在 `applyReviver` 增加 `WeakSet<object>` 参数，遇到已在当前递归栈中的容器时直接 `reviver.call(obj, key, val)` 不再下钻；`Document.toJS` 在 `src/doc/Document.ts:341-343` 传入即可。该改动只作用于 toJS 之后的 reviver 阶段，不触碰任何 CST token 或 AST `range`，因此不影响 CST↔AST 的 offset/range 对应关系。

### 风险点 3（`src/nodes/toJS.ts`）：`maxAliasCount` 按扇出乘积估算，101 个无害标量别名也被当成攻击拒绝

- **现象**：阈值检查是 `data.count * data.aliasCount > maxAliasCount`（`src/nodes/toJS.ts:39-46`），`count` 是该 anchor 被解析的次数，`aliasCount` 由 `#getAliasCount` 递归估算子树别名扇出（`:51-69`）。对**标量** anchor，展开结果永远只是值的复用（字符串/数字无需复制内存），但计数逻辑不区分叶子与集合：`#getAliasCount` 对非 Alias/Pair/Array 节点一律返回 1（`:68`），于是“同一标量被引用 101 次”恰好 `101 * 1 > 100` 被拒绝。
- **触发条件**：一个普通标量 anchor 被 alias 引用超过 100 次（模板化配置、枚举展开、测试固件里很常见）。
- **最小复现**：
  ```bash
  node -e "import('./src/index.ts').then(Y => {
    const src = ['a: &x 1', ...Array.from({length:101},(_,i)=>'k'+i+': *x')].join('\n')
    console.log(Y.parse(src))
  })"
  ```
  实测抛 `ReferenceError: Excessive alias count indicates a resource exhaustion attack`；改成 50 个则正常；把 `maxAliasCount` 调高或设为 -1 可绕过。
- **判断：有意的防御性取舍，但存在明确的误杀面。** 这个乘积是为了用线性遍历近似 billion-laughs 的指数展开（`#getAliasCount` 沿集合取 alias 扇出的乘积近似，`:51-68`），宁枉纵是安全姿态，默认 100，选项本身公开在 `src/options.ts:197`，默认值取值于 `src/nodes/toJS.ts:19`。但它把“别名引用次数”和“实际物化字节数”混为一谈：真正的放大只发生在集合 anchor 上（YAMLMap/YAMLSeq 的 toJS 会重建容器），标量别名零放大。依据就在 `src/nodes/toJS.ts:39-47` 与 `:68`：计数对叶子与容器同权。更精细的做法是让 `#getAliasCount` 对标量 anchor 返回 1 的同时，把阈值检查限定在“anchor 节点是集合”时，或按已物化对象数计数；这属于安全/易用权衡，不宜在无测试集（submodule 缺失）的情况下贸然改默认行为，故仅记录不改。

## 五、钉死不变量的新测试，以及如何让它变红

- 新增测试文件：`tests/merge-order-invariant.ts`（3 个用例，随验收命令一起跑）。它钉死的是“次序问题 3 / merge 语义不变量”：**`<<` 的序列值按源顺序合并，靠前的 map 在键冲突时胜出；同 map 的显式键永远胜出**。用例分别覆盖字面量序列、alias 序列、显式键冲突三种情况。
- 当前代码下该文件绿（已运行 `npx vitest run tests/merge-order-invariant.ts`，3/3 通过）。
- **让它变红的具体改法（已亲自验证）**：把 `src/schema/yaml-1.1/merge.ts:51`
  ```ts
    for (const it of source) mergeValue(doc, ctx, map, it, isPlainObject)
  ```
  改为
  ```ts
    for (const it of source.slice().reverse())
      mergeValue(doc, ctx, map, it, isPlainObject)
  ```
  保存后跑 `npx vitest run tests/merge-order-invariant.ts`：前两个用例失败（实测 `merge sequence: earlier sources override later ones` 与 alias 版本都收到 `b:2` 而不是 `b:1`，2 failed / 1 passed）。改回后恢复全绿。验证完成后源码已还原，`git diff src/` 为空。
- 选择钉这一条的理由：这是纯顺序不变量，断言用最终 JS 值表达、不依赖 range 或内部结构；一行改动即可翻转，且红/绿结论我都在当前代码上实际跑过。

## 六、改动边界与验收

- 源码 `src/`：**零改动**（未做可选最小修复；风险点 2 的修复建议见上，刻意保持对外行为与 CST/AST range 对应关系不变）。
- 测试：仅新增 `tests/merge-order-invariant.ts`，未改任何现有断言；未动 `package.json` scripts；未引入依赖；未拉取 `tests/yaml-test-suite/` 与 `tests/json-test-suite/` submodule。
- 验收命令（与任务要求一致）：
  `npx vitest run --reporter=dot --exclude 'tests/**/*-test-suite.ts' 2>&1 | tail -20`
  结果：**22 个测试文件、968 个用例全部通过**（原 21 文件/965 + 新增 1 文件/3）。
