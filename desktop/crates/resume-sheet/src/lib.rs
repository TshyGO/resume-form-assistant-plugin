//! 简历模板 ↔ Excel/CSV。口径逐条对齐插件 `popup.js` 的 `parseTemplateFile`、
//! `templateToSheetRows`、`templateExportFileName`、`getTemplateNameFromFile`。

use std::collections::BTreeMap;
use std::fmt;
use std::io::{Cursor, Read};

use calamine::{open_workbook_from_rs, Data, DataRef, Reader, Xlsx, XlsxError};
use quick_xml::events::Event;
use rust_xlsxwriter::Workbook;

pub const HEADER: [&str; 3] = ["一级分类", "字段名", "值"];
pub const SHEET_NAME: &str = "简历模板";
const UNGROUPED: &str = "未分类";
const UNNAMED: &str = "未命名模板";
const MAX_LISTED_ROW_NUMBERS: usize = 20;

pub const MAX_SHEET_BYTES: u64 = 5 * 1024 * 1024;
// 压缩文件大小不等于解析成本。上限覆盖解压、元数据预分配和共享字符串重复引用。
const MAX_XLSX_EXPANDED_BYTES: u64 = 32 * 1024 * 1024;
const MAX_XLSX_MEMBERS: usize = 1024;
const MAX_XLSX_CELLS: usize = 200_000;
const MAX_XML_ATTRIBUTES: usize = 1024;

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

/// 文件大小上限为 5 MiB；解析预算超限与损坏文件一样返回 Unreadable。
pub fn parse(file_name: &str, bytes: &[u8]) -> Result<Vec<Group>, SheetError> {
    if bytes.len() as u64 > MAX_SHEET_BYTES {
        return Err(SheetError::Unreadable);
    }
    let rows = match extension(file_name).as_deref() {
        Some("xlsx") => xlsx_rows(bytes)?,
        Some("csv") => csv_rows(bytes)?,
        _ => return Err(SheetError::UnsupportedExtension),
    };
    groups_from_rows(rows)
}

// 仅用于 calamine 尚未解码的公式字符串缓存。共享/内联字符串不能再解一次。
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
        // calamine 0.36 已解码 Excel 转义；再解一次会破坏字面量 _xHHHH_。
        Data::String(s) => s.clone(),
        // 插件把 #N/A 等错误单元格当空值导入。
        Data::Error(_) => String::new(),
        // f64 的 Display 不会用科学计数法、也不带多余的 .0，唯一要收拾的是
        // 负零会打印成 "-0"；Excel 单元格里没有有意义的负零，统一成 "0"。
        Data::Float(v) if *v == 0.0 => "0".to_string(),
        other => other.to_string(),
    }
}

/// 在 calamine 的 CFB 探测、共享字符串预分配和 XML 解析之前执行。
fn validate_xlsx(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, SheetError> {
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err(SheetError::Unreadable);
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| SheetError::Unreadable)?;
    if archive.len() > MAX_XLSX_MEMBERS {
        return Err(SheetError::Unreadable);
    }
    let mut remaining = MAX_XLSX_EXPANDED_BYTES;
    let mut parts = BTreeMap::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|_| SheetError::Unreadable)?;
        if file.size() > remaining {
            return Err(SheetError::Unreadable);
        }
        let name = file.name().to_ascii_lowercase();
        // 不信任 ZIP 声明的大小；实际读取也受限，并读到 EOF 校验 CRC。
        let mut content = Vec::new();
        file.by_ref().take(remaining + 1).read_to_end(&mut content)
            .map_err(|_| SheetError::Unreadable)?;
        if content.len() as u64 > remaining {
            return Err(SheetError::Unreadable);
        }
        remaining -= content.len() as u64;
        // 工作表关系可指向 .bin 等任意后缀。扫描所有成员，不能凭后缀跳过安全检查。
        validate_xlsx_xml(&content, name.ends_with(".xml") || name.ends_with(".rels"))?;
        parts.insert(name.replace('\\', "/"), content);
    }
    Ok(parts)
}

