// Wire-protocol constants shared between the server (server.ts) and the
// lightweight client (client.ts) — split out so the client never needs
// to import server.ts (which pulls in the whole project-registry/store
// graph). Built from CLI_NAME, never the literal word "fern".

import { CLI_NAME } from "@context-fern/core";

export const TOKEN_HEADER = `x-${CLI_NAME}-token`;
