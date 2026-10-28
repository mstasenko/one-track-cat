"""Finite B580 pipeline smoke; generated audio is labelled AI test audio.

Use a private writable directory owned by the ordinary user. This harness runs
under that user; only its child inference worker is authorized through sudo.
"""
import argparse
import json
from pathlib import Path
import os
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--language", choices=("en", "ru"), default="en")
    parser.add_argument("--voice-style", choices=("original", "conversational", "cosy", "calm", "professional", "energetic"), default="original")
    args = parser.parse_args()
    args.output.mkdir(mode=0o700)
    pack = Path("dist/voice-pack").resolve()
    nodes = [node for node in Path("/sys/class/drm").glob("renderD*")
             if (node / "device/vendor").read_text().strip() == "0x8086"
             and (node / "device/device").read_text().strip() == "0xe20b"]
    if len(nodes) != 1:
        raise RuntimeError("Cannot identify the B580 render node")
    occupancy = subprocess.run(["sudo", "-n", "fuser", "-v", f"/dev/dri/{nodes[0].name}"], capture_output=True, text=True)
    if occupancy.returncode != 1 or occupancy.stdout.strip() or occupancy.stderr.strip():
        raise RuntimeError(f"B580 is occupied or its ownership could not be verified: {occupancy.stdout}{occupancy.stderr}")
    command = ["sudo", "-n", str(pack / "runtime/bin/python"), "-B", str(pack / "narration_worker.py"),
               "--pack", str(pack), "--ffmpeg", "/usr/bin/ffmpeg", "--uid", str(os.getuid()), "--gid", str(os.getgid())]
    with (args.output / "diagnostics.log").open("x") as diagnostic:
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=diagnostic, text=True)
        records = []

        def receive():
            line = child.stdout.readline()
            if not line:
                raise RuntimeError(f"Worker exited: {child.wait()}")
            value = json.loads(line)
            records.append(value)
            print(line, end="", flush=True)
            return value

        def request(value):
            started = time.monotonic()
            child.stdin.write(json.dumps(value) + "\n")
            child.stdin.flush()
            while True:
                response = receive()
                if "error" in response:
                    raise RuntimeError(response["error"])
                if "result" in response:
                    records.append(dict(action=value["action"], seconds=time.monotonic() - started))
                    return response["result"]
        try:
            receive()
            source = args.output.resolve() / "input.wav"
            fixture = Path("dist/voice-pack-cache/fixtures") / ("russian-12s.wav" if args.language == "ru" else "english-12s-48k.wav")
            subprocess.run(["/usr/bin/ffmpeg", "-v", "error", "-i", str(fixture), "-ar", "48000", "-ac", "2", str(source)], check=True)
            speech, background = (str(args.output.resolve() / name) for name in ("speech.wav", "background.wav"))
            request(dict(action="separate", input=str(source), speech=speech, background=background))
            words = request(dict(action="transcribe", input=speech, language=args.language))
            text = " ".join(word["text"].strip() for word in words if word["start"] < 4)
            messages = [dict(role="system", content=f'Improve {args.language} narration. Preserve meaning. Return only {{"segments":[{{"id":"phrase-0","text":"revised text"}}]}}.'),
                        dict(role="user", content=json.dumps(dict(segments=[dict(id="phrase-0", text=text)])))]
            request(dict(action="rewrite", batches=[messages]))
            # Known original transcript + matching reference; never claim the
            # model's proposed rewrite is automatically approved by the user.
            reference = Path("dist/voice-pack-cache/fixtures/english-reference.wav").resolve()
            reference_text = "Can I get some water in my water bottle?"
            generated_text = reference_text
            if args.language == "ru":
                reference = args.output.resolve() / "reference.wav"
                reference_text = " ".join(word["text"].strip() for word in words if word["end"] <= 6)
                subprocess.run(["/usr/bin/ffmpeg", "-v", "error", "-i", speech, "-t", "6", "-ac", "1", str(reference)], check=True)
                generated_text = "Пожалуйста, подождите. Всё готово."
            request(dict(action="synthesize", voiceStyle=args.voice_style, phrases=[dict(text=generated_text, reference=str(reference), referenceText=reference_text,
                         output=str(args.output.resolve() / "AI-generated-test.wav"))]))
        finally:
            child.stdin.close()
            code = child.wait()
            (args.output / "results.json").write_text(json.dumps(dict(records=records, exitCode=code), indent=2))
        if code:
            raise RuntimeError(f"Worker failed: {code}")


if __name__ == "__main__":
    main()
