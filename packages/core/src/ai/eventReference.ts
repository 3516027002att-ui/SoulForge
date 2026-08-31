/**
 * 社区积累的 Sekiro 事件经验笔记的轻量语义索引。
 *
 * 这些条目只用于把“血条、落雷、掉落”等自然语言映射到可能的 EMEVD
 * 指令名。它们是有价值的领域经验，但不是当前工作区的 native snapshot；
 * 调用方必须继续用 search_events/read_emevd_outline 和当前 EMEDF 确认具体身份。
 */

export interface EventReferenceMatch {
  instruction: string;
  aliases: string[];
  description: string;
  sourceUri: string;
  authority: 'community-reference';
  score: number;
}

const EVENT_REFERENCE_SOURCE = 'reference://community/sekiro-event-notes';

interface EventReferenceEntry {
  instruction: string;
  aliases: readonly string[];
  description: string;
}

/**
 * 仅收录社区笔记中对 Agent 定位最有帮助的语义入口；具体参数签名仍以
 * 当前工作区的 EMEVD/EMEDF 读取为准。别名刻意包含中英文和常见口语。
 */
const EVENT_REFERENCE_ENTRIES: readonly EventReferenceEntry[] = [
  { instruction: 'DisplayBossHealthBar', aliases: ['血条', 'boss血条', '首领血条', '显示boss血条', '显示首领血条', 'boss health bar'], description: '显示屏幕下方的 Boss/首领血条。' },
  { instruction: 'SetCharacterHPBarDisplay', aliases: ['头顶血条', '头顶血量', '关闭头顶血条', '人物血量显示'], description: '控制角色头顶的 HP 显示，不等同于 Boss 血条。' },
  { instruction: 'IfCharacterHPValue', aliases: ['血量小于', 'hp小于', '生命值条件', '血量条件', 'hp condition'], description: '按角色当前 HP 建立条件分支。' },
  { instruction: 'SpawnMapSFX', aliases: ['落雷', '雷电', '闪电', '地图特效', '天气特效', '地面随机特效', 'map sfx'], description: '调用地图/天气特效；具体特效编号和持续方式必须从事件与参数确认。' },
  { instruction: 'DeleteMapSFX', aliases: ['关闭落雷', '关闭地图特效', '删除地图特效', '停止天气特效'], description: '删除或关闭地图特效；不可据此猜测特效编号。' },
  { instruction: 'AwardItemLot', aliases: ['掉落', '奖励', '奖励组', '击杀奖励', '击杀后掉落', 'item lot', 'award'], description: '触发 ItemLot/奖励组；奖励组 ID 必须沿事件或参数引用读取。' },
  { instruction: 'HandleBossDefeat', aliases: ['击杀', '首领死亡', 'boss死亡', '忍杀字幕', '击杀字幕', 'boss defeat'], description: '处理首领击败后的通用流程或字幕；具体语义需由原生事件确认。' },
  { instruction: 'HandleBossDefeatAndDisplayBanner', aliases: ['击败字幕', '显示击杀横幅', '不死斩字幕', '踏破字幕', 'boss banner'], description: '处理首领击败并显示横幅文本。' },
  { instruction: 'ForceCharacterDeath', aliases: ['强制死亡', '强制npc死亡', '让敌人死亡', 'force death'], description: '请求角色死亡；是否掉钱、掉落或触发其它事件不能从笔记单独推断。' },
  { instruction: 'IfCharacterDeadalive', aliases: ['判断死亡', '判断npc死亡', '角色是否死亡', 'dead alive'], description: '检测角色生死状态。笔记中的拼写需要由当前 EMEDF/native 名称校正。' },
  { instruction: 'SetCharacterTeamType', aliases: ['阵营', '友方', '敌方', '不攻击', '不攻击狼', '让敌人不攻击玩家', 'team type'], description: '设置角色阵营候选；要实现不攻击关系还要检查 AI、目标和伤害条件。' },
  { instruction: 'ForceCharacterTarget', aliases: ['强制索敌', '锁定目标', '强制锁定狼', 'force target'], description: '强制设置角色目标；目标实体 ID 必须由 MSB/事件读取确认。' },
  { instruction: 'IfCharacterDamagedBy', aliases: ['被谁攻击', '玩家攻击敌人', '狼攻击', '伤害来源', 'damaged by'], description: '检测角色是否被指定来源伤害，可用于验证或阻止错误攻击关系。' },
  { instruction: 'IfPlayerLockedOn', aliases: ['玩家锁定', '锁定npc', '锁定目标', 'locked on'], description: '检测玩家是否锁定指定实体。' },
  { instruction: 'IfCharacterAIState', aliases: ['战斗状态', '警戒状态', 'ai状态', 'combat state', 'alert state'], description: '按角色 AI 状态建立条件。' },
  { instruction: 'SetCharacterAIState', aliases: ['关闭ai', '开启ai', '设置ai状态', 'ai state'], description: '设置或关闭角色 AI 状态；必须确认当前事件和 AI 语义。' },
  { instruction: 'SetCharacterAIId', aliases: ['更换ai', 'ai id', '切换ai'], description: '设置角色使用的 AI 参数候选；AI ID 必须从当前资源读取。' },
  { instruction: 'RequestCharacterAICommand', aliases: ['ai命令', '发送ai命令', '请求ai计划', 'ai command'], description: '向角色 AI 发送命令；是否生效依赖 AI 计划。' },
  { instruction: 'RequestCharacterAIReplan', aliases: ['ai重规划', '重新规划ai', 'ai replan'], description: '请求角色 AI 重新规划。' },
  { instruction: 'SetCharacterImmortality', aliases: ['不死身', '无敌', '角色不死', 'immortality'], description: '设置角色不死/免死候选状态。' },
  { instruction: 'SetCharacterAnimationState', aliases: ['不能动', '可以动', '开启动作', '关闭动画', '让单位行动', 'animation state'], description: '控制角色动画/行动状态；与显示或隐藏角色是不同层。' },
  { instruction: 'ChangeCharacterEnableState', aliases: ['显示人物', '隐藏人物', '启用人物', '禁用人物', 'enable state'], description: '控制角色是否启用/显示，不等同于允许其行动。' },
  { instruction: 'ForceAnimationPlayback', aliases: ['强制动作', '播放动作', '强制播放动画', 'force animation'], description: '强制角色播放指定动画。动画 ID 必须通过动作原生身份解析。' },
  { instruction: 'SetSpEffect', aliases: ['添加特效', '给角色加特效', 'sp effect', '施加状态'], description: '给角色施加 SpEffect；特效 ID 和持续性必须从 PARAM/事件读取。' },
  { instruction: 'ClearSpEffect', aliases: ['移除特效', '清除特效', '删除状态', 'clear sp effect'], description: '清除角色身上的 SpEffect。' },
  { instruction: 'IfCharacterHasSpEffect', aliases: ['是否有特效', '判断特效', '角色有状态', 'has sp effect'], description: '检测角色是否拥有指定 SpEffect。' },
  { instruction: 'InitializeCommonEvent', aliases: ['公共事件', '注册事件函数', 'common event', '初始化公共事件'], description: '调用已注册公共事件；参数数量和含义必须以当前 EMEVD/EMEDF 确认。' },
  { instruction: 'InitializeEvent', aliases: ['初始化事件', '事件入口', 'initialize event'], description: '初始化本地或关联事件。' },
  { instruction: 'Event', aliases: ['事件定义', '开启事件', 'event definition'], description: '事件定义/入口的源码结构候选。' },
  { instruction: 'Label0', aliases: ['标签', '跳转标签', 'label'], description: '事件控制流标签候选；实际源码语法由当前编译器确认。' },
  { instruction: 'EndUnconditionally', aliases: ['结束事件', '无条件结束', 'end event'], description: '无条件结束当前事件。' },
  { instruction: 'IfConditionGroup', aliases: ['条件组', 'or条件', 'and条件', 'condition group'], description: '根据条件组结果控制流程。' },
  { instruction: 'CharacterAIState', aliases: ['角色ai状态', 'ai状态读取', 'character ai state'], description: '社区笔记中的 AI 状态简写，实际指令名需由当前 EMEDF 校正。' },
  { instruction: 'SetEventFlag', aliases: ['事件标记', '开启flag', '关闭flag', 'event flag'], description: '设置事件 Flag；Flag ID 不能凭笔记猜测。' },
  { instruction: 'GotoIfEventFlag', aliases: ['按flag跳转', '事件标记跳转', 'goto flag'], description: '按事件 Flag 条件跳转到标签。' },
  { instruction: 'WaitFixedTimeSeconds', aliases: ['WaitFixedTimeSecond', '等待秒', '延时秒', '等待时间', 'wait seconds'], description: '按秒等待；社区笔记中也出现单数拼写，实际名称需由 EMEDF 校正。' },
  { instruction: 'SetMenuFade', aliases: ['黑屏', '淡出', '淡入', '菜单淡入淡出', 'menu fade'], description: '设置菜单/画面的淡入淡出，通常与过场或传送配合。' },
  { instruction: 'WaitFixedTimeFrames', aliases: ['等待帧', '延时帧', 'wait frames'], description: '按帧等待。' },
  { instruction: 'WaitRandomTimeSeconds', aliases: ['随机等待', '随机延时', 'random wait'], description: '在时间范围内随机等待。' },
  { instruction: 'IfInoutsideArea', aliases: ['进入区域', '区域内', '区域触发', 'inside area'], description: '判断玩家或实体是否在区域内/外。' },
  { instruction: 'IfEntityInoutsideRadiusOfEntity', aliases: ['距离触发', '距离范围', '半径判断', 'radius condition'], description: '判断两个实体间的距离或内外半径关系。' },
  { instruction: 'WarpCharacterAndCopyFloor', aliases: ['拉到狼身边', '召唤到玩家旁', '传送到玩家', 'copy floor warp'], description: '把角色传送到目标附近并复制楼层信息。' },
  { instruction: 'WarpCharacterAndSetFloor', aliases: ['传送角色', '传送到点位', 'set floor warp'], description: '把角色传送到地图实体/区域点位。' },
  { instruction: 'IssueShortWarpRequest', aliases: ['短距离传送', '短传', 'short warp'], description: '发出短距离传送请求。' },
  { instruction: 'PlayCutsceneAndWarpPlayer', aliases: ['cg', '过场动画', '播放过场并传送', 'cutscene warp'], description: '播放过场并传送玩家。' },
  { instruction: 'PlayCutsceneAndWarpPlayerWithLighting200213', aliases: ['带光照过场', '过场光照', 'lighting cutscene'], description: '播放带区域光照设置的过场并传送玩家。' },
  { instruction: 'IfOngoingCutsceneFinished', aliases: ['过场结束', 'cg结束', 'cutscene finished'], description: '判断正在播放的过场是否结束。' },
  { instruction: 'IfActionButton', aliases: ['动作键', '按键触发', 'action button'], description: '检测玩家对指定实体的动作键交互。' },
  { instruction: 'SetObjectInteraction', aliases: ['禁用鬼佛', '物体交互', 'object interaction'], description: '设置对象交互类型和启用状态。' },
  { instruction: 'CreateObjectfollowingSFX', aliases: ['雾门', '创建雾门', '物体雾效', 'fog wall'], description: '为对象创建跟随特效，笔记将其用于雾门候选。' },
  { instruction: 'DeleteObjectfollowingSFX', aliases: ['关闭雾门', '删除物体特效', 'fog wall off'], description: '关闭或删除对象跟随特效。' },
  { instruction: 'DeactivateObject', aliases: ['关闭物体', '开启物体', '物体启用', 'object enable'], description: '控制地图对象启用状态。' },
  { instruction: 'ActivateMapPart', aliases: ['启用地图部件', '开启地图part', 'map part enable'], description: '启用地图部件。' },
  { instruction: 'MakeEnemyAppearEvent', aliases: ['敌人出现', '复活敌人', '召唤敌人', 'enemy appear'], description: '触发敌人出现/复活事件候选，通常还依赖地图出生点和事件条件。' },
  { instruction: 'SetMapCeremony', aliases: ['地图仪式', '改变地图状态', 'map ceremony'], description: '设置地图仪式/状态候选。' },
  { instruction: 'SetAreaEnvmap', aliases: ['昼夜', '天气', '环境天气', '改变场景天气', 'environment map'], description: '设置区域环境/昼夜天气候选；数值必须由当前游戏数据验证。' },
  { instruction: 'SetAreaCamerasetparamSubid', aliases: ['区域镜头', '镜头参数', 'camera set'], description: '设置区域镜头参数子 ID。' },
  { instruction: 'SetLightingUnknown', aliases: ['设置光照', '早晨', '中午', '夜晚光照', 'lighting'], description: '设置区域光照时间候选；具体枚举必须由当前 EMEDF 确认。' },
  { instruction: 'RandomlySetEventFlagInRange', aliases: ['随机flag', '随机事件标记', 'random event flag'], description: '在 Flag 范围内随机设置事件标记。' },
  { instruction: 'PlaySE', aliases: ['音效', '播放声音', 'sound effect', 'se'], description: '播放声音效果。' },
  { instruction: 'ShowTutorialText', aliases: ['教程文本', '辅助说明', 'tutorial text'], description: '显示教程/辅助文本。' },
  { instruction: 'ShowHintBox', aliases: ['提示框', '显示提示', 'hint box'], description: '显示提示框。' },
  { instruction: 'ShowSmallHintBox', aliases: ['小提示', '左侧小字', 'small hint'], description: '显示小型提示框。' },
  { instruction: 'DisplayGenericDialogGloballyAndSetEventFlags', aliases: ['全局对话框', '确认框', 'ok cancel', 'dialog flags'], description: '显示全局对话并设置事件 Flag。' },
  { instruction: 'RemoveItemFromPlayer', aliases: ['删除玩家物品', '扣除物品', 'remove item'], description: '从玩家物品栏移除指定数量。' },
  { instruction: 'IfPlayerHasdoesntHaveItem', aliases: ['是否拥有物品', '玩家有无物品', 'has item'], description: '判断玩家是否拥有物品。笔记中的拼写需以 EMEDF 校正。' },
  { instruction: 'StoreItemAmountHeldInEventValue', aliases: ['记录物品数量', '物品数量存事件值', 'item amount'], description: '把玩家持有数量写入事件值。' },
  { instruction: 'SetPlayerRespawnPoint', aliases: ['重生点', '设置重生点', 'respawn point'], description: '设置玩家重生点。' },
  { instruction: 'WarpPlayerWithinAreaSettingCameraOrientation', aliases: ['区域传送', '传送并设置镜头', 'player area warp'], description: '在区域设置中传送玩家并设置镜头朝向。' },
  { instruction: 'WarpPlayerNew', aliases: ['玩家传送', '传送地图', 'player warp'], description: '传送玩家到目标地图/点位。' },
  { instruction: 'DisableBonfire', aliases: ['禁用鬼佛', '关闭鬼佛', 'bonfire'], description: '禁用指定鬼佛/篝火交互。' },
  { instruction: 'SaveRequest', aliases: ['保存', '请求保存', 'save request'], description: '请求保存。' },
  { instruction: 'SetLockOnPoint', aliases: ['锁定点', '锁定位置', 'lock on point'], description: '设置角色锁定点候选。' },
  { instruction: 'RequestAnimationPlayback', aliases: ['请求动画', '动画播放请求', 'animation request'], description: '请求播放动画。' },
  { instruction: 'ReproduceObjectAnimation', aliases: ['物体动画', '重放物体动画', 'object animation'], description: '播放/重放物体动画。' },
  { instruction: 'ResetCharacterPosition', aliases: ['重置位置', '重置角色位置', 'reset position'], description: '重置角色位置。' },
  { instruction: 'SetCharacterDefaultBackreadState', aliases: ['backread', '默认加载状态', '角色后台加载'], description: '设置角色的默认 backread/加载状态。' },
  { instruction: 'SetNPCPartSEAndSFX', aliases: ['npc部位特效', '部位音效', 'npc part sfx'], description: '设置 NPC 部位的声音与特效。' },
  { instruction: 'CreateNPCPart', aliases: ['创建npc部位', '部位生成', 'create npc part'], description: '创建或配置 NPC 部位。' },
  { instruction: 'IncrementEventValue', aliases: ['事件值增加', '计数器', 'increment event value'], description: '增加事件值。' },
  { instruction: 'EzstateInstructionRequest', aliases: ['特殊处决', 'ezstate', '处决请求'], description: '请求 EzState 指令候选；参数必须由当前事件 schema 确认。' },
  { instruction: 'GrantSkill', aliases: ['授予技能', '获得技能', 'grant skill'], description: '授予玩家技能。' },
  { instruction: 'GotoIfPlayerInoutMap', aliases: ['玩家在地图', '地图内外判断', 'goto map'], description: '按玩家是否在指定地图进行事件跳转。' },
  { instruction: 'IfPlayerSwimState', aliases: ['游泳状态', '潜水状态', 'swim state'], description: '检测玩家游泳或潜水状态。' },
  { instruction: 'PlayerSwimState', aliases: ['设置游泳状态', 'player swim'], description: '读取/设置玩家游泳状态候选。' },
  { instruction: 'PlayerIsLookingAtEntity', aliases: ['看向实体', '注视目标', 'looking at entity'], description: '判断玩家是否正在看向指定实体。' },
  { instruction: 'DisplayAreaWelcomeMessage', aliases: ['区域欢迎语', '区域提示', 'area welcome'], description: '显示区域欢迎信息。' }
];

