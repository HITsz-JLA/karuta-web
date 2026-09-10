#!/usr/bin/env python3
"""Build a karuta-web package from the local maimai song archives.

The source directory contains one ZIP per maimai version.  This builder scans
only maidata.txt, keeps songs whose MASTER or RE:MASTER chart is at least
12+, de-duplicates DX/repeated version entries, and copies one cover plus one
audio file per selected song into a server-readable karuta-web ZIP.

The input archives are never extracted or modified.  Use --dry-run to inspect
the selection before writing the package.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import shutil
import subprocess
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path


MIN_LEVEL = 12.5
DEFAULT_AUDIO_DURATION = 30.0
DEFAULT_AUDIO_BITRATE = "128k"
ZIP32_LIMIT = (1 << 32) - 1
IMAGE_NAMES = ("bg.webp", "bg.jpg", "bg.jpeg", "bg.png")
AUDIO_NAMES = ("track.mp3", "track.ogg", "track.m4a", "track.wav")
VERSION_RE = re.compile(r"^(\d+)")
FIELD_RE = re.compile(r"^&(?P<key>[A-Za-z0-9_]+)=(?P<value>.*)$")
DX_SUFFIX_RE = re.compile(r"\s*\[(?:DX|dx)\]\s*$")
WHITESPACE_RE = re.compile(r"\s+")


@dataclass
class Candidate:
    title: str
    artist: str
    master: float | None
    remaster: float | None
    difficulty: float
    difficulty_name: str
    version: int
    archive: Path
    folder: str
    image_entry: str
    audio_entry: str

    @property
    def identity(self) -> str:
        title = normalize_identity(self.title)
        artist = normalize_artist_identity(self.artist)
        return f"{title}\x00{artist}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(r"D:\maimaikaruta"),
        help="directory containing version ZIP archives",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data-packages/maimai-master-12plus.zip"),
        help="output karuta-web package ZIP",
    )
    parser.add_argument(
        "--audio-duration",
        type=float,
        default=DEFAULT_AUDIO_DURATION,
        help="seconds of audio to keep per card; use 0 to keep the full source audio",
    )
    parser.add_argument(
        "--audio-bitrate",
        default=DEFAULT_AUDIO_BITRATE,
        help="bitrate for the generated MP3 segments (default: 128k)",
    )
    parser.add_argument(
        "--ffmpeg",
        type=Path,
        help="path to ffmpeg; defaults to ffmpeg found on PATH",
    )
    parser.add_argument("--dry-run", action="store_true", help="scan and report, but do not write a package")
    parser.add_argument("--json-report", type=Path, help="also write the selection report as JSON")
    return parser.parse_args()


def version_number(path: Path) -> int:
    match = VERSION_RE.match(path.name)
    return int(match.group(1)) if match else 0


def decode_maidata(data: bytes) -> str:
    # Modern archives are UTF-8.  Some older community packs contain a small
    # amount of Shift-JIS text, so retain a fallback for those entries.
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp932", errors="replace")


def read_fields(data: bytes) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in decode_maidata(data).splitlines():
        match = FIELD_RE.match(line.strip())
        if match and match.group("key") not in fields:
            fields[match.group("key")] = match.group("value").strip()
    return fields


def parse_level(value: str | None) -> float | None:
    text = (value or "").strip().upper()
    if not text:
        return None
    # A level may include a trailing +, e.g. 12+.  Half a level is only used
    # for ordering; the original value is preserved in the report/display.
    match = re.fullmatch(r"(\d+)(\+)?", text)
    if not match:
        return None
    return float(match.group(1)) + (0.5 if match.group(2) else 0.0)


def display_level(value: float | None) -> str:
    if value is None:
        return "?"
    whole = int(value)
    return f"{whole}+" if value - whole >= 0.5 else str(whole)


def normalize_identity(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value or "")
    # [DX] is a chart/version marker, not part of the song identity.  Do not
    # strip words such as Remix: those are intentionally separate songs.
    normalized = DX_SUFFIX_RE.sub("", normalized)
    normalized = WHITESPACE_RE.sub(" ", normalized).strip().casefold()
    return normalized


def normalize_artist_identity(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value or "").casefold()
    # Artist credits often change only in separators between versions, such
    # as `t pazolite` versus `t+pazolite`.  Keep letters/numbers (including
    # Japanese and other Unicode letters), but ignore presentation marks.
    return "".join(character for character in normalized if character.isalnum())


def entry_map(names: list[str]) -> dict[str, str]:
    return {name.replace("\\", "/").lower(): name for name in names}


def find_asset(entries: dict[str, str], folder: str, names: tuple[str, ...]) -> str | None:
    folder = folder.rstrip("/")
    for name in names:
        hit = entries.get(f"{folder}/{name}".lower())
        if hit:
            return hit
    return None


def better_candidate(new: Candidate, old: Candidate) -> bool:
    # Prefer the highest eligible chart.  If the chart is tied, prefer the
    # newest version because it normally has the latest cover/audio asset.
    return (new.difficulty, new.version, bool(new.remaster)) > (old.difficulty, old.version, bool(old.remaster))


def scan_archives(source: Path) -> tuple[list[Candidate], dict[str, int]]:
    archives = sorted((path for path in source.glob("*.zip") if path.is_file()), key=version_number)
    if not archives:
        raise SystemExit(f"no ZIP archives found in {source}")

    selected: dict[str, Candidate] = {}
    stats = {
        "archives": len(archives),
        "maidata": 0,
        "eligible": 0,
        "missing_assets": 0,
        "replaced_duplicates": 0,
    }

    for archive in archives:
        version = version_number(archive)
        with zipfile.ZipFile(archive) as source_zip:
            names = source_zip.namelist()
            entries = entry_map(names)
            maidata_entries = [name for name in names if name.replace("\\", "/").lower().endswith("/maidata.txt")]
            stats["maidata"] += len(maidata_entries)
            for maidata_entry in maidata_entries:
                folder = maidata_entry.replace("\\", "/").rsplit("/", 1)[0]
                fields = read_fields(source_zip.read(maidata_entry))
                title = fields.get("title", "").strip()
                artist = fields.get("artist", "").strip()
                master = parse_level(fields.get("lv_4"))
                remaster = parse_level(fields.get("lv_5"))
                eligible_levels = [(master, "MASTER"), (remaster, "RE:MASTER")]
                eligible_levels = [(level, name) for level, name in eligible_levels if level is not None and level >= MIN_LEVEL]
                if not title or not eligible_levels:
                    continue
                stats["eligible"] += 1
                difficulty, difficulty_name = max(eligible_levels, key=lambda item: item[0])
                image_entry = find_asset(entries, folder, IMAGE_NAMES)
                audio_entry = find_asset(entries, folder, AUDIO_NAMES)
                if not image_entry or not audio_entry:
                    stats["missing_assets"] += 1
                    continue
                candidate = Candidate(
                    title=title,
                    artist=artist,
                    master=master,
                    remaster=remaster,
                    difficulty=difficulty,
                    difficulty_name=difficulty_name,
                    version=version,
                    archive=archive,
                    folder=folder,
                    image_entry=image_entry,
                    audio_entry=audio_entry,
                )
                old = selected.get(candidate.identity)
                if old is None:
                    selected[candidate.identity] = candidate
                elif better_candidate(candidate, old):
                    selected[candidate.identity] = candidate
                    stats["replaced_duplicates"] += 1

    candidates = sorted(selected.values(), key=lambda item: (normalize_identity(item.title), normalize_identity(item.artist)))
    return candidates, stats


def safe_csv_row(candidate: Candidate, number: int, image_path: str, audio_path: str) -> list[str]:
    artist_suffix = f" · {candidate.artist}" if candidate.artist else ""
    display_name = f"{candidate.title}{artist_suffix} · {candidate.difficulty_name} {display_level(candidate.difficulty)}"
    return [
        "MAIMAI",
        str(number),
        candidate.title,
        "1",
        display_name,
        Path(audio_path).name,
        audio_path,
        Path(image_path).name,
        image_path,
    ]


def resolve_ffmpeg(path: Path | None) -> str | None:
    if path:
        if path.is_file():
            return str(path)
        raise SystemExit(f"ffmpeg executable not found: {path}")
    return shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")


def make_audio_segment(data: bytes, ffmpeg: str, duration: float, bitrate: str, source_name: str) -> bytes:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        *(["-t", f"{duration:g}"] if duration > 0 else []),
        "-vn",
        "-c:a",
        "libmp3lame",
        "-b:a",
        bitrate,
        "-f",
        "mp3",
        "pipe:1",
    ]
    result = subprocess.run(command, input=data, capture_output=True, check=False)
    if result.returncode != 0 or not result.stdout:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"ffmpeg failed for {source_name}: {detail or 'no output'}")
    return result.stdout


def build_package(
    candidates: list[Candidate],
    output: Path,
    audio_duration: float = DEFAULT_AUDIO_DURATION,
    audio_bitrate: str = DEFAULT_AUDIO_BITRATE,
    ffmpeg: str | None = None,
) -> None:
    if audio_duration < 0:
        raise SystemExit("--audio-duration must be zero or greater")
    if audio_duration > 0 and not ffmpeg:
        raise SystemExit("ffmpeg is required to build 30-second segments; install ffmpeg or pass --ffmpeg")

    output.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "category",
        "work_number",
        "work_name",
        "song_slot",
        "song_title",
        "audio_file",
        "audio_path",
        "cover_files",
        "cover_paths",
    ]
    csv_buffer = io.StringIO(newline="")
    writer = csv.writer(csv_buffer, lineterminator="\n")
    writer.writerow(fields)

    # Python starts emitting ZIP64 metadata once an archive crosses 2 GiB,
    # even when all offsets still fit in the classic 32-bit ZIP fields. The
    # karuta-web reader deliberately rejects ZIP64, so keep this package in
    # ZIP32 while it remains below the actual 4 GiB ZIP32 limit.
    zipfile.ZIP64_LIMIT = ZIP32_LIMIT
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as target:
        for number, candidate in enumerate(candidates, start=1):
            image_suffix = Path(candidate.image_entry).suffix.lower() or ".jpg"
            image_path = f"images/{number}{image_suffix}"
            audio_path = f"mp3_files/seg_30/MAIMAI/{number}.mp3"
            writer.writerow(safe_csv_row(candidate, number, image_path, audio_path))
            with zipfile.ZipFile(candidate.archive) as source_zip:
                target.writestr(image_path, source_zip.read(candidate.image_entry))
                source_audio = source_zip.read(candidate.audio_entry)
                if audio_duration > 0:
                    audio = make_audio_segment(source_audio, ffmpeg, audio_duration, audio_bitrate, candidate.audio_entry)
                else:
                    audio = source_audio
                target.writestr(audio_path, audio)

        manifest = {
            "format": "karuta-web",
            "version": 1,
            "mode": "lite",
            "name": "maimai MASTER 12+",
            "source": "D:\\maimaikaruta",
            "cardCount": len(candidates),
            "selection": "MASTER or RE:MASTER >= 12+, DX/version duplicates de-duplicated, Remix retained",
            "audio": "30-second MP3 segments" if audio_duration > 0 else "full source audio",
        }
        target.writestr("meta/manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        target.writestr("meta/metadata.csv", csv_buffer.getvalue().encode("utf-8"))


def report(candidates: list[Candidate], stats: dict[str, int]) -> dict[str, object]:
    return {
        "stats": stats,
        "cardCount": len(candidates),
        "cards": [
            {
                "title": item.title,
                "artist": item.artist,
                "master": display_level(item.master),
                "remaster": display_level(item.remaster),
                "selectedDifficulty": f"{item.difficulty_name} {display_level(item.difficulty)}",
                "version": item.version,
                "archive": item.archive.name,
            }
            for item in candidates
        ],
    }


def main() -> None:
    args = parse_args()
    candidates, stats = scan_archives(args.source)
    result = report(candidates, stats)
    print(json.dumps({"stats": stats, "cardCount": len(candidates)}, ensure_ascii=False, indent=2))
    if candidates:
        print("first_cards:")
        for item in candidates[:10]:
            print(f"  {item.title} | {item.difficulty_name} {display_level(item.difficulty)} | v{item.version}")
    if args.json_report:
        args.json_report.parent.mkdir(parents=True, exist_ok=True)
        args.json_report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not args.dry_run:
        ffmpeg = resolve_ffmpeg(args.ffmpeg)
        build_package(candidates, args.output, args.audio_duration, args.audio_bitrate, ffmpeg)
        print(f"wrote: {args.output} ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
