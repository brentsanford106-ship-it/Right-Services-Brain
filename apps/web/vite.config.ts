import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  server: { host: "localhost", port: 5173, strictPort: true },
  build: { sourcemap: false },
  test: { environment: "jsdom", include: ["src/**/*.test.tsx"] },
});
