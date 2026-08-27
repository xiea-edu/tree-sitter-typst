from __future__ import annotations

import argparse
import csv
import json
import math
import os
import platform
import random
import statistics
import subprocess
from pathlib import Path

PARSER_LABELS = {
    "local": "Local (xiea-edu)",
    "uben0": "uben0",
    "seniormars": "SeniorMars",
}
PARSER_ORDER = ["local", "uben0", "seniormars"]
STRATUM_LABELS = {
    "independent": "Independent Typst + Universe",
    "uben0-tests": "uben0 tests",
    "seniormars-tests": "SeniorMars tests",
}


def pct(numerator: int, denominator: int) -> str:
    return "n/a" if denominator == 0 else f"{100 * numerator / denominator:.3f}%"


def median_rates(samples: list[dict], field: str) -> float:
    if field == "bytes":
        values = [sample["bytes"] * 1e9 / sample["elapsed_ns"] / (1024 * 1024) for sample in samples]
    else:
        values = [sample["operations"] * 1e9 / sample["elapsed_ns"] for sample in samples]
    return statistics.median(values)


def median_latency_us(samples: list[dict]) -> float:
    return statistics.median(sample["elapsed_ns"] / sample["operations"] / 1000 for sample in samples)


def bootstrap_ratio(a: list[dict], b: list[dict], field: str, seed: str) -> tuple[float, float, float]:
    assert len(a) == len(b)
    randomizer = random.Random(seed)
    ratios = []
    for _ in range(10_000):
        indices = [randomizer.randrange(len(a)) for _ in range(len(a))]
        if field == "bytes":
            av = [a[i]["bytes"] / a[i]["elapsed_ns"] for i in indices]
            bv = [b[i]["bytes"] / b[i]["elapsed_ns"] for i in indices]
        else:
            av = [a[i]["operations"] / a[i]["elapsed_ns"] for i in indices]
            bv = [b[i]["operations"] / b[i]["elapsed_ns"] for i in indices]
        ratios.append(statistics.median(av) / statistics.median(bv))
    ratios.sort()
    point = median_rates(a, field) / median_rates(b, field)
    return point, ratios[249], ratios[9749]


def command_output(command: list[str]) -> str:
    try:
        return subprocess.run(command, check=True, text=True, capture_output=True).stdout.strip()
    except Exception:
        return "unavailable"


def cpu_name() -> str:
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
            return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
    except Exception:
        return platform.processor() or "unavailable"


def write_csv(path: Path, accuracy: dict, speed: dict) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "parser",
                "valid_clean_files",
                "valid_files",
                "valid_clean_percent",
                "structural_macro_f1",
                "structural_micro_f1",
                "natural_invalid_detected",
                "natural_invalid_total",
                "mutated_invalid_detected",
                "mutated_invalid_total",
                "incremental_correct",
                "incremental_total",
                "full_parse_mib_s_median",
                "incremental_latency_us_median",
            ],
        )
        writer.writeheader()
        for parser in PARSER_ORDER:
            item = accuracy["parsers"][parser]
            writer.writerow(
                {
                    "parser": parser,
                    "valid_clean_files": item["valid_clean_files"],
                    "valid_files": item["valid_files"],
                    "valid_clean_percent": 100 * item["valid_clean_files"] / item["valid_files"],
                    "structural_macro_f1": item["structural"]["macro_f1"],
                    "structural_micro_f1": item["structural"]["micro_f1"],
                    "natural_invalid_detected": item["invalid"]["natural_detected"],
                    "natural_invalid_total": item["invalid"]["natural_total"],
                    "mutated_invalid_detected": item["invalid"]["mutation_detected"],
                    "mutated_invalid_total": item["invalid"]["mutation_total"],
                    "incremental_correct": item["incremental"]["passed"],
                    "incremental_total": item["incremental"]["total"],
                    "full_parse_mib_s_median": median_rates(speed["full_parse"][parser], "bytes"),
                    "incremental_latency_us_median": median_latency_us(speed["incremental_parse"][parser]),
                }
            )


