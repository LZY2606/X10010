# `yaml` 解析/序列化链路分析

> 行号对应交付时仓库（`yaml@3.0.0-2`）里的代码。所有结论都可用
> `node --experimental-strip-types` 直接跑探针复现；新增钉死测试见
> `tests/merge-order-invariants.ts`。

## 1. 主干调用链：`YAML.parse(src)` 从入口到返回值

### 1.1 入口装配（`src/public-api.ts`）

1. `parse(src, reviver?, options?)`：`src/public-api.ts:123`。第 129–134 行先归一化
   `reviver`（第二参数可以是函数，也可以直接是 options 对象）。
2. 第 136 行调用 `parseDocument(src, options)` 拿到一篇
   `Document.Parsed`；**此时只做词法/CST/AST 构建，不产生 JS 值**。
3. 第 138 行把 `doc.warnings` 逐条交给 `warn(doc.options.logLevel, …)`
   （`src/log.ts:7`，仅 `warn`/`debug` 级别才输出）。
4. 第 139–142 行处理致命错误：`doc.errors.length > 0` 时，`logLevel !==
   'silent'` 就 `throw doc.errors[0]`；`'silent'` 则把 `doc.errors = []`
   清空并继续（所以 silent 下非法 YAML 会返回“尽力解析”的值）。
5. 第 143 行 `doc.toJS({ reviver, ...options })` 才是把 AST 变成 JS 值的地方；
   返回值就是它的结果（可选再过一遍 reviver）。

`parseDocument`（`src/public-api.ts:64`）装配出三件套：

- `new Parser(lineCounter?.addNewLine)`（第 69 行）；
- `new Composer(options)`（第 70 行）；
- 第 75–79 行 `for (const _doc of composer.compose(parser.parse(source), true,
  source.length))`：`Parser.parse` 返回一个数组（已物化的 CST），`Composer.compose`
  以 `forceDoc=true`、`endOffset=source.length` 消费它。第 81–90 行保证只取第一篇
  文档，多篇且非 silent 时追加一条 `MULTIPLE_DOCS` 错误。
- 第 93–96 行用 `LineCounter` 给错误补行列和源码指针（`prettifyError`，
  `src/errors.ts:63`）。

### 1.2 词法：`lex()` 切词素（`src/parse/lexer.ts`）

- 入口 `lex(source)`：`src/parse/lexer.ts:59`。校验是字符串（第 60 行），new 一个
  `Lexer`，用 `stream → document → flow` 三个状态（第 63–76 行）扫到末尾，返回
  `lexer.tokens: string[]`。
- 输出是“源文本切片 + 4 个控制字符”：普通词素就是 `source` 的子串；控制字符定义在
  `src/parse/cst.ts:146-155`（`BOM='\uFEFF'`、`DOCUMENT='\x02'`、
  `FLOW_END='\x18'`、`SCALAR='\x1f'`）。
- 标量是**两个词素**：先 push `SCALAR` 哨兵，再 push 标量原文。块标量在
  `src/parse/lexer.ts:496-497`（`blockScalar()`，第 423 行起，按 `indentNext` 吃到
  缩进结束），plain 标量在 `src/parse/lexer.ts:534-535`（`plainScalar()`，第 500
  行起；冒号后必须跟空白、`#` 前必须有非空白等边界都在这里切）。单/双引号走
  `quotedScalar()`（第 391 行），别名 `*name` 在 `document()`/`flow()` 里用
  `until(isNotAnchorChar)` 整段吞掉。
- 换行只认 LF 和 CRLF：`newline()`（第 567–572 行）对 `\n` 计 1、对 `\r\n` 计 2，
  其余（裸 `\r`）返回 0，不产生 `newline` 词素（见 §4 风险点一）。

### 1.3 CST：`Parser.next()` 攒 token（`src/parse/parser.ts`）

- `Parser.parse(source)`：`src/parse/parser.ts:187`。第 189 行
  `for (const lexeme of lex(source)) this.next(lexeme)`，最后第 190 行
  `return this.end()`。**Parser 不调用 `lex()` 以外的外部状态**；`offset` 字段
  （第 156 行）在 `next()` 里逐词素累加，等于是“当前词素起点的全局偏移”。
- `next(source)`：`src/parse/parser.ts:196`。
  - 第 200–205 行：若上一个词素是 `SCALAR` 哨兵（`atScalar`），复位后立刻
    `step()` 一次，再 `offset += source.length` 返回。也就是说哨兵本身不吃字符，
    真正的标量文本在下一次 `next()` 里被当成 `scalar` 类型处理。
  - 否则第 207 行 `tokenType(source)`（`src/parse/cst.ts:191`，按值/首字符把词素
    归类为 `doc-start`、`map-value-ind`、`alias`、`single-quoted-scalar`……）。
    识别不出时第 208–211 行直接压一个 `{type:'error'}` token；`scalar` 类型在
    第 212–215 行特殊处理（置 `atScalar=true`，等下一跳）；其余第 217–239 行
    `step()` 后更新 `atNewLine`/`indent`/`offset`。
- `step()`：`src/parse/parser.ts:259`，按栈顶 token 类型分派：空栈→`stream()`
  （第 398 行，处理 directive/BOM/`---`，第 408–417 行把 `document` 压栈）；
  栈顶是 `document`→`document()`（第 427 行）；`scalar` 等→`scalar()`
  （第 459 行，遇到行内 `:` 会就地把标量改造成 `block-map`，第 471–478 行）；
  `block-scalar`→`blockScalar()`（第 482 行）；`block-map`/`block-seq`/
  `flow-collection` 分别是第 510/733/784 行。
- **完整 CST token 的交出时刻**：`pop()`（`src/parse/parser.ts:302`）。当一个结构
  遇到换行/缩进回落/结束指示符时被弹出；第 313–314 行，栈空时 `this.tokens.push
  (token)`——这是 Parser 向外交付一个完整 `document`/`directive`/`error` 的唯一
  出口。栈非空时不交付，而是挂到父节点上（第 326–327 行 `top.value = token`、
  第 332–365 行塞进 block-map/block-seq/flow-collection 的 item）。
- `end()`：`src/parse/parser.ts:244`，第 245 行把栈里残余结构逐个 `pop()` 出来，
  最终 `return this.tokens`（第 246 行）。所以词法错误不会 throw，而是变成
  `{type:'error', offset, message, source}`（第 210、307、450 行）。

### 1.4 Document：`Composer.compose()` 切文档（`src/compose/composer.ts`）

- `compose(tokens, forceDoc=false, endOffset=-1)`：`src/compose/composer.ts:156`。
  第 162 行 `for (const token of tokens) this.next(token)`，第 163 行
  `return this.end(forceDoc, endOffset)`。**一个 CST `document` token 对应一篇
  Document**，切换边界完全由 token 类型决定。
- `next(token)`：`src/compose/composer.ts:167`：
  - `'directive'`（第 170 行）：交给 `this.directives.add()`（`%TAG`/`%YAML`，
    `src/doc/directives.ts:75`），并压进 `prelude`；
  - `'document'`（第 179 行）：第 180–185 行调 `composeDoc(options, directives,
    token, this.onError)` 得到一篇 AST 文档；第 186–191 行检查“有 directive 却缺
    `---`”；第 192 行 `decorate(doc,false)` 把累计的 comment/errors/warnings 挂到
    本文档；第 193–194 行把上一篇 `this.doc` push 进 `docs`，当前文档成为
    `this.doc`——**这就是“从 token 流里切出一篇”的动作**；
  - `'error'`（第 205 行）：在 directive 区或还没文档时进 composer 级 `errors`，
    否则直接挂到 `this.doc.errors`（第 214–215 行）；
  - `'doc-end'`（第 218 行）：置 `doc.directives.docEnd`，用 `resolveEnd`
    吃尾部注释，第 238 行把 `doc.range[2]` 钉到文件尾偏移。
