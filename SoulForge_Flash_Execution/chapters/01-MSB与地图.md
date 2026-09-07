# 1. MSB 与地图：把写入目标和格式语义钉死

本章对应报告 F01～F05、F13，以及 T01～T12。当前问题不是“地图看起来不对”而已；原报告证实了字段解释错误。必须同时处理 reader、writer、共享 DTO、索引与验证，不能只把写入偏移换掉。

## SF-01：切断三类危险写入，保留正常读取

**报告依据。** §3.1～3.3、§11.1；S03～S09。目标是防止 EntityID 错写、Region scale 覆盖指针和未完成引用重映射的结构删除继续产生副作用。

**修改范围。** `bridge/SoulForge.Bridge/MsbNativeDocument.cs` 的 `ApplyMutations`；`MsbNativeWriter.cs` 的 `PreparePatches` / `ParsePatch`；`packages/shared/src/map-document.ts` 的事务校验、Blender delta 导入；`packages/core/src/editing/mapService.ts` 的 mutation 构造；`packages/core/src/ai/toolRegistry.ts` 的相关能力广告与入参校验。前端展示由独立前端卡接收。

**本方案裁定。** 修复未通过 native 验证时，`set_entity_id` / 只写 EntityID 的 `set_property` 返回 `MSB_ENTITY_SCHEMA_UNVERIFIED`；Region 任何 scale、scaleDelta、scaleMultiplier 字段返回 `MSB_REGION_SCALE_UNSUPPORTED`；delete_part/delete_region/delete_event 返回 `MSB_REFERENCE_COVERAGE_INCOMPLETE`。其中 Region scale 的禁止是长期默认，不随 EntityID 修复解除。删除能力按 SF-04 的 profile 逐项开放。

校验必须判断字段“存在”，而不是值是否 truthy。`scaleX=0`、`scaleX=1`、`scaleX=null`、空数组、scaleDelta=[0,0,0] 都算提交了 scale 意图，不能被忽略。json schema 禁止不认识的字段；C# 运行时再次拒绝，不依赖 TypeScript 已检查。

合法的 Region 位置/旋转写入不得被迫带 scale。检查 `pushTransformMutation` 或构造 `set_region_transform` 的分支，只从 typed Region 的 position/rotation 构造写入对象。若现有 `transform` 同时带了用于显示的 scale，禁止把它展开到 mutation。旧客户端明确传来 scale 时返回错误，不能当作“用户其实没改缩放”吞掉。

**步骤。** 增加三个集中的能力判定函数；writer preflight 和共享事务 validator 调用同一规格的相应判定；工具广告根据该能力表隐藏不支持的操作；直接调用 Bridge 的负例必须仍拒绝；正常 Part 的位置/旋转/已支持缩放，以及 Region 的位置/旋转维持现有路径。

**测试。** 在 `packages/core/src/testing/runNativeMsbWriterSmoke.ts` 保留正常变换场景；新增 `runAuditMsbSafetyGateSmoke.ts`。输入直达 `runBridge({command:'write-msb',...})`，绕开 UI 和 tool registry，分别传上述三类危险操作。保存 source/staging/final 的前后目录列表与 hash，断言失败前未生成可提交产物。再用一个正常 Part 平移和一个 Region 平移证明没有把整模块关掉。

**验收。** SF-01 只能标记“危险能力封禁完成”，不能标记“EntityID/地图删除功能完成”。这条区别写进任务结果。原有测试若默认期望未验证删除成功，改成明确的能力拒绝断言，并保留后续 reopen 测试的待验证项，不能删掉整组。

## SF-02：MSB EntityID 的解析、写入、独立验证与派生迁移

### 1.2.1 字段布局：不可混淆的四个位置

报告中的 SoulsFormats 独立读取顺序给出以下定位，适用于本报告对应的 Sekiro MSBS 布局：Part 头部 `entry+0x0C` 是内部 ID；Part 的 EntityData 相对指针字段在 `entry+0x60`，真正 EntityID 在 `entry+relative`；Region 头部 `entry+0x0C` 也是内部 ID；Region 的 BaseData3 相对指针字段在 `entry+0x50`，真正 EntityID 在 `entry+relative+4`。位置计算中的 relative 是相对于当前条目起点，不是文件起点，不是 pointer 字段起点。依据为报告 X01/X02 的字段顺序；该定位不是允许套用所有游戏 MSB 的通用公式。

