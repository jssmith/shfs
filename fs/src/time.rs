//! Small time helpers, so the crate needs no date library.

use std::time::{SystemTime, UNIX_EPOCH};

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Parses the leading `YYYY-MM-DDTHH:MM:SS` of an ISO 8601 UTC timestamp into Unix seconds.
/// Returns 0 when the text does not parse.
pub fn parse_iso(s: &str) -> i64 {
    if s.len() < 19 {
        return 0;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).and_then(|t| t.parse::<i64>().ok());
    match (num(0..4), num(5..7), num(8..10), num(11..13), num(14..16), num(17..19)) {
        (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(se)) => {
            days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se
        }
        _ => 0,
    }
}

/// Now as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn now_iso() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (y, m, day) = civil_from_days(secs.div_euclid(86400));
    let rem = secs.rem_euclid(86400);
    format!(
        "{y:04}-{m:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60,
        d.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip() {
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), 0);
        assert_eq!(parse_iso("2026-11-25T12:00:00.000Z"), 1795608000);
        assert!(parse_iso(&now_iso()) > 1_700_000_000);
    }
}