- `end(forceDoc,endOffset)`：`src/compose/composer.ts:258`。有残留文档就第 260
  行收尾 push；否则 `forceDoc`（`parseDocument` 恒为 true）时第 263–275 行凭空造
  一篇 `new Document(undefined,{_directives})`，`doc.range=[0,endOffset,endOffset]`
  （第 272 行）——空输入/纯注释输入也保证返回一篇文档。
- `onError(source,code,message,warning?)`：`src/compose/composer.ts:93`。**第四个
  参数 `warning` 决定分流**：真值 `new YAMLWarning` 进 `this.warnings`
  （第 95 行），否则 `new YAMLParseError` 进 `this.errors`（第 96 行）。

### 1.5 `composeDoc`：一篇文档的 AST 装配（`src/compose/compose-doc.ts`）

- 签名 `composeDoc(options, directives, {offset,start,value,end}, onError)`：
  `src/compose/compose-doc.ts:18`。
- 第 24–25 行 new 出 `Document(undefined, {_directives})`——构造函数
  （`src/doc/Document.ts:80`）据此建 `Directives`、`Schema` 与默认 options
  （`logLevel:'warn'`、`strict:true`、`stringKeys:false` 等，第 107–118 行）。
- 第 26–32 行建 `ComposeContext { atKey:false, atRoot:true, directives, options,
  schema }`，这是后续所有 `composeNode` 共享的可变上下文（`atKey` 在拼 key 时翻成
  true）。
- 第 33–40 行 `resolveProps(start,{indicator:'doc-start',...})`（
  `src/compose/resolve-props.ts:14`）从 CST `document.start` 里剥出 anchor/tag/
  注释/`---` 指示符（`found`）；第 41–53 行若找到 `---` 置 `docStart`，并检查块集合
  不能与 `---` 同行。
- 第 54–56 行是**根节点的诞生点**：有根 CST token 就 `composeNode(ctx, value,
  props, onError)`；没有就 `composeEmptyNode(ctx, props.end, start, null, props,
  onError)`（空文档根是一个 `null` Scalar）。
- 第 58–61 行用根节点的 `range[2]` 作为 `contentEnd`，`resolveEnd(end,…)`
  吃文档尾部注释，最终 `doc.range = [offset, contentEnd, re.offset]`。
  **这一跳定下来的是：根 AST 节点、文档三元组 range、根注释。**

### 1.6 `composeNode`：按 CST token 类型分派（`src/compose/compose-node.ts`）

`composeNode(ctx, token, props, onError)`：`src/compose/compose-node.ts:37`。
`props` 是 `resolveProps` 的产物（`anchor`、`tag`、`comment`、`spaceBefore`、
`end`）。分派在第 47–84 行：

- `'alias'` → `composeAlias`（第 136 行）：new `Alias(source.substring(1))`
  （剥掉 `*`），校验空名/冒号结尾警告（第 142–150 行），range 由
  `[offset, offset+source.length, resolveEnd(...).offset]` 给出（第 151–153 行）。
  若还带 anchor/tag，第 50–55 行报 `ALIAS_PROPS`。**这一跳不解析锚点，只记录
  `alias.source` 字符串**——锚点能不能找到要等 `toJS`。
- `'scalar' | 'single-quoted-scalar' | 'double-quoted-scalar' | 'block-scalar'`
  → `composeScalar(ctx, token, tag, onError)`（第 61 行）；第 62 行把 anchor 名
  （剥 `&`）挂到节点上。
- `'block-map' | 'block-seq' | 'flow-collection'` →
  `composeCollection(...)`（第 68 行），同样在第 69 行挂 anchor。深嵌套导致的栈
  溢出在第 70–74 行被 catch 成 `RESOURCE_EXHAUSTION` 错误，不让进程崩。
- 分派失败（第 76–83 行，含 CST error token）时 `isSrcToken=false`，第 85 行用
  `composeEmptyNode` 兜底。

收尾在第 86–104 行：空 anchor 报错；`atKey && options.stringKeys` 且节点不是
string Scalar 时报 `NON_STRING_KEY`（第 88–97 行，注意它只是报错，不改变节点值）；
`spaceBefore`/`commentBefore`/`comment` 落到节点上；`keepSourceTokens` 时挂
`srcToken`（第 104 行）。**这一跳定下来的是：AST 节点类别、anchor、注释、key 位置
上的 stringKeys 校验。**

`composeEmptyNode`：`src/compose/compose-node.ts:108`。它没有真实源文本，于是
第 116–121 行伪造一个 `{type:'scalar', indent:-1, source:''}` 的 `FlowScalar`，
其 `offset` 来自 `emptyScalarPosition(offset, before, pos)`
（`src/compose/util-empty-scalar-position.ts:3`：从 `before` 数组里往回剥
space/comment/newline，再跨过纯空格，把“空标量”定位到空白段之后），然后照常走
`composeScalar`（第 122 行）。有注释时第 129–132 行把 `node.range[2]` 撑到
`props.end`，让注释被包进节点 range。**空节点的 start/value-end 因此可以等于同一个
偏移（长度为 0），但仍是源里的真实字符位置。** 实测 `b:` 的值节点 range 为
`[7,7,7]`。

### 1.7 `composeScalar`：形态解码 → 选 tag → `resolve()`（`src/compose/compose-scalar.ts`）

`composeScalar(ctx, token, tagToken, onError)`：`src/compose/compose-scalar.ts:10`。
严格分三步，顺序不能换：

1. **形态解码（只看引号形态，不看 schema）**：第 16–19 行，块标量走
   `resolveBlockScalar(ctx, token, onError)`
   （`src/compose/resolve-block-scalar.ts:7`：解析 header 的 `|/>`、显式缩进、
   chomp（`-`/`+`/clip），折叠空白并产出 `{value,type,comment,range}`），其余走
   `resolveFlowScalar(token, strict, onError)`
   （`src/compose/resolve-flow-scalar.ts:14`：`scalar`→`PLAIN` +
   `plainValue/foldLines`（第 30–32、70 行），单引号→`QUOTE_SINGLE`
   （第 35–37 行，去首尾引号并把 `''` 折叠成 `'`），双引号→`QUOTE_DOUBLE`
   （第 40–42 行，处理转义））。两者都用 `resolveEnd` 把尾部注释和 node-end
   算出来，返回 `range:[offset, valueEnd, re.offset]`（第 60–67 行）。
2. **显式 tag 字面量解析**：第 21–25 行，若有 tag 词素，调
   `directives.tagName(tagToken.source, …)`（`src/doc/directives.ts:126`：把
   `!!int`、`!foo`、`!<…>`、`%TAG` 声明的 handle 解析成完整 tag URI；`'!'`
   原样返回表示非特定 tag）。
3. **选 ScalarTag 并 `resolve`**：第 27–48 行，选择规则（优先级从高到低）：
   - 第 28–29 行：`options.stringKeys && ctx.atKey` → 直接用 `schema.scalar`
     （string tag，`src/schema/common/string.ts:4`），**显式 tag 也压不过它**，
     只会附带给一条 `NON_STRING_KEY` 警告级校验；实测 `!!int 5:` 配
     `stringKeys:true` 键仍是字符串 `"5"` 且报 `NON_STRING_KEY`；
   - 第 30–31 行：有显式 tag 名 → `findScalarTagByName`（第 59 行）：`'!'`→string
     （第 66 行）；否则按 `schema.tags` **数组排列次序**找 `tag===tagName`
     （第 68–73 行，带 `default && test` 的先收集，第 74 行再让 test 决定）；都没
     命中再查 `schema.knownTags[tagName]`（第 75–81 行，命中后以
     `default:false, test:undefined` 追加进 `schema.tags`，保证能 stringify 但
     以后不再隐式命中）；再没有就第 82–88 行报 `TAG_RESOLVE_FAILED`
     （除 `tag:yaml.org,2002:str` 外是 **warning**）并退回 string；
   - 第 32–33 行：无显式 tag 且 token 是 `'scalar'`（plain）→
     `findScalarTagByTest`（第 93 行）：从 `schema.tags` 里过滤
     `default:true`（或 key 位置上的 `default:'key'`）且 `test(value)` 为真的第
     一个（第 99–112 行，按数组次序），找不到退回 string；第 114–124 行，若配置了
     `schema.compat`，用 compat 再试一次，两者结论不一致时只发 **warning**
     （“may be parsed as either…”），**不改变选中的 tag**；
   - 第 34 行：非 plain（单/双引号、块标量）又没显式 tag → 直接 `schema.scalar`。
     所以引号/块形态本身就锁定字符串，schema `test` 根本不会被执行；实测
     `'42'`、`| 42` 都是 string，而 plain `42` 是 number。
   第 37–48 行调中选 tag 的 `resolve(value,onError,options)` 得到 JS 原始值
   （int 的 `parseInt`、bool 的布尔、string 的原样字符串……），抛错被 catch 成
   `TAG_RESOLVE_FAILED` 并用裸字符串兜底。
