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

    /// `as_str`의 짝 — 캐시 컬럼에 든 짧은 이름을 되읽는다.
    /// (`FromStr` 트레이트가 아니라 이름을 `from_code`로 둔다 — 실패가 없다)
    pub fn from_code(s: &str) -> Status {
        match s {
            "ok" => Status::Ok,
            "empty" => Status::Empty,
            "encrypted" => Status::Encrypted,
            "too_big" => Status::TooBig,
            "unsupported" => Status::Unsupported,
            _ => Status::Failed(String::new()),
        }
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
        // 비밀번호가 걸린 문서 — 비밀번호 없이는 열 수 없다
        return Extracted::err(Status::Encrypted);
    }

    // 배포용 문서는 본문이 ViewText에 AES로 잠겨 들어간다
    let prefix = if distributed {
        "ViewText/Section"
    } else {
        "BodyText/Section"
    };
    let mut names: Vec<String> = comp
        .walk()
        .filter(|e| e.is_stream())
        .map(|e| {
            e.path()
                .to_string_lossy()
                .trim_start_matches('/')
                .replace('\\', "/")
        })
        .filter(|p| p.starts_with(prefix))
        .collect();
    if names.is_empty() {
        return Extracted::fail("본문 스트림 없음");
    }
    names.sort();

    let doc_info = if distributed {
        read_stream(&mut comp, "DocInfo").unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut out = String::new();
    let mut locked = 0usize;
    for name in names {
        let Some(raw) = read_stream(&mut comp, &name) else {
            continue;
        };
        if distributed {
            match view_text_section(&raw, &doc_info, compressed) {
                Some(text) => out.push_str(&text),
                None => locked += 1,
            }
        } else {
            let data = if compressed {
                match inflate(&raw) {
                    Some(d) => d,
                    None => continue,
                }
            } else {
                raw
            };
            scan_records(&data, &mut out);
        }
        if out.chars().count() > MAX_CHARS {
            break;
        }
    }
    // 열쇠를 못 찾은 배포용 문서는 실패가 아니라 "잠김"으로 남긴다
    if out.trim().is_empty() && locked > 0 {
        return Extracted::err(Status::Encrypted);
    }
    Extracted::ok(out)
}

// ---------- 배포용 hwp (ViewText) ----------
//
// 한글의 "배포용 문서로 저장"은 본문을 `BodyText/`가 아니라 `ViewText/`에 넣고
// AES-128-ECB로 잠근다. 열쇠는 스트림 앞머리 260바이트(레코드 헤더 4 + 데이터 256)에
// 난독화되어 들어 있다 — MSVC `rand()`와 같은 선형 합동 생성기로 XOR 스트림을 만들어 풀고,
// 첫 바이트 하위 4비트가 가리키는 자리에서 16바이트를 꺼내면 그것이 AES 키다.
//
// ⚠️ 포맷 문서가 불완전해서 구현마다 열쇠를 꺼내는 자리가 다르다(섹션 앞머리 vs DocInfo).
// 그래서 후보를 모두 시도하고 **평문이 나오는 것을 고른다** — 아래 `looks_like_text`.

/// MSVC `rand()` — seed를 그대로 쓰는 선형 합동 생성기.
/// 한글이 난독화에 쓰는 것과 같다.
#[cfg(feature = "docs")]
struct MsvcRng(u32);

#[cfg(feature = "docs")]
impl MsvcRng {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(214013).wrapping_add(2531011);
        (self.0 >> 16) & 0x7FFF
    }
}

/// 260바이트 앞머리에서 AES 키를 꺼낸다. 실패하면 None.
#[cfg(feature = "docs")]
fn distribution_key(head: &[u8]) -> Option<[u8; 16]> {
    if head.len() < 260 {
        return None;
    }
    // 레코드 헤더 4바이트를 뺀 256바이트가 난독화된 데이터다
    let mut data = [0u8; 256];
    data.copy_from_slice(&head[4..260]);

    let seed = i32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    let mut rng = MsvcRng(seed as u32);
    let mut key_byte = 0u8;
    let mut run = 0i32;
    for (i, b) in data.iter_mut().enumerate() {
        if run == 0 {
            key_byte = (rng.next() & 0xFF) as u8;
            run = (rng.next() & 0x0F) as i32 + 1;
        }
        // 앞 4바이트(seed)는 그대로 두고 나머지만 푼다
        if i >= 4 {
            *b ^= key_byte;
        }
        run -= 1;
    }

    let offset = 4 + (seed & 0x0F) as usize;
    if offset + 16 > 256 {
        return None;
    }
    let mut key = [0u8; 16];
    key.copy_from_slice(&data[offset..offset + 16]);
    Some(key)
}

