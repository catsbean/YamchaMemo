import { useEffect, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import { Section } from "./ui";

/** 카카오 책 검색 API 키 */
export default function KakaoSection() {
  const [kakaoKey, setKakaoKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    load("settings.json", { autoSave: true, defaults: {} }).then(async (s) => {
      setKakaoKey((await s.get<string>("kakaoApiKey")) ?? "");
    });
  }, []);

  async function saveKakaoKey() {
    const s = await load("settings.json", { autoSave: true, defaults: {} });
    await s.set("kakaoApiKey", kakaoKey.trim());
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  }

  return (
    <Section
      title="카카오 책 검색"
      desc={
        <>
          키가 없어도 책 검색·자동 채우기는 교보문고로 동작합니다. 카카오 키를 넣으면 검색 결과가 더
          정확해집니다. <span className="text-neutral-600">developers.kakao.com</span>에서 REST API 키를
          무료로 발급받을 수 있습니다.
        </>
      }
    >
      <div className="flex gap-2">
        <input
          type="password"
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
          placeholder="REST API 키"
          value={kakaoKey}
          onChange={(e) => setKakaoKey(e.target.value)}
        />
        <button
          className="shrink-0 rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500"
          onClick={saveKakaoKey}
        >
          저장
        </button>
        {keySaved && (
          <span className="self-center text-xs text-emerald-600">저장됨</span>
        )}
      </div>
    </Section>
  );
}
