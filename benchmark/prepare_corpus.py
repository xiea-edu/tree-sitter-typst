from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

LOCAL_SHA = "604f05fdfd679ff515a5226ecf314b65aa1c5c4f"
UBEN0_SHA = "46cf4ded12ee974a70bf8457263b67ad7ee0379d"
SENIORMARS_SHA = "1acd48c90d260bc9f8a99f903d3e2a8031bc7aae"
TYPST_SHA = "9dfd3a08500b7896045f907433cf7b4b02434fad"
PACKAGES_SHA = "df365225e63a0de72e6cbfb4704efd26e2f5c3bb"
PACKAGE_SAMPLE_SIZE = 200
MAX_FILE_BYTES = 1024 * 1024

SEED_TEXT = "\n".join(
    [
        "tree-sitter-typst-benchmark-v1",
        LOCAL_SHA,
        UBEN0_SHA,
        SENIORMARS_SHA,
        TYPST_SHA,
        PACKAGES_SHA,
    ]
)
SEED = hashlib.sha256(SEED_TEXT.encode()).hexdigest()


def run(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-c", f"safe.directory={repo}", *args],
        cwd=repo,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    return result.stdout


def semver_key(value: str) -> tuple:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?", value)
    if not match:
        return (-1, -1, -1, 0, value)
    major, minor, patch = map(int, match.group(1, 2, 3))
    prerelease = match.group(4)
    return (major, minor, patch, 1 if prerelease is None else 0, prerelease or "")


def configure_typst_checkout(repo: Path) -> None:
    run(repo, "sparse-checkout", "init", "--no-cone")
    run(repo, "sparse-checkout", "set", "--no-cone", "*.typ")
    run(repo, "checkout", "--detach", TYPST_SHA)


def configure_packages_checkout(repo: Path) -> list[dict]:
    names = [
        line.strip()
        for line in run(repo, "ls-tree", "-d", "--name-only", f"{PACKAGES_SHA}:packages/preview").splitlines()
        if line.strip()
    ]
    names.sort(key=lambda name: hashlib.sha256(f"{SEED}\0{name}".encode()).hexdigest())
    selected = []
    sparse_paths = []
    for name in names[:PACKAGE_SAMPLE_SIZE]:
        versions = [
            line.strip()
            for line in run(
                repo,
                "ls-tree",
                "-d",
                "--name-only",
                f"{PACKAGES_SHA}:packages/preview/{name}",
            ).splitlines()
            if line.strip()
        ]
        if not versions:
            continue
        version = max(versions, key=semver_key)
        relative = f"packages/preview/{name}/{version}"
        selected.append({"name": name, "version": version, "path": relative})
        sparse_paths.append(relative)

    run(repo, "sparse-checkout", "init", "--no-cone")
    run(repo, "sparse-checkout", "set", "--no-cone", *sparse_paths)
    run(repo, "checkout", "--detach", PACKAGES_SHA)
    return selected


def add_file(
    source: Path,
    provenance: dict,
    output_files: Path,
    records: dict[str, dict],
    exclusions: list[dict],
) -> None:
    try:
        data = source.read_bytes()
    except OSError as error:
        exclusions.append({**provenance, "reason": "read_error", "error": str(error)})
        return
    add_bytes(data, provenance, output_files, records, exclusions)


def add_bytes(
    data: bytes,
    provenance: dict,
    output_files: Path,
    records: dict[str, dict],
    exclusions: list[dict],
) -> None:
    if len(data) > MAX_FILE_BYTES:
        exclusions.append({**provenance, "reason": "over_size_limit", "bytes": len(data)})
        return
    try:
        data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        exclusions.append({**provenance, "reason": "invalid_utf8"})
        return

    digest = hashlib.sha256(data).hexdigest()
    if digest in records:
        records[digest]["provenances"].append(provenance)
        return

    stored = f"files/{digest}.typ"
    (output_files / f"{digest}.typ").write_bytes(data)
    records[digest] = {
        "id": digest,
        "stored": stored,
        "bytes": len(data),
        "provenances": [provenance],
    }


def parse_tree_sitter_corpus(path: Path) -> list[tuple[str, str, str]]:
    """Extract test names, source text, and expected tree text."""
    lines = path.read_text(encoding="utf-8").splitlines()
    cases: list[tuple[str, str, str]] = []
    index = 0
    divider = re.compile(r"^={3,}\s*$")
    separator = re.compile(r"^-{3,}\s*$")

    while index < len(lines):
        while index < len(lines) and not divider.fullmatch(lines[index]):
            index += 1
        if index == len(lines):
            break
        title_start = index + 1
        title_end = title_start
        while title_end < len(lines) and not divider.fullmatch(lines[title_end]):
            title_end += 1
        if title_end == len(lines):
            raise ValueError(f"unterminated test title in {path}")

        source_start = title_end + 1
        source_end = source_start
        while source_end < len(lines) and not separator.fullmatch(lines[source_end]):
            source_end += 1
        if source_end == len(lines):
            raise ValueError(f"missing source/tree separator in {path}")

        source_lines = lines[source_start:source_end]
        # Tree-sitter corpora conventionally use one blank framing line around
        # sources. Remove only that frame, preserving intentional extra blanks.
        if source_lines and not source_lines[0]:
            source_lines = source_lines[1:]
        if source_lines and not source_lines[-1]:
            source_lines = source_lines[:-1]
        expected_start = source_end + 1
        expected_end = expected_start
        while expected_end < len(lines) and not divider.fullmatch(lines[expected_end]):
            expected_end += 1

        title = " ".join(line.strip() for line in lines[title_start:title_end]).strip()
        cases.append((title, "\n".join(source_lines), "\n".join(lines[expected_start:expected_end])))
        index = expected_end

    expected = sum(1 for line in lines if separator.fullmatch(line))
    if len(cases) != expected:
        raise ValueError(f"extracted {len(cases)} of {expected} cases from {path}")
    return cases


def add_parser_tests(
    repo: Path,
    origin: str,
    revision: str,
    corpus_glob: str,
    output_files: Path,
    records: dict[str, dict],
    exclusions: list[dict],
) -> dict:
    corpus_files = sorted(repo.glob(corpus_glob))
    extracted_cases = 0
    for corpus_file in corpus_files:
        relative = corpus_file.relative_to(repo).as_posix()
        for case_index, (case_name, source, expected_tree) in enumerate(
            parse_tree_sitter_corpus(corpus_file)
        ):
            expected_recovery = bool(
                re.search(r"\((?:ERROR|MISSING|malformed_[A-Za-z0-9_]*)\b", expected_tree)
            )
            add_bytes(
                source.encode("utf-8"),
                {
                    "origin": origin,
                    "revision": revision,
                    "path": relative,
                    "case": case_name,
                    "case_index": case_index,
                    "format": "tree-sitter-corpus",
                    "expected_recovery": expected_recovery,
                },
                output_files,
                records,
                exclusions,
            )
            extracted_cases += 1

    fixture_files = sorted((repo / "test" / "fixtures").rglob("*.typ"))
    for fixture in fixture_files:
        add_file(
            fixture,
            {
                "origin": origin,
                "revision": revision,
                "path": fixture.relative_to(repo).as_posix(),
                "format": "typst-fixture",
                "expected_recovery": (
                    "invalid" in fixture.relative_to(repo).parts
                    or "malformed" in fixture.name.lower()
                ),
            },
            output_files,
            records,
            exclusions,
        )
    return {
        "corpus_files": len(corpus_files),
        "corpus_cases": extracted_cases,
        "fixture_files": len(fixture_files),
    }


def stratum_summary(records: dict[str, dict]) -> dict[str, dict]:
    groups = {
        "independent": {"typst", "typst-universe"},
        "uben0-tests": {"uben0-tests"},
        "seniormars-tests": {"seniormars-tests"},
    }
    summary = {}
    for name, origins in groups.items():
        selected = [
            item
            for item in records.values()
            if origins.intersection({provenance["origin"] for provenance in item["provenances"]})
        ]
        summary[name] = {
            "unique_files": len(selected),
            "total_bytes": sum(item["bytes"] for item in selected),
        }
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bench-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    bench_root = args.bench_root.resolve()
    output = args.output.resolve()
    output_files = output / "files"
    output_files.mkdir(parents=True, exist_ok=True)

    typst_repo = bench_root / "typst"
    packages_repo = bench_root / "packages"
    uben0_repo = bench_root / "uben0"
    seniormars_repo = bench_root / "seniormars"
    configure_typst_checkout(typst_repo)
    selected_packages = configure_packages_checkout(packages_repo)

    records: dict[str, dict] = {}
    exclusions: list[dict] = []

    for source in sorted(typst_repo.rglob("*.typ")):
        relative = source.relative_to(typst_repo).as_posix()
        add_file(
            source,
            {"origin": "typst", "revision": TYPST_SHA, "path": relative},
            output_files,
            records,
            exclusions,
        )

    for package in selected_packages:
        package_root = packages_repo / package["path"]
        for source in sorted(package_root.rglob("*.typ")):
            relative = source.relative_to(packages_repo).as_posix()
            add_file(
                source,
                {
                    "origin": "typst-universe",
                    "revision": PACKAGES_SHA,
                    "package": package["name"],
                    "version": package["version"],
                    "path": relative,
                },
                output_files,
                records,
                exclusions,
            )

    parser_test_inventory = {
        "uben0-tests": add_parser_tests(
            uben0_repo,
            "uben0-tests",
            UBEN0_SHA,
            "test/corpus/*.scm",
            output_files,
            records,
            exclusions,
        ),
        "seniormars-tests": add_parser_tests(
            seniormars_repo,
            "seniormars-tests",
            SENIORMARS_SHA,
            "test/corpus/*.txt",
            output_files,
            records,
            exclusions,
        ),
    }

    manifest = {
        "schema": 1,
        "selection_seed": SEED,
        "limits": {"package_sample_size": PACKAGE_SAMPLE_SIZE, "max_file_bytes": MAX_FILE_BYTES},
        "revisions": {
            "local": LOCAL_SHA,
            "uben0": UBEN0_SHA,
            "seniormars": SENIORMARS_SHA,
            "typst": TYPST_SHA,
            "packages": PACKAGES_SHA,
        },
        "selected_packages": selected_packages,
        "parser_test_inventory": parser_test_inventory,
        "strata": stratum_summary(records),
        "files": sorted(records.values(), key=lambda item: item["id"]),
        "exclusions": exclusions,
        "summary": {
            "unique_files": len(records),
            "total_bytes": sum(item["bytes"] for item in records.values()),
            "duplicate_provenances": sum(len(item["provenances"]) - 1 for item in records.values()),
            "excluded_files": len(exclusions),
        },
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest["summary"], indent=2))


if __name__ == "__main__":
    main()