新增 native 常量：`PartEntityDataOffsetField=0x60`、`RegionBaseData3OffsetField=0x50`、`InternalEntryIdOffset=0x0C`。不要让两条路径复用一个名为 `IdOffset` 的模糊常量。

### 1.2.2 相对指针算法

新增 C# helper 名为 `ResolveRelativeInt32Field`，放在现有 `MsbNativeDocument.cs`，不要创建第二个完整 MSB parser。输入为 source、entryStart、pointerFieldOffset、innerOffset、该 family 的最小头长、所属条目的已验证物理边界；输出为经过检查的绝对 int32 地址。

```csharp
// 新增 helper 核心；调用者还负责格式 profile 与所属 param 边界。
private static int ResolveRelativeInt32Field(
    byte[] source, long entryStart, int pointerFieldOffset,
    int innerOffset, int minimumHeaderBytes, long sectionEnd)
{
    if (entryStart < 0 || sectionEnd > source.LongLength || sectionEnd <= entryStart)
        throw new InvalidDataException("MSB_ENTITY_SECTION_INVALID");
    long pointerAt = checked(entryStart + pointerFieldOffset);
    if (pointerAt < entryStart || pointerAt > sectionEnd - sizeof(long))
        throw new InvalidDataException("MSB_ENTITY_POINTER_FIELD_OOB");
    long relative = System.Buffers.Binary.BinaryPrimitives.ReadInt64LittleEndian(
        source.AsSpan(checked((int)pointerAt), sizeof(long)));
    if (relative < minimumHeaderBytes)
        throw new InvalidDataException("MSB_ENTITY_POINTER_INVALID");
    long absolute = checked(checked(entryStart + relative) + innerOffset);
    if (absolute < entryStart || absolute > sectionEnd - sizeof(int) || (absolute & 3) != 0)
        throw new InvalidDataException("MSB_ENTITY_TARGET_OOB_OR_UNALIGNED");
    return checked((int)absolute);
}
```

Part 最小头长 0xA0、Region 最小头长 0x60，来自上述独立布局顺序。`sectionEnd`传入当前条目的已验证物理end，不直接传整个param的end。对当前profile，将同param的entry offset去重检查后按物理位置排序，当前entry的end取下一物理entry起点与param end的较小者；有别名entry/跨entry共享载荷且profile未证明合法时拒绝。排序O(N log N)只在文档创建时执行一次，不在每次mutation重做。单纯“仍在param里”不能允许一个对象的指针指向另一个对象的数据。不能用 `Math.Min`、取模、截断或默认 0 把非法指针“修复”为可读地址。checked 溢出转换成结构化失败，不触发写盘。

helper 通过还不等于 profile 已验证。增加目标字段不能与头部、offset 表、已登记字符串/其他受保护区域重叠的检查。初期只开放独立语料证明的布局。某个合法变体使用超出此 profile 的共享布局时，返回不支持；不得放宽边界以“兼容未知格式”。

### 1.2.3 reader 改动

定位 `ReadParts` 当前 `ReadInt32(source, off + 0x0C)`。将它改为 `internalEntryId`；另用 helper 读取 entityId。`ReadRegions` 做同样分离。为 native record 增加 `InternalEntryId` 字段，保留 `EntityId` 名称表示真正游戏字段。构造函数全部调用点做显式迁移，不能顺序错位传参。

DTO 增加 `internalEntryId`，改正 `entityId` 的来源；格式/schema 版本递增。`nativeOffset` 保持快照身份含义，不变成 EntityID。main/Core 中构建 map symbol 和 `MapDocument` 时只读取新的 entityId；搜索内部 ID 另设字段，不把它当游戏事件引用。

不要在 reader 中为 EntityID 推断值：没有可验证字段就返回诊断和不可用状态，不返回头部 ID、0、-1 作为“兼容值”。-1 是真实语义中的可能哨兵，不是解析失败替代品。

### 1.2.4 writer 改动

`PreparePatches` 完成 sourceHash、对象 family/nativeOffset/expectedName、int32 范围、profile 验证，之后计算所有 mutation 的写入地址。所有地址和冲突都验证完才复制 source。`ApplyMutations` 写真实地址，不写 +0x0C。相同对象多次改 EntityID采用 SF-06 的最终状态规则：顺序模拟，最后值为 post-image。任何对象删除与后续属性写冲突，在 staging 前失败。

