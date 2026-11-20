There is no `bench smoke` command. Run the benchmark's two checks that exist:

1. `uv run --project bench pytest`: the benchmark's own tests (fast, offline, synthetic fixtures). Report pass or fail.
2. If `bench/data/scrubbed/streams.jsonl` exists on this machine (it is gitignored, so it may not), run `uv run --project bench bench eval bench/data/scrubbed/streams.jsonl`. It takes about 20 minutes for about 37,000 turns, so run it in the background and say so. If the file does not exist, say that and skip it.

Report the `bench eval` table as it prints it (action accuracy, F1 new, F1 return, F1 stray, over-carry, p50 and p95 latency, per splice variant, for `full` and the baselines). There is no stored baseline file; compare with `bench/results/day30-report.md` or the README's benchmark table only if the user asks, and flag any metric that moved more than 2 points against whichever they name. Label every number spliced and synthetic, not natural, unless a `--natural` file was given.
