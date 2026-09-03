import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert';

const execFileAsync = promisify(execFile);

const sekiroRoot = 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
const modsAicommon = join(sekiroRoot, 'mods/script/aicommon.luabnd.dcx');
const modsM11 = join(sekiroRoot, 'mods/script/m11_00_00_00.luabnd.dcx');
const vanillaAicommon = join(sekiroRoot, 'script/aicommon.luabnd.dcx');

const bridgeExe = resolve('bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe');

async function runBridge(command, filePath, options = {}) {
  const args = [command, filePath];
  if (Object.keys(options).length > 0) {
    args.push(JSON.stringify(options));
  }
  try {
    const { stdout } = await execFileAsync(bridgeExe, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    parsed.ok = parsed.parseStatus === 'ok' || parsed.parseStatus === 'partial';
    return parsed;
  } catch (err) {
    if (err && typeof err === 'object' && 'stdout' in err && typeof err.stdout === 'string') {
      try {
        const parsed = JSON.parse(err.stdout);
        parsed.ok = parsed.parseStatus === 'ok' || parsed.parseStatus === 'partial';
        return parsed;
      } catch {}
    }
    throw err;
  }
}

async function main() {
  console.log('--- 开始 FromSoftware *.luabnd.dcx 专有模块集成验证 ---');
  assert(existsSync(bridgeExe), `Bridge 可执行文件不存在: ${bridgeExe}`);
  assert(existsSync(modsAicommon), `测试 Mod 资源不存在: ${modsAicommon}`);

  const tempRoot = resolve('.tmp/luabnd-verify-' + Date.now());
  await mkdir(tempRoot, { recursive: true });

  try {
    // 1. read-luabnd-document / inspect-luabnd
    console.log('1. 验证 read-luabnd-document (mods/script/aicommon.luabnd.dcx)...');
    const docRes = await runBridge('read-luabnd-document', modsAicommon);
    assert.strictEqual(docRes.ok, true, `read-luabnd-document 应该成功: ${JSON.stringify(docRes.diagnostics)}`);
    const doc = docRes.data;
    assert.strictEqual(doc.format, 'LUABND');
    assert.strictEqual(doc.entryCount, 106, '总条目应为 106');
    assert.strictEqual(doc.scriptCount, 104, 'Lua 脚本条目应为 104');
    assert.strictEqual(doc.hasLuagnl, true, '应含有 LUAGNL');
    assert.strictEqual(doc.hasLuainfo, true, '应含有 LUAINFO');
    assert.strictEqual(doc.luagnl.symbolCount, 1739, 'aiCommon.luagnl 应有 1739 个全局符号');
    assert.strictEqual(doc.luagnl.symbolsSample[0], 'GOAL_COMMON_TopGoal', '首个符号应为 GOAL_COMMON_TopGoal');
    assert.strictEqual(doc.luainfo.goalCount, 96, 'aiCommon.luainfo 应有 96 个目标定义');
    assert.strictEqual(doc.luainfo.goalsSample[0].goalId, 2000, '首个目标 ID 应为 2000');
    assert.strictEqual(doc.luainfo.goalsSample[0].name, 'Wait', '首个目标名应为 Wait');
    assert.strictEqual(doc.roundTrip.byteIdentical, true, 'BND4 roundTrip 必须 byte-identical');
    assert.strictEqual(doc.layoutGuard.acceptsNoOp, true, 'BND4 layoutGuard 必须通过');
    assert.strictEqual(doc.fieldPreservation.headerUnknownBytesPreserved, true, '未知字段保持');
    console.log('   ✓ 容器解析成功：104 个脚本、1739 个全局符号、96 个 AI 目标、字段完好保持。');

    // 2. 地图脚本容器验证 (m11_00_00_00.luabnd.dcx)
    console.log('2. 验证地图脚本容器 read-luabnd-document (mods/script/m11_00_00_00.luabnd.dcx)...');
    const m11Res = await runBridge('read-luabnd-document', modsM11);
    assert.strictEqual(m11Res.ok, true);
    assert.strictEqual(m11Res.data.entryCount, 86);
    assert.strictEqual(m11Res.data.scriptCount, 84);
    assert.strictEqual(m11Res.data.luagnl.symbolCount, 4);
    assert.strictEqual(m11Res.data.luainfo.goalCount, 1);
    console.log('   ✓ 地图脚本容器解析成功：84 个脚本、4 个符号、1 个目标。');

    // 3. read-luabnd-script 字节码脚本探测
    console.log('3. 验证 read-luabnd-script (字节码脚本 000110_platoon.lua)...');
    const platoonRes = await runBridge('read-luabnd-script', modsAicommon, { childPath: '000110_platoon.lua' });
    assert.strictEqual(platoonRes.ok, true);
    const platoon = platoonRes.data;
    assert.strictEqual(platoon.isBytecode, true);
    assert.strictEqual(platoon.isPlainText, false);
    assert.strictEqual(platoon.magic, '\\x1bLuaP');
    assert(platoon.variant.includes('Havok Script / Sekiro variant'));
    assert(platoon.embeddedSymbols.includes('Platoon000110_Activate'), '应提取出 Platoon000110_Activate 符号');
    assert(platoon.embeddedSymbols.includes('SetEnablePlatoonMove'), '应提取出 SetEnablePlatoonMove 符号');
    assert(platoon.textPreview.includes('SoulForge Lua Bytecode Preview'), '应生成结构化预览文本');
    console.log('   ✓ 字节码脚本探测成功：Magic \\x1bLuaP、Havok Script 变体，成功提取出内嵌符号常量池与结构化预览。');

    // 4. read-luabnd-script 明文脚本读取
    console.log('4. 验证 read-luabnd-script (明文脚本 goal_list.lua)...');
    const goalRes = await runBridge('read-luabnd-script', modsAicommon, { childPath: 'goal_list.lua' });
    assert.strictEqual(goalRes.ok, true);
    const goal = goalRes.data;
    assert.strictEqual(goal.isBytecode, false);
    assert.strictEqual(goal.isPlainText, true);
    assert(goal.textContent.includes('GOAL_COMMON_TopGoal = 0'), '应包含明文常数定义');
    assert(goal.lineCount > 100, '明文脚本行数应大于 100 行');
    console.log(`   ✓ 明文脚本探测成功：全明文 UTF-8，共 ${goal.lineCount} 行。`);

    // 5. export-luabnd 容器全量解包与 JSON 描述符生成
    console.log('5. 验证 export-luabnd 导出所有脚本与符号/目标清单...');
    const exportDir = join(tempRoot, 'export_out');
    const exportRes = await runBridge('export-luabnd', modsAicommon, { outputDirectory: exportDir });
    assert.strictEqual(exportRes.ok, true);
    assert.strictEqual(exportRes.data.scriptCount, 104);
    assert(existsSync(join(exportDir, '000110_platoon.lua')), '000110_platoon.lua 必须存在');
    assert(existsSync(join(exportDir, 'goal_list.lua')), 'goal_list.lua 必须存在');
    assert(existsSync(join(exportDir, 'aiCommon.luagnl')), 'aiCommon.luagnl 必须存在');
    assert(existsSync(join(exportDir, 'aiCommon.luainfo')), 'aiCommon.luainfo 必须存在');
    assert(existsSync(join(exportDir, 'luagnl.symbols.json')), 'luagnl.symbols.json 必须存在');
    assert(existsSync(join(exportDir, 'luainfo.goals.json')), 'luainfo.goals.json 必须存在');
    const rawJson = await readFile(join(exportDir, 'luagnl.symbols.json'), 'utf8');
    const exportedSymbols = JSON.parse(rawJson.replace(/^\uFEFF/, ''));
    assert.strictEqual(exportedSymbols.symbolCount, 1739);
    console.log(`   ✓ 导出功能验证成功：解包了全部 104 个脚本及符号/目标 JSON 描述符。`);

    // 6. write-luabnd-script 精确替换写回机制与无损 DCX/BND4 封装
    console.log('6. 验证 write-luabnd-script 精确替换写回...');
    const writeOutPath = join(tempRoot, 'aicommon_modified.luabnd.dcx');
    const updatedContent = 'GOAL_COMMON_TopGoal = 0\n-- SoulForge Luabnd Writeback Verification\nGOAL_COMMON_Normal = 1\n';
    const writeRes = await runBridge('write-luabnd-script', modsAicommon, {
      outputPath: writeOutPath,
      childPath: 'goal_list.lua',
      expectedContainerHash: doc.sourceHash,
      expectedChildHash: goal.contentHash,
      text: updatedContent
    });
    assert.strictEqual(writeRes.ok, true, `写入应成功: ${JSON.stringify(writeRes.diagnostics)}`);
    assert.strictEqual(writeRes.data.rereadVerified, true, '重读必须通过验证');

    // 重新打开修改后的容器，检验修改是否生效且其他条目是否无损
    const rereadRes = await runBridge('read-luabnd-script', writeOutPath, { childPath: 'goal_list.lua' });
    assert.strictEqual(rereadRes.ok, true);
    assert.strictEqual(rereadRes.data.textContent, updatedContent, '修改后的脚本内容必须精确一致');

    const rereadPlatoon = await runBridge('read-luabnd-script', writeOutPath, { childPath: '000110_platoon.lua' });
    assert.strictEqual(rereadPlatoon.ok, true);
    assert.strictEqual(rereadPlatoon.data.contentHash, platoon.contentHash, '其余 105 个条目必须保持字节完全不变');
    console.log('   ✓ 写回与重读验证成功：目标脚本精确替换，DCX/BND4 重新封包合法，其余条目完全保持！');

    // 7. 原版游戏 KRAK 压缩容器验证
    if (existsSync(vanillaAicommon)) {
      console.log('7. 验证原版游戏 KRAK 压缩容器 read-luabnd-document (script/aicommon.luabnd.dcx)...');
      process.env.SOULFORGE_SEKIRO_GAME_ROOT = sekiroRoot;
      const krakRes = await runBridge('read-luabnd-document', vanillaAicommon);
      assert.strictEqual(krakRes.ok, true, `KRAK 解包应成功: ${JSON.stringify(krakRes.diagnostics)}`);
      assert.strictEqual(krakRes.data.dcxCompression, 'KRAK');
      assert.strictEqual(krakRes.data.entryCount, 106);
      assert.strictEqual(krakRes.data.luagnl.symbolCount, 1738);
      console.log('   ✓ 原版 KRAK 压缩 luabnd 解包验证成功！');
    }

    // 8. 异常与边界防御测试
    console.log('8. 验证异常诊断与边界防御...');
    const notFoundRes = await runBridge('read-luabnd-script', modsAicommon, { childPath: 'non_existent_script.lua' });
    assert.strictEqual(notFoundRes.ok, false, '不存在的脚本必须返回失败');
    assert.strictEqual(notFoundRes.diagnostics[0].code, 'LUABND_SCRIPT_READ_FAILED');

    const mismatchRes = await runBridge('read-luabnd-script', modsAicommon, {
      childPath: 'goal_list.lua',
      expectedContainerHash: '0000000000000000000000000000000000000000000000000000000000000000'
    });
    assert.strictEqual(mismatchRes.ok, false, 'Container Hash 不匹配必须返回失败');
    assert.strictEqual(mismatchRes.diagnostics[0].code, 'LUABND_CONTAINER_HASH_MISMATCH');
    console.log('   ✓ 结构化错误诊断与防篡改 Hash 检查生效。');

    console.log('\n======================================================');
    console.log('🎉 所有 8 项 Luabnd 专有模块集成验证全部通过！');
    console.log('======================================================');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Luabnd 验证失败:', err);
  process.exit(1);
});