export const EVENT_REFERENCE_SOURCE_URI = EVENT_REFERENCE_SOURCE;

export function searchEventReference(query: string, limit = 20): EventReferenceMatch[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const queryLatin = normalizedQuery.match(/[a-z][a-z0-9_]*/gu) ?? [];
  const queryHan = unique([...normalizedQuery].filter((char) => /\p{Script=Han}/u.test(char)));
  const scored = EVENT_REFERENCE_ENTRIES.flatMap((entry) => {
    const haystack = normalize([entry.instruction, ...entry.aliases, entry.description].join(' '));
    let score = 0;
    if (haystack.includes(normalizedQuery)) score += 100;
    for (const token of queryLatin) if (haystack.includes(token)) score += 20;
    for (const alias of entry.aliases) {
      const normalizedAlias = normalize(alias);
      if (normalizedAlias && (normalizedQuery.includes(normalizedAlias) || normalizedAlias.includes(normalizedQuery))) score += 35;
    }
    const entryHan = unique([...haystack].filter((char) => /\p{Script=Han}/u.test(char)));
    const overlap = queryHan.filter((char) => entryHan.includes(char)).length;
    if (queryHan.length >= 2 && overlap >= 2) score += overlap * 4;
    if (score === 0) return [];
    return [{
      instruction: entry.instruction,
      aliases: [...entry.aliases],
      description: entry.description,
      sourceUri: `${EVENT_REFERENCE_SOURCE}#${entry.instruction}`,
      authority: 'community-reference' as const,
      score
    }];
  });
  return scored
    .sort((left, right) => right.score - left.score || left.instruction.localeCompare(right.instruction))
    .slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_#:/\\.(),，。；;：:\-]+/gu, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
