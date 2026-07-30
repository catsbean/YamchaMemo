//! 첨부 문서에서 **검색용 평문**을 뽑는다. 레이아웃·서식은 버린다.
//!
//! 규칙 넷 (전부 실파일 109개 측정에서 나온 것 — `HANDOFF-search.md` §3-1)
//! 1. 어떤 파서든 패닉할 수 있다 (pdf-extract는 실제로 패닉했다) → `catch_unwind`로 격리
//! 2. 암호 걸린 문서는 실패가 아니다 → `Encrypted`로 구분해 사용자에게 이유를 알린다
//! 3. 크기 상한은 포맷별로 다르다 → PDF는 크기에 비용이 비례하지만
//!    컨테이너 포맷(hwp·office)은 안쪽 본문 스트림만 읽으므로 100MB짜리도 0.5초다
//! 4. 텍스트가 없는 PDF는 스캔본이다 → `Empty`로 남겨 "OCR 없음"을 설명할 수 있게
//!
//! HWP 5.0은 직접 파싱한다. `hwpers` 크레이트는 실파일에서 파싱 자체를 실패했다.

use std::path::Path;

/// PDF는 추출 비용이 파일 크기에 비례한다
pub const MAX_PDF_BYTES: u64 = 50 * 1024 * 1024;
/// 컨테이너 포맷은 안쪽 본문만 읽으므로 느슨하게 (이미지 때문에 100MB인 hwp도 본문은 수만 자)
pub const MAX_CONTAINER_BYTES: u64 = 300 * 1024 * 1024;
/// 한 문서에서 색인할 최대 문자 수
pub const MAX_CHARS: usize = 200_000;

/// 추출 결과 상태. 캐시에 그대로 저장해 다음 실행에서 재시도를 건너뛴다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// 텍스트를 얻었다
    Ok,
    /// 문서는 읽혔지만 텍스트가 없다 (스캔본 PDF, 그림만 있는 문서)
    Empty,
    /// 암호가 걸려 있다
    Encrypted,
    /// 파서가 실패했다 (사유 포함)
    Failed(String),
    /// 크기 상한 초과
    TooBig,
    /// 다루지 않는 확장자
    Unsupported,
}

impl Status {
    /// 캐시 컬럼에 넣을 짧은 이름
    pub fn as_str(&self) -> &str {
        match self {
            Status::Ok => "ok",
            Status::Empty => "empty",
            Status::Encrypted => "encrypted",
            Status::Failed(_) => "failed",
            Status::TooBig => "too_big",
            Status::Unsupported => "unsupported",
        }
    }

    pub fn from_str(s: &str) -> Status {
        match s {
            "ok" => Status::Ok,
            "empty" => Status::Empty,
            "encrypted" => Status::Encrypted,
            "too_big" => Status::TooBig,
            "unsupported" => Status::Unsupported,
            _ => Status::Failed(String::new()),
        }
    }

    /// 다시 시도해 볼 가치가 있는지 (파일이 그대로일 때)
    pub fn worth_retry(&self) -> bool {
        false
    }
}

pub struct Extracted {
    pub text: String,
    pub status: Status,
}

impl Extracted {
    /// 상한을 넘으면 자르고, 빈 텍스트는 `Empty`로 본다
    #[cfg(feature = "docs")]
    fn ok(mut text: String) -> Extracted {
        if text.chars().count() > MAX_CHARS {
            text = text.chars().take(MAX_CHARS).collect();
        }
        let status = if text.trim().is_empty() {
            Status::Empty
        } else {
            Status::Ok
        };
        Extracted { text, status }
    }

    fn err(status: Status) -> Extracted {
        Extracted {
            text: String::new(),
            status,
        }
    }

    fn fail(msg: impl Into<String>) -> Extracted {
        Extracted::err(Status::Failed(msg.into()))
    }
}

/// 이 확장자를 다루는지. 순회할 때 파일을 열어 보기 전에 걸러내는 데 쓴다.
pub fn is_supported(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "hwp" | "hwpx" | "docx" | "pptx" | "xlsx" | "xlsm" | "xls" | "pdf" | "txt" | "csv" | "md"
    )
}

