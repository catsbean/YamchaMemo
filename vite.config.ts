import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    // 기본값 500kB는 **웹에서 내려받는** 상황을 재는 값이다. 이 앱은 데스크톱이라
    // 번들을 네트워크가 아니라 로컬 디스크에서 읽으므로 그 비용이 아예 없다.
    // 지금 1.1MB인데 절반이 에디터다 — CodeMirror 351kB + 파서(@lezer) 202kB,
    // React 177kB, 내가 쓴 코드는 130kB뿐. 줄일 여지가 사실상 없는 구성이라
    // 빌드마다 뜨는 경고는 소음일 뿐이라서 한도를 올려 둔다.
    // (시작이 느려지면 그때는 짐작 말고 실제 시작 시간부터 잰다)
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // testvault: 프로젝트 안에 vault를 두고 테스트할 때 리로드 루프 방지
      ignored: [
        "**/src-tauri/**",
        "**/crates/**",
        "**/target/**",
        "**/testvault/**",
        "**/.yamcha/**",
      ],
    },
  },
});
