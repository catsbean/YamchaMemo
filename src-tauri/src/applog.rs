//! 로그 파일 (8-2) — 사용자가 "안 돼요"라고 할 때 원인을 볼 수 있게.
//!
//! 예전에는 오류가 화면 토스트와 콘솔로만 나가고 어디에도 남지 않았다. 설치본은 콘솔이 없으니
//! 사실상 사라졌다.
//!
//! - 자리: 앱 로그 폴더(`app_log_dir`)의 `yamcha-YYYY-MM-DD.log` — 하루 한 파일
//! - 크기: 파일이 5MB를 넘으면 `….old.log`로 밀어 두고 새로 쓴다(하루 최대 10MB)
//! - 보관: 7일 지난 파일은 지운다(켤 때·날이 바뀔 때)
//! - **노트 본문은 남기지 않는다.** 경로(vault 안 상대 경로 — 제목이 들어 있다)는 남긴다. 사용자 폴더
//!   앞부분은 `~`로 줄인다
//! - 로그를 못 써도 앱은 멈추지 않는다 — 기록기의 실패는 모두 삼킨다
//!
//! 새 의존성을 들이지 않는다(로그 크레이트는 tauri 버전과 엮인다 — 업데이터에서 한 번 겪었다).

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::{Duration, Local, NaiveDate};

const KEEP_DAYS: i64 = 7;
const MAX_BYTES: u64 = 5 * 1024 * 1024;
const PREFIX: &str = "yamcha-";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn tag(self) -> &'static str {
        match self {
            Level::Info => "INFO ",
            Level::Warn => "WARN ",
            Level::Error => "ERROR",
        }
    }

    /// 화면에서 넘어온 수준 이름 — 모르는 이름은 경고로 본다
    pub fn parse(s: &str) -> Level {
        match s {
            "info" => Level::Info,
            "error" => Level::Error,
            _ => Level::Warn,
        }
    }
}

struct Open {
    date: String,
    file: File,
    size: u64,
}

pub struct Logger {
    dir: PathBuf,
    max_bytes: u64,
    homes: Vec<String>,
    state: Mutex<Option<Open>>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// 앱이 뜰 때 한 번. 오래된 파일을 걷고, 패닉도 기록하게 한다.
pub fn init(dir: PathBuf) {
    let logger = Logger::new(dir, MAX_BYTES, home_dirs());
    logger.prune(Local::now().date_naive());
    if LOGGER.set(logger).is_err() {
        return;
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let trace = std::backtrace::Backtrace::force_capture().to_string();
        let short: Vec<&str> = trace.lines().take(40).collect();
        error(format!("패닉: {info}\n{}", short.join("\n")));
        prev(info);
    }));
}

pub fn info(msg: impl AsRef<str>) {
    write(Level::Info, msg.as_ref());
}

pub fn warn(msg: impl AsRef<str>) {
    write(Level::Warn, msg.as_ref());
}

pub fn error(msg: impl AsRef<str>) {
    write(Level::Error, msg.as_ref());
}

pub fn write(level: Level, msg: &str) {
    if let Some(l) = LOGGER.get() {
        l.write(level, msg);
    }
}

/// 로그 폴더 (아직 init 전이면 None)
pub fn dir() -> Option<PathBuf> {
    LOGGER.get().map(|l| l.dir.clone())
}

/// 지금 쓰는 파일 — [로그 폴더 열기]가 탐색기에서 이 파일을 짚는다
pub fn current_file() -> Option<PathBuf> {
    LOGGER
        .get()
        .map(|l| l.file_for(&Local::now().format("%Y-%m-%d").to_string(), false))
}

/// 최근 `n`줄 (오래된 것 → 새것 차례)
pub fn recent(n: usize) -> Vec<String> {
    LOGGER.get().map(|l| l.recent(n)).unwrap_or_default()
}

/// 사용자 폴더 앞부분을 `~`로 — 진단 정보에 사용자 이름이 실려 나가지 않게
pub fn mask(s: &str) -> String {
    match LOGGER.get() {
        Some(l) => mask_homes(s, &l.homes),
        None => mask_homes(s, &home_dirs()),
    }
}