/// 파일에서 평문을 뽑는다. 어떤 입력에도 패닉하지 않는다.
pub fn extract(path: &Path) -> Extracted {
    let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_lowercase()) else {
        return Extracted::err(Status::Unsupported);
    };
    if !is_supported(&ext) {
        return Extracted::err(Status::Unsupported);
    }
    let cap = if ext == "pdf" {
        MAX_PDF_BYTES
    } else {
        MAX_CONTAINER_BYTES
    };
    if let Ok(m) = std::fs::metadata(path) {
        if m.len() > cap {
            return Extracted::err(Status::TooBig);
        }
    }
    let p = path.to_path_buf();
    // 파서가 패닉하면 앱이 죽는다 — 실측에서 pdf 한 건이 실제로 패닉했다
    match std::panic::catch_unwind(move || dispatch(&p, &ext)) {
        Ok(x) => x,
        Err(_) => Extracted::fail("파서 패닉"),
    }
}

#[cfg(feature = "docs")]
fn dispatch(path: &Path, ext: &str) -> Extracted {
    match ext {
        "hwp" => hwp(path),
        "hwpx" => zip_xml(path, &["Contents/section"], "hp:p"),
        "docx" => zip_xml(path, &["word/document.xml", "word/header", "word/footer"], "w:p"),
        "pptx" => zip_xml(path, &["ppt/slides/slide", "ppt/notesSlides/"], "a:p"),
        "xlsx" | "xlsm" | "xls" => sheets(path),
        "pdf" => pdf(path),
        "txt" | "csv" | "md" => plain(path),
        _ => Extracted::err(Status::Unsupported),
    }
}

/// feature "docs"를 끈 빌드 — 첨부 검색이 비활성이 된다
#[cfg(not(feature = "docs"))]
fn dispatch(_path: &Path, _ext: &str) -> Extracted {
    Extracted::err(Status::Unsupported)
}

// ---------- HWP 5.0 : OLE 컨테이너 + raw deflate + PARA_TEXT 레코드 ----------

/// 문단 텍스트 레코드 (HWPTAG_BEGIN(16) + 51)
#[cfg(feature = "docs")]
const HWPTAG_PARA_TEXT: u32 = 67;

#[cfg(feature = "docs")]
fn hwp(path: &Path) -> Extracted {
    let Ok(mut comp) = cfb::open(path) else {
        return Extracted::fail("OLE 컨테이너가 아님");
    };
    let Some(fh) = read_stream(&mut comp, "FileHeader") else {
        return Extracted::fail("FileHeader 없음");
    };
    if fh.len() < 40 {
        return Extracted::fail("FileHeader가 짧음");
    }
    let flags = u32::from_le_bytes([fh[36], fh[37], fh[38], fh[39]]);
    let compressed = flags & 0x01 != 0;
    let encrypted = flags & 0x02 != 0;
    let distributed = flags & 0x04 != 0;
    if encrypted {
        return Extracted::err(Status::Encrypted);
    }
    if distributed {
        // 배포용 문서는 ViewText가 AES로 잠겨 있다 — 유예(HANDOFF-search.md §8)
        return Extracted::err(Status::Encrypted);
    }

    let mut names: Vec<String> = comp
        .walk()
        .filter(|e| e.is_stream())
        .map(|e| {
            e.path()
                .to_string_lossy()
                .trim_start_matches('/')
                .replace('\\', "/")
        })
        .filter(|p| p.starts_with("BodyText/Section"))
        .collect();
    if names.is_empty() {
        return Extracted::fail("본문 스트림 없음");
    }
    names.sort();

    let mut out = String::new();
    for name in names {
        let Some(raw) = read_stream(&mut comp, &name) else {
            continue;
        };
        let data = if compressed {
            match inflate(&raw) {
                Some(d) => d,
                None => continue,
            }
        } else {
            raw
        };
        scan_records(&data, &mut out);
        if out.chars().count() > MAX_CHARS {
            break;
        }
    }
    Extracted::ok(out)
}

#[cfg(feature = "docs")]
fn read_stream(comp: &mut cfb::CompoundFile<std::fs::File>, name: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut s = comp.open_stream(name).ok()?;
    let mut b = Vec::new();
    s.read_to_end(&mut b).ok()?;
    Some(b)
}

/// HWP 압축 스트림은 raw deflate. 뒤가 잘려도 앞부분은 쓴다 —
/// 문서가 조금 깨졌어도 읽히는 데까지는 검색되는 게 낫다.
#[cfg(feature = "docs")]
fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    let _ = flate2::read::DeflateDecoder::new(data).read_to_end(&mut out);
    if out.is_empty() {
        let _ = flate2::read::ZlibDecoder::new(data).read_to_end(&mut out);
    }
    (!out.is_empty()).then_some(out)
}