`VerifyMutations` 不逐条将中间值对比最终文件。构建对象→最终 EntityID 的字典；重读逐项比较；同时逐项验证 InternalEntryId 不变。整个文件的差异区间只能包含请求的四字节字段及已声明容器重建范围。对 raw MSB 的单字段修改，允许区间就是精确四字节；不可以把整个条目列为“都允许变化”。

### 1.2.5 独立 oracle，不复制同一个错误

新增 `packages/core/src/testing/msbsIndependentEntityOracle.ts`，只供测试，不从 Core production barrel 导出。它按原报告独立 MSBS 布局读取目标真实字段，并输出 InternalEntryId、EntityID、指针原值与字段地址。oracle 的常量与读取逻辑不得 import `MsbNativeDocument` 的新 helper，也不能以 Bridge 返回的 entityId 作为 expected。测试比较的是 writer 产物与独立定义。

完整格式差分阶段应使用固定版本的独立 MSBS reader。若运行环境只有字段 oracle，没有完整 SoulsFormats 可执行工具，允许得到 `verified_field_oracle`，不得报完整 native roundtrip。完整 reader 的版本、源码 blob/包 hash 和输出需要单独保存；禁止使用 floating master 作为无记录依赖。

### 1.2.6 测试数据与判据

T01 的输入必须满足 InternalEntryId=7、EntityID=1000，要求写成 2000。可以在合法 native fixture 的临时副本中构造这两个不同值；不能用“内部 ID 恰好等于 EntityID”的样本。T02 使用 Region 独立数据块，BaseData3 的第一项 ActivationPartIndex 和第二项 EntityID 必须不同，并证明第一项未变。

反例组包括 pointer=0、负数、超过 long→int 范围、加法溢出、未对齐、越过所属 param、指向头部、错误 family、旧 expectedHash、同名不同 nativeOffset、值 int32 上下界和越界值。每个拒绝都断言 source hash 不变、最终目标不存在新产物。

“旧错误检测力”测试构造错误结果：将 +0x0C 改为 2000，保留真实 EntityID=1000，然后喂给 verifier。verifier 必须失败。若它通过，说明只重写了测试叙述，没有独立验收。

### 1.2.7 索引、RAG 与 Wiki 迁移

在已有 schema/version 管理入口中增加 MSB reader schema revision。不得给每个资源生成临时随机版本规避缓存。资源派生键至少包含 outerHash、readerSchemaHash、metadataSchemaHash。找到 `nativeSemanticRefresh.ts`、`knowledgeRefresh.ts`、`workspaceIndex.ts`、`semanticWorkspaceIndex.ts`、`rag/persist.ts` 对 MSB 投影的保存路径；写一条幂等迁移：旧 schema 的 map EntityID 投影标 stale，删除或重建对应派生索引，沿引用依赖标 stale，不改 native 游戏文件。

迁移以一个 version marker 提交；中断重启再次运行不得重复生成相同 chunk 或丢失 journal。原 transaction 历史保留旧 readerSchemaHash，不重写历史字段含义。旧操作能否回滚取决于冻结字节 pre/post-image，不根据新 EntityID 重新猜目标。

**通过命令。** `npm run typecheck`；原 `bridge:verify:msb` / `bridge:verify:msb-writer`；新增 `test:audit-sf-02-unit` / `test:audit-sf-02-native`；通过 SF-00 runner 执行并保存 required suite 清单。撤除 SF-01 对 EntityID 的封禁仅在该 profile 的 native 独立验证通过之后。

## SF-03：Region 变换模型与 shape 尺寸

**报告依据。** F02、T03/T04。当前 `+0x30/+0x34/+0x38` 属于数据指针，必须零写入。

**修改范围。** `MsbNativeDocument.cs`、`MsbNativeWriter.cs`、shared `map-document.ts`、Core `msbBridgeRead.ts` / `msbBridgeCommit.ts`、`mapService.ts`，以及 shared capability 投影。新类型建议为 `MapRegionTransform={position,rotation}` 与 `MapRegionShape`。Part 继续使用 position/rotation/scale。