fn home_dirs() -> Vec<String> {
    ["USERPROFILE", "HOME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .filter(|h| h.len() > 3)
        .collect()
}

/// `homes`의 각 경로(대소문자·`\`/`/` 가리지 않고)를 `~`로 바꾼다
fn mask_homes(s: &str, homes: &[String]) -> String {
    let mut out = s.to_string();
    for home in homes {
        for variant in [home.clone(), home.replace('\\', "/")] {
            let needle = variant.to_lowercase();
            if needle.is_empty() {
                continue;
            }
            loop {
                // 바이트 위치를 소문자판에서 찾는다 — ASCII 밖 글자는 길이가 바뀔 수 있어 같을 때만
                let lower = out.to_lowercase();
                if lower.len() != out.len() {
                    out = out.replace(&variant, "~");
                    break;
                }
                match lower.find(&needle) {
                    Some(at) => out.replace_range(at..at + needle.len(), "~"),
                    None => break,
                }
            }
        }
    }
    out
}

/// 한 줄로 — 여러 줄 메시지(패닉의 백트레이스 등)는 줄마다 들여 써서 다음 줄로 이어 붙인다
fn format_line(now: &str, level: Level, msg: &str) -> String {
    let mut lines = msg.lines();
    let first = lines.next().unwrap_or("");
    let mut out = format!("{now} {} {first}\n", level.tag());
    for rest in lines {
        out.push_str("    ");
        out.push_str(rest);
        out.push('\n');
    }
    out
}

/// `yamcha-2026-10-02.log`·`yamcha-2026-10-02.old.log` → (날짜, 지금 파일인가)
fn parse_name(name: &str) -> Option<(NaiveDate, bool)> {
    let rest = name.strip_prefix(PREFIX)?;
    let (date, current) = if let Some(d) = rest.strip_suffix(".old.log") {
        (d, false)
    } else {
        (rest.strip_suffix(".log")?, true)
    };
    NaiveDate::parse_from_str(date, "%Y-%m-%d").ok().map(|d| (d, current))
}

impl Logger {
    fn new(dir: PathBuf, max_bytes: u64, homes: Vec<String>) -> Self {
        Logger { dir, max_bytes, homes, state: Mutex::new(None) }
    }

    fn file_for(&self, date: &str, old: bool) -> PathBuf {
        let tail = if old { ".old.log" } else { ".log" };
        self.dir.join(format!("{PREFIX}{date}{tail}"))
    }

    fn open(&self, date: &str) -> Option<Open> {
        fs::create_dir_all(&self.dir).ok()?;
        let path = self.file_for(date, false);
        let file = OpenOptions::new().create(true).append(true).open(&path).ok()?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Some(Open { date: date.to_string(), file, size })
    }

    fn write(&self, level: Level, msg: &str) {
        let now = Local::now();
        self.write_at(&now.format("%Y-%m-%d").to_string(), &now.format("%Y-%m-%d %H:%M:%S%.3f").to_string(), level, msg);
    }

    fn write_at(&self, date: &str, stamp: &str, level: Level, msg: &str) {
        let line = format_line(stamp, level, &mask_homes(msg, &self.homes));
        let Ok(mut state) = self.state.lock() else { return };
        if state.as_ref().is_none_or(|o| o.date != date) {
            if let Ok(d) = NaiveDate::parse_from_str(date, "%Y-%m-%d") {
                self.prune(d);
            }
            *state = self.open(date);
        }
        // 넘치면 지금 파일을 .old로 밀고 새로 연다 (그날의 앞부분 5MB는 남는다)
        if state.as_ref().is_some_and(|o| o.size > 0 && o.size + line.len() as u64 > self.max_bytes) {
            *state = None;
            let old = self.file_for(date, true);
            let _ = fs::remove_file(&old);
            let _ = fs::rename(self.file_for(date, false), &old);
            *state = self.open(date);
        }
        if let Some(o) = state.as_mut() {
            if o.file.write_all(line.as_bytes()).is_ok() {
                o.size += line.len() as u64;
            }
        }
    }

    /// `today`에서 `KEEP_DAYS`일보다 오래된 로그를 지운다 (이 기록기가 만든 이름만)
    fn prune(&self, today: NaiveDate) {
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        let cutoff = today - Duration::days(KEEP_DAYS);
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some((date, _)) = parse_name(&name) {
                if date < cutoff {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }

    fn recent(&self, n: usize) -> Vec<String> {
        let Ok(entries) = fs::read_dir(&self.dir) else { return Vec::new() };
        let mut files: Vec<((NaiveDate, bool), PathBuf)> = entries
            .flatten()
            .filter_map(|e| parse_name(&e.file_name().to_string_lossy()).map(|k| (k, e.path())))
            .collect();
        // 새것부터: 날짜가 늦은 것, 같은 날이면 지금 파일(.log)이 .old보다 새것
        files.sort_by_key(|f| std::cmp::Reverse(f.0));
        let mut out: Vec<String> = Vec::new();
        for (_, path) in files {
            let Ok(text) = read_lossy(&path) else { continue };
            let lines: Vec<&str> = text.lines().collect();
            let take = (n - out.len()).min(lines.len());
            let mut chunk: Vec<String> =
                lines[lines.len() - take..].iter().map(|s| s.to_string()).collect();
            chunk.append(&mut out);
            out = chunk;
            if out.len() >= n {
                break;
            }
        }
        out
    }
}

fn read_lossy(path: &Path) -> std::io::Result<String> {
    Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // 시험용 옛 로그 파일을 맨 쓰기로 꾸민다
mod tests {
    use super::*;

    fn logger(dir: &Path, max: u64) -> Logger {
        Logger::new(dir.to_path_buf(), max, vec![r"C:\Users\Tester".to_string()])
    }

    #[test]
    fn 하루_한_파일에_한_줄씩_쌓고_여러_줄은_들여_쓴다() {
        let d = tempfile::tempdir().unwrap();
        let l = logger(d.path(), MAX_BYTES);
        l.write_at("2026-10-02", "2026-10-02 10:00:00.000", Level::Info, "켰다");
        l.write_at("2026-10-02", "2026-10-02 10:00:01.000", Level::Error, "패닉\n  at a.rs:1");
        let text = fs::read_to_string(d.path().join("yamcha-2026-10-02.log")).unwrap();
        assert_eq!(
            text,
            "2026-10-02 10:00:00.000 INFO  켰다\n2026-10-02 10:00:01.000 ERROR 패닉\n      at a.rs:1\n"
        );
    }

    #[test]
    fn 사용자_폴더는_물결로_줄인다() {
        let homes = vec![r"C:\Users\Tester".to_string()];
        assert_eq!(
            mask_homes(r"열기 실패: c:\users\tester\iCloudDrive\YamchaMemo\Free\메모.md", &homes),
            r"열기 실패: ~\iCloudDrive\YamchaMemo\Free\메모.md"
        );
        assert_eq!(mask_homes("C:/Users/Tester/a and C:/Users/Tester/b", &homes), "~/a and ~/b");
        assert_eq!(mask_homes(r"E:\Projects\vault", &homes), r"E:\Projects\vault");
    }

    #[test]
    fn 넘치면_old로_밀고_새로_쓴다() {
        let d = tempfile::tempdir().unwrap();
        let l = logger(d.path(), 100);
        for i in 0..6 {
            l.write_at("2026-10-02", "2026-10-02 10:00:00.000", Level::Info, &format!("줄 {i}"));
        }
        let cur = fs::read_to_string(d.path().join("yamcha-2026-10-02.log")).unwrap();
        let old = fs::read_to_string(d.path().join("yamcha-2026-10-02.old.log")).unwrap();
        assert!(cur.len() as u64 <= 100 && old.len() as u64 <= 100, "{cur:?} / {old:?}");
        assert!(cur.contains("줄 5"));
        // 최근 줄은 .old와 지금 파일을 이어 차례대로 준다
        let recent = l.recent(3);
        assert_eq!(recent.len(), 3);
        assert!(recent[2].ends_with("줄 5"), "{recent:?}");
        assert!(recent[1].ends_with("줄 4"), "{recent:?}");
    }

    #[test]
    fn 날이_바뀌면_일주일_지난_로그를_지운다() {
        let d = tempfile::tempdir().unwrap();
        for name in ["yamcha-2026-09-20.log", "yamcha-2026-09-24.old.log", "yamcha-2026-09-25.log", "남의 파일.log"] {
            fs::write(d.path().join(name), "x\n").unwrap();
        }
        let l = logger(d.path(), MAX_BYTES);
        l.write_at("2026-10-02", "2026-10-02 00:00:01.000", Level::Info, "새 날");
        let mut left: Vec<String> = fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(left, ["yamcha-2026-09-25.log", "yamcha-2026-10-02.log", "남의 파일.log"]);
    }

    #[test]
    fn 최근_줄은_여러_날을_건너_차례대로() {
        let d = tempfile::tempdir().unwrap();
        let l = logger(d.path(), MAX_BYTES);
        l.write_at("2026-10-01", "2026-10-01 23:59:59.000", Level::Info, "어제");
        l.write_at("2026-10-02", "2026-10-02 00:00:01.000", Level::Warn, "오늘");
        let r = l.recent(10);
        assert_eq!(r.len(), 2);
        assert!(r[0].ends_with("어제") && r[1].ends_with("오늘"), "{r:?}");
    }
}
