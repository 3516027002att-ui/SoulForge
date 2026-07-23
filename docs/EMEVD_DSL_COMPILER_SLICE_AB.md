# EMEVD DSL 编译器 Slice A+B 稳定技术规格

> 状态：`fixture-confirmed`；公开 Windows CI 已验证，native 接线仍未完成。  
> 对应：Issue #6。  
> 本文只描述稳定编译契约，不另立里程碑或项目进度口径。

## 目标

第一版 EMEVD DSL 是基于已打开 `EmevdEditorDocument` 的 patch DSL，不是完整文件声明语言。省略 event 或 instruction 不代表删除。

合法链路：

```text
native / semantic document
  -> patch template renderer
  -> bounded tokenizer
  -> parser + AST + source spans
  -> document/revision/schema binding
  -> EMEDF scalar typecheck
  -> deterministic typed mutation plan
```

Slice A+B 不连接 Bridge、PatchIR 或目标文件写入，因此不改变 EMEVD native authority。

## 稳定身份

`eventUri` 依赖 event ID，`instructionUri` 依赖 ordinal，二者都可能在结构 mutation 后漂移。编辑器文档因此增加：

```ts
interface EmevdNodeAnchor {
  documentInstanceId: string;
  localNodeId: string;
  sourceFingerprint: string;
}
```

约束：

- `documentInstanceId` 区分一次打开文档的生命周期；
- `localNodeId` 不从可变 event ID 或当前 ordinal 单独派生；
- event ID mutation 必须保留 event 和 child instruction 的 anchor；
- compiler request 的 document instance 或 revision 不匹配时失败关闭；
- anchor 只是 editor-local identity，不替代 native offset、resource URI 或持久资源引用。

## 第一版语法

```text
resource "file://event/common.emevd"
base revision 0 schema "sha256:..."

event @e:0123456789ab {
  set id = 51
  set rest = 1
  instruction @i:abcdef012345 {
    set arg conditionGroup = -2
  }
}
```

当前只解析：

- `set id`；
- `set rest`；
- `set arg <name>`。

不支持 insert、delete、layer、parameter bank、macro、include、表达式执行、裸 bytes 或 argsBase64 写入。

## Patch template roundtrip

`renderEmevdPatchDsl()` 会渲染当前 event ID、rest behavior 和已绑定 EMEDF 的 typed args。未知 instruction 仅作为带 anchor 的只读注释出现。

未经修改的模板必须满足：

```text
render -> parse -> bind -> deterministic empty plan
```

模板不会把省略解释为删除，也不会用普通 DSL 语法暴露 raw argsBase64 或未知 payload 写入。

## 安全边界

- source 最大 256 KiB；
- token 最大 20,000；
- nesting 最大 16；
- tokenizer 无文件系统访问、无动态执行；
- 所有 diagnostics 带 source span；
- schema 缺失或 fingerprint 变化时不产出 plan；
- unknown instruction 保持只读；
- integer 严格执行 u8/s8/u16/s16/u32/s32 范围；
- bool 不与 number 自动转换；
- f32 必须 finite；
- event ID 冲突失败；
- 编译只生成计划，不修改 authority document；
- 同一 semantic AST、base document、revision 与 schema 生成相同 plan fingerprint；空白和 source span 不进入语义 fingerprint。

## 已验证

公开 Windows CI 已覆盖：

- stable anchor 在 event ID mutation 后保持；
- patch template render / parse / bind 为空计划；
- 同输入 plan fingerprint 确定；
- whitespace/source span 不影响语义 fingerprint；
- stale revision、schema 缺失/变化、unknown instruction、数值越界、event ID 冲突与语法错误失败关闭；
- 编译过程不修改 authority document。

验证仅使用构造 EMEVD document 与最小 fixture EMEDF，不产生 native authority 声明。

## 非声明

- 不代表 DSL 已可写入 native EMEVD；
- 不代表完整 Sekiro EMEDF；
- 不代表 insert/delete、layer 或 parameter bank 已支持；
- 不代表 KRAK 包装或游戏加载已验证；
- 不提升 EMEVD 当前 `partial` authority；
- 后续 Bridge 接线仍必须经过 typed mutation、native document、PatchIR、staging、validation、backup、atomic commit、reread、audit 和 rollback。