4. 第 49–54 行回填：`scalar.range=range`、`scalar.source=value`（**折叠后**的
   逻辑值，非原文）、`scalar.type=type`、显式 tag 名写进 `scalar.tag`、
   `tag.format` 写进 `scalar.format`、注释写进 `scalar.comment`。

**这一跳定下来的是：标量的字符串逻辑值、引号/块 type、命中的 tag、JS 原始值与
range。**

集合侧的对应逻辑在 `composeCollection`（`src/compose/compose-collection.ts:54`）：
第 62–66 行同样先解析显式 tag 名；第 93–101 行无 tag / `'!'` / 形态匹配
（map tag+map 形态等）走通用 `YAMLMap/YAMLSeq`；第 103–105 行才在 `schema.tags`
里按名找集合 tag；找不到再查 `knownTags`（第 107–130 行，形态不符给
`BAD_COLLECTION_TYPE` **warning**）；自定义集合 tag 的 `resolve()` 在第 134–139
行执行，可把集合替换成任意节点。block-map 的实际递归在
`resolveBlockMap`（`src/compose/resolve-block-map.ts:14`）：第 31–38 行解析 key
props、第 71–77 行在 `ctx.atKey=true` 下递归 `composeNode` 出键、第 79–80 行
`map.has(keyNode)` 时报 `DUPLICATE_KEY`、第 83–90 行解析 value props、
第 112–132 行递归出值并 `new Pair(keyNode,valueNode)` + `map.set(pair)`，第 157
行给出 `map.range=[bm.offset, offset, commentEnd ?? offset]`。

### 1.8 `Document.toJS`：AST → JS 值（`src/doc/Document.ts` + `src/nodes/`）

`Document.toJS(opt)`：`src/doc/Document.ts:335`。

- 第 337 行 `const ctx = new ToJSContext(opt)`（`src/nodes/toJS.ts:8`），这是整棵
  树共享的递归状态，角色有三个：
  - `anchors: Map<Node, {aliasCount,count,res}>`（第 9–10 行）：AST 锚点节点 →
    “已转出的 JS 值 + 别名展开计数”。`setAnchor`（第 22–26 行）首次出现记
    `{aliasCount:0,count:1,res}`，再次出现只更新 `res`；
  - `aliasResolveCache?: Node[]`（第 12 行）：`Alias.resolve` 首次调用时用
    `visit(doc)` 把所有带 anchor 的节点和 Alias 按文档顺序缓存（
    `src/nodes/Alias.ts:73-79`），之后复用；
  - `maxAliasCount`（第 15、19 行，默认 100）与 `mapAsMap`（第 13、18 行）：
    别名炸弹开关与集合落地类型。
- 第 338 行 `this.value.toJS(this, ctx)` 递归出根 JS 值；第 339–340 行在全部递归
  完之后，按 anchor 出现顺序回调 `opt.onAnchor(res, count)`；第 341–343 行可选套
  reviver。

各节点的 `toJS`：

- `Scalar.toJS`：`src/nodes/Scalar.ts:98`。有 anchor 时第 99–101 行**直接 set**
  一个 `{aliasCount:0,count:1,res:this.value}`（标量不可能参与循环，所以没有走
  `setAnchor` 的更新分支）；返回 `this.value`（第 102 行）——即第 1.7 步 tag
  `resolve` 已经算好的原始值。
- `YAMLMap.toJS`：`src/nodes/YAMLMap.ts:221`。第 235–242 行决定容器：显式
  `Type`/`mapAsMap`→`Map`，否则 `{}` 且 `isPlainObject=true`；第 243 行有 anchor
  先 `ctx.setAnchor(this, map)`——**先把空容器登记进 anchors，再填内容**，这样
  alias 指回该 map 时拿到的就是同一个（可成环的）对象；第 244–245 行按
  `this.values.values()`（即 Pair 插入顺序）逐个
  `addPairToJSMap(doc,ctx,map,pair,isPlainObject)`。
- `YAMLSeq.toJS`：`src/nodes/YAMLSeq.ts:185`。有 anchor 时同样先建空数组并
  `setAnchor` 再 push（第 187–193 行），无 anchor 时第 194 行直接
  `Array.from(this, item => item.toJS(...))`。
- `Alias.toJS`：`src/nodes/Alias.ts:92`。第 96 行 `this.resolve(doc,ctx)` 找到
  锚点 AST 节点，找不到第 97–100 行抛
  `ReferenceError('Unresolved alias (the anchor must be set before the alias)')`；
  找到后第 102 行 `ctx.resolveAlias(doc, source)`：
  `ToJSContext.resolveAlias`（`src/nodes/toJS.ts:28`）——anchor 还没转过就第 30–33
  行**现场递归 `source.toJS`**（前向引用因此天然支持，只要 anchor 在文档里出现在
  后即可），第 39–47 行做计数防护（见 §2.3），最后返回缓存的同一 `res`。
- **`addPairToJSMap`：键值真正落地的一跳**（`src/nodes/addPairToJSMap.ts:10`）。
  传入：`doc`、`ctx`、目标 `map`、当前 `Pair {key,value}`、`isPlainObject`。
  分三条路：
  1. 第 17 行：`'addToJSMap' in key` 且定义了 → 调
     `key.addToJSMap(...)`（自定义/merge Scalar 的钩子，
     `src/schema/yaml-1.1/merge.ts:28-32` 里 `<<` 的 resolve 就把这个钩子挂在
     Scalar 上）；
  2. 第 19–20 行：否则若 `isMergeKey(doc,key)`（
     `src/schema/yaml-1.1/merge.ts:35`：键值是 `<<` symbol、或是无类型/plain 且值为
     `'<<'` 的 Scalar，并且 schema 里启用了 default merge tag）→
     `addMergeToJSMap`（merge.ts:43）：把值（map/alias/seq of maps）展开，且
     **只填目标 map 里还不存在的键**（Map：`if(!map.has(key)) map.set`，
     merge.ts:70-71；普通对象：
     `if(!Object.prototype.hasOwnProperty.call(map,key))`，merge.ts:73）；
  3. 第 21–42 行：普通键。第 22 行 `key.toJS` 取 JS 键；Map 第 23–24 行
     `map.set(jsKey, value.toJS())`（**无条件覆盖**）；Set 第 25–26 行 `add`；
     普通对象第 28 行 `stringifyKey` 把非字符串键序列化成字符串（对象键发
     mapKeyWarned 警告，`src/nodes/addPairToJSMap.ts:62-68`），第 30–41 行写入，
     其中 `__proto__`/`constructor`（第 32–33 行）以及非字面量对象上的键碰撞
     （第 31 行）改走 `Object.defineProperty`，避免原型污染。
  **这一跳定下来的是：目标容器里一个键的最终归属——merge 只补缺失键，普通键一律
  覆盖，写入位置就是 Pair 在文档里的迭代位置（§3.3）。**

### 1.9 反向链：`YAML.stringify` → 文档文本（`src/stringify/`）

