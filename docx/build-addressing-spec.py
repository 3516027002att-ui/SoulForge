# -*- coding: utf-8 -*-
"""Generate SoulForge action/map Agent addressing spec. Run from repo root or this folder."""
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

OUT = Path(__file__).resolve().parent / "动作与地图Agent编址.docx"

NAVY = RGBColor(0x1B, 0x3A, 0x4B)
INK = RGBColor(0x22, 0x22, 0x22)
MUTED = RGBColor(0x55, 0x55, 0x55)
CODE_BG = "F4F1EA"


def set_run_font(run, *, size=11, bold=False, color=INK, east_asia="微软雅黑", ascii_font="Calibri", mono=False):
    run.bold = bold
    run.font.size = Pt(size)
    run.font.color.rgb = color
    run.font.name = "Consolas" if mono else ascii_font
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.get_or_add_rFonts()
    rfonts.set(qn("w:ascii"), "Consolas" if mono else ascii_font)
    rfonts.set(qn("w:hAnsi"), "Consolas" if mono else ascii_font)
    rfonts.set(qn("w:eastAsia"), east_asia)


def add_para(doc, text, *, size=11, bold=False, color=INK, space_after=8, space_before=0, align=None):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.space_before = Pt(space_before)
    p.paragraph_format.line_spacing = 1.15
    run = p.add_run(text)
    set_run_font(run, size=size, bold=bold, color=color)
    return p


def add_heading_custom(doc, text, level):
    sizes = {1: 18, 2: 14, 3: 12}
    p = doc.add_heading(text, level=level)
    for run in p.runs:
        set_run_font(run, size=sizes.get(level, 12), bold=True, color=NAVY, east_asia="微软雅黑")
    p.paragraph_format.space_before = Pt(14 if level > 1 else 6)
    p.paragraph_format.space_after = Pt(8)
    return p


def add_code_block(doc, lines):
    for i, line in enumerate(lines):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(0 if i else 4)
        p.paragraph_format.space_after = Pt(0 if i < len(lines) - 1 else 10)
        p.paragraph_format.left_indent = Cm(0.4)
        shd = p._p.get_or_add_pPr()
        # keep simple: mono paragraph, no shading API hassle
        run = p.add_run(line if line else " ")
        set_run_font(run, size=10, mono=True, color=RGBColor(0x2A, 0x2A, 0x2A), east_asia="微软雅黑")


def shade_cell(cell, hex_color):
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    shd = tcPr.makeelement(qn("w:shd"), {
        qn("w:val"): "clear",
        qn("w:color"): "auto",
        qn("w:fill"): hex_color,
    })
    tcPr.append(shd)


def set_cell_text(cell, text, *, bold=False, header=False, mono=False):
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(text)
    set_run_font(
        run,
        size=9 if mono else 10,
        bold=bold or header,
        color=RGBColor(0xFF, 0xFF, 0xFF) if header else INK,
        mono=mono,
        east_asia="微软雅黑",
    )


def add_table(doc, headers, rows, col_widths_cm, mono_cols=()):
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = "Table Grid"
    table.autofit = False
    for i, w in enumerate(col_widths_cm):
        for cell in table.columns[i].cells:
            cell.width = Cm(w)
    for i, h in enumerate(headers):
        cell = table.rows[0].cells[i]
        shade_cell(cell, "1B3A4B")
        set_cell_text(cell, h, header=True)
    for r_i, row in enumerate(rows):
        for c_i, val in enumerate(row):
            cell = table.rows[r_i + 1].cells[c_i]
            if r_i % 2 == 1:
                shade_cell(cell, "F7F4EE")
            set_cell_text(cell, val, mono=c_i in mono_cols)
    doc.add_paragraph().paragraph_format.space_after = Pt(6)
    return table


