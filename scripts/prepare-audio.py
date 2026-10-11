#!/usr/bin/env python3
"""Prepare web FLAC assets without changing the source WAVs.

Requires ffmpeg and ffprobe. One shared attenuation preserves float peaks above
0 dBFS before 16-bit quantization and FLAC encoding. No resampling, trimming,
per-track normalization or encoder padding.
"""
import array
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "audioAssets"
DEST = ROOT / "public" / "audio"
DEPLOYMENT_GAIN = 0.85
ASSETS = {
    "menuFill": "Music/Menu/VOMenuFill.wav",
    "menu": "Music/Menu/VOMenu.wav",
    "gameStart": "Music/Main/VOGameStart.wav",
    **{f"phase{i}": f"Music/Main/VOGamePhase{i}.wav" for i in range(1, 6)},
    **{f"attack{i}": f"SFX/Attack/Attack{i}.wav" for i in range(1, 4)},
    **{f"killed{i}": f"SFX/Killed/Killed{i}.wav" for i in range(1, 3)},
    "damage": "SFX/Damage/Damage.wav",
    "click": "SFX/UI/Click.wav",
    "change": "SFX/UI/Change.wav",
    "achievement": "SFX/UI/Achievement.wav",
    "ultimateCharge": "SFX/Ultimate/UltimateCharge.wav",
    "ultimateBurst": "SFX/Ultimate/UltimateInitialBurst.wav",
    "ultimateExplosion": "SFX/Ultimate/UltimateMainExplosion.wav",
}

def probe(path):
    result = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_rate,channels,duration_ts,time_base,bits_per_raw_sample",
        "-of", "json", str(path),
    ])
    return json.loads(result)["streams"][0]

def float_peak(path):
    raw = subprocess.check_output([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
        "-f", "f32le", "-acodec", "pcm_f32le", "-",
    ])
    samples = array.array("f")
    samples.frombytes(raw)
    return max(abs(min(samples)), abs(max(samples)))

def main():
    DEST.mkdir(parents=True, exist_ok=True)
    assets = {}
    for key, relative in ASSETS.items():
        source = SOURCE / relative
        target = DEST / f"{key}.flac"
        original = probe(source)
        source_peak = float_peak(source)
        if source_peak * DEPLOYMENT_GAIN >= 0.995:
            raise RuntimeError(f"{key}: source peak {source_peak} needs more shared headroom")
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
            "-map_metadata", "-1", "-c:a", "flac", "-compression_level", "8",
            "-af", f"volume={DEPLOYMENT_GAIN},aresample=osf=s16:dither_method=triangular", str(target),
        ], check=True)
        encoded = probe(target)
        for field in ("sample_rate", "channels", "duration_ts", "time_base"):
            if original[field] != encoded[field]:
                raise RuntimeError(f"{key}: {field} changed: {original[field]} -> {encoded[field]}")
        sample_rate = int(encoded["sample_rate"])
        frames = int(encoded["duration_ts"])
        assets[key] = {
            "file": target.name,
            "source": relative,
            "sampleRate": sample_rate,
            "frames": frames,
            "channels": encoded["channels"],
            "duration": frames / sample_rate,
            "sourcePeak": source_peak,
            "bytes": target.stat().st_size,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        }
        print(f"{key:19} {frames:8} frames  {frames / sample_rate:10.6f}s  {target.stat().st_size:9,} bytes")
    phase_frames = {assets[f"phase{i}"]["frames"] for i in range(1, 6)}
    if len(phase_frames) != 1:
        raise RuntimeError("All phase loops must have exactly the same frame count")
    manifest = {
        "version": 1,
        "encoding": "FLAC, 16-bit PCM with triangular dither, original sample rate and frame count",
        "sharedGain": DEPLOYMENT_GAIN,
        "phaseCrossfadeSeconds": 0.65,
        "menuFadeSeconds": 0.35,
        "ultimateRecoverySeconds": 0.65,
        "assets": assets,
    }
    (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Total: {sum(a['bytes'] for a in assets.values()):,} bytes")

if __name__ == "__main__":
    main()
