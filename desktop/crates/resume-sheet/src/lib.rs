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
}

impl fmt::Display for SheetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedExtension => f.write_str("仅支持 .xlsx 或 .csv 文件。"),
            Self::Unreadable => f.write_str("读不出这个 Excel 文件，确认它没有损坏、也不是加密文件。"),
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
        }
    }
}

impl std::error::Error for SheetError {}

/// 一行的前三列，带表格里的真实行号（从 1 起）。
type Row = (usize, [String; 3]);

fn extension(file_name: &str) -> Option<String> {
    let (stem, ext) = file_name.rsplit_once('.')?;
    let _ = stem;
    Some(ext.to_ascii_lowercase())
}

pub fn parse(file_name: &str, bytes: &[u8]) -> Result<Vec<Group>, SheetError> {
    let rows = match extension(file_name).as_deref() {
        Some("xlsx") => xlsx_rows(bytes)?,
        Some("csv") => csv_rows(bytes)?,
        _ => return Err(SheetError::UnsupportedExtension),
    };
    groups_from_rows(rows)
}

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        // 手机号、学号这类整数存成浮点时，别显示成 1.38e10 或带 .0。
        Data::Float(v) if v.fract() == 0.0 && v.abs() < 1e15 => format!("{}", *v as i64),
        Data::Int(v) => v.to_string(),
        other => other.to_string(),
    }
}

fn xlsx_rows(bytes: &[u8]) -> Result<Vec<Row>, SheetError> {
    let mut workbook: Xlsx<_> =
        open_workbook_from_rs(Cursor::new(bytes.to_vec())).map_err(|_| SheetError::Unreadable)?;
    let first = workbook.sheet_names().first().cloned().ok_or(SheetError::NoSheet)?;
    let range = workbook.worksheet_range(&first).map_err(|_| SheetError::Unreadable)?;
    let (Some((top, _)), Some((bottom, _))) = (range.start(), range.end()) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for r in top..=bottom {
        let cell = |c: u32| range.get_value((r, c)).map(cell_text).unwrap_or_default();
        rows.push((r as usize + 1, [cell(0), cell(1), cell(2)]));
    }
    Ok(rows)
}

fn csv_rows(bytes: &[u8]) -> Result<Vec<Row>, SheetError> {
    let text = std::str::from_utf8(bytes).map_err(|_| SheetError::NotUtf8)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for (index, record) in reader.records().enumerate() {
        let record = record.map_err(|_| SheetError::Unreadable)?;
        let line = record.position().map(|p| p.line() as usize).unwrap_or(index + 1);
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
pub fn write_xlsx(groups: &[Group]) -> Result<Vec<u8>, SheetError> {
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

/// 对齐 `getTemplateNameFromFile`：去掉最后一个扩展名。
pub fn template_name_from_file(file_name: &str) -> String {
    let stem = match file_name.rsplit_once('.') {
        Some((stem, _)) => stem,
        None => file_name,
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
        assert_eq!(parse("a.xlsx", b"not a zip").unwrap_err().to_string(), "读不出这个 Excel 文件，确认它没有损坏、也不是加密文件。");
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
}
