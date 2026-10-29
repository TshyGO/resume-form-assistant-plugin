use super::*;

/// Bounded, read-only worksheet preview. Coordinates are zero-based, preserving sparse gaps.
#[derive(Debug, Clone)]
pub struct SheetPreview {
    pub sheet_names: Vec<String>,
    pub sheet_index: usize,
    pub cells: Vec<(u32, u32, String)>,
    pub row_count: u32,
    pub column_count: u32,
    pub truncated: bool,
}
pub fn preview_xlsx(bytes: &[u8], sheet_index: usize) -> Result<SheetPreview, SheetError> {
    if bytes.len() as u64 > MAX_SHEET_BYTES {
        return Err(SheetError::Unreadable);
    }
    let parts = validate_xlsx(bytes)?;
    let mut workbook: Xlsx<_> =
        open_workbook_from_rs(Cursor::new(bytes)).map_err(|_| SheetError::Unreadable)?;
    let sheet_names = workbook.sheet_names().to_vec();
    if sheet_names.len() > 128 {
        return Err(SheetError::Unreadable);
    }
    let name = sheet_names.get(sheet_index).ok_or(SheetError::NoSheet)?;
    let types = sheet_string_types(&parts, sheet_index)?;
    drop(parts);
    let mut reader = workbook
        .worksheet_cells_reader(name)
        .map_err(|_| SheetError::Unreadable)?;
    let mut cells = Vec::new();
    let mut row_count = 0;
    let mut column_count = 0;
    let mut count = 0;
    let mut text_bytes = 0usize;
    let mut truncated = false;
    while let Some(cell) = reader.next_cell().map_err(|_| SheetError::Unreadable)? {
        count += 1;
        if count > MAX_XLSX_CELLS {
            return Err(SheetError::Unreadable);
        }
        let (row, col) = cell.get_position();
        if row >= 1_048_576 || col >= 16_384 {
            return Err(SheetError::Unreadable);
        }
        if matches!(cell.get_value(), DataRef::Empty) {
            continue;
        }
        row_count = row_count.max(row + 1);
        column_count = column_count.max(col + 1);
        // A sparse XFD1048576 cell must never allocate a gigantic rectangle.
        if row >= 500 || col >= 50 {
            truncated = true;
            continue;
        }
        let value = cell.get_value();
        let raw_len = match value {
            DataRef::String(s) => s.len(),
            DataRef::SharedString(s) => s.len(),
            _ => 0,
        };
        if raw_len > 16_384 || text_bytes.saturating_add(raw_len) > 1024 * 1024 {
            truncated = true;
            continue;
        }
        let mut text = if *types.get(count - 1).ok_or(SheetError::Unreadable)? {
            match value {
                DataRef::String(s) => decode_excel_escapes(s),
                _ => cell_text(&Data::from(value.clone())),
            }
        } else {
            cell_text(&Data::from(value.clone()))
        };
        text_bytes += text.len();
        if text.len() > 4096 {
            let mut end = 4096;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            text.push('…');
            truncated = true;
        }
        cells.push((row, col, text));
    }
    if count != types.len() {
        return Err(SheetError::Unreadable);
    }
    Ok(SheetPreview {
        sheet_names,
        sheet_index,
        cells,
        row_count,
        column_count,
        truncated,
    })
}