/// 레코드를 훑어 문단 텍스트만 모은다.
/// 헤더는 u32 하나 — tag 10비트 · level 10비트 · size 12비트.
/// size가 0xFFF면 다음 u32가 실제 크기다.
///
/// **표 안의 셀 문단도 같은 스트림의 PARA_TEXT 레코드**라서 그냥 따라온다.
/// 공고문·양식처럼 표가 많은 한국 문서에서 이게 결정적이다.
#[cfg(feature = "docs")]
fn scan_records(data: &[u8], out: &mut String) {
    let mut pos = 0usize;
    while pos + 4 <= data.len() {
        let h = u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        pos += 4;
        let tag = h & 0x3FF;
        let mut size = (h >> 20) as usize;
        if size == 0xFFF {
            if pos + 4 > data.len() {
                return;
            }
            size = u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                as usize;
            pos += 4;
        }
        if pos + size > data.len() {
            return;
        }
        if tag == HWPTAG_PARA_TEXT {
            decode_para_text(&data[pos..pos + size], out);
            out.push('\n');
        }
        pos += size;
    }
}

/// PARA_TEXT는 UTF-16LE. 제어문자 중 확장 컨트롤(표·그림·각주 등)은
/// 자기 뒤로 정보 6워드 + 종료 1워드를 더 차지하므로 8워드를 건너뛴다.
#[cfg(feature = "docs")]
fn decode_para_text(body: &[u8], out: &mut String) {
    const EXTENDED: [u16; 13] = [1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23];
    let units: Vec<u16> = body
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let mut buf: Vec<u16> = Vec::with_capacity(units.len());
    let mut i = 0usize;
    while i < units.len() {
        let u = units[i];
        if u < 32 {
            if EXTENDED.contains(&u) {
                i += 8;
                continue;
            }
            buf.push(if u == 10 || u == 13 { 10 } else { 32 });
            i += 1;
            continue;
        }
        buf.push(u);
        i += 1;
    }
    out.push_str(&String::from_utf16_lossy(&buf));
}

// ---------- zip + XML : hwpx · docx · pptx ----------

/// zip 안의 본문 XML에서 태그를 걷어내고 문단마다 줄을 바꾼다.
#[cfg(feature = "docs")]
fn zip_xml(path: &Path, entry_prefixes: &[&str], para_tag: &str) -> Extracted {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(path) else {
        return Extracted::fail("열기 실패");
    };
    let Ok(mut zip) = zip::ZipArchive::new(file) else {
        return Extracted::fail("zip이 아님");
    };
    // 암호 걸린 OOXML은 zip 자체가 다르게 생겼다 (본문 XML이 없다)
    let mut names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.ends_with(".xml") && entry_prefixes.iter().any(|p| n.starts_with(p)))
        .collect();
    if names.is_empty() {
        return Extracted::fail("본문 XML 없음");
    }
    names.sort();
    let close = format!("</{para_tag}>");
    let mut out = String::new();
    for name in names {
        let Ok(mut f) = zip.by_name(&name) else {
            continue;
        };
        let mut xml = String::new();
        if f.read_to_string(&mut xml).is_err() {
            continue;
        }
        strip_xml(&xml, &close, &mut out);
        if out.chars().count() > MAX_CHARS {
            break;
        }
    }
    Extracted::ok(out)
}

/// 태그 제거 + 엔티티 복원. XML 파서를 쓰지 않는다 —
/// 검색용 평문에는 구조가 필요 없고, 파서 하나를 안 들이는 값이 더 크다.
#[cfg(feature = "docs")]
fn strip_xml(xml: &str, para_close: &str, out: &mut String) {
    // 문단 종료 태그를 먼저 표시해 두고 태그를 걷어낸다
    let marked = xml.replace(para_close, "\u{1}");
    let mut buf = String::with_capacity(marked.len() / 2);
    let mut in_tag = false;
    for c in marked.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            '\u{1}' => buf.push('\n'),
            _ if !in_tag => buf.push(c),
            _ => {}
        }
    }
    let buf = buf
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'");
    for line in buf.lines() {
        let t = line.trim();
        if !t.is_empty() {
            out.push_str(t);
            out.push('\n');
        }
    }
}

// ---------- 스프레드시트 ----------

