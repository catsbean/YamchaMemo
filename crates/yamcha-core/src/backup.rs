//! 백업과 복원 — vault를 zip 하나로 묶고, 빈 폴더로만 되푼다 (7-5).
//!
//! **무엇을 넣나.** 노트·첨부·`_types.json`·`_callouts.json` 등 vault의 파일 전부와
//! `.yamcha/templates/`(사용자가 고친 본문·제목 템플릿). `.yamcha/`의 나머지(히스토리·휴지통·
//! 임시 파일)는 넣지 않는다 — 다시 만들 수 있거나 백업의 몫이 아니고, 넣기 시작하면 백업이
//! 몇 배가 된다. 검색 색인은 애초에 vault 밖(앱 데이터 폴더)에 있다.
//!
//! **수정시각을 따로 적는다.** 노트의 날짜는 파일명이 날짜가 아니면 수정시각에서 나온다
//! (`Vault::summary_of`). 풀면서 수정시각을 되살리지 않으면 복원한 노트가 모두 "오늘"이 되고
//! 날짜순 목록이 뭉개진다. zip 자체의 시각은 2초 단위·시간대 없음이라 믿지 않고, 나노초를
//! 목록 파일(`MANIFEST`)에 적어 둔다.
//!
//! **복원은 빈 폴더로만.** 지금 vault를 덮어쓰지 않는다 — 되돌릴 수 없는 일을 조용히 하지
//! 않는다는 규율(`audit`의 "자동 수정 없음"과 같은 결).

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{Datelike, Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::error::CoreError;
use crate::Progress;

/// zip 안의 목록 파일 — 만든 시각과 파일마다의 수정시각(나노초)
pub const MANIFEST: &str = ".yamcha-backup.json";
/// zip 주석 — "이 앱이 만든 백업"이라는 표시
const MARK: &str = "YamchaMemo backup 1";

/// 백업·복원 결과
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct BackupReport {
    /// 담은(푼) 파일 수
    pub files: u32,
    /// 그중 노트(`.md`) 수
    pub notes: u32,
    /// 원본 크기 합 (바이트)
    pub bytes: f64,
}

#[derive(Serialize, Deserialize, Default)]
struct Manifest {
    version: u32,
    created: String,
    /// 경로 → 수정시각(epoch 나노초)
    mtimes: BTreeMap<String, i64>,
}

/// 이 vault 상대 경로를 백업에 넣나
fn included(rel: &str) -> bool {
    if rel == MANIFEST || rel.ends_with(".md.tmp") {
        return false;
    }
    match rel.split_once('/') {
        Some((".yamcha", rest)) => rest.starts_with("templates/"),
        _ => rel != ".yamcha",
    }
}

fn is_note(rel: &str) -> bool {
    rel.ends_with(".md") && !rel.starts_with(".yamcha/")
}

/// 백업에 넣을 파일 (상대 경로, 절대 경로) — 경로 순으로
fn files_to_back_up(root: &Path) -> Result<Vec<(String, PathBuf)>, CoreError> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let ft = entry.file_type()?;
            // 바로가기(심볼릭 링크)는 따라가지 않는다 — vault 밖을 통째로 담을 수 있다
            if ft.is_symlink() {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if ft.is_dir() {
                // `.yamcha`는 templates만 들여다본다
                if rel == ".yamcha" || rel.starts_with(".yamcha/") {
                    if rel == ".yamcha" || rel.starts_with(".yamcha/templates") {
                        walk(root, &path, out)?;
                    }
                    continue;
                }
                walk(root, &path, out)?;
            } else if included(&rel) {
                out.push((rel, path));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// 이미 압축된 형식은 다시 압축하지 않는다 — 줄지 않고 시간만 든다
fn compression_for(rel: &str) -> CompressionMethod {
    let ext = rel.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some(
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "heic" | "mp3" | "m4a" | "mp4"
            | "mov" | "zip" | "7z" | "gz" | "docx" | "xlsx" | "pptx" | "hwpx" | "epub",
        ) => CompressionMethod::Stored,
        _ => CompressionMethod::Deflated,
    }
}

fn nanos_of(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as i64).unwrap_or(0)
}

/// zip 항목에 적을 시각 (압축 프로그램에서 볼 때용 — 복원은 `MANIFEST`를 본다)
fn zip_time(t: SystemTime) -> zip::DateTime {
    let local = Local.timestamp_nanos(nanos_of(t));
    zip::DateTime::from_date_and_time(
        local.year().clamp(1980, 2107) as u16,
        local.month() as u8,
        local.day() as u8,
        local.hour() as u8,
        local.minute() as u8,
        local.second() as u8,
    )
    .unwrap_or_default()
}

/// `dest`가 `root` 안에 있나 (아직 없는 파일이어도 부모 폴더로 가린다)
fn is_inside(dest: &Path, root: &Path) -> bool {
    let Ok(root) = root.canonicalize() else { return false };
    let parent = dest.parent().unwrap_or(dest);
    parent.canonicalize().map(|p| p.starts_with(&root)).unwrap_or(false)
}

/// vault를 zip 하나로 묶는다. `progress`에는 (담은 파일, 전체).
///
/// 임시 파일(`…zip.tmp`)에 다 쓴 뒤 이름을 바꾼다 — 도중에 끊겨도 반쯤 쓰인 zip이
/// 백업인 척 남지 않는다. 읽지 못한 파일이 하나라도 있으면 실패한다 — 몇 편이 빠진
/// 백업을 멀쩡한 줄 알고 믿는 것이 가장 나쁘다.
pub fn create_backup(
    root: &Path,
    dest: &Path,
    progress: Progress<'_>,
) -> Result<BackupReport, CoreError> {
    if is_inside(dest, root) {
        return Err(CoreError::Invalid(
            "백업 파일을 vault 안에 둘 수 없습니다 — 다음 백업에 딸려 들어갑니다. 다른 폴더를 고르세요."
                .into(),
        ));
    }
    let files = files_to_back_up(root)?;
    let mut tmp_name = dest.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);

    let written = write_zip(&files, &tmp, progress);
    match written {
        Ok(report) => {
            fs::rename(&tmp, dest)?;
            Ok(report)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn write_zip(
    files: &[(String, PathBuf)],
    tmp: &Path,
    progress: Progress<'_>,
) -> Result<BackupReport, CoreError> {
    let zip_err = |e: zip::result::ZipError| CoreError::Invalid(format!("백업 파일을 쓰지 못했습니다: {e}"));
    let out = File::create(tmp)?;
    let mut zip = zip::ZipWriter::new(BufWriter::new(out));
    let mut manifest = Manifest {
        version: 1,
        created: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        mtimes: BTreeMap::new(),
    };
    let mut report = BackupReport::default();
    let total = files.len();
    for (i, (rel, abs)) in files.iter().enumerate() {
        progress(i, total);
        let read_err = |e: io::Error| CoreError::Invalid(format!("'{rel}'을(를) 읽지 못했습니다: {e}"));
        let mut src = File::open(abs).map_err(read_err)?;
        let meta = src.metadata().map_err(read_err)?;
        let modified = meta.modified().unwrap_or(UNIX_EPOCH);
        let options = SimpleFileOptions::default()
            .compression_method(compression_for(rel))
            .last_modified_time(zip_time(modified))
            .large_file(meta.len() >= u32::MAX as u64);
        zip.start_file(rel.as_str(), options).map_err(zip_err)?;
        io::copy(&mut src, &mut zip).map_err(read_err)?;
        manifest.mtimes.insert(rel.clone(), nanos_of(modified));
        report.files += 1;
        report.bytes += meta.len() as f64;
        if is_note(rel) {
            report.notes += 1;
        }
    }
    let json = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| CoreError::Invalid(format!("백업 목록을 만들지 못했습니다: {e}")))?;
    zip.start_file(MANIFEST, SimpleFileOptions::default()).map_err(zip_err)?;
    zip.write_all(&json)?;
    zip.set_comment(MARK).map_err(zip_err)?;
    let buffered = zip.finish().map_err(zip_err)?;
    let file = buffered.into_inner().map_err(|e| e.into_error())?;
    // 디스크에 닿은 뒤에 이름을 바꾼다 — 정전 뒤에 빈 zip이 백업 자리에 있으면 안 된다
    file.sync_all()?;
    progress(total, total);
    Ok(report)
}

/// 백업 zip을 **빈 폴더**(없으면 만든다)로 푼다. `progress`에는 (푼 파일, 전체).
///
/// 풀기 전에 모든 경로를 먼저 본다 — `../`나 절대 경로로 폴더 밖을 가리키는 항목이 하나라도
/// 있으면 아무것도 쓰지 않고 거부한다. 풀다가 실패하면 **이번에 만든 것만** 걷어 내
/// 폴더를 처음 모습(없었거나 비어 있던)으로 돌려놓는다.
pub fn restore_backup(
    zip_path: &Path,
    dest: &Path,
    progress: Progress<'_>,
) -> Result<BackupReport, CoreError> {
    let not_backup = || CoreError::Invalid("YamchaMemo 백업 파일이 아닙니다.".into());
    let file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(BufReader::new(file)).map_err(|_| not_backup())?;
    if archive.comment() != MARK.as_bytes() && archive.index_for_name(MANIFEST).is_none() {
        return Err(not_backup());
    }

    let existed = dest.exists();
    if existed {
        if !dest.is_dir() {
            return Err(CoreError::Invalid("복원할 자리가 폴더가 아닙니다.".into()));
        }
        if fs::read_dir(dest)?.next().is_some() {
            return Err(CoreError::Invalid(
                "빈 폴더에만 복원할 수 있습니다 — 지금 있는 파일을 덮지 않으려는 것입니다. 새 폴더를 고르세요."
                    .into(),
            ));
        }
    }

    // 먼저 경로를 전부 확인한다 (아무것도 쓰기 전에)
    let mut entries: Vec<(usize, PathBuf, String)> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| not_backup())?;
        let name = entry.name().to_string();
        if name == MANIFEST || entry.is_dir() {
            continue;
        }
        let Some(safe) = entry.enclosed_name() else {
            return Err(CoreError::Invalid(format!(
                "백업에 폴더 밖을 가리키는 경로가 들어 있어 풀지 않았습니다: {name}"
            )));
        };
        entries.push((i, safe, name));
    }
    let manifest: Manifest = match archive.by_name(MANIFEST) {
        Ok(mut m) => {
            let mut s = String::new();
            m.read_to_string(&mut s)?;
            serde_json::from_str(&s).unwrap_or_default()
        }
        Err(_) => Manifest::default(),
    };

    fs::create_dir_all(dest)?;
    let extracted = extract(&mut archive, &entries, &manifest, dest, progress);
    if extracted.is_err() {
        // 이번에 만든 것만 걷는다 — 폴더는 없었거나 비어 있었다
        if existed {
            if let Ok(children) = fs::read_dir(dest) {
                for c in children.flatten() {
                    let p = c.path();
                    let _ = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
                }
            }
        } else {
            let _ = fs::remove_dir_all(dest);
        }
    }
    extracted
}