fn xlsx_xml_reader(content: &[u8]) -> quick_xml::Reader<&[u8]> {
    let mut xml = quick_xml::Reader::from_reader(content);
    xml.config_mut().check_end_names = false;
    xml.config_mut().check_comments = false;
    xml.config_mut().trim_text(false);
    xml.config_mut().expand_empty_elements = true;
    xml
}

fn validate_xlsx_xml(content: &[u8], require_xml: bool) -> Result<(), SheetError> {
    // 与 calamine 的 XML tokenizer 一致，防止预检提前停止而实际解析继续。
    let mut xml = xlsx_xml_reader(content);
    let mut shared_strings = 0;
    loop {
        let event = match xml.read_event() {
            Ok(event) => event,
            Err(_) if !require_xml => return Ok(()), // 图片等二进制；calamine 也无法越过此错误。
            Err(_) => return Err(SheetError::Unreadable),
        };
        match event {
            Event::Start(e) | Event::Empty(e) => {
                if e.local_name().as_ref() == b"si" {
                    shared_strings += 1;
                    if shared_strings > MAX_XLSX_CELLS { return Err(SheetError::Unreadable); }
                }
                // calamine 的 raw-attribute reader 允许比 XML 更多的 ASCII 空白。
                // 先拒绝非法控制字节，防止它把预检看到的不同属性名解释成 uniqueCount/r/ref。
                let guarded_tag = matches!(e.local_name().as_ref(), b"sst" | b"row" | b"c" | b"dimension" | b"f");
                if (require_xml || guarded_tag)
                    && e.iter().any(|b| b.is_ascii_control() && !matches!(b, b'\t' | b'\n' | b'\r'))
                {
                    return Err(SheetError::Unreadable);
                }
                for (index, attr) in e.attributes().enumerate() {
                    if index >= MAX_XML_ATTRIBUTES {
                        return Err(SheetError::Unreadable);
                    }
                    let attr = match attr {
                        Ok(attr) => attr,
                        // 二进制附件中偶然出现尖括号不是 XML；仍继续扫描后续事件。
                        Err(_) if !require_xml => continue,
                        Err(_) => return Err(SheetError::Unreadable),
                    };
                    // calamine 按关系文件寻找工作簿目录，所以检查所有 XML 路径，
                    // 也检查自闭合/带命名空间的 sst，而非只检查 xl/sharedStrings.xml。
                    match (e.local_name().as_ref(), attr.key.as_ref()) {
                        (b"row", b"r") => { validate_cell_reference(&attr.value, false)?; }
                        (b"c", b"r") => { validate_cell_reference(&attr.value, true)?; }
                        (b"dimension", b"ref") => validate_cell_range(&attr.value)?,
                        _ => {}
                    }
                    if e.local_name().as_ref() == b"sst" && attr.key.as_ref() == b"uniqueCount" {
                        let count = std::str::from_utf8(&attr.value)
                            .ok().and_then(|s| s.parse::<usize>().ok())
                            .ok_or(SheetError::Unreadable)?;
                        if count > MAX_XLSX_CELLS {
                            return Err(SheetError::Unreadable);
                        }
                    }
                }
            }
            Event::Eof => return Ok(()),
            _ => {}
        }
    }
}

// calamine 在返回 cell 前用 u32 算坐标；先拒绝越界文本，避免解析器内部溢出。
fn validate_cell_reference(reference: &[u8], column_required: bool) -> Result<(u32, u32), SheetError> {
    let letters = reference.iter().take_while(|b| b.is_ascii_alphabetic()).count();
    let mut column = 0u32;
    for letter in &reference[..letters] {
        column = column.checked_mul(26)
            .and_then(|n| n.checked_add((letter.to_ascii_uppercase() - b'A' + 1) as u32))
            .ok_or(SheetError::Unreadable)?;
    }
    let digits = &reference[letters..];
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return Err(SheetError::Unreadable);
    }
    let row = std::str::from_utf8(digits).ok().and_then(|s| s.parse::<u32>().ok())
        .ok_or(SheetError::Unreadable)?;
    if row == 0 || row > 1_048_576 || column > 16_384 || (column_required && column == 0) {
        return Err(SheetError::Unreadable);
    }
    Ok((row, column))
}