def write_strata_csv(path: Path, accuracy: dict) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "stratum",
                "parser",
                "valid_clean_files",
                "valid_files",
                "valid_clean_percent",
                "valid_clean_bytes",
                "valid_bytes",
                "structural_macro_f1",
                "structural_micro_f1",
                "natural_invalid_detected",
                "natural_invalid_total",
            ],
        )
        writer.writeheader()
        for stratum in STRATUM_LABELS:
            for parser in PARSER_ORDER:
                item = accuracy["parsers"][parser]["strata"][stratum]
                writer.writerow(
                    {
                        "stratum": stratum,
                        "parser": parser,
                        "valid_clean_files": item["valid_clean_files"],
                        "valid_files": item["valid_files"],
                        "valid_clean_percent": 100 * item["valid_clean_files"] / item["valid_files"],
                        "valid_clean_bytes": item["valid_clean_bytes"],
                        "valid_bytes": item["valid_bytes"],
                        "structural_macro_f1": item["structural"]["macro_f1"],
                        "structural_micro_f1": item["structural"]["micro_f1"],
                        "natural_invalid_detected": item["natural_invalid_detected"],
                        "natural_invalid_total": item["natural_invalid_total"],
                    }
                )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--accuracy", type=Path, required=True)
    parser.add_argument("--speed", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--strata-csv", type=Path, required=True)
    args = parser.parse_args()

    accuracy = json.loads(args.accuracy.read_text(encoding="utf-8"))
    speed = json.loads(args.speed.read_text(encoding="utf-8"))
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))

    full_rates = {name: median_rates(speed["full_parse"][name], "bytes") for name in PARSER_ORDER}
    incremental_latencies = {
        name: median_latency_us(speed["incremental_parse"][name]) for name in PARSER_ORDER
    }
    full_pairs = []
    incremental_pairs = []
    for left_index, left in enumerate(PARSER_ORDER):
        for right in PARSER_ORDER[left_index + 1 :]:
            full_pairs.append(
                (left, right, *bootstrap_ratio(speed["full_parse"][left], speed["full_parse"][right], "bytes", f"full:{left}:{right}"))
            )
            incremental_pairs.append(
                (
                    left,
                    right,
                    *bootstrap_ratio(
                        speed["incremental_parse"][left],
                        speed["incremental_parse"][right],
                        "operations",
                        f"incremental:{left}:{right}",
                    ),
                )
            )

    cpu = cpu_name()
    os_description = platform.platform()
    power_scheme = command_output(["powercfg", "/getactivescheme"])
    rustc = command_output(["rustc", "--version"])
    cargo = command_output(["cargo", "--version"])

    lines = [
        "# Typst Tree-sitter Parser Benchmark",
        "",
        "## Result",
        "",
        "The independent corpus remains the primary accuracy result; upstream-owned tests are reported as separate home-test strata. The local parser retained the strongest independent accuracy. Speed is measured only on the independent common-clean cohort and does not override accuracy.",
        "",
        "## Corpus and controls",
        "",
        f"- {manifest['summary']['unique_files']:,} unique Typst inputs ({manifest['summary']['total_bytes']:,} bytes), with {manifest['summary']['duplicate_provenances']} exact duplicate provenances deduplicated and {manifest['summary']['excluded_files']} input excluded.",
        f"- {accuracy['oracle_valid_files']:,} files were valid under Typst 0.15.1; {accuracy['oracle_invalid_files']:,} contained official syntax errors.",
        f"- Real-world coverage used the latest versions of {len(manifest['selected_packages'])} Typst Universe packages chosen by the frozen SHA-256 seed `{manifest['selection_seed']}`.",
        f"- Independent stratum: {manifest['strata']['independent']['unique_files']:,} unique files ({manifest['strata']['independent']['total_bytes']:,} bytes).",
        f"- uben0 stratum: {manifest['strata']['uben0-tests']['unique_files']:,} unique sources from {manifest['parser_test_inventory']['uben0-tests']['corpus_cases']:,} corpus cases.",
        f"- SeniorMars stratum: {manifest['strata']['seniormars-tests']['unique_files']:,} unique sources from {manifest['parser_test_inventory']['seniormars-tests']['corpus_cases']:,} corpus cases and {manifest['parser_test_inventory']['seniormars-tests']['fixture_files']:,} `.typ` fixtures.",
        "- For parser-owned corpora, only the Typst source portion is reused. Parser-specific expected trees are intentionally ignored because the three grammars expose different node schemas.",
        "- Mutation and incremental-correctness samples remain drawn only from the independent stratum, preserving the original comparison exactly.",
        "- Each checked-in generated C parser and required scanner headers was compiled into one runner with the same Tree-sitter 0.26.13 runtime, MSVC C11 mode, and release optimization.",
        "",
        "## Primary accuracy: independent corpus",
        "",
        "| Parser | Clean oracle-valid files | Clean valid bytes | Structural macro F1 | Structural micro F1 | Natural invalid | Mutated invalid | Incremental = full | Timeouts |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for name in PARSER_ORDER:
        overall = accuracy["parsers"][name]
        item = overall["strata"]["independent"]
        lines.append(
            f"| {PARSER_LABELS[name]} | {item['valid_clean_files']}/{item['valid_files']} ({pct(item['valid_clean_files'], item['valid_files'])}) "
            f"| {item['valid_clean_bytes']:,}/{item['valid_bytes']:,} ({pct(item['valid_clean_bytes'], item['valid_bytes'])}) "
            f"| {item['structural']['macro_f1']:.4f} | {item['structural']['micro_f1']:.4f} "
            f"| {item['natural_invalid_detected']}/{item['natural_invalid_total']} "
            f"| {overall['invalid']['mutation_detected']}/{overall['invalid']['mutation_total']} "
            f"| {overall['incremental']['passed']}/{overall['incremental']['total']} "
            f"| {overall['parse_none_or_timeout']} |"
        )

    lines.extend(
        [
            "",
            "Structural F1 uses exact `(canonical construct, start byte, end byte)` matches for direct one-to-one named constructs shared by all implementations. It is secondary because the parsers intentionally expose different tree schemas; no nodes were merged, trimmed, or weighted for a particular parser.",
            "",
            "## Parser-owned test strata",
            "",
            "These rows make home-field effects visible rather than blending them into the independent headline result.",
            "",
            "| Corpus stratum | Parser | Clean oracle-valid files | Clean valid bytes | Structural macro F1 | Structural micro F1 | Natural invalid |",
            "|---|---|---:|---:|---:|---:|---:|",
        ]
    )
    for stratum in ("uben0-tests", "seniormars-tests"):
        for name in PARSER_ORDER:
            item = accuracy["parsers"][name]["strata"][stratum]
            lines.append(
                f"| {STRATUM_LABELS[stratum]} | {PARSER_LABELS[name]} "
                f"| {item['valid_clean_files']}/{item['valid_files']} ({pct(item['valid_clean_files'], item['valid_files'])}) "
                f"| {item['valid_clean_bytes']:,}/{item['valid_bytes']:,} ({pct(item['valid_clean_bytes'], item['valid_bytes'])}) "
                f"| {item['structural']['macro_f1']:.4f} | {item['structural']['micro_f1']:.4f} "
                f"| {item['natural_invalid_detected']}/{item['natural_invalid_total']} |"
            )

    lines.extend(
        [
            "",
            "## Speed on the common-clean cohort",
            "",
            f"The speed cohort contains {speed['cohort_files']} deterministically selected independent files ({speed['cohort_bytes']:,} bytes) from the {len(accuracy['independent_common_clean_ids']):,} independent files parsed cleanly by all three parsers. Results are medians of {speed['measurement_blocks']} interleaved blocks after {speed['warmup_blocks']} warm-up blocks on logical processor {speed['affinity_core']}.",
            "",
            "| Parser | Full parse median | Incremental median per edit |",
            "|---|---:|---:|",
        ]
    )
    for name in PARSER_ORDER:
        lines.append(
            f"| {PARSER_LABELS[name]} | {full_rates[name]:.2f} MiB/s | {incremental_latencies[name]:.2f} µs |"
        )

    lines.extend(
        [
            "",
            "Pairwise ratios below are `left ÷ right`; values above 1 mean the left parser is faster. Intervals are paired 95% bootstrap confidence intervals over measurement blocks.",
            "",
            "| Workload | Comparison | Ratio | 95% CI |",
            "|---|---|---:|---:|",
        ]
    )
    for left, right, point, low, high in full_pairs:
        lines.append(
            f"| Full | {PARSER_LABELS[left]} / {PARSER_LABELS[right]} | {point:.3f}× | [{low:.3f}, {high:.3f}] |"
        )
    for left, right, point, low, high in incremental_pairs:
        lines.append(
            f"| Incremental | {PARSER_LABELS[left]} / {PARSER_LABELS[right]} | {point:.3f}× | [{low:.3f}, {high:.3f}] |"
        )

    lines.extend(
        [
            "",
            "## Environment",
            "",
            f"- CPU: {cpu}",
            f"- OS: {os_description}",
            f"- Power scheme: `{power_scheme}`",
            f"- Rust: `{rustc}`",
            f"- Cargo: `{cargo}`",
            "- C compiler: MSVC 19.44.35228 (`/std:c11`, `/O2` as emitted by `cc` for `opt_level(3)`)",
            "",
            "## Pinned revisions",
            "",
        ]
    )
    for name, revision in accuracy["revisions"].items():
        lines.append(f"- {name}: `{revision}`")

    lines.extend(
        [
            "",
            "## Reproduction",
            "",
            "Run `prepare_corpus.py` against isolated clones at the pinned revisions, set `TYPST_BENCH_ROOT` to that checkout root, then build and run:",
            "",
            "```powershell",
            "cargo build --release --manifest-path benchmark/Cargo.toml",
            "typst-parser-benchmark.exe accuracy <manifest.json> <corpus-root> benchmark/results/accuracy.json",
            "typst-parser-benchmark.exe speed <manifest.json> <corpus-root> benchmark/results/accuracy.json benchmark/results/speed.json",
            "```",
            "",
            "The raw JSON, full corpus manifest, exact mapping code, and summary CSV accompany this report. Absolute timings are specific to this machine; the interleaved same-process ratios are the more portable speed result.",
            "",
        ]
    )

    args.report.write_text("\n".join(lines), encoding="utf-8")
    write_csv(args.csv, accuracy, speed)
    write_strata_csv(args.strata_csv, accuracy)
    print(json.dumps({"full_mib_s": full_rates, "incremental_us": incremental_latencies}, indent=2))


if __name__ == "__main__":
    main()