`MapRegionShape` 是判别联合，初始包含 `kind:'unsupported'` 与 `kind:'point'` 的只读表示；Sphere/Box/Cylinder 的可写分支必须有 profile。profile 至少包含 shapeType 的原生判别值、shapeData 指针规则、字段类型/偏移/单位、允许零值、未触及字节规则、独立依据 hash、已验证样本集合。原报告没有给出完整 shape 字段表，本方案不伪造数字偏移。

**尺寸运算裁定。** 已经验证的 Sphere 仅接受统一缩放，半径 r'=r*s；非均匀缩放不默默平均。已验证 Box 的各原生尺寸依轴语义乘对应比例；Blender 轴映射经 SF-25 的坐标合同，不直接把 scaleX 当 width。已验证 Cylinder 的两个径向比例相等才能仍表示圆柱，否则拒绝；高度独立变化。Point 没有尺寸字段。所有 shape 变换必须产生明确的 `set_region_shape` 命令，禁止写 `set_region_transform.scale`。

输入尺寸必须有限且符合 profile 的正数/非负规则；未知类型、未知布局或无法表示的形变返回 `SHAPE_OPERATION_UNSUPPORTED`。shape 类型变更不是尺寸更新，初期不开放，因为它可能改变 payload 长度及引用。

**执行门槛。** SF-03 的第一阶段交付为 reader/DTO 分离与通用 scale 拒绝；第二阶段逐 profile 开放 shape 尺寸。缺少独立布局的形状只读。第二阶段不能因第一阶段通过而被标为完成。

**测试。** 保存 Region +0x30/+0x38 原始八字节指针，任何位置/旋转或已支持 shape 尺寸修改后都必须不变。恶意 scale=1/null/0 均拒绝。支持类型从独立 reader 读取新尺寸，未知类型零写入。盒子采用非对称尺寸以发现轴交换；球采用非均匀输入以发现非法近似。

## SF-04：结构删除与引用闭包

### 1.4.1 安全默认值

在没有完整引用描述符之前，所有 native MSB delete 保持封禁。不得以 `references.length===0` 判断安全，因为“没有找到引用”可能只是“没有解析引用”。只修 ActivationPartIndex 不能宣称 MSB 删除完成。

### 1.4.2 描述符与索引域

新增测试/领域协议 `MsbReferenceDescriptor`：owner 对象句柄、owner 属性、存储位置、存储类型、targetIndexDomain、目标解析规则、nullSentinel、nullable、onDeletePolicy、sourceSchemaHash。`targetIndexDomain` 必须区分整类列表、特定子类型列表、事件局部列表等。不是所有 Part 引用都使用同一个全局 Parts 数组。

新增 `ReferenceCoverageCertificate`：gameProfile、readerSchemaHash、sourceHash、presentTypeIds、decodedReferenceKinds、unknownReferenceRegions、complete。complete 只能由 schema/解析器根据本次文档所有已出现类型计算；模型或普通工具调用不能传入 true。任何未知引用区域令 complete=false。

### 1.4.3 删除算法

1. 对删除目标做完整解析，冻结 handle 集合 D。重复或歧义目标拒绝。
2. 对每个受影响的 indexDomain 枚举旧有序对象 H=[h0,h1,...]。构建映射 M[i]：hi∈D 则 -1；否则为未删除前缀数量。
3. 遍历所有引用描述符。哨兵不改；指向保留目标的引用写 M[oldIndex]；指向删除目标的引用按描述符策略处理。默认策略为 reject。clear 只有 nullable 且用户计划显式包含该清除行为才允许。不得自动级联删除。
4. 如果旧引用已经越界，停止并报告损坏，不在删除时“顺便修好”。如果描述符覆盖不完整，停止，不写 offset 表。
5. 生成一次最终 family offset 表和所有引用字段 patch；所有写区间建立 manifest。重新计算计数。内部 entry ID 是否需重编必须由该 profile 指定，不擅自等同数组下标。
6. 对结构结果做独立读取。对每个保留引用，比较“引用指向的对象身份”而非只比较整数。原 A/B/C 删除 A 后，指向 B 的 1 应成为 0；指向 C 的 2 应成为 1。
7. 进入统一事务，验证后提交。任何验证失败都触发 SF-12 的恢复协议。

复杂度为 O(N+E)，N 是参与索引域的对象数，E 是已声明引用数。不得对每个删除重新全表查找并重写，也不得反复删除可变数组后继续使用旧索引。