/// AES-128-ECB 복호. 블록에 안 맞는 꼬리는 버린다(암호문은 블록 배수다).
#[cfg(feature = "docs")]
fn aes_ecb_decrypt(key: &[u8; 16], data: &[u8]) -> Vec<u8> {
    use aes::cipher::{BlockCipherDecrypt, KeyInit};
    let Ok(cipher) = aes::Aes128::new_from_slice(key) else {
        return Vec::new();
    };
    let usable = data.len() - (data.len() % 16);
    let mut out = data[..usable].to_vec();
    for block in out.chunks_exact_mut(16) {
        let Ok(b) = <&mut aes::cipher::Array<u8, aes::cipher::consts::U16>>::try_from(block)
        else {
            continue;
        };
        cipher.decrypt_block(b);
    }
    out
}

/// 복호·해제 결과가 정말 본문인지 — PARA_TEXT 레코드에서 글자가 나오는지 본다.
/// 열쇠 후보를 고를 판단 기준이다.
#[cfg(feature = "docs")]
fn looks_like_text(data: &[u8]) -> Option<String> {
    let mut out = String::new();
    scan_records(data, &mut out);
    let printable = out
        .chars()
        .filter(|c| !c.is_control() && !c.is_whitespace())
        .count();
    (printable >= 8).then_some(out)
}

