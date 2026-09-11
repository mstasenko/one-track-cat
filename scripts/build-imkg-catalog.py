#!/usr/bin/env python3
"""Build a small, deterministic captioned-IMKG catalog without extracting the archive."""

from __future__ import annotations

import argparse
import codecs
from dataclasses import dataclass
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit
import zipfile


SOURCE_URL = "https://owncloud.ut.ee/owncloud/s/mFdPCY2mWdQLZ7Q"
CHUNK_BYTES = 64 * 1024
MAX_MEMBER_BYTES = 1 << 30
MAX_ROW_BYTES = 1 << 20
MAX_RECORDS = 2_000_000
MAX_TEMPLATES = 10_000
MAX_OUTPUT = 10_000
MAX_NAME_CHARS = 240
MAX_CAPTION_CHARS = 512
TAG_RE = re.compile(r"<[^>]*>")
TEMPLATE_ID_RE = re.compile(r"[0-9]{1,12}\Z")
IMAGE_RE = re.compile(r"/([0-9a-z]{1,12})\.(jpg|jpeg|png|webp)\Z")
COUNT_RE = re.compile(r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)\Z")


class InputError(ValueError):
    """Raised when the source cannot be safely converted into a complete catalog."""


@dataclass(frozen=True)
class Candidate:
    template_id: str
    instance_id: str
    name: str
    caption: str
    url: str
    upvotes: int
    views: int

    def rank(self) -> tuple[int, int, str, str, str, str]:
        return (-self.upvotes, -self.views, self.instance_id, self.template_id, self.name, self.caption)


class JsonArrayReader:
    """Read one JSON array incrementally, keeping the current row bounded."""

    def __init__(self, stream, member_size: int) -> None:
        self.stream = stream
        self.member_size = member_size
        self.decoder = codecs.getincrementaldecoder("utf-8")()
        self.json_decoder = json.JSONDecoder()
        self.buffer = ""
        self.bytes_read = 0
        self.eof = False

    def _read_text(self) -> str:
        chunk = self.stream.read(CHUNK_BYTES)
        if chunk:
            self.bytes_read += len(chunk)
            if self.bytes_read > MAX_MEMBER_BYTES or self.bytes_read > self.member_size:
                raise InputError("JSON member exceeds the configured size limit")
            try:
                return self.decoder.decode(chunk, final=False)
            except UnicodeDecodeError as error:
                raise InputError("JSON member is not valid UTF-8") from error
        if self.eof:
            return ""
        self.eof = True
        try:
            return self.decoder.decode(b"", final=True)
        except UnicodeDecodeError as error:
            raise InputError("JSON member ends with incomplete UTF-8") from error

    def _append_text(self) -> bool:
        while True:
            text = self._read_text()
            if text:
                self.buffer += text
                if len(self.buffer.encode("utf-8")) > MAX_ROW_BYTES + CHUNK_BYTES:
                    raise InputError("JSON row or whitespace exceeds the configured bound")
                return True
            if self.eof:
                return False

    def _fill(self) -> bool:
        while not self.buffer and not self.eof:
            if not self._append_text():
                break
        return bool(self.buffer)

    def _skip_space(self) -> None:
        while True:
            self.buffer = self.buffer.lstrip()
            if self.buffer or self.eof or not self._append_text():
                return

    def _drain_tail(self) -> None:
        if self.buffer.strip():
            raise InputError("non-whitespace data follows the JSON array")
        while not self.eof:
            text = self._read_text()
            if text.strip():
                raise InputError("non-whitespace data follows the JSON array")

    def rows(self):
        self._fill()
        self._skip_space()
        if not self.buffer or self.buffer[0] != "[":
            raise InputError("JSON member must contain a top-level array")
        self.buffer = self.buffer[1:]
        first = True
        while True:
            self._skip_space()
            if not self.buffer:
                raise InputError("JSON array is truncated")
            if self.buffer[0] == "]":
                if not first:
                    raise InputError("JSON array has a trailing comma")
                self.buffer = self.buffer[1:]
                self._drain_tail()
                return

            start = 0
            while True:
                try:
                    value, end = self.json_decoder.raw_decode(self.buffer, start)
                    break
                except json.JSONDecodeError as error:
                    if len(self.buffer[start:].encode("utf-8")) > MAX_ROW_BYTES:
                        raise InputError("JSON row exceeds the 1 MiB limit") from error
                    if self.eof or not self._append_text():
                        raise InputError("invalid or truncated JSON row") from error
            if len(self.buffer[start:end].encode("utf-8")) > MAX_ROW_BYTES:
                raise InputError("JSON row exceeds the 1 MiB limit")
            self.buffer = self.buffer[end:]
            yield value
            first = False
            self._skip_space()
            if not self.buffer:
                raise InputError("JSON array is truncated")
            if self.buffer[0] == ",":
                self.buffer = self.buffer[1:]
                continue
            if self.buffer[0] == "]":
                self.buffer = self.buffer[1:]
                self._drain_tail()
                return
            raise InputError("JSON array requires a comma or closing bracket")


