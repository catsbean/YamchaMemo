import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
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
