/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VWIKI_RACE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
