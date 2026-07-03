# v0.3 Synthetic BND Fixture Layout

这个文档定义 SoulForge 自有的 synthetic BND fixture 布局，用于验证 BND child inventory 导出管线。

它不是 FromSoftware 原生 BND3/BND4 规格。

## 目标

这个 fixture 用来证明：

- Bridge 能导出 child inventory；
- 每个 child 有稳定 id；
- 每个 child 有 name；
- 每个 child 有 offset、packedSize、unpackedSize；
- 能根据 child name 推断 resourceKind；
- 输出必须带 high confidence fixture metadata；
- 输出必须明确 nativeFormatAuthority = false。

## 通用规则

- int32 和 int64 都是 little-endian；
- 字符串是 UTF-16LE null-terminated；
- fixture 可以由 smoke script 在临时目录生成；
- 不提交真实游戏资源；
- 不把该 fixture 当成原生 BND 权威格式。

## Magic 和 marker

```text
0x00  4 bytes   ASCII magic: BND4 或 BND3
0x04  4 bytes   ASCII marker: SFBN
```

## Header

```text
0x08  int32     version，目前为 1
0x0C  int32     child count
0x10  int32     child table start offset
0x14  int32     string pool start offset
```

## Child row

每个 child row 长度 32 bytes。

```text
int32 childId
int32 nameStringPoolRelativeUtf16Offset
int64 dataOffset
int64 packedSize
int64 unpackedSize
```

## 预期 Bridge 输出

```text
resourceKind = file
parseStatus = partial
diagnostic code = BND_SYNTHETIC_FIXTURE_CONFIRMED
```

每个 child 应导出：

```text
children[].id
children[].name
children[].resourceKind
children[].offset
children[].packedSize
children[].unpackedSize
children[].raw.confidence = high
children[].raw.nativeFormatAuthority = false
```

## 接线状态

`SyntheticBinderFixtureExports.cs` 已定义解析和导出 helper。

建议接线路径：

```text
Bridge inspect 或未来 export-binder
  -> SyntheticBinderFixtureExports.TryExport
  -> confirmed child inventory
  -> visible-string binderChildCandidate fallback
```

当前不强行加入公开 Bridge command。Codex 后续应先完成 event / param / map router wire-up，再单独处理 BND child inventory 接线。