#[cfg(feature = "docs")]
fn sheets(path: &Path) -> Extracted {
    use calamine::Reader;
    let mut wb = match calamine::open_workbook_auto(path) {
        Ok(w) => w,
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("password") || msg.contains("Password") {
                return Extracted::err(Status::Encrypted);
            }
            return Extracted::fail(msg);
        }
    };
    let mut out = String::new();
    for name in wb.sheet_names().to_vec() {
        if let Ok(range) = wb.worksheet_range(&name) {
            // 시트 이름도 찾을 거리다
            out.push_str(&name);
            out.push('\n');
            for row in range.rows() {
                let cells: Vec<String> = row
                    .iter()
                    .map(|c| c.to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !cells.is_empty() {
                    out.push_str(&cells.join(" "));
                    out.push('\n');
                }
            }
        }
        if out.chars().count() > MAX_CHARS {
            break;
        }
    }
    Extracted::ok(out)
}

// ---------- PDF ----------

#[cfg(feature = "docs")]
fn pdf(path: &Path) -> Extracted {
    match pdf_extract::extract_text(path) {
        Ok(t) => Extracted::ok(t),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("decryption") || msg.contains("password") {
                return Extracted::err(Status::Encrypted);
            }
            Extracted::fail(msg)
        }
    }
}

// ---------- 평문 ----------