- `stringify(value,…)`：`src/public-api.ts:173`。第 204–207 行 `undefined` 默认
  直接返回 `undefined`；第 208 行 value 已是 `Document` 且无 replacer 时直接
  `value.toString(options)`；否则第 209 行 `new Document(value,replacer,options)
  .toString(options)`，经 `NodeCreator` 先把原生 JS 值包成节点。
- `Document.toString`：`src/doc/Document.ts:352`。第 353–354 行有 errors 直接抛
  `'Document with errors cannot be stringified'`；第 362 行 `stringifyDocument`。
- `stringifyDocument(doc,options)`：`src/stringify/stringifyDocument.ts:10`。第 25
  行 `createStringifyContext(doc,options)`（`src/stringify/stringify.ts:64`：合并
  `defaultStringifyOptions`——`lineWidth:80`、`minContentWidth:20`、
  `defaultStringType:'PLAIN'`、`blockQuote:true`、`singleQuote:null`、
  `verifyAliasOrder:true` 等，`src/stringify/stringify.ts:29-46`）；第 44–49 行
  `stringify(doc.value,ctx,…)`；最后 `lines.join('\n')+'\n'`（第 81 行）。
- `stringify(node,ctx,…)`：`src/stringify/stringify.ts:149`。Pair/Alias 先特判
  （第 150–162 行；Alias 无 directives 时用 `resolvedAliases` Set 挡循环，第 156–161
  行抛 `Cannot stringify circular structure without alias nodes`；有 directives 时
  交给 `Alias.toString` 做 `verifyAliasOrder` 检查，`src/nodes/Alias.ts:113-116`）；
  第 167–169 行 `getTagObject` 按 `item.tag`/`identify` 选 schema tag；第 171–176
  行 `stringifyProps` 先输出 `&anchor`/tag（且先于值输出，保证 alias 引用时 anchor
  已在文本里）；第 178–186 行：tag 自带 `stringify` 用 tag 的（string tag 会把
  `ctx.actualString=true`，`src/schema/common/string.ts:10-11`），Scalar 否则走
  `stringifyString(node,ctx,…)`，集合走各自的 `toString`（block/flow map、seq）。
- `stringifyString(item,ctx,…)`：`src/stringify/stringifyString.ts:343`。第 356–360
  行先做**控制字符/未配对代理强制双引号**（覆盖已有 `Scalar.type`）；第 362–378
  行 `_stringify(type)` 按 type 分派到 `blockString`/`doubleQuotedString`/
  `singleQuotedString`/`plainString`；第 380–386 行返回 null（type 不在支持集合）时
  用 `defaultKeyType`（implicit key 时）/`defaultStringType` 兜底（默认 PLAIN）。
  各生产者内部最后调用 `foldFlowLines(text, indent, mode, getFoldOptions(ctx,
  isBlock))` 折行（plain/single：FOLD_FLOW；double：FOLD_QUOTED；block：FOLD_BLOCK
  ——分别见 stringifyString.ts:340、154、138、269-274）。
- `foldFlowLines(text, indent, mode, {indentAtStart, lineWidth=80,
  minContentWidth=20, onFold, onOverflow})`：`src/stringify/foldFlowLines.ts:29`。
  第 40 行 `lineWidth<=0` 直接不折；第 41 行 `lineWidth<minContentWidth` 时把
  minContentWidth 置 0；第 42 行 `endStep=max(1+minContentWidth,
  1+lineWidth-indent.length)` 决定每段最短推进长度；第 43 行文本短于 endStep 不折。
  只在“非空白后、且下一字符非空白/换行/tab”的空格处折（第 76–83 行），quoted 模式
  认 `\` 转义、允许词中折行（第 62–75、99–107 行），block 模式跳过“更深缩进”的行
  （`consumeMoreIndentedLines`，第 55–58、72–76 行）。

## 2. 不变量清单

### 2.1 range 对应：CST `offset/source` ↔ AST `[start, value-end, node-end]`

CST 每个 SourceToken 带 `{offset, indent, source}`（`Parser.sourceToken`，
`src/parse/parser.ts:249-257`），`offset` 是 `source` 在原文中的起始下标；结构 token
（document/block-map/…）带自己的 `offset` 和子 SourceToken。AST 节点的
`range?: [number,number,number]` 三元组（定义见 `src/nodes/types.ts` 与
`src/doc/Document.ts:61-67` 的注释：value-end/node-end 位置本身不包含在区间内）。
对应规则：

- **flow 标量**：`resolveFlowScalar` 第 60–66 行
  `range=[offset, offset+source.length, resolveEnd(end,valueEnd,…).offset]`。
  start = CST token 的 `offset`；value-end 紧贴标量原文末尾（不含尾随空白）；
  node-end 再吃掉 `token.end` 里的空格/注释/换行。实测 `key: 42 # hi\n`：CST 值
  token `{offset:5,source:'42'}`，AST 值 range `[5,7,11]`（node-end 11 覆盖到注释
  尾），键 token `{offset:0,source:'key'}` → 键 range `[0,3,3]`（无尾随 token）。
- **block 标量**：`resolveBlockScalar` 第 131–132 行
  `range=[start, start+header.length+scalar.source.length, …]`，start 是
  `scalar.offset`（**包含 header**，如 `a: |` 的 `|` 起点），value-end/node-end
  相同，覆盖到块内容最后一个换行。空内容 shortcut 在第 38–40 行同理。
  实测 `a: |\n  x\n` 值 range `[3,9,9]`。
- **alias**：`composeAlias` 第 151–153 行
  `[offset, offset+source.length, re.offset]`，包含整个 `*name`（含 `*`）。
- **block-map**：`resolveBlockMap` 第 157 行
  `[bm.offset, offset, commentEnd ?? offset]`：start 是 map 第一个 token 的偏移；
  value-end 是最后一个值 node-end；第三个元素是“纯尾注释”的结束点（有悬空注释时与
  value-end 不同）。**block-seq** 同理：`src/compose/resolve-block-seq.ts:55`
  `[bs.offset, offset, commentEnd ?? offset]`。**flow 集合**：
  `src/compose/resolve-flow-collection.ts:207`（map 起点取首个 keyNode.range[0]）、
  第 232–234 行 `[fc.offset, cePos, end.offset|cePos]`。
- **document**：`compose-doc.ts:61` `[offset, contentEnd, re.offset]`；遇到
  `...` 时第三个元素再被 `composer.ts:238` 改成 `resolveEnd` 的文件尾偏移。
- **没有源文本的空节点**：`composeEmptyNode`（compose-node.ts:108）伪造的
  `FlowScalar.source===''`，其 offset 由 `emptyScalarPosition`
  （`src/compose/util-empty-scalar-position.ts:3`）从“传入 offset + before 数组”
  回退空白后算出，因此 start=value-end=同一个真实位置；带注释时 node-end 被
  compose-node.ts:131 改成 props.end。空文档（forceDoc 路径）的根 Scalar 没有
  range（实测空串 `parseDocument('')` 的 value range 为 undefined），但
  `doc.range=[0,endOffset,endOffset]`（composer.ts:272）；`---\n\n` 的空根 range
  为 `[3,3,3]`。
- 若开启 `keepSourceTokens`，同一个 CST token 还会挂在 `node.srcToken`
  （compose-node.ts:104），可直接反查 offset 与 range 的一致性。

### 2.2 tag 解析优先级

按代码实际介入顺序（先后即覆盖关系）：

1. **`%TAG`/`%YAML` 指令**：`Directives.add`（`src/doc/directives.ts:75`）先于本文
   档生效，决定 tag handle 前缀和 YAML 版本（1.1→yaml-1.1 schema、1.2/next→core，
   `src/doc/Document.ts:301-312`）。