/// 배포용 문서의 한 섹션에서 평문을 뽑는다.
/// 열쇠 후보(섹션 앞머리 / DocInfo 앞머리)를 차례로 시도한다.
#[cfg(feature = "docs")]
fn view_text_section(raw: &[u8], doc_info: &[u8], compressed: bool) -> Option<String> {
    if raw.len() <= 260 {
        return None;
    }
    let body = &raw[260..];
    for head in [raw, doc_info] {
        let Some(key) = distribution_key(head) else {
            continue;
        };
        let decrypted = aes_ecb_decrypt(&key, body);
        if decrypted.is_empty() {
            continue;
        }
        let candidate = if compressed {
            match inflate(&decrypted) {
                Some(d) => d,
                None => continue,
            }
        } else {
            decrypted
        };
        if let Some(text) = looks_like_text(&candidate) {
            return Some(text);
        }
    }
    None
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
                r#"<hml><hp:p><hp:t>첫째 문단</hp:t></hp:p><hp:p><hp:t>둘째 문단</hp:t></hp:p></hml>"#,
            )],
        );
        let r = extract(&hwpx);
        assert_eq!(r.status, Status::Ok);
        assert!(r.text.contains("첫째 문단"));
        assert!(r.text.contains("둘째 문단"));

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

    /// 난독화에 쓰는 생성기가 MSVC `rand()`와 같은지 — C의 `srand(1); rand()` 값으로 확인.
    /// 이 값이 틀리면 배포용 문서의 열쇠를 절대 못 찾는다.
    #[test]
    #[cfg(feature = "docs")]
    fn msvc_rng_matches_c_rand() {
        let mut r = MsvcRng(1);
        let got: Vec<u32> = (0..6).map(|_| r.next()).collect();
        assert_eq!(got, vec![41, 18467, 6334, 26500, 19169, 15724]);
    }

    /// 배포용 hwp를 직접 만들어(암호화까지) 되읽는다.
    ///
    /// 이 왕복 테스트가 확인하는 것: 플래그 판독 · ViewText 경로 선택 · 260바이트 앞머리 건너뛰기
    /// · AES-128-ECB 복호 · 압축 해제 · 레코드 스캔.
    /// 확인하지 **못하는** 것: 열쇠를 꺼내는 자리가 한글의 실제 규칙과 같은지
    /// (같은 규칙으로 넣고 빼므로 자기 일관성만 본다) → 실파일 검증이 따로 필요하다.
    #[test]
    #[cfg(feature = "docs")]
    fn distribution_hwp_roundtrip() {
        use aes::cipher::{BlockCipherEncrypt, KeyInit};

        let d = dir();
        let path = d.path().join("배포용.hwp");

        // ① 앞머리 260바이트를 만든다 — 우리 키 유도의 역순으로 키를 심는다
        let seed: i32 = 0x1234_5678;
        let key: [u8; 16] = *b"0123456789abcdef";
        let mut plain = [0u8; 256];
        plain[..4].copy_from_slice(&seed.to_le_bytes());
        let offset = 4 + (seed & 0x0F) as usize;
        plain[offset..offset + 16].copy_from_slice(&key);
        // 같은 XOR 스트림으로 덮어 난독화한다 (XOR이라 넣기와 빼기가 같다)
        let mut rng = MsvcRng(seed as u32);
        let mut kb = 0u8;
        let mut run = 0i32;
        for (i, b) in plain.iter_mut().enumerate() {
            if run == 0 {
                kb = (rng.next() & 0xFF) as u8;
                run = (rng.next() & 0x0F) as i32 + 1;
            }
            if i >= 4 {
                *b ^= kb;
            }
            run -= 1;
        }
        let mut head = vec![0u8; 4]; // 레코드 헤더 자리 (내용은 안 본다)
        head.extend_from_slice(&plain);
        assert_eq!(distribution_key(&head), Some(key), "심은 키를 되찾지 못했다");

        // ② 본문 레코드를 만들어 압축하고 AES로 잠근다
        let text = "배포용 문서의 본문 한 줄";
        let utf16: Vec<u8> = text
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let mut record = Vec::new();
        let header: u32 = (HWPTAG_PARA_TEXT & 0x3FF) | ((utf16.len() as u32) << 20);
        record.extend_from_slice(&header.to_le_bytes());
        record.extend_from_slice(&utf16);

        let mut deflated = Vec::new();
        {
            use std::io::Write;
            let mut enc =
                flate2::write::DeflateEncoder::new(&mut deflated, flate2::Compression::default());
            enc.write_all(&record).unwrap();
            enc.finish().unwrap();
        }
        let cipher = aes::Aes128::new_from_slice(&key).unwrap();
        let mut sealed = deflated.clone();
        sealed.resize(sealed.len() + (16 - sealed.len() % 16) % 16, 0);
        for block in sealed.chunks_exact_mut(16) {
            let b = <&mut aes::cipher::Array<u8, aes::cipher::consts::U16>>::try_from(block).unwrap();
            cipher.encrypt_block(b);
        }

        // ③ OLE 컨테이너로 쓴다 — FileHeader(압축+배포용) + ViewText/Section0
        {
            use std::io::Write;
            let mut comp = cfb::create(&path).unwrap();
            let mut fh = vec![0u8; 256];
            fh[..17].copy_from_slice(b"HWP Document File");
            fh[32..36].copy_from_slice(&0x0501_0001u32.to_le_bytes());
            fh[36..40].copy_from_slice(&0x05u32.to_le_bytes()); // 압축 + 배포용
            comp.create_stream("/FileHeader")
                .unwrap()
                .write_all(&fh)
                .unwrap();
            let mut section = head.clone();
            section.extend_from_slice(&sealed);
            comp.create_storage("/ViewText").unwrap();
            comp.create_stream("/ViewText/Section0")
                .unwrap()
                .write_all(&section)
                .unwrap();
            comp.flush().unwrap();
        }

        // ④ 되읽는다
        let r = extract(&path);
        assert_eq!(r.status, Status::Ok, "배포용 문서를 읽지 못했다");
        assert!(r.text.contains("배포용 문서"), "{:?}", r.text);
        assert!(r.text.contains("본문 한 줄"), "{:?}", r.text);
    }

    /// 열쇠를 못 찾는 배포용 문서는 실패가 아니라 "잠김"으로 남는다
    #[test]
    #[cfg(feature = "docs")]
    fn undecryptable_distribution_reports_encrypted() {
        use std::io::Write;
        let d = dir();
        let path = d.path().join("못푸는배포용.hwp");
        let mut comp = cfb::create(&path).unwrap();
        let mut fh = vec![0u8; 256];
        fh[..17].copy_from_slice(b"HWP Document File");
        fh[36..40].copy_from_slice(&0x05u32.to_le_bytes());
        comp.create_stream("/FileHeader")
            .unwrap()
            .write_all(&fh)
            .unwrap();
        comp.create_storage("/ViewText").unwrap();
        // 앞머리 260바이트 + 아무 의미 없는 암호문
        comp.create_stream("/ViewText/Section0")
            .unwrap()
            .write_all(&vec![0x7Au8; 260 + 64])
            .unwrap();
        comp.flush().unwrap();
        drop(comp);

        assert_eq!(extract(&path).status, Status::Encrypted);
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
            assert_eq!(Status::from_code(s.as_str()), s);
        }
        assert!(matches!(
            Status::from_code(Status::Failed("무엇이든".into()).as_str()),
            Status::Failed(_)
        ));
    }
}