def normalize_text(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = html.unescape(TAG_RE.sub("", value))
    text = " ".join(text.split()).strip()
    return text[:limit].rstrip()


def normalize_image_url(value: object) -> tuple[str, str] | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.startswith("//"):
        text = "https:" + text
    try:
        parsed = urlsplit(text)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "https"
        or parsed.netloc != "i.imgflip.com"
        or hostname != "i.imgflip.com"
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return None
    match = IMAGE_RE.fullmatch(parsed.path)
    if not match:
        return None
    instance_id, extension = match.groups()
    return f"https://i.imgflip.com/{instance_id}.{extension}", instance_id


def valid_instance_url(value: object, instance_id: str, image_url: str) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if text == f"/i/{instance_id}" or text == image_url:
        return True
    try:
        parsed = urlsplit(text)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and parsed.netloc == "imgflip.com"
        and parsed.hostname == "imgflip.com"
        and port is None
        and parsed.username is None
        and parsed.password is None
        and parsed.path == f"/i/{instance_id}"
        and not parsed.query
        and not parsed.fragment
    )


def parse_count(value: object) -> int:
    if not isinstance(value, str):
        return 0
    text = value.strip()
    if len(text) > 32 or not COUNT_RE.fullmatch(text):
        return 0
    try:
        return int(text.replace(",", ""))
    except ValueError:
        return 0


def clean_caption(value: object, instance_title: str) -> str:
    text = normalize_text(value, MAX_ROW_BYTES)
    prefix = re.match(rf"^{re.escape(instance_title)}\s*\|\s*", text, re.IGNORECASE)
    if prefix:
        text = text[prefix.end():].lstrip("| ").strip()
    if text.casefold().startswith(("image tagged in", "made w/")):
        return ""
    markers = [" | image tagged in", " | made w/"]
    cutoff = min((text.lower().find(marker) for marker in markers if text.lower().find(marker) >= 0), default=-1)
    if cutoff >= 0:
        text = text[:cutoff]
    return normalize_text(text, MAX_CAPTION_CHARS)


def candidate_from_record(record: object) -> Candidate | None:
    if not isinstance(record, dict):
        return None
    template_value = record.get("template_ID")
    if not isinstance(template_value, str) or not TEMPLATE_ID_RE.fullmatch(template_value):
        return None
    template_id = template_value.lstrip("0") or "0"
    template_title = normalize_text(record.get("template_title"), MAX_NAME_CHARS)
    instance_title = normalize_text(record.get("title"), MAX_NAME_CHARS)
    if not template_title or not instance_title:
        return None
    image = normalize_image_url(record.get("image_url"))
    if image is None:
        return None
    image_url, instance_id = image
    if not valid_instance_url(record.get("URL"), instance_id, image_url):
        return None
    caption = clean_caption(record.get("alt_text"), instance_title)
    if not caption:
        return None
    name_text = template_title if template_title.casefold() == instance_title.casefold() else f"{template_title} — {instance_title}"
    name = normalize_text(name_text, MAX_NAME_CHARS)
    return Candidate(
        template_id=template_id,
        instance_id=instance_id,
        name=name,
        caption=caption,
        url=image_url,
        upvotes=parse_count(record.get("upvote_count")),
        views=parse_count(record.get("view_count")),
    )


def caption_key(value: str) -> str:
    return " ".join(value.casefold().split())


def keep_candidate(groups: dict[str, list[Candidate]], candidate: Candidate) -> None:
    selected = groups.setdefault(candidate.template_id, [])
    key = caption_key(candidate.caption)
    for index, existing in enumerate(selected):
        if caption_key(existing.caption) == key:
            if candidate.rank() < existing.rank():
                selected[index] = candidate
            break
    else:
        selected.append(candidate)
    selected.sort(key=Candidate.rank)
    if len(selected) > 3:
        selected.pop()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def collect_candidates(archive_path: Path) -> list[Candidate]:
    groups: dict[str, list[Candidate]] = {}
    records = 0
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = [info for info in archive.infolist() if not info.is_dir()]
            if len(members) != 1 or not members[0].filename.lower().endswith(".json"):
                raise InputError("archive must contain exactly one JSON member")
            member = members[0]
            if member.file_size < 0 or member.file_size > MAX_MEMBER_BYTES:
                raise InputError("JSON member exceeds the configured size limit")
            with archive.open(member, "r") as stream:
                for record in JsonArrayReader(stream, member.file_size).rows():
                    records += 1
                    if records > MAX_RECORDS:
                        raise InputError("input record count exceeds the configured limit")
                    candidate = candidate_from_record(record)
                    if candidate is None:
                        continue
                    if candidate.template_id not in groups and len(groups) >= MAX_TEMPLATES:
                        raise InputError("template count exceeds the configured limit")
                    keep_candidate(groups, candidate)
    except (zipfile.BadZipFile, EOFError, RuntimeError, OSError) as error:
        raise InputError(f"could not read complete ZIP member: {error}") from error

    selected = sorted((candidate for group in groups.values() for candidate in group), key=Candidate.rank)
    unique: list[Candidate] = []
    seen_ids: set[str] = set()
    for candidate in selected:
        if candidate.instance_id in seen_ids:
            continue
        seen_ids.add(candidate.instance_id)
        unique.append(candidate)
    if len(unique) > MAX_OUTPUT:
        raise InputError("output entry count exceeds the configured limit")
    return unique


def write_catalog(archive_path: Path, output_path: Path) -> None:
    archive_hash = sha256_file(archive_path)
    selected = collect_candidates(archive_path)
    data = {
        "source": SOURCE_URL,
        "archiveSha256": archive_hash,
        "memes": [
            {"id": item.instance_id, "name": item.name, "caption": item.caption, "url": item.url}
            for item in selected
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary: str | None = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as target:
            json.dump(data, target, ensure_ascii=False, separators=(",", ":"))
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, output_path)
        temporary = None
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_zip", type=Path)
    parser.add_argument("output_json", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    arguments = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        write_catalog(arguments.input_zip, arguments.output_json)
    except (InputError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