2. **`resolveProps` 解析词素级显式 tag/anchor**：`src/compose/resolve-props.ts:130-
   138`，多个 tag 报 `MULTIPLE_TAGS`、tag/anchor 出现在指示符之前报
   `BAD_PROP_ORDER`（第 142–147 行）；显式 tag 词素经
   `Directives.tagName`（directives.ts:126）解析成 URI。
3. **`stringKeys`（最高优先级，仅 key 位）**：compose-scalar.ts:28-29，在任何 tag
   选择之前直接用 string tag，并由 compose-node.ts:88-97 对非字符串结果报
   `NON_STRING_KEY`。显式 tag 也压不过它（实测 `!!int 5: +stringKeys` 键仍是
   `"5"`）。
4. **显式 tag（`findScalarTagByName`）**：compose-scalar.ts:30-31、59-89。
   - `'!'` 非特定 tag → string（第 66 行）；
   - 然后按 **`schema.tags` 的数组排列次序**（core 次序见
     `src/schema/core/schema.ts:10-22`：map, seq, string, null, bool, intOct, int,
     intHex, floatNaN, floatExp, float；yaml-1.1 见
     `src/schema/yaml-1.1/schema.ts:16-38`）找 `tag===tagName`：带 `default&&test`
     的同名 tag 先收集（第 67–73 行），再用 test 二次确认（第 74 行），其余立即
     返回；
   - 再查 **`schema.knownTags`**（compose-scalar.ts:75；knownTags 由
     `resolveKnownTags` 决定，1.2 core 下为 `coreKnownTags`：
     binary/merge/omap/pairs/set/timestamp，`src/schema/tags.ts:74-90`、
     `src/schema/Schema.ts:42`）；命中后第 79 行把它以
     `{...kt,default:false,test:undefined}` **追加进 `schema.tags`**——显式仍可用，
     但永不再隐式命中；
   - 全不命中 → `TAG_RESOLVE_FAILED`，除 `!!str` 外是 **warning**
     （第 82–87 行），退回 string tag。集合侧对应逻辑 compose-collection.ts:103-130。
5. **隐式 test（仅 plain token）**：compose-scalar.ts:32-33 调
   `findScalarTagByTest`（第 93–127 行），在过滤出的 `default:true`（key 位还有
   `default:'key'`，如 merge）tag 里按 `schema.tags` 次序取第一个
   `test(value)===true`，否则 string。引号/块标量根本不走这步（第 34 行）。
6. **`schema.compat`**：compose-scalar.ts:114-124，只在隐式 test 选定之后做差异
   比对，**只能发 warning，不能翻盘**；schema 构造见 `src/schema/Schema.ts:35-39`。
   实测 core 下 `yes` 是字符串，配 `compat:'json'`（json schema 无 bool-yes）仍
   返回 `'yes'`，只多一条 `TAG_RESOLVED_FAILED` warning。

失效关系一句话：`stringKeys` 让显式 tag 与隐式 test 在 key 位全部失效（仅留报错）；
显式 tag 让隐式 test 与引号默认 string 失效（但压不过 stringKeys）；knownTags 只在
显式点名时可用且会被降级为非 default；compat 永远不能让前三者失效。

### 2.3 anchor 与 alias

- **“anchor 必须在 alias 之前”靠文档顺序扫描，而不是靠 compose 期校验**：
  `Alias.resolve(doc,ctx)`（`src/nodes/Alias.ts:62`）先取
  `ctx.aliasResolveCache`，否则第 73–79 行用 `visit(doc)` 按文档顺序收集
  “Alias 节点或带 anchor 的节点”；第 83–86 行从头扫到 `this`（含）为止，记录最后
  一个 `node.anchor===this.source` 的节点并在遇到自己时 `break`。所以只有
  **本 alias 之前**的同名 anchor 会被找到；前向 alias → `resolve` 返回 undefined →
  `Alias.toJS` 第 97–100 行抛 ReferenceError。compose 期（compose-node.ts:48-56）
  只检查 alias 不许带属性，不校验锚点是否存在，因此 `parseDocument('a: *x\nb: &x
  1')` 能构出 AST（只是 `toJS` 才抛）。同名 anchor 重复定义时“后一个覆盖前一个”
  就是第 85 行不断刷新 `found` 的直接结果（实测 `a:&a 1 / b:&a 2 / c:*a` → 2）。
- **`ToJSContext.anchors`**（toJS.ts:9、22-26）：保证同一锚点的多次 alias 引用拿到
  **同一个 JS 值**（对象恒等、循环可表达），也是前向 alias 能工作的原因：
  `resolveAlias` 第 30–33 行发现 anchor 未转时现场递归 `source.toJS`。
- **`aliasResolveCache`**（toJS.ts:12，Alias.ts:70-79）：把“按文档顺序的 anchor/
  alias 列表”缓存到本次 toJS，避免每个 alias 都全树 visit 一次；它同时固化了“只看
  前文”的语义。
- **`maxAliasCount`（防别名炸弹/指数展开）**：toJS.ts:39-47，每次解析 alias 时
  `data.count += 1`，并懒算 `data.aliasCount = #getAliasCount(doc, source)`
  （第 51–69 行：递归估算一个锚点在子树里会被展开多少次，Pair 取 key/value 的
  max），当 `count*aliasCount > maxAliasCount`（默认 100，第 19 行）抛
  `'Excessive alias count indicates a resource exhaustion attack'`。`-1` 关闭
  （第 39 行）；`0` 在 `Alias.resolve` 入口（Alias.ts:66-67）直接抛
  “Alias resolution is disabled”。实测 10×10×10×10 的 billion-laughs 变体被挡。
  注意阈值是**乘积启发式**：深度为 1 的自引用循环 `count=1, aliasCount=1` 不会被挡
  （见下条）。
- **循环引用在哪挡、挡不住的表现**：解析/toJS 阶段**刻意允许**循环——
  YAMLMap/YAMLSeq 在填内容前就把空容器 `setAnchor`（YAMLMap.ts:243、
  YAMLSeq.ts:187-189），所以 `a:&a { b: *a }` 会得到 `r.a.b===r.a` 的真循环对象，
  `maxAliasCount` 默认也不拦（实测为 true）。真正的拦截发生在：
  1. 序列化阶段 `stringify`：无 directives（version:null）时靠
     `resolvedAliases` 抛 `Cannot stringify circular structure without alias
     nodes`（stringify.ts:156-161）；正常文档靠 `verifyAliasOrder`（默认 true）
     在 Alias.toString 检查 anchor 是否已经输出（Alias.ts:113-116）；
  2. 外部消费阶段：对循环结果 `JSON.stringify` 抛
     `Converting circular structure to JSON`（原生 TypeError，库不包装）；
  3. 深递归/别名指数展开由 `maxAliasCount` 抛 ReferenceError（toJS.ts:43-45），
     compose 期的深嵌套栈溢出由 compose-node.ts:70-74 降级成
     `RESOURCE_EXHAUSTION` 解析错误。

### 2.4 错误与警告的分界

- **`onError` 第四参数**：`ComposeErrorHandler`
  （`src/compose/composer.ts:20-25`）签名
  `(source, code, message, warning?)`；`Composer.onError`（composer.ts:93-97）
  据此二选一：真值 `YAMLWarning`，否则 `YAMLParseError`。CST 词法错误不走
  onError，由 Parser 直接产 `{type:'error'}` token（parser.ts:208-211 等），
  Composer.next 在 composer.ts:205-216 包成 `YAMLParseError('UNEXPECTED_TOKEN')`。
- **两种类**：`YAMLParseError`/`YAMLWarning` 都继承 `YAMLError`
  （`src/errors.ts:30-61`），都带 `name/code/message/pos`，经 `prettifyError`
  （errors.ts:63-101）补 `linePos` 与源码指针；**warning 与 error 走完全不同的数组**
  （`doc.warnings` vs `doc.errors`，Document.ts:52、74）。
