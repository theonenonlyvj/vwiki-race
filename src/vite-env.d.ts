/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VWIKI_RACE_API_URL?: string;
  /** Unset by any build today - errorReporting.ts's reportVisibleError falls
   *  back to "dev" when absent. Reserved for a future CI step to stamp the
   *  deployed commit SHA so a visible-error beacon can be pinned to a build. */
  readonly VITE_COMMIT_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
