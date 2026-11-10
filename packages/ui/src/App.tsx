// Top-level screen switch: Start (pick a project) vs. the app shell.

import { useState } from "react";
import { AppShell } from "./screens/AppShell";
import { type OpenedProject, Start } from "./screens/Start";

export interface AppProps {
  /** A message from main.tsx's one-time code exchange, surfaced on the Start screen — e.g. an expired/reused code, or the browser having silently dropped the session cookie. */
  initialAuthError?: string | null;
}

export function App({ initialAuthError = null }: AppProps) {
  const [project, setProject] = useState<OpenedProject | null>(null);

  if (!project) {
    return <Start onOpen={setProject} initialAuthError={initialAuthError} />;
  }

  return <AppShell projectPath={project.path} projectName={project.name} />;
}