#[cfg(feature = "docs")]
fn plain(path: &Path) -> Extracted {
    let Ok(bytes) = std::fs::read(path) else {
        return Extracted::fail("읽기 실패");
    };
    match String::from_utf8(bytes) {
        Ok(s) => Extracted::ok(s),
        // UTF-8이 아니면 한국 파일은 대개 CP949다
        Err(e) => {
            let (s, _, _) = encoding_rs::EUC_KR.decode(e.as_bytes());
            Extracted::ok(s.into_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "docs")]
    use std::io::Write;

    /// zip 기반 포맷 fixture를 그때그때 만든다.
    /// 바이너리 fixture를 저장소에 넣지 않으려는 것 — 남의 문서를 커밋할 일도 없다.
    #[cfg(feature = "docs")]
    fn make_zip(path: &Path, entries: &[(&str, &str)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        for (name, body) in entries {
            z.start_file(*name, opts).unwrap();
            z.write_all(body.as_bytes()).unwrap();
        }
        z.finish().unwrap();
    }

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    #[cfg(feature = "docs")]
    fn docx_text_and_paragraphs() {
        let d = dir();
        let p = d.path().join("문서.docx");
        make_zip(
            &p,
            &[(
                "word/document.xml",
                r#"<?xml version="1.0"?><w:document><w:body>
                <w:p><w:r><w:t>첫째 문단</w:t></w:r></w:p>
                <w:p><w:r><w:t>둘째 </w:t></w:r><w:r><w:t>문단</w:t></w:r></w:p>
                <w:p><w:r><w:t>기호 &amp; 엔티티</w:t></w:r></w:p>
                </w:body></w:document>"#,
            )],
        );
        let r = extract(&p);
        assert_eq!(r.status, Status::Ok);
        // 문단마다 줄이 바뀌고, 한 문단 안에서 쪼개진 조각은 붙는다
        assert!(r.text.contains("첫째 문단"), "{}", r.text);
        assert!(r.text.contains("둘째 문단"), "{}", r.text);
        // 엔티티가 복원된다
        assert!(r.text.contains("기호 & 엔티티"), "{}", r.text);
    }

    #[test]
    #[cfg(feature = "docs")]
    fn hwpx_and_pptx_use_their_own_paragraph_tags() {
        let d = dir();
        let hwpx = d.path().join("한글.hwpx");
        make_zip(
            &hwpx,
            &[(
                "Contents/section0.xml",
                r#"<hml><hp:p><hp:t>여름 소나기</hp:t></hp:p><hp:p><hp:t>입주자모집공고</hp:t></hp:p></hml>"#,
            )],
        );
        let r = extract(&hwpx);
        assert_eq!(r.status, Status::Ok);
        assert!(r.text.contains("여름 소나기"));
        assert!(r.text.contains("입주자모집공고"));

        let pptx = d.path().join("발표.pptx");
        make_zip(
            &pptx,
            &[(
                "ppt/slides/slide1.xml",
                r#"<p:sld><a:p><a:t>첫 장</a:t></a:p></p:sld>"#,
            )],
        );
        let r = extract(&pptx);
        assert_eq!(r.status, Status::Ok);
        assert!(r.text.contains("첫 장"));
    }

    #[test]
    #[cfg(feature = "docs")]
    fn text_file_reads_utf8_and_cp949() {
        let d = dir();
        let utf8 = d.path().join("메모.txt");
        std::fs::write(&utf8, "한글 메모").unwrap();
        assert!(extract(&utf8).text.contains("한글 메모"));

        // CP949로 인코딩된 "한글" — 한국에서 흔하다
        let cp949 = d.path().join("옛날.txt");
        std::fs::write(&cp949, [0xC7, 0xD1, 0xB1, 0xDB]).unwrap();
        let r = extract(&cp949);
        assert_eq!(r.status, Status::Ok);
        assert!(r.text.contains("한글"), "{:?}", r.text);
    }

    #[test]
    #[cfg(feature = "docs")]
    fn broken_files_fail_without_panicking() {
        let d = dir();
        // hwp인 척하는 쓰레기
        let fake = d.path().join("가짜.hwp");
        std::fs::write(&fake, "이건 OLE가 아니다").unwrap();
        assert!(matches!(extract(&fake).status, Status::Failed(_)));

        // zip 서명만 맞고 뒤가 엉망인 docx
        let fake = d.path().join("가짜.docx");
        let mut junk = b"PK\x03\x04".to_vec();
        junk.extend_from_slice("뒤는 엉망이다".as_bytes());
        std::fs::write(&fake, junk).unwrap();
        assert!(matches!(extract(&fake).status, Status::Failed(_)));

        // zip은 맞지만 본문 XML이 없다
        let empty = d.path().join("빈.docx");
        make_zip(&empty, &[("docProps/app.xml", "<x/>")]);
        assert!(matches!(extract(&empty).status, Status::Failed(_)));

        // 헤더만 있는 pdf
        let fake = d.path().join("가짜.pdf");
        std::fs::write(&fake, "%PDF-1.4 하지만 내용이 없다").unwrap();
        assert!(matches!(
            extract(&fake).status,
            Status::Failed(_) | Status::Empty
        ));
    }

    #[test]
    fn unsupported_and_oversize() {
        let d = dir();
        let zipfile = d.path().join("압축.zip");
        std::fs::write(&zipfile, b"x").unwrap();
        assert_eq!(extract(&zipfile).status, Status::Unsupported);
        assert!(!is_supported("zip"));
        assert!(is_supported("HWP")); // 대문자 확장자도 같다
        assert!(is_supported("pdf"));
    }

    #[test]
    #[cfg(feature = "docs")]
    fn char_cap_truncates() {
        let d = dir();
        let big = d.path().join("긴글.txt");
        std::fs::write(&big, "가".repeat(MAX_CHARS + 5_000)).unwrap();
        let r = extract(&big);
        assert_eq!(r.status, Status::Ok);
        assert_eq!(r.text.chars().count(), MAX_CHARS);
    }

    /// 실파일 검증. 바이너리 hwp는 fixture로 만들 수 없어(OLE 컨테이너) 실파일로만 확인된다.
    /// 개인 문서를 저장소에 넣지 않으려고 경로를 환경변수로 받는다.
    ///
    /// YAMCHA_DOC_SAMPLE="C:/경로/문서.hwp" cargo test -p yamcha-core real_document -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_document() {
        let Ok(path) = std::env::var("YAMCHA_DOC_SAMPLE") else {
            panic!("YAMCHA_DOC_SAMPLE에 파일 경로를 넣어 주세요");
        };
        let p = std::path::PathBuf::from(&path);
        let t = std::time::Instant::now();
        let r = extract(&p);
        let chars = r.text.chars().count();
        let hangul = r.text.chars().filter(|c| ('가'..='힣').contains(c)).count();
        println!(
            "{path}\n  상태 {:?} · {chars}자 · {}ms · 한글 {:.1}%",
            r.status,
            t.elapsed().as_millis(),
            hangul as f64 * 100.0 / chars.max(1) as f64
        );
        let head: String = r.text.chars().filter(|c| *c != '\r').take(200).collect();
        println!("  앞 200자: {head}");
        assert_eq!(r.status, Status::Ok);
        assert!(chars > 0);
        // 깨진 문자가 섞이면 추출 경로가 틀린 것이다
        assert_eq!(r.text.chars().filter(|c| *c == '\u{FFFD}').count(), 0);
    }

    #[test]
    fn status_roundtrips_through_cache_names() {
        for s in [
            Status::Ok,
            Status::Empty,
            Status::Encrypted,
            Status::TooBig,
            Status::Unsupported,
        ] {
            assert_eq!(Status::from_str(s.as_str()), s);
        }
        assert!(matches!(
            Status::from_str(Status::Failed("무엇이든".into()).as_str()),
            Status::Failed(_)
        ));
    }
}