def main():
    doc = Document()
    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.left_margin = Cm(2.2)
    section.right_margin = Cm(2.2)
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(2.0)

    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.font.color.rgb = INK
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), "微软雅黑")

    header = section.header
    hp = header.paragraphs[0]
    hr = hp.add_run("SoulForge · 动作 / 地图 Agent 编址")
    set_run_font(hr, size=9, color=MUTED, east_asia="微软雅黑")

    footer = section.footer
    fp = footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    fr = fp.add_run("与 锐评/grok.txt 问题 6 同一口径 · 2026-08-19")
    set_run_font(fr, size=9, color=MUTED, east_asia="微软雅黑")

    add_para(doc, "SoulForge", size=11, bold=True, color=NAVY, space_after=2)
    add_para(doc, "动作与地图的 Agent 编址", size=22, bold=True, color=NAVY, space_after=4)
    add_para(
        doc,
        "界面可以继续用现在的工作台。后端（索引 / RAG / Agent 读写工具）必须按参数同构的文本格式交出地址，Agent 才能查找和修改。",
        size=11,
        color=INK,
        space_after=12,
    )

    add_heading_custom(doc, "1. 产品句", 1)
    add_para(
        doc,
        "用户原话（2026-08-19）：文本的格式也有要求，虽然显示上适配当前界面，实际上和参数的格式类似，cXXXX，AXXXX，具体词条，起始帧结束帧等信息。地图是 MXXX，mxxxx，具体信息。只有后端都呈现这些信息，才方便 Agent 查找和修改。",
    )
    add_para(
        doc,
        "解包停在 Bridge 文档，不停在磁盘松散文件。一个 ID 只属于一个权威工具：帧时间属于 TAE，坐标属于 MSB，数值属于 PARAM，文案属于 FMG，地图逻辑属于 EMEVD。",
    )

    add_heading_custom(doc, "2. 参数是样板", 1)
    add_para(doc, "现有 PARAM 门面已经是「表 # 行 . 字段 = 绝对值」。动作和地图必须长得像它，而不是散文路径。")
    add_code_block(
        doc,
        [
            "EquipParamWeapon#70500.atkPhysCorrection = 320",
            "SpEffectParam#110111.changeStaminaPoint = 10",
        ],
    )
    add_para(doc, "检索：用户说「70500 琉璃」或「EquipParamWeapon#70500」应命中同一行。写入：mutate_param_fields 收同一地址。")

    add_heading_custom(doc, "3. 动作编址  cXXXX / AXXXX / 词条 / 帧", 1)
    add_para(doc, "角色是 cXXXX（来自 chr/c1050.anibnd.dcx 的茎）。动画是 A + animId 零填充四位；合法 hkx 茎是别名，不是第二套主键。词条用该动画 events 数组下标。时间对外是帧（30fps），对内仍是秒。")

    add_heading_custom(doc, "3.1 地址语法", 2)
    add_table(
        doc,
        ["层级", "形式", "例子", "含义"],
        [
            ["角色", "cXXXX", "c1050", "chr/c1050.anibnd.dcx + 伴生 chrbnd"],
            ["动画", "cXXXX#AXXXX", "c1050#A0200", "animId=200；别名 c1050#a000_020000"],
            ["词条", "cXXXX#AXXXX.eN", "c1050#A0200.e0", "该动画 events[0]"],
            ["字段", "….eN.field", "c1050#A0200.e0.startFrame", "起始帧 / 结束帧 / 已解码参数"],
        ],
        [2.4, 4.2, 5.4, 4.6],
        mono_cols={1, 2},
    )

    add_heading_custom(doc, "3.2 写入例子", 2)
    add_code_block(
        doc,
        [
            "c1050#A0200.e0.startFrame = 438",
            "c1050#A0200.e0.endFrame   = 441",
            "c1050#A0200.e0.SoundID    = 105011001",
        ],
    )
    add_para(doc, "未解码参数体禁止编造字段名，只能按模板 insert-event 拷贝。SoundID / SpEffect / Bullet / Atk 的数值本身走 mutate_param_fields，TAE 只存引用 ID。")

    add_heading_custom(doc, "3.3 RAG / 工具必须交出的正文", 2)
    add_para(doc, "每一条词条一块，字段给全，不许 24 条指令、200 条动画这种显示上限渗进索引。")
    add_code_block(
        doc,
        [
            "chr c1050",
            "anim A0200 animId 200 hkx a000_020000",
            "event e0 type 128 PlaySound_General",
            "startFrame 438 endFrame 441 startTime 14.6 endTime 14.7",
            "SoundType 1 SoundID 105011001",
            "source chr/c1050.anibnd.dcx",
        ],
    )
    add_para(doc, "检索「c1050」「A200」「A0200」「PlaySound」「438」「105011001」都必须能落到这块。queryParse 不得把 a000_020000 拆成 a000 与 020000。")

    add_heading_custom(doc, "4. 地图编址  MXXX / mxxxx / 实体", 1)
    add_para(doc, "区域是 M + 地图号两位（m11_01_00_00 → M11）。块是完整四段 mAA_BB_CC_DD，下划线是 ID 的一部分，禁止拆开。实体用 MSB 里的 part / region / event 名。")

    add_heading_custom(doc, "4.1 地址语法", 2)
    add_table(
        doc,
        ["层级", "形式", "例子", "含义"],
        [
            ["区域", "MXX", "M11", "只狼图号，如苇名城一带"],
            ["块", "mAA_BB_CC_DD", "m11_01_00_00", "具体 msb / mapbnd"],
            ["实体", "mAA_BB_CC_DD#name", "m11_01_00_00#c1050_0000", "part / region / event 名"],
            ["字段", "…#name.field", "m11_01_00_00#c1050_0000.posX", "位置 / 旋转 / 缩放 / model"],
        ],
        [2.4, 4.2, 5.6, 4.4],
        mono_cols={1, 2},
    )

    add_heading_custom(doc, "4.2 写入例子", 2)
    add_code_block(
        doc,
        [
            "m11_01_00_00#c1050_0000.posX = 12.5",
            "m11_01_00_00#c1050_0000.posY = 0.0",
            "m11_01_00_00#c1050_0000.posZ = -3.2",
        ],
    )

    add_heading_custom(doc, "4.3 RAG / 工具必须交出的正文", 2)
    add_code_block(
        doc,
        [
            "area M11",
            "map m11_01_00_00",
            "part c1050_0000 kind character",
            "model c1050 modelIndex 3",
            "pos 12.5 0.0 -3.2",
            "rot 0 90 0 scale 1 1 1",
            "source map/m11_01_00_00/m11_01_00_00.msb.dcx",
        ],
    )
    add_para(doc, "检索「M11」「m11_01_00_00」「c1050_0000」必须命中。queryParse 不得把 m11_01_00_00 按 _ 拆开。")

    add_heading_custom(doc, "5. 和现有工具怎么接", 1)
    add_table(
        doc,
        ["地址里出现的东西", "权威工具", "不要做的事"],
        [
            ["cXXXX#AXXXX.eN.startFrame / endFrame", "未来 read_tae_events / mutate_tae_event_times（包 write-tae-document）", "当 UTF-8 覆盖 anibnd"],
            ["词条里的 SoundID / SpEffect / Bullet / Atk", "现有 mutate_param_fields", "在 TAE 里再做一套数值编辑器"],
            ["角色/物品显示名", "现有 mutate_fmg_entries", "把 msgbnd 当文本文件"],
            ["mxxxx#name.pos / rot / scale", "未来 read_msb_parts / mutate_msb_part_transform（包 write-msb）", "地图页底下「实时模式」暗门"],
            ["part.model → cXXXX / 地图 FLVER", "现有 FlverViewer / FLVER 工作台（全部网格）", "只画 mesh[0] 或 12 个盒子"],
            ["地图 event 对到的 EMEVD id", "现有 apply_emevd_dsl", "在地图页嵌一套事件 DSL"],
        ],
        [5.2, 6.0, 5.4],
    )

    add_heading_custom(doc, "6. 现在缺什么（后端）", 1)
    add_para(doc, "RAG 家族只有 file / event / map_entity / map_region / param_row / text_entry。event 是 EMEVD，不是 TAE。没有 tae_event 家族，Agent 检索「c1050 A0200 PlaySound 438」落不到词条。")
    add_para(doc, "map_entity 正文只有 name / kind / model / mapId / position，没有 M11、没有完整 mAA_BB_CC_DD 原子 ID、没有 rot/scale/modelIndex。export-map 在 Bridge 里仍是未实现候选。")
    add_para(doc, "queryParse 把 _ - . / 都切成空格，m11_01_00_00 和 a000_020000 会被拆碎。tokenize 还丢掉长度小于等于 2 的非数字词。")
    add_para(doc, "Agent 还没有 read_tae_* / read_msb_*。显示层 200/40/12/256 若渗进索引，检索会假装完整。")

    add_heading_custom(doc, "7. 开工时必须做的", 1)
    add_para(doc, "1. 索引与 RAG 为每条 TAE 词条、每个 MSB part/region 产出上面这种正文和稳定 symbolUri（action://c1050/A0200/e0、map://m11_01_00_00/part/c1050_0000）。")
    add_para(doc, "2. retrieve_evidence / search_* 能按 c1050、A0200、M11、m11_01_00_00 命中。")
    add_para(doc, "3. 读写工具的入参收同一套地址，不要另一套 path+index。")
    add_para(doc, "4. 界面可以继续三栏，但选中行的 data-cite / 复制地址必须是这套字符串。")
    add_para(doc, "5. 字段给全。不要 MAX_FIELDS=24、MAX_INSTRUCTIONS=24 砍进 Agent 可见正文。")

    add_heading_custom(doc, "8. 不要做", 1)
    add_para(doc, "不要把 anibnd / mapbnd 解成工作区里一堆裸文件再当「适配」。不要为动作/地图再写一套数值编辑器去抢 PARAM。不要虚拟滚动、不要显示条数上限。不要做动画播放和编排。不要改治理 seal。")

    add_heading_custom(doc, "9. Flash 施工单（按刀做，做完一刀再下一刀）", 1)
    add_para(doc, "详细锚点、测试命令、负向扰动以 锐评/grok.txt 问题 6 为准。这里只留顺序，避免 flash 一次改二十个文件。")
    add_para(doc, "只读：本文件 1–5 节 + grok 问题 6 的「给 flash 的读法」列出的六个文件。不要通读交接书。")
    add_para(doc, "6-A  queryParse / tokenize：先抽出原子地址再切词。m11_01_00_00、a000_020000、c1050#A0200 不得被拆。lookupIndex 把原子词推进 byToken。")
    add_para(doc, "6-B  地图正文：MapEntitySymbol 补 modelIndex / scale / areaId；chunk 写成 area M11 + map m11_01_00_00 + address。不要实现 C# export-map，用 read-msb-document 的 parts 投影。")
    add_para(doc, "6-C  新家族 tae_event（不要改旧 event=EMEVD）。ResourceKind action 已存在。从 read-tae-document 信封投影 TaeExport。每条词条一块，SoundID 进 numericIds。")
    add_para(doc, "6-D  只加只读工具 search_tae_events。retrieve_evidence 说明里写上 cXXXX / AXXXX / MXX。跑 schema 门禁。")
    add_para(doc, "6-E  runRagRetrieveSmoke 加 c1050、A0200、m11_01_00_00、M11；旧 1100800 / 狼的义手 / common.emevd.dcx 必须仍绿。")
    add_para(doc, "6-F  下一 worktree：照抄 fmgEdit / emevdEdit 做 taeEdit / msbEdit。入参是地址字符串。写只包已有 write-tae-document / write-msb。本刀不做预览。")
    add_para(doc, "公共文件 packages/shared/src/soulAddress.ts（index.ts 要 export）。所有 padStart / 正则只准写在这里。")
    add_para(doc, "验证：npm run typecheck ； npm run test:rag。不要 gov seal。不要虚拟滚动。")

    add_para(doc, "本文与 锐评/grok.txt 问题 6 同步。冲突时以用户当次口述为准，两份一起改。", color=MUTED, space_before=16)

    doc.save(OUT)
    patch_settings_xml(OUT)
    print(f"wrote {OUT}")


def patch_settings_xml(path: Path) -> None:
    """python-docx writes w:zoom without required w:percent; schema validate fails."""
    import zipfile

    with zipfile.ZipFile(path, "r") as src:
        infos = src.infolist()
        datas = {info.filename: src.read(info.filename) for info in infos}
    settings = datas["word/settings.xml"].decode("utf-8")
    settings = settings.replace('<w:zoom w:val="bestFit"/>', '<w:zoom w:percent="100" w:val="bestFit"/>')
    settings = settings.replace('w:eastAsia="ja-JP"', 'w:eastAsia="zh-CN"')
    datas["word/settings.xml"] = settings.encode("utf-8")
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as dst:
        for info in infos:
            dst.writestr(info, datas[info.filename])


if __name__ == "__main__":
    main()
