//! 简历模板 ↔ Excel/CSV。口径逐条对齐插件 `popup.js` 的 `parseTemplateFile`、
//! `templateToSheetRows`、`templateExportFileName`、`getTemplateNameFromFile`。

use std::fmt;
use std::io::Cursor;

use calamine::{open_workbook_from_rs, Data, Reader, Xlsx};
use rust_xlsxwriter::Workbook;

pub const HEADER: [&str; 3] = ["一级分类", "字段名", "值"];
pub const SHEET_NAME: &str = "简历模板";
const UNGROUPED: &str = "未分类";
const UNNAMED: &str = "未命名模板";
const MAX_LISTED_ROW_NUMBERS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub name: String,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SheetError {
    UnsupportedExtension,
    Unreadable,
    NotUtf8,
    NoSheet,
    Empty,
    MissingKeys(Vec<usize>),
    NoFields,
    WriteFailed,
    CellTooLong { group: String, key: String },
}

impl fmt::Display for SheetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedExtension => f.write_str("仅支持 .xlsx 或 .csv 文件。"),
            Self::Unreadable => f.write_str("读不出这个文件，确认它没有损坏、也不是加密文件。"),
            Self::NotUtf8 => f.write_str("CSV 需要 UTF-8 编码：请在 Excel 里另存为「CSV UTF-8」，或直接用 .xlsx。"),
            Self::NoSheet => f.write_str("文件中没有可用工作表。"),
            Self::Empty => f.write_str("Excel 内容为空。"),
            // 手改的表要一次看到所有出错行；太多时几乎都是整列错位，列一墙数字没用。
            Self::MissingKeys(rows) if rows.len() > MAX_LISTED_ROW_NUMBERS => write!(
                f,
                "共 {} 行缺少「字段名」（第二列），请检查第二列是不是整列错位了。",
                rows.len()
            ),
            Self::MissingKeys(rows) => {
                let list: Vec<String> = rows.iter().map(|r| r.to_string()).collect();
                write!(f, "第 {} 行缺少「字段名」（第二列）。", list.join("、"))
            }
            Self::NoFields => f.write_str("未解析到任何字段，请检查 Excel 格式。"),
            Self::WriteFailed => f.write_str("生成 Excel 失败。"),
            Self::CellTooLong { group, key } => write!(
                f,
                "「{group} / {key}」超过 Excel 单元格上限 32767 字，无法导出。"
            ),
        }
    }
}

impl std::error::Error for SheetError {}

/// 一行的前三列，带表格里的真实行号（从 1 起）。
type Row = (usize, [String; 3]);

fn extension(file_name: &str) -> Option<String> {
    file_name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase())
}

pub fn parse(file_name: &str, bytes: &[u8]) -> Result<Vec<Group>, SheetError> {
    let rows = match extension(file_name).as_deref() {
        Some("xlsx") => xlsx_rows(bytes)?,
        Some("csv") => csv_rows(bytes)?,
        _ => return Err(SheetError::UnsupportedExtension),
    };
    groups_from_rows(rows)
}