fn extract<R: Read + io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    entries: &[(usize, PathBuf, String)],
    manifest: &Manifest,
    dest: &Path,
    progress: Progress<'_>,
) -> Result<BackupReport, CoreError> {
    let mut report = BackupReport::default();
    let total = entries.len();
    for (n, (i, safe, name)) in entries.iter().enumerate() {
        progress(n, total);
        let mut entry = archive
            .by_index(*i)
            .map_err(|e| CoreError::Invalid(format!("'{name}'을(를) 풀지 못했습니다: {e}")))?;
        let target = dest.join(safe);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        // 빈 폴더로 새로 푸는 것이라 원자적 쓰기가 필요 없다 — 실패하면 폴더째 걷는다
        let mut out = File::create(&target)?;
        let bytes = io::copy(&mut entry, &mut out)?;
        if let Some(&nanos) = manifest.mtimes.get(name) {
            if nanos > 0 {
                let _ = out.set_modified(UNIX_EPOCH + Duration::from_nanos(nanos as u64));
            }
        }
        report.files += 1;
        report.bytes += bytes as f64;
        if is_note(name) {
            report.notes += 1;
        }
    }
    progress(total, total);
    Ok(report)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // 시험 vault를 맨 쓰기로 꾸민다
mod tests {
    use super::*;

    fn noop() -> impl FnMut(usize, usize) {
        |_, _| {}
    }

    /// 한글 파일명·첨부·템플릿이 있는 vault를 꾸민다
    fn sample_vault(root: &Path) {
        fs::create_dir_all(root.join("Free")).unwrap();
        fs::create_dir_all(root.join("Books")).unwrap();
        fs::create_dir_all(root.join("_attachments/covers")).unwrap();
        fs::create_dir_all(root.join(".yamcha/templates")).unwrap();
        fs::create_dir_all(root.join(".yamcha/history/Free")).unwrap();
        fs::create_dir_all(root.join(".yamcha/trash")).unwrap();
        fs::create_dir_all(root.join(".yamcha/tmp")).unwrap();
        fs::write(root.join("Free/메모 하나.md"), "---\ntype: free\n---\n\n본문").unwrap();
        fs::write(root.join("Books/클린 코드.md"), "---\ntype: book\n---\n\n## 소개").unwrap();
        fs::write(root.join("_attachments/covers/표지.jpg"), [0xFF, 0xD8, 0xFF, 1, 2, 3]).unwrap();
        fs::write(root.join("_attachments/회의 자료.pdf"), b"%PDF-1.4 ...").unwrap();
        fs::write(root.join("_types.json"), "[]").unwrap();
        fs::write(root.join(".yamcha/templates/daily.md"), "## 할 일\n").unwrap();
        fs::write(root.join(".yamcha/history/Free/x.md"), "옛 판").unwrap();
        fs::write(root.join(".yamcha/trash/20260101-000000_지운것.md"), "지움").unwrap();
        fs::write(root.join(".yamcha/tmp/쓰는중.tmp"), "").unwrap();
        fs::write(root.join("Free/옛 임시.md.tmp"), "").unwrap();
    }

    fn listing(root: &Path) -> Vec<(String, Vec<u8>)> {
        files_to_back_up(root)
            .unwrap()
            .into_iter()
            .map(|(rel, abs)| (rel, fs::read(abs).unwrap()))
            .collect()
    }

    #[test]
    fn 백업했다가_새_폴더로_풀면_그대로_돌아온다() {
        let vault = tempfile::tempdir().unwrap();
        sample_vault(vault.path());
        // 노트 날짜는 수정시각에서 나온다 — 옛날 시각을 박아 두고 되살아나는지 본다
        let old = UNIX_EPOCH + Duration::from_secs(1_600_000_000) + Duration::from_nanos(123_456_789);
        File::options()
            .write(true)
            .open(vault.path().join("Free/메모 하나.md"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        let before = listing(vault.path());

        let out = tempfile::tempdir().unwrap();
        let zip = out.path().join("백업.zip");
        let mut seen = Vec::new();
        let made = create_backup(vault.path(), &zip, &mut |d, t| seen.push((d, t))).unwrap();
        assert_eq!((made.files, made.notes), (6, 2));
        assert_eq!(seen.last(), Some(&(6, 6)));
        assert!(!out.path().join("백업.zip.tmp").exists(), "임시 파일이 남았다");

        let dest = out.path().join("복원");
        let restored = restore_backup(&zip, &dest, &mut noop()).unwrap();
        assert_eq!((restored.files, restored.notes), (6, 2));
        assert_eq!(listing(&dest), before, "내용이나 목록이 달라졌다");
        let mtime = fs::metadata(dest.join("Free/메모 하나.md")).unwrap().modified().unwrap();
        assert_eq!(nanos_of(mtime) / 1_000, nanos_of(old) / 1_000, "수정시각이 되살아나지 않았다");

        // 히스토리·휴지통·임시 파일은 넣지 않는다
        assert!(!dest.join(".yamcha/history").exists());
        assert!(!dest.join(".yamcha/trash").exists());
        assert!(!dest.join(".yamcha/tmp").exists());
        assert!(!dest.join("Free/옛 임시.md.tmp").exists());
        assert!(!dest.join(MANIFEST).exists(), "목록 파일이 vault에 풀렸다");
        // 원본은 그대로다
        assert_eq!(listing(vault.path()), before);
        assert!(vault.path().join(".yamcha/history/Free/x.md").exists());
    }

    #[test]
    fn 비어_있지_않은_폴더에는_풀지_않는다() {
        let vault = tempfile::tempdir().unwrap();
        sample_vault(vault.path());
        let out = tempfile::tempdir().unwrap();
        let zip = out.path().join("b.zip");
        create_backup(vault.path(), &zip, &mut noop()).unwrap();

        let dest = out.path().join("있던 폴더");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("내 글.md"), "지키자").unwrap();
        let err = restore_backup(&zip, &dest, &mut noop()).unwrap_err();
        assert!(err.to_string().contains("빈 폴더"), "{err}");
        assert_eq!(fs::read_to_string(dest.join("내 글.md")).unwrap(), "지키자");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 1);
    }

    #[test]
    fn 폴더_밖을_가리키는_항목이_있으면_아무것도_풀지_않는다() {
        let out = tempfile::tempdir().unwrap();
        let zip = out.path().join("나쁜.zip");
        let mut w = zip::ZipWriter::new(File::create(&zip).unwrap());
        w.start_file("Free/멀쩡.md", SimpleFileOptions::default()).unwrap();
        w.write_all(b"ok").unwrap();
        w.start_file("../밖.md", SimpleFileOptions::default()).unwrap();
        w.write_all(b"x").unwrap();
        w.set_comment(MARK).unwrap();
        w.finish().unwrap();

        let dest = out.path().join("복원");
        let err = restore_backup(&zip, &dest, &mut noop()).unwrap_err();
        assert!(err.to_string().contains("폴더 밖"), "{err}");
        assert!(!dest.exists(), "거부했는데 폴더가 생겼다");
        assert!(!out.path().join("밖.md").exists());
    }

    #[test]
    fn 이_앱의_백업이_아닌_zip은_거부한다() {
        let out = tempfile::tempdir().unwrap();
        let zip = out.path().join("남의.zip");
        let mut w = zip::ZipWriter::new(File::create(&zip).unwrap());
        w.start_file("readme.txt", SimpleFileOptions::default()).unwrap();
        w.write_all(b"hi").unwrap();
        w.finish().unwrap();
        let err = restore_backup(&zip, &out.path().join("d"), &mut noop()).unwrap_err();
        assert!(err.to_string().contains("백업 파일이 아닙니다"), "{err}");
    }

    #[test]
    fn 백업_파일을_vault_안에_두지_않는다() {
        let vault = tempfile::tempdir().unwrap();
        sample_vault(vault.path());
        let err = create_backup(vault.path(), &vault.path().join("Free/백업.zip"), &mut noop())
            .unwrap_err();
        assert!(err.to_string().contains("vault 안"), "{err}");
        assert!(!vault.path().join("Free/백업.zip").exists());
    }

    #[test]
    fn 풀다가_실패하면_만든_것을_걷어_낸다() {
        let vault = tempfile::tempdir().unwrap();
        sample_vault(vault.path());
        let out = tempfile::tempdir().unwrap();
        let zip = out.path().join("b.zip");
        create_backup(vault.path(), &zip, &mut noop()).unwrap();
        // 앞의 몇 편은 풀리고 넷째(압축 없이 담은 표지)에서 CRC가 어긋나게 깨뜨린다
        let data_at = {
            let mut a = zip::ZipArchive::new(File::open(&zip).unwrap()).unwrap();
            let i = a.index_for_name("_attachments/covers/표지.jpg").unwrap();
            let e = a.by_index(i).unwrap();
            e.data_start().unwrap() as usize
        };
        let mut bytes = fs::read(&zip).unwrap();
        bytes[data_at] ^= 0xFF;
        let broken = out.path().join("깨진.zip");
        fs::write(&broken, &bytes).unwrap();

        // 없던 폴더 — 폴더째 걷힌다
        let dest = out.path().join("복원");
        assert!(restore_backup(&broken, &dest, &mut noop()).is_err());
        assert!(!dest.exists(), "실패했는데 반쯤 푼 폴더가 남았다");

        // 비어 있던 폴더 — 폴더는 두고 안만 비운다
        let empty = out.path().join("빈 폴더");
        fs::create_dir_all(&empty).unwrap();
        assert!(restore_backup(&broken, &empty, &mut noop()).is_err());
        assert!(empty.is_dir());
        assert_eq!(fs::read_dir(&empty).unwrap().count(), 0, "반쯤 푼 파일이 남았다");
    }
}