- **`YAML.parse` vs `YAML.parseDocument`**：`parseDocument`（public-api.ts:64）
  永远返回文档，错误只累积在 `doc.errors` 里，**从不因解析错误抛异常**（多篇文档是
  例外，第 81–90 行也是 push 错误而非 throw）。`parse`（public-api.ts:123）则在
  第 139–142 行检查：非 silent 且有 error 就 `throw doc.errors[0]`，silent 清空
  errors 继续返回 toJS 值。两者对 warning 都不抛：parse 在第 138 行按 logLevel
  输出，parseDocument 只存放。
- **`logLevel` 的位置**：默认 `'warn'`（Document.ts:111）。它只影响**输出/清空**，
  不影响错误的产生与归类：`warn()`（`src/log.ts:7`）仅在 `warn`/`debug` 级别
  `emitWarning`/`console.warn`；`'error'` 级别下 warning 不打印；`'silent'` 还会
  抑制 parse 的 throw（public-api.ts:140-141）与 parseDocument 多篇文档错误的追加
  （public-api.ts:81）。

### 2.5 序列化形态选择与折行参数

- **参数通道**：`getFoldOptions(ctx,isBlock)`（stringifyString.ts:18-25）把
  `ctx.options.lineWidth`、`ctx.options.minContentWidth` 原样塞进 FoldOptions，
  `indentAtStart` 块形态取 `ctx.indent.length`、flow 形态取 `ctx.indentAtStart`
  （该值在 `stringifyProps` 输出 anchor/tag 时按其长度增加，
  stringify.ts:171-176）。默认值来自 createStringifyContext
  （stringify.ts:29-46）：`lineWidth:80`、`minContentWidth:20`。消费方是
  foldFlowLines.ts:29-43（语义见 §1.9：`lineWidth<=0` 不折；
  `lineWidth<minContentWidth` 时 `minContentWidth=0`；`endStep=max(1+
  minContentWidth, 1+lineWidth-indent)`）。
- **四种形态的选中条件**（都在 `stringifyString` 及其调用的生产者里）：
  - **plain**：节点 `type==='PLAIN'` 或 type 不支持时由 `defaultStringType`
    （默认 PLAIN）兜底（stringifyString.ts:373-374、380-386）；但
    `plainString`（stringifyString.ts:282）会在以下情况改判：implicit key 含换行/
    flow 内含 `[]{}`/起始指示符/`:#` 等正则（第 290-310 行）→ 引号或 block；
    多行且非显式 PLAIN → block（第 311-319 行）；含文档起始标记 `%`/`---`/`...`
    → block 或引号（第 320-327 行）；**最后**第 332-337 行在 `actualString`
    （string tag 自带，common/string.ts:10）下用当前 schema（含 compat）的非 str
    default tag 的 `test` 复检折叠前文本，若会被解析成非字符串（如 `'42'`、
    `'true'`）→ 改走引号。
  - **单引号**：`type==='QUOTE_SINGLE'`（第 371-372 行）或引号选择器
    `quotedString`（第 157-169 行：无双引号有单引号→单引号；有双引号无单引号→双
    引号；`singleQuote:true` 倾向单引号）。`singleQuotedString`（第 141 行）在
    `singleQuote===false`、implicit key 含换行、换行前后有空白时（第 142-146 行）
    退回双引号。
  - **双引号**：`type==='QUOTE_DOUBLE'`（第 369-370 行）；以及 stringifyString
    入口第 356-360 行检测到 C0/C1 控制字符或未配对 UTF-16 代理时，**无条件覆盖**
    节点原有 type 强制双引号；单引号 fallback 与 `singleQuote:false` 也到这里。
  - **block（`|`/`>`）**：`type` 是 `BLOCK_LITERAL/BLOCK_FOLDED` 时（第 364-368
    行），implicit key/flow 内不允许 block，改走引号；否则 `blockString`（第 180
    行）。`blockQuote:false` 或值里有“换行+行尾空白”时（第 189 行）退回引号；
    literal/folded 的选择见第 196-204 行（`blockQuote:'literal'/'folded'` 强制，
    否则尊重节点 `BLOCK_LITERAL/BLOCK_FOLDED`，再否则“行宽不超时”选 folded，
    超时选 literal）；folded 折行时若 `onOverflow` 触发（第 263-275 行，仅非强制
    folded 时挂）回退 literal。
- **哪些情况推翻节点上已写好的 `Scalar.type`**：(a) 控制字符/代理强制
  QUOTE_DOUBLE（stringifyString.ts:356-360，唯一在分派**之前**的覆盖）；
  (b) `BLOCK_*` 在 implicit key/flow 容器内被换成引号（第 366-368 行）；
  (c) `QUOTE_SINGLE` 被 singleQuote:false/换行邻空白换成双引号
  （stringifyString.ts:142-147）；(d) PLAIN 候选被 plainString 的非法字符正则、
  文档标记、actualString 回环复检改成引号/block（第 290-337 行）；
  (e) folded block 因溢出回退 literal（第 263-276 行）；
  (f) 不认识的 type 被 defaultStringType/defaultKeyType 替换（第 380-386 行）。

## 3. 三个次序问题（答案读代码得到）

### 3.1 一个普通标量在变成 `Scalar` 之前，“它算什么”的判断次序

以 plain token 为例，实际发生顺序（括号为证据行）：

1. **词法形态切分**：lexer 决定这是 plain 还是 quoted/block——plain 走到
   `plainScalar()`（`src/parse/lexer.ts:500`），引号由 `document()`/`flow()` 中的 `quotedScalar(ch)`（lexer.ts:250、341）决定，块由 `blockScalar()`（lexer.ts:423）决定；词素类型由
   `tokenType`（`src/parse/cst.ts:191`）落定。这一步只看字符形态。
2. **Parser 归类**：`next()` 把 `scalar`/`single-quoted-scalar`/
   `double-quoted-scalar` 压成对应 FlowScalar（parser.ts:212-215、879-895）；
   block-scalar 另走 parser.ts:482-508。
3. **props 解析（anchor/tag 词素）**：`resolveProps`（resolve-props.ts:14）从
   start/sep 里取出 `anchor`、`tag`，并产出多 tag/多 anchor/属性顺序错误。
4. **形态解码**：`composeScalar` 第 16–19 行调
   resolveFlowScalar/resolveBlockScalar，得到**逻辑字符串** value 与 PLAIN/
   QUOTE_*/BLOCK_* type。引号剥离、转义、换行折叠都在这一步（
   resolve-flow-scalar.ts:30-43、99-201）。
5. **显式 tag 名解析**：compose-scalar.ts:21-25 → `Directives.tagName`
   （directives.ts:126）。
6. **stringKeys 短路（仅 key 位）**：compose-scalar.ts:28-29。
7. **选 tag**：显式名 → findScalarTagByName（compose-scalar.ts:59）；否则
   plain → findScalarTagByTest 按 `schema.tags` 数组次序跑 `test`
   （compose-scalar.ts:93-112）；非 plain → string（第 34 行）。
8. **`tag.resolve(value)` 得 JS 值**：compose-scalar.ts:38-48。
9. **toJS 期**：`Scalar.toJS`（Scalar.ts:98）原样返回 value；key 位上还有
   `Schema.mapKey`（`src/schema/Schema.ts:40`、61-64：Scalar 解包成
   `value ?? null`）决定 JS 对象键的形态。

交换其中两步会出什么错（任选两处即可复现）：

- **交换第 1 步与第 7 步（让引号形态也参与隐式 test 匹配）**：`'42'`、
  `"true"`、`| 42` 会被 `int`/`bool` 的 `test` 命中而变成 number/boolean。
  实测当前 `'42'` 是 `'42'(string)`、`|- 42` 也是字符串；一旦把
  compose-scalar.ts:32 的条件从 `token.type === 'scalar'` 放宽成对所有形态跑
  findScalarTagByTest，单/双引号与块标量里的数字/布尔全部错型——而“引号即字符串”
  是 YAML 用户最基本的逃生舱。