fn validate_cell_range(reference: &[u8]) -> Result<(), SheetError> {
    let mut endpoints = reference.split(|b| *b == b':');
    let start = validate_cell_reference(endpoints.next().ok_or(SheetError::Unreadable)?, true)?;
    if let Some(end) = endpoints.next() {
        let end = validate_cell_reference(end, true)?;
        if end.0 < start.0 || end.1 < start.1 || endpoints.next().is_some() {
            return Err(SheetError::Unreadable);
        }
    }
    Ok(())
}

fn xml_attr(e: &quick_xml::events::BytesStart<'_>, key: &[u8], decoder: quick_xml::Decoder, local: bool)
    -> Result<Option<String>, SheetError>
{
    for attr in e.attributes() {
        let attr = attr.map_err(|_| SheetError::Unreadable)?;
        let matches = if local { attr.key.local_name().as_ref() == key } else { attr.key.as_ref() == key };
        if matches {
            // 与 calamine::attrs::decode_attr 相同，不额外规范化关系路径中的空白。
            let decoded = decoder.decode(&attr.value).map_err(|_| SheetError::Unreadable)?;
            return quick_xml::escape::unescape(&decoded).map(|v| Some(v.into_owned()))
                .map_err(|_| SheetError::Unreadable);
        }
    }
    Ok(None)
}

/// calamine 的 DataRef 不区分 inlineStr 与 t=str，只有后者仍需 Excel 转义解码。
/// 从同一 ZIP 的实际关系链定位首表，并按 XML 流顺序保留类型；不能用是否存在公式猜测。
fn first_sheet_string_types(parts: &BTreeMap<String, Vec<u8>>) -> Result<Vec<bool>, SheetError> {
    let part = |path: &str| parts.get(&path.replace('\\', "/").to_ascii_lowercase())
        .map(Vec::as_slice).ok_or(SheetError::Unreadable);
    let mut directory = "xl/".to_string();
    if let Some(root) = parts.get("_rels/.rels") {
        let mut xml = xlsx_xml_reader(root);
        loop {
            match xml.read_event().map_err(|_| SheetError::Unreadable)? {
                Event::Start(e) if e.local_name().as_ref() == b"Relationship" => {
                    if xml_attr(&e, b"Type", xml.decoder(), false)?.is_some_and(|v| v.ends_with("/relationships/officeDocument")) {
                        if let Some(target) = xml_attr(&e, b"Target", xml.decoder(), false)? {
                            directory = target.rfind('/').map(|i| target[..=i].trim_start_matches('/').to_string()).unwrap_or_default();
                        }
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
    }
    let mut xml = xlsx_xml_reader(part(&format!("{directory}workbook.xml"))?);
    let sheet_id = loop {
        match xml.read_event().map_err(|_| SheetError::Unreadable)? {
            Event::Start(e) if e.local_name().as_ref() == b"sheet" => {
                break xml_attr(&e, b"id", xml.decoder(), true)?.ok_or(SheetError::Unreadable)?;
            }
            Event::Eof => return Err(SheetError::Unreadable),
            _ => {}
        }
    };
    let mut xml = xlsx_xml_reader(part(&format!("{directory}_rels/workbook.xml.rels"))?);
    let mut target = None;
    loop {
        match xml.read_event().map_err(|_| SheetError::Unreadable)? {
            Event::Start(e) if e.local_name().as_ref() == b"Relationship" => {
                if xml_attr(&e, b"Id", xml.decoder(), false)?.as_deref() == Some(&sheet_id) {
                    target = xml_attr(&e, b"Target", xml.decoder(), false)?;
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let target = target.ok_or(SheetError::Unreadable)?;
    let path = target.strip_prefix('/').map(str::to_string).unwrap_or_else(|| format!("{directory}{target}"));
    let mut xml = xlsx_xml_reader(part(&path)?);
    let mut in_data = false;
    let mut in_cell = false;
    let mut types = Vec::new();
    loop {
        match xml.read_event().map_err(|_| SheetError::Unreadable)? {
            Event::Start(e) if e.local_name().as_ref() == b"sheetData" => in_data = true,
            Event::Start(e) if in_data && e.local_name().as_ref() == b"c" => {
                if in_cell || types.len() == MAX_XLSX_CELLS { return Err(SheetError::Unreadable); }
                in_cell = true;
                types.push(xml_attr(&e, b"t", xml.decoder(), false)?.as_deref() == Some("str"));
            }
            Event::End(e) if in_data && e.local_name().as_ref() == b"c" => in_cell = false,
            Event::End(e) if in_data && e.local_name().as_ref() == b"sheetData" => return Ok(types),
            Event::Eof => return Err(SheetError::Unreadable),
            _ => {}
        }
    }
}

fn xlsx_rows(bytes: &[u8]) -> Result<Vec<Row>, SheetError> {
    let parts = validate_xlsx(bytes)?;
    let mut workbook: Xlsx<_> =
        open_workbook_from_rs(Cursor::new(bytes)).map_err(|_| SheetError::Unreadable)?;
    let first = workbook.sheet_names().first().cloned().ok_or(SheetError::NoSheet)?;
    let mut reader = match workbook.worksheet_cells_reader(&first) {
        Ok(reader) => reader,
        Err(XlsxError::NotAWorksheet(_)) => return Ok(Vec::new()),
        Err(_) => return Err(SheetError::Unreadable),
    };
    let string_types = first_sheet_string_types(&parts)?;
    drop(parts);
    // 不调用 worksheet_range：两个距离很远的单元格也会让 Range 分配巨大矩形。
    let mut cells = Vec::new();
    let mut left = u32::MAX;
    let mut text_bytes = 0u64;
    let mut count = 0;
    while let Some(cell) = reader.next_cell().map_err(|_| SheetError::Unreadable)? {
        count += 1;
        if count > MAX_XLSX_CELLS {
            return Err(SheetError::Unreadable);
        }
        let value = cell.get_value();
        if matches!(value, DataRef::Empty) {
            continue;
        }
        let (row, col) = cell.get_position();
        if row >= 1_048_576 || col >= 16_384 {
            return Err(SheetError::Unreadable);
        }
        // 先计算借用的共享字符串长度，防止大量引用在 clone 后才发现超限。
        let string_len = match value {
            DataRef::String(s) => s.len(),
            DataRef::SharedString(s) => s.len(),
            _ => 0,
        };
        text_bytes += string_len as u64;
        if text_bytes > MAX_XLSX_EXPANDED_BYTES {
            return Err(SheetError::Unreadable);
        }
        left = left.min(col);
        let text = if *string_types.get(count - 1).ok_or(SheetError::Unreadable)? {
            match value {
                // calamine 已解码共享/内联字符串，但公式缓存 t=str 仍返回原始 Excel 转义。
                DataRef::String(s) => decode_excel_escapes(s),
                _ => cell_text(&Data::from(value.clone())),
            }
        } else {
            cell_text(&Data::from(value.clone()))
        };
        cells.push((row, col, text));
    }
    if count != string_types.len() { return Err(SheetError::Unreadable); }
    let mut rows: BTreeMap<u32, [String; 3]> = BTreeMap::new();
    for (row, col, text) in cells {
        // 按整个 used range 的最左列取相对前三列；相同坐标最后一个非空值生效。
        if col - left < 3 {
            rows.entry(row).or_default()[(col - left) as usize] = text;
        }
    }
    Ok(rows.into_iter().map(|(row, cells)| (row as usize + 1, cells)).collect())
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

    /// 保留真实导出文件的关系/类型信息，只替换被测 XML 部件。
    fn with_member(bytes: &[u8], name: &str, content: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut input = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for i in 0..input.len() {
            let mut file = input.by_index(i).unwrap();
            if file.name() == name { continue; }
            output.start_file(file.name(), options).unwrap();
            std::io::copy(&mut file, &mut output).unwrap();
        }
        output.start_file(name, options).unwrap();
        output.write_all(content).unwrap();
        output.finish().unwrap().into_inner()
    }

    fn sample_xlsx() -> Vec<u8> {
        write_xlsx(&[g("组", &[("键", "值")])]).unwrap()
    }

    #[test]
    fn xlsx_excessive_attributes_are_rejected_before_workbook_parsing() {
        use std::fmt::Write;
        let mut xml = String::from("<worksheet><dimension");
        for i in 0..=MAX_XML_ATTRIBUTES {
            write!(xml, " a{i}=\"x\"").unwrap();
        }
        xml.push_str(" ref=\"A1:C2\"/><sheetData/></worksheet>");
        let bytes = with_member(&sample_xlsx(), "xl/worksheets/sheet1.xml", xml.as_bytes());
        assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
    }

    #[test]
    fn xlsx_rejects_untrusted_shared_string_capacity_in_all_tag_forms() {
        for xml in [
            "<sst uniqueCount=\"18446744073709551615\"></sst>",
            "<sst uniqueCount=\"18446744073709551615\"/>",
            "<s:sst xmlns:s=\"urn:test\" uniqueCount=\"18446744073709551615\"/>",
        ] {
            let bytes = with_member(&sample_xlsx(), "xl/sharedStrings.xml", xml.as_bytes());
            assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
            // 大小写、反斜杠和非标准目录不能绕过预检。
            let bytes = with_member(&sample_xlsx(), "other\\SHAREDSTRINGS.XML", xml.as_bytes());
            assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
        }
    }

    #[test]
    fn xlsx_rejects_ole_headers_before_calamine_cfb_probe() {
        // CFB 扇区计数来自文件头；不能先进入其预分配路径再检查 ZIP。
        let mut bytes = vec![0xff; 512];
        bytes[..8].copy_from_slice(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        assert_eq!(parse("renamed.xlsx", &bytes), Err(SheetError::Unreadable));
    }

    #[test]
    fn xlsx_bounds_decompression_even_for_an_unused_member() {
        let expanded = vec![b'a'; MAX_XLSX_EXPANDED_BYTES as usize + 1];
        let bytes = with_member(&sample_xlsx(), "unused.bin", &expanded);
        assert!(bytes.len() < MAX_SHEET_BYTES as usize);
        assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
    }

    #[test]
    fn sparse_xlsx_does_not_allocate_its_bounding_rectangle() {
        // 两个极远坐标曾触发约 512 GiB 的 Range 分配；dimension 也可能不诚实。
        for dimension in ["A1", "A1:XFD1048576"] {
            let xml = format!(r#"<worksheet><dimension ref="{dimension}"/><sheetData>
                <row r="1"><c r="A1" t="inlineStr"><is><t>分类</t></is></c>
                <c r="B1" t="inlineStr"><is><t>字段</t></is></c></row>
                <row r="1048576"><c r="B1048576" t="inlineStr"><is><t>键</t></is></c>
                <c r="C1048576" t="inlineStr"><is><t>值</t></is></c>
                <c r="XFD1048576" t="inlineStr"><is><t>忽略</t></is></c></row>
                </sheetData></worksheet>"#);
            let bytes = with_member(&sample_xlsx(), "xl/worksheets/sheet1.xml", xml.as_bytes());
            assert_eq!(parse("a.xlsx", &bytes).unwrap(), vec![g("未分类", &[("键", "值")])]);
        }
    }

    #[test]
    fn repeated_shared_strings_have_an_aggregate_output_budget() {
        let strings = format!("<sst uniqueCount=\"1\"><si><t>{}</t></si></sst>", "a".repeat(2 * 1024 * 1024));
        let mut xml = String::from("<worksheet><sheetData>");
        for row in 1..=20 {
            xml.push_str(&format!("<row r=\"{row}\"><c r=\"A{row}\" t=\"s\"><v>0</v></c></row>"));
        }
        xml.push_str("</sheetData></worksheet>");
        let bytes = with_member(&sample_xlsx(), "xl/sharedStrings.xml", strings.as_bytes());
        let bytes = with_member(&bytes, "xl/worksheets/sheet1.xml", xml.as_bytes());
        assert!(bytes.len() < MAX_SHEET_BYTES as usize);
        assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
    }

    #[test]
    fn xlsx_preserves_global_left_column_row_order_and_duplicate_values() {
        let xml = br#"<worksheet><sheetData>
            <row r="4"><c r="D4" t="inlineStr"><is><t>old</t></is></c>
            <c r="C4" t="inlineStr"><is><t>key</t></is></c>
            <c r="D4" t="inlineStr"><is><t>value</t></is></c><c r="D4"/></row>
            <row r="2"><c r="B2" t="inlineStr"><is><t>group</t></is></c>
            <c r="C2" t="inlineStr"><is><t>key</t></is></c></row>
            </sheetData></worksheet>"#;
        let bytes = with_member(&sample_xlsx(), "xl/worksheets/sheet1.xml", xml);
        assert_eq!(parse("a.xlsx", &bytes).unwrap(), vec![g("未分类", &[("key", "value")])]);
    }

    #[test]
    fn xlsx_rejects_coordinate_overflow_before_entering_the_cell_reader() {
        for body in [
            "<row r=\"999999999999999999999\"/>",
            "<row><c r=\"ZZZZZZZZZZZZZZZZ1\"><v>1</v></c></row>",
            "<row><c r=\"A4294967296\"><v>1</v></c></row>",
        ] {
            let xml = format!("<worksheet><sheetData>{body}</sheetData></worksheet>");
            let bytes = with_member(&sample_xlsx(), "xl/worksheets/sheet1.xml", xml.as_bytes());
            assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
        }
        let bytes = with_member(&sample_xlsx(), "xl/worksheets/sheet1.xml",
            b"<worksheet><dimension ref=\"A1:ZZZZZZZZZZ9999999999999\"/><sheetData/></worksheet>");
        assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
    }

    #[test]
    fn xlsx_rejects_reversed_dimensions_and_non_xml_extension_bypasses() {
        for dimension in ["B2:A1", "C1:B2", "A1:A1:A1", "A1:ZZZZZZZZ99999999999999"] {
            let xml = format!("<worksheet><dimension ref=\"{dimension}\"/><sheetData/></worksheet>");
            for member in ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet1.bin"] {
                let bytes = with_member(&sample_xlsx(), member, xml.as_bytes());
                assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
            }
        }
    }

    #[test]
    fn cached_formula_strings_still_decode_excel_escapes_once() {
        let xml = br#"<worksheet><sheetData>
            <row r="1"><c r="A1" t="inlineStr"><is><t>group</t></is></c>
            <c r="B1" t="inlineStr"><is><t>key</t></is></c></row>
            <row r="2"><c r="B2" t="inlineStr"><is><t>key</t></is></c>
            <c r="C2" t="str"><f>CHAR(13)</f><v>a_x000D_b _x005F_x0041_</v></c></row>
            </sheetData></worksheet>"#;
        let bytes = with_member(&sample_xlsx(), "xl/worksheets/sheet1.xml", xml);
        assert_eq!(parse("a.xlsx", &bytes).unwrap(), vec![g("未分类", &[("key", "a\rb _x0041_")])]);
    }

    #[test]
    fn binary_attachments_do_not_need_to_be_well_formed_xml() {
        let bytes = with_member(&sample_xlsx(), "xl/media/image.bin", b"binary <garbage invalid> </different> tail");
        assert_eq!(parse("a.xlsx", &bytes).unwrap(), vec![g("组", &[("键", "值")])]);
    }

    #[test]
    fn shared_formula_indices_are_not_used_as_allocation_sizes() {
        let xml = br#"<worksheet><sheetData>
            <row r="1"><c r="A1" t="inlineStr"><is><t>group</t></is></c></row>
            <row r="2"><c r="B2" t="inlineStr"><is><t>key</t></is></c>
            <c r="C2"><f t="shared" si="18446744073709551614" ref="C2:C3">1</f><v>1</v></c></row>
            </sheetData></worksheet>"#;
        let bytes = with_member(&sample_xlsx(), "xl/worksheets/sheet1.xml", xml);
        assert_eq!(parse("a.xlsx", &bytes).unwrap(), vec![g("未分类", &[("key", "1")])]);
    }

    #[test]
    fn non_xml_whitespace_cannot_hide_guarded_attributes() {
        for control in [0x0b, 0x0c] {
            let mut xml = b"<sst ".to_vec();
            xml.push(control);
            xml.extend_from_slice(b"uniqueCount=\"18446744073709551615\"/>");
            // 不先运行有风险的分配器：必须由同一预检直接拒绝，包括无 XML 后缀的路径。
            assert_eq!(validate_xlsx_xml(&xml, false), Err(SheetError::Unreadable));
            let bytes = with_member(&sample_xlsx(), "xl/sharedStrings.xml", &xml);
            assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
        }
    }

    #[test]
    fn string_types_decode_once_with_or_without_formulas() {
        for (kind, body) in [
            ("str", "<v>a_x000D_b _x005F_x0041_</v>"),
            ("inlineStr", "<is><t>a_x000D_b _x005F_x0041_</t></is>"),
        ] {
            let xml = format!(r#"<worksheet><sheetData>
                <row r="1"><c r="A1" t="inlineStr"><is><t>header</t></is></c></row>
                <row r="2"><c r="B2" t="inlineStr"><is><t>key</t></is></c>
                <c r="C2" t="{kind}">{body}</c></row></sheetData></worksheet>"#);
            let bytes = with_member(&sample_xlsx(), "xl/worksheets/sheet1.xml", xml.as_bytes());
            assert_eq!(parse("a.xlsx", &bytes).unwrap(), vec![g("未分类", &[("key", "a\rb _x0041_")])]);
        }
    }

    #[test]
    fn actual_shared_string_entries_are_bounded_without_a_declared_count() {
        let xml = format!("<sst>{}</sst>", "<si><t>x</t></si>".repeat(MAX_XLSX_CELLS + 1));
        let bytes = with_member(&sample_xlsx(), "xl/sharedStrings.xml", xml.as_bytes());
        assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
    }

    #[test]
    fn worksheet_relationships_can_use_non_xml_extensions() {
        let xml = br#"<worksheet><sheetData>
            <row r="1"><c r="A1" t="inlineStr"><is><t>header</t></is></c></row>
            <row r="2"><c r="B2" t="inlineStr"><is><t>key</t></is></c>
            <c r="C2" t="str"><v>a_x000D_b</v></c></row></sheetData></worksheet>"#;
        let bytes = with_member(&sample_xlsx(), "xl/worksheets/sheet1.bin", xml);
        let rels = br#"<Relationships><Relationship Id="rId1"
            Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
            Target="worksheets/sheet1.bin"/></Relationships>"#;
        let bytes = with_member(&bytes, "xl/_rels/workbook.xml.rels", rels);
        assert_eq!(parse("a.xlsx", &bytes).unwrap(), vec![g("未分类", &[("key", "a\rb")])]);
        let attack = b"<worksheet><dimension ref=\"B2:A1\"/><sheetData/></worksheet>";
        let bytes = with_member(&bytes, "xl/worksheets/sheet1.bin", attack);
        assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
    }

    #[test]
    fn workbook_directory_and_member_case_follow_package_relationships() {
        use std::io::Write;
        let bytes = sample_xlsx();
        let mut input = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for i in 0..input.len() {
            let mut file = input.by_index(i).unwrap();
            if file.name() == "_rels/.rels" { continue; }
            let name = file.name().strip_prefix("xl/").map(|p| format!("CUSTOM/{p}").to_ascii_uppercase())
                .unwrap_or_else(|| file.name().to_string());
            output.start_file(name, options).unwrap();
            std::io::copy(&mut file, &mut output).unwrap();
        }
        output.start_file("_rels/.rels", options).unwrap();
        output.write_all(br#"<Relationships><Relationship Id="rId1"
            Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
            Target="/custom/workbook.xml"/></Relationships>"#).unwrap();
        let bytes = output.finish().unwrap().into_inner();
        assert_eq!(parse("a.xlsx", &bytes).unwrap(), vec![g("组", &[("键", "值")])]);
    }

    #[test]
    fn public_parse_enforces_the_file_size_limit() {
        let bytes = vec![b'a'; MAX_SHEET_BYTES as usize + 1];
        assert_eq!(parse("a.xlsx", &bytes), Err(SheetError::Unreadable));
        assert_eq!(parse("a.csv", &bytes), Err(SheetError::Unreadable));
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
        // 的 `_xHHHH_` 序列；依赖升级后必须恰好解码一次，否则会把
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
