// Spec §11's Start screen: pick a project (recent list + folder input).
// Replaces a login screen — see docs/design/DESIGN.md's "no login
// screen" rule. The folder input only ever accepts a path that already
// has .fern/fern.db (POST /projects/open does the real check); this
// screen never creates one.

import { PRODUCT_NAME, pluralize } from "@context-fern/core";
import { useEffect, useState } from "react";
import { ApiError, listProjects, openProjectPath } from "../api/client";
import type { RecentProject } from "../api/types";
import { CharacterFern } from "../components/CharacterFern";
import { FernGlyph } from "../components/FernGlyph";
import { DEFAULT_DAEMON_PORT } from "../constants";
import "./Start.css";

export interface OpenedProject {
  path: string;
  name: string;
}

export function Start({
  onOpen,
  initialAuthError = null,
}: {
  onOpen: (project: OpenedProject) => void;
  /** Surfaced by main.tsx when the one-time code exchange itself failed, or the browser silently dropped the resulting session cookie — both show up here instead of a merely-empty recent-projects list, which would otherwise look identical to "no projects yet". */
  initialAuthError?: string | null;
}) {
  const [projects, setProjects] = useState<RecentProject[] | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [error, setError] = useState<string | null>(initialAuthError);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((res) => {
        if (!cancelled) setProjects(res.projects);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function open(path: string): Promise<void> {
    setError(null);
    setSubmitting(true);
    try {
      const opened = await openProjectPath(path);
      onOpen(opened);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't open that project — try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (folderPath.trim()) void open(folderPath.trim());
  }

  return (
    <div className="start-screen">
      <div className="start-card">
        <div className="start-card__left">
          <FernGlyph />
          <div className="start-heading">
            <h1>Open a fern</h1>
            <p>
              {PRODUCT_NAME} runs on this machine. Pick a project to see its
              sessions.
            </p>
          </div>

          {projects && projects.length > 0 && (
            <ul className="start-recent-list" aria-label="Recent projects">
              {projects.map((project) => (
                <li key={project.path}>
                  <button
                    type="button"
                    className="start-recent-row"
                    disabled={submitting}
                    onClick={() => void open(project.path)}
                  >
                    <span className="start-recent-row__info">
                      <span className="start-recent-row__name">
                        {project.name}
                      </span>
                      <span className="start-recent-row__path">
                        {project.path}
                      </span>
                    </span>
                    <span className="start-recent-row__count">
                      {pluralize(project.sessionCount, "session")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Decorative only — "OR" is already plain reading-order text for screen readers; the lines carry no separate meaning. */}
          <div className="start-divider">
            <span />
            OR
            <span />
          </div>

          <form className="start-folder-form" onSubmit={handleSubmit}>
            <label htmlFor="fern-folder">Project folder</label>
            <input
              id="fern-folder"
              type="text"
              placeholder="~/code/your-project"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
            />
            <button
              type="submit"
              className="start-open-button"
              disabled={submitting || folderPath.trim().length === 0}
            >
              Open fern
            </button>
          </form>

          {error && (
            <p role="alert" className="start-error">
              {error}
            </p>
          )}

          <p className="start-footer">
            No account needed · localhost:
            {window.location.port || DEFAULT_DAEMON_PORT}
            <br />
            Nothing here leaves this machine
          </p>
        </div>
        <div className="start-card__art">
          <CharacterFern />
        </div>
      </div>
    </div>
  );
}