### 1.4.4 跨文件与外部引用

EntityID 被 EMEVD 使用是另一类关系，不属于文件内数组索引。删除一个具有外部引用的对象，影响范围包含调用事件、状态机或其他已知资源；默认返回引用列表和 blocked。只有明确的跨文件 ChangeSet 能修复这些引用，且其所有成员通过验证，才能提交。未知外部关系不被“本 MSB 没有引用”覆盖。

**验收。** T05/T06 覆盖删除首、中、末对象；保留引用、nullable 清除、不可空拒绝；重复删除；不同 subtype 索引域；引用闭包不完整；改写后的内部 ID；独立 reader 解析。门禁封禁可以作为阶段交付，不能作为成熟编辑器删除功能通过。

## SF-05：地图查询、批量目标与快照复用

### 1.5.1 组合查询采用交集，不再选择一条分支

修改 `queryMapEntities`。`modelName`、`entityId`、`kind`、`nameContains` 都是可选的 AND 条件。建立候选集时可选成本最小的索引集合，最终仍执行全部给定谓词。大小写折叠只用于 nameContains 搜索；identity/modelName 的精确匹配沿既有 canonical 规则，不能同时改变底层资源名。

`regionName` 表示“引用该 Region 的事件”，不是模糊字符串过滤。先用 native 身份解析 Region；名称歧义则返回候选；引用图 coverage 不完整时返回 `MAP_REFERENCE_COVERAGE_INCOMPLETE`，不返回空集。取得事件集合后继续与其他条件求交。冲突条件得到合法空集及完整 coverage，不忽略其中一个条件。

### 1.5.2 批量操作的目标集合

`batchTransformMapParts` 删除 `if (!part) continue`。第一遍解析全部 requested targets 到 canonical handles；任一缺失或歧义返回错误，staging 调用次数必须为零。两个输入别名解析到同一个 handle 时返回 `MAP_DUPLICATE_TARGET`，不重复计算 delta，也不静默去重后继续把 requestedCount 当 modifiedCount。

第二遍计算目标值。positionDelta 与原 position 相加；scaleMultiplier 与原 Part scale 相乘；输入 rotation delta 的意义固定为当前接口原生 Euler 分量增量，不能暗中升级成世界轴旋转。需要世界/局部矩阵旋转的请求走 SF-25 新协议。浮点量化采用格式写入结果；输出包含 requested/resolved/effective counts，零有效变化返回 no-op。

默认不提供 bestEffort 参数。用户将来需要部分成功时另建显式批次模式，返回每个目标状态；不能借这次修复把普通 ok:true 继续用在部分成功上。

### 1.5.3 消除重复完整加载

现有入口 `loadMapDocument`、`executeMapTransaction`、`batchTransformMapParts` 保留。新增内部 `MapSnapshotLease`，包含 doc、sceneGraph、sourceIdentity、sourceVersion、released 标记。它由宿主创建，不允许模型 JSON 伪造。

`executeMapTransaction` 增加内部可选 snapshot 参数：传入时验证 file 与 workspaceEpoch 一致，并在提交前检查 sourceHash；没有传入时调用一次 loadMapDocument。批量入口传入刚读取的 lease。事务内完成一次提交后权威重读，返回 `verifiedPostState`，包含触及对象及完整 sourceVersion。外层 afterList 从该结果生成，删除为了生成 afterList 的第四次 loadMapDocument。

必要的 native 提交后重读不能被缓存替代。该重读必须绕过以旧 revision 为键的投影，读到真实新 outer/payload hash。可以复用新解析结果在 Core/main 之间传递，不再重复 IO/JSON/sceneGraph 构造。

### 1.5.4 验证与前端合同

新增 `runAuditMapSelectionSmoke.ts`，使用实际 `queryMapEntities` / `batchTransformMapParts`。测试 modelName 匹配两项但 entityId 只匹配一项；一个有效目标加一个不存在目标；两个别名指向同一目标；读后源文件变化；无效 float；量化 no-op；外层 afterList 不触发额外 load。

mock 调用次数只能验证函数编排，另需真实 `runBridge` trace 的 sourceHash、command、responseBytes、parse/projection 计数。UI 接收 `verifiedPostState` 时以同一 revision 更新已打开对象；前端不自行再读“某个同名对象”替代返回的 handle。SF-29 验证用户看到的更新。
