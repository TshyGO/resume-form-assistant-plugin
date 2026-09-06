/// UTC RFC3339 subset used by this protocol:
/// `YYYY-MM-DDTHH:MM:SSZ` or `YYYY-MM-DDTHH:MM:SS.fractionZ`.
/// Calendar date and clock must be real. No offsets other than `Z`.
pub fn is_utc_timestamp(value: &str) -> bool {
    let b = value.as_bytes();
    if !value.ends_with('Z') || !value.is_ascii() || b.len() < 20 {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| range.clone().all(|i| b.get(i).map(|c| c.is_ascii_digit()).unwrap_or(false));
    if !(digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'T'
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19))
    {
        return false;
    }
    let frac_ok = match b.len() {
        20 => true,
        n if n > 21 && b[19] == b'.' => b[20..n - 1].iter().all(u8::is_ascii_digit),
        _ => false,
    };
    if !frac_ok {
        return false;
    }
    let year: u32 = value[0..4].parse().unwrap_or(0);
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    let hour: u32 = value[11..13].parse().unwrap_or(99);
    let minute: u32 = value[14..16].parse().unwrap_or(99);
    let second: u32 = value[17..19].parse().unwrap_or(99);
    hour <= 23 && minute <= 59 && second <= 59 && valid_date(year, month, day)
}

fn valid_date(year: u32, month: u32, day: u32) -> bool {
    let dim = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    day >= 1 && day <= dim
}

#[cfg(test)]
mod tests {
    use super::is_utc_timestamp;

    #[test]
    fn accepts_fraction_and_rejects_impossible_dates() {
        assert!(is_utc_timestamp("2026-09-06T12:00:00Z"));
        assert!(is_utc_timestamp("2026-09-06T12:00:00.000Z"));
        assert!(!is_utc_timestamp("2026-xxxxxTxxxxxxxxZ"));
        assert!(!is_utc_timestamp("2026-13-01T12:00:00.000Z"));
        assert!(!is_utc_timestamp("2026-02-30T12:00:00Z"));
        assert!(!is_utc_timestamp("2026-09-06T24:00:00Z"));
        assert!(!is_utc_timestamp("2026-09-06T12:00:00+00:00"));
    }
}
