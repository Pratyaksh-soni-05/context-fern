import { getJson } from "../daemon-client";
import { renderTree, type TreeFrondInput } from "../tree-render";

export async function runTree(): Promise<void> {
  const projectPath = process.cwd();
  const res = await getJson(
    `/tree?projectPath=${encodeURIComponent(projectPath)}`,
  );

  console.log(
    renderTree({
      stemName: res.stemName as string,
      fronds: res.fronds as TreeFrondInput[],
      strayCount: res.strayCount as number,
    }),
  );
}
