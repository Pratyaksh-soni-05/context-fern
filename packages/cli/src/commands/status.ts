import { getJson } from "@context-fern/daemon/client";

export async function runStatus(flags: Record<string, string>): Promise<void> {
  const projectPath = process.cwd();
  const res = await getJson(
    `/status?projectPath=${encodeURIComponent(projectPath)}`,
  );

  if (flags.json === "true") {
    console.log(JSON.stringify(res));
    return;
  }
  console.log(res.statusReceipt);
}