- **交换第 7 步内部的数组次序（intOct/int/intHex/float… 的排列）**：core schema
  把 `intOct` 排在 `int` 前、`intHex` 更后（`src/schema/core/schema.ts:16-18`）。
  若把 `int` 提前到 `intOct` 之前，`0o17` 会先被十进制 int 的 `test` 命中（
  isInt 只看数字和正负号，`0o17` 能过吗？不能——`o` 非数字；真正受影响的是
  `0x1f` 同理不过；能演示次序敏感的是**同形多义**值，例如 yaml-1.1 里
  `schema.ts:21-22` 的 trueTag/falseTag 与 `on/off/yes/no` 不同 tag 共享
  identify，以及 core 里 `floatNaN`（`.nan/.inf` 类）排在 `float` 前）：把
  `floatNaN` 与 `float` 次序对调，`.nan`、`-.inf` 会被十进制 float 的 test 判否、
  或被更宽的 float 规则吞掉，得到 `NaN`/`Infinity` 之外的错误结果或直接退化成
  字符串。更直接的例子：`default:'key'` 的 merge tag（
  `src/schema/yaml-1.1/merge.ts:25`，`test: str=>str==='<<'`）只在 key 位、且
  按数组次序参与匹配——把它排到普通 string 之后无影响（string 不参与隐式 test，
  见下一条），但把 `default:'key'` 判定（compose-scalar.ts:110）与
  `default===true` 的顺序对调，值位置上的 `<<` 就会被错当成 merge。
- **交换第 6 步与第 7 步（先隐式 test 再看 stringKeys）**：`!!int 5` 作键时先被
  解析成 number，再补一条 NON_STRING_KEY 错误，键也已经是 number 而非字符串，
  stringKeys 的承诺（“所有键按字符串处理”）被打破——错误还在，但值错了。

### 3.2 `stringifyString` 链上三件事的次序：形态 → 回环复检 → 折行

对 plain 生产者，代码里的确定先后是：

1. **形态选择**（决定试 plain / single / double / block）：
   stringifyString.ts:355-386（控制字符强制双引号 → 按 `Scalar.type` 分派 →
   defaultStringType 兜底）；plain 候选再在 `plainString` 内被非法字符正则
   （第 296-310 行）、多行偏好（第 311-319 行）、文档标记（第 320-327 行）改判成
   引号/block。
2. **回环复检（产出文本再被当 YAML 解析时还是不是字符串）**：plainString
   第 328-337 行：先用当前缩进把 `\n` 展成多行得到 `str`（此时**尚未折行**），
   若 `actualString`，就用 `schema.tags`/`schema.compat` 里非 str 的 default tag
   的 `test(str)` 复查；命中（如 `42`、`true`、`0.9e-3`）就放弃 plain 改走
   `quotedString`。
3. **按行宽折行**：复检通过后，plainString 第 338-340 行才
   `foldFlowLines(str, indent, FOLD_FLOW, getFoldOptions(ctx,false))`。引号形态在
   各自生产者末尾折行（single：第 152-154 行；double：第 136-138 行；
   block：第 269-274 行）。

哪一对不能交换：

- **形态选择 ↔ 回环复检不能换**。复检逻辑（`tags.some(test)`，
  stringifyString.ts:333-336）只存在于 plain 分支里，且复检的输入必须是“按 plain
  规则产出的文本”。若先复检再选形态，`42` 这类值在“还没决定要不要 plain”的阶段
  没有可供 test 的候选文本；要让它能跑就得把复检提到所有形态共用——那
  `true`/`null`/`42` 就会在 type=QUOTE_SINGLE/BLOCK_LITERAL 等场景被多余地加引号
  或报错。实测当前行为：`YAML.stringify('42')` 必须得到 `"42"\n` 而不是
  `42\n`（回环成 number），这条正是被钉在第 332-337 行的；形态选择不先落地，这道
  保险没有挂载点。
- **形态选择 ↔ 折行不能换**。block 生产者内部还要在 folded/literal 之间根据折行
  是否 overflow 回退（blockString 第 263-279 行的 `literalFallback`），而 flow/
  quoted/block 三种 fold 模式（FOLD_FLOW/FOLD_QUOTED/FOLD_BLOCK）对转义、深缩进行
  的处理完全不同（foldFlowLines.ts:55-75、99-107）。先折行再选形态会用错误的模式
  折一遍再丢弃（例如 plain 文本含 `\n` 时本该 block，却先被 FOLD_FLOW 在空格处折
  断）。
- 至于**回环复检 ↔ 折行**：二者在纯文本层面是可交换的——折行只在空格处插入
  `\n`+缩进，plain 解析时这些换行被 foldLines 折叠回空格，tag 的 `test` 对两者
  给出同样结论（代码把复检放在折行前，只是为了让 `str` 短、少算一遍，并顺带覆盖
  implicit key 不折行的路径，第 338-339 行）。所以真正不能换的是前两对。

### 3.3 同一 map 里 `<<` 合并键与普通键的写入先后

决定代码有两处：

- 迭代顺序来自 `YAMLMap.toJS` 对 `this.values.values()` 的顺序遍历
  （`src/nodes/YAMLMap.ts:244-245`）。`values` 是个 Map，键为 schema.mapKey，
  Pair 在 `resolveBlockMap` 里按**源文档中条目的出现次序** `map.set(pair)`
  （`src/compose/resolve-block-map.ts:129-131`，flow 集合对应
  resolve-flow-collection.ts 同样按 item 次序）。因此 merge Pair 排在源里第几项，
  `addPairToJSMap` 就在第几项被调用。
- 单个 Pair 的写入分支由 `addPairToJSMap`（
  `src/nodes/addPairToJSMap.ts:17-42`）决定：先查 `addToJSMap` 钩子
  （merge Scalar 在 resolve 时挂上，merge.ts:28-32），再查裸 `<<`
  （addPairToJSMap.ts:19-20，TODO 注释说明这是兼容路径），最后才是普通键
  （第 21-42 行，**无条件 `map.set`/赋值覆盖**）。merge 展开内部
  （merge.ts:58-86）只补目标中不存在的键（`!map.has(key)` /
  `!hasOwnProperty`）。

合起来的次序语义：

1. `<<` **之前**的普通键：先写入；merge 展开时看到键已存在，跳过——普通键胜出；
2. `<<` **之后**的普通键：后写入，无条件覆盖 merge 带来的同名字段——普通键仍胜出；
3. merge 引入的新键，其**枚举位置**就是 `<<` 在源里的位置（实测
   `a / <<{m,k} / c` → `Object.keys` 为 `['a','m','k','c']`）；
4. `<<` 的值是 seq 时，`addMergeToJSMap` 按数组顺序逐个 merge
   （merge.ts:49-51），每个又只补缺失键，所以**序列里更早的 map 胜出**（
   `<<:[{a:1},{a:2}]` → `a:1`，实测验证）。

把次序颠倒会怎样：若把 addPairToJSMap.ts:19 的判断取反（或把 merge 改成无条件
`set`），merge 就会覆盖它**前面**的普通键——`{a:99, <<:{a:1}}` 会从 `{a:99}`
变成 `{a:1}`；新增键的枚举位置也会从 `<<` 所在位置跑到遍历末尾/开头。影响的输入
类：任何“本地键写在 merge 之前且与被合并 map 同名”的文档（YAML merge 规范
http://yaml.org/type/merge.html 明确要求 earlier keys 不被覆盖；这正是
`tests/merge-order-invariants.ts` 钉死的行为，见 §6）。

## 4. 三个风险点（分属三个不同文件）

### 风险点一：裸 CR（`\r`，非 CRLF）既不当换行也不报错 —— `src/parse/lexer.ts`

- **现象**：只含 `\r` 的行结束不被识别为换行，后续行被拼进同一行标量/结构；有时
  报错信息还会指向错误位置。实测：
  - `YAML.parse('a: 1\rb: 2\r')` 抛 `Nested mappings are not allowed in compact
    mappings`（把 `1\rb: 2` 当成同一行里 `a` 的值后面又起 map）；
  - `YAML.parse('- 1\r- 2\r')` 不报错，返回 `["1\r- 2\r"]`——两个 seq 项静默合并
    成一个字符串，数据已经错了却无 error/warning；
  - `YAML.parse('|\r a\r b\r')` 抛词法级 `Not a YAML token: " a b"`。