/// 解一个 `_x([0-9A-Fa-f]{4})_` 转义序列，还原成对应字符。
/// rust_xlsxwriter/Excel 把共享字符串里的控制字符（`\t`、`\n` 除外）以及字面量
/// 出现的 `_xHHHH_` 序列本身，都转义成这种形式（字面量的下划线转义成
/// `_x005F_`）；calamine 0.30.1 读回来不会解码，这里手动单遍、从左到右扫描
/// 补上，不引入 regex 依赖。单遍扫描意味着 `_x005F_x0041_` 会先把开头的
/// `_x005F_` 解成 `_`，再把剩下的 `x0041_` 当成普通文本，结果是 `_x0041_`——
/// 这与 Excel 自己转义/反转义的行为一致。
fn decode_excel_escapes(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if i + 7 <= chars.len()
            && chars[i] == '_'
            && chars[i + 1] == 'x'
            && chars[i + 6] == '_'
            && chars[i + 2..i + 6].iter().all(|c| c.is_ascii_hexdigit())
        {
            let hex: String = chars[i + 2..i + 6].iter().collect();
            if let Ok(code) = u32::from_str_radix(&hex, 16) {
                if let Some(ch) = char::from_u32(code) {
                    out.push(ch);
                    i += 7;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => decode_excel_escapes(s),
        // 插件把 #N/A 等错误单元格当空值导入。
        Data::Error(_) => String::new(),
        // f64 的 Display 不会用科学计数法、也不带多余的 .0，唯一要收拾的是
        // 负零会打印成 "-0"；Excel 单元格里没有有意义的负零，统一成 "0"。
        Data::Float(v) if *v == 0.0 => "0".to_string(),
        other => other.to_string(),
    }
}

fn xlsx_rows(bytes: &[u8]) -> Result<Vec<Row>, SheetError> {
    let mut workbook: Xlsx<_> =
        open_workbook_from_rs(Cursor::new(bytes)).map_err(|_| SheetError::Unreadable)?;
    let first = workbook.sheet_names().first().cloned().ok_or(SheetError::NoSheet)?;
    let range = workbook.worksheet_range(&first).map_err(|_| SheetError::Unreadable)?;
    let (Some((top, left)), Some((bottom, _))) = (range.start(), range.end()) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for r in top..=bottom {
        // 插件（SheetJS）按 used range 相对取前三列；calamine 的 get_value 要
        // 绝对坐标，所以要在 used range 最左列（left）上加相对偏移。
        let cell = |c: u32| range.get_value((r, left + c)).map(cell_text).unwrap_or_default();
        rows.push((r as usize + 1, [cell(0), cell(1), cell(2)]));
    }
    Ok(rows)
}

/// 增量算「一条 CSV 记录在原文本里的真实行号」（从 1 起，`\r\n` 算一次换行）。
/// `csv` crate 的 `Position::line()` 在跳过空白行之后会不准，这里改成直接
/// 用 `Position::byte()`：先跳过记录前残留的换行符（空白行会被 csv
/// crate 悄悄跳过、不产生记录，但它们的换行符还留在这段字节里），再数
/// 这段文本里出现过几次真正的换行。
///
/// 记录按出现顺序依次喂进来，每条只重新扫描上一条到这一条之间的新增字节，
/// 而不是从头重扫——否则 5 MB 的 CSV 在 O(n²) 下会卡住。这依赖调用方按序
/// 调用（`byte` 不回退）；`scanned_upto` 落点保证之前的部分不会正好卡在一对
/// `\r\n` 中间（跳换行符的循环总是把连续的 `\r`/`\n` 一口气吃完才停），所以
/// 窗口化扫描不会因为漏看边界而把跨批次的 `\r\n` 数成两次、或漏数一次。
struct LineCounter {
    scanned_upto: usize,
    breaks_so_far: usize,
}

impl LineCounter {
    fn new() -> Self {
        Self { scanned_upto: 0, breaks_so_far: 0 }
    }

    fn line_number(&mut self, text: &str, byte: usize) -> usize {
        let bytes = text.as_bytes();
        // `byte.max(scanned_upto)` 只是防御性兜底：正常情况下 `byte` 不会回退。
        let mut start = byte.max(self.scanned_upto);
        while start < bytes.len() && (bytes[start] == b'\r' || bytes[start] == b'\n') {
            start += 1;
        }
        let mut i = self.scanned_upto;
        while i < start {
            match bytes[i] {
                b'\r' => {
                    self.breaks_so_far += 1;
                    i += if i + 1 < start && bytes[i + 1] == b'\n' { 2 } else { 1 };
                }
                b'\n' => {
                    self.breaks_so_far += 1;
                    i += 1;
                }
                _ => i += 1,
            }
        }
        self.scanned_upto = start;
        self.breaks_so_far + 1
    }
}

fn csv_rows(bytes: &[u8]) -> Result<Vec<Row>, SheetError> {
    let text = std::str::from_utf8(bytes).map_err(|_| SheetError::NotUtf8)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut rows = Vec::new();
    let mut counter = LineCounter::new();
    for (index, record) in reader.records().enumerate() {
        let record = record.map_err(|_| SheetError::Unreadable)?;
        let line = record
            .position()
            .map(|p| counter.line_number(text, p.byte() as usize))
            .unwrap_or(index + 1);
        let cell = |c: usize| record.get(c).unwrap_or("").to_string();
        rows.push((line, [cell(0), cell(1), cell(2)]));
    }
    Ok(rows)
}

/// 清理单元格文本：去首尾空白，并剥离 U+FEFF（BOM / 零宽不换行空格）。
/// Rust 的 `str::trim()` 不认 U+FEFF 为空白，但插件用的 JS
/// `String.prototype.trim()` 会剥离它——手改表格时，非首行的单元格
/// 也可能被另存为带 BOM 的编码，两边口径要对齐。
fn clean_cell(c: &str) -> String {
    c.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}').to_string()
}

fn groups_from_rows(rows: Vec<Row>) -> Result<Vec<Group>, SheetError> {
    let mut rows = rows
        .into_iter()
        .map(|(n, cells)| (n, cells.map(|c| clean_cell(&c))))
        .filter(|(_, cells)| cells.iter().any(|c| !c.is_empty()));
    // 第一行非空行是表头。
    if rows.next().is_none() {
        return Err(SheetError::Empty);
    }
    let mut groups: Vec<Group> = Vec::new();
    let mut missing = Vec::new();
    for (line, [group, key, value]) in rows {
        if key.is_empty() {
            missing.push(line);
            continue;
        }
        let name = if group.is_empty() { UNGROUPED.to_string() } else { group };
        match groups.iter_mut().find(|g| g.name == name) {
            Some(existing) => existing.fields.push(Field { key, value }),
            None => groups.push(Group { name, fields: vec![Field { key, value }] }),
        }
    }
    if !missing.is_empty() {
        return Err(SheetError::MissingKeys(missing));
    }
    if groups.is_empty() {
        return Err(SheetError::NoFields);
    }
    Ok(groups)
}

/// 表头和列序与 `parse` 读的同一套，导出的文件能原样导回来。
/// 不剔密码类字段：这是用户自己那份 Excel 的往返，剔了就导不回去了。
const MAX_CELL_CHARS: usize = 32_767;

pub fn write_xlsx(groups: &[Group]) -> Result<Vec<u8>, SheetError> {
    for group in groups {
        for field in &group.fields {
            if group.name.chars().count() > MAX_CELL_CHARS
                || field.key.chars().count() > MAX_CELL_CHARS
                || field.value.chars().count() > MAX_CELL_CHARS
            {
                return Err(SheetError::CellTooLong { group: group.name.clone(), key: field.key.clone() });
            }
        }
    }
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name(SHEET_NAME).map_err(|_| SheetError::WriteFailed)?;
    for (col, title) in HEADER.iter().enumerate() {
        sheet.write_string(0, col as u16, *title).map_err(|_| SheetError::WriteFailed)?;
    }
    let mut row: u32 = 1;
    for group in groups {
        for field in &group.fields {
            sheet.write_string(row, 0, &group.name).map_err(|_| SheetError::WriteFailed)?;
            sheet.write_string(row, 1, &field.key).map_err(|_| SheetError::WriteFailed)?;
            sheet.write_string(row, 2, &field.value).map_err(|_| SheetError::WriteFailed)?;
            row += 1;
        }
    }
    workbook.save_to_buffer().map_err(|_| SheetError::WriteFailed)
}

/// 对齐 `getTemplateNameFromFile`：`fileName.replace(/\.[^.]+$/, "")`——只在
/// 最后一个点后面还有内容时才算扩展名并去掉；点在末尾（如 "a."、"a.b."）时
/// 正则不匹配，原样保留。
pub fn template_name_from_file(file_name: &str) -> String {
    let stem = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !ext.is_empty() => stem,
        _ => file_name,
    };
    let stem = stem.trim();
    if stem.is_empty() { UNNAMED.into() } else { stem.into() }
}

