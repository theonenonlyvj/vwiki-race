import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { resolveApiOrigin } from "./src/services/apiOrigin";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  resolveApiOrigin(env.VITE_VWIKI_RACE_API_URL, {
    production: mode === "production",
  });

  return {
    plugins: [react()],
  };
});