- **触发条件**：输入来自老 Mac（CR-only）系统、或被某些工具把 CRLF 错截成 CR 的
  YAML 文本。
- **最小复现**：
  ```bash
  node --experimental-strip-types -e "import('yaml').then(({parse})=>console.log(parse('- 1\r- 2\r')))"
  # 实际输出：[ '1\r- 2\r' ]，而不是 [1, 2]
  ```
- **判断依据（设计取舍）**：`Lexer.newline()`（
  `src/parse/lexer.ts:567-572`）只认 `\n` 与 `\r\n`，这与 YAML 1.2 规范一致
  （规范的 line break 就是 LF/CRLF，CR 不是合法断行），所以“CR 不折行”本身合规。
  **缺陷的成分在于静默**：seq 合并那类输入没有任何 error/warning，用户无从察觉数据
  被吞；若认为应像非法指示符那样产出一个 CST error token（或至少对“值中出现裸 CR”
  发 warning），需要动 lexer 的状态机，影响面大，建议至少文档化。

### 风险点二：不同类型但同字符串的键在普通对象表示里静默碰撞丢数据 —— `src/nodes/addPairToJSMap.ts`

- **现象**：AST/YAMLMap 层允许 number `1` 与 string `"1"`（以及 `true`/`null` 的
  字符串化）作为不同键共存，但落到普通 JS 对象时键被 `String(...)` 收敛，后者覆盖
  前者，**没有 error/warning**（只有对象键才有的 mapKeyWarned 提示也不会触发，因为
  键本身是原始值）。实测：
  ```js
  parse('1: number\n"1": string\n')
  // AST pairs: [ [1,'number'], ['1','string'] ]，doc.errors/warnings 均为空
  // toJS():    { '1': 'string' }          ← number 那条丢了
  // mapAsMap:  Map(2){ 1=>'number', '1'=>'string' }  ← 数据其实都在
  ```
- **触发条件**：混用带引号/不带引号的“看起来相同”的标量键（数字、布尔、null、
  大整数与字符串），并用默认对象输出（`mapAsMap:false`）。
- **最小复现**：
  ```bash
  node --experimental-strip-types -e "import('yaml').then(({parse,parseDocument})=>{const d=parseDocument('1: a\n\"1\": b\n');console.log(d.errors.length,[...d.value.pairs()].length,parse('1: a\n\"1\": b\n'))})"
  // 0 2 { '1': 'b' }
  ```
- **判断依据（设计取舍 + 可改进点）**：对象键只能是字符串是 JS 语言限制，库提供了
  `mapAsMap:true` 逃生舱（`src/options.ts:183-189`），且
  `DUPLICATE_KEY`（resolve-block-map.ts:79-80）是在 AST 层用 `mapKey` 判等，
  SameValueZero 下 1 与 '1' 不相等——所以解析层“不报重复键”是自洽的。**缺陷成分**
  在于 `addPairToJSMap`（`src/nodes/addPairToJSMap.ts:28-41`）对原始值碰撞是静默
  覆盖（不像复杂对象键那样在第 62-68 行 warn 一次）。低成本改进是可以在
  `!isPlainObject && stringKey in map` 之外，对 `isPlainObject` 且已有键的 JS
  原始键与新键非 SameValueZero 的情况发一次 `warn`，不改返回值、不改 range。

### 风险点三：非法 merge 源在 `toJS` 期才抛“裸” `Error`，不进 `doc.errors`、无位置、silent 也压不住 —— `src/schema/yaml-1.1/merge.ts`

- **现象**：`<<` 的值不是 map/map alias（或 alias 指向非 map、seq 里含非 map）时，
  错误既不在 compose 期产生（AST 正常构出），也不走 `onError` 体系，而是在
  `toJS` 里 `throw new Error('Merge sources must be maps or map aliases')`
  （`src/schema/yaml-1.1/merge.ts:64-67`）。实测 `<<: 42`、`<<: null`、
  `<<: [1,2]`、`s:&s 42 / <<:*s` 全部在 `YAML.parse` 里抛普通 `Error`；它没有
  `code`/`pos`/`linePos`，`logLevel:'silent'` 也压不住（silent 只清 `doc.errors`，
  public-api.ts:141，管不到 toJS 里的 throw）。
- **触发条件**：YAML 1.1 schema（或开启 `merge:true`）下给 `<<` 配非 map 值。
  人写的配置里 `<<: *base` 拼错锚点类型、或把标量误缩进进 merge seq 都能踩到。
- **最小复现**：
  ```bash
  node --experimental-strip-types -e "import('yaml').then(({parse})=>{try{parse('x:\n  <<: 42\n',{schema:'yaml-1.1'})}catch(e){console.log(e.name,e.message)})"
  // Error Merge sources must be maps or map aliases
  ```
- **判断依据（缺陷）**：同库的其他语义错误都统一为带 code/pos 的
  `YAMLParseError`（经 composer onError）或 `ReferenceError`（alias 类错误），
  唯独这里是裸 `Error` 且延迟到取值阶段，使得 `parseDocument` 用户无法通过
  `doc.errors` 发现该文档对 `<<` 的使用是坏的（`doc.errors` 为空），错误处理中间件
  按 `YAMLParseError`/`code` 过滤时会漏掉它。修法方向是在 compose 期（
  resolve-block-map.ts 的 value 处理处）对 merge 值类型发 onError，或至少让这里抛
  YAMLParseError；但这会改变现有抛出类型与时机，属于对外行为变更，需配合大版本，
  故本次仅记录不修改。

## 5. 未做的最小修复说明

本次没有修改 `src/`：风险点一/三 的修复都会改变公开行为（错误产生时机、错误类型），
风险点二 若要发 warning 也会改变可观察输出；按“对外行为不改”的边界，三处都只在
§4 给出依据与修法方向。三个风险点都与 CST/AST 的 range 计算无关，因此即使后续按
上述方向修复（均在 lexer 错误出口或 toJS 写入分支加信号），也不会触碰任何
`range=[start,value-end,node-end]` 的赋值点（resolve-flow-scalar.ts:60-67、
resolve-block-scalar.ts:131-132、compose-node.ts:151-153、resolve-block-map.ts:157
等），CST offset 与 AST 三元组的对应关系保持不变。

## 6. 新增测试与其“变红”指令

新增文件：`tests/merge-order-invariants.ts`（8 个用例，随验收命令一起跑）。它钉死
两条读代码得到的次序/不变量：

1. **merge 键的写入次序**（§3.3）：merge 只补缺失键，不覆盖 `<<` 之前的普通键；
   `<<` 之后的普通键照常覆盖；新键枚举位置就在 `<<` 处；Map 输出同语义；merge
   seq 中更早的 map 优先。
2. **标量解析次序**（§3.1/1.7）：单引号形态在 schema test 之前锁定字符串——
   `parseDocument("'42'")` 的节点 type 是 `QUOTE_SINGLE`、`toJS()` 是 string
   `'42'`；plain `42` 仍走 int tag 得 number 42。

**让它变红的真实单行改动（已动手验证、已还原）**：把
`src/nodes/addPairToJSMap.ts:19`

```ts
  else if (isMergeKey(doc, key))
```

改成

```ts
  else if (!isMergeKey(doc, key))
```

即 merge 键不再走 `addMergeToJSMap`、普通键反而带着 merge 值进去（merge 的 map
参数变成标量/别名，会在 merge.ts:64-67 抛 “Merge sources must be maps or map
aliases”）。验证结果：该文件 8 个用例中 6 个失败（merge 五例全红），还原后 8/8
恢复绿色；全量 965 + 8 = 973 个用例全绿（见下）。
