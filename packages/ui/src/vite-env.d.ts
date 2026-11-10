/// <reference types="vite/client" />

// Declared explicitly (not just relying on vite/client's own ambient
// merge) — tsc -b's composite project-reference build (unlike a
// standalone `tsc --noEmit` on this package alone) didn't pick up the
// triple-slash reference's *.css module declaration on its own.
declare module "*.css";