/// 对齐 `templateExportFileName`：只去掉文件系统不收的字符，保留原名，导回来名字不变。
pub fn export_file_name(template_name: &str) -> String {
    let safe: String = template_name
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let safe = safe.trim();
    format!("{}.xlsx", if safe.is_empty() { "简历模板" } else { safe })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(name: &str, fields: &[(&str, &str)]) -> Group {
        Group {
            name: name.into(),
            fields: fields.iter().map(|(k, v)| Field { key: (*k).into(), value: (*v).into() }).collect(),
        }
    }

    #[test]
    fn csv_rows_become_groups_in_first_seen_order() {
        let csv = "\u{feff}一级分类,字段名,值\n基本信息,姓名, 张三 \n,手机号码,138\n\n教育经历,学校,某大学\n基本信息,邮箱,a@b.c\n,,\n";
        let groups = parse("我的简历.csv", csv.as_bytes()).unwrap();
        assert_eq!(
            groups,
            vec![
                g("基本信息", &[("姓名", "张三"), ("邮箱", "a@b.c")]),
                g("未分类", &[("手机号码", "138")]),
                g("教育经历", &[("学校", "某大学")]),
            ]
        );
    }

    #[test]
    fn rows_without_a_field_name_are_all_reported() {
        let csv = "一级分类,字段名,值\n基本信息,,张三\n基本信息,邮箱,x\n教育,,某大学\n";
        let err = parse("a.csv", csv.as_bytes()).unwrap_err();
        assert_eq!(err.to_string(), "第 2、4 行缺少「字段名」（第二列）。");
    }

    #[test]
    fn many_missing_names_suggest_a_shifted_column() {
        let mut csv = String::from("一级分类,字段名,值\n");
        for _ in 0..21 {
            csv.push_str("组,,值\n");
        }
        let err = parse("a.csv", csv.as_bytes()).unwrap_err();
        assert_eq!(err.to_string(), "共 21 行缺少「字段名」（第二列），请检查第二列是不是整列错位了。");
    }

    #[test]
    fn a_header_only_sheet_has_no_fields() {
        let err = parse("a.csv", "一级分类,字段名,值\n".as_bytes()).unwrap_err();
        assert_eq!(err.to_string(), "未解析到任何字段，请检查 Excel 格式。");
        let err = parse("a.csv", b"").unwrap_err();
        assert_eq!(err.to_string(), "Excel 内容为空。");
    }

    #[test]
    fn only_xlsx_and_csv_are_accepted() {
        assert_eq!(parse("a.xls", b"x").unwrap_err().to_string(), "仅支持 .xlsx 或 .csv 文件。");
        assert_eq!(parse("a", b"x").unwrap_err().to_string(), "仅支持 .xlsx 或 .csv 文件。");
    }

    #[test]
    fn a_non_utf8_csv_is_explained() {
        let gbk_like = [0xd0u8, 0xd5, 0xc3, 0xfb, b',', b'x', b'\n'];
        assert_eq!(parse("a.csv", &gbk_like).unwrap_err().to_string(), "CSV 需要 UTF-8 编码：请在 Excel 里另存为「CSV UTF-8」，或直接用 .xlsx。");
    }

    #[test]
    fn an_exported_workbook_reads_back_the_same() {
        let groups = vec![
            g("基本信息", &[("姓名", "张三"), ("手机号码", "13800000000")]),
            g("教育经历", &[("学校", "某大学"), ("说明", "")]),
        ];
        let bytes = write_xlsx(&groups).unwrap();
        assert_eq!(parse("导出.xlsx", &bytes).unwrap(), groups);
    }

    #[test]
    fn a_broken_xlsx_is_unreadable() {
        assert_eq!(parse("a.xlsx", b"not a zip").unwrap_err().to_string(), "读不出这个文件，确认它没有损坏、也不是加密文件。");
    }

    #[test]
    fn names_follow_the_plugin() {
        assert_eq!(template_name_from_file("校招简历.xlsx"), "校招简历");
        assert_eq!(template_name_from_file(".xlsx"), "未命名模板");
        assert_eq!(template_name_from_file("a.b.csv"), "a.b");
        assert_eq!(export_file_name("a/b:c*?\"<>|\u{1}名"), "abc名.xlsx");
        assert_eq!(export_file_name("  "), "简历模板.xlsx");
    }

    #[test]
    fn a_bom_prefixed_group_name_or_key_in_a_middle_row_is_cleaned() {
        // Rust 的 str::trim() 不会剥离 U+FEFF（零宽不换行空格 / BOM），
        // 但插件用的 JS String.prototype.trim() 会。中间行（非首行）带 BOM
        // 时要按插件口径清理，否则分组名/字段名会带着不可见字符。
        let csv = "一级分类,字段名,值\n\u{feff}基本信息,\u{feff}姓名,张三\n";
        let groups = parse("a.csv", csv.as_bytes()).unwrap();
        assert_eq!(groups, vec![g("基本信息", &[("姓名", "张三")])]);
    }

    // --- 修复回归测试（code review 后补） ---

    #[test]
    fn xlsx_used_range_not_starting_at_column_a_is_read_correctly() {
        // 插件（SheetJS）按 used range 的最左列取相对列；calamine 的 get_value
        // 要绝对坐标。数据写在 B2:D3（不是从 A 列开始）时，之前的实现固定读
        // 绝对列 0、1、2，会读错列、甚至整列漏掉。
        let mut workbook = Workbook::new();
        {
            let sheet = workbook.add_worksheet();
            sheet.write_string(1, 1, "一级分类").unwrap();
            sheet.write_string(1, 2, "字段名").unwrap();
            sheet.write_string(1, 3, "值").unwrap();
            sheet.write_string(2, 1, "基本信息").unwrap();
            sheet.write_string(2, 2, "姓名").unwrap();
            sheet.write_string(2, 3, "张三").unwrap();
        }
        let bytes = workbook.save_to_buffer().unwrap();
        let groups = parse("a.xlsx", &bytes).unwrap();
        assert_eq!(groups, vec![g("基本信息", &[("姓名", "张三")])]);
    }

    #[test]
    fn csv_row_numbers_are_correct_for_crlf_line_endings() {
        let csv = "h,h,h\r\ng,k,v\r\ng,,x\r\n";
        let err = parse("a.csv", csv.as_bytes()).unwrap_err();
        assert_eq!(err.to_string(), "第 3 行缺少「字段名」（第二列）。");
    }

    #[test]
    fn csv_row_numbers_skip_over_blank_lf_lines_correctly() {
        let csv = "h,h,h\n\n\ng,,x\n";
        let err = parse("a.csv", csv.as_bytes()).unwrap_err();
        assert_eq!(err.to_string(), "第 4 行缺少「字段名」（第二列）。");
    }

    #[test]
    fn csv_row_numbers_skip_over_blank_crlf_lines_correctly() {
        let csv = "h,h,h\r\n\r\n\r\ng,,x\r\n";
        let err = parse("a.csv", csv.as_bytes()).unwrap_err();
        assert_eq!(err.to_string(), "第 4 行缺少「字段名」（第二列）。");
    }

    #[test]
    fn csv_row_number_after_a_quoted_multiline_field_is_the_true_line() {
        let csv = "h,h,h\ng,k,\"a\nb\"\ng,,x\n";
        let err = parse("a.csv", csv.as_bytes()).unwrap_err();
        assert_eq!(err.to_string(), "第 4 行缺少「字段名」（第二列）。");
    }

    /// `line_number` 曾对每条记录从字节 0 重新扫描，5 MB 的 CSV 在 O(n²) 下会卡住。
    /// 20 万行（约 200 万字节）验证改成增量扫描后仍然又快又准：只有最后一条数据行
    /// 缺字段名，报的行号要对（表头占第 1 行）。
    #[test]
    fn two_hundred_thousand_rows_report_the_right_line_number_quickly() {
        let mut csv = String::from("一级分类,字段名,值\n");
        for i in 0..200_000usize {
            if i == 199_999 {
                csv.push_str("组,,v\n");
            } else {
                use std::fmt::Write as _;
                let _ = write!(csv, "组,k{i},v\n");
            }
        }
        let start = std::time::Instant::now();
        let err = parse("a.csv", csv.as_bytes()).unwrap_err();
        let elapsed = start.elapsed();
        assert_eq!(err.to_string(), "第 200001 行缺少「字段名」（第二列）。");
        assert!(elapsed.as_secs() < 2, "took too long: {elapsed:?}");
    }

    #[test]
    fn control_chars_and_literal_escape_sequences_round_trip() {
        // rust_xlsxwriter/Excel 把控制字符和字面量 `_xHHHH_` 转义成共享字符串里
        // 的 `_xHHHH_` 序列；calamine 0.30.1 读回来不会解码。不解码就会把
        // "a\r\nb _x0041_ c\u{1}d" 读成 "a_x000D_\nb _x005F_x0041_ c_x0001_d"。
        let groups = vec![g("组", &[("键", "a\r\nb _x0041_ c\u{1}d")])];
        let bytes = write_xlsx(&groups).unwrap();
        assert_eq!(parse("a.xlsx", &bytes).unwrap(), groups);
    }

    #[test]
    fn template_name_from_file_only_strips_a_non_empty_extension() {
        assert_eq!(template_name_from_file("a."), "a.");
        assert_eq!(template_name_from_file("a.b."), "a.b.");
        assert_eq!(template_name_from_file(".csv"), "未命名模板");
        assert_eq!(template_name_from_file("noext"), "noext");
    }

    #[test]
    fn cell_text_reads_error_cells_as_empty_and_normalizes_negative_zero() {
        assert_eq!(cell_text(&Data::Error(calamine::CellErrorType::NA)), "");
        assert_eq!(cell_text(&Data::Float(-0.0)), "0");
        assert_eq!(cell_text(&Data::Float(13_800_000_000.0)), "13800000000");
    }

    #[test]
    fn exporting_a_value_over_the_excel_cell_limit_is_rejected() {
        let groups = vec![g("组", &[("键", &"a".repeat(32_768))])];
        let err = write_xlsx(&groups).unwrap_err();
        assert_eq!(err.to_string(), "「组 / 键」超过 Excel 单元格上限 32767 字，无法导出。");
    }
}
